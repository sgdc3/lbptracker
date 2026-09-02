/**
 * The voice mixer.
 *
 * Plain TypeScript with no Web Audio in sight, so it runs under `node --test`
 * and under OfflineAudioContext for export, and the AudioWorklet is a thin
 * wrapper around it (src/audio/mixer-worklet.ts). Determinism is the point:
 * the same project must render identically on every browser and every run.
 */

import { panGains, panGainsInto } from '../core/voice.ts';
import type { Adsr } from '../core/envelope.ts';
import { Envelope } from '../core/envelope.ts';
import type { Interpolator } from './interpolate.ts';
import { INTERPOLATORS, DEFAULT_INTERPOLATOR } from './interpolate.ts';
import type { LfoSettings } from './lfo.ts';
import { LFO_RATE_SCALE, Lfo, gainFactor, panFold, pitchFactor } from './lfo.ts';
import type { FilterSettings } from './moog.ts';
import {
  FILTER_BYPASS_CUTOFF,
  MoogLadder,
  filterAt,
  filterAtInto,
  ladderCoefficients,
  ladderCoefficientsInto,
} from './moog.ts';
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

/**
 * One control point of a note's automation.
 *
 * The engine holds a note's pitch, volume and pan as **(value, slide) pairs**
 * and rewrites both at every control point, so a note glides linearly from one
 * point to the next -- see `sub_0x38e0`. That glide is the sequencer's pitch
 * bend, and it is not a rare flourish: **53.9% of the corpus's 2,027,633 notes
 * carry more than one control point**, and 6.7% bend in pitch, by up to 95
 * semitones.
 */
export interface AutomationPoint {
  /** Frames from the voice's start. */
  readonly frame: number;
  /**
   * Semitones relative to the note's base pitch.
   *
   * ⚠️ Interpolated **linearly in semitones**, not in playback rate. The engine
   * ramps `voice.pitch` and only then feeds it to `exp2f`, so a bend is
   * exponential in rate; linear-in-rate would sag in the middle of every glide.
   */
  readonly pitch: number;
  /** Linear gain relative to the note's base volume. */
  readonly gain: number;
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
   * Output frame at which this voice is **taken away**, whatever it is doing.
   *
   * ⚠️ Not the same thing as `endFrame`, and the difference is the whole
   * point. `endFrame` closes the note's gate -- the envelope releases, and a
   * one-shot ignores it entirely, because a drum hit is not shortened by how
   * long the note was written. `cutFrame` is the engine's allocator handing this
   * voice's record to a later note: `fmodextinput.prx` 0x1640 returns a record
   * and the caller overwrites it, so whatever was playing there stops mid-sample
   * with no release. A one-shot cannot ignore that one.
   *
   * Leaving it out is what let a stolen one-shot keep sounding. On `Ascetic`
   * that is `mime_artist` -- five stack layers of a loopless 9,142-frame vocal,
   * played at rate 0.02 because the note sits 68 semitones under the sample's
   * base note, so each note occupied five of the engine's 32 voices for **9.5
   * seconds** and none of them ever went away.
   */
  readonly cutFrame?: number;
  /**
   * Frames for which a one-shot's gate is held open regardless of the note.
   *
   * ⚠️ This is the whole of question 10, made into a number. `Infinity` is the
   * rule as it was first written -- a loopless sample is never gated and plays
   * to its end -- and the corpus refutes that as a universal rule; see
   * `holdFramesFor` in `src/core/render.ts` for the measurement and for what
   * this is set to instead. 0 gates a one-shot like anything else.
   */
  readonly holdFrames?: number;
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
  /**
   * The note's control points, in frame order and relative to its start.
   *
   * A single point, or none, means a flat note. Anything past the last point
   * holds its value, which is what the engine does when it runs out of records.
   */
  readonly automation?: readonly AutomationPoint[];
  /**
   * How much of this voice goes to the echo and reverb buses, 0..1.
   *
   * `PInstrument` carries both as real fields (`echoSend`, `reverbSend`), and
   * 22% and 55% of the corpus's placements set them.
   *
   * ⚠️ **Two buses is our arrangement, not a measured one.** The DSP is
   * 4-in/4-out — one dry stereo pair and one send pair — and `Params[25]` is a
   * single send level, so the engine very likely sums echo and reverb into that
   * one pair rather than keeping them apart. Splitting them here is easier to
   * mix and easier to be wrong about; see steering/open-questions.md.
   */
  readonly echoSend?: number;
  readonly reverbSend?: number;
  /** Injected so an offline render can be deterministic. */
  readonly random?: () => number;
  /**
   * Sample frame to begin at, rather than 0.
   *
   * `Params[2]` gives each layer of a stacked voice its own random start,
   * `startOffset * sampleLength * U(0, 1)` frames in, which is what stops the
   * layers from being one louder copy of each other.
   */
  readonly startPosition?: number;
  /**
   * Radians added to each LFO's randomised start phase, one per LFO.
   *
   * `Params[17|20|23]` times `2 * PI / Numstack` per layer, so a stacked
   * voice's layers sit at different points of the same cycle.
   */
  readonly lfoPhaseOffset?: readonly [number, number, number];
}

