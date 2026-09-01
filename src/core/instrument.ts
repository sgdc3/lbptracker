/**
 * The sampler patch: 8 sample slots and the key splits between them.
 *
 * Field names, offsets and stream order come from the game's own serialisers --
 * see steering/sequencer-data-model.md. What is NOT yet settled is flagged
 * inline and tracked in steering/open-questions.md; nothing here silently
 * invents a rule.
 */

export const MAX_SLOTS = 8;
export const MAX_SPLITS = 9; // 8 zones need 9 boundaries
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
   * Key-split boundaries: the **inclusive upper bound** of each zone, in
   * **descending** order. `splitNotes[0]` is 87 in every one of the game's 68
   * instruments; unused trailing entries are 0.
   */
  readonly splitNotes: readonly number[];
  /**
   * ⚠️ **Not the number of slots in use.** Measured across the game's 68
   * instruments: `numStack` equals the used-slot count in only 14 of them.
   * `electric_piano` uses one sample with `numStack` 2, `ghost` one with 3, and
   * most 8-slot drum kits have `numStack` 1. It is a voice-stacking count --
   * how many voices to layer per note -- not an array length. Use
   * `sampleGuids[i] !== 0` to find the slots that exist.
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
 * ⚠️ **The split convention is NOT settled.** What is measured across the
 * game's 68 instruments is only the shape: `Splitnotes` is a **descending**
 * list, `splitNotes[0]` is 87 in every single one, and unused trailing entries
 * are 0. This function reads them as inclusive upper bounds -- zone `i` covers
 * `splitNotes[i+1] < note <= splitNotes[i]` -- because that is the reading
 * under which a zone's own base note lands inside it.
 *
 * It only does so **56.8% of the time**. Measured over the 257 zones of the
 * game's multisampled instruments: base inside its own zone 146, inside the
 * zone above 31, neither 80. Drum kits explain some of the misses -- a kit's
 * base notes are arbitrary, one drum per key -- but `piano` (1 of 5),
 * `honky_tonk_piano` (1 of 5), `clarinet` (1 of 3) and `doublebass` (1 of 3)
 * are pitched instruments and they do not fit.
 *
 * `baiyon_city_guildford` fits perfectly: bounds `87, 73, 61, 49, 37, 25` over
 * bases `84, 72, 60, 48, 36, 24`, every base inside its zone. The piano does
 * not: bounds `87, 66, 54, 40, 30` over bases `84, 72, 60, 48, 36` puts every
 * zone but the first on the sample an octave above, so C4 would play the C5
 * sample pitched down twelve semitones while `piano_c4.smp` sits unused.
 *
 * Something is still wrong -- an off-by-one, a different numbering for
 * `Splitnotes` than for `baseNote`, or a rule that is not "nearest bound" at
 * all. See steering/open-questions.md. Keep this the one place that decides.
 *
 * @param slotCount how many slots actually hold a sample. NOT `numStack` --
 *        see the note on that field.
 */
export function resolveSlot(
  instrument: Instrument,
  note: number,
  slotCount = instrument.slots.length,
): number {
  const splits = instrument.splitNotes;
  const usable = Math.max(1, Math.min(slotCount, splits.length));

  let zone = 0;
  while (zone + 1 < usable && note <= splits[zone + 1]) zone += 1;
  return zone;
}
