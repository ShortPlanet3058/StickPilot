import { icon } from './icons';
import { bindKeyboard } from './keyboard';
import { bindRemote, flashKey, isMac, layoutFor, MOD, renderRemote } from './remote';
import { Video } from './video';
import type { DeviceInfo, DeviceKind, FireTvApi, ProfileSet, SessionStatus, Settings } from '../shared/types';

declare global {
  interface Window { firetv: FireTvApi }
}

const api = window.firetv;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- State ----------

const state = {
  view: 'home' as 'home' | 'player',
  devices: [] as DeviceInfo[],
  status: { state: 'idle' } as SessionStatus,
  settings: null as Settings | null,
  profileSets: new Map<string, ProfileSet>(),
  /** The device the player screen is about */
  playerSerial: null as string | null,
  fullscreen: false,
  menuOpen: false,
  autoConnectTried: false,
  remoteKind: null as DeviceKind | null,
};

const device = (serial: string | null) => state.devices.find((d) => d.serial === serial);
const liveSerial = () => (state.status.state === 'running' || state.status.state === 'connecting') ? state.status.serial : null;
const isLive = (serial: string) => liveSerial() === serial;
const isRunning = () => state.status.state === 'running' && state.status.serial === state.playerSerial;
const missingNetworkHosts = () => (state.settings?.networkHosts ?? []).filter((h) => !device(h));

function profileIdFor(serial: string): string {
  const set = state.profileSets.get(serial);
  const saved = state.settings?.profileBySerial[serial];
  return set?.profiles.some((p) => p.id === saved) ? saved! : set?.defaultId ?? '';
}

