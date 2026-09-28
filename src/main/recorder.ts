// Writes the H.264 stream the device already sends into an MP4 file, without
// re-encoding. Fragmented MP4, so a recording stays playable even if the app
// stops mid-way. Frames arrive only when the screen changes, so the file has a
// variable frame rate; each frame lasts until the next one arrives.
//
// An MP4 must start on a key frame; the device sends one only every ~10 s, so
// starting a recording asks the server for a fresh one (Session.resetVideo).

import fs from 'fs';
import { Muxer, StreamTarget } from 'mp4-muxer';

interface Frame { data: Uint8Array; key: boolean; pts: number; at: number }

/** Splits an Annex B buffer (00 00 01 / 00 00 00 01 start codes) into NAL units */
function splitNals(buf: Uint8Array): Uint8Array[] {
  const nals: Uint8Array[] = [];
  let start = -1;
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (start >= 0) nals.push(buf.subarray(start, i > 0 && buf[i - 1] === 0 ? i - 1 : i));
      start = i + 3;
      i += 2;
    }
  }
  if (start >= 0) nals.push(buf.subarray(start));
  return nals.filter((n) => n.length > 0);
}

/** avcC box contents (the decoder configuration MP4 needs) from one SPS and one PPS */
function avcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.length + pps.length);
  out.set([1, sps[1], sps[2], sps[3], 0xff, 0xe1, sps.length >> 8, sps.length & 0xff]);
  out.set(sps, 8);
  let o = 8 + sps.length;
  out.set([1, pps.length >> 8, pps.length & 0xff], o);
  out.set(pps, o + 3);
  return out;
}

export class Recorder {
  private fd: number | null = null;
  private muxer: Muxer<StreamTarget> | null = null;
  private pending: Frame | null = null;
  private firstPts = 0;
  private lastPts = 0;
  file: string | null = null;

  get active(): boolean {
    return this.fd !== null;
  }

  start(file: string, width: number, height: number): void {
    this.fd = fs.openSync(file, 'w');
    this.file = file;
    const fd = this.fd;
    this.muxer = new Muxer({
      target: new StreamTarget({ onData: (data, position) => { fs.writeSync(fd, data, 0, data.length, position); } }),
      video: { codec: 'avc', width, height },
      fastStart: 'fragmented',
      firstTimestampBehavior: 'offset',
    });
    this.pending = null;
  }

  /** Feed every video packet; recording begins at the first key frame */
  push(data: Uint8Array, key: boolean, pts: number): void {
    if (!this.muxer) return;
    const f = { data, key, pts, at: Date.now() };
    if (!this.pending && !f.key) return;
    if (this.pending) this.write(this.pending, f.pts - this.pending.pts);
    else this.firstPts = f.pts;
    this.pending = f;
    this.lastPts = f.pts;
  }

  private write(f: Frame, durationUs: number): void {
    const nals = splitNals(f.data);
    const sps = nals.find((n) => (n[0] & 0x1f) === 7);
    const pps = nals.find((n) => (n[0] & 0x1f) === 8);
    // MP4 stores NAL units with 4-byte length prefixes; SPS/PPS go in the avcC box instead
    const body = nals.filter((n) => { const t = n[0] & 0x1f; return t !== 7 && t !== 8; });
    const out = new Uint8Array(body.reduce((s, n) => s + 4 + n.length, 0));
    let o = 0;
    for (const n of body) {
      new DataView(out.buffer).setUint32(o, n.length);
      out.set(n, o + 4);
      o += 4 + n.length;
    }
    const meta = f.key && sps && pps
      ? { decoderConfig: { codec: `avc1.${[...sps.subarray(1, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')}`, description: avcC(sps, pps) } }
      : undefined;
    this.muxer!.addVideoChunkRaw(out, f.key ? 'key' : 'delta', f.pts, Math.max(1, durationUs), meta);
  }

  /** Finishes the file; returns its path and length in seconds */
  stop(): { file: string; seconds: number } | null {
    if (!this.muxer || this.fd === null || !this.file) return null;
    // The last frame stays on screen until Stop (the device sends nothing while the screen is still)
    const tailUs = this.pending ? Math.max(40_000, (Date.now() - this.pending.at) * 1000) : 0;
    if (this.pending) this.write(this.pending, tailUs);
    const seconds = this.pending ? (this.lastPts - this.firstPts + tailUs) / 1e6 : 0;
    const hadFrames = !!this.pending;
    this.muxer.finalize();
    fs.closeSync(this.fd);
    const file = this.file;
    this.muxer = null;
    this.fd = null;
    this.pending = null;
    this.file = null;
    if (!hadFrames) { fs.rmSync(file, { force: true }); return null; }
    return { file, seconds };
  }
}
