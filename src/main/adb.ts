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
    execFile(adbPath(), full, { timeout }, (err, stdout, stderr) => {
      if (err && err.killed) reject(new Error(`adb ${args[0]} timed out`));
      else if (err) reject(new Error(`adb ${args[0]}: ${(stderr || stdout || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

export function spawnAdb(args: string[], serial?: string): ChildProcess {
  return spawn(adbPath(), serial ? ['-s', serial, ...args] : args);
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
    await adb(['start-server']).catch(() => {});
    this.spawn();
  }

  private spawn(): void {
    if (this.stopped) return;
    const proc = spawnAdb(['track-devices', '-l']);
    this.proc = proc;
    let buf = '';
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      while (buf.length >= 4) {
        const len = parseInt(buf.slice(0, 4), 16);
        if (Number.isNaN(len)) { buf = ''; break; }
        if (buf.length < 4 + len) break;
        const body = buf.slice(4, 4 + len);
        buf = buf.slice(4 + len);
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
