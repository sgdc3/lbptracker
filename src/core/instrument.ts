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
  /** Key-split boundaries, 9 of them. */
  readonly splitNotes: readonly number[];
  /** How many slots are actually in use. 1 in every instrument in the corpus. */
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
 * ⚠️ **The split convention is not confirmed.** `Splitnotes` having 9 entries
 * for 8 slots is the classic fencepost of a key-split sampler, so zone `i` is
 * taken here as `splitNotes[i] <= note < splitNotes[i + 1]`. The direction, the
 * inclusivity, and whether `Splitnotes` is even in the same numbering as
 * `baseNote` are all open -- see open questions 4 and 5. Keep this the single
 * place that decides, so changing it is a one-line change.
 */
export function resolveSlot(instrument: Instrument, note: number): number {
  const splits = instrument.splitNotes;
  const usable = Math.min(instrument.numStack, instrument.slots.length);
  if (usable <= 1) return 0;

  for (let zone = 0; zone < usable && zone + 1 < splits.length; zone += 1) {
    const low = splits[zone];
    const high = splits[zone + 1];
    if (note >= low && note < high) return zone;
  }
  // Outside every zone: clamp to the nearest end rather than dropping the note.
  return note < splits[0] ? 0 : usable - 1;
}
