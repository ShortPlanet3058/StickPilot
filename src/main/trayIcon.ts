// Draws the menu-bar icon into a PNG at runtime: a one-color version of the
// StickPilot logo (a diagonal streaming stick crossed by a remote's D-pad ring).
// macOS uses it as a template image, tinted to match the menu bar.

import zlib from 'zlib';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size: number, alpha: (x: number, y: number) => number): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte + RGBA
    for (let x = 0; x < size; x++) row[1 + x * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, alpha(x, y))));
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Coverage of a pixel by the logo glyph, supersampled for smooth edges (18 px design grid) */
function logoShape(size: number): (x: number, y: number) => number {
  const s = size / 18;
  const c = 9 * s;
  const k = Math.SQRT1_2;
  // Stick along the rising diagonal; u runs along it (towards the top right), v across
  const inStick = (u: number, v: number) => {
    const halfLen = 7.9 * s;
    const halfWidth = 2.5 * s;
    const r = 2.0 * s;
    const qx = Math.max(Math.abs(u) - (halfLen - r), 0);
    const qy = Math.max(Math.abs(v) - (halfWidth - r), 0);
    return Math.hypot(qx, qy) <= r;
  };
  const inPlug = (u: number, v: number) => u >= 7.6 * s && u <= 9.6 * s && Math.abs(v) <= 1.3 * s;
  return (x, y) => {
    let hit = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const dx = x + (i + 0.5) / 4 - c;
      const dy = y + (j + 0.5) / 4 - c;
      const u = (dx - dy) * k;
      const v = (dx + dy) * k;
      const r = Math.hypot(dx, dy) / s;
      const ring = r >= 2.5 && r <= 3.8;
      const dot = r <= 1.2;
      // A gap around the ring keeps it distinct from the stick in a single color
      const stick = r >= 4.6 && (inStick(u, v) || inPlug(u, v));
      if (ring || dot || stick) hit++;
    }
    return hit / 16;
  };
}

/** PNGs for 1x and 2x displays */
export function trayIconPngs(): { x1: Buffer; x2: Buffer } {
  return { x1: png(18, logoShape(18)), x2: png(36, logoShape(36)) };
}
