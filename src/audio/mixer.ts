/**
 * The voice mixer.
 *
 * Plain TypeScript with no Web Audio in sight, so it runs under `node --test`
 * and under OfflineAudioContext for export, and the AudioWorklet is a thin
 * wrapper around it (src/audio/mixer-worklet.ts). Determinism is the point:
 * the same project must render identically on every browser and every run.
 */

import { panGains } from '../core/voice.ts';
import type { Adsr } from '../core/envelope.ts';
import { Envelope } from '../core/envelope.ts';
import type { Interpolator } from './interpolate.ts';
import { INTERPOLATORS, DEFAULT_INTERPOLATOR } from './interpolate.ts';
import type { LfoSettings } from './lfo.ts';
import { LFO_RATE_SCALE, Lfo, gainFactor, panFold, pitchFactor } from './lfo.ts';
import type { FilterSettings } from './moog.ts';
import { MoogLadder, filterAt, ladderCoefficients } from './moog.ts';
import type { MipChain } from './mipmap.ts';
import { mipLevelFor, readMipped } from './mipmap.ts';

export interface SampleBuffer {
  /** One Float32Array per channel, -1..1. */
  readonly channels: readonly Float32Array[];
  readonly sampleRate: number;
  readonly loop?: { readonly start: number; readonly end: number };
  /**
   * Optional per-channel mip chains from `buildMipChain`.
   *
   * **When present the voice reads through `readMipped`, which is the engine's
   * own sampler** -- linear, with the source swapped for a pre-decimated copy
   * above pitch ratio 2 and 4. Without them the voice uses the `Interpolator`
   * passed to the mixer, which is our reference path and stays available for
   * A/B. The two differ slightly at the loop wrap; `readMipped` documents how
   * and why they converge on real material.
   */
  readonly mips?: readonly MipChain[];
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
  /**
   * Frames of linear fade before `endFrame`.
   *
   * Needed for looping samples: they never run out on their own, so a voice
   * that is simply cut at `endFrame` leaves a step in the waveform and clicks.
   *
   * ⚠️ A linear fade is a stand-in for the game's own release. The instruments
   * carry 27 pairs of synth parameters that almost certainly hold an envelope
   * -- see steering/open-questions.md -- and none of those indices are
   * identified yet, so this is our shape, not the game's.
   */
  readonly release?: number;
  /**
   * Exponential decay in dB per second, applied from the voice's start.
   *
   * ⚠️ **NOT the game's envelope — ours, and a diagnostic.** The shipped loops
   * carry their own amplitude contour (`piano_c6`'s spans 1.70 dB peak to
   * trough), so repeating one modulates the output at the wrap rate whatever
   * the join does: measured 5.75% at 14.8 Hz on F5, 43.7x above the background,
   * which is audible as a flutter or click. A decay suppresses it — the same
   * measurement drops to 1.4x — which is presumably how the game hides it.
   * Leave this at 0 for faithful output until the real envelope is recovered
   * from `RInstrument.Params`; see steering/open-questions.md.
   */
  readonly decayDbPerSecond?: number;
  /**
   * The instrument's ADSR, from `evaluateAdsr`.
   *
   * **When present this is what shapes the note, and `release` and
   * `decayDbPerSecond` are ignored** -- those two were stand-ins for exactly
   * this, invented while `Params` was unread. A voice with an envelope also
   * outlives its `endFrame`: that frame closes the gate and the release runs
   * on from there, which is what stops a held note ending in a step.
   */
  readonly envelope?: Adsr;
  /**
   * The instrument's low-pass, from `Params[3..10]`.
   *
   * `settings` are the static knobs and `envelope` is the **second** ADSR,
   * which exists to sweep the cutoff. Most acoustic instruments leave the
   * filter wide open and can omit this entirely; it is what makes the synth
   * patches -- `saw_wave`, `robot`, `e_guitar_distorted`, the drum kits --
   * sound like themselves rather than like their raw samples.
   */
  readonly filter?: {
    readonly settings: FilterSettings;
    readonly envelope: Adsr;
  };
  /**
   * The instrument's three LFOs, `Params[15..23]`, in engine order: **pitch,
   * gain, pan**. A depth of zero leaves its destination untouched, which is
   * what 62 or more of the game's 68 instruments choose for each.
   *
   * Their phases are randomised per voice, so two notes of the same instrument
   * modulate differently -- pass `random` to make a render reproducible.
   */
  readonly lfos?: readonly [LfoSettings, LfoSettings, LfoSettings];
  /** Injected so an offline render can be deterministic. */
  readonly random?: () => number;
}

