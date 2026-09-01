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
 * Equal-power pan, 0..1 with 0.5 centred.
 *
 * ⚠️ UNMEASURED. FMOD's own 2D pan law is open question 7; equal-power is the
 * conventional choice and is at least continuous and centre-correct. One
 * measurement replaces this and fixes the stereo image across the whole
 * project, so it is worth doing before any serious listening test.
 */
export function panGains(pan: number): { left: number; right: number } {
  const p = Math.max(0, Math.min(1, pan));
  const angle = p * (Math.PI / 2);
  return { left: Math.cos(angle), right: Math.sin(angle) };
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