class Voice {
  position = 0;
  readonly spec: VoiceSpec;
  /** Output frames still to wait before this voice starts. */
  delay: number;
  /** Output frames remaining before it is cut, or Infinity. */
  life: number;
  /** Frames until the allocator takes this voice away; Infinity if it never does. */
  cut: number;
  /** Frames of forced gate left on a one-shot. */
  hold: number;
  /** Frames of linear fade at the end of that life. */
  readonly release: number;
  /** Per-frame multiplier for the optional decay, or 1. */
  readonly decayPerFrame: number;
  /** Which mip this voice reads, fixed by its rate. Unused without `mips`. */
  private readonly mipLevel: number;
  private readonly env = new Envelope();
  /** Frames rendered since this voice started, for the automation cursor. */
  private elapsed = 0;
  private autoIndex = 0;
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
  constructor(
    spec: VoiceSpec,
    delay: number,
    life: number,
    cut: number,
    outputRate: number,
  ) {
    // ⚠️ The default has to depend on the sample, not be a flat Infinity: a
    // LOOPED voice with no `holdFrames` must still be gated by its note, and
    // holding its gate open forever is what a flat default did -- it broke
    // `endFrame` for every caller that had never heard of one-shots.
    this.hold = spec.holdFrames ?? (spec.sample.loop === undefined ? Infinity : 0);
    this.spec = spec;
    this.delay = delay;
    this.life = life;
    this.cut = cut;
    this.release = Number.isFinite(life) ? Math.min(spec.release ?? 0, life) : 0;
    this.decayPerFrame = spec.decayDbPerSecond
      ? Math.pow(10, -Math.abs(spec.decayDbPerSecond) / 20 / outputRate)
      : 1;
    this.mipLevel = mipLevelFor(spec.playbackRate);
    const phase = spec.lfoPhaseOffset;
    this.lfo = [
      new Lfo(spec.random, phase?.[0] ?? 0),
      new Lfo(spec.random, phase?.[1] ?? 0),
      new Lfo(spec.random, phase?.[2] ?? 0),
    ];
    this.position = spec.startPosition ?? 0;
    this.secondsPerFrame = 1 / outputRate;
    const gains = panGains(spec.pan);
    this.left = gains.left * spec.gain;
    this.right = gains.right * spec.gain;
  }