class Voice {
  position = 0;
  readonly spec: VoiceSpec;
  /** Output frames still to wait before this voice starts. */
  delay: number;
  /** Output frames remaining before it is cut, or Infinity. */
  life: number;
  /** Frames of linear fade at the end of that life. */
  readonly release: number;
  /** Per-frame multiplier for the optional decay, or 1. */
  readonly decayPerFrame: number;
  /** Which mip this voice reads, fixed by its rate. Unused without `mips`. */
  private readonly mipLevel: number;
  private readonly env = new Envelope();
  private readonly lfo: readonly [Lfo, Lfo, Lfo];
  // The filter envelope and one ladder per channel -- the engine keeps two,
  // which is what its ten per-voice state floats are.
  private readonly filterEnv = new Envelope();
  private readonly ladderL = new MoogLadder();
  private readonly ladderR = new MoogLadder();
  private readonly secondsPerFrame: number;
  private decayGain = 1;
  private readonly left: number;
  private readonly right: number;

  // Fields are declared and assigned longhand rather than with TypeScript
  // parameter properties: Node's strip-only type removal rejects any syntax
  // that emits runtime code. See steering/tracker-architecture.md.
  constructor(spec: VoiceSpec, delay: number, life: number, outputRate: number) {
    this.spec = spec;
    this.delay = delay;
    this.life = life;
    this.release = Number.isFinite(life) ? Math.min(spec.release ?? 0, life) : 0;
    this.decayPerFrame = spec.decayDbPerSecond
      ? Math.pow(10, -Math.abs(spec.decayDbPerSecond) / 20 / outputRate)
      : 1;
    this.mipLevel = mipLevelFor(spec.playbackRate);
    this.lfo = [new Lfo(spec.random), new Lfo(spec.random), new Lfo(spec.random)];
    this.secondsPerFrame = 1 / outputRate;
    const gains = panGains(spec.pan);
    this.left = gains.left * spec.gain;
    this.right = gains.right * spec.gain;
  }

  get finished(): boolean {
    // With an envelope the voice ends when the release reaches zero, not when
    // its life runs out -- life only closes the gate.
    if (this.spec.envelope ? this.env.finished : this.life <= 0) return true;
    const source = this.spec.sample.channels[0];
    return !this.spec.sample.loop && this.position >= source.length;
  }

