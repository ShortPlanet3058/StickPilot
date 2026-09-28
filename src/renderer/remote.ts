// Remote layouts per device kind. Adding support for a new kind of device means
// adding a layout here; the rendering and input handling are shared.

import { icon } from './icons';
import type { DeviceKind, FireTvApi } from '../shared/types';

export const isMac = navigator.userAgent.includes('Mac');
export const MOD = isMac ? '⌥' : 'Alt+';

export const KEY = {
  HOME: 3, BACK: 4, DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22, DPAD_CENTER: 23,
  VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26, MENU: 82, PLAY_PAUSE: 85, REWIND: 89, FAST_FORWARD: 90,
  MUTE: 164, SETTINGS: 176, APP_SWITCH: 187,
} as const;

interface Button {
  label: string;
  icon: string;
  /** Android keycode, sent as down/up (held buttons repeat like a real remote) */
  key?: number;
  /** Special actions that aren't a plain key */
  action?: 'quickSettings';
  shortcut?: string;
}

type Section =
  | { type: 'dpad' }
  | { type: 'row'; buttons: Button[] }
  | { type: 'chips'; buttons: Button[] }
  | { type: 'note'; text: string };

const B = {
  back: { label: 'Back', icon: 'back', key: KEY.BACK, shortcut: 'Esc' },
  home: { label: 'Home', icon: 'home', key: KEY.HOME, shortcut: `${MOD}H` },
  menu: { label: 'Menu', icon: 'menu', key: KEY.MENU, shortcut: `${MOD}M` },
  rewind: { label: 'Rewind', icon: 'rewind', key: KEY.REWIND, shortcut: `${MOD}←` },
  play: { label: 'Play', icon: 'playPause', key: KEY.PLAY_PAUSE, shortcut: `${MOD}Space` },
  forward: { label: 'Forward', icon: 'fastForward', key: KEY.FAST_FORWARD, shortcut: `${MOD}→` },
  volDown: { label: 'Vol −', icon: 'volumeDown', key: KEY.VOLUME_DOWN, shortcut: `${MOD}↓` },
  mute: { label: 'Mute', icon: 'mute', key: KEY.MUTE, shortcut: `${MOD}0` },
  volUp: { label: 'Vol +', icon: 'volumeUp', key: KEY.VOLUME_UP, shortcut: `${MOD}↑` },
  settings: { label: 'Settings', icon: 'settings', key: KEY.SETTINGS, shortcut: `${MOD}S` },
  quick: { label: 'Quick settings', icon: 'sliders', action: 'quickSettings', shortcut: `${MOD}Q` },
  recents: { label: 'Recents', icon: 'recents', key: KEY.APP_SWITCH },
  power: { label: 'Power', icon: 'power', key: KEY.POWER },
} satisfies Record<string, Button>;

const MEDIA: Section = { type: 'row', buttons: [B.rewind, B.play, B.forward] };
const VOLUME: Section = { type: 'row', buttons: [B.volDown, B.mute, B.volUp] };

export const LAYOUTS: Record<'firetv' | 'tv' | 'phone', Section[]> = {
  // Keys verified on Fire OS 8. Recents, All apps, Guide and Search keys do nothing
  // there, and Alexa needs the remote's microphone, so they are left out.
  firetv: [
    { type: 'chips', buttons: [B.settings, B.quick] },
    { type: 'dpad' },
    { type: 'row', buttons: [B.back, B.home, B.menu] },
    MEDIA,
    VOLUME,
  ],
  tv: [
    { type: 'chips', buttons: [B.settings] },
    { type: 'dpad' },
    { type: 'row', buttons: [B.back, B.home, B.menu] },
    MEDIA,
    VOLUME,
  ],
  phone: [
    { type: 'row', buttons: [B.back, B.home, B.recents] },
    { type: 'row', buttons: [B.volDown, B.power, B.volUp] },
    MEDIA,
    { type: 'note', text: 'Touch input on the picture is not supported yet. Use the buttons and the keyboard.' },
  ],
};

