/**
 * The instrument's three LFOs — `Params[15..23]`.
 *
 * Recovered from the renderer's per-layer loop in `fmodextinput.prx`; see
 * steering/sequencer-data-model.md for the trace and for which parts are
 * measured. Each LFO is a (rate, depth, layer spread) triple, and the three
 * have fixed destinations:
 *
 * | LFO | params | rate scale | goes to |
 * |---|---|---|---|
 * | 1 | 15, 16, 17 | ×100 | the **playback rate** — vibrato |
 * | 2 | 18, 19, 20 | ×100 | the **gain** — tremolo |
 * | 3 | 21, 22, 23 | ×50 | **pan** |
 *
 * The oscillator is libc's sine/cosine (`ZtjspkJQ+vw`, stub `0x130`), always
 * called with selector 0. Which of its two branches is the sine was not pinned,
 * and it does not matter: **the phases are randomised in `[0, 2π)` at note
 * start**, so sine versus cosine is a constant offset on an already-random
 * phase. That randomisation is not a detail either -- it is why two notes of
 * the same instrument never modulate in lockstep.
 */

/** One LFO's settings, already evaluated for a note's modulation. */
export interface LfoSettings {
  /** `Params[15|18|21]`, evaluated. Multiplied by the scale below. */
  readonly rate: number;
  /** `Params[16|19|22]`, evaluated. **Zero switches the LFO off.** */
  readonly depth: number;
  /**
   * `Params[17|20|23]`, evaluated. Fans a stacked voice's layers around the
   * cycle; with one layer it does nothing.
   */
  readonly spread: number;
}

/** The engine's per-LFO rate scale: ×100, ×100, ×50. */
export const LFO_RATE_SCALE = [100, 100, 50] as const;

/**
 * A phase accumulator.
 *
 * `random` is injected so a render can be made deterministic; the engine uses
 * `rand()` scaled by `2^-30`, which is uniform on `[0, 1]`.
 */
export class Lfo {
  private phase: number;

  /**
   * @param offset radians added to the randomised start phase. This is how a
   *   stacked voice fans its layers around the cycle: `Params[17|20|23]` times
   *   `2 * PI / Numstack` per layer.
   */
  constructor(random: () => number = Math.random, offset = 0) {
    this.phase = random() * 2 * Math.PI + offset;
  }

  /** Advance by `dt` seconds at `rate`, already scaled. */
  advance(dt: number, scaledRate: number): void {
    this.phase += dt * scaledRate;
    // Keep the accumulator bounded; the engine lets it grow, but a float that
    // has run for an hour loses the precision this does not.
    const twoPi = 2 * Math.PI;
    if (this.phase >= twoPi || this.phase <= -twoPi) this.phase %= twoPi;
  }

  /** The oscillator's current value, −1..1. */
  get value(): number {
    return Math.sin(this.phase);
  }

  /** The phase, for the pan fold which needs it rather than the sine. */
  get radians(): number {
    return this.phase;
  }

  reset(random: () => number = Math.random): void {
    this.phase = random() * 2 * Math.PI;
  }
}

/**
 * LFO 1: a multiplier on the playback rate.
 *
 * ```
 * rate = pitchRatio * (detune + 0.05 * depth * osc)
 * ```
 *
 * `detune` is `Params[0]`'s per-layer value and is `1` when a voice does not
 * stack -- the same `0.05` scale carries both, which is what identified this
 * target. At full depth the swing is ±5% of the rate, a little under a
 * semitone.
 *
 * ✔ **The 0.05 is measured on this LFO's own path**, not borrowed from the
 * detune: `fmodextinput.prx` `0x2788` and `0x281a` both multiply `Params[16]` --
 * interpolated by the modulation -- by `0.05` before use. It is the same
 * constant the stack detune applies at `0x1b59`, which is what made "pitch" the
 * reading in the first place and now makes it the measurement.
 */
export function pitchFactor(osc: number, depth: number, detune = 1): number {
  return detune + 0.05 * depth * osc;
}

/**
 * LFO 2: a multiplier on the gain. Depth 0 leaves it at exactly 1.
 *
 * ✔ **Measured**, `0x255c`-`0x2574`: the oscillator is multiplied by the
 * interpolated `Params[19]`, **1 is added**, and the result multiplies a level.
 * `1 + depth * osc` is the instruction sequence, not a shape chosen to be tidy.
 */
export function gainFactor(osc: number, depth: number): number {
  return 1 + depth * osc;
}

/**
 * LFO 3: pan, `0..1`.
 *
 * ⚠️ **Not the sine folded — the sine's contribution added to a base and the
 * whole thing folded**, which is why this takes the raw value rather than a
 * factor. The fold makes a triangle: it rises to 1, turns, and comes back,
 * where a raw sine would sit still at the extremes.
 *
 * ✔ **The fold is measured instruction for instruction**, `0x26cb`-`0x2713`:
 *
 * ```
 * 0x26cb  s = sin * depth
 * 0x26db  s = base + s
 * 0x26df  s = |s|                  ; vandps against the sign mask
 * 0x26e7  s = s * 0.5
 * 0x26ef  f = floor(s)             ; vroundss, mode 1
 * 0x26f5  t = s - f
 * 0x26f9  t = t + t
 * 0x26fd  if (t > 1) t = 2 - t     ; the triangle
 * ```
 *
 * which is this function, line for line.
 *
 * ⚠️ **What stays a reading is only the destination.** The fold's `t` is
 * broadcast to four lanes at `0x272b` and written through a pointer, in the same
 * shape the gain LFO uses at `0x2578`-`0x25a5`; the last hop into the two
 * per-channel factors was not read end to end. Pan is the reading because `t` is
 * in `0..1` and `panGains` — which *is* measured — is the only consumer of a
 * `0..1` in this voice.
 */
export function panFold(osc: number, depth: number, base = 0): number {
  const v = Math.abs(osc * depth + base) * 0.5;
  const t = (v - Math.floor(v)) * 2;
  return t > 1 ? 2 - t : t;
}
