// Plays the device's Opus audio with WebCodecs + Web Audio. Latency is kept low
// and bounded: the device sends a burst when the stream opens, and frames are
// dropped while more than MAX_AHEAD is queued, so playback settles close to real
// time instead of carrying that backlog (or any later one) forever.

import type { StickPilotApi } from '../shared/types';

const START_DELAY = 0.04; // seconds of buffer ahead of "now" for smooth playback
const MAX_AHEAD = 0.1;

export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private decoder: AudioDecoder | null = null;
  private next = 0;
  private gain: GainNode | null = null;
  onEnded: () => void = () => {};

  constructor(api: StickPilotApi) {
    api.onAudioConfig(({ description }) => this.configure(description));
    api.onAudioPacket(({ data, pts }) => {
      if (this.decoder?.state !== 'configured') return;
      this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: pts, data }));
    });
    api.onAudioEnded(() => { this.stop(); this.onEnded(); });
  }

  private configure(description: Uint8Array): void {
    this.stop();
    this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.next = 0;
    this.decoder = new AudioDecoder({
      output: (frame) => this.play(frame),
      error: (e) => console.error('audio decoder', e),
    });
    this.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, description });
  }

  private play(frame: AudioData): void {
    const ctx = this.ctx!;
    const buffer = ctx.createBuffer(frame.numberOfChannels, frame.numberOfFrames, frame.sampleRate);
    for (let c = 0; c < frame.numberOfChannels; c++) {
      frame.copyTo(buffer.getChannelData(c), { planeIndex: c, format: 'f32-planar' });
    }
    frame.close();
    const now = ctx.currentTime;
    if (this.next > now + MAX_AHEAD) return; // too much queued: drop this frame to catch up
    if (this.next < now + 0.005) this.next = now + START_DELAY; // ran dry: restart with a small buffer
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain!);
    src.start(this.next);
    this.next += buffer.duration;
  }

  /** How far ahead of real time the queued audio is, in ms (shown in the stats) */
  bufferedMs(): number {
    return this.ctx ? Math.max(0, (this.next - this.ctx.currentTime) * 1000) : 0;
  }

  get active(): boolean {
    return this.decoder?.state === 'configured';
  }

  stop(): void {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    void this.ctx?.close();
    this.ctx = null;
    this.gain = null;
  }
}
