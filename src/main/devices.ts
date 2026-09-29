import dns from 'dns';
import { EventEmitter } from 'events';
import net from 'net';
import os from 'os';
import { adb, DeviceTracker, RawDevice } from './adb';
import type { DeviceInfo, DeviceKind, DeviceStatusInfo, NetworkResult, ScanResult } from '../shared/types';

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

  async connectNetwork(input: string, retried = false): Promise<NetworkResult> {
    const host = normalizeHost(input);
    if (!host) return { ok: false, message: 'Enter an IP address, e.g. 192.168.1.40' };
    let out: string;
    try {
      // adb connect waits for a TCP connection; unreachable hosts time out
      out = (await adb(['connect', host], { timeout: 12000 })).trim();
    } catch (e) {
      out = (e as Error).message;
    }
    if (/connected to|already connected/i.test(out) && !/failed|cannot|unable/i.test(out)) {
      return { ok: true, message: `Connected to ${host}. If the TV asks, allow USB debugging.`, serial: host };
    }
    // macOS applies Local Network permission to the process that started the adb server,
    // and adb reuses a running server. One started by another app, or by StickPilot before
    // access was granted, keeps failing with "No route to host" while StickPilot itself can
    // reach the device: restart the server so it runs under StickPilot's permission.
    if (!retried && /No route to host|EHOSTUNREACH/i.test(out)) {
      const [ip, port] = host.split(':');
      if (await portOpen(ip, Number(port), 1500)) {
        await this.restartServer();
        return this.connectNetwork(host, true);
      }
    }
    return { ok: false, message: humanizeConnectError(out, host) };
  }

  /** Restarts the adb server from this app (the device tracker reconnects on its own) */
  private restarting: Promise<void> | null = null;
  restartServer(): Promise<void> {
    this.restarting ??= (async () => {
      await adb(['kill-server']).catch(() => {});
      await adb(['start-server']).catch(() => {});
    })().finally(() => { this.restarting = null; });
    return this.restarting;
  }

  /** Live status for the device panel, in one shell round trip */
  async statusInfo(serial: string): Promise<DeviceStatusInfo> {
    const sep = '@@FTV@@';
    const cmds = [
      'df -k /data | tail -1',
      'grep -E "MemTotal|MemAvailable" /proc/meminfo',
      'dumpsys thermalservice 2>/dev/null | grep -m6 -E "Temperature\\{|Thermal Status|IsStatusOverride|Current temperatures"',
      'dumpsys wifi 2>/dev/null | grep -m1 mWifiInfo',
      'cat /proc/uptime',
      'wm size',
      'getprop ro.product.cpu.abi; nproc',
      'dumpsys power | grep -m1 mWakefulness=',
    ];
    const out = await adb(['shell', cmds.join(`; echo ${sep}; `)], { serial, timeout: 10000 });
    const [df, mem, thermal, wifi, uptime, wm, cpu, power] = out.split(sep).map((s) => s.trim());
    const num = (re: RegExp, s: string) => { const m = re.exec(s); return m ? Number(m[1]) : null; };

    const dfCols = df.split(/\s+/);
    const storage = dfCols.length >= 4 && !Number.isNaN(Number(dfCols[1]))
      ? { totalKB: Number(dfCols[1]), usedKB: Number(dfCols[2]), freeKB: Number(dfCols[3]) } : null;
    const totalKB = num(/MemTotal:\s+(\d+)/, mem);
    const availableKB = num(/MemAvailable:\s+(\d+)/, mem);
    const cpuTemp = num(/mValue=([\d.]+), mType=0/, thermal);
    const rssi = num(/RSSI: (-?\d+)/, wifi);
    const [abi = '', cores = ''] = cpu.split('\n').map((s) => s.trim());
    return {
      storage,
      memory: totalKB && availableKB ? { totalKB, availableKB } : null,
      cpuTemp: cpuTemp === null ? null : Math.round(cpuTemp * 10) / 10,
      // mStatus above 0 means the thermal service is limiting performance
      throttled: /mType=0, mName=\w+, mStatus=[1-9]/.test(thermal),
      wifi: rssi !== null && rssi > -127
        ? { rssi, linkMbps: num(/Link speed: (\d+)Mbps/, wifi) ?? 0, freqMHz: num(/Frequency: (\d+)MHz/, wifi) ?? 0 } : null,
      uptimeSec: num(/^([\d.]+)/, uptime),
      screen: /(\d+x\d+)/.exec(wm)?.[1] ?? '',
      ip: await this.deviceIp(serial),
      abi,
      cores: Number(cores) || null,
      awake: /Awake/.test(power) ? true : /Asleep|Dozing/.test(power) ? false : null,
    };
  }

  /** The device's own IP address on its Wi-Fi (or Ethernet) network */
  async deviceIp(serial: string): Promise<string | null> {
    for (const iface of ['wlan0', 'eth0']) {
      const out = await adb(['shell', `ip -f inet addr show ${iface} 2>/dev/null`], { serial, timeout: 5000 }).catch(() => '');
      const m = /inet (\d+\.\d+\.\d+\.\d+)/.exec(out);
      if (m) return m[1];
    }
    return null;
  }

  /**
   * Adds a Wi-Fi connection to a device that is connected over USB, without typing its IP.
   * Fire TVs already accept network connections while ADB debugging is on; other Android
   * devices need `adb tcpip` first, which briefly restarts adb on the device.
   */
  async enableWifi(serial: string): Promise<NetworkResult> {
    const ip = await this.deviceIp(serial);
    if (!ip) return { ok: false, message: 'The device is not connected to a Wi-Fi or Ethernet network.' };
    const host = `${ip}:${DEFAULT_ADB_PORT}`;
    const first = await this.connectNetwork(host);
    if (first.ok) return first;
    await adb(['tcpip', String(DEFAULT_ADB_PORT)], { serial }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    return this.connectNetwork(host);
  }

  /**
   * Finds TVs and adb devices on the local /24 networks. Each address is checked for
   * the adb port and for the TV description ports: Fire TVs publish their name at
   * :60000/dd.xml (DIAL), Android/Google TVs at :8008/ssdp/device-desc.xml. Nothing
   * is connected: connecting shows an approval prompt on the device, so that stays
   * the user's choice. Only local traffic.
   */
  async scanNetwork(): Promise<ScanResult[]> {
    const own = new Set<string>();
    const bases = new Set<string>();
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs ?? []) {
        if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
        own.add(a.address);
        bases.add(a.address.split('.').slice(0, 3).join('.'));
      }
    }
    const ips = [...bases].slice(0, 2).flatMap((b) => Array.from({ length: 254 }, (_, i) => `${b}.${i + 1}`))
      .filter((ip) => !own.has(ip));
    const PORTS = [DEFAULT_ADB_PORT, 60000, 8008];
    const jobs = ips.flatMap((ip) => PORTS.map((port) => ({ ip, port })));
    const open = new Map<string, Set<number>>();
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const { ip, port } = jobs[next++];
        if (await portOpen(ip, port, 400)) {
          if (!open.has(ip)) open.set(ip, new Set());
          open.get(ip)!.add(port);
        }
      }
    };
    await Promise.all(Array.from({ length: 96 }, worker));

    const known = new Set(this.raw.map((d) => d.serial));
    const results = await Promise.all([...open].map(async ([ip, ports]): Promise<ScanResult | null> => {
      const desc = ports.has(60000) ? await tvDescription(`http://${ip}:60000/dd.xml`)
        : ports.has(8008) ? await tvDescription(`http://${ip}:8008/ssdp/device-desc.xml`) : null;
      if (!desc && !ports.has(DEFAULT_ADB_PORT)) return null; // something else with an open web port
      const host = `${ip}:${DEFAULT_ADB_PORT}`;
      const kind: DeviceKind = desc ? (/amazon/i.test(desc.manufacturer) ? 'firetv' : 'tv') : 'unknown';
      return {
        host, ip, kind,
        name: desc?.name || (await reverseName(ip)),
        model: desc?.model ?? '',
        adb: ports.has(DEFAULT_ADB_PORT),
        connected: known.has(host),
      };
    }));
    return results.filter((r): r is ScanResult => !!r).sort((a, b) => ipCompare(a.ip, b.ip));
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
  // macOS 15+ reports local-network access it hasn't allowed as "No route to host"
  if (/No route to host|EHOSTUNREACH/i.test(out)) {
    return process.platform === 'darwin'
      ? `Can't reach ${host}. If macOS asked whether StickPilot may find devices on your local network, allow it: System Settings → Privacy & Security → Local Network.`
      : `Can't reach ${host}. Check that the TV is on and on the same network.`;
  }
  const detail = out.replace(/^adb connect: /, '').replace(/^Command failed:.*$/m, '').trim();
  return detail ? `Could not connect to ${host}: ${detail}` : `Could not connect to ${host}.`;
}

function portOpen(host: string, port: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

async function reverseName(ip: string): Promise<string> {
  try {
    const names = await Promise.race([
      dns.promises.reverse(ip),
      new Promise<string[]>((r) => setTimeout(() => r([]), 800)),
    ]);
    return (names[0] ?? '').replace(/\.(local|lan|home|box)$/i, '');
  } catch {
    return '';
  }
}

const ipCompare = (a: string, b: string) => Number(a.split('.')[3]) - Number(b.split('.')[3]);

/** friendlyName / manufacturer / model from a UPnP device description */
async function tvDescription(url: string): Promise<{ name: string; manufacturer: string; model: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const xml = await res.text();
    const tag = (t: string) => (new RegExp(`<${t}>([^<]*)</${t}>`).exec(xml)?.[1] ?? '').replace(/&amp;/g, '&').replace(/&apos;|&#39;/g, "'").trim();
    const name = tag('friendlyName');
    return name ? { name, manufacturer: tag('manufacturer'), model: tag('modelName') } : null;
  } catch {
    return null;
  }
}
