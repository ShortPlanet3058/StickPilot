import { AppsPanel, appIcon, paintAvatars } from './apps';
import { AudioPlayer } from './audio';
import { DevicePanel } from './devicePanel';
import { icon } from './icons';
import { bindKeyboard } from './keyboard';
import { bindTouch } from './touch';
import { bindRemote, flashKey, isMac, layoutFor, MOD, renderRemote, triggerQuickSettings } from './remote';
import { Video } from './video';
import type { DeviceInfo, DeviceKind, ScanResult, StickPilotApi, ProfileSet, SessionMode, SessionStatus, Settings, Transport } from '../shared/types';

declare global {
  interface Window { stickpilot: StickPilotApi }
}

const api = window.stickpilot;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type View = 'home' | 'player' | 'remote';

/** Short notifications at the bottom of the window, optionally with one action */
export function toast(message: string, opts: { kind?: 'ok' | 'error' | 'info'; action?: { label: string; run: () => void }; ms?: number } = {}): void {
  const el = document.createElement('div');
  el.className = `toast ${opts.kind ?? 'info'}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}</span>`;
  if (opts.action) {
    const b = document.createElement('button');
    b.textContent = opts.action.label;
    b.addEventListener('click', () => { opts.action!.run(); el.remove(); });
    el.appendChild(b);
  }
  document.getElementById('toasts')!.appendChild(el);
  setTimeout(() => el.classList.add('leaving'), opts.ms ?? 5000);
  setTimeout(() => el.remove(), (opts.ms ?? 5000) + 300);
}
type Tab = 'firetv' | 'tv' | 'phone';

// ---------- State ----------

const state = {
  view: 'home' as View,
  devices: [] as DeviceInfo[],
  status: { state: 'idle' } as SessionStatus,
  settings: null as Settings | null,
  profileSets: new Map<string, ProfileSet>(),
  /** The connection (adb serial) the player / remote view is about */
  current: null as string | null,
  fullscreen: false,
  menuOpen: false,
  autoConnectTried: false,
  /** Recording start time (ms), or 0 */
  recordingSince: 0,
  /** Network discovery results, and whether a search is running */
  discovered: [] as ScanResult[],
  scanning: false,
  discoveredOnce: false,
  remoteKind: null as DeviceKind | null,
};

const device = (serial: string | null) => state.devices.find((d) => d.serial === serial);
const liveSerial = () => (state.status.state === 'running' || state.status.state === 'connecting') ? state.status.serial : null;
const liveMode = (): SessionMode | null => (state.status.state === 'running' || state.status.state === 'connecting') ? state.status.mode : null;
const isLive = (serial: string) => liveSerial() === serial;
const isRunning = () => state.status.state === 'running' && state.status.serial === state.current;
const missingNetworkHosts = () => (state.settings?.networkHosts ?? []).filter((h) => !device(h));

/** Favorites are per physical device, so USB and Wi-Fi share them */
const deviceKey = (serial: string | null) => device(serial)?.hardwareId || serial || '';
const favoritesFor = (serial: string | null) => state.settings?.favoriteApps[deviceKey(serial)] ?? [];

function profileIdFor(serial: string): string {
  const set = state.profileSets.get(serial);
  const saved = state.settings?.profileBySerial[serial];
  return set?.profiles.some((p) => p.id === saved) ? saved! : set?.defaultId ?? '';
}

function stateLabel(d: DeviceInfo): { text: string; cls: string } {
  if (isLive(d.serial)) {
    const what = liveMode() === 'remote' ? 'Remote' : 'Live';
    return { text: state.status.state === 'running' ? what : 'Starting', cls: 'live' };
  }
  switch (d.state) {
    case 'device': return { text: 'Ready', cls: 'ready' };
    case 'unauthorized': return { text: 'Allow on TV', cls: 'warn' };
    case 'authorizing':
    case 'connecting': return { text: 'Connecting', cls: '' };
    case 'offline': return { text: 'Offline', cls: 'warn' };
    default: return { text: 'Unknown', cls: '' };
  }
}

const kindIcon = (k: DeviceKind) => (k === 'phone' ? 'phone' : 'tv');
const via = (d: DeviceInfo) => (d.transport === 'network' ? 'Wi-Fi' : 'USB');
const subline = (d: DeviceInfo) => [via(d), d.state === 'unauthorized' ? 'Not authorized yet' : d.osLabel || d.model].filter(Boolean).join(' · ');

// ---------- Devices grouped by physical device ----------

/** One physical device, reachable over one or more connections (USB, Wi-Fi) */
interface DeviceGroup { key: string; conns: DeviceInfo[] }

function groupDevices(list: DeviceInfo[], includeHidden = false): DeviceGroup[] {
  const groups = new Map<string, DeviceGroup>();
  const hidden = new Set(state.settings?.hiddenDevices ?? []);
  for (const d of list) {
    if (!includeHidden && (hidden.has(d.hardwareId) || hidden.has(d.serial))) continue;
    const key = d.hardwareId || d.serial;
    if (!groups.has(key)) groups.set(key, { key, conns: [] });
    groups.get(key)!.conns.push(d);
  }
  return [...groups.values()];
}

/** The connection a card acts on: the live one, the preferred one if ready, else a ready USB, else any */
function primaryConn(g: DeviceGroup): DeviceInfo {
  const ready = g.conns.filter((d) => d.state === 'device');
  const pref = state.settings?.transportByDevice[g.key];
  return g.conns.find((d) => isLive(d.serial))
    ?? ready.find((d) => d.transport === pref)
    ?? ready.find((d) => d.transport === 'usb') ?? ready[0] ?? g.conns[0];
}

/** Unidentified devices (not authorized yet) are most likely Fire TVs here */
function tabOf(g: DeviceGroup): Tab {
  const kind = g.conns.find((c) => c.identified)?.kind ?? 'unknown';
  return kind === 'phone' ? 'phone' : kind === 'tv' ? 'tv' : 'firetv';
}

// ---------- Device screen ----------

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'firetv', label: 'Fire TV', icon: 'tv' },
  { id: 'tv', label: 'Android TV', icon: 'tv' },
  { id: 'phone', label: 'Phones & tablets', icon: 'phone' },
];

