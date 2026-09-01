/**
 * The voice mixer.
 *
 * Plain TypeScript with no Web Audio in sight, so it runs under `node --test`
 * and under OfflineAudioContext for export, and the AudioWorklet is a thin
 * wrapper around it (src/audio/mixer-worklet.ts). Determinism is the point:
 * the same project must render identically on every browser and every run.
 */

import { panGains } from '../core/voice.ts';
import type { Interpolator } from './interpolate.ts';
import { INTERPOLATORS, DEFAULT_INTERPOLATOR } from './interpolate.ts';

export interface SampleBuffer {
  /** One Float32Array per channel, -1..1. */
  readonly channels: readonly Float32Array[];
  readonly sampleRate: number;
  readonly loop?: { readonly start: number; readonly end: number };
}

export interface VoiceSpec {
  readonly sample: SampleBuffer;
  /** Sample frames advanced per output frame. */
  readonly playbackRate: number;
  readonly gain: number;
  /** 0 = hard left, 0.5 = centre, 1 = hard right. */
  readonly pan: number;
  /** Output frame at which this voice starts. Lets a block schedule sample-accurately. */
  readonly startFrame?: number;
  /** Output frame at which it stops, or undefined to run to the end of the sample. */
  readonly endFrame?: number;
}

class Voice {
  position = 0;
  readonly spec: VoiceSpec;
  /** Output frames still to wait before this voice starts. */
  delay: number;
  /** Output frames remaining before it is cut, or Infinity. */
  life: number;
  private readonly left: number;
  private readonly right: number;

  // Fields are declared and assigned longhand rather than with TypeScript
  // parameter properties: Node's strip-only type removal rejects any syntax
  // that emits runtime code. See steering/tracker-architecture.md.
  constructor(spec: VoiceSpec, delay: number, life: number) {
    this.spec = spec;
    this.delay = delay;
    this.life = life;
    const gains = panGains(spec.pan);
    this.left = gains.left * spec.gain;
    this.right = gains.right * spec.gain;
  }

  get finished(): boolean {
    if (this.life <= 0) return true;
    const source = this.spec.sample.channels[0];
    return !this.spec.sample.loop && this.position >= source.length;
  }

  /** Render into the output, advancing by `frames`. Returns nothing; mixes additively. */
  render(
    outLeft: Float32Array,
    outRight: Float32Array,
    frames: number,
    interpolate: Interpolator,
  ): void {
    const { sample, playbackRate } = this.spec;
    const chans = sample.channels;
    const mono = chans.length === 1;
    const srcL = chans[0];
    const srcR = mono ? chans[0] : chans[1];
    const loop = sample.loop;

    for (let i = 0; i < frames; i += 1) {
      if (this.delay > 0) {
        this.delay -= 1;
        continue;
      }
      if (this.life <= 0) return;

      if (loop && this.position >= loop.end) {
        const span = loop.end - loop.start;
        if (span > 0) {
          this.position = loop.start + ((this.position - loop.start) % span);
        }
      }
      if (!loop && this.position >= srcL.length) return;

      const l = interpolate(srcL, this.position);
      const r = mono ? l : interpolate(srcR, this.position);
      outLeft[i] += l * this.left;
      outRight[i] += r * this.right;

      this.position += playbackRate;
      this.life -= 1;
    }
  }
}

export class Mixer {
  readonly outputRate: number;
  private voices: Voice[] = [];
  private interpolate: Interpolator;

  constructor(
    outputRate: number,
    interpolate: Interpolator = INTERPOLATORS[DEFAULT_INTERPOLATOR],
  ) {
    this.outputRate = outputRate;
    this.interpolate = interpolate;
  }

  setInterpolator(interpolate: Interpolator): void {
    this.interpolate = interpolate;
  }

  get voiceCount(): number {
    return this.voices.length;
  }

  /** Start a voice. `startFrame` is relative to the next render block. */
  play(spec: VoiceSpec): void {
    const delay = Math.max(0, spec.startFrame ?? 0);
    const life =
      spec.endFrame === undefined ? Infinity : Math.max(0, spec.endFrame - delay);
    this.voices.push(new Voice(spec, delay, life));
  }

  stopAll(): void {
    this.voices.length = 0;
  }

  /**
   * Render one block. `left` and `right` are cleared first, so callers get the
   * mix rather than an accumulation across blocks.
   */
  render(left: Float32Array, right: Float32Array): void {
    const frames = Math.min(left.length, right.length);
    left.fill(0);
    right.fill(0);

    for (const voice of this.voices) {
      voice.render(left, right, frames, this.interpolate);
    }
    // A voice that ran out mid-block has already written what it had.
    this.voices = this.voices.filter((v) => !v.finished);
  }
}
