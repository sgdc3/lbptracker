/**
 * A `Sequencer` back out as a `PLNb` plan the game can load.
 *
 * This is the return leg of `project.ts`: `importLevel` turns a file's Things
 * into a `Sequencer`, and everything here turns a `Sequencer` back into the
 * Things a music sequencer is made of, wraps them in an `RPlan`, and hands
 * `writer.ts` a payload to put in a container.
 *
 * ## Why a plan, and why it can travel alone
 *
 * A plan is one saved Thing -- a costume, a vehicle, or a music sequencer
 * somebody copied into their popit -- and it is the smallest unit anybody can
 * drop into a level. ❗ **Everything a sequencer plan refers to is a GUID**: the
 * gadget's mesh, the gadget's own plan, and one `RInstrument` and one icon
 * texture per chip. GUIDs are game assets, in the player's own FileDB, so the
 * file needs nothing shipped beside it -- no FARC, no hash blobs. That is the
 * whole reason the export is a plan and not a level.
 *
 * ## The shape, and where it comes from
 *
 * ✔ **Measured over 17 real LBP3 sequencer plans** (the plan dependencies of
 * "Music Gallery #3", `dev/fetch-plan.ts`), which agree Thing for Thing:
 *
 * ```
 * Thing  uid 2  planGuid 120863  parts RENDER_MESH POS TRIGGER STICKERS SWITCH GROUP MICROCHIP SEQUENCER
 *   groupHead -> Thing uid 3, whose only part is GROUP
 *   MICROCHIP.circuitBoardThing -> Thing uid 4, parent 2, groupHead 2, planGuid 120863, part SWITCH
 *   MICROCHIP.components        -> one Thing per instrument, parent 4, groupHead 3, part INSTRUMENT
 * ```
 *
 * Three deliberate simplifications, each a thing the real plans carry that is
 * somebody's history rather than the object:
 *
 * - **one group Thing, not a chain.** Every real plan has three to six
 *   GROUP-only Things linked through `groupHead`, each carrying the hash of a
 *   plan its creator saved earlier; that is a copy-and-paste history, and one
 *   link is the same structure with none of it.
 * - **no stickers.** The 179-byte `STICKERS` on a real sequencer holds decals
 *   whose textures are **hashes** -- the creator's own stickers, which would
 *   turn a self-contained plan into one with missing dependencies.
 * - **no extra components.** Every real board carries one chip that is not an
 *   instrument (a speaker, a script); those are the creator's wiring.
 *
 * ## What is not modelled, and is written as measured
 *
 * `RENDER_MESH`, `POS`, `TRIGGER`, `SWITCH` and `GROUP` hold nothing musical
 * and the reader in `parts.ts` steps over their values. They are written here
 * from constants measured out of those same 17 plans -- and
 * `dev/verify-export.ts` diffs what this writes against what the game wrote,
 * span by span, so the constants are checked rather than remembered.
 */

import { chipFor } from './chips.ts';
import { escapeEntities } from './parts.ts';
import { CELL_HEIGHT, CELL_WIDTH, type Sequencer, type Track } from './project.ts';
import type { RevisionInfo } from './serializer.ts';
import { PARTS } from './thing.ts';
import { Writer, writeResource, type Deflate, type DependencyOut } from './writer.ts';

/* ------------------------------------------------------------ the gadget */

/** `RPlan` GUID of the Music Sequencer gadget: the plan every sequencer Thing came from. */
export const MUSIC_SEQUENCER_PLAN = 120863;
/** `RMesh` GUID the gadget renders as. */
export const MUSIC_SEQUENCER_MESH = 127558;