const SETUP: Record<Tab, { title: string; intro: string; steps: string[] }> = {
  firetv: {
    title: 'Connect a Fire TV',
    intro: 'Mirror its screen or use this computer as its remote.',
    steps: [
      'On the TV, open Settings → My Fire TV → Developer options and turn on <b>ADB debugging</b>.',
      'Connect the stick to this computer with a USB data cable, or add it by IP address over Wi-Fi.',
      'Accept the <b>Allow USB debugging?</b> prompt on the TV.',
    ],
  },
  tv: {
    title: 'Connect an Android TV',
    intro: 'Google TV and other Android TV devices work the same way.',
    steps: [
      'Settings → System → About: select <b>Android TV OS build</b> 7 times to unlock Developer options.',
      'In Developer options, turn on <b>USB debugging</b> (sometimes called Network debugging).',
      'Add the TV by IP address below, then accept the prompt on the TV.',
    ],
  },
  phone: {
    title: 'Connect a phone or tablet',
    intro: 'Mirroring works; touch control on the picture is not supported yet.',
    steps: [
      'Settings → About phone: tap <b>Build number</b> 7 times to unlock Developer options.',
      'In Developer options, turn on <b>USB debugging</b>.',
      'Connect it with a USB cable and accept the prompt on the phone.',
    ],
  },
};

const addTile = document.createElement('article');

function buildAddTile(): void {
  addTile.className = 'dcard add';
  addTile.innerHTML = `
    <button class="add-open" type="button">${icon('plus', 22)}<span>Add by IP address</span><small>Connect over Wi-Fi</small></button>
    <form class="add-form" hidden>
      <div class="dcard-top"><span class="dcard-icon">${icon('wifi', 22)}</span>
        <button type="button" class="icon-btn add-close" aria-label="Cancel">${icon('close', 16)}</button></div>
      <label for="add-host">IP address of the device</label>
      <div class="field-row">
        <input id="add-host" placeholder="192.168.1.40" autocomplete="off" spellcheck="false">
        <button type="submit" class="primary">Connect</button>
      </div>
      <p class="help">Fire TV: Settings → My Fire TV → About → Network shows the IP address. ADB debugging must be on.</p>
      <p class="message" role="status"></p>
    </form>`;
  const form = addTile.querySelector<HTMLFormElement>('.add-form')!;
  const open = (on: boolean) => {
    form.hidden = !on;
    addTile.querySelector<HTMLElement>('.add-open')!.hidden = on;
    addTile.classList.toggle('open', on);
    if (on) addTile.querySelector<HTMLInputElement>('#add-host')!.focus();
  };
  addTile.querySelector('.add-open')!.addEventListener('click', () => open(true));
  addTile.querySelector('.add-close')!.addEventListener('click', () => open(false));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = addTile.querySelector<HTMLInputElement>('#add-host')!;
    const msg = addTile.querySelector<HTMLElement>('.message')!;
    const host = input.value.trim();
    if (!host) return;
    msg.className = 'message';
    msg.textContent = `Connecting to ${host}…`;
    const result = await api.connectNetwork(host);
    msg.className = `message ${result.ok ? 'ok' : 'error'}`;
    msg.textContent = result.message;
    if (result.ok) {
      state.settings = await api.getSettings();
      input.value = '';
      setTimeout(() => { open(false); msg.textContent = ''; }, 2500);
      renderHome();
    }
  });
}

/** Same TV found by Discover (matched by name) for a device that has no Wi-Fi connection yet */
function discoveredTwin(g: DeviceGroup): ScanResult | undefined {
  if (g.conns.some((c) => c.transport === 'network')) return undefined;
  const names = new Set(g.conns.map((c) => c.name.toLowerCase()));
  return state.discovered.find((f) => f.adb && !f.connected && names.has(f.name.toLowerCase()));
}

function wifiOffer(g: DeviceGroup, d: DeviceInfo, live: boolean): string {
  if (d.transport !== 'usb' || d.state !== 'device' || g.conns.some((c) => c.transport === 'network') || live) return '';
  const twin = discoveredTwin(g);
  return twin
    ? `<span class="also">· also on Wi-Fi (${esc(twin.ip)})</span><button class="link" data-join="${esc(twin.host)}" title="Connect over Wi-Fi too, so it works without the cable">Connect over Wi-Fi</button>`
    : `<button class="link" data-wifi="${esc(d.serial)}" title="Connect this device over Wi-Fi too, so it works without the cable">Set up Wi-Fi</button>`;
}

function deviceCard(g: DeviceGroup): string {
  const d = primaryConn(g);
  const pill = stateLabel(d);
  const ready = g.conns.filter((c) => c.state === 'device');
  const live = g.conns.find((c) => isLive(c.serial));

  let foot: string;
  if (live) {
    foot = `<button class="primary" data-open="${esc(live.serial)}">Open</button>`;
  } else if (d.state === 'device') {
    foot = `<button class="primary" data-connect="${esc(d.serial)}" data-mode="mirror">${icon('tv', 16)}<span>Screen + remote</span></button>`
      + `<button data-connect="${esc(d.serial)}" data-mode="remote" title="Control the device without mirroring its screen">${icon('remote', 16)}<span>Remote only</span></button>`;
  } else if (d.state === 'unauthorized') foot = '<p class="dcard-help">Accept "Allow USB debugging?" on the device.</p>';
  else if (d.state === 'offline') foot = '<p class="dcard-help">Reconnect the cable or restart ADB debugging.</p>';
  else foot = '<p class="dcard-help">Waiting for the device…</p>';

  // Pick USB or Wi-Fi when the device is reachable both ways
  const transports = [...new Set(ready.map((c) => c.transport))];
  const picker = transports.length > 1 && !live
    ? `<div class="mini-seg" role="radiogroup" aria-label="Connection">${(['usb', 'network'] as Transport[]).map((t) =>
      `<button role="radio" data-transport="${t}" data-group="${esc(g.key)}" aria-checked="${d.transport === t}">${icon(t === 'network' ? 'wifi' : 'usb', 13)}${t === 'network' ? 'Wi-Fi' : 'USB'}</button>`).join('')}</div>`
    : `<p class="dcard-sub">${icon(d.transport === 'network' ? 'wifi' : 'usb', 13)}<span>${esc(via(d))}</span>${wifiOffer(g, d, !!live)}</p>`;

  const more = `<button class="icon-btn more" data-more="${esc(g.key)}" title="More" aria-haspopup="menu">${icon('more', 18)}</button>`;
  const detail = d.state === 'unauthorized' ? 'Not authorized yet' : [d.osLabel, d.model && d.model !== d.name ? d.model : ''].filter(Boolean).join(' · ');
  return `<article class="dcard${live ? ' live' : ''}">
      <div class="dcard-top"><span class="dcard-icon">${icon(kindIcon(d.kind), 22)}</span>
        <span class="dcard-top-end"><span class="pill ${pill.cls}">${pill.text}</span>${more}</span></div>
      <h3>${esc(d.name)}</h3>
      <p class="dcard-detail">${esc(detail)}</p>
      <div class="dcard-conn">${picker}</div>
      <div class="dcard-foot">${foot}</div>
    </article>`;
}

