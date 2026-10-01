import { execFile, spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { adbPath } from './paths';
import type { AdbState, Transport } from '../shared/types';

export interface AdbOptions {
  serial?: string;
  timeout?: number;
}

export function adb(args: string[], { serial, timeout = 15000 }: AdbOptions = {}): Promise<string> {
  const full = serial ? ['-s', serial, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(adbPath(), full, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err && err.killed) reject(new Error(`adb ${args[0]} timed out`));
      else if (err) reject(new Error(`adb ${args[0]}: ${(stderr || stdout || err.message).trim()}`));
      // adb for Windows writes its output in text mode: every \n arrives as \r\n
      else resolve(stdout.replace(/\r\n/g, '\n'));
    });
  });
}

// windowsHide: adb is a console program; without it every call flashes a console window on Windows
export function spawnAdb(args: string[], serial?: string): ChildProcess {
  return spawn(adbPath(), serial ? ['-s', serial, ...args] : args, { windowsHide: true });
}

/**
 * Starts the adb server if it isn't running. No pipes: the server keeps running after
 * this call exits, and must not hold on to (and so keep open) any of our handles.
 */
export function startServer(timeout = 15000): Promise<void> {
  return new Promise((resolve) => {
    const proc = spawn(adbPath(), ['start-server'], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { proc.kill(); resolve(); }, timeout);
    const done = () => { clearTimeout(timer); resolve(); };
    proc.once('exit', done);
    proc.once('error', done);
  });
}

export interface RawDevice {
  serial: string;
  state: AdbState;
  transport: Transport;
  model: string;
}

const KNOWN_STATES: AdbState[] = ['device', 'unauthorized', 'offline', 'authorizing', 'connecting'];

/** Parses the body of `adb devices -l` / `adb track-devices -l` */
export function parseDeviceList(text: string): RawDevice[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('List of devices')).map((line) => {
    const [serial, state, ...rest] = line.split(/\s+/);
    const info = Object.fromEntries(rest.map((kv) => kv.split(':') as [string, string]));
    return {
      serial,
      state: (KNOWN_STATES as string[]).includes(state) ? (state as AdbState) : 'unknown',
      // network serials are host:port; USB serials never contain ':'
      transport: serial.includes(':') ? 'network' : 'usb',
      model: (info.model || '').replace(/_/g, ' '),
    };
  });
}

/**
 * Streams device list changes from `adb track-devices -l`, which pushes the full
 * list (as 4 hex digits of length + body) whenever anything is plugged, unplugged
 * or changes state. Restarts itself if adb exits.
 */
export class DeviceTracker extends EventEmitter {
  private proc: ChildProcess | null = null;
  private stopped = false;

  async start(): Promise<void> {
    this.stopped = false;
    await startServer();
    this.spawn();
  }

  private spawn(): void {
    if (this.stopped) return;
    const proc = spawnAdb(['track-devices', '-l']);
    this.proc = proc;
    // The length counts bytes as sent by the adb server. adb for Windows turns each \n
    // into \r\n on the way out, which would push every following message off by one
    // byte per device (serials then read as "0055G072…"): the \r are dropped first.
    let buf = Buffer.alloc(0);
    proc.stdout!.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk.filter((b) => b !== 0x0d)]);
      while (buf.length >= 4) {
        const head = buf.subarray(0, 4).toString('latin1');
        if (!/^[0-9a-f]{4}$/i.test(head)) { buf = Buffer.alloc(0); break; }
        const len = parseInt(head, 16);
        if (buf.length < 4 + len) break;
        const body = buf.subarray(4, 4 + len).toString('utf8');
        buf = buf.subarray(4 + len);
        this.emit('list', parseDeviceList(body));
      }
    });
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
      if (!this.stopped) setTimeout(() => this.spawn(), 1000);
    });
    proc.on('error', (e) => this.emit('error', e));
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill();
    this.proc = null;
  }
}
