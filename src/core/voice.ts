/**
 * Note -> playback parameters.
 *
 * The pitch formula is the one in steering/sequencer-data-model.md, which
 * follows directly from the recovered field names and from the way the shipped
 * banks are laid out (one sample per octave: piano_C2..C6, epiano_C1..C5,
 * triangle_synth_C2..C6).
 *
 * Two constants in here are NOT measured and are marked as such. Keep them in
 * this one file so that closing the open questions is a small edit rather than
 * a hunt.
 */

import type { Instrument, SampleSlot } from './instrument.ts';
import { resolveSlot } from './instrument.ts';

/**
 * **MEASURED: `fineTune` is in semitones.** `sub_0x1c40` in `fmodextinput.prx`
 * adds the slot's f32 straight into the semitone sum, alongside the note and
 * the root note, before the single division by 12:
 *
 * ```
 * xmm1  = t * voice.pitchSlide + voice.pitch    // semitones
 * xmm1 += [slot + 0x8c]                         // fineTune  <- same units
 * xmm1 -= (float)[slot + 0x84]                  // rootNote
 * exp2f(xmm1 * 0.0833333)                       // 1/12
 * ```
 *
 * It was 100 (cents) on a coin-flip; open question 5 is closed.
 */
export const FINETUNE_PER_SEMITONE = 1;

/** ⚠️ UNMEASURED. See open question 3 -- inferred from clip lengths, not the engine. */
export const STEPS_PER_BEAT = 4;

export interface VoiceParams {
  /** Index into the instrument's slots. */
  readonly slot: number;
  /**
   * Sample frames to advance per output frame. 1 means the sample plays at its
   * own rate; 2 means an octave up.
   */
  readonly playbackRate: number;
  /** Linear gain, 0..1. */
  readonly gain: number;
  /** 0 = hard left, 0.5 = centre, 1 = hard right. */
  readonly pan: number;
}

export interface VoiceRequest {
  readonly note: number;
  /** Note record volume, 0..127. */
  readonly volume: number;
  readonly instrument: Instrument;
  /** Per-instrument gain, `PInstrument.Level`. */
  readonly level: number;
  /** `PInstrument.Pan`, 0..1 centred at 0.5. */
  readonly pan: number;
  /** The sample's own rate, from the FSB header. */
  readonly sampleRate: number;
  /** The output device's rate. */
  readonly outputRate: number;
  /** `PSequencer.Tempo`, only used when the slot has `fitBpm`. */
  readonly tempo: number;
}

/**
 * The pitch ratio for one note on one slot, before the sample-rate conversion.
 *
 * ```
 * ratio = 2 ^ ((note - baseNote + fineTune) / 12)
 * if !pitched: ratio = 1            // percussion plays at a fixed rate
 * if fitBpm:   ratio *= tempo / baseBpm
 * ```
 *
 * **This shape is confirmed against the engine**, not inferred: the branch
 * structure, the order of the terms and the `tempo / baseBpm` factor all match
 * `sub_0x1c40` in `fmodextinput.prx` exactly. See
 * steering/sequencer-data-model.md.
 */
export function pitchRatio(
  slot: SampleSlot,
  note: number,
  tempo: number,
): number {
  let ratio = 1;
  if (slot.pitched) {
    const semitones =
      note - slot.baseNote + slot.fineTune / FINETUNE_PER_SEMITONE;
    ratio = 2 ** (semitones / 12);
  }
  if (slot.fitBpm && slot.baseBpm > 0) {
    ratio *= tempo / slot.baseBpm;
  }
  return ratio;
}

/**
 * Note velocity to linear gain.
 *
 * ⚠️ UNMEASURED curve. The record's `volume` is 0..127 with a default of 0x60
 * (96). Linear in amplitude is assumed here; the game may well apply a curve.
 * Kept as one function so a measurement replaces it in one place.
 */
export function velocityGain(volume: number): number {
  return Math.max(0, Math.min(127, volume)) / 127;
}