function missingCard(host: string): string {
  // Discover may have just found it: then it is on the network, only not connected yet
  const found = state.discovered.find((f) => f.host === host);
  const reachable = !!found?.adb;
  return `<article class="dcard${reachable ? '' : ' dim'}">
      <div class="dcard-top"><span class="dcard-icon">${icon(found && found.kind !== 'unknown' ? 'tv' : 'wifi', 22)}</span>
        <span class="dcard-top-end"><span class="pill ${reachable ? 'ready' : ''}">${reachable ? 'Found' : 'Not reachable'}</span>
        <button class="icon-btn more" data-more-host="${esc(host)}" title="More" aria-haspopup="menu">${icon('more', 18)}</button></span></div>
      <h3>${esc(found?.name || host)}</h3>
      <p class="dcard-detail">${esc(found?.name ? `Saved Wi-Fi device · ${found.ip}` : 'Saved Wi-Fi device')}</p>
      <div class="dcard-foot">${reachable
        ? `<button class="primary" data-join="${esc(host)}">Connect</button>`
        : `<button data-retry="${esc(host)}">Try again</button>`}</div>
    </article>`;
}

/** Discovered hosts not already in the list (by address, or by name for a TV known over USB) */
function discoveredFor(tab: Tab): ScanResult[] {
  const names = new Set(state.devices.map((d) => d.name.toLowerCase()));
  const saved = new Set(state.settings?.networkHosts ?? []);
  return state.discovered.filter((f) => !f.connected && !saved.has(f.host) && !names.has(f.name.toLowerCase())
    && (tab === 'tv' ? f.kind === 'tv' : tab === 'firetv' ? f.kind !== 'tv' : false));
}

function discoveredCard(f: ScanResult): string {
  const foot = f.adb
    ? `<button class="primary" data-join="${esc(f.host)}">Connect</button>`
    : '<p class="dcard-help">Turn on ADB debugging on this TV to connect (Settings → My Fire TV → Developer options).</p>';
  return `<article class="dcard found">
      <div class="dcard-top"><span class="dcard-icon">${icon(f.kind === 'unknown' ? 'wifi' : 'tv', 22)}</span>
        <span class="pill ${f.adb ? 'ready' : 'warn'}">${f.adb ? 'Found' : 'ADB off'}</span></div>
      <h3>${esc(f.name || f.ip)}</h3>
      <p class="dcard-detail">${esc([f.ip, f.model || (f.kind === 'unknown' ? 'Android device' : '')].filter(Boolean).join(' · '))}</p>
      <div class="dcard-foot">${foot}</div>
    </article>`;
}

function currentTab(): Tab {
  const t = state.settings?.homeTab;
  return t === 'tv' || t === 'phone' ? t : 'firetv';
}

function renderHome(): void {
  const groups = groupDevices(state.devices);
  const tab = currentTab();
  $('home-tabs').innerHTML = TABS.map((t) => {
    const n = groups.filter((g) => tabOf(g) === t.id).length;
    return `<button role="tab" data-tab="${t.id}" aria-selected="${t.id === tab}">${icon(t.icon, 16)}<span>${t.label}</span>${n ? `<span class="count">${n}</span>` : ''}</button>`;
  }).join('');

  const mine = groups.filter((g) => tabOf(g) === tab);
  // Saved Wi-Fi hosts don't know their type while unreachable; they belong to the TV tabs
  const missing = tab === 'phone' ? [] : missingNetworkHosts();
  const setup = SETUP[tab];
  let html = '';
  if (!mine.length && !missing.length) {
    html = `<div class="empty">
        <h2>${setup.title}</h2>
        <p>${setup.intro}</p>
        <ol>${setup.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
        <p class="muted">Devices appear here as soon as they are detected.</p>
      </div>`;
  }
  html += `<div class="grid" id="device-grid">${mine.map(deviceCard).join('')}${missing.map(missingCard).join('')}</div>`;
  const found = discoveredFor(tab);
  if (found.length) html += `<h2 class="section-title">On your network</h2><div class="grid">${found.map(discoveredCard).join('')}</div>`;
  const hiddenCount = groupDevices(state.devices, true).length - groups.length;
  if (hiddenCount > 0) {
    html += `<p class="hidden-note">${hiddenCount} hidden device${hiddenCount > 1 ? 's' : ''} · <button class="link" data-unhide>Show</button></p>`;
  }
  $('home-content').innerHTML = html;
  $('device-grid').appendChild(addTile); // moved, not recreated: keeps what is typed in it
  const btn = $<HTMLButtonElement>('btn-discover');
  btn.disabled = state.scanning;
  btn.innerHTML = state.scanning ? '<span class="spinner small"></span><span>Searching…</span>' : `${icon('search', 16)}<span>Discover</span>`;
}

// ---------- Player & remote view ----------

function renderToolbars(): void {
  const d = device(state.current);
  const live = !!d && isLive(d.serial);
  const name = d?.name ?? state.current ?? '';
  for (const b of $$('.switch-btn')) b.innerHTML = `<span>${esc(name)}</span>${icon('chevronDown', 14)}`;
  $('fs-name').textContent = name;

  const set = d ? state.profileSets.get(d.serial) : undefined;
  const profile = set?.profiles.find((p) => p.id === profileIdFor(d!.serial));
  let status: string;
  if (live && state.status.state === 'running') {
    status = liveMode() === 'remote' ? `Remote only · ${via(d!)}` : `Connected · ${profile?.description ?? ''}`;
  } else if (live) status = 'Connecting…';
  else status = d ? stateLabel(d).text : 'Not reachable';
  for (const el of $$('[data-bind="status"]')) el.textContent = status;

  const picker = $('profile-picker');
  if (d && d.state === 'device' && set) {
    const current = profileIdFor(d.serial);
    picker.innerHTML = set.profiles.map((p) =>
      `<button role="radio" data-profile="${p.id}" aria-checked="${p.id === current}" title="${esc(`${p.description}. ${set.note}`)}">${esc(p.label)}</button>`).join('');
    picker.hidden = false;
  } else {
    picker.hidden = true;
  }

  for (const btn of $$<HTMLButtonElement>('.btn-connect')) {
    btn.textContent = live ? 'Disconnect' : 'Connect';
    btn.className = `btn-connect${live ? '' : ' primary'}`;
    btn.disabled = !live && (!d || d.state !== 'device');
  }
  const iconBtn = document.querySelector<HTMLButtonElement>('.btn-connect-icon')!;
  iconBtn.innerHTML = icon(live ? 'power' : 'link');
  iconBtn.title = live ? 'Disconnect' : 'Connect';
  iconBtn.disabled = !live && (!d || d.state !== 'device');

  const soundOn = !!state.settings?.audioEnabled;
  for (const b of $$('.btn-sound')) {
    b.innerHTML = icon('headphones'); // distinct from the remote's Mute key
    b.setAttribute('aria-pressed', String(soundOn));
    b.title = soundOn
      ? `Sound plays on this computer; the TV is silent meanwhile. Click to send it back to the TV (${MOD}U)`
      : `Play the sound on this computer (${MOD}U)`;
  }
  const rec = $('btn-record');
  rec.classList.toggle('recording', !!state.recordingSince);
  rec.innerHTML = state.recordingSince
    ? `${icon('stop', 16)}<span class="rec-time">${formatDuration((Date.now() - state.recordingSince) / 1000)}</span>`
    : icon('record');
  rec.title = state.recordingSince ? `Stop recording (${MOD}⇧C)` : `Record the screen (${MOD}⇧C)`;
  ($('btn-record') as HTMLButtonElement).disabled = !(isRunning() && liveMode() === 'mirror');
  for (const b of $$<HTMLButtonElement>('.btn-shot')) b.disabled = !(d && d.state === 'device');
  $('btn-stats').setAttribute('aria-pressed', String(!!state.settings?.showStats));
  $('btn-remote').setAttribute('aria-pressed', String(state.settings?.remoteVisible !== false));
  $('btn-pin').setAttribute('aria-pressed', String(!!state.settings?.remoteOnTop));
  $('player').classList.toggle('remote-hidden', state.settings?.remoteVisible === false);
  $('remote').classList.toggle('disabled', !isRunning());
}

