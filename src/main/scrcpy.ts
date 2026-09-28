// Minimal scrcpy client: starts the pinned scrcpy-server on the device over adb,
// reads the H.264 video stream and sends control messages (remote keys, text).
//
// Wire format (scrcpy server 4.1, tunnel_forward=true):
//   video socket:   1 dummy byte, then packets [u64 pts+flags][u32 size][size bytes]
//                   bit 62 = config (SPS/PPS), bit 61 = key frame, low 61 bits = pts (us)
//   control socket: messages we write, e.g. inject keycode
//                   [u8 type=0][u8 action][u32 keycode][u32 repeat][u32 metastate]

import { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import net from 'net';
import { adb, spawnAdb } from './adb';
import { serverPath, SERVER_VERSION } from './paths';
import type { AppInfo, Profile } from '../shared/types';

const DEVICE_JAR = '/data/local/tmp/firetv-scrcpy-server.jar';
const FLAG_CONFIG = 1n << 62n;
const FLAG_KEY = 1n << 61n;
const PTS_MASK = (1n << 61n) - 1n;

const MSG_INJECT_KEYCODE = 0;
const MSG_INJECT_TEXT = 1;

async function pushServer(serial: string): Promise<void> {
  await adb(['push', serverPath(), DEVICE_JAR], { serial });
}

function serverArgs(scid: string, extra: string[]): string[] {
  return ['shell', `CLASSPATH=${DEVICE_JAR}`, 'app_process', '/', 'com.genymobile.scrcpy.Server',
    SERVER_VERSION, `scid=${scid}`, 'log_level=info', ...extra];
}

/** Asks the server which H.264 encoders the device has; 'hardware' if any is not software */
export async function detectEncoder(serial: string): Promise<'hardware' | 'software'> {
  await pushServer(serial);
  const scid = randomScid();
  const out = await adb(serverArgs(scid, ['list_encoders=true', 'audio=false']), { serial, timeout: 15000 });
  const h264 = out.split('\n').filter((l) => /--video-codec=h264/.test(l));
  return h264.some((l) => /\((hw|hybrid)\)/.test(l)) ? 'hardware' : 'software';
}

/** Installed apps with their display names, via the server's list_apps (the server knows labels) */
export async function listApps(serial: string): Promise<AppInfo[]> {
  await pushServer(serial);
  const out = await adb(serverArgs(randomScid(), ['list_apps=true']), { serial, timeout: 30000 });
  const apps: AppInfo[] = [];
  for (const line of out.split('\n')) {
    // " * Prime Video                    com.amazon.firebat"  (* = system app, - = installed by the user)
    const m = /^\s*([*-])\s+(.+?)\s{2,}(\S+)\s*$/.exec(line);
    if (m) apps.push({ system: m[1] === '*', name: m[2].trim(), pkg: m[3] });
  }
  return apps;
}

function randomScid(): string {
  return ((Math.random() * 0x7fffffff) >>> 0).toString(16).padStart(8, '0');
}

export class Session extends EventEmitter {
  private server: ChildProcess | null = null;
  private video: net.Socket | null = null;
  private control: net.Socket | null = null;
  private port: number | null = null;
  private config: Buffer | null = null;
  private floor: number[] = [];
  private stopped = true;
  private streaming = false; // true once video flows; before that, start() reports errors
  serial: string | null = null;

  get active(): boolean {
    return !this.stopped;
  }

  /** profile null = remote only: control channel, no video (no encoding on the device) */
  async start(serial: string, profile: Profile | null): Promise<void> {
    this.serial = serial;
    this.stopped = false;
    const scid = randomScid();

    await pushServer(serial);
    this.port = Number((await adb(['forward', 'tcp:0', `localabstract:scrcpy_${scid}`], { serial })).trim());

    const videoArgs = profile
      ? ['video=true', 'video_codec=h264', `max_size=${profile.size}`, `max_fps=${profile.fps}`, `video_bit_rate=${profile.bitrate}`]
      : ['video=false'];
    const server = spawnAdb(serverArgs(scid, [
      'tunnel_forward=true', 'audio=false', 'control=true', ...videoArgs,
      'send_device_meta=false', 'send_stream_meta=false',
    ]), serial);
    this.server = server;
    let log = '';
    const onLog = (d: Buffer) => { log = (log + d.toString()).slice(-2000); this.emit('log', d.toString()); };
    server.stdout!.on('data', onLog);
    server.stderr!.on('data', onLog);
    server.on('exit', (code) => this.end(`The mirroring server stopped (code ${code}). ${lastError(log)}`.trim()));

    try {
      // The first socket carries the dummy byte: video when mirroring, else control
      if (profile) {
        this.video = await this.connectFirst();
        this.control = await this.connect();
      } else {
        this.control = await this.connectFirst();
        this.control.resume();
      }
    } catch (e) {
      const reason = `${(e as Error).message}. ${lastError(log)}`.trim();
      await this.stop();
      throw new Error(reason);
    }
    this.control.on('data', () => {}); // device messages (clipboard etc.) are not used yet
    this.control.on('error', () => {});
    this.control.on('close', () => this.end('The connection to the device closed.'));
    if (this.video) this.readVideo(this.video);
    this.streaming = true;
  }

  // adb forward accepts connections before the server listens; the dummy byte
  // proves the server is really there.
  private async connectFirst(): Promise<net.Socket> {
    for (let i = 0; i < 100 && !this.stopped; i++) {
      try {
        const sock = await this.connect();
        await new Promise<void>((resolve, reject) => {
          sock.once('data', (d: Buffer) => {
            sock.pause(); // hold the stream until its reader is attached
            if (d.length > 1) sock.unshift(d.subarray(1));
            resolve();
          });
          sock.once('close', () => reject(new Error('closed')));
        });
        return sock;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('Could not reach the mirroring server on the device');
  }

  private connect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: this.port! }, () => resolve(sock));
      sock.setNoDelay(true);
      sock.once('error', reject);
    });
  }

  private readVideo(sock: net.Socket): void {
    let buf: Buffer = Buffer.alloc(0);
    sock.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      while (buf.length >= 12) {
        const size = buf.readUInt32BE(8);
        if (buf.length < 12 + size) break;
        const flags = buf.readBigUInt64BE(0);
        const data = Buffer.from(buf.subarray(12, 12 + size));
        buf = buf.subarray(12 + size);
        this.onPacket(flags, data);
      }
    });
    sock.on('close', () => this.end('The video stream closed.'));
    sock.on('error', () => {});
    sock.resume();
  }

  private onPacket(flags: bigint, data: Buffer): void {
    if (flags & FLAG_CONFIG) {
      this.config = data;
      this.emit('config', { codec: avcCodecString(data) });
      return;
    }
    const key = (flags & FLAG_KEY) !== 0n;
    const pts = Number(flags & PTS_MASK);
    // Like the scrcpy client: prepend SPS/PPS to the next key frame
    if (key && this.config) data = Buffer.concat([this.config, data]);

    // Lag above the best recent frame: shows when frames start queueing up
    const raw = Number(process.hrtime.bigint() / 1000n) - pts;
    this.floor.push(raw);
    if (this.floor.length > 600) this.floor.shift();
    const lagMs = (raw - Math.min(...this.floor)) / 1000;
    this.emit('packet', { data, key, pts, lagMs });
  }

  key(keycode: number, action: 0 | 1, repeat = 0): void {
    if (!this.control) return;
    const msg = Buffer.alloc(14);
    msg.writeUInt8(MSG_INJECT_KEYCODE, 0);
    msg.writeUInt8(action, 1);
    msg.writeUInt32BE(keycode, 2);
    msg.writeUInt32BE(repeat, 6);
    msg.writeUInt32BE(0, 10);
    this.control.write(msg);
  }

  tap(keycode: number): void {
    this.key(keycode, 0);
    this.key(keycode, 1);
  }

  text(str: string): void {
    if (!this.control || !str) return;
    const utf8 = Buffer.from(str, 'utf8');
    const msg = Buffer.alloc(5 + utf8.length);
    msg.writeUInt8(MSG_INJECT_TEXT, 0);
    msg.writeUInt32BE(utf8.length, 1);
    utf8.copy(msg, 5);
    this.control.write(msg);
  }

  /** Unexpected end: tear down and report once */
  private end(reason: string): void {
    if (this.stopped) return;
    const report = this.streaming;
    void this.stop().then(() => { if (report) this.emit('ended', reason); });
  }

  async stop(): Promise<void> {
    const wasActive = !this.stopped;
    this.stopped = true;
    this.streaming = false;
    this.video?.destroy();
    this.control?.destroy();
    this.video = this.control = null;
    this.server?.kill();
    this.server = null;
    this.config = null;
    this.floor = [];
    if (wasActive && this.port && this.serial) {
      await adb(['forward', '--remove', `tcp:${this.port}`], { serial: this.serial }).catch(() => {});
    }
    this.port = null;
  }
}

function lastError(log: string): string {
  const line = log.split('\n').reverse().find((l) => /ERROR|Exception/.test(l));
  return line ? line.replace(/^.*?ERROR:\s*/, '').trim() : '';
}

/** "avc1.PPCCLL" from the SPS NAL unit of an Annex B config packet */
function avcCodecString(annexB: Buffer): string {
  for (let i = 0; i + 6 < annexB.length; i++) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1 && (annexB[i + 3] & 0x1f) === 7) {
      const hex = (b: number) => b.toString(16).padStart(2, '0');
      return `avc1.${hex(annexB[i + 4])}${hex(annexB[i + 5])}${hex(annexB[i + 6])}`;
    }
  }
  return 'avc1.42c028';
}
