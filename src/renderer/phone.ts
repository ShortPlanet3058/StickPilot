// The phone remote page, served by StickPilot on the computer (src/main/phoneRemote.ts).
// Every press is a small HTTP request to the computer, which sends it to the TV; the
// TV's state comes back as a live event stream. All URLs are relative to the page,
// whose address carries the access token.

import { icon } from './icons';
import { KEY } from './remote';
import type { AppInfo, PhoneState } from '../shared/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let state: PhoneState | null = null;
let apps: AppInfo[] = [];
let reachable = true;
let linkDead = false;

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ---------- Talking to the computer ----------

async function post(route: string, body: Record<string, unknown> = {}): Promise<Response | null> {
  try {
    const res = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true });
    if (res.status === 404) setLinkDead();
    return res;
  } catch {
    return null;
  }
}

const buzz = () => { try { navigator.vibrate?.(8); } catch { /* not supported (iPhone) */ } };
const tap = (code: number) => { buzz(); void post('api/tap', { code }); };

function toast(text: string, ms = 2600): void {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(Number(el.dataset.t));
  el.dataset.t = String(window.setTimeout(() => { el.hidden = true; }, ms));
}

function setLinkDead(): void {
  linkDead = true;
  render();
}

function listen(): void {
  const events = new EventSource('api/events');
  events.onmessage = (e) => {
    reachable = true;
    const first = !state;
    state = JSON.parse(e.data) as PhoneState;
    if (first || (state.session === 'running' && !apps.length)) void loadApps();
    render();
  };
  events.onerror = () => {
    reachable = false;
    render();
    // A wrong or replaced token answers 404; EventSource alone can't tell that apart
    void fetch('api/state').then((r) => { if (r.status === 404) { events.close(); setLinkDead(); } }).catch(() => {});
  };
}

async function loadApps(): Promise<void> {
  try {
    const res = await fetch('api/apps');
    if (res.ok) apps = await res.json();
    renderFavs();
    if (!$('apps').hidden) renderApps();
  } catch { /* offline: the stream reports it */ }
}

// ---------- Held keys ----------

/** Press and hold: key down now, repeats like a real remote after a short delay, key up on release */
function holdable(el: HTMLElement, code: number): void {
  let repeat = 0;
  let timer: number | undefined;
  let down = false;
  const stop = () => {
    if (!down) return;
    down = false;
    clearTimeout(timer);
    clearInterval(timer);
    el.classList.remove('pressed');
    void post('api/key', { code, action: 'up' });
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (down) return;
    down = true;
    repeat = 0;
    el.setPointerCapture(e.pointerId);
    el.classList.add('pressed');
    buzz();
    void post('api/key', { code, action: 'down', repeat: 0 });
    timer = window.setTimeout(() => {
      timer = window.setInterval(() => { void post('api/key', { code, action: 'down', repeat: ++repeat }); }, 110);
    }, 420);
  });
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('lostpointercapture', stop);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------- Building the remote ----------

function button(id: string, label: string, iconName: string, cls = ''): string {
  return `<button id="${id}" class="key ${cls}" aria-label="${esc(label)}">${icon(iconName, 22)}<span>${esc(label)}</span></button>`;
}

function buildDpad(): void {
  $('dpad').innerHTML = `
    <button class="arrow up" data-code="${KEY.DPAD_UP}" aria-label="Up">${icon('chevronUp', 26)}</button>
    <button class="arrow left" data-code="${KEY.DPAD_LEFT}" aria-label="Left">${icon('chevronLeft', 26)}</button>
    <button class="ok" data-code="${KEY.DPAD_CENTER}" aria-label="OK">OK</button>
    <button class="arrow right" data-code="${KEY.DPAD_RIGHT}" aria-label="Right">${icon('chevronRight', 26)}</button>
    <button class="arrow down" data-code="${KEY.DPAD_DOWN}" aria-label="Down">${icon('chevronDown', 26)}</button>`;
  for (const b of $('dpad').querySelectorAll<HTMLElement>('[data-code]')) holdable(b, Number(b.dataset.code));
}

/** Swipe to move (one step per ~36 px, keeps going as the finger moves), tap for OK */
function bindTouchpad(): void {
  const pad = $('touchpad');
  const STEP = 36;
  let origin: { x: number; y: number } | null = null;
  let start: { x: number; y: number; t: number } | null = null;
  let moved = false;
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    origin = { x: e.clientX, y: e.clientY };
    start = { x: e.clientX, y: e.clientY, t: Date.now() };
    moved = false;
  });
  pad.addEventListener('pointermove', (e) => {
    if (!origin) return;
    const dx = e.clientX - origin.x;
    const dy = e.clientY - origin.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < STEP) return;
    moved = true;
    const horizontal = Math.abs(dx) > Math.abs(dy);
    tap(horizontal ? (dx > 0 ? KEY.DPAD_RIGHT : KEY.DPAD_LEFT) : (dy > 0 ? KEY.DPAD_DOWN : KEY.DPAD_UP));
    pad.dataset.dir = horizontal ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    origin = { x: e.clientX, y: e.clientY };
  });
  const end = (e: PointerEvent) => {
    if (!start) return;
    const still = Math.hypot(e.clientX - start.x, e.clientY - start.y) < 12;
    if (!moved && still && Date.now() - start.t < 350) { tap(KEY.DPAD_CENTER); pad.dataset.dir = 'ok'; }
    origin = null;
    start = null;
    window.setTimeout(() => { delete pad.dataset.dir; }, 180);
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', () => { origin = null; start = null; });
}

