/**
 * Reading a level far enough to find its music.
 *
 * ## The parse is deliberately a prefix
 *
 * A level's stream is `RLevel` → `worldThing` → that Thing's parts → `PWorld` →
 * `things`, and **everything this project needs is inside `things`**. Once that
 * array is read the walk stops: the rest of `PWorld` (rewards, lighting, trophy
 * conditions, Vita branches) and the rest of `RLevel` (player record, tutorial
 * inventory, adventure data) are hundreds of lines of serialiser that would only
 * be read to reach the end of a file nobody is going to write back yet.
 *
 * ⚠️ That is a real constraint on step 7, round-trip export: writing a level
 * back out needs all of it. Stopping early is safe **only** while the direction
 * is read-only, and `StopParse` below is where that assumption lives.
 *
 * ## What cannot be skipped
 *
 * Everything before `things`, and every Thing in it. Parts carry no length and
 * object references expand inline at their first mention, so a part with no
 * reader ends the parse — see `thing.ts`, which also records why the "eight part
 * readers" figure in steering was wrong.
 */

import { loadResource, type Inflate } from './resource.ts';
import { Serializer, SerializerError, requireLbp3, type RevisionInfo } from './serializer.ts';
import type { InstrumentPart, Microchip, SequencerPart } from './parts.ts';
import { readThingRef, type PartReader, type Thing } from './thing.ts';

/** Thrown once `PWorld.things` is in hand, to stop reading the rest. */
class StopParse extends Error {
  readonly things: (Thing | undefined)[];
  constructor(things: (Thing | undefined)[]) {
    super('stop');
    this.things = things;
  }
}

/**
 * A struct the corpus never actually populates.
 *
 * Reading a zero count is free; a non-zero one means this level uses something
 * the reader has not been taught, and saying so beats guessing at a layout that
 * has never been exercised.
 */
function emptyOnly(s: Serializer, what: string): void {
  const count = s.i32();
  if (count !== 0) {
    throw new SerializerError(
      `${what} has ${count} entries and no reader — it was empty everywhere in the ` +
        `corpus this was built against, so its layout has never been tested`,
    );
  }
}

/** `SlotID`: an enum32 and a u32. */
function readSlotId(s: Serializer): void {
  s.i32();
  s.u32();
}

/** `LevelData`, at subVersion 0x213. */
function readLevelData(s: Serializer): void {
  readSlotId(s);
  s.i32(); // type
  emptyOnly(s, 'LevelData.chunkFileList');
  s.vector3(); // offset
  s.vector3(); // min
  s.vector3(); // max
  s.reference(readLevelData); // parent
  s.guid(); // farcGuid, subVersion >= 0x1ac
}

/** `StreamingManager`, at subVersion 0x213. */
function readStreamingManager(s: Serializer): void {
  emptyOnly(s, 'StreamingManager.editingThingsList');
  const count = s.i32();
  for (let i = 0; i < count; i += 1) s.reference(readLevelData);
  s.i32(); // numIslands
  s.i32(); // numPendingIslands
  s.resource(true); // fartDesc, a descriptor
  s.vector3(); // startingPointPosition
  s.i32(); // streamingZoneShape
  s.i32(); // streamingZoneSize
  s.i32(); // numInUsePlans
  s.i32(); // maintainIslandsCount
}

/**
 * `PWorld`, read only as far as `things`.
 *
 * The fields before it are few and all gated on subVersion, which the corpus
 * pins at 0x213 — so every branch below is the one that is always taken, and the
 * older ones are omitted rather than left as dead code.
 */
function readWorld(s: Serializer, readers: ReadonlyMap<string, PartReader>): never {
  const { subVersion } = s.revision;
  if (subVersion >= 0x6d) {
    s.f32(); // backdropOffsetX
    s.f32(); // backdropOffsetY
    s.f32(); // backdropOffsetZ
  }
  if (subVersion >= 0x70) s.bool(); // backdropOffsetZAuto
  if (subVersion >= 0xe2) s.str(); // overrideBackdropAmbience
  if (subVersion >= 0x3f) s.reference(readStreamingManager);
  // Every Thing goes through `referenceInto` so that the cycles in a level --
  // a Thing's parent, a switch's target -- resolve to the real object rather
  // than the empty placeholder `reference` would register.
  const count = s.i32();
  const things: (Thing | undefined)[] = [];
  for (let i = 0; i < count; i += 1) things.push(readThingRef(s, readers));
  throw new StopParse(things);
}

export interface LevelParse {
  readonly revision: RevisionInfo;
  readonly things: (Thing | undefined)[];
}

/**
 * Read a level resource and return every Thing in its world.
 *
 * `readers` is the part table; a Thing carrying a part that is not in it throws
 * `UnimplementedPartError` naming that part, which is how the reader gets built
 * out — run it over the corpus, implement whatever it names, run it again.
 */
export async function readLevel(
  bytes: Uint8Array,
  inflate: Inflate,
  readers: ReadonlyMap<string, PartReader>,
): Promise<LevelParse> {
  const resource = await loadResource(bytes, inflate);
  // `Revision.branch` is the head word's high half, which serializer.ts spells
  // `subVersion` -- the branch proper is the separate pair on the resource.
  const revision: RevisionInfo = {
    version: resource.revision.version,
    subVersion: resource.revision.branch,
    branchId: resource.branchId,
    branchRevision: resource.branchRevision,
  };
  requireLbp3(revision);

  const s = new Serializer(resource.data, revision, resource.compressionFlags);

  // `RLevel`: the cross-play hashes came in at 0x3e7, and the corpus straddles
  // that, so the count is only there on the later files.
  if (revision.version > 0x3e6) {
    const count = s.i32();
    for (let i = 0; i < count; i += 1) s.sha1();
  }

  const worldReaders = new Map(readers);
  worldReaders.set('WORLD', (self) => readWorld(self, worldReaders));

  try {
    readThingRef(s, worldReaders);
  } catch (error) {
    if (error instanceof StopParse) return { revision, things: error.things };
    throw error;
  }
  throw new SerializerError('the world Thing carried no WORLD part');
}

