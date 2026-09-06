/**
 * The Thing graph: what a level actually is.
 *
 * A level is one `worldThing`, whose `WORLD` part holds every other Thing in
 * the level. Each Thing is a UID, a few scalars, a 64-bit mask of which parts it
 * carries, and then those parts inline in a fixed order.
 *
 * ## Why every part type has to be implemented, not just the interesting ones
 *
 * ⚠️ **`steering/tracker-architecture.md` said this walk needed eight part
 * readers. It needs all of them, and the difference is not a detail.** The
 * reasoning behind "eight" was that only nine part types ever share a Thing with
 * a `SEQUENCER` — which is true, and irrelevant. Parts carry no length, object
 * references expand inline at their first mention, and `PWorld.things` is an
 * array of such references, so reaching the 443rd Thing means having fully read
 * the 442 before it. A part this reader does not know is not a part it can step
 * over; it is the end of the parse.
 *
 * The measured number, from `tools/PartCensus.java` over the 10 level files that
 * load: **33 distinct part types across 81,946 Things**. `PartCensus`'s own
 * header says as much — "a TypeScript walk cannot skip anything" — so the tool
 * was right and the conclusion drawn from it was not.
 *
 * ## What is deliberately absent
 *
 * The LBP3 range this project accepts (`serializer.ts`: version `0x3b7`-`0x3ff`;
 * subVersions `0x0` and `0x205`-`0x218` are what the archive sample carries, and
 * nothing range-checks them) rules out every deprecated part by itself:
 *
 * - `head & 0xffff >= 0x13c` excludes indices `0x36`-`0x3c` — the six LBP1 parts;
 * - the same test at `0x18c` excludes `PARTICLE_EMITTER_2` (`0x3d`);
 * - `head >> 16 >= 0x107` excludes `CREATOR_ANIM` (`0x3e`), **and** switches off
 *   the `index++` shim that older files need for every index above `0x28`.
 *
 * So the table below carries only the live parts. Adding an older revision means
 * putting the deprecated entries back *and* restoring that index shift, not just
 * relaxing the version check.
 */

import { Serializer, SerializerError } from './serializer.ts';

/**
 * The parts, in **declaration order** — which is the order they serialise in.
 *
 * ⚠️ Declaration order is not index order, and the difference is load-bearing:
 * `Part.fromFlags` in cwlib iterates `Part.values()`, so `LEVEL_SETTINGS`
 * (index `0x0a`) is written after `GENERATED_MESH` (`0x09`) but before
 * `SPRITE_LIGHT` (`0x0b`), while `TRIGGER_EFFECTOR` (`0x36`) sits between
 * `TRIGGER` (`0x05`) and `YELLOWHEAD` (`0x06`). Sorting this table by index
 * would desynchronise every Thing that carries more than one part.
 *
 * `since` is the part's `PartHistory` value: a part is present only when the
 * stream's parts-revision has reached it, whatever its flag bit says.
 */
/**
 * cwlib `Branch.LEERDAMMER` and the two of its revisions this reader needs.
 *
 * ❗ **A branch can turn a version gate on early, and two of the gates in
 * `fillThing` are branch gates wearing a version gate's clothes.** Every LBP1
 * level in the archive sample is on this branch at revision 0x17, so both of
 * these fire and neither was implemented.
 */
const LEERDAMMER = 0x4c44;
const LD_RESOURCES = 0x2;
const LD_TEST_MARKER = 0x5;
/** `PCreature` gains the submerged pair here; the branch is on 0x17, so it has them. */
export const LD_SUBMERGED = 0xf;
/** Any LEERDAMMER revision at all. `isLeerdammer()` in cwlib. */
export const LD_ANY = 0x0;

/** cwlib `Revision.has(branch, revision)`. */
export function onLeerdammer(
  revision: { branchId: number; branchRevision: number },
  since: number,
): boolean {
  return revision.branchId === LEERDAMMER && revision.branchRevision >= since;
}

