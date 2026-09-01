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
/**
 * The cutoff above which the engine does not run the ladder at all.
 *
 * `0x2ee9` compares the clamped cutoff against **0.99** and `0x2f17` branches on
 * it. The fall-through path is a self-contained loop at `0x2f40`-`0x2fdb` that
 * touches **none** of the ladder's constants -- no `0.8`, no `5.6`, no `1/6` --
 * so it is the unfiltered path, and it is the one taken when the cutoff is
 * above the threshold. A wide-open lowpass is skipped rather than computed.
 *
 * That the compared value is the cutoff is not inferred from the shape: `xmm9`
 * receives `freq` at `0x2a72` and is not written again before `0x2ae9` clamps it
 * into the slot the comparison reads.
 *
 * ⚠️ **This is not a micro-optimisation, it is audible.** This ladder at
 * `freq = 1` is not transparent: a unit impulse comes out at 0.833 and it still
 * rings after half a second. `keys/piano.rinst` has a cutoff of exactly 1.0 at
 * both ends of its range, so every one of its notes was being coloured by a
 * filter the engine never runs.
 */
export const FILTER_BYPASS_CUTOFF = 0.99;

export function ladderCoefficients(freq: number, res: number): LadderCoefficients {
  return ladderCoefficientsInto(freq, res, { p: 0, f: 0, q: 0 });
}

/** `ladderCoefficients` writing into a caller-owned object. Same arithmetic. */
export function ladderCoefficientsInto(
  freq: number,
  res: number,
  out: { p: number; f: number; q: number },
): LadderCoefficients {
  const t = 1 - freq;
  const p = freq + 0.8 * freq * t;
  out.p = p;
  out.f = p + p - 1;
  out.q = res * (1 + 0.5 * t * (1 - t + 5.6 * t * t));
  return out;
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
 * res  = clamp(resonance      * envFactor,     0, 1)
 * ```
 *
 * Read out of `fmodextinput.prx` at `0x2a02`-`0x2a90`. Every parameter arrives
 * through the same lerp-and-broadcast shape, `vsubss; vmulss xmm7; vaddss;
 * vpshufd 0`, which is `x + mod * (y - x)`:
 *
 * ```
 * 0x2a28   xmm4 = (1 - envAmount) + envB * envAmount      ; envFactor
 * 0x2a3f   xmm6 = cutoff * cutoff                         ; cutoff²
 * 0x2a6a   xmm1 = 1 + (pitchRatio - 1) * keyTrack         ; keytrack
 * 0x2a6e   xmm1 = cutoff² * keytrack
 * 0x2a72   xmm9 = envFactor * xmm1                        ; freq
 * 0x2a90   xmm1 = xmm4 * resonance                        ; res = envFactor * resonance
 * ```
 *
 * ⚠️ **`xmm4` is `envFactor`, not `keytrack`, and the two are indistinguishable
 * from the arithmetic alone** — both are `1 + (X - 1) * p`. A session read them
 * the wrong way round, concluded that the resonance takes the key tracking, and
 * swapped `Params[5]` and `[6]` to match. What settles it is the identity of
 * `X`: `[rbp-0xa90]` starts at 1.0 and is multiplied by a frequency ratio, so it
 * is the pitch; `[rbp-0xb70]` is the return of the envelope evaluator called at
 * `0x222d` with `Params[7..10]`, so it is envelope B. See `FILTER_PARAMS`.
 *
 * **The clamps are the engine's**, not ours as this said. `0x2ae9`-`0x2b32`
 * clamps all four block values -- the start and end of both the cutoff and the
 * resonance ramp -- with `vminps` against 1.0 and `vmaxps` against zero.
 */
export function filterAt(
  settings: FilterSettings,
  envelopeB: number,
  pitchRatio: number,
): { freq: number; res: number } {
  return filterAtInto(settings, envelopeB, pitchRatio, { freq: 0, res: 0 });
}

/**
 * `filterAt` writing into a caller-owned object instead of allocating one.
 *
 * The voice loop calls this once per frame per voice, and an object per call
 * there is a measurable share of the render: allocation plus the garbage it
 * makes. The arithmetic is identical -- this is the same function with the
 * result written rather than returned.
 */
export function filterAtInto(
  settings: FilterSettings,
  envelopeB: number,
  pitchRatio: number,
  out: { freq: number; res: number },
): { freq: number; res: number } {
  const keytrack = 1 + (pitchRatio - 1) * settings.keyTrack;
  const envFactor = 1 + settings.envAmount * (envelopeB - 1);
  const freq = settings.cutoff * settings.cutoff * keytrack * envFactor;
  const res = settings.resonance * envFactor;
  out.freq = freq < 0 ? 0 : freq > 1 ? 1 : freq;
  out.res = res < 0 ? 0 : res > 1 ? 1 : res;
  return out;
}

/** `Params` indices, so the mapping lives next to the code that uses it. */
/**
 * Which `Params` index is which filter control.
 *
 * `fmodextinput.prx` loads the four as consecutive `(x,y)` pairs from `rcx` at
 * `0x2985`-`0x29bd` and combines them at `0x2a02`-`0x2a90`. The array base is
 * pinned rather than assumed: the same function reads `[rcx+0x540..0x55c]` as
 * the amplitude ADSR (`Params[11..14]`), `[rcx+0x560..0x5a4]` as the LFO
 * triples and `[rcx+0x5a8]` as the output level, which puts `Params[0]` at
 * `rcx+0x4e8` and `Params[3]` at `rcx+0x500`.
 *
 * ⚠️ **The key-tracking and envelope terms are the same shape**, `1 + (X - 1)*p`,
 * so the indices cannot be told apart from the arithmetic — only from what `X`
 * is. This was got wrong once by guessing:
 *
 * - `[rbp-0xa90]` is the **pitch ratio**. It is set to `1.0` at `0x1e25` and
 *   multiplied at `0x1e4a` by `[rbp-0x9d0] / [rcx+rbx+0x88]`, a frequency over
 *   the slot's own base frequency. It pairs with `Params[5]`, so
 *   **`Params[5]` is the key tracking**.
 * - `[rbp-0xb70]` is **envelope B**. `0x21ef`-`0x220d` interpolate
 *   `Params[7..10]` — the filter ADSR — and `0x222d` calls the envelope
 *   evaluator with them, storing its result there. It pairs with `Params[6]`,
 *   so **`Params[6]` is the envelope amount**.
 *
 * Everything downstream follows from those two, including which of the two
 * factors reaches the resonance at `0x2a90`.
 */
export const FILTER_PARAMS = {
  cutoff: 3,
  resonance: 4,
  keyTrack: 5,
  envAmount: 6,
} as const;
