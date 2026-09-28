// H.264 decoding with WebCodecs. Frames are drawn the moment they are decoded;
// nothing is buffered, because buffering is exactly the lag we want to avoid.

import type { FireTvApi } from '../shared/types';

export class Video {
  private ctx: CanvasRenderingContext2D;
  private decoder: VideoDecoder | null = null;
  private waitingForKey = true;
  private submitted = new Map<number, { t: number; lagMs: number }>();
  private stats = { frames: 0, decodeMs: [] as number[], lagMs: [] as number[], dropped: 0 };
  hasFrame = false;
  onFirstFrame: () => void = () => {};

  constructor(private canvas: HTMLCanvasElement, api: FireTvApi) {
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })!;
    api.onConfig(({ codec }) => this.configure(codec));
    api.onPacket(({ data, key, pts, lagMs }) => {
      const d = this.decoder;
      if (!d || d.state !== 'configured') return;
      if (this.waitingForKey && !key) return;
      this.waitingForKey = false;
      if (d.decodeQueueSize > 2 && !key) { this.stats.dropped++; return; }
      this.submitted.set(pts, { t: performance.now(), lagMs });
      d.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: pts, data }));
    });
  }

  private configure(codec: string): void {
    this.close();
    this.waitingForKey = true;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
          this.canvas.width = frame.displayWidth;
          this.canvas.height = frame.displayHeight;
        }
        this.ctx.drawImage(frame, 0, 0);
        const s = this.submitted.get(frame.timestamp);
        if (s) {
          this.stats.decodeMs.push(performance.now() - s.t);
          this.stats.lagMs.push(s.lagMs);
          this.submitted.delete(frame.timestamp);
        }
        this.stats.frames++;
        frame.close();
        if (!this.hasFrame) { this.hasFrame = true; this.onFirstFrame(); }
      },
      error: (e) => console.error('decoder', e),
    });
    this.decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  }

  private close(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.submitted.clear();
  }

  /** Drops the decoder and blanks the canvas so a stale frame never looks live */
  clear(): void {
    this.close();
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.hasFrame = false;
  }

  /** Summary of the last second; resets the counters */
  takeStats(): string {
    const s = this.stats;
    const median = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
    const size = `${this.canvas.width}×${this.canvas.height}`;
    // The device only sends frames when the screen changes
    const text = s.frames === 0
      ? `idle    ${size}\nscreen is still, no new frames`
      : `${String(s.frames).padStart(2)} fps   ${size}\n`
        + `lag     ${median(s.lagMs).toFixed(0).padStart(4)} ms   max ${Math.max(0, ...s.lagMs).toFixed(0)} ms\n`
        + `decode  ${median(s.decodeMs).toFixed(1).padStart(4)} ms`
        + (s.dropped ? `\ndropped ${s.dropped}` : '');
    this.stats = { frames: 0, decodeMs: [], lagMs: [], dropped: 0 };
    return text;
  }
}