export const PARTS: readonly { readonly name: string; readonly index: number; readonly since: number }[] = [
  { name: 'BODY', index: 0x00, since: 0x01 },
  { name: 'JOINT', index: 0x01, since: 0x02 },
  { name: 'WORLD', index: 0x02, since: 0x03 },
  { name: 'RENDER_MESH', index: 0x03, since: 0x04 },
  { name: 'POS', index: 0x04, since: 0x05 },
  { name: 'TRIGGER', index: 0x05, since: 0x06 },
  { name: 'YELLOWHEAD', index: 0x06, since: 0x09 },
  { name: 'AUDIO_WORLD', index: 0x07, since: 0x0a },
  { name: 'ANIMATION', index: 0x08, since: 0x0b },
  { name: 'GENERATED_MESH', index: 0x09, since: 0x0c },
  { name: 'LEVEL_SETTINGS', index: 0x0a, since: 0x10 },
  { name: 'SPRITE_LIGHT', index: 0x0b, since: 0x11 },
  { name: 'SCRIPT_NAME', index: 0x0c, since: 0x14 },
  { name: 'CREATURE', index: 0x0d, since: 0x15 },
  { name: 'CHECKPOINT', index: 0x0e, since: 0x16 },
  { name: 'STICKERS', index: 0x0f, since: 0x17 },
  { name: 'DECORATIONS', index: 0x10, since: 0x18 },
  { name: 'SCRIPT', index: 0x11, since: 0x19 },
  { name: 'SHAPE', index: 0x12, since: 0x1a },
  { name: 'EFFECTOR', index: 0x13, since: 0x1b },
  { name: 'EMITTER', index: 0x14, since: 0x1c },
  { name: 'REF', index: 0x15, since: 0x1d },
  { name: 'METADATA', index: 0x16, since: 0x1e },
  { name: 'COSTUME', index: 0x17, since: 0x1f },
  { name: 'CAMERA_TWEAK', index: 0x18, since: 0x21 },
  { name: 'SWITCH', index: 0x19, since: 0x22 },
  { name: 'SWITCH_KEY', index: 0x1a, since: 0x23 },
  { name: 'GAMEPLAY_DATA', index: 0x1b, since: 0x24 },
  { name: 'ENEMY', index: 0x1c, since: 0x25 },
  { name: 'GROUP', index: 0x1d, since: 0x26 },
  { name: 'PHYSICS_TWEAK', index: 0x1e, since: 0x27 },
  { name: 'NPC', index: 0x1f, since: 0x28 },
  { name: 'SWITCH_INPUT', index: 0x20, since: 0x29 },
  { name: 'MICROCHIP', index: 0x21, since: 0x2a },
  { name: 'MATERIAL_TWEAK', index: 0x22, since: 0x2b },
  { name: 'MATERIAL_OVERRIDE', index: 0x23, since: 0x2c },
  { name: 'INSTRUMENT', index: 0x24, since: 0x2d },
  { name: 'SEQUENCER', index: 0x25, since: 0x2e },
  { name: 'CONTROLINATOR', index: 0x26, since: 0x2f },
  { name: 'POPPET_POWERUP', index: 0x27, since: 0x30 },
  { name: 'POCKET_ITEM', index: 0x28, since: 0x31 },
  { name: 'TRANSITION', index: 0x29, since: 0x33 },
  { name: 'FADER', index: 0x2a, since: 0x34 },
  { name: 'ANIMATION_TWEAK', index: 0x2b, since: 0x35 },
  { name: 'WIND_TWEAK', index: 0x2c, since: 0x36 },
  { name: 'POWER_UP', index: 0x2d, since: 0x37 },
  { name: 'HUD_ELEM', index: 0x2e, since: 0x38 },
  { name: 'TAG_SYNCHRONIZER', index: 0x2f, since: 0x39 },
  { name: 'WORMHOLE', index: 0x30, since: 0x3a },
  { name: 'QUEST', index: 0x31, since: 0x3b },
  { name: 'CONNECTOR_HOOK', index: 0x32, since: 0x3c },
  { name: 'ATMOSPHERIC_TWEAK', index: 0x33, since: 0x3d },
  { name: 'STREAMING_DATA', index: 0x34, since: 0x3e },
  { name: 'STREAMING_HINT', index: 0x35, since: 0x3f },
];

