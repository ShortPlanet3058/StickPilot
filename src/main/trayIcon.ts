// Draws the menu-bar icon (a TV outline) into a PNG at runtime, so the app ships
// no image files. macOS uses it as a template image (tinted to match the menu bar).

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

/** Coverage of a pixel by a rounded-rectangle outline and a stand, supersampled for smooth edges */
function tvShape(size: number): (x: number, y: number) => number {
  const s = size / 18; // designed on an 18 px grid
  const stroke = 1.6 * s;
  const inRoundedRectRing = (px: number, py: number) => {
    const [x0, y0, x1, y1, r] = [1.5 * s, 3 * s, 16.5 * s, 13 * s, 2.2 * s];
    const d = (ix0: number, iy0: number, ix1: number, iy1: number, rr: number) => {
      const qx = Math.max(ix0 + rr - px, 0, px - (ix1 - rr));
      const qy = Math.max(iy0 + rr - py, 0, py - (iy1 - rr));
      return Math.hypot(qx, qy) - rr; // <0 inside
    };
    return d(x0, y0, x1, y1, r) <= 0 && d(x0 + stroke, y0 + stroke, x1 - stroke, y1 - stroke, Math.max(0, r - stroke)) > 0;
  };
  const inStand = (px: number, py: number) =>
    (px >= 5.5 * s && px <= 12.5 * s && py >= 15 * s && py <= 15 * s + stroke)
    || (px >= 9 * s - stroke / 2 && px <= 9 * s + stroke / 2 && py >= 13 * s && py <= 15 * s);
  return (x, y) => {
    let hit = 0;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      const px = x + (i + 0.5) / 4;
      const py = y + (j + 0.5) / 4;
      if (inRoundedRectRing(px, py) || inStand(px, py)) hit++;
    }
    return hit / 16;
  };
}

/** PNGs for 1x and 2x displays */
export function trayIconPngs(): { x1: Buffer; x2: Buffer } {
  return { x1: png(18, tvShape(18)), x2: png(36, tvShape(36)) };
}
