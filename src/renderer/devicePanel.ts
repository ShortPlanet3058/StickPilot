// Device panel: live status (storage, memory, temperature, Wi-Fi…) and power actions.

import { icon } from './icons';
import type { DeviceInfo, DeviceStatusInfo, FireTvApi } from '../shared/types';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const gb = (kb: number) => `${(kb / 1024 / 1024).toFixed(kb > 10 * 1024 * 1024 ? 0 : 1)} GB`;

function duration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

function signal(rssi: number): { label: string; bars: number } {
  if (rssi >= -55) return { label: 'Excellent', bars: 4 };
  if (rssi >= -67) return { label: 'Good', bars: 3 };
  if (rssi >= -75) return { label: 'Fair', bars: 2 };
  return { label: 'Weak', bars: 1 };
}

const bar = (fraction: number, warn = false) =>
  `<div class="meter${warn ? ' warn' : ''}"><div class="meter-fill" data-w="${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}"></div></div>`;

export interface DevicePanelContext {
  device(): DeviceInfo | undefined;
  toast(message: string, kind?: 'ok' | 'error' | 'info'): void;
  done(): void;
}

export class DevicePanel {
  isOpen = false;
  private timer: number | undefined;
  private info: DeviceStatusInfo | null = null;
  private error = false;
  private confirmReboot = false;

  constructor(private root: HTMLElement, private api: FireTvApi, private ctx: DevicePanelContext) {
    root.innerHTML = `
      <div class="sheet-backdrop" data-close></div>
      <div class="sheet-panel" role="dialog" aria-label="Device">
        <header class="sheet-head"><h2>Device</h2>
          <button class="icon-btn" data-close title="Close (Esc)">${icon('close', 16)}</button></header>
        <div class="sheet-body device-body"></div>
      </div>`;
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-close]')) { this.close(); return; }
      const action = t.closest<HTMLElement>('[data-power]')?.dataset.power as 'sleep' | 'wake' | 'reboot' | undefined;
      if (action) void this.power(action);
    });
    document.addEventListener('keydown', (e) => {
      if (this.isOpen && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
    }, true);
  }

  open(): void {
    if (!this.ctx.device()) return;
    this.isOpen = true;
    this.root.hidden = false;
    this.info = null;
    this.error = false;
    this.confirmReboot = false;
    this.render();
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), 5000);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    clearInterval(this.timer);
    this.ctx.done();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  private async refresh(): Promise<void> {
    const d = this.ctx.device();
    if (!d || d.state !== 'device') { this.error = true; this.render(); return; }
    try {
      this.info = await this.api.deviceInfo(d.serial);
      this.error = false;
    } catch {
      this.error = true;
    }
    if (this.isOpen) this.render();
  }

  private async power(action: 'sleep' | 'wake' | 'reboot'): Promise<void> {
    const d = this.ctx.device();
    if (!d) return;
    if (action === 'reboot' && !this.confirmReboot) {
      this.confirmReboot = true;
      this.render();
      return;
    }
    this.confirmReboot = false;
    await this.api.devicePower(d.serial, action);
    if (action === 'reboot') {
      this.ctx.toast(`${d.name} is restarting. It will reconnect by itself in about a minute.`, 'info');
      this.close();
      return;
    }
    setTimeout(() => void this.refresh(), 1500);
  }

  private render(): void {
    const body = this.root.querySelector<HTMLElement>('.device-body')!;
    const d = this.ctx.device();
    const i = this.info;
    const head = d ? `<div class="device-title"><h3>${esc(d.name)}</h3>
        <p>${esc([d.manufacturer, d.model].filter(Boolean).join(' '))}${d.osLabel ? ` · ${esc(d.osLabel)}` : ''}</p></div>` : '';
    if (!i) {
      body.innerHTML = head + (this.error
        ? '<p class="sheet-empty">The device is not reachable.</p>'
        : '<div class="sheet-loading"><div class="spinner"></div><p>Reading the device status…</p></div>');
      return;
    }
    const row = (label: string, value: string, extra = '') =>
      `<div class="stat"><div class="stat-head"><span>${label}</span><b>${value}</b></div>${extra}</div>`;
    const stats: string[] = [];
    if (i.storage) {
      const used = i.storage.usedKB / i.storage.totalKB;
      stats.push(row('Storage', `${gb(i.storage.freeKB)} free of ${gb(i.storage.totalKB)}`, bar(used, used > 0.9)));
    }
    if (i.memory) {
      const used = 1 - i.memory.availableKB / i.memory.totalKB;
      stats.push(row('Memory', `${gb(i.memory.availableKB)} available of ${gb(i.memory.totalKB)}`, bar(used, used > 0.85)));
    }
    if (i.cpuTemp !== null) {
      const hot = i.throttled || i.cpuTemp >= 75;
      stats.push(row('CPU temperature', `${i.cpuTemp.toFixed(0)} °C`,
        hot ? '<p class="stat-note warn">The device is hot and may be slowing down, which makes the picture lag.</p>' : ''));
    }
    if (i.wifi) {
      const s = signal(i.wifi.rssi);
      const band = i.wifi.freqMHz >= 5900 ? '6 GHz' : i.wifi.freqMHz >= 4900 ? '5 GHz' : '2.4 GHz';
      stats.push(row('Wi-Fi', `${s.label} · ${band}`,
        `<div class="wifi-bars" aria-label="${s.bars} of 4 bars">${[1, 2, 3, 4].map((b) => `<span class="${b <= s.bars ? 'on' : ''}"></span>`).join('')}</div>`
        + `<p class="stat-note">${i.wifi.rssi} dBm · ${i.wifi.linkMbps} Mbps link</p>`));
    }
    const facts: [string, string][] = [
      ['Connection', `${d?.transport === 'network' ? 'Wi-Fi' : 'USB'}${d?.transport === 'network' ? ` (${esc(d.serial)})` : ''}`],
      ['IP address', i.ip ?? 'Not on a network'],
      ['Screen', i.screen || '—'],
      ['Running for', i.uptimeSec !== null ? duration(i.uptimeSec) : '—'],
      ['Processor', `${i.cores ?? '?'} cores · ${esc(i.abi)}`],
    ];
    body.innerHTML = `${head}
      <div class="stats-list">${stats.join('')}</div>
      <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <h3 class="sheet-section">Power</h3>
      <div class="power-row">
        <button data-power="sleep" ${i.awake === false ? 'disabled' : ''}>${icon('power', 16)}<span>Sleep</span></button>
        <button data-power="wake" ${i.awake === true ? 'disabled' : ''}>${icon('refresh', 16)}<span>Wake</span></button>
        <button data-power="reboot" class="${this.confirmReboot ? 'danger' : ''}">${icon('refresh', 16)}<span>${this.confirmReboot ? 'Click again to restart' : 'Restart'}</span></button>
      </div>
      ${i.awake === false ? '<p class="stat-note">The device is asleep. The picture stays still until you wake it.</p>' : ''}`;
    // Widths via CSSOM: inline style attributes are blocked by the page's CSP
    for (const el of body.querySelectorAll<HTMLElement>('.meter-fill')) el.style.width = `${el.dataset.w}%`;
  }
}