/**
 * How far the parts table had got when this Thing was written.
 *
 * ❗ **It is in the stream, and this file used to guess it from the version.**
 * The guess -- `CONTROLINATOR` up to 0x3e2, `STREAMING_HINT` after -- happened to
 * agree with every file in the corpus, because it is derived from the same
 * table; what it could not do is consume the four bytes the Thing writes for it,
 * and the byte that had to be eaten to make the part mask decode was recorded
 * here as "one byte cwlib does not account for". It is this field: an `s32`,
 * which is a **one-byte zigzag varint** in a compressed stream and a full four
 * bytes in one that is not. The first uncompressed resource -- a streaming
 * island's plan -- read three bytes short and produced a plausible, wrong part
 * list. `PartHistory.STREAMING_HINT` is 0x3f, `CONTROLINATOR` 0x2f.
 */

/** Reads one part's body. Returning nothing is fine; the bytes are what matter. */
export type PartReader = (s: Serializer, thing: Thing) => unknown;

export class UnimplementedPartError extends SerializerError {
  readonly part: string;
  constructor(part: string) {
    super(`no reader for part ${part}`);
    this.part = part;
  }
}

export interface Thing {
  uid: number;
  parent?: Thing;
  groupHead?: Thing;
  planGuid: number;
  flags: number;
  extraFlags: number;
  /** Part name → whatever its reader returned. */
  readonly parts: Map<string, unknown>;
}

export function hasPart(thing: Thing, name: string): boolean {
  return thing.parts.has(name);
}

/**
 * Optional trace of what the walk is reading, and where.
 *
 * ⚠️ Keep this. A part that consumes the wrong number of bytes is only reported
 * one Thing later, by the `0xAA` marker, and the byte offset alone does not say
 * which part was wrong. The span of every part is what turns "something before
 * byte 219" into "SHAPE ran 103..217 and should have stopped at 216".
 *
 * Each part and Thing fires **twice**: once on entry with `end` of -1, once on
 * exit with the real end. The entries are what matter when the failure happens
 * deep inside a nested read — the exits never arrive for the frames that are
 * still open, and those are exactly the ones holding the bug.
 */
export type Trace = (event: string, start: number, end: number) => void;
let trace: Trace | undefined;
export function setTrace(fn: Trace | undefined): void {
  trace = fn;
}

/**
 * Read one Thing.
 *
 * `readers` maps a part name to its reader; a part that **has a body** and no
 * reader throws `UnimplementedPartError` naming it, which is what makes building
 * this out a loop rather than a guess. A part the Thing merely declares — its
 * mask bit set and its reference null — needs none; see the note at the call.
 */
/** An empty Thing, registered before its body is read so cycles resolve. */
export function emptyThing(): Thing {
  return { uid: 0, planGuid: 0, flags: 0, extraFlags: 0, parts: new Map<string, unknown>() };
}

/** Read a Thing behind a reference, registering it before its parts are read. */
export function readThingRef(
  s: Serializer,
  readers: ReadonlyMap<string, PartReader>,
): Thing | undefined {
  return s.referenceInto(emptyThing, (self, thing) => fillThing(self, thing, readers));
}

export function readThing(s: Serializer, readers: ReadonlyMap<string, PartReader>): Thing {
  const thing = emptyThing();
  fillThing(s, thing, readers);
  return thing;
}

