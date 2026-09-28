// Menu-bar mini remote: a compact remote for whatever device is connected.

import { icon } from './icons';
import { bindKeyboard } from './keyboard';
import { bindRemote, flashKey, KEY, triggerQuickSettings } from './remote';
import type { DeviceInfo, FireTvApi, SessionStatus, Settings } from '../shared/types';

declare global {
  interface Window { firetv: FireTvApi }
}

const api = window.firetv;
const $ = (id: string) => document.getElementById(id)!;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let status: SessionStatus = { state: 'idle' };
let devices: DeviceInfo[] = [];
let settings: Settings | null = null;

const running = () => status.state === 'running';
const btn = (code: number, label: string, ico: string) =>
  `<button data-key="${code}" title="${label}" aria-label="${label}">${icon(ico, 18)}<span>${label}</span></button>`;

// A smaller remote than the main window's: D-pad plus the most used keys
$('t-remote').innerHTML = `
  <div class="dpad small">
    <button data-key="${KEY.DPAD_UP}" class="dpad-up" aria-label="Up">${icon('chevronUp', 20)}</button>
    <button data-key="${KEY.DPAD_LEFT}" class="dpad-left" aria-label="Left">${icon('chevronLeft', 20)}</button>
    <button data-key="${KEY.DPAD_CENTER}" class="dpad-ok">OK</button>
    <button data-key="${KEY.DPAD_RIGHT}" class="dpad-right" aria-label="Right">${icon('chevronRight', 20)}</button>
    <button data-key="${KEY.DPAD_DOWN}" class="dpad-down" aria-label="Down">${icon('chevronDown', 20)}</button>
  </div>
  <div class="key-row">${btn(KEY.BACK, 'Back', 'back')}${btn(KEY.HOME, 'Home', 'home')}${btn(KEY.MENU, 'Menu', 'menu')}</div>
  <div class="key-row">${btn(KEY.REWIND, 'Rewind', 'rewind')}${btn(KEY.PLAY_PAUSE, 'Play', 'playPause')}${btn(KEY.FAST_FORWARD, 'Forward', 'fastForward')}</div>
  <div class="key-row">${btn(KEY.VOLUME_DOWN, 'Vol −', 'volumeDown')}${btn(KEY.MUTE, 'Mute', 'mute')}${btn(KEY.VOLUME_UP, 'Vol +', 'volumeUp')}</div>`;
$('t-open').innerHTML = icon('fullscreen', 16);

function render(): void {
  const serial = status.state === 'idle' ? settings?.lastSerial : status.serial;
  const d = devices.find((x) => x.serial === serial);
  $('t-name').textContent = d?.name ?? 'Fire TV';
  const pill = $('t-status');
  pill.className = `pill ${running() ? 'live' : status.state === 'connecting' ? '' : d?.state === 'device' ? 'ready' : ''}`;
  pill.textContent = running() ? (status.state === 'running' && status.mode === 'mirror' ? 'Live' : 'Remote')
    : status.state === 'connecting' ? 'Connecting' : d?.state === 'device' ? 'Ready' : 'Offline';

  $('t-remote').hidden = !running();
  $('t-idle').hidden = running();
  $('t-disconnect').hidden = !running();
  const canConnect = d?.state === 'device';
  ($('t-connect') as HTMLButtonElement).disabled = !canConnect || status.state === 'connecting';
  $('t-idle-text').innerHTML = !settings?.lastSerial
    ? 'Connect a device once from the Fire TV window.'
    : canConnect ? `Not connected to <b>${esc(d!.name)}</b>.` : `<b>${esc(d?.name ?? serial ?? '')}</b> is not reachable.`;
}

bindRemote($('t-remote'), api, running);
bindKeyboard(api, {
  active: running,
  menuOpen: () => false,
  flash: (code, down) => flashKey($('t-remote'), code, down),
  toggleFullscreen: () => {},
  toggleStats: () => {},
  toggleRemote: () => {},
  quickSettings: () => triggerQuickSettings($('t-remote'), api),
  toggleApps: () => api.showMainWindow(),
  toggleSound: () => {},
  screenshot: () => {},
  toggleRecording: () => {},
  toggleDevicePanel: () => {},
});

$('t-open').addEventListener('click', () => api.showMainWindow());
$('t-connect').addEventListener('click', () => { void api.connectRemote().catch(() => {}); });
$('t-disconnect').addEventListener('click', () => void api.stop());

api.onStatus((s) => { status = s; render(); });
api.onDevices(async (list) => { devices = list; settings = await api.getSettings(); render(); });

void (async () => {
  [status, devices, settings] = await Promise.all([api.getStatus(), api.listDevices(), api.getSettings()]);
  render();
})();
