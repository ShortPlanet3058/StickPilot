// App launcher: a panel listing the device's apps, with search, favorites and
// force close. Tiles show the apps' real TV banners (fetched from the device by
// StickPilot's helper), falling back to the icon, then to a lettered avatar.

import { icon } from './icons';
import type { AppArt, AppInfo, FireTvApi } from '../shared/types';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** System components that aren't useful to launch by hand */
const HIDDEN = new Set([
  'com.amazon.tv.launcher', 'com.amazon.ftv.screensaver', 'com.amazon.ssm', 'com.amazon.ftv.profilepicker',
  'com.amazon.firetv.troubleshooting', 'com.amazon.tv.earlyaccess', 'com.amazon.tv.ftvambient',
  'com.amazon.whasettings', 'com.amazon.smarthomemapviewapp',
]);

/** Square image for an app: its real icon if known, else a lettered avatar */
export function appIcon(app: AppInfo, art: AppArt | undefined, size = 40): string {
  if (art?.icon) return `<img class="app-icon" src="${art.icon}" width="${size}" height="${size}" alt="" draggable="false">`;
  return avatar(app, size);
}

export function avatar(app: AppInfo, size = 40): string {
  const words = app.name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  // "Prime Video" -> PV, "YouTube" -> Y
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || app.pkg)[0]).toUpperCase();
  let h = 0;
  for (const c of app.pkg) h = (h * 31 + c.charCodeAt(0)) % 360;
  // Inline style attributes are blocked by the page's CSP; paintAvatars() applies these
  return `<span class="avatar" data-h="${h}" data-size="${size}" aria-hidden="true">${esc(letters)}</span>`;
}

export function paintAvatars(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('.avatar[data-h]')) {
    const size = Number(el.dataset.size);
    el.style.setProperty('--h', el.dataset.h!);
    el.style.width = el.style.height = `${size}px`;
    el.style.fontSize = `${Math.round(size * 0.36)}px`;
    el.removeAttribute('data-h');
  }
}

export interface AppsContext {
  serial(): string | null;
  favorites(): string[];
  setFavorites(pkgs: string[]): void;
  toast(message: string, kind?: 'ok' | 'error' | 'info'): void;
  /** Called after the panel closes or an app was opened */
  done(): void;
}

export class AppsPanel {
  private apps: AppInfo[] = [];
  private current: string | null = null;
  private query = '';
  private loadedFor: string | null = null;
  /** Logos by package, filled in as they arrive */
  art: Record<string, AppArt> = {};
  isOpen = false;

