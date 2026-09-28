// While connected, the keyboard is the TV's keyboard and remote: arrows, Enter,
// Esc and typing always go to the device, no matter which on-screen button was
// clicked last. Only real text fields and open menus in the app keep their keys.
// Remote shortcuts use Option (macOS) / Alt, so plain letters can be typed.

import { KEY } from './remote';
import type { StickPilotApi } from '../shared/types';

export interface KeyboardHooks {
  active(): boolean;               // connected and the player is showing
  menuOpen(): boolean;
  flash(code: number, down: boolean): void;
  toggleFullscreen(): void;
  toggleStats(): void;
  toggleRemote(): void;
  quickSettings(): void;
  toggleApps(): void;
  toggleSound(): void;
  screenshot(): void;
  toggleRecording(): void;
  toggleDevicePanel(): void;
}

const HELD: Record<string, number> = {
  ArrowUp: KEY.DPAD_UP, ArrowDown: KEY.DPAD_DOWN, ArrowLeft: KEY.DPAD_LEFT, ArrowRight: KEY.DPAD_RIGHT,
  Enter: KEY.DPAD_CENTER,
};

// Option/Alt + key (by physical key, since Option changes the character on macOS)
const MOD_KEYS: Record<string, number> = {
  KeyH: KEY.HOME, KeyM: KEY.MENU, KeyS: KEY.SETTINGS, KeyB: KEY.BACK,
  Space: KEY.PLAY_PAUSE, KeyP: KEY.PLAY_PAUSE,
  ArrowLeft: KEY.REWIND, ArrowRight: KEY.FAST_FORWARD,
  ArrowUp: KEY.VOLUME_UP, ArrowDown: KEY.VOLUME_DOWN, Digit0: KEY.MUTE,
};

export function bindKeyboard(api: StickPilotApi, hooks: KeyboardHooks): void {
  const isTextField = (el: EventTarget | null) =>
    el instanceof HTMLElement && el.matches('input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable="true"]');

  // Keycode sent on key down, by physical key, so key up releases exactly that
  const down = new Map<string, number>();
  const press = (e: KeyboardEvent, code: number) => {
    api.key(code, 0, e.repeat ? 1 : 0);
    if (!e.repeat) { down.set(e.code, code); hooks.flash(code, true); }
  };
  const releaseAll = () => {
    for (const code of down.values()) { api.key(code, 1); hooks.flash(code, false); }
    down.clear();
  };

  const shouldHandle = (e: KeyboardEvent) =>
    hooks.active() && !hooks.menuOpen() && !isTextField(e.target) && !e.metaKey && !e.ctrlKey;

  document.addEventListener('keydown', (e) => {
    if (!shouldHandle(e)) return;

    if (e.altKey) {
      const special: Record<string, () => void> = {
        KeyQ: hooks.quickSettings,
        KeyA: hooks.toggleApps,
        KeyU: hooks.toggleSound,
        KeyD: hooks.toggleDevicePanel,
        KeyF: hooks.toggleFullscreen,
        KeyI: hooks.toggleStats,
        KeyR: hooks.toggleRemote,
        KeyV: () => api.pasteClipboard(),
      };
      if (e.code === 'KeyC') {
        e.preventDefault();
        if (!e.repeat) (e.shiftKey ? hooks.toggleRecording : hooks.screenshot)();
        return;
      }
      if (special[e.code]) { e.preventDefault(); if (!e.repeat) special[e.code](); return; }
      const code = MOD_KEYS[e.code];
      if (code === undefined) return;
      e.preventDefault();
      press(e, code);
      return;
    }

    const held = HELD[e.key];
    if (held !== undefined) {
      e.preventDefault();
      press(e, held);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!e.repeat) { api.tap(KEY.BACK); hooks.flash(KEY.BACK, true); }
      return;
    }
    if (e.key === 'Backspace') {
      e.preventDefault();
      api.backspace();
      return;
    }
    if (e.key.length === 1) {
      // A printable character: type it on the device (Tab and friends are left alone)
      e.preventDefault();
      api.type(e.key);
    }
  });

  document.addEventListener('keyup', (e) => {
    const code = down.get(e.code);
    if (code !== undefined) {
      api.key(code, 1);
      hooks.flash(code, false);
      down.delete(e.code);
    }
    if (e.key === 'Escape') hooks.flash(KEY.BACK, false);
  });
  // Switching windows mid-press would otherwise leave a key held on the device
  window.addEventListener('blur', releaseAll);

  // Clicking app buttons must not steal keyboard focus from the picture
  document.addEventListener('mousedown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('button') && !t.closest('form')) e.preventDefault();
  });
}
