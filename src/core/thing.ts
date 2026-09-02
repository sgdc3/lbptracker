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
 * The LBP3 range this project accepts (`serializer.ts`: version `0x3b8`-`0x3ff`,
 * subVersion `0x213`) rules out every deprecated part by itself:
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

/** `PartHistory.STREAMING_HINT` and `PartHistory.CONTROLINATOR`. */
const PARTS_REVISION_LATEST = 0x3f;
const PARTS_REVISION_CONTROLINATOR = 0x2f;

/**
 * How far the parts table had got at this revision.
 *
 * ⚠️ The corpus straddles the boundary: files at version `0x3b8`-`0x3e2` stop at
 * `CONTROLINATOR`, later ones go to `STREAMING_HINT`. A file read with the wrong
 * one loses or gains the tail of the part list.
 */
export function partsRevisionFor(version: number): number {
  return version <= 0x3e2 ? PARTS_REVISION_CONTROLINATOR : PARTS_REVISION_LATEST;
}

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
 * Read one Thing.
 *
 * `readers` maps a part name to its reader; a part with no reader throws
 * `UnimplementedPartError` naming it, which is what makes building this out a
 * loop rather than a guess.
 */
export function readThing(s: Serializer, readers: ReadonlyMap<string, PartReader>): Thing {
  const { version } = s.revision;

  // `Revisions.THING_TEST_MARKER` is 0x2a1. It is a plain 0xAA and its whole job
  // is to fail loudly here rather than 200 bytes later.
  if (version >= 0x2a1) {
    const marker = s.u8();
    if (marker !== 0xaa) {
      throw new SerializerError(
        `Thing test marker was 0x${marker.toString(16)}, not 0xaa, at byte ` +
          `${s.position - 1} — the part reader before this one consumed the wrong ` +
          `number of bytes`,
      );
    }
  }

  const thing: Thing = {
    uid: 0,
    planGuid: 0,
    flags: 0,
    extraFlags: 0,
    parts: new Map<string, unknown>(),
  };

  // version >= 0x27f puts the UID first; older files put the parent first.
  thing.uid = s.i32();
  thing.parent = s.reference((self) => readThing(self, readers));
  thing.groupHead = s.reference((self) => readThing(self, readers));
  if (version >= 0x1c7) s.reference((self) => readThing(self, readers)); // oldEmitter

  // `isToolkit()` is false for anything the game wrote.
  if (version >= 0x214) {
    s.i16(); // createdBy
    s.i16(); // changedBy
  }

  if (version >= 0x341) {
    if (version >= 0x254) thing.planGuid = s.guid();
    thing.flags = s.u8();
    // ⚠️ cwlib gates this byte on `subVersion >= 0x110`, and **the corpus says
    // otherwise**. Every level here reports a head of `0x000003xx` -- subVersion
    // 0 -- and every one of them still carries the byte: on `5aa77945` the world
    // Thing's part mask only decodes to `BODY,WORLD,POS,SCRIPT,EFFECTOR,
    // GAMEPLAY_DATA` (which is exactly what `RLevel`'s constructor builds) when
    // one byte is consumed here first. Reading it unconditionally is what the
    // data supports; the gate is left recorded rather than obeyed.
    thing.extraFlags = s.u8();
  } else {
    if (version > 0x21a) s.bool(); // isStamping
    if (version >= 0x254) thing.planGuid = s.guid();
    if (version >= 0x2f2) s.bool(); // hidden
  }

  // The part mask. `u64` here is a varint when the stream is compressed, and a
  // part index can be as high as 0x35, so this really does need 64 bits.
  const mask = version >= 0x297 ? s.u64() : -1;
  const partsRevision = partsRevisionFor(version);

  for (const part of PARTS) {
    if (partsRevision < part.since) continue;
    // `mask` can exceed 2^53, so the bit test goes through BigInt rather than
    // `1 << index`, which would silently wrap at 32.
    if ((BigInt(mask) & (1n << BigInt(part.index))) === 0n) continue;
    const read = readers.get(part.name);
    if (!read) throw new UnimplementedPartError(part.name);
    const value = s.reference((self) => read(self, thing));
    thing.parts.set(part.name, value);
  }

  return thing;
}
