// Mouse on the picture becomes a finger on the device, for phones and tablets: click to
// tap, drag to swipe, hold to long-press, and the wheel or trackpad scrolls. Right click
// is Back and middle click Home, as in scrcpy. TVs have no touchscreen, so there the
// picture stays a picture.

import { KEY } from './remote';
import type { StickPilotApi } from '../shared/types';

export interface TouchHooks {
  /** Touch is on for the device being shown */
  enabled(): boolean;
  flash(code: number, down: boolean): void;
}

const NOTCH_PX = 100; // a mouse wheel notch, in browser wheel pixels

export function bindTouch(canvas: HTMLCanvasElement, api: StickPilotApi, hooks: TouchHooks): void {
  /** Pointer position in video pixels, or null outside the picture (object-fit: contain bars) */
  const toVideo = (e: { clientX: number; clientY: number }) => {
    const w = canvas.width;
    const h = canvas.height;
    const r = canvas.getBoundingClientRect();
    if (!w || !h || !r.width || !r.height) return null;
    const scale = Math.min(r.width / w, r.height / h);
    const x = (e.clientX - (r.left + (r.width - w * scale) / 2)) / scale;
    const y = (e.clientY - (r.top + (r.height - h * scale) / 2)) / scale;
    return x >= 0 && y >= 0 && x < w && y < h ? { x, y, w, h } : null;
  };

  let pointer: number | null = null;
  let last: { x: number; y: number; w: number; h: number } | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (!hooks.enabled()) return;
    if (e.button === 2 || e.button === 1) {
      e.preventDefault();
      const code = e.button === 2 ? KEY.BACK : KEY.HOME;
      api.tap(code);
      hooks.flash(code, true);
      setTimeout(() => hooks.flash(code, false), 150);
      return;
    }
    if (e.button !== 0 || pointer !== null) return;
    const p = toVideo(e);
    if (!p) return;
    e.preventDefault();
    pointer = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    last = p;
    api.touch(0, p.x, p.y, p.w, p.h);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointer || !last) return;
    // Captured: keep following outside the picture, clamped to its edge
    const r = toVideo(e) ?? (() => {
      const w = canvas.width, h = canvas.height, b = canvas.getBoundingClientRect();
      const scale = Math.min(b.width / w, b.height / h);
      const x = (e.clientX - (b.left + (b.width - w * scale) / 2)) / scale;
      const y = (e.clientY - (b.top + (b.height - h * scale) / 2)) / scale;
      return { x: Math.max(0, Math.min(w - 1, x)), y: Math.max(0, Math.min(h - 1, y)), w, h };
    })();
    last = r;
    api.touch(2, r.x, r.y, r.w, r.h);
  });

  const end = (e: PointerEvent) => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    if (last) api.touch(1, last.x, last.y, last.w, last.h);
    last = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // Leaving the app mid-drag must not leave a finger down on the device
  window.addEventListener('blur', () => {
    if (pointer === null) return;
    if (last) api.touch(1, last.x, last.y, last.w, last.h);
    pointer = null;
    last = null;
  });

  canvas.addEventListener('contextmenu', (e) => { if (hooks.enabled()) e.preventDefault(); });

  canvas.addEventListener('wheel', (e) => {
    if (!hooks.enabled()) return;
    const p = toVideo(e);
    if (!p) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 10 : 1 / NOTCH_PX;
    const h = e.deltaX * unit;
    const v = -e.deltaY * unit;
    if (h || v) api.scroll(p.x, p.y, p.w, p.h, Math.max(-16, Math.min(16, h)), Math.max(-16, Math.min(16, v)));
  }, { passive: false });
}
