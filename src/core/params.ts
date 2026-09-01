/**
 * The complete `RInstrument.Params` map — all 27, named.
 *
 * Every one is a **(lo, hi) pair**, and a note picks a point inside it with the
 * 4-bit modulation field of its own note word (`bits 24..27 / 15`). Where
 * `x === y`, which is most of the corpus, the parameter is simply fixed.
 *
 * ```
 * value = P.x + mod * (P.y - P.x)
 * ```
 *
 * The block is three synth sections and an output stage, in order:
 *
 * | indices | section |
 * |---|---|
 * | 0..2 | the unison stack — `sub_0x1a50` |
 * | 3..6 | the Moog ladder low-pass — `sub_0x1c40` |
 * | 7..10 | envelope B, which sweeps that filter |
 * | 11..14 | envelope A, the amplitude ADSR |
 * | 15..23 | three LFOs, as (rate, depth, layer phase spread) triples |
 * | 24..26 | output level, send, drive |
 *
 * Naming them took three passes and the same method each time: read what the
 * renderer computes, then label the 68 shipped instruments by how they *behave*
 * and check which index separates the labels. See steering/open-questions.md for
 * why labelling by distribution instead cost four sessions.
 */

/** `Params[0..2]` — the unison stack. See `sub_0x1a50` in the PRX. */
export const STACK_PARAMS = {
  /** Per-layer detune: `1 + 0.05 · U(−r, +r)`, a ratio. */
  detune: 0,
  /** Per-layer spread: `0.5 · U(−r, +r)`, centred on zero. */
  spread: 1,
  /** Per-layer random start: `r · sampleLength · U(0, 1)` frames in. */
  startOffset: 2,
} as const;

/**
 * `Params[15..23]` — three LFOs, one triple each.
 *
 * The rate is a phase increment per block, scaled by **100** for LFOs 1 and 2
 * and by **50** for LFO 3; the phases live at voice record `+0x98`, `+0x9c` and
 * `+0xa0` and are randomised in `[0, 2π)` when the note starts, so two notes
 * never modulate identically.
 *
 * The depth is multiplied by the oscillator and the result used as `1 + depth ·
 * osc`, so **depth 0 is off** — which is what 62 to 65 of the 68 instruments
 * choose. The rate is set on nearly all of them regardless; it is the depth that
 * switches an LFO on, not the rate.
 *
 * The spread is `× 2π / Numstack`: it fans a stacked voice's layers around the
 * cycle, so five layers can each be at a different point of the same LFO. It is
 * zero on 63 or more instruments, which is right for something that only means
 * anything when a voice stacks.
 */
export const LFO_PARAMS = [
  { rate: 15, depth: 16, spread: 17, rateScale: 100 },
  { rate: 18, depth: 19, spread: 20, rateScale: 100 },
  { rate: 21, depth: 22, spread: 23, rateScale: 50 },
] as const;

/** `Params[24..26]` — the output stage. */
export const OUTPUT_PARAMS = {
  /**
   * Per-instrument level. **Never zero in the corpus and 61 distinct values
   * across 68 instruments** — every instrument trims itself, and no two agree.
   * It enters the gain chain alongside `sqrt(1 / Numstack)`, which is the
   * equal-power correction for stacking, and a factor of 2.
   */
  level: 24,
  /**
   * Send into the DSP's **second stereo pair**. The renderer accumulates each
   * voice into two output pairs, and this scales the one at voice `+0x1c`.
   * Zero on 33 of 68 and never above 0.23 — `space_piano`, `harp`,
   * `e_guitar_clean_muted`, `ukulele`, `glass_harmonica` send the most.
   */
  send: 25,
  /**
   * Drive into the filter. Zero on 64 of 68, and the four that use it are
   * `e_guitar_power` 0.73, `e_guitar_distorted` 0.57/0.70, `space_piano` 0.51
   * and `electric_harpsichord` 0.39 — plus two `baiyon` patches on the `.y`
   * end only.
   *
   * ⚠️ **"Drive" is read from that list and from where the value lands**, which
   * is a gain multiplied in ahead of the ladder. Pushing level into a filter
   * whose saturation is a cube *is* distortion, and the ladder's `[-1, +1]`
   * domain is why this parameter is clamped to `0..1`. The two guitars being
   * the top two users is the argument; there is no label in the game to check
   * it against.
   */
  drive: 26,
} as const;

/** One row per index, for display and for reading the block at a glance. */
export const PARAM_NAMES: readonly string[] = [
  'stack detune', // 0
  'stack spread', // 1
  'stack start offset', // 2
  'filter cutoff', // 3
  'filter resonance', // 4
  'filter key tracking', // 5
  'filter envelope amount', // 6
  'filter attack', // 7
  'filter decay', // 8
  'filter sustain', // 9
  'filter release', // 10
  'amp attack', // 11
  'amp decay', // 12
  'amp sustain', // 13
  'amp release', // 14
  'LFO 1 rate', // 15
  'LFO 1 depth', // 16
  'LFO 1 layer spread', // 17
  'LFO 2 rate', // 18
  'LFO 2 depth', // 19
  'LFO 2 layer spread', // 20
  'LFO 3 rate', // 21
  'LFO 3 depth', // 22
  'LFO 3 layer spread', // 23
  'output level', // 24
  'send', // 25
  'drive', // 26
];