  /**
   * Whether this voice ignores its note's end and runs to the end of the sample.
   *
   * A sample with no loop has no way to sustain, and the game's percussion is
   * exactly that set. **89.4% of the corpus's 673,037 percussion notes last two
   * steps or fewer** -- at 180 BPM, 167 ms against samples of 0.5 to 0.8 s. A
   * one-step kick would be 83 ms of an 806 ms sample, and `a_kit_1.rinst`'s
   * amplitude envelope is a bare gate (`sustain 1`, `release 0.068`), so gating
   * would clip essentially every drum hit in every level to a stub.
   *
   * ⚠️ **This is inferred, not read.** There is no one-shot flag: the slot
   * carries only `baseNote`, `baseBpm`, `pitched`, `fitBpm` and `fineTune`, so
   * the loop's presence in the sample is the only signal the engine has to work
   * with. What has not been found is the code that acts on it. See open
   * question 10.
   */
  private get oneShot(): boolean {
    return this.spec.sample.loop === undefined && this.hold > 0;
  }

  /**
   * Scratch for the inner loop.
   *
   * `filterAt`, `ladderCoefficients` and `panGains` each returned a fresh
   * object, and the loop calls all three once per frame per voice. Reusing
   * three objects per voice is the same arithmetic with the allocation
   * removed -- the rendered output is byte-identical, which is asserted by
   * hashing a render before and after.
   */
  private readonly filterScratch = { freq: 0, res: 0 };
  private readonly ladderScratch = { p: 0, f: 0, q: 0 };
  private readonly panScratch = { left: 0, right: 0 };

  get finished(): boolean {
    const source = this.spec.sample.channels[0];
    // Being taken away ends any voice, one-shot or not.
    if (this.cut <= 0) return true;
    // A one-shot ends when the sample does, and only then.
    if (this.oneShot) return this.position >= source.length;
    // With an envelope the voice ends when the release reaches zero, not when
    // its life runs out -- life only closes the gate.
    if (this.spec.envelope ? this.env.finished : this.life <= 0) return true;
    return this.position >= source.length;
  }