/**
 * The texture the popit shows for the item -- and **the one field the game
 * refuses to do without**.
 *
 * ❗ **`InventoryItemDetails.Icon` must not be null, or LBP3 never adds the
 * plan to the popit at all.** Measured in the game (1.28 under shadPS4) by the
 * project's owner, 2026-09-10, by bisection: the game's own sequencer imports,
 * the same object read and written back here did not; grafting the halves
 * apart put the fault in this tail rather than in the Thing graph, and
 * degrading the real tail one field at a time cleared every other candidate --
 * `Colour` -1 imports, a null `CreationHistory` imports, an empty creator
 * imports, **a null `Icon` does not**. The resource stays at status byte 9
 * instead of reaching 4, so `AddInventoryItem` never sees it as ready.
 * Confirmed the other way round: with an icon, the round trip, the demo plan
 * and a real exported song all import, and the same three without one do not.
 *
 * ⚠️ **The descriptor only has to be there.** An icon that resolves to nothing
 * -- a hash in no archive -- imports just as well, so this is a presence check
 * inside the game's loader and not a texture it needs to draw.
 *
 * ❗ **128567 is the Music Sequencer's own popit icon, and it was found rather
 * than picked.** The route, which is the one to repeat for any other gadget:
 * the mesh this writer puts in `PRenderMesh` is 127558
 * (`mesh_library/common_objects/sound_objects/boombox/sequencer.mol`); the one
 * plan in the game's data that depends on it is
 * `plans/palettes/dlc_arcade/sequencer.plan`, GUID **120863** — the same plan
 * GUID the corpus's sequencer Things carry — and the `Icon` of *its*
 * `InventoryItemDetails` is a GUID descriptor for **128567**
 * (`texture_library/ui/auto_icons/dlc_arcade/palette_gameplay_arcade_6416.tex`).
 *
 * ⚠️ **`electronics_inventory_logic_sequencer.tex` (128125) is a different
 * gadget**, and its name is a good enough trap to have caught this file once:
 * it is the icon of `gad_sequencer.plan`, GUID 125400, the **logic** sequencer
 * from the electronics palette. `PSequencer` is the part both share
 * (`MusicSequencer` is the flag that separates them), so a search by name lands
 * on the wrong one; the dependency on the mesh is what tells them apart.
 *
 * `PlanDetails.icon` overrides it; 0 writes the null descriptor the game
 * rejects, and is there so that a test can reproduce the failure rather than
 * for anybody to use.
 */
export const DEFAULT_PLAN_ICON = 128567;

/** Dependency type ids -- `resource.ts` has the measured table. */
const TYPE_TEXTURE = 1;
const TYPE_MESH = 2;
const TYPE_INSTRUMENT = 48;

/**
 * The revision this writer was measured at: LBP3 1.28 on PS3.
 *
 * ⚠️ **The subVersion is the platform.** `0x213` is what the PS3 build writes
 * and `0x218` what the PS4 one does; a PS3 game will not read a PS4 file. The
 * gates below are the reader's own, so either can be asked for, but only what
 * `dev/verify-export.ts` checks has been checked -- see its header for which.
 */
export const LBP3_PS3: RevisionInfo = {
  version: 0x3f9, subVersion: 0x213, branchId: 0, branchRevision: 0,
};

/** The same game on PS4/PS5, which is what the archive's own plans are. */
export const LBP3_PS4: RevisionInfo = {
  version: 0x3f9, subVersion: 0x218, branchId: 0, branchRevision: 0,
};

/** Integers, vectors and matrices compressed -- what every level and plan uses. */
export const COMPRESSION_ALL = 7;

/**
 * The oldest revision this writer will produce, and why it is `0x398`.
 *
 * ❗ **The reader implements every branch back to LBP1; the writer implements
 * one.** `readSwitch` alone has nine gates that fire below `0x398` -- a
 * connector block of some fifty bytes, `logicType`, `bulletPlayerNumber`, a
 * second output form -- and none of them is written here, because nothing needs
 * them and a branch with no file to check it against is a branch that is
 * probably wrong. Asking for an older revision would produce a file that reads
 * back plausibly and is not what that game writes, which is the exact failure
 * `requireLbp3` exists to prevent on the way in.
 */
export const MIN_WRITABLE_VERSION = 0x398;
export const MAX_WRITABLE_VERSION = 0x3ff;

export class PlanWriteError extends Error {}

export function requireWritable(revision: RevisionInfo): void {
  if (revision.version < MIN_WRITABLE_VERSION || revision.version > MAX_WRITABLE_VERSION) {
    throw new PlanWriteError(
      `this writer produces revisions 0x${MIN_WRITABLE_VERSION.toString(16)}..` +
        `0x${MAX_WRITABLE_VERSION.toString(16)}, not 0x${revision.version.toString(16)}: ` +
        'the older branches of PSwitch and PGroup are read here and never written',
    );
  }
  if (revision.branchId !== 0) {
    throw new PlanWriteError(
      `branch 0x${revision.branchId.toString(16)} has gates of its own that nothing here writes`,
    );
  }
}

/**
 * `PartHistory.STREAMING_HINT`, which is what the game writes on **every**
 * Thing.
 *
 * ⚠️ **Not the last part present, which is what cwlib's writer computes.**
 * Measured: every Thing in all 17 plans carries `partsRevision` 63, including
 * the GROUP-only ones whose last part is at 0x26. Writing the smaller number
 * would read back the same and still not be what the game does.
 */
const PARTS_REVISION = 0x3f;