function renderSwitchMenu(): void {
  const visible = new Set(groupDevices(state.devices).flatMap((g) => g.conns.map((c) => c.serial)));
  const items = state.devices.filter((d) => visible.has(d.serial) || d.serial === state.current).map((d) => {
    const pill = stateLabel(d);
    const current = d.serial === state.current;
    return `<button role="menuitem" class="menu-item${current ? ' current' : ''}" data-switch="${esc(d.serial)}" ${d.state !== 'device' ? 'disabled' : ''}>
        ${icon(kindIcon(d.kind), 18)}
        <span class="menu-text"><span>${esc(d.name)}</span><small>${esc(subline(d))}</small></span>
        <span class="pill ${pill.cls}">${pill.text}</span>
      </button>`;
  }).join('');
  $('switch-menu').innerHTML = `${items || '<p class="menu-empty">No devices detected</p>'}
    <div class="menu-sep"></div>
    <button role="menuitem" class="menu-item" data-menu="home">${icon('grid', 18)}<span class="menu-text"><span>All devices</span></span></button>`;
}

function setMenu(open: boolean, anchor?: HTMLElement): void {
  state.menuOpen = open;
  const menu = $('switch-menu');
  if (open && anchor) {
    renderSwitchMenu();
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 328))}px`;
  }
  menu.hidden = !open;
  for (const b of $$('.switch-btn')) b.setAttribute('aria-expanded', String(open && b === anchor));
  if (!open) focusTarget().focus();
}

function card(o: { icon?: string; warn?: boolean; spinner?: boolean; title: string; meta?: string; body?: string; actions?: string }): string {
  const top = o.spinner ? '<div class="spinner" role="status"></div>'
    : o.icon ? `<div class="card-icon${o.warn ? ' warn' : ''}">${icon(o.icon, 24)}</div>` : '';
  return `<div class="card">${top}<h2>${o.title}</h2>${o.meta ? `<p class="meta">${o.meta}</p>` : ''}`
    + `${o.body ? `<p>${o.body}</p>` : ''}${o.actions ? `<div class="actions">${o.actions}</div>` : ''}</div>`;
}

const backToDevices = '<button data-stage="home">All devices</button>';

/** Status card for the current device, or '' when the live view (picture or remote) should show */
function statusCard(mode: SessionMode): string {
  const serial = state.current;
  const d = device(serial);
  const s = state.status;
  if (!serial) return '';
  if (!d) {
    return card({ icon: 'wifi', warn: true, title: 'Not reachable', meta: esc(serial),
      body: 'The device is not answering. Check that it is on, on the same network, and that ADB debugging is on.',
      actions: `${backToDevices}<button class="primary" data-stage="retry">Try again</button>` });
  }
  const meta = esc([d.osLabel, via(d)].filter(Boolean).join(' · '));
  if (d.state === 'unauthorized') {
    return card({ icon: 'alert', warn: true, title: 'Allow this computer on the device', meta,
      body: 'The device is showing "Allow USB debugging?". Select "Always allow from this computer", then OK. This screen updates by itself.',
      actions: backToDevices });
  }
  if (d.state === 'offline') {
    return card({ icon: 'alert', warn: true, title: 'Device offline', meta,
      body: 'Reconnect the cable, or turn ADB debugging off and on again.', actions: backToDevices });
  }
  if (d.state !== 'device') return card({ spinner: true, title: 'Waiting for the device…', meta });
  if (isLive(d.serial)) {
    if (s.state === 'connecting') return card({ spinner: true, title: `Connecting to ${esc(d.name)}…`, meta });
    if (mode === 'mirror' && !video.hasFrame) return card({ spinner: true, title: 'Starting the picture…', meta });
    return '';
  }
  const again = `<button class="primary" data-stage="connect">${s.state === 'ended' && s.cause !== 'user' ? 'Reconnect' : 'Connect'}</button>`;
  if (s.state === 'ended' && s.serial === d.serial && s.cause !== 'user') {
    return card({ icon: 'alert', warn: true, title: s.cause === 'unplugged' ? 'Device disconnected' : 'Connection ended', meta,
      body: esc(s.reason), actions: `${backToDevices}${again}` });
  }
  return card({ icon: kindIcon(d.kind), title: 'Disconnected', meta: `${esc(d.name)} · ${meta}`, actions: `${backToDevices}${again}` });
}

function renderFavorites(): void {
  const favs = favoritesFor(state.current).slice(0, 3);
  const html = favs.map((pkg) => {
    const app = apps.byPkg(pkg) ?? { pkg, name: pkg.split('.').pop() ?? pkg, system: false };
    return `<button class="fav" data-fav="${esc(pkg)}" title="Open ${esc(app.name)}">${appIcon(app, apps.art[pkg], 28)}<span>${esc(app.name)}</span></button>`;
  }).join('') + `<button class="fav all" data-apps title="All apps (${MOD}A)">${icon('grid', 18)}<span>${favs.length ? 'All apps' : 'Apps'}</span></button>`;
  const row = $('fav-apps');
  if (row.dataset.html !== html) {
    row.dataset.html = html;
    row.innerHTML = html;
    row.classList.toggle('empty', !favs.length);
    paintAvatars(row);
  }
}

function renderRemotePanel(): void {
  renderFavorites();
  const kind = device(state.current)?.kind ?? 'firetv';
  $('stage').classList.toggle('touch', kind === 'phone');
  if (kind === state.remoteKind) return;
  state.remoteKind = kind;
  $('remote-buttons').innerHTML = renderRemote(kind);
  const hasDpad = layoutFor(kind).some((s) => s.type === 'dpad');
  const rows: [string, string][] = [
    ...(hasDpad ? [['← ↑ → ↓', 'Navigate'], ['Enter', 'OK']] as [string, string][] : []),
    ['Esc', 'Back'],
    ...(kind === 'phone' ? [['Click', 'Tap'], ['Drag', 'Swipe'], ['Right\u00a0click', 'Back'], ['Wheel', 'Scroll']] as [string, string][] : []),
    ['A–Z, 0–9', 'Type on the device'],
    ['Backspace', 'Delete a character'],
    [`${MOD}H`, 'Home'], [`${MOD}M`, 'Menu'],
    ...(kind !== 'phone' ? [[`${MOD}S`, 'Settings']] as [string, string][] : []),
    ...(kind === 'firetv' ? [[`${MOD}Q`, 'Quick settings']] as [string, string][] : []),
    [`${MOD}Space`, 'Play / Pause'], [`${MOD}← ${MOD}→`, 'Rewind / Forward'],
    [`${MOD}↑ ${MOD}↓`, 'Volume'], [`${MOD}0`, 'Mute'],
    [`${MOD}A`, 'Apps'], [`${MOD}U`, 'Sound on this computer'],
    [`${MOD}C`, 'Screenshot'], [`${MOD}⇧C`, 'Record the screen'], [`${MOD}D`, 'Device status'],
    [`${MOD}V`, 'Paste clipboard'], [`${MOD}F`, 'Fullscreen'],
  ];
  $('shortcuts').innerHTML = rows.map(([k, v]) =>
    `<dt>${k.split(' ').map((x) => `<kbd>${esc(x)}</kbd>`).join('')}</dt><dd>${esc(v)}</dd>`).join('');
}

function renderPlayer(): void {
  const html = statusCard('mirror');
  if ($('overlay').innerHTML !== html) $('overlay').innerHTML = html;
  $('screen').hidden = !(state.current && isLive(state.current) && video.hasFrame);
}

function renderRemoteView(): void {
  const html = statusCard('remote');
  if ($('remote-overlay').innerHTML !== html) $('remote-overlay').innerHTML = html;
  $('remote-view').classList.toggle('has-card', !!html);
}

function render(): void {
  for (const v of ['home', 'player', 'remote-view']) $(v).hidden = v !== (state.view === 'remote' ? 'remote-view' : state.view);
  // The remote panel lives in whichever view shows it
  const slot = state.view === 'remote' ? $('remote-view-slot') : $('player-remote-slot');
  if ($('remote').parentElement !== slot) slot.appendChild($('remote'));
  if (state.view === 'home') { renderHome(); return; }
  renderToolbars();
  renderRemotePanel();
  if (state.view === 'player') renderPlayer();
  else renderRemoteView();
  if (state.menuOpen) renderSwitchMenu();
}

const focusTarget = () => (state.view === 'remote' ? $('remote-view') : $('stage'));

// ---------- Actions ----------

const profileRequests = new Map<string, Promise<void>>();
function loadProfiles(serial: string): Promise<void> {
  if (state.profileSets.has(serial)) return Promise.resolve();
  let req = profileRequests.get(serial);
  if (!req) {
    // Encoder detection runs the server once per device: share one request
    req = api.profilesFor(serial).then((set) => { state.profileSets.set(serial, set); render(); })
      .finally(() => profileRequests.delete(serial));
    profileRequests.set(serial, req);
  }
  return req;
}

function setView(view: View, serial?: string): void {
  const was = state.view;
  if (serial) state.current = serial;
  state.view = view;
  if (view === 'remote' && was !== 'remote') {
    api.setCompact(true);
    api.setAlwaysOnTop(!!state.settings?.remoteOnTop);
  } else if (view !== 'remote' && was === 'remote') {
    api.setCompact(false);
  }
  render();
  focusTarget().focus();
}

async function connect(serial: string, mode: SessionMode, profileId?: string): Promise<void> {
  const d = device(serial);
  if (!d || d.state !== 'device') return;
  setView(mode === 'remote' ? 'remote' : 'player', serial);
  await loadProfiles(serial);
  try {
    await api.start(serial, profileId ?? profileIdFor(serial), mode);
  } catch {
    // Reported through the 'ended' status
  }
  focusTarget().focus();
}

/** Opens an already-live device in the view matching its session */
function openLive(serial: string): void {
  setView(liveMode() === 'remote' ? 'remote' : 'player', serial);
}

async function setProfile(profileId: string): Promise<void> {
  const serial = state.current;
  if (!serial || !state.settings) return;
  state.settings.profileBySerial = { ...state.settings.profileBySerial, [serial]: profileId };
  await api.setSettings({ profileBySerial: state.settings.profileBySerial });
  render();
  if (isLive(serial) && liveMode() === 'mirror') await connect(serial, 'mirror', profileId);
}

async function saveSetting(patch: Partial<Settings>): Promise<void> {
  if (!state.settings) return;
  Object.assign(state.settings, patch);
  await api.setSettings(patch);
  render();
}

function goHome(): void {
  setMenu(false);
  setView('home');
}

async function forget(host: string): Promise<void> {
  await api.forgetNetwork(host);
  state.settings = await api.getSettings();
  if (state.current === host) state.current = null;
  render();
}

async function retry(host: string): Promise<void> {
  await api.connectNetwork(host);
  state.settings = await api.getSettings();
  render();
}

async function discover(manual: boolean): Promise<void> {
  if (state.scanning) return;
  state.scanning = true;
  renderHome();
  try {
    state.discovered = await api.scanNetwork();
  } finally {
    state.scanning = false;
    state.discoveredOnce = true;
  }
  if (manual) {
    const n = discoveredFor(currentTab()).length;
    const twins = groupDevices(state.devices).map(discoveredTwin).filter((f): f is ScanResult => !!f);
    const already = state.discovered.filter((f) => f.connected).length;
    if (n) toast(`Found ${n} new device${n > 1 ? 's' : ''} on your network.`, { kind: 'ok' });
    else if (twins.length) toast(`${twins.map((t) => t.name).join(', ')} ${twins.length > 1 ? 'are' : 'is'} also on your network. Use Connect over Wi-Fi on the card.`, { kind: 'ok', ms: 7000 });
    else if (already) toast(`Found ${already} device${already > 1 ? 's' : ''} on your network, already connected.`, { kind: 'info' });
    else toast('No devices found on your network. ADB debugging must be on, on the same network.', { kind: 'info', ms: 7000 });
  }
  render();
}

async function join(host: string): Promise<void> {
  toast(`Connecting to ${host}… If the TV asks, allow USB debugging.`, { ms: 4000 });
  const result = await api.connectNetwork(host);
  state.settings = await api.getSettings();
  toast(result.message, { kind: result.ok ? 'ok' : 'error' });
  render();
}

/** Items marked danger need a second click ("Click again to …") before they run */
function openCardMenu(anchor: HTMLElement, items: { label: string; danger?: boolean; confirm?: string; run: () => void }[]): void {
  const menu = $('card-menu');
  const armed = new Set<number>();
  const draw = () => {
    menu.innerHTML = items.map((it, i) => `<button role="menuitem" class="menu-item${it.danger ? ' danger' : ''}${armed.has(i) ? ' armed' : ''}" data-i="${i}"><span class="menu-text"><span>${esc(armed.has(i) ? it.confirm ?? 'Click again to confirm' : it.label)}</span></span></button>`).join('');
  };
  draw();
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(8, Math.min(r.right - 240, window.innerWidth - 248))}px`;
  menu.hidden = false;
  menu.onclick = (e) => {
    const i = Number((e.target as HTMLElement).closest<HTMLElement>('[data-i]')?.dataset.i);
    if (Number.isNaN(i)) return;
    if (items[i].danger && !armed.has(i)) { armed.add(i); draw(); return; }
    menu.hidden = true;
    items[i].run();
  };
}

