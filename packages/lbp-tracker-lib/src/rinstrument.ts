/**
 * `RInstrument` (resource type 48, magic `INSb`) -- the sampler patch.
 *
 * Eight sample slots, eight sample GUIDs, nine key-split boundaries, and the
 * arpeggiator. The GUIDs address plain RIFF/WAV files in the FARC archives
 * through the game's FileDB; see steering/game-assets.md for that chain and
 * `tools/ExtractGuid.java` for how to walk it.
 *
 * Field order is from the game's own serialiser (`v0xc68a70`), cross-checked
 * against every one of the 68 `.rinst` files the game ships. Integers here are
 * varints -- see ByteReader.varuint / .varint and the warning there.
 */

import { ByteReader } from '@lbptracker/cwlib/stream.ts';
import { MAX_ARPEGGIO, MAX_PARAMS, MAX_SLOTS, MAX_SPLITS } from './instrument.ts';
import type { SampleSlot } from './instrument.ts';

export interface InstrumentParam {
  readonly x: number;
  readonly y: number;
}

export interface RInstrument {
  readonly slots: readonly SampleSlot[];
  /** GUIDs into the FileDB; 0 means the slot is unused. */
  readonly sampleGuids: readonly number[];
  readonly splitNotes: readonly number[];
  /** How many slots are in use. */
  readonly numStack: number;
  readonly params: readonly InstrumentParam[];
  readonly arpeggio: readonly number[];
  readonly arpeggiate: boolean;
}

export class InstrumentFormatError extends Error {}

function expectCount(reader: ByteReader, expected: number, what: string): void {
  const count = reader.varuint();
  if (count !== expected) {
    throw new InstrumentFormatError(
      `${what}: expected ${expected} entries, header says ${count} ` +
        `(at byte ${reader.position})`,
    );
  }
}

function readSlot(reader: ByteReader): SampleSlot {
  const baseNote = reader.varint();
  const baseBpm = reader.f32();
  const pitched = reader.bool();
  // The serialiser emits `fitbpm` twice into the same member -- a duplicate in
  // the game's own code, not two settings. Measured at v0xcc0eea / v0xcc0ef8.
  const fitBpm = reader.bool();
  reader.bool();
  const fineTune = reader.f32();
  return { baseNote, baseBpm, pitched, fitBpm, fineTune };
}

/**
 * Parse an RInstrument from the *decompressed* payload of an `INSb` resource
 * (`loadResource(...).data`).
 *
 * Throws unless the payload is consumed exactly. That check is the reason to
 * trust this: a misread varint leaves the cursor somewhere else, and across 68
 * real instruments all of them land on the final byte.
 */
export function readInstrument(payload: Uint8Array): RInstrument {
  const reader = new ByteReader(payload);

  expectCount(reader, MAX_SLOTS, 'Samples');
  const slots: SampleSlot[] = [];
  for (let i = 0; i < MAX_SLOTS; i += 1) slots.push(readSlot(reader));

  expectCount(reader, MAX_SLOTS, 'SampleGuids');
  const sampleGuids: number[] = [];
  for (let i = 0; i < MAX_SLOTS; i += 1) sampleGuids.push(reader.varuint());

  expectCount(reader, MAX_SPLITS, 'Splitnotes');
  const splitNotes: number[] = [];
  for (let i = 0; i < MAX_SPLITS; i += 1) splitNotes.push(reader.varint());

  const numStack = reader.varint();

  // Each param is written as its own two-element array, so the count repeats.
  const params: InstrumentParam[] = [];
  for (let i = 0; i < MAX_PARAMS; i += 1) {
    expectCount(reader, 2, `Params[${i}]`);
    params.push({ x: reader.f32(), y: reader.f32() });
  }

  expectCount(reader, MAX_ARPEGGIO, 'Arpeggio');
  const arpeggio: number[] = [];
  for (let i = 0; i < MAX_ARPEGGIO; i += 1) arpeggio.push(reader.i8());

  const arpeggiate = reader.bool();

  if (reader.remaining !== 0) {
    throw new InstrumentFormatError(
      `${reader.remaining} bytes left over after the instrument ` +
        `(read ${reader.position} of ${payload.length})`,
    );
  }

  return { slots, sampleGuids, splitNotes, numStack, params, arpeggio, arpeggiate };
}

/** The slots that are actually in use, paired with their sample GUID. */
export function usedSlots(
  instrument: RInstrument,
): { slot: SampleSlot; guid: number; index: number }[] {
  const out: { slot: SampleSlot; guid: number; index: number }[] = [];
  for (let i = 0; i < instrument.slots.length; i += 1) {
    if (instrument.sampleGuids[i]) {
      out.push({ slot: instrument.slots[i], guid: instrument.sampleGuids[i], index: i });
    }
  }
  return out;
}
