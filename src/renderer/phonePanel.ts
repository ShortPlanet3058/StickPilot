// Phone remote panel: turns the phone remote on, and shows the QR code / link to open
// on the phone. The page itself is src/renderer/phone.ts, served by src/main/phoneRemote.ts.

import { icon } from './icons';
import { isMac } from './remote';
import type { PhoneRemoteInfo, StickPilotApi } from '../shared/types';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const isWindows = navigator.userAgent.includes('Windows');

export interface PhonePanelContext {
  toast(message: string, kind?: 'ok' | 'error' | 'info'): void;
  done(): void;
}

export class PhonePanel {
  isOpen = false;
  private info: PhoneRemoteInfo | null = null;
  private busy = false;
  private confirmNewLink = false;

  constructor(private root: HTMLElement, private api: StickPilotApi, private ctx: PhonePanelContext) {
    root.innerHTML = `
      <div class="sheet-backdrop" data-close></div>
      <div class="sheet-panel" role="dialog" aria-label="Phone remote">
        <header class="sheet-head"><h2>Phone remote</h2>
          <button class="icon-btn" data-close title="Close (Esc)">${icon('close', 16)}</button></header>
        <div class="sheet-body phone-body"></div>
      </div>`;
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-close]')) { this.close(); return; }
      if (t.closest('[data-copy]') && this.info?.url) {
        void navigator.clipboard.writeText(this.info.url).then(() => this.ctx.toast('Link copied.', 'ok'));
      }
      if (t.closest('[data-new-link]')) void this.newLink();
    });
    root.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id === 'phone-on') void this.set(t.checked);
    });
    document.addEventListener('keydown', (e) => {
      if (this.isOpen && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
    }, true);
    api.onPhoneRemote((info) => { this.info = info; if (this.isOpen) this.render(); });
  }

  open(): void {
    this.isOpen = true;
    this.root.hidden = false;
    this.confirmNewLink = false;
    this.render();
    void this.api.getPhoneRemote().then((info) => { this.info = info; this.render(); });
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    this.ctx.done();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  private async set(on: boolean): Promise<void> {
    this.busy = true;
    this.render();
    try {
      this.info = await this.api.setPhoneRemote(on);
    } catch (e) {
      this.ctx.toast(`The phone remote could not start: ${(e as Error).message.replace(/^Error invoking remote method '[\w:]+': (Error: )?/, '')}`, 'error');
      this.info = await this.api.getPhoneRemote();
    }
    this.busy = false;
    this.render();
  }

  private async newLink(): Promise<void> {
    if (!this.confirmNewLink) { this.confirmNewLink = true; this.render(); return; }
    this.confirmNewLink = false;
    this.info = await this.api.newPhoneLink();
    this.render();
    this.ctx.toast('New link ready. Phones need to scan the new code.', 'ok');
  }

  private render(): void {
    const body = this.root.querySelector('.phone-body')!;
    const info = this.info;
    const on = !!info?.enabled;
    const firewall = isWindows
      ? 'If Windows asks whether StickPilot may use the network, allow it on private networks.'
      : isMac ? 'If macOS asks whether StickPilot may accept incoming connections, choose Allow.' : '';
    const phones = info?.phones ?? 0;

    body.innerHTML = `
      <p class="phone-intro">Use your phone as the TV's remote: arrows or a swipe touchpad, playback and volume, typing and your apps. Nothing to install: it opens in the phone's browser.</p>
      <label class="toggle phone-toggle">
        <input type="checkbox" id="phone-on" ${on ? 'checked' : ''} ${this.busy ? 'disabled' : ''}>
        <span class="toggle-track" aria-hidden="true"></span>
        <span>Phone remote ${on ? 'on' : 'off'}</span>
      </label>
      ${on ? (info!.url ? `
        <div class="phone-qr" aria-label="QR code of the phone remote link">${info!.qr ?? ''}</div>
        <p class="phone-scan">Scan with the phone's camera</p>
        <div class="phone-link">
          <code>${esc(info!.url)}</code>
          <button class="icon-btn" data-copy title="Copy the link">${icon('link', 16)}</button>
        </div>
        <p class="phone-count ${phones ? 'ok' : ''}">${phones ? `${phones} phone${phones > 1 ? 's' : ''} connected` : 'No phone connected yet'}</p>
        <ul class="phone-tips">
          <li>The phone must be on the same Wi-Fi as this computer, and StickPilot must keep running here.</li>
          <li>To open it like an app, add the page to the phone's home screen (Share › Add to Home Screen on iPhone).</li>
          ${firewall ? `<li>${esc(firewall)}</li>` : ''}
        </ul>
        <div class="phone-new">
          <button class="ghost" data-new-link>${this.confirmNewLink ? 'Replace the link: phones using it stop working' : 'New link'}</button>
        </div>`
      : '<p class="phone-intro">This computer has no network address right now. Connect it to Wi-Fi or Ethernet.</p>')
      : ''}`;
  }
}