function deviceMenu(anchor: HTMLElement, key: string): void {
  const g = groupDevices(state.devices).find((x) => x.key === key);
  if (!g) return;
  const d = primaryConn(g);
  const net = g.conns.find((c) => c.transport === 'network');
  const usb = g.conns.some((c) => c.transport === 'usb');
  const items: { label: string; danger?: boolean; confirm?: string; run: () => void }[] = [];
  if (net && usb) items.push({ label: 'Forget Wi-Fi connection', run: () => void forget(net.serial) });
  items.push({
    label: usb ? 'Remove and hide from the list' : 'Remove from StickPilot',
    danger: true,
    confirm: 'Click again to remove (clears its favorites)',
    run: () => void removeDevice(g, d.name, usb),
  });
  openCardMenu(anchor, items);
}

async function removeDevice(g: DeviceGroup, name: string, usb: boolean): Promise<void> {
  await api.removeDevice(g.key, g.conns.map((c) => c.serial));
  state.settings = await api.getSettings();
  if (g.conns.some((c) => c.serial === state.current)) state.current = null;
  toast(usb ? `${name} is hidden. Unplug it, or use Show at the bottom to bring it back.` : `${name} was removed.`, { kind: 'ok', ms: 6000 });
  render();
}

async function setupWifi(btn: HTMLElement, serial: string): Promise<void> {
  btn.textContent = 'Setting up…';
  btn.setAttribute('disabled', '');
  const result = await api.enableWifi(serial);
  state.settings = await api.getSettings();
  toast(result.ok ? 'Wi-Fi connection added. You can now unplug the cable.' : result.message, { kind: result.ok ? 'ok' : 'error' });
  render();
}

