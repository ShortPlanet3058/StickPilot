// Routes typed characters to the device in the way the focused screen accepts.
//
// Real text fields (YouTube search, browsers, most apps) take injected text.
// Amazon's own search screens (e.g. Settings search) are letter grids, not text
// fields: they ignore text, but a letter key jumps the grid to that letter and
// OK then types it. Sending that OK anywhere else would press whatever is
// highlighted, so grid mode is only used on screens known to be grids.

import { adb } from './adb';
import type { Session } from './scrcpy';

type Mode = 'text' | 'grid';

const KEYCODE_DPAD_CENTER = 23;
const KEYCODE_DEL = 67;
const KEYCODE_SPACE = 62;
const KEYCODE_0 = 7;
const KEYCODE_A = 29;
const MODE_TTL_MS = 1500;

/** Focused window "package/activity" names that are Amazon letter-grid searches */
function isLetterGrid(focus: string): boolean {
  return /^com\.amazon\./.test(focus) && /search/i.test(focus);
}

export class Typer {
  private mode: { value: Mode; at: number; serial: string } | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private session: Session) {}

  type(text: string): void {
    this.enqueue(async () => {
      const mode = await this.currentMode();
      if (mode === 'text') {
        this.session.text(text);
        return;
      }
      for (const ch of text.toLowerCase()) {
        const code = gridKeycode(ch);
        if (code === null) continue;
        this.session.tap(code);
        await sleep(40); // let the grid move its highlight before OK
        this.session.tap(KEYCODE_DPAD_CENTER);
        await sleep(40);
      }
    });
  }

  backspace(): void {
    this.enqueue(async () => this.session.tap(KEYCODE_DEL));
  }

  /** The focused screen changes when the user navigates: forget the cached mode */
  invalidate(): void {
    this.mode = null;
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue.then(job).catch(() => {});
  }

  private async currentMode(): Promise<Mode> {
    const serial = this.session.serial;
    if (!serial) return 'text';
    const now = Date.now();
    if (this.mode && this.mode.serial === serial && now - this.mode.at < MODE_TTL_MS) return this.mode.value;
    let value: Mode = 'text';
    try {
      const out = await adb(['shell', 'dumpsys window | grep -m1 mCurrentFocus'], { serial, timeout: 3000 });
      const focus = out.replace(/.*u0 /, '').replace(/}.*/s, '').trim();
      value = isLetterGrid(focus) ? 'grid' : 'text';
    } catch {
      // Unknown: text is the safe choice, it never presses anything
    }
    this.mode = { value, at: now, serial };
    return value;
  }
}

function gridKeycode(ch: string): number | null {
  if (ch >= 'a' && ch <= 'z') return KEYCODE_A + ch.charCodeAt(0) - 97;
  if (ch >= '0' && ch <= '9') return KEYCODE_0 + ch.charCodeAt(0) - 48;
  if (ch === ' ') return KEYCODE_SPACE;
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
