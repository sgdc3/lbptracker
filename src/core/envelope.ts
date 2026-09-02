/**
 * The instrument's ADSR -- `Params[11..14]`, reproduced from `sub_0x1690` in
 * `fmodextinput.prx`.
 *
 * This is the envelope the project went four sessions without: until it was
 * found, `Mixer` faked a note's shape with a linear release and an optional
 * exponential decay, both marked as ours rather than the game's. Both are
 * superseded by this. See steering/sequencer-data-model.md for the evidence,
 * which is the disassembly plus two independent checks against the 68
 * instruments the game ships.
 *
 * Two things about it are worth knowing before reading the code:
 *
 * - **The stages are linear in level, not exponential.** A piano modelled this
 *   way decays along a straight line, not a curve. That is what the engine
 *   does; it is not a simplification made here.
 * - **The stage time is the parameter squared**, which is how a 0..1 knob turns
 *   into a usable range of times.
 */

import type { InstrumentParam } from './rinstrument.ts';

/** One evaluated envelope. Times are in seconds; `sustain` is a level, 0..1. */
export interface Adsr {
  readonly attack: number;
  readonly decay: number;
  readonly sustain: number;
  readonly release: number;
}

/**
 * `Params` indices for the amplitude envelope.
 *
 * Established three ways that agree: the four are loaded together at `0x1ed3`
 * and passed to `sub_0x1690` in this order; `Params[13]` separates struck from
 * sustained instruments at Cohen's d = -3.54, further than anything else in the
 * block; and its values are exactly 1.0 on `choir`, `brass` and `clarinet`,
 * exactly 0.0 on `glockenspiel`, `marimba` and `vibraphone`, and 0.070 on the
 * piano.
 */
export const ADSR_PARAMS = { attack: 11, decay: 12, sustain: 13, release: 14 } as const;

/**
 * A second envelope with the same shape, at `Params[7..10]`.
 *
 * ⚠️ **Its destination is not established.** Its results are broadcast into the
 * same SIMD path as `Params[3..6]`, so a filter envelope is the obvious
 * reading, and a reading is all it is.
 */
export const ADSR_PARAMS_B = { attack: 7, decay: 8, sustain: 9, release: 10 } as const;

/**
 * Seconds per unit of the engine's envelope clock.
 *
 * ⚠️ **Derived, not measured.** The renderer passes `frames * 5.20833e-06` as
 * `dt`, and `5.20833e-06` is `1/192000` = `1/(4 x 48000)`, so one unit is four
 * seconds at the 48 kHz the samples are recorded at. Everything this produces
 * is musically sensible -- a piano decay of `0.527^2 x 4` = 1.11 s, a choir
 * attack of `0.013^2 x 4` = 0.68 ms, a `strings_ensemble` swell up to 0.95 s --
 * which is support, not proof. The other `dt` constant in the same code
 * (`1/48,000,000`, 250x smaller) is read here as sampling the current level
 * rather than advancing it; if that reading is wrong, this constant is wrong
 * with it. Check both against a recording before trusting stage times to the
 * millisecond.
 */
export const ENVELOPE_SECONDS_PER_UNIT = 4;

/**
 * A `Params` pair is a **range**, and the note picks a point inside it.
 *
 * `mod` comes from bits 24..27 of the note word divided by 15, so it has
 * sixteen positions. Where `x === y` -- most instruments, most params -- the
 * parameter is fixed and `mod` does nothing.
 *
 * ✔ **`x + mod*(y - x)`, and the direction is measured on every one of the 27
 * parameters, not inferred from one.** `fmodextinput.prx` loads `.x` then `.y`
 * and subtracts `y - x` at 27 distinct sites; the four filter parameters load
 * into xmm8..xmm14 first and combine later, at `0x29c2`, `0x29ec`, `0x2a03` and
 * `0x2a36`, which is why a scan for "the `vsubss` right after the `.y` load"
 * finds only 23. Getting the direction backwards would invert every range in the
 * game at once, silently, on the 19% of notes that carry a modulation.
 */
export function evaluateParam(param: InstrumentParam, mod: number): number {
  return param.x + mod * (param.y - param.x);
}

/** Evaluate one of the two envelopes for a note whose modulation is `mod`. */
export function evaluateAdsr(
  params: readonly InstrumentParam[],
  indices: typeof ADSR_PARAMS | typeof ADSR_PARAMS_B,
  mod: number,
): Adsr {
  const at = (i: number) =>
    evaluateParam(params[i] ?? { x: 0, y: 0 }, mod) ** 2 * ENVELOPE_SECONDS_PER_UNIT;
  return {
    attack: at(indices.attack),
    decay: at(indices.decay),
    // The sustain is a LEVEL, so it is not squared and not a time.
    sustain: evaluateParam(params[indices.sustain] ?? { x: 0, y: 0 }, mod),
    release: at(indices.release),
  };
}

/**
 * The engine's envelope generator, state and all.
 *
 * The stored value is **mirrored around 1**, exactly as the engine stores it:
 * `0..1` is the attack running upward, and `1..2` is the decay running upward
 * while the level it represents runs *down*. Keeping that representation rather
 * than a tidier one is deliberate -- the handover from attack to decay depends
 * on it, and a rewrite into an explicit stage enum was where a subtle
 * difference would hide.
 */
export class Envelope {
  private stored = 0;
  private done = false;

  /** The audible level, 0..1. */
  get level(): number {
    return this.stored > 1 ? 2 - this.stored : this.stored;
  }

  /** True once a released envelope has reached zero; the voice can be freed. */
  get finished(): boolean {
    return this.done;
  }

  /**
   * Advance by `dt` seconds and return the new level.
   *
   * `gate` is the note still being held -- in the engine, `voice[+0x10] == 0`,
   * the flag the sequencer sets when the note's chain of records ends.
   */
  advance(dt: number, gate: boolean, adsr: Adsr): number {
    if (!gate) {
      // Release: the audible level falls, and hitting zero ends the voice.
      if (adsr.release <= 0) {
        this.stored = 0;
        this.done = true;
        return 0;
      }
      const next = this.level - dt / adsr.release;
      if (next < 0) {
        this.stored = 0;
        this.done = true;
        return 0;
      }
      this.stored = next;
      return next;
    }

    let remaining = dt;
    if (this.stored <= 1) {
      // Attack. `need` is the time still required to reach full level.
      const need = adsr.attack * (1 - this.stored);
      if (adsr.attack > 0 && need > remaining) {
        this.stored += remaining / adsr.attack;
        return this.level;
      }
      // The attack completes inside this step; the leftover drives the decay.
      // An attack of zero from a standing start jumps straight to full.
      if (need > 0) remaining -= need;
      this.stored = 1;
    }

    // Decay, running toward the sustain level.
    const floor = 2 - adsr.sustain;
    if (adsr.decay <= 0) {
      this.stored = floor;
    } else {
      this.stored = Math.min(floor, this.stored + remaining / adsr.decay);
    }
    return this.level;
  }

  /** Restart the envelope for a new note. */
  reset(): void {
    this.stored = 0;
    this.done = false;
  }
}