function maybeAutoConnect(): void {
  const s = state.settings;
  if (state.autoConnectTried || !s?.autoConnect || !s.lastSerial) return;
  const d = device(s.lastSerial);
  if (d?.state !== 'device') return;
  state.autoConnectTried = true;
  void connect(d.serial, 'mirror');
}

/** Connect / disconnect toggle for the current device, keeping the current view's mode */
function toggleConnection(): void {
  const serial = state.current;
  if (!serial) return;
  if (isLive(serial)) void api.stop();
  else void connect(serial, state.view === 'remote' ? 'remote' : 'mirror');
}

// ---------- Apps ----------

const apps = new AppsPanel($('apps-panel'), api, {
  serial: () => (isRunning() ? state.current : null),
  favorites: () => favoritesFor(state.current),
  setFavorites: (pkgs) => {
    if (!state.settings) return;
    void saveSetting({ favoriteApps: { ...state.settings.favoriteApps, [deviceKey(state.current)]: pkgs } });
  },
  toast: (m, kind) => toast(m, { kind }),
  done: () => focusTarget().focus(),
});
apps.onLoaded = () => renderFavorites();

const devicePanel = new DevicePanel($('device-panel'), api, {
  device: () => device(state.current),
  toast: (m, kind) => toast(m, { kind }),
  done: () => focusTarget().focus(),
});

function toggleApps(): void {
  if (!isRunning()) return;
  apps.toggle();
}

// ---------- Screenshots and recording ----------

const formatDuration = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function takeScreenshot(): Promise<void> {
  const d = device(state.current);
  if (!d || d.state !== 'device') return;
  const r = await api.screenshot(d.serial);
  if (r.ok && r.file) toast('Screenshot saved to Pictures › StickPilot.', { kind: 'ok', action: { label: 'Show', run: () => api.showInFolder(r.file!) } });
  else toast(r.message ?? 'The screenshot failed.', { kind: 'error' });
}

function recordingSaved(r: { file: string; seconds: number } | null): void {
  state.recordingSince = 0;
  render();
  if (r) toast(`Recording saved (${formatDuration(r.seconds)}) to Movies › StickPilot.`, { kind: 'ok', ms: 8000, action: { label: 'Show', run: () => api.showInFolder(r.file) } });
}

async function toggleRecording(): Promise<void> {
  if (state.recordingSince) { recordingSaved(await api.stopRecording()); return; }
  if (!isRunning() || liveMode() !== 'mirror') return;
  const canvas = $<HTMLCanvasElement>('screen');
  try {
    await api.startRecording(canvas.width, canvas.height);
    state.recordingSince = Date.now();
    render();
  } catch (e) {
    toast((e as Error).message.replace(/^Error invoking remote method '[\w:]+': Error: /, ''), { kind: 'error' });
  }
}

setInterval(() => { if (state.recordingSince && state.view === 'player') renderToolbars(); }, 1000);
api.onRecordingStopped(recordingSaved);

// ---------- Dropped files: APKs are installed, anything else goes to Download ----------

function dropTarget(): DeviceInfo | undefined {
  if (state.view === 'home') {
    // On the device screen, only when there's no doubt which device is meant
    const ready = groupDevices(state.devices).map(primaryConn).filter((d) => d.state === 'device');
    return ready.length === 1 ? ready[0] : undefined;
  }
  const d = device(state.current);
  return d?.state === 'device' ? d : undefined;
}