function setPad(which: 'dpad' | 'touchpad'): void {
  $('dpad').hidden = which !== 'dpad';
  $('touchpad').hidden = which !== 'touchpad';
  for (const b of document.querySelectorAll<HTMLElement>('[data-pad]')) b.setAttribute('aria-checked', String(b.dataset.pad === which));
  store.set('stickpilot.pad', which);
}

function buildKeys(kind: string): void {
  const third = kind === 'phone'
    ? button('k-recents', 'Recents', 'recents')
    : button('k-menu', 'Menu', 'menu');
  $('keys').innerHTML = [
    button('k-back', 'Back', 'back'), button('k-home', 'Home', 'home'), third,
    button('k-rew', 'Rewind', 'rewind'), button('k-play', 'Play', 'playPause'), button('k-ff', 'Forward', 'fastForward'),
    button('k-vdown', 'Vol −', 'volumeDown'), button('k-mute', 'Mute', 'mute'), button('k-vup', 'Vol +', 'volumeUp'),
  ].join('');
  const codes: Record<string, number> = {
    'k-back': KEY.BACK, 'k-home': KEY.HOME, 'k-menu': KEY.MENU, 'k-recents': KEY.APP_SWITCH,
    'k-rew': KEY.REWIND, 'k-play': KEY.PLAY_PAUSE, 'k-ff': KEY.FAST_FORWARD,
    'k-vdown': KEY.VOLUME_DOWN, 'k-mute': KEY.MUTE, 'k-vup': KEY.VOLUME_UP,
  };
  // Volume and seeking repeat while held; the others are single presses
  const held = new Set<number>([KEY.VOLUME_DOWN, KEY.VOLUME_UP, KEY.REWIND, KEY.FAST_FORWARD]);
  for (const [id, code] of Object.entries(codes)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (held.has(code)) holdable(el, code);
    else el.addEventListener('click', () => tap(code));
  }

  const chips: string[] = [];
  if (kind !== 'phone') chips.push(`<button class="chip" data-chip="settings">${icon('settings', 16)}Settings</button>`);
  if (kind === 'firetv') chips.push(`<button class="chip" data-chip="quick">${icon('sliders', 16)}Quick settings</button>`);
  $('chips').innerHTML = chips.join('');
}

// ---------- Apps ----------

function appTile(a: AppInfo, small = false): string {
  const letter = esc((a.name.trim()[0] ?? '?').toUpperCase());
  return `<button class="app${small ? ' small' : ''}" data-pkg="${esc(a.pkg)}">
    <span class="app-art"><img src="art/${encodeURIComponent(a.pkg)}" alt="" loading="lazy"><b>${letter}</b></span>
    <span class="app-name">${esc(a.name)}</span></button>`;
}

function renderFavs(): void {
  const favs = (state?.favorites ?? []).map((p) => apps.find((a) => a.pkg === p) ?? { pkg: p, name: p.split('.').pop() ?? p, system: false });
  $('favs').innerHTML = favs.slice(0, 3).map((a) => appTile(a, true)).join('')
    + `<button class="app small all" data-open-apps>${'<span class="app-art">' + icon('grid', 22) + '</span>'}<span class="app-name">All apps</span></button>`;
}

function renderApps(): void {
  const q = $<HTMLInputElement>('apps-search').value.trim().toLowerCase();
  const list = apps.filter((a) => !q || a.name.toLowerCase().includes(q) || a.pkg.includes(q));
  const mine = list.filter((a) => q || !a.system);
  const builtIn = q ? [] : list.filter((a) => a.system);
  const section = (title: string, items: AppInfo[]) => (items.length
    ? `<h3>${esc(title)}</h3><div class="app-grid">${items.map((a) => appTile(a)).join('')}</div>` : '');
  $('apps-list').innerHTML = !apps.length ? '<p class="empty">Loading apps…</p>'
    : (section(q ? 'Results' : 'Your apps', mine) + section('Built-in apps', builtIn)) || '<p class="empty">No app matches.</p>';
}

/** Images that fail (no logo cached yet) leave the letter showing */
document.addEventListener('error', (e) => {
  const img = e.target as HTMLElement;
  if (img instanceof HTMLImageElement && img.closest('.app-art')) img.remove();
}, true);
document.addEventListener('load', (e) => {
  const img = e.target as HTMLElement;
  if (img instanceof HTMLImageElement) img.closest('.app-art')?.classList.add('has-art');
}, true);

