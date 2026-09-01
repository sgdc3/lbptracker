/**
 * The sampler patch: 8 sample slots and the key splits between them.
 *
 * Field names, offsets and stream order come from the game's own serialisers,
 * and the split and stacking semantics from all 68 instruments the game ships
 * -- see steering/sequencer-data-model.md. What is NOT yet settled is flagged
 * inline and tracked in steering/open-questions.md; nothing here silently
 * invents a rule.
 */

export const MAX_SLOTS = 8;
export const MAX_SPLITS = 9; // 8 zones; [0] is a constant, [1..8] are the bounds
export const MAX_PARAMS = 27;
export const MAX_ARPEGGIO = 32;

/** One of the 8 sample slots. 16 bytes in the game's memory. */
export interface SampleSlot {
  /** The note the sample was recorded at. */
  readonly baseNote: number;
  /** The sample's own tempo, for loops. */
  readonly baseBpm: number;
  /**
   * Fine pitch offset.
   *
   * ⚠️ Units unconfirmed -- cents or semitones, both consistent with an f32.
   * `pitchRatio` assumes cents and says so. Open question 5.
   */
  readonly fineTune: number;
  /** Pitch-shift with the note, or play at a fixed rate (percussion). */
  readonly pitched: boolean;
  /** Rate-match the sample to the sequencer tempo. */
  readonly fitBpm: boolean;
}

export interface Instrument {
  readonly slots: readonly SampleSlot[];
  /**
   * Key-split bounds, **descending**, each belonging to the zone above it —
   * see `resolveSlot`. `splitNotes[0]` is 87 in every one of the game's 68
   * instruments and is never consulted; unused trailing entries are 0.
   */
  readonly splitNotes: readonly number[];
  /**
   * ⚠️ **Not the number of slots in use.** Measured across the game's 68
   * instruments: `numStack` equals the used-slot count in only 14 of them.
   * `electric_piano` uses one sample with `numStack` 2, `ghost` one with 3, and
   * most 8-slot drum kits have `numStack` 1. Use `sampleGuids[i] !== 0` to find
   * the slots that exist.
   *
   * It **is** an array length, just not of the slots: `sub_0x1a50` in
   * `fmodextinput.prx` loops `numStack` times filling one playback position,
   * one detune and one spread per layer, so a note plays that many overlapping
   * copies of the same slot. It runs to 5 in the corpus, and at five the three
   * arrays tile the voice record exactly. See steering/sequencer-data-model.md.
   */
  readonly numStack: number;
  readonly arpeggiate: boolean;
  readonly arpeggio: readonly number[];
}

export const DEFAULT_SLOT: SampleSlot = {
  baseNote: 48,
  baseBpm: 149.5,
  fineTune: 0,
  pitched: true,
  fitBpm: false,
};

/**
 * Which slot plays a given note.
 *
 * `Splitnotes` is a **descending list of bounds, each belonging to the zone
 * above it**: slot `i` covers `splitNotes[i+1] <= note < splitNotes[i]`, slot 0
 * takes everything at or above `splitNotes[1]`, and the last slot runs down to
 * 0. `splitNotes[0]` is 87 in every instrument and is never consulted — it is a
 * constant the editor writes, not a ceiling (creators play up to note 95).
 *
 * **Established against the game's own 68 instruments:**
 *
 * - **62 of 68 have exactly one non-zero split per used slot** — the fencepost
 *   the layout implies, and strong evidence the two lists are paired by index.
 * - **63 of 68 have every slot reachable** under this rule, and **73.5% of all
 *   slots resolve their own base note to themselves** (189 of 257) against
 *   56.8% for the `<=` variant. That gap is what settles the comparison.
 * - `baiyon_city_guildford` fits exactly: bounds `87, 73, 61, 49, 37, 25, 14,
 *   13` over bases `84, 72, 60, 48, 36, 24, 13, 12` puts every base note inside
 *   its own zone, eight for eight.
 *
 * ⚠️ **The boundary convention is NOT settled, and it is worth 22% of the
 * corpus.** `<` and `<=` place a note differently whenever it sits exactly on a
 * bound, and **215,449 of 968,829 corpus notes on multi-slot instruments do**,
 * across 47 of the 68 instruments. The synth PRX cannot settle it: it never
 * reads `Splitnotes` at all -- the only field it touches below the parameter
 * block is `+0x4e4`, `Numstack` -- so the selection is eboot-side and has not
 * been found. Two engine-independent checks were run and neither is decisive:
 * once the zone count is right, both conventions leave the same single
 * unreachable zone; and `<` reaches more distinct samples than `<=` on 5,657
 * corpus tracks against 3,900, a lean rather than a verdict. `<` stays because
 * it is what was here, not because it was proved.
 *
 * ⚠️ **Do not test this rule by asking whether a zone contains its own base
 * note.** That measures the sound designer, not the engine, and it cost a whole
 * session once. `piano` sets its bounds `87, 66, 54, 40, 30` against bases
 * `84, 72, 60, 48, 36` — every bound about six semitones below its slot's base
 * — so the piano is voiced to *always transpose downward*, which is the normal
 * sampler preference since pitching up thins a sample out. `guildford` centres
 * its samples instead. Both are legitimate voicings of the same rule, and
 * scoring rules on "base in zone" ranks voicing styles, not correctness.
 *
 * @param slotCount how many slots actually hold a sample. NOT `numStack` --
 *        see the note on that field.
 */
/**
 * How many key zones an instrument actually has.
 *
 * **The zone count comes from `Splitnotes`, not from how many slots hold a
 * sample.** The bounds run downward and the array is zero-filled past the last
 * one, so the count is the number of leading non-zero entries.
 *
 * On **62 of the game's 68 instruments** that equals the number of slots with a
 * sample, which is why the difference went unnoticed. The six that disagree
 * disagree for two different reasons:
 *
 * - `conga`, `djembe`, `dumbek` and `ukulele` carry **spare slots**: six bounds
 *   (`87,60,48,36,24,12`) against seven samples, the seventh with a base note
 *   out of sequence with the rest.
 * - `mime_artist` has **one** bound and four samples, with `Numstack` 5 -- its
 *   slots are stack layers rather than zones.
 *
 * Counting slots instead of bounds invents zones below the last bound. They are
 * unreachable, so nothing played differently -- **zero of the corpus's
 * 2,027,633 notes change slot** -- but they showed up as eight phantom
 * "unreachable slots" and made this rule look broken when it was not. Counting
 * bounds leaves exactly one, `ukulele`, whose bounds are `87,60,40,40,16,12`:
 * a genuinely empty zone in the game's own data.
 */
export function zoneCount(instrument: Instrument): number {
  const splits = instrument.splitNotes;
  let n = 0;
  while (n < splits.length && splits[n] !== 0) n += 1;
  return Math.max(1, n);
}

export function resolveSlot(
  instrument: Instrument,
  note: number,
  slotCount = instrument.slots.length,
): number {
  const splits = instrument.splitNotes;
  const usable = Math.max(
    1,
    Math.min(slotCount, splits.length, zoneCount(instrument)),
  );

  // Strictly less-than: the bound belongs to the zone ABOVE it. Measured --
  // guildford's slot 6 has base note 13 and `splitNotes[7]` is also 13, so
  // `<=` pushes that base into slot 7 and leaves slot 6 owning the single
  // note 14. `<` puts all eight bases in their own slots.
  let zone = 0;
  while (zone + 1 < usable && note < splits[zone + 1]) zone += 1;
  return zone;
}