function setupDrop(): void {
  let depth = 0;
  const zone = $('drop-zone');
  const hide = () => { depth = 0; zone.hidden = true; };
  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    depth++;
    const d = dropTarget();
    const items = [...(e.dataTransfer.items ?? [])];
    // File names aren't readable until the drop; the MIME type tells APKs apart where available
    const apk = items.length > 0 && items.every((i) => i.type === 'application/vnd.android.package-archive');
    $('drop-icon').innerHTML = icon(d ? (apk ? 'plus' : 'send') : 'alert', 28);
    $('drop-text').innerHTML = d
      ? (apk ? `Drop to install on <b>${esc(d.name)}</b>` : `Drop to install APKs or copy files to <b>${esc(d.name)}</b>`)
      : 'Connect or select a device first';
    zone.classList.toggle('invalid', !d);
    zone.hidden = false;
  });
  document.addEventListener('dragleave', () => { if (--depth <= 0) hide(); });
  // Without this, Electron opens a dropped file in place of the app
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    hide();
    const d = dropTarget();
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!d || !files.length) return;
    void (async () => {
      for (const f of files) {
        const path = api.pathForFile(f);
        const isApk = /\.apk$/i.test(f.name);
        toast(isApk ? `Installing ${f.name} on ${d.name}…` : `Copying ${f.name} to ${d.name}…`, { ms: 3000 });
        const r = isApk ? await api.installApk(d.serial, path) : await api.pushFile(d.serial, path);
        toast(r.message, { kind: r.ok ? 'ok' : 'error', ms: r.ok ? 5000 : 9000 });
        if (r.ok && isApk) void apps.load(true); // the launcher should list the new app
      }
    })();
  });
}

// ---------- Sound ----------

const audio = new AudioPlayer(api);
audio.onEnded = () => {
  if (state.settings?.audioEnabled && state.status.state === 'running') {
    toast('The device stopped sending sound. It may not support sound forwarding.', { kind: 'error' });
  }
};

async function toggleSound(): Promise<void> {
  if (!state.settings) return;
  const on = !state.settings.audioEnabled;
  await saveSetting({ audioEnabled: on });
  const serial = liveSerial();
  const mode = liveMode();
  if (on) toast('Sound now plays on this computer. The TV speakers stay silent until you turn it off.', { kind: 'info', ms: 6000 });
  // The sound stream is chosen when the connection starts: reconnect to apply
  if (serial && mode) await connect(serial, mode);
}

/** Warns when the picture lags while sound is on, and offers to turn it off */
const lagWatch = { seconds: 0, warnedAt: 0 };
function watchLag(): void {
  const s = state.status;
  if (s.state !== 'running' || !s.audio || s.mode !== 'mirror') { lagWatch.seconds = 0; return; }
  lagWatch.seconds = video.lastLagMs > 150 ? lagWatch.seconds + 1 : 0;
  if (lagWatch.seconds >= 4 && Date.now() - lagWatch.warnedAt > 60_000) {
    lagWatch.warnedAt = Date.now();
    toast('The picture is lagging behind. Turning off sound may help.', {
      kind: 'error', ms: 10000, action: { label: 'Turn off sound', run: () => void toggleSound() },
    });
  }
}

// ---------- Video & fullscreen ----------

const video = new Video($<HTMLCanvasElement>('screen'), api);
video.onFirstFrame = () => render();

setInterval(() => {
  const show = !!state.settings?.showStats && video.hasFrame && state.view === 'player';
  $('stats').hidden = !show;
  const text = video.takeStats() + (audio.active ? `\nsound   ${audio.bufferedMs().toFixed(0).padStart(4)} ms buffered` : '');
  if (show) $('stats').textContent = text;
  watchLag();
}, 1000);

let fsTimer: number | undefined;
function showFsBar(): void {
  if (!state.fullscreen) return;
  $('fs-bar').classList.add('visible');
  clearTimeout(fsTimer);
  fsTimer = window.setTimeout(() => $('fs-bar').classList.remove('visible'), 2200);
}

// ---------- Wiring ----------