  /**
   * Render into the output, advancing by `frames`, mixing additively.
   *
   * Returns the half-open frame span it actually touched. Callers need that:
   * a send bus has to clear and accumulate a scratch buffer around each voice,
   * and doing that over the whole block instead of the voice's own window is
   * what made a full-length render quadratic -- with tens of thousands of notes
   * against a sixteen-million-frame block it is the difference between seconds
   * and hours.
   */
  render(
    outLeft: Float32Array,
    outRight: Float32Array,
    frames: number,
    interpolate: Interpolator,
    engineSampler: boolean,
  ): { begin: number; end: number } {
    const { sample, playbackRate } = this.spec;
    const chans = sample.channels;
    const mono = chans.length === 1;
    const srcL = chans[0];
    const srcR = mono ? chans[0] : chans[1];
    const loop = sample.loop;
    const envelope = this.spec.envelope;
    const filter = this.spec.filter;
    const lfos = this.spec.lfos;
    const automation = this.spec.automation;
    // With the engine sampler off the voice falls back to `interpolate` over
    // the full-rate channels, which is the A/B path: it is how a different
    // interpolator can be heard against the game's own.
    const mips = engineSampler ? sample.mips : undefined;
    // Per-voice constants, tested once instead of once per frame.
    const lfo0 = lfos !== undefined && lfos[0].depth !== 0;
    const lfo1 = lfos !== undefined && lfos[1].depth !== 0;
    const lfo2 = lfos !== undefined && lfos[2].depth !== 0;

    // `envFactor` is `1 + envAmount * (envB - 1)`, so at `envAmount === 0` it is
    // 1 whatever the envelope does -- the cutoff and resonance are then fixed
    // for the whole voice, and both the filter envelope and the coefficient
    // solve can leave the loop. Most instruments are in this case at modulation
    // 0: `piano`, `musicbox`, `a_kit_1`, `ray_gun` and `baiyon_drums_1` all have
    // `Params[6].x` of exactly zero.
    const filterFixed = filter !== undefined && filter.settings.envAmount === 0;
    let fixedBypass = false;
    if (filter && filterFixed) {
      // The envelope level is unused here, so any value gives the same answer.
      const fixed = filterAtInto(filter.settings, 0, playbackRate, this.filterScratch);
      fixedBypass = fixed.freq > FILTER_BYPASS_CUTOFF;
      if (!fixedBypass) ladderCoefficientsInto(fixed.freq, fixed.res, this.ladderScratch);
    }

    // Skip the start delay by arithmetic. Counting it down a frame at a time
    // made every voice walk the whole block before its first sample, so a note
    // near the end of a long render cost as much as one at the beginning.
    let begin = 0;
    if (this.delay > 0) {
      const skip = Math.min(this.delay, frames);
      this.delay -= skip;
      if (skip >= frames) return { begin: frames, end: frames };
      begin = skip;
    }
    // The allocator's cut, by arithmetic rather than a per-frame test: it is
    // known before the loop and never moves.
    const last = Number.isFinite(this.cut) ? Math.min(frames, begin + this.cut) : frames;

    let i = begin;
    for (; i < last; i += 1) {
      // A one-shot is never released: it is held until the sample runs out.
      const held = this.hold > 0 || this.life > 0;
      if (!envelope && !held) break;
      this.hold -= 1;

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
      if (!loop && this.position >= srcL.length) break;

      let fade: number;
      if (envelope) {
        fade = this.env.advance(this.secondsPerFrame, held, envelope);
        if (this.env.finished) break;
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

      // The note's own bend and volume glide, ahead of the LFOs, which
      // multiply on top of it exactly as the engine's do.
      if (automation && automation.length > 0) {
        while (
          this.autoIndex + 1 < automation.length &&
          automation[this.autoIndex + 1].frame <= this.elapsed
        ) {
          this.autoIndex += 1;
        }
        const from = automation[this.autoIndex];
        const to = automation[this.autoIndex + 1];
        let semitones = from.pitch;
        let gain = from.gain;
        if (to) {
          const span = to.frame - from.frame;
          // A zero-length segment would divide by zero; two records on the same
          // step is authoring debris, not a glide, so take the later value.
          const t = span > 0 ? (this.elapsed - from.frame) / span : 1;
          semitones += (to.pitch - from.pitch) * t;
          gain += (to.gain - from.gain) * t;
        }
        if (semitones !== 0) rate *= 2 ** (semitones / 12);
        fade *= gain;
      }
      this.elapsed += 1;
      if (lfos) {
        // An LFO at zero depth is never read, so advancing its phase is pure
        // cost. 62 to 65 of the game's 68 instruments leave all three at zero.
        if (lfo0) {
          this.lfo[0].advance(this.secondsPerFrame, lfos[0].rate * LFO_RATE_SCALE[0]);
          rate *= pitchFactor(this.lfo[0].value, lfos[0].depth);
        }
        if (lfo1) {
          this.lfo[1].advance(this.secondsPerFrame, lfos[1].rate * LFO_RATE_SCALE[1]);
          fade *= gainFactor(this.lfo[1].value, lfos[1].depth);
        }
        if (lfo2) {
          this.lfo[2].advance(this.secondsPerFrame, lfos[2].rate * LFO_RATE_SCALE[2]);
          const gains = panGainsInto(
            panFold(this.lfo[2].value, lfos[2].depth, this.spec.pan * 2),
            this.panScratch,
          );
          panLeft = gains.left * this.spec.gain;
          panRight = gains.right * this.spec.gain;
        }
      }

      // Filter, then amplitude: the ladder is inside the voice, ahead of the
      // gain and the pan.
      // A wide-open lowpass is skipped, not computed: the engine branches on
      // `cutoff > 0.99` at 0x2ee9 into a loop carrying none of the ladder's
      // constants. Running it anyway is not free -- this ladder passes a unit
      // impulse at 0.833 and rings -- and piano sits at exactly 1.0.
      if (filterFixed) {
        if (!fixedBypass) {
          l = this.ladderL.process(l, this.ladderScratch);
          r = mono ? l : this.ladderR.process(r, this.ladderScratch);
        }
      } else if (filter) {
        const level = this.filterEnv.advance(this.secondsPerFrame, held, filter.envelope);
        const { freq, res } = filterAtInto(
          filter.settings,
          level,
          playbackRate,
          this.filterScratch,
        );
        if (freq <= FILTER_BYPASS_CUTOFF) {
          const coefficients = ladderCoefficientsInto(freq, res, this.ladderScratch);
          l = this.ladderL.process(l, coefficients);
          r = mono ? l : this.ladderR.process(r, coefficients);
        }
      }

      outLeft[i] += l * panLeft * fade;
      outRight[i] += r * panRight * fade;

      this.position += rate;
      this.life -= 1;
      this.cut -= 1;
    }
    return { begin, end: i };
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
    const cut =
      spec.cutFrame === undefined ? Infinity : Math.max(0, spec.cutFrame - delay);
    this.voices.push(new Voice(spec, delay, life, cut, this.outputRate));
  }

  stopAll(): void {
    this.voices.length = 0;
  }

  /**
   * Render one block. `left` and `right` are cleared first, so callers get the
   * mix rather than an accumulation across blocks.
   *
   * `onVoice` is called after each voice is mixed in. It exists because an
   * offline render of a whole song is one call that runs for many seconds, and
   * a progress bar that only tracks the phases *around* it is worse than none:
   * it fills, then freezes for most of the wait. The callback must be cheap and
   * synchronous -- a worker's `postMessage` is, and reaches the main thread
   * without this loop yielding.
   */
  render(
    left: Float32Array,
    right: Float32Array,
    sends?: {
      readonly echo?: readonly [Float32Array, Float32Array];
      readonly reverb?: readonly [Float32Array, Float32Array];
    },
    onVoice?: (done: number, total: number) => void,
  ): void {
    const frames = Math.min(left.length, right.length);
    left.fill(0);
    right.fill(0);
    sends?.echo?.[0].fill(0);
    sends?.echo?.[1].fill(0);
    sends?.reverb?.[0].fill(0);
    sends?.reverb?.[1].fill(0);

    // A send bus is the same render scaled: rather than render a voice twice,
    // each voice writes into a scratch pair and that is added to dry and to
    // each bus at its own level. The scratch is per render, not per voice.
    const needsSends =
      sends !== undefined &&
      this.voices.some((v) => (v.spec.echoSend ?? 0) > 0 || (v.spec.reverbSend ?? 0) > 0);
    const scratchL = needsSends ? new Float32Array(frames) : left;
    const scratchR = needsSends ? new Float32Array(frames) : right;

    const total = this.voices.length;
    let done = 0;
    for (const voice of this.voices) {
      if (onVoice && (done & 0xff) === 0) onVoice(done, total);
      done += 1;
      const echo = voice.spec.echoSend ?? 0;
      const reverb = voice.spec.reverbSend ?? 0;
      if (!needsSends || (echo === 0 && reverb === 0)) {
        voice.render(left, right, frames, this.interpolate, this.engineSampler);
        continue;
      }
      // The scratch is left clean by whoever used it last, so only the span
      // this voice writes needs clearing -- and only that span needs summing.
      const span = voice.render(scratchL, scratchR, frames, this.interpolate, this.engineSampler);
      for (let i = span.begin; i < span.end; i += 1) {
        const l = scratchL[i];
        const r = scratchR[i];
        left[i] += l;
        right[i] += r;
        if (echo > 0 && sends?.echo) {
          sends.echo[0][i] += l * echo;
          sends.echo[1][i] += r * echo;
        }
        if (reverb > 0 && sends?.reverb) {
          sends.reverb[0][i] += l * reverb;
          sends.reverb[1][i] += r * reverb;
        }
      }
      scratchL.fill(0, span.begin, span.end);
      scratchR.fill(0, span.begin, span.end);
    }
    onVoice?.(total, total);
    // A voice that ran out mid-block has already written what it had.
    this.voices = this.voices.filter((v) => !v.finished);
  }
}
