/**
 * The sequencer's filter: a 4-pole Moog ladder low-pass.
 *
 * Reproduced from `0x3070`-`0x3259` in `fmodextinput.prx`, which is the
 * Stilson/Smith approximation published on musicdsp.org as "Moog VCF,
 * variation 1" -- constant for constant, including the `5.6` in the resonance
 * compensation and the `b4 - b4³/6` cubic saturation. See
 * steering/sequencer-data-model.md.
 *
 * This is what `Params[3..10]` are for, and what the ten floats at voice record
 * `+0xa4` … `+0xc8` were: two ladders of five states each, one per channel.
 *
 * ⚠️ **The saturation makes this non-linear, so it is not a filter you can swap
 * for "a low-pass".** Driving it hard is part of the sound of every synth patch
 * the game ships. Keep the cube.
 *
 * ⚠️ **Its input domain is `[-1, +1]`, and past about ±1.4 it runs away to
 * NaN.** That is a property of the approximation, not a bug in the
 * transcription -- the reference documents the same domain and the engine
 * carries the same cube. A voice's samples are `int16 / 32768` and linear
 * interpolation cannot exceed its inputs, so they never leave the domain; the
 * boundary is pinned in test/moog.test.ts so that stays true deliberately
 * rather than by luck. Do not add a clamp the engine does not have.
 */

/** The two coefficients the ladder actually runs on. */
export interface LadderCoefficients {
  /** `p` in the reference: the per-stage gain. */
  readonly p: number;
  /** `f` in the reference: the per-stage feedback. */
  readonly f: number;
  /** The resonance feedback around all four stages. */
  readonly q: number;
}

/**
 * Coefficients for a normalised cutoff and resonance, both `0..1`.
 *
 * `freq` is **not** a frequency in Hz. It is the engine's normalised value, and
 * the engine never converts it to one -- the cutoff is whatever this
 * approximation gives at that number and at the output sample rate, which is
 * part of why the filter has to be reproduced rather than substituted.
 */
export function ladderCoefficients(freq: number, res: number): LadderCoefficients {
  const t = 1 - freq;
  const p = freq + 0.8 * freq * t;
  return {
    p,
    f: p + p - 1,
    q: res * (1 + 0.5 * t * (1 - t + 5.6 * t * t)),
  };
}

/**
 * One ladder. Five states, `b0` being the previous input.
 *
 * Coefficients are passed per sample rather than held, because the engine ramps
 * them across a block whenever they change (its `0x332b` path) -- holding them
 * would quantise a filter sweep to the block size, which is audible on exactly
 * the patches that sweep.
 */
export class MoogLadder {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;

  process(input: number, coefficients: LadderCoefficients): number {
    const { p, f, q } = coefficients;
    const x = input - q * this.b4;

    const t1 = this.b1;
    this.b1 = (x + this.b0) * p - this.b1 * f;
    const t2 = this.b2;
    this.b2 = (this.b1 + t1) * p - this.b2 * f;
    const t3 = this.b3;
    this.b3 = (this.b2 + t2) * p - this.b3 * f;
    this.b4 = (this.b3 + t3) * p - this.b4 * f;

    // The saturation. Without it the ladder blows up at high resonance instead
    // of settling into self-oscillation.
    this.b4 -= (this.b4 * this.b4 * this.b4) / 6;
    this.b0 = x;
    return this.b4;
  }

  reset(): void {
    this.b0 = 0;
    this.b1 = 0;
    this.b2 = 0;
    this.b3 = 0;
    this.b4 = 0;
  }
}

/** The instrument's filter settings, before the envelope and the note modulate them. */
export interface FilterSettings {
  /** `Params[3]`, 0..1. **Squared** on the way to the cutoff. */
  readonly cutoff: number;
  /** `Params[4]`, 0..1. Zero in 60 of the game's 68 instruments. */
  readonly resonance: number;
  /** `Params[5]`, 0..1: how far the cutoff follows the note. */
  readonly keyTrack: number;
  /** `Params[6]`, 0..1: how far envelope B moves the cutoff. */
  readonly envAmount: number;
}

/**
 * Cutoff and resonance for one sample, given the filter envelope's current
 * level and the voice's playback rate.
 *
 * ```
 * keytrack  = 1 + (pitchRatio - 1) * keyTrack
 * envFactor = 1 + envAmount * (envelopeB - 1)
 * freq = clamp(cutoff² * keytrack * envFactor, 0, 1)
 * res  = clamp(resonance      * keytrack,         0, 1)
 * ```
 *
 * **Both lines are now read out of `fmodextinput.prx`**, in the block at
 * `0x2a02`-`0x2a90`. Every parameter arrives through the same shape --
 * `vsubss; vmulss xmm7; vaddss; vpshufd 0` is `x + mod * (y - x)` broadcast to
 * four lanes -- which makes the arithmetic between them readable:
 *
 * ```
 * 0x2a28   xmm4 = (1 - keyTrack) + pitchRatio * keyTrack   ; keytrack
 * 0x2a3f   xmm6 = cutoff * cutoff                          ; cutoff²
 * 0x2a6a   xmm1 = 1 + envAmount * (envB - 1)               ; envFactor
 * 0x2a6e   xmm1 = cutoff² * envFactor
 * 0x2a72   xmm9 = keytrack * xmm1                          ; freq
 * 0x2a90   xmm1 = xmm4 * resonance                         ; res
 * ```
 *
 * ⚠️ **The resonance takes the key tracking, not the envelope.** This file
 * said `resonance * envFactor` and flagged it as the least certain line
 * recovered; it was wrong. The two are not interchangeable on a patch whose
 * envelopes disagree: `synth/ghost.rinst` has an amplitude decay of 0.85 s
 * against a filter attack of 1.04 s, so envelope B never gets past 0.194 and
 * `envFactor` stays in 0.37-0.49 for the whole audible life of the note. Its
 * authored resonance of 0.90 arrived at the ladder as 0.33; with the key
 * tracking it arrives as 0.50, and the ladder's `q` goes from 0.90 to 1.36.
 *
 * ⚠️ The clamps are ours. Nothing in that block bounds either value, but the
 * ladder diverges for `freq > 1`.
 */
export function filterAt(
  settings: FilterSettings,
  envelopeB: number,
  pitchRatio: number,
): { freq: number; res: number } {
  const keytrack = 1 + (pitchRatio - 1) * settings.keyTrack;
  const envFactor = 1 + settings.envAmount * (envelopeB - 1);
  const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  return {
    freq: clamp(settings.cutoff * settings.cutoff * keytrack * envFactor),
    res: clamp(settings.resonance * keytrack),
  };
}

/** `Params` indices, so the mapping lives next to the code that uses it. */
export const FILTER_PARAMS = {
  cutoff: 3,
  resonance: 4,
  keyTrack: 5,
  envAmount: 6,
} as const;
