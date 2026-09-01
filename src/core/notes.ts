/**
 * The note record, and how records group into notes.
 *
 * Everything here is measured against real levels -- 1,626,983 notes from 22
 * of them. The measurements and their controls are in
 * steering/sequencer-data-model.md. Two points are worth repeating here
 * because getting either wrong is silent:
 *
 *  1. A note's duration is the SPAN from its first record to its last, not the
 *     number of records. A two-record note has a start and an end and can last
 *     any length. Counting records makes every note look 1-2 steps long.
 *
 *  2. A note's records are occasionally out of order in the file (~81 notes in
 *     1.6 million). Sort by step before using them.
 */

/** One 4-byte record as it sits in `PInstrument.Notes`. */
export interface NoteRecord {
  /** Step position within this instrument's clip, 0-127. Real clips stop at 63. */
  readonly step: number;
  /** Pitch, 0-127. */
  readonly pitch: number;
  /** 0-255, though real data never exceeds 127. Default 0x60. */
  readonly volume: number;
  /** 0-255, though real data never exceeds 127. Default 0x40. */
  readonly timbre: number;
  readonly triplet: boolean;
  /** Marks the last record of a note. */
  readonly end: boolean;
}

/** A note: one or more control points, the last of which carried the end flag. */
export interface Note {
  /** Control points, sorted by step. The first is the note-on. */
  readonly points: readonly NoteRecord[];
  readonly startStep: number;
  readonly endStep: number;
  /** `endStep - startStep + 1`, in steps. */
  readonly duration: number;
  /** True when pitch varies along the chain -- a glide. */
  readonly hasPitchAutomation: boolean;
  readonly hasVolumeAutomation: boolean;
  readonly hasTimbreAutomation: boolean;
}

export const NOTE_RECORD_SIZE = 4;
export const DEFAULT_VOLUME = 0x60;
export const DEFAULT_TIMBRE = 0x40;

/** Decode one 4-byte record. `bytes` must have at least 4 bytes from `offset`. */
export function decodeRecord(bytes: Uint8Array, offset = 0): NoteRecord {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  return {
    step: b0 & 0x7f,
    triplet: (b0 & 0x80) !== 0,
    pitch: b1 & 0x7f,
    end: (b1 & 0x80) !== 0,
    // Unsigned. The toolkit reads these as signed Java bytes while its writer
    // masks with 0xff; anything above 0x7f would come back negative there.
    volume: bytes[offset + 2],
    timbre: bytes[offset + 3],
  };
}

/** Encode one record back to 4 bytes, the inverse of decodeRecord. */
export function encodeRecord(note: NoteRecord, into: Uint8Array, offset = 0): void {
  into[offset] = (note.step & 0x7f) | (note.triplet ? 0x80 : 0);
  into[offset + 1] = (note.pitch & 0x7f) | (note.end ? 0x80 : 0);
  into[offset + 2] = note.volume & 0xff;
  into[offset + 3] = note.timbre & 0xff;
}

export function decodeRecords(bytes: Uint8Array): NoteRecord[] {
  if (bytes.length % NOTE_RECORD_SIZE !== 0) {
    throw new RangeError(
      `note data is ${bytes.length} bytes, not a multiple of ${NOTE_RECORD_SIZE}`,
    );
  }
  const out: NoteRecord[] = [];
  for (let o = 0; o < bytes.length; o += NOTE_RECORD_SIZE) {
    out.push(decodeRecord(bytes, o));
  }
  return out;
}

function varies<T>(points: readonly NoteRecord[], pick: (n: NoteRecord) => T): boolean {
  for (let i = 1; i < points.length; i += 1) {
    if (pick(points[i]) !== pick(points[0])) return true;
  }
  return false;
}

function makeNote(points: NoteRecord[]): Note {
  // Sort by step: real files occasionally store a note's points out of order.
  const sorted = points.length > 1 ? [...points].sort((a, b) => a.step - b.step) : points;
  const startStep = sorted[0].step;
  const endStep = sorted[sorted.length - 1].step;
  return {
    points: sorted,
    startStep,
    endStep,
    duration: endStep - startStep + 1,
    hasPitchAutomation: varies(sorted, (n) => n.pitch),
    hasVolumeAutomation: varies(sorted, (n) => n.volume),
    hasTimbreAutomation: varies(sorted, (n) => n.timbre),
  };
}

export interface GroupResult {
  readonly notes: Note[];
  /**
   * Records after the last end flag. Should always be empty: across 105,785
   * real instruments, not one array had a trailing run. A non-empty value here
   * means the array was misread, not that the data is unusual.
   */
  readonly trailing: NoteRecord[];
}

/** Group a flat record array into notes, splitting on the end flag. */
export function groupNotes(records: readonly NoteRecord[]): GroupResult {
  const notes: Note[] = [];
  let current: NoteRecord[] = [];
  for (const record of records) {
    current.push(record);
    if (record.end) {
      notes.push(makeNote(current));
      current = [];
    }
  }
  return { notes, trailing: current };
}

/** Convenience: raw bytes straight to notes. */
export function readNotes(bytes: Uint8Array): GroupResult {
  return groupNotes(decodeRecords(bytes));
}