function stateLabel(d: DeviceInfo): { text: string; cls: string } {
  if (isLive(d.serial)) return { text: state.status.state === 'running' ? 'Live' : 'Starting', cls: 'live' };
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

// ---------- Device screen ----------

const addTile = document.createElement('article');

function buildAddTile(): void {
  addTile.className = 'dcard add';
  addTile.innerHTML = `
    <button class="add-open" type="button">${icon('plus', 22)}<span>Add by IP address</span><small>Connect a TV over Wi-Fi</small></button>
    <form class="add-form" hidden>
      <div class="dcard-top"><span class="dcard-icon">${icon('wifi', 22)}</span>
        <button type="button" class="icon-btn add-close" aria-label="Cancel">${icon('close', 16)}</button></div>
      <label for="add-host">IP address of the TV</label>
      <div class="field-row">
        <input id="add-host" placeholder="192.168.1.40" autocomplete="off" spellcheck="false">
        <button type="submit" class="primary">Connect</button>
      </div>
      <p class="help">Settings → My Fire TV → About → Network shows the IP address. ADB debugging must be on.</p>
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

/** The connection a card acts on: the live one, else a ready USB, else any ready one */
function primaryConn(g: DeviceGroup): DeviceInfo {
  const ready = g.conns.filter((d) => d.state === 'device');
  return g.conns.find((d) => isLive(d.serial)) ?? ready.find((d) => d.transport === 'usb') ?? ready[0] ?? g.conns[0];
}

function deviceCard(g: DeviceGroup): string {
  const d = primaryConn(g);
  const pill = stateLabel(d);
  const transports = [...new Set(g.conns.map(via))];
  const alt = g.conns.find((c) => c !== d && c.state === 'device' && c.transport !== d.transport);
  let foot: string;
  if (isLive(d.serial)) foot = `<button class="primary" data-open="${esc(d.serial)}">Open</button>`;
  else if (d.state === 'device') {
    foot = `<button class="primary" data-connect="${esc(d.serial)}">Connect</button>`
      + (alt ? `<button class="ghost" data-connect="${esc(alt.serial)}">Use ${via(alt)}</button>` : '');
  } else if (d.state === 'unauthorized') foot = '<p class="dcard-help">Accept "Allow USB debugging?" on the TV.</p>';
  else if (d.state === 'offline') foot = '<p class="dcard-help">Reconnect the cable or restart ADB debugging.</p>';
  else foot = '<p class="dcard-help">Waiting for the device…</p>';
  const net = g.conns.find((c) => c.transport === 'network');
  const forget = net
    ? `<button class="icon-btn forget" data-forget="${esc(net.serial)}" title="Forget the Wi-Fi connection">${icon('close', 15)}</button>` : '';
  const live = g.conns.some((c) => isLive(c.serial));
  const detail = d.state === 'unauthorized' ? 'Not authorized yet' : d.osLabel || d.model;
  return `<article class="dcard${live ? ' live' : ''}">
      <div class="dcard-top"><span class="dcard-icon">${icon(kindIcon(d.kind), 22)}</span>
        <span class="pill ${pill.cls}">${pill.text}</span>${forget}</div>
      <h3>${esc(d.name)}</h3>
      <p class="dcard-sub">${g.conns.map((c) => icon(c.transport === 'network' ? 'wifi' : 'usb', 13)).join('')}<span>${esc([transports.join(' + '), detail].filter(Boolean).join(' · '))}</span></p>
      <div class="dcard-foot">${foot}</div>
    </article>`;
}

function missingCard(host: string): string {
  return `<article class="dcard dim">
      <div class="dcard-top"><span class="dcard-icon">${icon('wifi', 22)}</span><span class="pill">Not reachable</span>
        <button class="icon-btn forget" data-forget="${esc(host)}" title="Forget this device">${icon('close', 15)}</button></div>
      <h3>${esc(host)}</h3>
      <p class="dcard-sub">${icon('wifi', 13)}<span>Saved Wi-Fi device</span></p>
      <div class="dcard-foot"><button data-retry="${esc(host)}">Try again</button></div>
    </article>`;
}

function renderHome(): void {
  const groups = groupDevices(state.devices);
  const tvs = groups.filter((g) => primaryConn(g).kind !== 'phone');
  const others = groups.filter((g) => primaryConn(g).kind === 'phone');
  const missing = missingNetworkHosts();
  const content = $('home-content');
  let html = '';
  if (!tvs.length && !others.length && !missing.length) {
    html = `<div class="empty">
        <h2>Connect a Fire TV</h2>
        <p>Mirror its screen and control it from this computer.</p>
        <ol>
          <li>On the TV, open Settings → My Fire TV → Developer options and turn on <b>ADB debugging</b>.</li>
          <li>Connect the stick to this computer with a USB data cable, or add it by IP address over Wi-Fi.</li>
          <li>Accept the <b>Allow USB debugging?</b> prompt on the TV.</li>
        </ol>
        <p class="muted">Devices appear here as soon as they are detected.</p>
      </div>
      <h2 class="section-title">Add a device</h2><div class="grid" id="grid-tvs"></div>`;
  } else {
    html = `<h2 class="section-title">TVs</h2><div class="grid" id="grid-tvs">${tvs.map(deviceCard).join('')}${missing.map(missingCard).join('')}</div>`;
    if (others.length) html += `<h2 class="section-title">Other devices</h2><div class="grid">${others.map(deviceCard).join('')}</div>`;
  }
  content.innerHTML = html;
  $('grid-tvs').appendChild(addTile); // moved, not recreated: keeps what is typed in it
}

// ---------- Player ----------

function renderToolbar(): void {
  const d = device(state.playerSerial);
  const live = !!d && isLive(d.serial);
  $('btn-switch').innerHTML = `<span>${esc(d?.name ?? state.playerSerial ?? '')}</span>${icon('chevronDown', 14)}`;
  $('fs-name').textContent = d?.name ?? '';

  const set = d ? state.profileSets.get(d.serial) : undefined;
  const profile = set?.profiles.find((p) => p.id === profileIdFor(d!.serial));
  $('title-status').textContent = live
    ? (state.status.state === 'running' ? `Connected · ${profile?.description ?? ''}` : 'Connecting…')
    : d ? stateLabel(d).text : 'Not reachable';

  const picker = $('profile-picker');
  if (d && d.state === 'device' && set) {
    const current = profileIdFor(d.serial);
    picker.innerHTML = set.profiles.map((p) =>
      `<button role="radio" data-profile="${p.id}" aria-checked="${p.id === current}" title="${esc(`${p.description}. ${set.note}`)}">${esc(p.label)}</button>`).join('');
    picker.hidden = false;
  } else {
    picker.hidden = true;
  }

  const btn = $<HTMLButtonElement>('btn-connect');
  btn.textContent = live ? 'Disconnect' : 'Connect';
  btn.className = live ? '' : 'primary';
  btn.disabled = !live && (!d || d.state !== 'device');

  $('btn-stats').setAttribute('aria-pressed', String(!!state.settings?.showStats));
  $('btn-remote').setAttribute('aria-pressed', String(state.settings?.remoteVisible !== false));
  $('player').classList.toggle('remote-hidden', state.settings?.remoteVisible === false);
  $('remote').classList.toggle('disabled', !isRunning());
}

function renderSwitchMenu(): void {
  const items = state.devices.map((d) => {
    const pill = stateLabel(d);
    const current = d.serial === state.playerSerial;
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

function setMenu(open: boolean): void {
  state.menuOpen = open;
  if (open) renderSwitchMenu();
  $('switch-menu').hidden = !open;
  $('btn-switch').setAttribute('aria-expanded', String(open));
  if (!open) $('stage').focus();
}

function card(o: { icon?: string; warn?: boolean; spinner?: boolean; title: string; meta?: string; body?: string; actions?: string }): string {
  const top = o.spinner ? '<div class="spinner" role="status"></div>'
    : o.icon ? `<div class="card-icon${o.warn ? ' warn' : ''}">${icon(o.icon, 24)}</div>` : '';
  return `<div class="card">${top}<h2>${o.title}</h2>${o.meta ? `<p class="meta">${o.meta}</p>` : ''}`
    + `${o.body ? `<p>${o.body}</p>` : ''}${o.actions ? `<div class="actions">${o.actions}</div>` : ''}</div>`;
}

const backToDevices = '<button data-stage="home">All devices</button>';

function stageContent(): string {
  const serial = state.playerSerial;
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
    return card({ icon: 'alert', warn: true, title: 'Allow this computer on the TV', meta,
      body: 'The TV is showing "Allow USB debugging?". Select "Always allow from this computer", then OK. This screen updates by itself.',
      actions: backToDevices });
  }
  if (d.state === 'offline') {
    return card({ icon: 'alert', warn: true, title: 'Device offline', meta,
      body: 'Reconnect the cable, or turn ADB debugging off and on again on the TV.', actions: backToDevices });
  }
  if (d.state !== 'device') return card({ spinner: true, title: 'Waiting for the device…', meta });
  if (isLive(d.serial)) {
    if (s.state === 'connecting') return card({ spinner: true, title: `Connecting to ${esc(d.name)}…`, meta });
    if (!video.hasFrame) return card({ spinner: true, title: 'Starting the picture…', meta });
    return '';
  }
  if (s.state === 'ended' && s.serial === d.serial && s.cause !== 'user') {
    return card({ icon: 'alert', warn: true, title: s.cause === 'unplugged' ? 'Device disconnected' : 'Connection ended', meta,
      body: esc(s.reason), actions: `${backToDevices}<button class="primary" data-stage="connect">Reconnect</button>` });
  }
  return card({ icon: kindIcon(d.kind), title: 'Disconnected', meta: `${esc(d.name)} · ${meta}`,
    actions: `${backToDevices}<button class="primary" data-stage="connect">Connect</button>` });
}

function renderRemotePanel(): void {
  const kind = device(state.playerSerial)?.kind ?? 'firetv';
  if (kind === state.remoteKind) return;
  state.remoteKind = kind;
  $('remote-buttons').innerHTML = renderRemote(kind);
  const hasDpad = layoutFor(kind).some((s) => s.type === 'dpad');
  const rows: [string, string][] = [
    ...(hasDpad ? [['← ↑ → ↓', 'Navigate'], ['Enter', 'OK']] as [string, string][] : []),
    ['Esc', 'Back'],
    ['A–Z, 0–9', 'Type on the TV'],
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
  renderToolbar();
  renderRemotePanel();
  const html = stageContent();
  if ($('overlay').innerHTML !== html) $('overlay').innerHTML = html;
  $('screen').hidden = !(state.playerSerial && isLive(state.playerSerial) && video.hasFrame);
  if (state.menuOpen) renderSwitchMenu();
}

function render(): void {
  $('home').hidden = state.view !== 'home';
  $('player').hidden = state.view !== 'player';
  if (state.view === 'home') renderHome();
  else renderPlayer();
}

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

function openPlayer(serial: string): void {
  state.playerSerial = serial;
  state.view = 'player';
  render();
  $('stage').focus();
}

async function connect(serial: string, profileId?: string): Promise<void> {
  const d = device(serial);
  if (!d || d.state !== 'device') return;
  openPlayer(serial);
  await loadProfiles(serial);
  try {
    await api.start(serial, profileId ?? profileIdFor(serial));
  } catch {
    // Reported through the 'ended' status
  }
  $('stage').focus();
}

async function setProfile(profileId: string): Promise<void> {
  const serial = state.playerSerial;
  if (!serial || !state.settings) return;
  state.settings.profileBySerial = { ...state.settings.profileBySerial, [serial]: profileId };
  await api.setSettings({ profileBySerial: state.settings.profileBySerial });
  render();
  if (isLive(serial)) await connect(serial, profileId);
}

async function saveSetting(patch: Partial<Settings>): Promise<void> {
  if (!state.settings) return;
  Object.assign(state.settings, patch);
  await api.setSettings(patch);
  render();
}

function goHome(): void {
  setMenu(false);
  state.view = 'home';
  render();
}

async function forget(host: string): Promise<void> {
  await api.forgetNetwork(host);
  state.settings = await api.getSettings();
  if (state.playerSerial === host) state.playerSerial = null;
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
  void connect(d.serial);
}

// ---------- Video & fullscreen ----------

const video = new Video($<HTMLCanvasElement>('screen'), api);
video.onFirstFrame = () => renderPlayer();

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
  $('btn-home').innerHTML = `${icon('chevronLeft', 16)}<span>Devices</span>`;
  $('btn-stats').innerHTML = icon('stats');
  $('btn-stats').title = `Latency stats (${MOD}I)`;
  $('btn-fullscreen').innerHTML = icon('fullscreen');
  $('btn-fullscreen').title = `Fullscreen (${MOD}F)`;
  $('btn-remote').innerHTML = icon('panel');
  $('btn-remote').title = `Show or hide the remote (${MOD}R)`;
  $('type-send').innerHTML = icon('send', 18);
  $('fs-exit').innerHTML = `${icon('exitFullscreen', 16)}<span>Exit fullscreen</span>`;
  buildAddTile();

  // Device screen
  $('home-content').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    if (t.dataset.connect) void connect(t.dataset.connect);
    if (t.dataset.open) openPlayer(t.dataset.open);
    if (t.dataset.forget) void forget(t.dataset.forget);
    if (t.dataset.retry) void retry(t.dataset.retry);
  });
  $<HTMLInputElement>('auto-connect').addEventListener('change', (e) =>
    saveSetting({ autoConnect: (e.target as HTMLInputElement).checked }));

  // Player toolbar
  $('btn-home').addEventListener('click', goHome);
  $('btn-switch').addEventListener('click', () => setMenu(!state.menuOpen));
  $('switch-menu').addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    if (t.dataset.menu === 'home') { goHome(); return; }
    const serial = t.dataset.switch;
    setMenu(false);
    if (serial && serial !== liveSerial()) void connect(serial);
    else if (serial) openPlayer(serial);
  });
  document.addEventListener('mousedown', (e) => {
    if (state.menuOpen && !(e.target as HTMLElement).closest('.switcher')) setMenu(false);
  });
  document.addEventListener('keydown', (e) => { if (state.menuOpen && e.key === 'Escape') setMenu(false); });

  $('profile-picker').addEventListener('click', (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>('[data-profile]')?.dataset.profile;
    if (id) void setProfile(id);
  });
  $('btn-connect').addEventListener('click', () => {
    const serial = state.playerSerial;
    if (!serial) return;
    if (isLive(serial)) void api.stop();
    else void connect(serial);
  });
  const toggleStats = () => saveSetting({ showStats: !state.settings?.showStats });
  const toggleRemote = () => saveSetting({ remoteVisible: state.settings?.remoteVisible === false });
  $('btn-stats').addEventListener('click', toggleStats);
  $('btn-remote').addEventListener('click', toggleRemote);
  $('btn-fullscreen').addEventListener('click', () => api.toggleFullscreen());
  $('fs-exit').addEventListener('click', () => api.toggleFullscreen());

  $('overlay').addEventListener('click', (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>('[data-stage]')?.dataset.stage;
    if (action === 'home') goHome();
    if (action === 'connect' && state.playerSerial) void connect(state.playerSerial);
    if (action === 'retry' && state.playerSerial) void retry(state.playerSerial);
  });

  // Remote
  bindRemote($('remote-buttons'), api, isRunning);
  $('type-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('type-text');
    if (isRunning() && input.value) api.type(input.value);
    input.value = '';
    $('stage').focus();
  });

  bindKeyboard(api, {
    active: () => state.view === 'player' && isRunning(),
    menuOpen: () => state.menuOpen,
    flash: (code, down) => flashKey($('remote-buttons'), code, down),
    toggleFullscreen: () => api.toggleFullscreen(),
    toggleStats,
    toggleRemote,
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
    state.status = s;
    if (s.state !== 'running') video.clear();
    else if (wasLive !== s.serial) video.hasFrame = false;
    render();
  });
  api.onFullscreen((on) => {
    state.fullscreen = on;
    document.body.classList.toggle('fullscreen', on);
    $('fs-bar').classList.toggle('visible', on);
    if (on) showFsBar();
    $('stage').focus();
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
