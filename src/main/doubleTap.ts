// Global "double-tap Right Shift" shortcut for the menu-bar remote.
//
// macOS: a small helper (helper/macos/StickPilotKeys.swift) watches modifier keys
// with a global NSEvent monitor in its own process and prints "doubletap". A
// keyboard hook inside the app (uiohook) could deadlock the main thread on macOS:
// its hook thread waits on the main queue while the main thread waits on it.
// The helper takes StickPilot's Accessibility permission (the app starts it).
//
// Windows / Linux: uiohook-napi in-process (no such main-queue hand-off there).
// Either way only Right Shift is looked at; nothing typed is kept.

import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import { systemPreferences } from 'electron';
import { keysHelperPath } from './paths';

const TAP_MAX_MS = 300; // a press longer than this is holding, not tapping
const BETWEEN_MAX_MS = 400; // second tap must follow the first within this
const RIGHT_SHIFT = 54; // uiohook key code

export class DoubleTap {
  private running = false;
  private helper: ChildProcess | null = null;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(private onTrigger: () => void) {}

  get active(): boolean {
    return this.running;
  }

  /** Starts listening; returns a message when the shortcut can't work yet */
  start(): string | null {
    if (this.running) return null;
    if (process.platform === 'darwin') {
      if (!systemPreferences.isTrustedAccessibilityClient(false)) {
        return 'To use double-tap Right Shift, StickPilot needs Accessibility access. Click Allow access, then switch StickPilot on in the list.';
      }
      return this.startHelper();
    }
    return this.startHook();
  }

  private startHelper(): string | null {
    const bin = keysHelperPath();
    if (!fs.existsSync(bin)) return 'The Right Shift shortcut helper is missing from this build.';
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.helper = child;
    this.running = true;
    let buf = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (process.env.STICKPILOT_DEBUG) process.stdout.write(`[keys] ${line}\n`);
        if (line === 'doubletap') this.onTrigger();
      }
    });
    child.on('exit', (code) => {
      if (process.env.STICKPILOT_DEBUG) process.stdout.write(`[keys] helper exited (${code})\n`);
      if (this.helper !== child) return;
      this.helper = null;
      this.running = false;
      // Crashed or lost its permission: try again shortly (stop() clears helper first)
      this.restartTimer = setTimeout(() => { this.restartTimer = null; this.start(); }, 5000);
    });
    return null;
  }

  private startHook(): string | null {
    try {
      // Loaded only here: native module, not needed (nor used) on macOS
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { uIOhook } = require('uiohook-napi') as typeof import('uiohook-napi');
      let downAt = 0;
      let clean = false;
      let lastTap = 0;
      uIOhook.removeAllListeners();
      uIOhook.on('keydown', (e) => {
        if (e.keycode === RIGHT_SHIFT) { if (!downAt) { downAt = Date.now(); clean = true; } } else { clean = false; lastTap = 0; }
      });
      uIOhook.on('keyup', (e) => {
        if (e.keycode !== RIGHT_SHIFT) return;
        const now = Date.now();
        const tap = clean && now - downAt <= TAP_MAX_MS;
        downAt = 0;
        if (!tap) { lastTap = 0; return; }
        if (lastTap && now - lastTap <= BETWEEN_MAX_MS) { lastTap = 0; this.onTrigger(); } else lastTap = now;
      });
      uIOhook.on('mousedown', () => { lastTap = 0; clean = false; });
      uIOhook.start();
      this.running = true;
      return null;
    } catch (e) {
      return `The Right Shift shortcut could not start: ${(e as Error).message}`;
    }
  }

  stop(): void {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.helper) {
      const h = this.helper;
      this.helper = null;
      h.kill();
    }
    if (this.running && process.platform !== 'darwin') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('uiohook-napi') as typeof import('uiohook-napi')).uIOhook.stop();
    }
    this.running = false;
  }
}