/** Everything a voice needs to start playing one note. */
export function voiceFor(request: VoiceRequest): VoiceParams {
  const slot = resolveSlot(request.instrument, request.note);
  const definition = request.instrument.slots[slot];
  const ratio = pitchRatio(definition, request.note, request.tempo);
  return {
    slot,
    playbackRate: ratio * (request.sampleRate / request.outputRate),
    gain: velocityGain(request.volume) * request.level,
    pan: request.pan,
  };
}

/**
 * **MEASURED: the pan law is linear.** `left = 1 - pan`, `right = pan`, 0..1
 * with 0.5 centred.
 *
 * Read straight off the renderer at `0x2d39`-`0x2dda` in `fmodextinput.prx`,
 * where the voice's pan value `p` becomes the two per-channel factors:
 *
 * ```
 * xmm3  = 1 - p        ; left
 * xmm10 = p            ; right
 * ...
 * L += (1 - p) * gain * sample
 * R +=      p  * gain * sample
 * ```
 *
 * ⚠️ **This was equal-power here for most of the project's life, and that was
 * wrong.** A linear law is about 3 dB quieter at the centre than an equal-power
 * one and its perceived loudness dips as a sound crosses the middle -- audible
 * on anything panned, and on everything once auto-pan (LFO 3) is running.
 * Equal-power is the better-sounding choice and it is not the game's, so it
 * does not belong in a faithful tracker.
 */
export function panGains(pan: number): { left: number; right: number } {
  return panGainsInto(pan, { left: 0, right: 0 });
}

/**
 * The gain that comes with narrowing a pan to `width` — **the other half of the
 * same operator**.
 *
 * ❗ **Narrowing a pan is not a rotation, it is a fold, and a fold has a gain.**
 * The game's stereo is a 7.1 bus folded down: FMOD's matrix puts `k·(ch0+ch1)`
 * in the centre with `k = 0.5` (`v0xa2599f`) and BS.775's downmix adds the
 * centre to both sides at `d = 1/sqrt2`, so
 *
 * ```
 *   L = ch0 + k·d·(ch0 + ch1)          the difference shrinks by 1/(1 + 2·k·d)
 *   R = ch1 + k·d·(ch0 + ch1)          and the SUM grows by  (1 + 2·k·d)
 * ```
 *
 * `PAN_WIDTH` is `1/(1 + 2·k·d) = 2 - sqrt2`, so the sum's gain is exactly its
 * reciprocal. Applying `pan' = 0.5 + (p - 0.5)·W` and `gain × 1/W` reproduces
 * the fold at every pan **exactly** — the ratio `ours/engine` is a flat `W` at
 * pan 0, 0.25, 0.5, 0.75 and 1 without it, which is the arithmetic below.
 *
 * ⚠️ **This project applied the narrowing and not the gain for two days**, so
 * everything it rendered was a uniform **−4.645 dB** under the game's own fold.
 * It did not show in a WAV, because `dev/render-level.ts` normalises; it showed
 * on the live page, which does not. A listener reported it as "the whole
 * sequencer is quiet", and that is what a half-applied linear operator sounds
 * like.
 *
 * A `width` of 1 is the fold switched off and returns 1, so `LBP_PAN_WIDTH=1`
 * still renders the file's own pans at the file's own level.
 */
export function foldGain(width: number): number {
  // A width of 0 is not a fold anyone can build -- it needs an infinite centre
  // feed -- and the live page's slider can ask for it. Leave the gain alone.
  return width > 0 ? 1 / width : 1;
}

/** `panGains` writing into a caller-owned object. Same arithmetic. */
export function panGainsInto(
  pan: number,
  out: { left: number; right: number },
): { left: number; right: number } {
  const p = pan < 0 ? 0 : pan > 1 ? 1 : pan;
  out.left = 1 - p;
  out.right = p;
  return out;
}

/** Output frames per sequencer step. */
export function samplesPerStep(
  outputRate: number,
  tempo: number,
  stepsPerBeat = STEPS_PER_BEAT,
): number {
  if (tempo <= 0) throw new RangeError(`tempo must be > 0, got ${tempo}`);
  return (outputRate * 60) / (tempo * stepsPerBeat);
}