  constructor(private root: HTMLElement, private api: FireTvApi, private ctx: AppsContext) {
    root.innerHTML = `
      <div class="sheet-backdrop" data-close></div>
      <div class="sheet-panel" role="dialog" aria-label="Apps">
        <header class="sheet-head">
          <h2>Apps</h2>
          <button class="icon-btn" data-refresh title="Refresh the list">${icon('refresh', 16)}</button>
          <button class="icon-btn" data-close title="Close (Esc)">${icon('close', 16)}</button>
        </header>
        <div class="sheet-search"><input type="search" placeholder="Search apps" spellcheck="false" autocomplete="off"></div>
        <div class="sheet-body"></div>
      </div>`;
    const input = root.querySelector<HTMLInputElement>('input')!;
    input.addEventListener('input', () => { this.query = input.value.trim().toLowerCase(); this.render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = this.visible()[0];
        if (first) void this.launch(first.pkg);
      }
    });
    root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-close]')) { this.close(); return; }
      if (t.closest('[data-refresh]')) { void this.load(true); return; }
      const pin = t.closest<HTMLElement>('[data-pin]')?.dataset.pin;
      if (pin) { this.togglePin(pin); return; }
      const stop = t.closest<HTMLElement>('[data-stop]')?.dataset.stop;
      if (stop) { void this.forceStop(stop); return; }
      const pkg = t.closest<HTMLElement>('[data-launch]')?.dataset.launch;
      if (pkg) void this.launch(pkg);
    });
    document.addEventListener('keydown', (e) => {
      if (this.isOpen && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
    }, true);
  }

  async open(): Promise<void> {
    this.isOpen = true;
    this.root.hidden = false;
    const input = this.root.querySelector<HTMLInputElement>('input')!;
    input.value = '';
    this.query = '';
    input.focus();
    this.render();
    await this.load(false);
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    this.ctx.done();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else void this.open();
  }

  /** Apps known for the current device (for the favorites row in the remote) */
  byPkg(pkg: string): AppInfo | undefined {
    return this.apps.find((a) => a.pkg === pkg);
  }

  async load(refresh: boolean): Promise<void> {
    const serial = this.ctx.serial();
    if (!serial) return;
    if (refresh || this.loadedFor !== serial) {
      this.apps = [];
      this.render();
      try {
        this.apps = await this.api.listApps(serial, refresh);
        this.loadedFor = serial;
        void this.loadArt(serial, refresh);
      } catch {
        this.ctx.toast('Could not read the list of apps from the device.', 'error');
      }
    }
    this.current = await this.api.currentApp(serial).catch(() => null);
    this.render();
    this.onLoaded();
  }

  /** Letters show first; the logos replace them once fetched (cached after the first time) */
  private async loadArt(serial: string, refresh: boolean): Promise<void> {
    const pkgs = this.apps.filter((a) => !HIDDEN.has(a.pkg)).map((a) => a.pkg);
    this.art = { ...this.art, ...(await this.api.cachedAppArt(pkgs)) };
    this.render();
    this.onLoaded();
    try {
      this.art = { ...this.art, ...(await this.api.appArt(serial, pkgs, refresh)) };
    } catch {
      // Logos are a nicety: keep the letters if the helper can't run
    }
    this.render();
    this.onLoaded();
  }

  /** Hook for the remote's favorites row */
  onLoaded: () => void = () => {};

  async launch(pkg: string): Promise<void> {
    const serial = this.ctx.serial();
    if (!serial) return;
    const app = this.byPkg(pkg);
    this.close();
    const ok = await this.api.launchApp(serial, pkg);
    if (!ok) this.ctx.toast(`${app?.name ?? pkg} could not be opened.`, 'error');
  }

  private async forceStop(pkg: string): Promise<void> {
    const serial = this.ctx.serial();
    if (!serial) return;
    await this.api.forceStopApp(serial, pkg);
    this.ctx.toast(`${this.byPkg(pkg)?.name ?? pkg} was closed.`, 'ok');
    this.current = await this.api.currentApp(serial).catch(() => null);
    this.render();
  }

  private togglePin(pkg: string): void {
    const favs = this.ctx.favorites();
    this.ctx.setFavorites(favs.includes(pkg) ? favs.filter((p) => p !== pkg) : [...favs, pkg]);
    this.render();
  }

  private visible(): AppInfo[] {
    const q = this.query;
    return this.apps
      .filter((a) => !HIDDEN.has(a.pkg))
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.pkg.includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private tile(a: AppInfo, favs: string[]): string {
    const pinned = favs.includes(a.pkg);
    const art = this.art[a.pkg];
    // TV banners already show the app's name; the label stays for icons and letters
    const visual = art?.banner
      ? `<img class="app-banner" src="${art.banner}" alt="" draggable="false">`
      : `<span class="app-banner placeholder">${appIcon(a, art, 44)}</span>`;
    return `<div class="app-tile${a.pkg === this.current ? ' running' : ''}">
        <button class="app-launch" data-launch="${esc(a.pkg)}" title="Open ${esc(a.name)}">${visual}<span>${esc(a.name)}</span></button>
        <button class="icon-btn app-pin${pinned ? ' on' : ''}" data-pin="${esc(a.pkg)}" title="${pinned ? 'Remove from favorites' : 'Add to favorites'}" aria-pressed="${pinned}">${icon('pin', 14)}</button>
      </div>`;
  }

  private render(): void {
    const body = this.root.querySelector<HTMLElement>('.sheet-body')!;
    if (!this.apps.length) {
      body.innerHTML = '<div class="sheet-loading"><div class="spinner"></div><p>Reading the apps on the device…</p></div>';
      return;
    }
    const favs = this.ctx.favorites();
    const list = this.visible();
    const cur = this.current ? this.byPkg(this.current) : undefined;
    const section = (title: string, apps: AppInfo[]) =>
      apps.length ? `<h3 class="sheet-section">${title}</h3><div class="app-grid">${apps.map((a) => this.tile(a, favs)).join('')}</div>` : '';
    let html = '';
    if (cur && !HIDDEN.has(cur.pkg) && !this.query) {
      html += `<div class="now-open">${appIcon(cur, this.art[cur.pkg], 32)}<div><small>Open now</small><span>${esc(cur.name)}</span></div>
        <button data-stop="${esc(cur.pkg)}" title="Force close this app, e.g. when it is stuck">Force close</button></div>`;
    }
    if (!this.query) html += section('Favorites', favs.map((p) => this.byPkg(p)).filter((a): a is AppInfo => !!a));
    html += section(this.query ? 'Results' : 'Your apps', list.filter((a) => this.query || !a.system));
    if (!this.query) html += section('Built-in apps', list.filter((a) => a.system));
    if (this.query && !list.length) html += '<p class="sheet-empty">No app matches.</p>';
    body.innerHTML = html;
    paintAvatars(body);
  }
}