function wire(): void {
  document.body.classList.toggle('mac', isMac);
  $('brand-icon').innerHTML = '<img src="logo.png" width="28" height="28" alt="">';
  for (const b of $$('.nav-home')) {
    b.innerHTML = b.classList.contains('icon-btn') ? icon('chevronLeft', 18) : `${icon('chevronLeft', 16)}<span>Devices</span>`;
    b.addEventListener('click', goHome);
  }
  const titled = (id: string, ico: string, title: string) => { $(id).innerHTML = icon(ico); $(id).title = title; };
  titled('btn-apps', 'grid', `Apps (${MOD}A)`);
  titled('btn-apps-compact', 'grid', `Apps (${MOD}A)`);
  titled('btn-remote-only', 'remote', 'Remote only: stop the picture, keep the remote');
  titled('btn-stats', 'stats', `Latency stats (${MOD}I)`);
  titled('btn-fullscreen', 'fullscreen', `Fullscreen (${MOD}F)`);
  titled('btn-remote', 'panel', `Show or hide the remote (${MOD}R)`);
  titled('btn-pin', 'pin', 'Keep this window on top');
  titled('btn-show-screen', 'tv', 'Show the screen');
  $('type-send').innerHTML = icon('send', 18);
  $('fs-exit').innerHTML = `${icon('exitFullscreen', 16)}<span>Exit fullscreen</span>`;
  buildAddTile();
  setupDrop();

  // Device screen
  $('home-tabs').addEventListener('click', (e) => {
    const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab as Tab | undefined;
    if (tab) void saveSetting({ homeTab: tab });
  });
  $('home-content').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    if (t.dataset.connect) void connect(t.dataset.connect, t.dataset.mode === 'remote' ? 'remote' : 'mirror');
    if (t.dataset.open) openLive(t.dataset.open);
    if (t.dataset.forget) void forget(t.dataset.forget);
    if (t.dataset.retry) void retry(t.dataset.retry);
    if (t.dataset.wifi) void setupWifi(t, t.dataset.wifi);
    if (t.dataset.more) deviceMenu(t, t.dataset.more);
    if (t.dataset.moreHost) {
      const host = t.dataset.moreHost;
      openCardMenu(t, [{ label: 'Remove from StickPilot', danger: true, confirm: 'Click again to remove', run: () => void forget(host) }]);
    }
    if (t.dataset.join) void join(t.dataset.join);
    if (t.dataset.unhide !== undefined) void saveSetting({ hiddenDevices: [] });
    if (t.dataset.transport && t.dataset.group && state.settings) {
      void saveSetting({ transportByDevice: { ...state.settings.transportByDevice, [t.dataset.group]: t.dataset.transport as Transport } });
    }
  });
  $('btn-discover').addEventListener('click', () => void discover(true));
  document.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement;
    if (!$('card-menu').hidden && !t.closest('#card-menu') && !t.closest('[data-more], [data-more-host]')) $('card-menu').hidden = true;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('card-menu').hidden = true; });
  $<HTMLInputElement>('auto-connect').addEventListener('change', (e) =>
    saveSetting({ autoConnect: (e.target as HTMLInputElement).checked }));

  // Toolbars
  for (const b of $$('.switch-btn')) b.addEventListener('click', () => setMenu(!state.menuOpen, b));
  $('switch-menu').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    if (t.dataset.menu === 'home') { goHome(); return; }
    const serial = t.dataset.switch;
    setMenu(false);
    if (serial && serial !== liveSerial()) void connect(serial, state.view === 'remote' ? 'remote' : 'mirror');
  });
  document.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement;
    if (state.menuOpen && !t.closest('#switch-menu') && !t.closest('.switch-btn')) setMenu(false);
  });
  document.addEventListener('keydown', (e) => { if (state.menuOpen && e.key === 'Escape') setMenu(false); });

  $('profile-picker').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-profile]')?.dataset.profile;
    if (id) void setProfile(id);
  });
  for (const b of $$('.btn-connect, .btn-connect-icon')) b.addEventListener('click', toggleConnection);
  const toggleStats = () => saveSetting({ showStats: !state.settings?.showStats });
  const toggleRemote = () => saveSetting({ remoteVisible: state.settings?.remoteVisible === false });
  const toggleFullscreen = () => { if (state.view === 'player') api.toggleFullscreen(); };
  $('btn-stats').addEventListener('click', toggleStats);
  $('btn-remote').addEventListener('click', toggleRemote);
  $('btn-fullscreen').addEventListener('click', toggleFullscreen);
  $('fs-exit').addEventListener('click', () => api.toggleFullscreen());
  for (const b of $$('.btn-sound')) b.addEventListener('click', () => void toggleSound());
  for (const b of $$('.btn-info')) { b.innerHTML = icon('info'); b.title = `Device status and power (${MOD}D)`; b.addEventListener('click', () => devicePanel.toggle()); }
  for (const b of $$('.btn-shot')) { b.innerHTML = icon('camera'); b.title = `Screenshot (${MOD}C)`; b.addEventListener('click', () => void takeScreenshot()); }
  $('btn-record').addEventListener('click', () => void toggleRecording());
  $('btn-apps').addEventListener('click', toggleApps);
  $('btn-apps-compact').addEventListener('click', toggleApps);
  $('fav-apps').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t || !isRunning()) return;
    if (t.dataset.apps !== undefined) toggleApps();
    else if (t.dataset.fav) void apps.launch(t.dataset.fav);
  });
  $('btn-remote-only').addEventListener('click', () => { if (state.current) void connect(state.current, 'remote'); });
  $('btn-show-screen').addEventListener('click', () => { if (state.current) void connect(state.current, 'mirror'); });
  $('btn-pin').addEventListener('click', () => {
    const on = !state.settings?.remoteOnTop;
    api.setAlwaysOnTop(on);
    void saveSetting({ remoteOnTop: on });
  });

  const onStageAction = (e: Event) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-stage]')?.dataset.stage;
    if (action === 'home') goHome();
    if (action === 'connect' && state.current) void connect(state.current, state.view === 'remote' ? 'remote' : 'mirror');
    if (action === 'retry' && state.current) void retry(state.current);
  };
  $('overlay').addEventListener('click', onStageAction);
  $('remote-overlay').addEventListener('click', onStageAction);

  // Remote
  const quickSettings = () => triggerQuickSettings($('remote-buttons'), api);
  bindRemote($('remote-buttons'), api, isRunning);
  $('type-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('type-text');
    if (isRunning() && input.value) api.type(input.value);
    input.value = '';
    focusTarget().focus();
  });

  bindKeyboard(api, {
    active: () => state.view !== 'home' && isRunning(),
    menuOpen: () => state.menuOpen || apps.isOpen || devicePanel.isOpen,
    flash: (code, down) => flashKey($('remote-buttons'), code, down),
    toggleFullscreen,
    toggleStats,
    toggleRemote,
    quickSettings,
    toggleApps,
    toggleSound: () => void toggleSound(),
    screenshot: () => void takeScreenshot(),
    toggleRecording: () => void toggleRecording(),
    toggleDevicePanel: () => devicePanel.toggle(),
  });
  bindTouch($<HTMLCanvasElement>('screen'), api, {
    enabled: () => isRunning() && liveMode() === 'mirror' && device(state.current)?.kind === 'phone',
    flash: (code, down) => flashKey($('remote-buttons'), code, down),
  });
  // pointerdown: touch cancels the mousedown that would otherwise follow
  $('stage').addEventListener('pointerdown', () => $('stage').focus());
  $('stage').addEventListener('mousemove', showFsBar);

  // Device and session updates
  api.onDevices((list) => {
    state.devices = list;
    for (const d of list) if (d.state === 'device') void loadProfiles(d.serial);
    maybeAutoConnect();
    render();
  });
  api.onStatus((s) => {
    const wasLive = liveSerial();
    const wasMode = liveMode();
    state.status = s;
    if (s.state === 'running' && favoritesFor(s.serial).length) void apps.load(false);
    if (s.state !== 'running') { apps.close(); audio.stop(); }
    // The session may change mode from outside this window (menu-bar remote, window closed)
    if (s.state === 'running' && s.serial === state.current) {
      if (s.mode === 'remote' && state.view === 'player') { setView('remote'); return; }
      if (s.mode === 'mirror' && state.view === 'remote') { setView('player'); return; }
    }
    if (s.state === 'running' && state.view === 'home' && !state.current) state.current = s.serial;
    if (s.state !== 'running' || s.mode !== 'mirror') video.clear();
    else if (wasLive !== s.serial || wasMode !== 'mirror') video.hasFrame = false;
    render();
  });
  api.onNotice((n) => toast(n.message, {
    kind: 'info',
    ms: n.action ? 20000 : 9000,
    action: n.action === 'accessibility' ? { label: 'Allow access', run: () => api.openAccessibilitySettings() } : undefined,
  }));
  api.onFullscreen((on) => {
    state.fullscreen = on;
    document.body.classList.toggle('fullscreen', on);
    $('fs-bar').classList.toggle('visible', on);
    if (on) showFsBar();
    focusTarget().focus();
  });
}

async function init(): Promise<void> {
  wire();
  state.settings = await api.getSettings();
  $<HTMLInputElement>('auto-connect').checked = !!state.settings.autoConnect;
  state.devices = await api.listDevices();
  for (const d of state.devices) if (d.state === 'device') void loadProfiles(d.serial);
  render();
  maybeAutoConnect();
  // One quiet search after launch; the Discover button repeats it
  setTimeout(() => void discover(false), 1500);
}

void init();
