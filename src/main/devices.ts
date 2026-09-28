import { EventEmitter } from 'events';
import { adb, DeviceTracker, RawDevice } from './adb';
import type { DeviceInfo, DeviceKind, NetworkResult } from '../shared/types';

interface Identity {
  hardwareId: string;
  name: string;
  model: string;
  manufacturer: string;
  kind: DeviceKind;
  osLabel: string;
}

const DEFAULT_ADB_PORT = 5555;

/** Keeps the live list of adb devices, identified with a friendly name and kind. */
export class DeviceManager extends EventEmitter {
  private tracker = new DeviceTracker();
  private raw: RawDevice[] = [];
  private identities = new Map<string, Identity>();
  private identifying = new Set<string>();

  async start(): Promise<void> {
    this.tracker.on('list', (list: RawDevice[]) => {
      this.raw = list;
      for (const d of list) if (d.state === 'device') void this.identify(d.serial);
      this.emit('changed', this.list());
    });
    await this.tracker.start();
  }

  stop(): void {
    this.tracker.stop();
  }

  list(): DeviceInfo[] {
    return this.raw.map((d) => {
      const id = this.identities.get(d.serial);
      return {
        serial: d.serial,
        state: d.state,
        transport: d.transport,
        name: id?.name || d.model || d.serial,
        model: id?.model || d.model,
        manufacturer: id?.manufacturer || '',
        kind: id?.kind || 'unknown',
        osLabel: id?.osLabel || '',
        hardwareId: id?.hardwareId || '',
        identified: !!id,
      };
    });
  }

  get(serial: string): DeviceInfo | undefined {
    return this.list().find((d) => d.serial === serial);
  }

  private async identify(serial: string): Promise<void> {
    if (this.identities.has(serial) || this.identifying.has(serial)) return;
    this.identifying.add(serial);
    try {
      // One shell round trip; each value on its own line
      const out = await adb(['shell',
        'getprop ro.product.manufacturer; getprop ro.product.model; settings get global device_name; '
        + 'getprop ro.build.version.release; getprop ro.build.mktg.fireos; getprop ro.serialno; '
        + 'pm has-feature android.software.leanback'],
      { serial, timeout: 10000 });
      const [manufacturer = '', model = '', deviceName = '', release = '', fireos = '', hardwareId = '', leanback = ''] =
        out.split('\n').map((s) => s.trim());
      const isTv = leanback === 'true';
      const kind: DeviceKind = manufacturer === 'Amazon' && /^AF/.test(model) && isTv ? 'firetv' : isTv ? 'tv' : 'phone';
      const name = deviceName && deviceName !== 'null' ? deviceName : `${manufacturer} ${model}`.trim();
      this.identities.set(serial, {
        hardwareId, name, model, manufacturer, kind,
        osLabel: fireos || (release ? `Android ${release}` : ''),
      });
      this.emit('changed', this.list());
    } catch {
      // Device went away or isn't ready yet; the next list update retries
    } finally {
      this.identifying.delete(serial);
    }
  }

  async connectNetwork(input: string): Promise<NetworkResult> {
    const host = normalizeHost(input);
    if (!host) return { ok: false, message: 'Enter an IP address, e.g. 192.168.1.40' };
    try {
      // adb connect waits for a TCP connection; unreachable hosts time out
      const out = (await adb(['connect', host], { timeout: 12000 })).trim();
      if (/connected to|already connected/i.test(out)) {
        return { ok: true, message: `Connected to ${host}. If the TV asks, allow USB debugging.`, serial: host };
      }
      return { ok: false, message: humanizeConnectError(out, host) };
    } catch (e) {
      return { ok: false, message: humanizeConnectError((e as Error).message, host) };
    }
  }

  async disconnectNetwork(input: string): Promise<void> {
    const host = normalizeHost(input);
    if (host) await adb(['disconnect', host]).catch(() => {});
    this.identities.delete(host);
  }
}

export function normalizeHost(input: string): string {
  const s = input.trim();
  if (!s) return '';
  return /:\d+$/.test(s) ? s : `${s}:${DEFAULT_ADB_PORT}`;
}

function humanizeConnectError(out: string, host: string): string {
  if (/timed out|ETIMEDOUT|killed/i.test(out)) {
    return `No answer from ${host}. Check the IP address and that the TV is on the same network.`;
  }
  if (/refused/i.test(out)) {
    return `${host} refused the connection. Turn on ADB debugging on the TV (Settings → My Fire TV → Developer options).`;
  }
  if (/unknown host|No such host|cannot resolve/i.test(out)) return `Unknown address: ${host}`;
  const detail = out.replace(/^adb connect: /, '').replace(/^Command failed:.*$/m, '').trim();
  return detail ? `Could not connect to ${host}: ${detail}` : `Could not connect to ${host}.`;
}