export function layoutFor(kind: DeviceKind): Section[] {
  return kind === 'firetv' ? LAYOUTS.firetv : kind === 'phone' ? LAYOUTS.phone : LAYOUTS.tv;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function attrs(b: Button): string {
  const title = b.shortcut ? `${b.label} (${b.shortcut})` : b.label;
  return `${b.key !== undefined ? `data-key="${b.key}"` : ''} ${b.action ? `data-action="${b.action}"` : ''} title="${esc(title)}" aria-label="${esc(b.label)}"`;
}

export function renderRemote(kind: DeviceKind): string {
  return layoutFor(kind).map((s) => {
    switch (s.type) {
      case 'dpad':
        return `<div class="dpad">
          <button data-key="${KEY.DPAD_UP}" class="dpad-up" title="Up (↑)" aria-label="Up">${icon('chevronUp', 22)}</button>
          <button data-key="${KEY.DPAD_LEFT}" class="dpad-left" title="Left (←)" aria-label="Left">${icon('chevronLeft', 22)}</button>
          <button data-key="${KEY.DPAD_CENTER}" class="dpad-ok" title="OK (Enter)">OK</button>
          <button data-key="${KEY.DPAD_RIGHT}" class="dpad-right" title="Right (→)" aria-label="Right">${icon('chevronRight', 22)}</button>
          <button data-key="${KEY.DPAD_DOWN}" class="dpad-down" title="Down (↓)" aria-label="Down">${icon('chevronDown', 22)}</button>
        </div>`;
      case 'row':
        return `<div class="key-row">${s.buttons.map((b) =>
          `<button ${attrs(b)}>${icon(b.icon, 20)}<span>${esc(b.label)}</span></button>`).join('')}</div>`;
      case 'chips':
        return `<div class="chips">${s.buttons.map((b) =>
          `<button class="chip" ${attrs(b)}>${icon(b.icon, 16)}<span>${esc(b.label)}</span></button>`).join('')}</div>`;
      case 'note':
        return `<p class="remote-note">${esc(s.text)}</p>`;
    }
  }).join('');
}

/**
 * Quick settings takes about a second (it goes through adb). Show the button as busy
 * meanwhile and ignore repeats, so a second click can't close the panel again.
 */
let quickBusy = false;
export function triggerQuickSettings(root: ParentNode, api: FireTvApi): void {
  if (quickBusy) return;
  quickBusy = true;
  const btns = root.querySelectorAll('[data-action="quickSettings"]');
  btns.forEach((b) => b.classList.add('pressed', 'busy'));
  void api.quickSettings().finally(() => {
    quickBusy = false;
    btns.forEach((b) => b.classList.remove('pressed', 'busy'));
  });
}

/** Pointer handling for remote buttons: press on down, release on up, like a real remote. */
export function bindRemote(root: HTMLElement, api: FireTvApi, canControl: () => boolean): void {
  let held: { btn: HTMLElement; code: number } | null = null;
  root.addEventListener('pointerdown', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('button[data-key], button[data-action]');
    if (!btn || !canControl()) return;
    e.preventDefault(); // keep keyboard focus on the picture
    if (btn.dataset.action === 'quickSettings') { triggerQuickSettings(root, api); return; }
    const code = Number(btn.dataset.key);
    held = { btn, code };
    btn.setPointerCapture(e.pointerId);
    btn.classList.add('pressed');
    api.key(code, 0);
  });
  const release = () => {
    if (!held) return;
    api.key(held.code, 1);
    held.btn.classList.remove('pressed');
    held = null;
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);
}

/** Lights up the on-screen button matching a keyboard press */
export function flashKey(root: HTMLElement, code: number, down: boolean): void {
  root.querySelectorAll(`[data-key="${code}"]`).forEach((b) => b.classList.toggle('pressed', down));
}
