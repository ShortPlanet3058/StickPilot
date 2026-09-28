import { icon } from './icons';
import { bindKeyboard } from './keyboard';
import { bindRemote, flashKey, isMac, layoutFor, MOD, renderRemote, triggerQuickSettings } from './remote';
import { Video } from './video';
import type { DeviceInfo, DeviceKind, FireTvApi, ProfileSet, SessionMode, SessionStatus, Settings, Transport } from '../shared/types';

declare global {
  interface Window { firetv: FireTvApi }
}

const api = window.firetv;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type View = 'home' | 'player' | 'remote';
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
  remoteKind: null as DeviceKind | null,
};

const device = (serial: string | null) => state.devices.find((d) => d.serial === serial);
const liveSerial = () => (state.status.state === 'running' || state.status.state === 'connecting') ? state.status.serial : null;
const liveMode = (): SessionMode | null => (state.status.state === 'running' || state.status.state === 'connecting') ? state.status.mode : null;
const isLive = (serial: string) => liveSerial() === serial;
const isRunning = () => state.status.state === 'running' && state.status.serial === state.current;
const missingNetworkHosts = () => (state.settings?.networkHosts ?? []).filter((h) => !device(h));

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

function groupDevices(list: DeviceInfo[]): DeviceGroup[] {
  const groups = new Map<string, DeviceGroup>();
  for (const d of list) {
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
    : `<p class="dcard-sub">${icon(d.transport === 'network' ? 'wifi' : 'usb', 13)}<span>${esc(via(d))}</span></p>`;

  const net = g.conns.find((c) => c.transport === 'network');
  const forget = net
    ? `<button class="icon-btn forget" data-forget="${esc(net.serial)}" title="Forget the Wi-Fi connection">${icon('close', 15)}</button>` : '';
  const detail = d.state === 'unauthorized' ? 'Not authorized yet' : [d.osLabel, d.model && d.model !== d.name ? d.model : ''].filter(Boolean).join(' · ');
  return `<article class="dcard${live ? ' live' : ''}">
      <div class="dcard-top"><span class="dcard-icon">${icon(kindIcon(d.kind), 22)}</span>
        <span class="pill ${pill.cls}">${pill.text}</span>${forget}</div>
      <h3>${esc(d.name)}</h3>
      <p class="dcard-detail">${esc(detail)}</p>
      <div class="dcard-conn">${picker}</div>
      <div class="dcard-foot">${foot}</div>
    </article>`;
}

function missingCard(host: string): string {
  return `<article class="dcard dim">
      <div class="dcard-top"><span class="dcard-icon">${icon('wifi', 22)}</span><span class="pill">Not reachable</span>
        <button class="icon-btn forget" data-forget="${esc(host)}" title="Forget this device">${icon('close', 15)}</button></div>
      <h3>${esc(host)}</h3>
      <p class="dcard-detail">Saved Wi-Fi device</p>
      <div class="dcard-foot"><button data-retry="${esc(host)}">Try again</button></div>
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
  $('home-content').innerHTML = html;
  $('device-grid').appendChild(addTile); // moved, not recreated: keeps what is typed in it
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

  $('btn-stats').setAttribute('aria-pressed', String(!!state.settings?.showStats));
  $('btn-remote').setAttribute('aria-pressed', String(state.settings?.remoteVisible !== false));
  $('btn-pin').setAttribute('aria-pressed', String(!!state.settings?.remoteOnTop));
  $('player').classList.toggle('remote-hidden', state.settings?.remoteVisible === false);
  $('remote').classList.toggle('disabled', !isRunning());
}

function renderSwitchMenu(): void {
  const items = state.devices.map((d) => {
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

function renderRemotePanel(): void {
  const kind = device(state.current)?.kind ?? 'firetv';
  if (kind === state.remoteKind) return;
  state.remoteKind = kind;
  $('remote-buttons').innerHTML = renderRemote(kind);
  const hasDpad = layoutFor(kind).some((s) => s.type === 'dpad');
  const rows: [string, string][] = [
    ...(hasDpad ? [['← ↑ → ↓', 'Navigate'], ['Enter', 'OK']] as [string, string][] : []),
    ['Esc', 'Back'],
    ['A–Z, 0–9', 'Type on the device'],
    ['Backspace', 'Delete a character'],
    [`${MOD}H`, 'Home'], [`${MOD}M`, 'Menu'],
    ...(kind !== 'phone' ? [[`${MOD}S`, 'Settings']] as [string, string][] : []),
    ...(kind === 'firetv' ? [[`${MOD}Q`, 'Quick settings']] as [string, string][] : []),
    [`${MOD}Space`, 'Play / Pause'], [`${MOD}← ${MOD}→`, 'Rewind / Forward'],
    [`${MOD}↑ ${MOD}↓`, 'Volume'], [`${MOD}0`, 'Mute'],
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

// ---------- Video & fullscreen ----------

const video = new Video($<HTMLCanvasElement>('screen'), api);
video.onFirstFrame = () => render();

setInterval(() => {
  const show = !!state.settings?.showStats && video.hasFrame && state.view === 'player';
  $('stats').hidden = !show;
  const text = video.takeStats();
  if (show) $('stats').textContent = text;
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
  $('brand-icon').innerHTML = icon('tv', 20);
  for (const b of $$('.nav-home')) {
    b.innerHTML = b.classList.contains('icon-btn') ? icon('chevronLeft', 18) : `${icon('chevronLeft', 16)}<span>Devices</span>`;
    b.addEventListener('click', goHome);
  }
  const titled = (id: string, ico: string, title: string) => { $(id).innerHTML = icon(ico); $(id).title = title; };
  titled('btn-remote-only', 'remote', 'Remote only: stop the picture, keep the remote');
  titled('btn-stats', 'stats', `Latency stats (${MOD}I)`);
  titled('btn-fullscreen', 'fullscreen', `Fullscreen (${MOD}F)`);
  titled('btn-remote', 'panel', `Show or hide the remote (${MOD}R)`);
  titled('btn-pin', 'pin', 'Keep this window on top');
  titled('btn-show-screen', 'tv', 'Show the screen');
  $('type-send').innerHTML = icon('send', 18);
  $('fs-exit').innerHTML = `${icon('exitFullscreen', 16)}<span>Exit fullscreen</span>`;
  buildAddTile();

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
    if (t.dataset.transport && t.dataset.group && state.settings) {
      void saveSetting({ transportByDevice: { ...state.settings.transportByDevice, [t.dataset.group]: t.dataset.transport as Transport } });
    }
  });
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
    menuOpen: () => state.menuOpen,
    flash: (code, down) => flashKey($('remote-buttons'), code, down),
    toggleFullscreen,
    toggleStats,
    toggleRemote,
    quickSettings,
  });
  $('stage').addEventListener('mousedown', () => $('stage').focus());
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
    if (s.state !== 'running' || s.mode !== 'mirror') video.clear();
    else if (wasLive !== s.serial || wasMode !== 'mirror') video.hasFrame = false;
    render();
  });
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
}

void init();