function fillThing(
  s: Serializer,
  thing: Thing,
  readers: ReadonlyMap<string, PartReader>,
): Thing {
  const { version, subVersion } = s.revision;
  const thingStart = s.position;
  trace?.('THING', thingStart, -1);

  // `Revisions.THING_TEST_MARKER` is 0x2a1. It is a plain 0xAA and its whole job
  // is to fail loudly here rather than 200 bytes later.
  //
  // ⚠️ **LEERDAMMER has it from its own revision 5, well below 0x2a1.** Reading a
  // 0x272 file without the marker takes the 0xAA as the first byte of the parent
  // reference and everything after is one byte out.
  if (version >= 0x2a1 || onLeerdammer(s.revision, LD_TEST_MARKER)) {
    const marker = s.u8();
    if (marker !== 0xaa) {
      throw new SerializerError(
        `Thing test marker was 0x${marker.toString(16)}, not 0xaa, at byte ` +
          `${s.position - 1} — the part reader before this one consumed the wrong ` +
          `number of bytes`,
      );
    }
  }

  // ❗ **The UID and the parent swap at 0x27f, and this used to read the 0x27f
  // order for every file while a comment above it described the rule.** cwlib
  // `Thing.java:96` is the authority: below 0x27f the parent comes first.
  // Measured 2026-09-06 with `LBP3_MIN_VERSION` lowered to 0x100, over the 21
  // LBP1 levels in `fixtures/archive`: **3 files got past the Thing header, then
  // 10 did.** It changes nothing at the bound this reader actually enforces --
  // 0x3b7 is far above 0x27f -- so it is latent correctness for a range that is
  // still refused, and the measurement only exists because the bound can be
  // lowered by hand. See question 28.
  if (version >= 0x27f) {
    thing.uid = s.i32();
    thing.parent = readThingRef(s, readers);
  } else {
    thing.parent = readThingRef(s, readers);
    thing.uid = s.i32();
  }
  thing.groupHead = readThingRef(s, readers);
  if (version >= 0x1c7) readThingRef(s, readers); // oldEmitter

  // `isToolkit()` is false for anything the game wrote.
  if (version >= 0x214) {
    s.i16(); // createdBy
    s.i16(); // changedBy
  }

  if (version >= 0x341) {
    if (version >= 0x254) thing.planGuid = s.guid();
    thing.flags = s.u8();
    if (subVersion >= 0x110) thing.extraFlags = s.u8();
  } else {
    if (version > 0x21a) s.bool(); // isStamping
    if (version >= 0x254) thing.planGuid = s.guid();
    if (version >= 0x2f2) s.bool(); // hidden
  }

  // ⚠️ **The parts revision comes first, and it is the field this reader used
  // to guess.** See the note on `PARTS` above: it is an `s32`, one byte as a
  // zigzag varint in a compressed stream and four in one that is not.
  const partsRevision = s.s32();
  // The part mask. `u64` here is a varint when the stream is compressed, and a
  // part index can be as high as 0x35, so this really does need 64 bits.
  //
  // ⚠️ **`u64Big`, not `u64`.** A `number` has 53 bits of mantissa and the
  // highest part index is 53, so a mask carrying `STREAMING_HINT` alongside any
  // low part comes back rounded and the low part vanishes without a word. See
  // `Serializer.u64Big` for the measurement.
  //
  // ⚠️ **And LEERDAMMER has the mask from its revision 2**, which is cwlib's
  // `isCompressed`. Without it a 0x272 Thing was read with `mask = -1` -- every
  // declared part treated as present -- and the parts revision it had just read
  // was garbage anyway, so nothing was read at all.
  const masked = version >= 0x297 || onLeerdammer(s.revision, LD_RESOURCES);
  const mask = masked ? s.u64Big() : -1n;

  for (const part of PARTS) {
    if (partsRevision < part.since) continue;
    // `mask` can exceed 2^53, so it is a BigInt all the way rather than
    // `1 << index`, which would silently wrap at 32.
    if ((mask & (1n << BigInt(part.index))) === 0n) continue;
    const read = readers.get(part.name);
    const partStart = s.position;
    trace?.(part.name, partStart, -1);
    // ❗ **The refusal belongs INSIDE the reference, not in front of it.** A
    // part's mask bit says the Thing has the field; the reference id that
    // follows says whether it holds anything. Refusing on the bit alone rejects
    // a level for a part that is null in it -- measured 2026-09-05: `EFFECTOR`
    // appears in 13 of the archive sample's LBP1 levels and **every one of the
    // 13 is a null reference**, one byte and no body. Those levels were being
    // turned away over a field that is not there.
    //
    // ⚠️ It also means `UnimplementedPartError` now says what it always claimed
    // to: this file has data for a part nothing here can read. A part that is
    // merely *declared* costs nothing and is skipped.
    const value = s.reference((self) => {
      if (!read) throw new UnimplementedPartError(part.name);
      return read(self, thing);
    });
    trace?.(part.name, partStart, s.position);
    thing.parts.set(part.name, value);
  }

  trace?.(`THING ${thing.uid}`, thingStart, s.position);
  return thing;
}
