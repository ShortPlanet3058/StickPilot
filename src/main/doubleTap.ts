// Global "double-tap Right Shift" shortcut for the menu-bar remote.
//
// Electron's globalShortcut only takes key combinations, so a lone modifier
// tapped twice needs a system-wide keyboard hook (uiohook-napi). The hook sees
// every key event; this code only ever looks at whether it is Right Shift and
// keeps nothing. On macOS the hook needs the Accessibility permission.

import { systemPreferences } from 'electron';
import { uIOhook, UiohookKey } from 'uiohook-napi';

const TAP_MAX_MS = 300; // a press longer than this is holding, not tapping
const BETWEEN_MAX_MS = 400; // second tap must follow the first within this

export class DoubleTap {
  private running = false;
  private downAt = 0;
  private clean = false; // no other key pressed during this tap
  private lastTap = 0;

  constructor(private onTrigger: () => void, private key: number = UiohookKey.ShiftRight) {
    uIOhook.on('keydown', (e) => {
      if (e.keycode === this.key) {
        if (!this.downAt) { this.downAt = Date.now(); this.clean = true; } // ignore auto-repeat
      } else {
        // Any other key (Shift+letter, a shortcut…) cancels: this was typing, not a tap
        this.clean = false;
        this.lastTap = 0;
      }
    });
    uIOhook.on('keyup', (e) => {
      if (e.keycode !== this.key) return;
      const now = Date.now();
      const tap = this.clean && now - this.downAt <= TAP_MAX_MS;
      this.downAt = 0;
      if (!tap) { this.lastTap = 0; return; }
      if (this.lastTap && now - this.lastTap <= BETWEEN_MAX_MS) {
        this.lastTap = 0;
        this.onTrigger();
      } else {
        this.lastTap = now;
      }
    });
    uIOhook.on('mousedown', () => { this.lastTap = 0; this.clean = false; });
  }

  get active(): boolean {
    return this.running;
  }

  /** Starts listening; returns a message when the shortcut can't work yet */
  start(): string | null {
    if (this.running) return null;
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
      return 'To use double-tap Right Shift, StickPilot needs Accessibility access. Click Allow access, then switch StickPilot on in the list.';
    }
    try {
      uIOhook.start();
      this.running = true;
      return null;
    } catch (e) {
      return `The Right Shift shortcut could not start: ${(e as Error).message}`;
    }
  }

  stop(): void {
    if (!this.running) return;
    uIOhook.stop();
    this.running = false;
  }
}