/**
 * Where a Thing sits on the circuit board it is parented to.
 *
 * ## Why a frame change is needed at all
 *
 * A closed board stores each component as a `CompactComponent` with a flat
 * `x, y` in board units. An **open** board has none of that: the components are
 * real Things in the world, and all that survives is a 4x4 per Thing. The cell
 * has to come back out of those two matrices.
 *
 * It is tempting to just subtract the two translations, since a circuit board is
 * usually hanging square on the screen. **Measured, that is wrong on real
 * levels**: `dev/board-probe.ts` finds that a bare delta puts only 78.93% of the
 * corpus's 1,030 open-board placements on a cell at all. One of the seven open
 * sequencer boards is attached to something rotated, and its components come out
 * on fractional cells. Expressing the delta in the board's own frame puts
 * **100%** of them on a cell.
 *
 * ## Why there is no quaternion here
 *
 * The board's frame is its matrix's three basis columns, so "the delta in board
 * space" is three dot products — one per axis, divided by the column's own
 * squared length so a scaled board still lands on integers. That is the whole
 * transform. `tools/RawDump.java` spells it as
 * `getNormalizedRotation().invert()` and rotates by a quaternion, which scores
 * the same 100% here for a reason worth knowing: it uses the **child's**
 * rotation rather than the board's, and those agree only because a component
 * lies flat against its board. It is right by accident, and it would part
 * company with the engine the moment a component were turned on the board.
 *
 * ## What says the units and the origin are right
 *
 * Nothing needs calibrating, and the corpus says so. All 61,128 stored
 * `CompactComponent.x` on closed boards are exact multiples of 52.5 and all
 * 61,128 stored `y` are **odd** multiples of it -- steps are 52.5 apart so an
 * instrument sits on any multiple, rows are twice that and a component sits at
 * the row's centre. Run this over the open boards and 1,030 of 1,030 come out
 * with the same signature, worst fractional part 0.0004 of a cell. A wrong
 * origin or a wrong scale could not reproduce that, so the result feeds
 * `boardToGrid` exactly as a stored pair would.
 */
export function boardCell(board: Float32Array, child: Float32Array): { x: number; y: number } {
  // Column-major: 12..14 is the translation, and column `i` is 4*i..4*i+2.
  const d = [child[12] - board[12], child[13] - board[13], child[14] - board[14]];
  const axis = (i: number) => {
    const c = [board[i * 4], board[i * 4 + 1], board[i * 4 + 2]];
    const squared = c[0] * c[0] + c[1] * c[1] + c[2] * c[2];
    return squared === 0 ? 0 : (c[0] * d[0] + c[1] * d[1] + c[2] * d[2]) / squared;
  };
  return { x: axis(0), y: axis(1) };
}

/** One music sequencer found in a level, with its board resolved. */
export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly instrument: InstrumentPart;
}

export interface FoundSequencer {
  /** The Thing's UID — what `RawDump` calls `seqUID`. */
  readonly uid: number;
  readonly settings: SequencerPart;
  readonly name: string;
  /** One entry per instrument placed on the board, in board order. */
  readonly placements: readonly Placement[];
}

/**
 * Every music sequencer in a parsed level.
 *
 * ⚠️ **The component list is not always where you would look for it.** While a
 * circuit board is open in the editor the game promotes its components to real
 * Things parented to the board and leaves `PMicrochip.components` empty, so
 * reading only that list finds a sequencer with no instruments at all. On one
 * corpus level that is five sequencers and 1,030 placements silently missing.
 * The fallback here is the one `RawDump.java` uses: scan the Thing list for
 * children of the board that carry an `INSTRUMENT`.
 *
 * The rebuilt order is the Thing list's order, which is what `RawDump` numbers
 * as `instIdx`; the compact list's order is its own.
 */
export function musicSequencers(things: readonly (Thing | undefined)[]): FoundSequencer[] {
  const out: FoundSequencer[] = [];
  for (const thing of things) {
    if (!thing) continue;
    const settings = thing.parts.get('SEQUENCER') as SequencerPart | undefined;
    const chip = thing.parts.get('MICROCHIP') as Microchip | undefined;
    if (!settings || !chip || !settings.musicSequencer) continue;

    const placements: Placement[] = [];
    if (chip.components.length > 0) {
      for (const component of chip.components) {
        const instrument = component.thing?.parts.get('INSTRUMENT') as InstrumentPart | undefined;
        if (instrument) placements.push({ x: component.x, y: component.y, instrument });
      }
    } else if (chip.board) {
      // The board's own matrix. Without it there is no frame to measure in, so
      // the placements would have to be dropped rather than guessed at.
      const boardPos = chip.board.parts.get('POS') as Float32Array | undefined;
      for (const child of things) {
        if (!child || child.parent !== chip.board) continue;
        const instrument = child.parts.get('INSTRUMENT') as InstrumentPart | undefined;
        if (!instrument) continue;
        const childPos = child.parts.get('POS') as Float32Array | undefined;
        const cell = boardPos && childPos ? boardCell(boardPos, childPos) : { x: NaN, y: NaN };
        placements.push({ x: cell.x, y: cell.y, instrument });
      }
    }
    out.push({ uid: thing.uid, settings, name: chip.name, placements });
  }
  return out;
}
