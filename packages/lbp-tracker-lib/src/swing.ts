/**
 * Swing, and the step clock it bends.
 *
 * ## The step length
 *
 * `fmodextinput.prx` `0x0bf7` divides **720000** by the tempo to get the length
 * of one step. At the engine's default tempo of 125 that is 5,760, and
 * `48000 * 60 / (125 * 4)` is 5,760 too -- so the constant is
 * `48000 * 60 * 4 / 60`... more usefully, it confirms **four steps to the beat**
 * at a 48 kHz output, which the rest of this project had assumed.
 *
 * ## What swing does
 *
 * `0x0be3`-`0x0c2e`, with `[state+0x1a2c]` holding the sequencer's `Swing`
 * (clamped to 0.99 on the way in at `v0x1c5d0c`) and `[state+0x1a4c]` the
 * running step position:
 *
 * ```
 * xmm1 = 720000 / tempo             ; the step's nominal length
 * xmm3 = xmm1 * swing * 0.5
 * eax  = (int)floor(position) & 1   ; which half of the pair
 * xmm3 = xmm3 * table[eax]          ; v0x44f0 = [1, -1]
 * xmm1 = xmm1 + xmm3                ; this step's actual length
 * ```
 *
 * So an **even** step is stretched to `L * (1 + swing/2)` and the **odd** step
 * after it is squeezed to `L * (1 - swing/2)`. The pair still lasts `2L`, so
 * swing never drifts against the bar -- it only moves the off-beat later.
 *
 * At `swing = 1` the ratio is 3:1, a hard shuffle; the field is clamped just
 * below 1 rather than at it.
 */

/** `720000 / tempo` is the engine's step length, and this is where 720000 is. */
export const ENGINE_STEP_CONSTANT = 720000;

/** Steps to the beat, confirmed by `720000 / 125 = 48000 * 60 / (125 * 4)`. */
export const STEPS_PER_BEAT = 4;

/**
 * The length of one step, in output frames, with swing applied.
 *
 * @param step which step -- only its parity matters
 * @param nominal the unswung step length
 * @param swing 0..1
 */
export function stepLength(step: number, nominal: number, swing: number): number {
  const sign = step % 2 === 0 ? 1 : -1;
  return nominal + nominal * swing * 0.5 * sign;
}

/**
 * Convert a step position -- possibly fractional, since triplets sit on thirds
 * -- into an output frame.
 *
 * Whole steps accumulate in pairs that each last `2 * nominal`, so the start of
 * an even step is exactly `step * nominal` and an odd one begins half a swing
 * unit later. A fraction within a step scales by *that* step's own length,
 * which is what makes a triplet inside a stretched step stretch with it.
 */
export function swungFrame(position: number, nominal: number, swing: number): number {
  if (swing === 0) return position * nominal;
  const step = Math.floor(position);
  const frac = position - step;
  const pairStart = step * nominal;
  // An odd step starts after its stretched partner, so it begins late by the
  // amount that partner gained.
  const start = step % 2 === 0 ? pairStart : pairStart + nominal * swing * 0.5;
  return start + frac * stepLength(step, nominal, swing);
}