  /** Render into the output, advancing by `frames`. Returns nothing; mixes additively. */
  render(
    outLeft: Float32Array,
    outRight: Float32Array,
    frames: number,
    interpolate: Interpolator,
    engineSampler: boolean,
  ): void {
    const { sample, playbackRate } = this.spec;
    const chans = sample.channels;
    const mono = chans.length === 1;
    const srcL = chans[0];
    const srcR = mono ? chans[0] : chans[1];
    const loop = sample.loop;
    const envelope = this.spec.envelope;
    const filter = this.spec.filter;
    const lfos = this.spec.lfos;
    // With the engine sampler off the voice falls back to `interpolate` over
    // the full-rate channels, which is the A/B path: it is how a different
    // interpolator can be heard against the game's own.
    const mips = engineSampler ? sample.mips : undefined;

    for (let i = 0; i < frames; i += 1) {
      if (this.delay > 0) {
        this.delay -= 1;
        continue;
      }
      const held = this.life > 0;
      if (!envelope && !held) return;

      if (loop) {
        const span = loop.end - loop.start;
        // The engine wraps only *past* loop.end, because it leaves the second
        // interpolation tap unwrapped and so still needs the frame at the end
        // to point somewhere. Our own path wraps both taps and therefore wraps
        // at loop.end. See readMipped.
        const past = mips ? this.position > loop.end : this.position >= loop.end;
        if (span > 0 && past) {
          this.position = loop.start + ((this.position - loop.start) % span);
        }
      }
      if (!loop && this.position >= srcL.length) return;

      let fade: number;
      if (envelope) {
        fade = this.env.advance(this.secondsPerFrame, held, envelope);
        if (this.env.finished) return;
      } else {
        // Linear release ramp over the last `release` frames of the voice's
        // life, plus the optional decay. Both are ours, and both are what the
        // envelope above replaces.
        fade =
          this.release > 0 && this.life < this.release ? this.life / this.release : 1;
        if (this.decayPerFrame !== 1) {
          this.decayGain *= this.decayPerFrame;
          fade *= this.decayGain;
        }
      }

      // Hand the loop to the interpolator only once the voice is inside it.
      // Before that the taps behind `loop.start` are the attack and are
      // correct as they stand; wrapping them would corrupt the note's onset.
      const region = loop && this.position >= loop.start ? loop : undefined;
      let l = mips
        ? readMipped(mips[0], this.position, this.mipLevel, region)
        : interpolate(srcL, this.position, region);
      let r = l;
      if (!mono) {
        r = mips
          ? readMipped(mips[1] ?? mips[0], this.position, this.mipLevel, region)
          : interpolate(srcR, this.position, region);
      }
      let panLeft = this.left;
      let panRight = this.right;
      let rate = playbackRate;
      if (lfos) {
        for (let n = 0; n < 3; n += 1) {
          this.lfo[n].advance(this.secondsPerFrame, lfos[n].rate * LFO_RATE_SCALE[n]);
        }
        if (lfos[0].depth !== 0) rate *= pitchFactor(this.lfo[0].value, lfos[0].depth);
        if (lfos[1].depth !== 0) fade *= gainFactor(this.lfo[1].value, lfos[1].depth);
        if (lfos[2].depth !== 0) {
          const gains = panGains(panFold(this.lfo[2].value, lfos[2].depth, this.spec.pan * 2));
          panLeft = gains.left * this.spec.gain;
          panRight = gains.right * this.spec.gain;
        }
      }

      // Filter, then amplitude: the ladder is inside the voice, ahead of the
      // gain and the pan.
      if (filter) {
        const level = this.filterEnv.advance(this.secondsPerFrame, held, filter.envelope);
        const { freq, res } = filterAt(filter.settings, level, playbackRate);
        const coefficients = ladderCoefficients(freq, res);
        l = this.ladderL.process(l, coefficients);
        r = mono ? l : this.ladderR.process(r, coefficients);
      }

      outLeft[i] += l * panLeft * fade;
      outRight[i] += r * panRight * fade;

      this.position += rate;
      this.life -= 1;
    }
  }
}

export class Mixer {
  readonly outputRate: number;
  private voices: Voice[] = [];
  private interpolate: Interpolator;
  private engineSampler = true;

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

  /**
   * Whether voices read through the engine's own sampler (linear plus octave
   * mipmaps, `readMipped`) or through the mixer's `Interpolator`.
   *
   * **On is the faithful setting and the default.** Off exists so a different
   * interpolator can be compared against it; it also takes effect only for
   * samples that were loaded with mip chains.
   */
  setEngineSampler(on: boolean): void {
    this.engineSampler = on;
  }

  get voiceCount(): number {
    return this.voices.length;
  }

  /** Start a voice. `startFrame` is relative to the next render block. */
  play(spec: VoiceSpec): void {
    const delay = Math.max(0, spec.startFrame ?? 0);
    const life =
      spec.endFrame === undefined ? Infinity : Math.max(0, spec.endFrame - delay);
    this.voices.push(new Voice(spec, delay, life, this.outputRate));
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
      voice.render(left, right, frames, this.interpolate, this.engineSampler);
    }
    // A voice that ran out mid-block has already written what it had.
    this.voices = this.voices.filter((v) => !v.finished);
  }
}