/** Part name → its bit in the mask, from the reader's own table. */
const PART_INDEX = new Map(PARTS.map((part) => [part.name, part.index]));

/* ------------------------------------------------------------ the Things */

/** One part on a Thing: its name, and the bytes it writes. */
interface PartOut {
  readonly name: string;
  readonly write: (w: Writer) => void;
}

/**
 * A Thing on its way out.
 *
 * ⚠️ **Identity is the key, so these are built and then linked, not copied.**
 * `Writer.reference` looks a Thing up in a `Map` keyed by the object, and a
 * sequencer's graph is full of cycles -- the board's parent is the root, whose
 * microchip holds the board. `parent` and `groupHead` are therefore mutable and
 * filled in after both ends exist.
 */
interface ThingOut {
  readonly uid: number;
  parent?: ThingOut;
  groupHead?: ThingOut;
  readonly planGuid: number;
  readonly parts: PartOut[];
}

/**
 * Write one Thing, header and parts.
 *
 * The mirror of `fillThing` in `thing.ts`, at the revisions this writer
 * accepts: the `0xAA` marker, the uid before the parent, the plan GUID and
 * flags, the parts revision, the 64-bit mask, then each part behind its own
 * reference id in **declaration order** -- which is not index order, and
 * sorting by index would desynchronise every Thing with more than one part.
 */
function writeThing(w: Writer, thing: ThingOut): void {
  const { version, subVersion } = w.revision;
  w.u8(0xaa);
  w.i32(thing.uid);
  w.reference(thing.parent, writeThing);
  w.reference(thing.groupHead, writeThing);
  if (version >= 0x1c7) w.i32(0); // oldEmitter
  if (version >= 0x214) {
    // ⚠️ **-1, not 0.** These are player slots and the game writes the index of
    // whoever made the Thing -- 2 on every Thing of all 17 plans, which is that
    // creator's controller and not a constant. -1 is "nobody", cwlib's default.
    w.i16(-1); // createdBy
    w.i16(-1); // changedBy
  }
  w.guid(thing.planGuid);
  w.u8(0); // flags
  if (subVersion >= 0x110) w.u8(0); // extraFlags
  w.s32(PARTS_REVISION);
  let mask = 0n;
  for (const part of thing.parts) {
    const index = PART_INDEX.get(part.name);
    if (index === undefined) throw new Error(`no part index for ${part.name}`);
    mask |= 1n << BigInt(index);
  }
  w.u64Big(mask);
  for (const declared of PARTS) {
    const part = thing.parts.find((p) => p.name === declared.name);
    if (part) w.reference(part, (self) => part.write(self));
  }
}

/* ------------------------------------------------------------- the parts */

/**
 * `PRenderMesh`, as the gadget carries it.
 *
 * Every field is a measured constant except the bone list, which is
 * `[this Thing, null, null]` -- three entries, the first pointing back at the
 * Thing being written, which by then already has its reference id.
 */
function renderMesh(self: () => ThingOut): PartOut {
  return {
    name: 'RENDER_MESH',
    write(w) {
      w.resource({ guid: MUSIC_SEQUENCER_MESH, type: TYPE_MESH }, TYPE_MESH);
      w.i32(3); // boneThings
      w.reference(self(), writeThing);
      w.i32(0);
      w.i32(0);
      w.resource(undefined, 0); // anim
      w.f32(0); // animPos
      w.f32(1); // animSpeed
      w.bool(true); // animLoop
      w.f32(0); // loopStart
      w.f32(1); // loopEnd
      w.i32(-8323200); // editorColor, packed ARGB above 0x31a
      w.u8(0); // castShadows
      w.bool(false); // RTTEnable
      w.u8(3); // visibilityFlags
      // ⚠️ 1.0696549 in eleven of the plans and 1.0 in the rest -- the gadget's
      // own scale against one somebody resized. 1.0 is the untouched value.
      w.f32(1);
    },
  };
}

/**
 * `PPos`: where the object is, and whose bone it is.
 *
 * ❗ **The identity matrix, deliberately.** A real plan carries the object's
 * last position in its author's level and a scale their popit had shrunk it to
 * (0.78, 0.73, 0.70 across the corpus, no two alike); the game moves a plan to
 * wherever it is dropped, so the only part of this that survives placement is
 * the **scale**, and 1 is the gadget at its own size.
 */