async function launch(pkg: string): Promise<void> {
  buzz();
  const res = await post('api/launch', { pkg });
  const ok = res ? ((await res.json().catch(() => ({}))) as { ok?: boolean }).ok : false;
  if (ok) { $('apps').hidden = true; } else toast("That app didn't open.");
}

// ---------- Rendering ----------

function render(): void {
  const s = state;
  const live = !linkDead && reachable && s?.session === 'running';
  $('remote').hidden = !live;
  $('idle').hidden = live;
  if (!live) $('apps').hidden = true;

  $('name').textContent = s?.device?.name ?? 'StickPilot';
  const status = linkDead ? 'Link expired' : !reachable ? 'Offline'
    : s?.session === 'running' ? (s.mode === 'mirror' ? 'Connected · screen on computer' : 'Connected')
    : s?.session === 'connecting' ? 'Connecting…' : 'Not connected';
  $('status').textContent = status;
  $('status').className = `status ${live ? 'ok' : s?.session === 'connecting' ? 'busy' : ''}`;
  $('power').hidden = !live;

  if (live && $('keys').dataset.kind !== s!.device?.kind) {
    $('keys').dataset.kind = s!.device?.kind ?? 'firetv';
    buildKeys(s!.device?.kind ?? 'firetv');
    renderFavs();
  }

  if (!live) {
    const connect = $<HTMLButtonElement>('connect');
    $('idle').querySelector('.idle-icon')!.innerHTML = icon(linkDead ? 'link' : !reachable ? 'wifi' : 'tv', 30);
    if (linkDead) {
      $('idle-title').textContent = 'This link no longer works';
      $('idle-text').textContent = 'Open StickPilot on your computer, choose Use your phone as the remote, and scan the new QR code.';
      connect.hidden = true;
    } else if (!reachable) {
      $('idle-title').textContent = "Can't reach StickPilot";
      $('idle-text').textContent = 'Check that your phone is on the same Wi-Fi as the computer, and that StickPilot is running there. Trying again…';
      connect.hidden = true;
    } else if (s?.session === 'connecting') {
      $('idle-title').textContent = 'Connecting…';
      $('idle-text').textContent = s.device ? `Opening the remote for ${s.device.name}.` : '';
      connect.hidden = true;
    } else {
      $('idle-title').textContent = s?.device ? s.device.name : 'No device';
      $('idle-text').textContent = s?.message
        ? `The connection ended: ${s.message}`
        : s?.canConnect ? 'Ready. Connect to use this phone as its remote.'
          : s?.device ? 'This device is not available right now. Check that it is on.'
            : 'Connect a TV in StickPilot on your computer first.';
      connect.hidden = !s?.canConnect;
      connect.disabled = false;
      connect.textContent = s?.message ? 'Reconnect' : 'Connect';
    }
  }
}

// ---------- Wiring ----------

function wire(): void {
  $('power').innerHTML = icon('power', 18);
  $('apps-close').innerHTML = icon('close', 18);
  $('type-back').innerHTML = icon('backspace', 20);
  $('type-send').innerHTML = icon('send', 20);
  buildDpad();
  bindTouchpad();
  setPad(store.get('stickpilot.pad') === 'touchpad' ? 'touchpad' : 'dpad');
  for (const b of document.querySelectorAll<HTMLElement>('[data-pad]')) b.addEventListener('click', () => setPad(b.dataset.pad as 'dpad' | 'touchpad'));

  $('connect').addEventListener('click', async () => {
    const b = $<HTMLButtonElement>('connect');
    b.disabled = true;
    b.textContent = 'Connecting…';
    const res = await post('api/connect');
    if (!res?.ok) {
      b.disabled = false;
      b.textContent = 'Connect';
      toast(res ? ((await res.json().catch(() => ({}))) as { message?: string }).message ?? 'Could not connect.' : 'StickPilot did not answer.');
    }
  });
  $('power').addEventListener('click', () => { buzz(); void post('api/disconnect'); });

  $('chips').addEventListener('click', (e) => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('[data-chip]')?.dataset.chip;
    if (chip === 'settings') tap(KEY.SETTINGS);
    if (chip === 'quick') { buzz(); toast('Opening quick settings…', 1500); void post('api/quick-settings'); }
  });

  const openApps = () => {
    $('apps').hidden = false;
    $<HTMLInputElement>('apps-search').value = '';
    renderApps();
    void loadApps();
  };
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-open-apps]')) { openApps(); return; }
    const pkg = t.closest<HTMLElement>('[data-pkg]')?.dataset.pkg;
    if (pkg) void launch(pkg);
  });
  $('apps-close').addEventListener('click', () => { $('apps').hidden = true; });
  $('apps-search').addEventListener('input', renderApps);

  const input = $<HTMLInputElement>('type-text');
  $('type').addEventListener('submit', (e) => {
    e.preventDefault();
    if (input.value) { buzz(); void post('api/text', { text: input.value }); }
    input.value = '';
  });
  $('type-back').addEventListener('click', () => { buzz(); void post('api/backspace'); });

  listen();
  render();
}

wire();