function pos(self: () => ThingOut): PartOut {
  return {
    name: 'POS',
    write(w) {
      w.reference(self(), writeThing); // thingOfWhichIAmABone -- itself
      w.i32(0); // animHash
      if (w.revision.version < 0x341) w.matrix(IDENTITY);
      w.matrix(IDENTITY);
    },
  };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** `PTrigger`, every field measured and identical in all 17 plans. */
const TRIGGER: PartOut = {
  name: 'TRIGGER',
  write(w) {
    const { version, subVersion } = w.revision;
    w.u8(0); // triggerType
    w.i32(0); // inThings
    w.f32(600); // radiusMultiplier
    if (version < 0x1d5) w.i32(0);
    if (subVersion >= 0x2a) w.u8(5); // zRangeHundreds
    w.bool(true); // allZLayers
    if (version >= 0x19b) {
      w.f32(1); // hysteresisMultiplier
      w.bool(true); // enabled
    }
    if (version >= 0x322) w.f32(0); // zOffset
    if (subVersion >= 0x90) w.s32(10); // scoreValue
  },
};

/** `SWITCH_MICROCHIP` and the board's own type, from `parts.ts`. */
const SWITCH_MICROCHIP = 36;
const SWITCH_CIRCUIT_BOARD = 37;

/**
 * `PSwitch`, twice: the gadget carries one and its circuit board carries
 * another, and **the two differ in exactly two fields** -- the type, and the
 * player in the manual activation. Everything else is the same 68 bytes in
 * every plan measured.
 */
function switchPart(type: number, player: number): PartOut {
  return {
    name: 'SWITCH',
    write(w) {
      const { version, subVersion } = w.revision;
      w.bool(false); // inverted
      w.f32(250); // radius
      if (version >= 0x382) w.f32(0); // minRadius
      w.s32(0); // colorIndex
      if (version >= 0x2dc) w.wstr(''); // name
      if (version >= 0x38f) w.bool(false); // crappyOldLbp1Switch
      w.s32(0); // behaviorOld
      w.i32(0); // outputs
      if (version < 0x398 && version >= 0x140) w.resource(undefined, 0); // stickerPlan
      if (version > 0x197) w.bool(false); // hideInPlayMode
      if (version > 0x1a4) {
        w.s32(type);
        w.i32(0); // referenceThing
        w.f32(0); // manualActivation.activation
        if (version >= 0x310) w.s32(0); // ternary
        if (version >= 0x2a3) w.i32(player); // player
      }
      if (version > 0x1a4) w.s32(0); // activationHoldTime
      if (version > 0x1a4) w.bool(false); // requireAll
      if (version > 0x23d) {
        w.f32(180); // angleRange
        w.s32(0); // includeTouching
      }
      if (version > 0x243) w.s32(1); // bulletsRequired
      if (version > 0x244) w.s32(0); // bulletsDetected
      if (version > 0x248) w.i32(0); // bulletRefreshTime
      if (version >= 0x2f5) w.bool(false); // resetWhenFull
      if (version > 0x272) w.i32(0); // inputList
      if (version > 0x283) w.bool(false); // includeRigidConnectors
      if (version > 0x28c) w.f32(0); // timerCount
      if (version > 0x2ad && subVersion < 0x100) w.i32(0); // teamFilter
      if (version > 0x2c3) {
        w.i32(0); // behavior
        w.i32(1); // randomBehavior
        w.i32(0); // randomPattern
        w.i32(30); // randomOnTimeMin
        w.i32(30); // randomOnTimeMax
        w.i32(0); // randomOffTimeMin
        w.i32(0); // randomOffTimeMax
        if (version < 0x3ad) {
          w.u8(0); // randomPhaseOn
          w.s32(0); // randomPhaseTime
        }
        w.bool(false); // retardedOldJoint
      }
      if (version > 0x30f) w.i32(0); // keySensorMode
      if (version > 0x34c) {
        w.i32(-8355585); // userDefinedColour
        w.bool(false); // wiresVisible
      }
      if (version > 0x34f) w.u8(0); // bulletTypes
      if (version > 0x390) w.bool(false); // detectUnspawnedPlayers
      if (subVersion > 0x216) w.u8(0); // unspawnedBehavior
      if (version > 0x3a4) w.bool(true); // playSwitchAudio
      if (version > 0x3ec) w.u8(1); // playerMode
      if (subVersion > 0x21) w.bool(false); // relativeToSequencer
      if (subVersion > 0x2f) w.u8(0); // layerRange
      if (subVersion > 0x7a) {
        w.bool(false); // breakSound
        w.s32(0); // colorTimer
      }
      if (subVersion > 0x67) w.bool(false); // isLbp3Switch
      if (subVersion > 0x68) w.bool(false); // randomNonRepeating
      if (subVersion > 0x102) w.i32(1); // stickerSwitchMode
    },
  };
}

/**
 * The handle the game itself puts on a Thing placed from one of its own plans.
 *
 * ⚠️ **Not a person's name being borrowed.** Every copy of the Music Sequencer
 * gadget in the corpus carries this in the `PGroup` beside `planDescriptor`
 * 120863 -- the pair means "this came from Mm's plan", and a copy that says
 * anything else is a copy that came from somewhere it did not. The **human**
 * fields, the group Thing's own creator and `InventoryItemDetails.creator`,
 * are left empty: this tracker has no author to claim.
 */
const STOCK_CREATOR = 'MM_Studio';

/**
 * `PGroup`.
 *
 * `planDescriptor` is the gadget's own plan and is a **descriptor**, so it is
 * not a dependency -- `Writer.resource` has the rule and the corpus proves it:
 * a real plan names 120863 here and its dependency table does not list it.
 */
function group(planDescriptor: number | undefined, creator = ''): PartOut {
  return {
    name: 'GROUP',
    write(w) {
      const { version } = w.revision;
      if (version >= 0x18e && version < 0x341) w.bool(false); // COPYRIGHT
      writeNetworkPlayerId(w, creator);
      w.resource(planDescriptor ? { guid: planDescriptor, type: 38 } : undefined, 38, true);
      if (version >= 0x25e && version < 0x341) w.bool(false); // EDITABLE
      if (version >= 0x267) {
        w.i32(0); // emitter
        w.i32(0); // lifetime
        // ⚠️ 11 on every group of every plan measured, including the ones with
        // no emitter to be alive for. Written because it is what is there.
        w.i32(11); // aliveFrames
      }
      if (version >= 0x26e && version < 0x341) w.bool(false); // PICKUP_ALL_MEMBERS
      if (version >= 0x30f && version < 0x341) w.bool(false); // mainSelectableObject
      if (version >= 0x341) w.u8(2); // flags
    },
  };
}

/** `PStickers`: four empty lists. See the header for why they stay empty. */
const STICKERS: PartOut = {
  name: 'STICKERS',
  write(w) {
    const { version } = w.revision;
    w.i32(0); // decals
    w.i32(0); // costumeDecals
    if (version >= 0x158 && version <= 0x3ba) w.i32(0); // paintControl
    if (version >= 0x15d) w.i32(0); // eyetoyData
  },
};

/** `NetworkPlayerID`: a 16-byte handle, a terminator, and two 8-byte blocks. */
function writeNetworkPlayerId(w: Writer, handle: string): void {
  const data = new Uint8Array(16);
  for (let i = 0; i < Math.min(handle.length, 16); i += 1) data[i] = handle.charCodeAt(i);
  w.bytes(data);
  w.u8(0); // term
  w.bytes(new Uint8Array(3)); // dummy
  w.bytes(new Uint8Array(8)); // opt
  w.bytes(new Uint8Array(8)); // reserved
}

/* -------------------------------------------------------- the instrument */

/** The chip scale that goes with one cell of width. */
const CHIP_UNIT = 1.4666666;

/**
 * The width a chip is drawn at, in `CHIP_UNIT`s, for a note grid `steps` long.
 *
 * ✔ **Measured over 3,724 instrument components**: `scaleY` is `CHIP_UNIT` on
 * every one, and `scaleX` is `cells * CHIP_UNIT` for a cell count that is
 * exactly `ceil((highest step + 1) / 16) - 1`. The values below are the game's
 * own bit patterns rather than that product, because two of them are not:
 * three cells is `4.4f` and six is `8.8f`, each one ulp above the multiple.
 */
const CHIP_WIDTHS = [
  0, 1.466666579246521, 2.933333158493042, 4.400000095367432, 5.866666316986084,
  7.3333330154418945, 8.800000190734863, 10.266666412353516,
];

function chipCells(track: Track): number {
  let highest = -1;
  for (const note of track.notes) highest = Math.max(highest, note.endStep);
  return Math.max(1, Math.ceil((highest + 1) / 16) - 1);
}

function chipWidth(cells: number): number {
  return CHIP_WIDTHS[cells] ?? Math.fround(cells * CHIP_UNIT);
}

/**
 * `PInstrument`: one chip, its settings and its note records.
 *
 * ❗ **The records go out as the bytes they came in as.** `Track.records` is
 * the file's own note data and `notes` is a decode of it; re-encoding the
 * decode would move an end flag on the ~81 notes in 1.6 million whose points
 * are stored out of order (`project.ts`). Anything that edits notes rebuilds
 * `records` through `encodeNotes` before it gets here.
 */
function instrument(track: Track): PartOut {
  const chip = chipFor(track.guid);
  return {
    name: 'INSTRUMENT',
    write(w) {
      const { version } = w.revision;
      w.resource(track.guid ? { guid: track.guid, type: TYPE_INSTRUMENT } : undefined, TYPE_INSTRUMENT);
      if (version >= 0x35b) w.wstr(escapeEntities(track.name));
      // The chip's tint, packed RGBA. The placement's own: a level's value
      // comes back out of `PInstrument.Colour`, and a chip this tracker made
      // starts on the factory colour `chips.ts` measured out of the
      // instrument's own popit plan.
      w.i32(track.colour); // colour
      w.i32(1); // loops -- 1 in every one of 105,785 corpus instruments
      w.i32(track.key);
      w.i32(track.scale);
      w.f32(track.level);
      w.f32(track.pan);
      w.f32(track.echoSend);
      w.f32(track.reverbSend);
      if (version >= 0x389) {
        // The note editor's viewport when the chip was last closed. Zero is
        // "never scrolled"; the corpus's own values are wherever that composer
        // happened to leave the cursor.
        w.i16(0); // uiscrollx
        w.i16(0); // uiscrolly
        w.i16(0); // uicurx
        w.i16(0); // uicury
      }
      w.i32(track.records.length / 4);
      w.bytes(track.records);
      if (version >= 0x379) {
        w.resource(chip ? { guid: chip.icon, type: TYPE_TEXTURE } : undefined, TYPE_TEXTURE);
      }
    },
  };
}

/* --------------------------------------------------------- the sequencer */

/**
 * `PSequencer`.
 *
 * `MusicSequencer` is what separates this from an animation sequencer, and the
 * game tests it on every Thing before it plays anything (`v0x1c5773`).
 */
function sequencerPart(sequencer: Sequencer): PartOut {
  return {
    name: 'SEQUENCER',
    write(w) {
      const { version, subVersion } = w.revision;
      w.f32(sequencer.tempo);
      w.f32(sequencer.swing);
      w.f32(sequencer.echoFeedback);
      w.f32(sequencer.echoTime);
      w.f32(sequencer.echoMix);
      if (version > 0x370) w.i32(sequencer.reverb);
      if (version > 0x36e) w.bool(sequencer.loop);
      w.f32(sequencer.startPoint);
      w.i32(sequencer.numChannels);
      for (let i = 0; i < 6; i += 1) w.f32(sequencer.volumes[i] ?? 1);
      if (version > 0x369) {
        w.f32(0); // playHead -- runtime state, serialised anyway
        w.bool(false); // isPlaying
      }
      if (version > 0x36c) w.bool(true); // musicSequencer
      if (subVersion > 0x28) w.bool(false); // animationSequencer
      if (version > 0x371) w.i32(2); // behavior -- 2 on every sequencer measured
      if (version > 0x3a0) {
        w.i32(-1); // triggerPlayer
        w.i32(0); // previewThing
      }
    },
  };
}

/**
 * `PMicrochip`: the board, its size, and one component per instrument.
 *
 * The cell arithmetic is `project.ts`'s, run backwards. ✔ Both halves are
 * checked against real files: `x` is `(gridX + 1) * 52.5` and `y` is
 * `-(gridY + 0.5) * 105`, which reproduces the corpus's fingerprint -- every
 * stored `x` an exact multiple of 52.5 and every `y` an **odd** multiple of it.
 */
function microchip(
  board: ThingOut,
  placements: readonly { thing: ThingOut; track: Track }[],
  sizeX: number,
  sizeY: number,
  name: string,
): PartOut {
  return {
    name: 'MICROCHIP',
    write(w) {
      const { version, subVersion } = w.revision;
      w.reference(board, writeThing);
      if (version >= 0x283) {
        // ⚠️ **116, and it is not a typo.** `hideInPlayMode` is a bool and the
        // game writes 0x74 into it on the microchip of every one of the 15
        // sequencer plans measured. Any non-zero byte reads as true; this is
        // the byte the game itself puts there.
        w.u8(116);
      }
      if (version >= 0x2b8) w.bool(true); // wiresVisible
      if (version >= 0x2e4) w.s32(0); // lastTouched -- a frame counter
      if (version >= 0x2e9) w.vector4([0, 0, 0, 0]); // offset -- where the board opened
      if (version >= 0x34d) {
        w.wstr(escapeEntities(name));
        w.i32(placements.length);
        for (const { thing, track } of placements) {
          w.reference(thing, writeThing);
          w.f32((track.gridX + 1) * CELL_WIDTH);
          w.f32(-(track.gridY + 0.5) * CELL_HEIGHT);
          w.f32(0); // angle
          w.f32(chipWidth(chipCells(track)));
          w.f32(CHIP_UNIT);
          w.bool(false); // flipped
        }
        w.f32(sizeX);
        w.f32(sizeY);
      }
      if (subVersion >= 0x1d) w.bool(false); // keepVisualVertical
      if (subVersion >= 0x2d) w.u8(0); // broadcastType
    },
  };
}

/* ------------------------------------------------------- the Thing graph */

/** The Things a sequencer plan holds, in the order the plan's array lists them. */
export function sequencerThings(sequencer: Sequencer): ThingOut[] {
  const groupThing: ThingOut = { uid: 3, planGuid: 0, parts: [] };
  groupThing.parts.push(group(undefined));

  const root: ThingOut = {
    uid: 2, groupHead: groupThing, planGuid: MUSIC_SEQUENCER_PLAN, parts: [],
  };
  const rootRef = () => root;
  const board: ThingOut = {
    uid: 4, parent: root, groupHead: root, planGuid: MUSIC_SEQUENCER_PLAN, parts: [],
  };
  board.parts.push(switchPart(SWITCH_CIRCUIT_BOARD, -1));

  const placements = sequencer.tracks.map((track, i) => ({
    track,
    thing: {
      uid: 5 + i,
      parent: board,
      groupHead: groupThing,
      planGuid: chipFor(track.guid)?.plan ?? 0,
      parts: [instrument(track)],
    } satisfies ThingOut as ThingOut,
  }));

  // The board is at least as tall as the sequencer says and at least as wide as
  // its rightmost chip, and never smaller than the smallest board the corpus
  // holds (4 columns by 3 rows).
  let rows = Math.max(sequencer.boardRows, 3);
  let columns = 4;
  for (const { track } of placements) {
    rows = Math.max(rows, track.gridY + 2);
    columns = Math.max(columns, track.gridX + chipCells(track) + 1);
  }

  root.parts.push(
    renderMesh(rootRef),
    pos(rootRef),
    TRIGGER,
    STICKERS,
    switchPart(SWITCH_MICROCHIP, 0),
    group(MUSIC_SEQUENCER_PLAN, STOCK_CREATOR),
    microchip(board, placements, columns * CELL_WIDTH, rows * CELL_HEIGHT, sequencer.name),
    sequencerPart(sequencer),
  );

  return [root, groupThing, board, ...placements.map((p) => p.thing)];
}

/* -------------------------------------------------------------- the plan */

/** What goes in the popit beside the object. */
export interface PlanDetails {
  /** The name the popit shows. Escaped on the way in, as the editor's own is. */
  readonly name: string;
  readonly description?: string;
  /**
   * The popit icon's texture GUID; `DEFAULT_PLAN_ICON` when left out.
   *
   * ❗ **0 writes a null descriptor, and the game will not import the plan.**
   * See `DEFAULT_PLAN_ICON`.
   */
  readonly icon?: number;
}

/**
 * `InventoryItemDetails`, the block `RPlan` writes after its Thing data.
 *
 * ❗ **`readPlan` has never read this and the game always writes it**, so it is
 * transcribed here from cwlib's `InventoryItemDetails.serialize` at
 * `version > 0x37c` and then checked against the 218 bytes a real plan carries:
 * the field before `type` decodes to `USER_OBJECT` (1 << 7) on all 17, which is
 * the alignment check -- a reading one field out could not land on a flag word
 * that means what the item is.
 *
 * The name goes in `userCreatedDetails`, where the game puts a creator's own
 * title; `titleKey` is for Mm's own items and stays 0.
 */
function writeInventoryDetails(w: Writer, details: PlanDetails): void {
  w.uleb128(0); // dateAdded (s64) -- 0 in every plan measured
  w.i32(0); // levelUnlockSlotID.slotType
  w.u32(0); // levelUnlockSlotID.slotNumber
  w.guid(0); // highlightSound
  w.i32(-1); // colour -- the corpus's own is its creator's popit tint
  w.i32(1 << 7); // type: USER_OBJECT
  w.i32(0); // subType
  w.u32(0); // titleKey
  w.u32(0); // descriptionKey
  w.i32(0); // creationHistory -- a reference, null
  // ❗ **Never `undefined` here.** A null icon is the one thing measured to stop
  // the game importing the plan at all -- `DEFAULT_PLAN_ICON` has the bisection
  // that found it. `w.resource` registers the texture as a dependency itself.
  const icon = details.icon ?? DEFAULT_PLAN_ICON;
  w.resource(icon ? { guid: icon, type: TYPE_TEXTURE } : undefined, TYPE_TEXTURE, true);
  // `userCreatedDetails` is a reference: an id, then the two strings.
  const created = { name: details.name };
  w.reference(created, (self) => {
    self.wstr(escapeEntities(details.name));
    self.wstr(escapeEntities(details.description ?? ''));
  });
  w.i32(0); // photoData
  w.i32(0); // eyetoyData
  w.i16(-1); // locationIndex
  w.i16(-1); // categoryIndex
  w.i16(0); // primaryIndex
  const creator = {};
  w.reference(creator, (self) => writeNetworkPlayerId(self, ''));
  w.i8(0); // toolType
  w.i8(0); // flags
}

/**
 * The LAMS key the game files a saved object under.
 *
 * Measured: the same value on all 17 plans, which is what makes it the
 * category rather than the item. `location` beside it is 0 on all 17.
 */
const CATEGORY_KEY = 3423480070;

/** What makes two dependencies the same entry: a GUID, or a hash. */
const key = (dependency: DependencyOut): string =>
  dependency.hash ? `h${[...dependency.hash].join(',')}` : `g${dependency.guid ?? 0}`;

/** Everything a `PLNb` needs, before the container. */
export interface PlanPayload {
  readonly payload: Uint8Array;
  readonly dependencies: readonly DependencyOut[];
}

/**
 * `RPlan`: the streaming flag, the plan's own (ignored) revision, the Thing
 * blob, and the inventory details.
 *
 * ⚠️ **The Things go in a nested stream with a fresh reference table.** Ids
 * inside `thingData` mean nothing outside it, so the blob gets its own
 * `Writer` -- the same rule `readPlan` states from the other side.
 */
export function planPayload(
  sequencer: Sequencer,
  revision: RevisionInfo,
  compressionFlags: number,
  details: PlanDetails,
): PlanPayload {
  const inner = new Writer(revision, compressionFlags);
  const things = sequencerThings(sequencer);
  inner.i32(things.length);
  for (const thing of things) inner.reference(thing, writeThing);
  const thingData = inner.done();

  const outer = new Writer(revision, compressionFlags);
  if (revision.subVersion >= 0xcc) outer.bool(false); // isUsedForStreaming
  outer.i32(((revision.subVersion << 16) | revision.version) >>> 0);
  outer.i32(thingData.length);
  outer.bytes(thingData);
  writeInventoryDetails(outer, details);
  outer.u32(0); // location
  outer.u32(CATEGORY_KEY); // category

  // ❗ **Both writers' dependencies, and the outer one is easy to forget.**
  // Nearly everything a plan refers to is referred to from a Thing, so this
  // used to return the inner table alone -- correct only while the inventory
  // icon was null, which is exactly the field the game turned out to insist on.
  // A dependency table missing the icon is a plan that names a texture it never
  // declares.
  const dependencies = [...inner.dependencies()];
  const seen = new Set(dependencies.map(key));
  for (const dependency of outer.dependencies()) {
    if (seen.has(key(dependency))) continue;
    seen.add(key(dependency));
    dependencies.push(dependency);
  }
  return { payload: outer.done(), dependencies };
}

export interface PlanOptions {
  readonly revision?: RevisionInfo;
  readonly compressionFlags?: number;
  /** What the popit calls it. Defaults to the sequencer's own name. */
  readonly name?: string;
  readonly description?: string;
  /** The popit icon's texture GUID; `DEFAULT_PLAN_ICON` when left out. */
  readonly icon?: number;
}

/**
 * A `Sequencer` as a `.plan` file, ready to drop in a save.
 *
 * `deflate` is injected exactly as `inflate` is on the read side --
 * `src/platform/` has the Node and browser adapters, and `writer.ts` says why
 * the two produce different (equally valid) zlib headers.
 */
export async function writeSequencerPlan(
  sequencer: Sequencer,
  deflate: Deflate,
  options: PlanOptions = {},
): Promise<Uint8Array> {
  const revision = options.revision ?? LBP3_PS3;
  requireWritable(revision);
  const compressionFlags = options.compressionFlags ?? COMPRESSION_ALL;
  const name = options.name ?? sequencer.name;
  const { payload, dependencies } = planPayload(sequencer, revision, compressionFlags, {
    name,
    description: options.description,
    icon: options.icon,
  });
  return writeResource(
    { magic: 'PLNb', revision, compressionFlags, payload, dependencies },
    deflate,
  );
}
