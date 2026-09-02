/**
 * The Thing part readers.
 *
 * One function per part type. None of them keeps anything it does not need —
 * what matters is that each consumes **exactly** the right number of bytes,
 * because the next Thing starts immediately after and there is no length to
 * resynchronise from.
 *
 * ## The format checks itself, once per Thing
 *
 * Every Thing begins with a `0xAA` marker (`thing.ts`). That is the only reason
 * building this by transcription is tractable: a part that reads one byte too
 * few or too many does not produce subtly wrong data, it fails loudly at the
 * *next* Thing. Treat a marker failure as "the part before this one is wrong",
 * not as a corrupt file.
 *
 * ## Revision gates, and one that does not hold
 *
 * Fields are gated on `version` (the head's low half) and `subVersion` (its high
 * half). ⚠️ **Nine of the ten corpus levels report `subVersion` 0** — by cwlib's
 * own test (`isLBP3()` is `head >> 16 != 0`) they are LBP2-revision files that
 * LBP3 wrote. Every `subVersion >= n` gate is therefore false on them, and where
 * that turned out to be wrong the code says so at the line: see `extraFlags` in
 * `thing.ts`.
 */

import { Serializer, SerializerError } from './serializer.ts';
import { readThing, type PartReader, type Thing } from './thing.ts';

/** An array of Thing references — cwlib's `thingarray`. */
function things(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const count = s.i32();
  for (let i = 0; i < count; i += 1) s.reference((self) => readThing(self, readers));
}

/** `PBody`: velocities, a frozen flag and whoever is dragging it about. */
export function readBody(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  s.vector3(); // posVel
  s.f32(); // angVel
  s.i32(); // frozen
  // `(version >= 0x22c && subVersion < 0x84) || subVersion >= 0x8b` — true either
  // way for everything this reader accepts.
  s.reference((self) => readThing(self, readers)); // editingPlayer
}

/** `PPos`: where the Thing is, and whose bone it is. */
export function readPos(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  s.reference((self) => readThing(self, readers)); // thingOfWhichIAmABone
  s.i32(); // animHash
  s.matrix(); // worldPosition; localPosition is regenerated above 0x341
}

/** `PJoint`: the connector between two Things. Long, and all of it fixed-width. */
export function readJoint(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  s.reference((self) => readThing(self, readers)); // a
  s.reference((self) => readThing(self, readers)); // b
  s.vector3(); // aContact
  s.vector3(); // bContact
  s.f32(); // length
  s.f32(); // angle
  s.f32(); // offsetTime
  s.bool(); // invertAngle
  s.resource(); // settings
  s.array((self) => self.i32()); // boneIdx
  s.vector4(); // boneLengths
  s.i32(); // type
  s.f32(); // strength
  s.bool(); // stiff
  s.vector3(); // slideDir
  s.i32(); // animationPattern
  s.f32(); // animationRange
  s.f32(); // animationTime
  s.f32(); // animationPhase
  s.f32(); // animationSpeed
  s.f32(); // animationPause
  s.f32(); // aAngleOffset
  s.f32(); // bAngleOffset
  s.f32(); // modStartFrames
  s.f32(); // modDeltaFrames
  s.f32(); // modScale
  s.f32(); // renderScale
  s.i32(); // jointSoundEnum
  s.f32(); // tweakTargetMaxLength
  s.f32(); // tweakTargetMinLength
  s.bool(); // currentlyEditing
  s.bool(); // hideInPlayMode
  s.i32(); // behaviour
  if (s.revision.subVersion >= 0xed) {
    const count = s.i32();
    for (let i = 0; i < count; i += 1) s.vector3(); // railKnotVector
  }
  if (s.revision.subVersion >= 0x197) s.u8(); // railInteractions
  if (s.revision.subVersion >= 0x19f) {
    s.bool(); // canBeTweakedByPoppetPowerup
    s.bool(); // createdByPoppetPowerup
  }
  if (s.revision.subVersion >= 0x1a4) s.bool(); // oldJointOutputBehavior
}

/** `PTrigger`: the volume a switch senses in. */
export function readTrigger(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  s.u8(); // triggerType, enum8
  things(s, readers); // inThings
  s.f32(); // radiusMultiplier
  if (s.revision.subVersion >= 0x2a) s.u8(); // zRangeHundreds
  s.bool(); // allZLayers
  s.f32(); // hysteresisMultiplier
  s.bool(); // enabled
  s.f32(); // zOffset
  if (s.revision.subVersion >= 0x90) s.s32(); // scoreValue
}

/**
 * `Polygon`: the outline a shape is cut from.
 *
 * The vertex list is two or three floats each depending on a `requiresZ` flag
 * that follows the count -- the one place in this format where an array's
 * element size is decided by a later field.
 */
function readPolygon(s: Serializer): void {
  const count = s.i32();
  const requiresZ = s.bool();
  for (let i = 0; i < count; i += 1) {
    if (requiresZ) s.vector3();
    else {
      s.f32();
      s.f32();
    }
  }
  s.array((self) => self.i32()); // loops
}

/** `ContactCache`: who this shape is touching. */
function readContactCache(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const count = s.i32();
  for (let i = 0; i < count; i += 1) {
    // A `Contact` is a reference to another Thing's PShape plus a flag byte.
    s.reference((self) => readShape(self, readers));
    s.u8();
  }
  s.bool(); // contactsSorted
  if (s.revision.subVersion < 0x46) s.bool(); // cacheDirtyButRecomputed
}

/**
 * `PShape`: the physical outline, its material and every tweak on it.
 *
 * The longest of the common parts, and almost all of it fixed-width. ⚠️ Three of
 * its gates are on `version` inside the range this reader accepts, so they are
 * not constant across the corpus: `stickiness`/`grabbability`/`grabFilter` need
 * `0x3bd` and the corpus starts at `0x3b8`, the opacity pair needs `0x3c1`, and
 * `canCollect` needs `0x3e2`. A reader written against one file's revision and
 * assumed constant would desynchronise on the others.
 */
export function readShape(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version, subVersion } = s.revision;
  readPolygon(s);
  s.resource(); // material
  s.resource(); // oldMaterial
  s.f32(); // thickness
  s.f32(); // massDepth
  s.i32(); // color -- a packed ARGB above 0x389, four floats below it
  s.f32(); // brightness
  s.f32(); // bevelSize
  s.matrix(); // COM
  s.i32(); // behavior
  s.i32(); // colorOff
  s.f32(); // brightnessOff
  s.u16(); // lethalType -- an enum32 at or below 0x345, a u16 after
  s.i32(); // soundEnumOverride
  s.u8(); // playerNumberColor -- an i32 at or below 0x367
  s.i16(); // flags -- an i8 at or below 0x345
  readContactCache(s, readers);
  if (version >= 0x3bd) {
    s.u8(); // stickiness
    s.u8(); // grabbability
    s.u8(); // grabFilter
  }
  if (version >= 0x3c1) {
    s.u8(); // colorOpacity
    s.u8(); // colorOffOpacity
  }
  if (subVersion >= 0x12c) s.u8(); // colorShininess
  if (version >= 0x3e2) s.bool(); // canCollect
  if (subVersion >= 0x42) {
    if (subVersion < 0xc6) s.u8();
    s.bool(); // ghosty
  }
  if (subVersion >= 0x186) s.bool(); // defaultClimbable
  if (subVersion >= 0x4b) s.bool(); // currentlyClimbable
  if (subVersion >= 0x63) s.bool(); // headDucking
  if (subVersion >= 0x82) s.bool(); // isLBP2Shape
  if (subVersion >= 0x8a) s.bool(); // isStatic
  if (subVersion >= 0xe6) s.bool(); // collidableSackboy
  if (subVersion >= 0x11a) {
    s.bool(); // partOfPowerUp
    s.bool(); // cameraExcluderIsSticky
  }
  if (subVersion >= 0x19a) s.bool(); // ethereal
  if (subVersion >= 0x120 && subVersion < 0x135) s.u8();
  if (subVersion >= 0x149) s.u8(); // zBias
  if (subVersion >= 0x14c) {
    s.u8(); // fireDensity
    s.u8(); // fireLifetime
  }
}

/**
 * `NetworkPlayerID`: who made this. 36 fixed bytes above version 0x234.
 *
 * `NetworkOnlineID` is 16 bytes of PSN id, a terminator and three of padding;
 * the outer struct adds two 8-byte blocks. Below 0x234 each block is length-
 * prefixed, which this reader never sees.
 */
function readNetworkPlayerId(s: Serializer): void {
  s.bytes(16); // handle.data
  s.u8(); // handle.term
  s.bytes(3); // handle.dummy
  s.bytes(8); // opt
  s.bytes(8); // reserved
}

/**
 * `PGroup`: the sticker-panel grouping, its creator and the plan it came from.
 *
 * ⚠️ `planDescriptor` is a **descriptor** resource, not a live one: it omits the
 * leading flags word that `resource()` reads by default. Getting that wrong
 * costs four bytes and desynchronises at the next Thing.
 */
export function readGroup(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version } = s.revision;
  readNetworkPlayerId(s); // creator
  s.resource(true); // planDescriptor, a descriptor
  if (version >= 0x267) {
    s.reference((self) => readThing(self, readers)); // emitter
    s.i32(); // lifetime
    s.i32(); // aliveFrames
  }
  if (version >= 0x341) s.u8(); // flags
}

/** Everything implemented so far, ready to hand to `readLevel`. */
export function partReaders(): Map<string, PartReader> {
  const readers = new Map<string, PartReader>();
  const bind = (name: string, read: (s: Serializer, r: ReadonlyMap<string, PartReader>) => void) => {
    readers.set(name, (s) => read(s, readers));
  };
  bind('BODY', readBody);
  bind('POS', readPos);
  bind('JOINT', readJoint);
  bind('TRIGGER', readTrigger);
  bind('SHAPE', readShape);
  bind('GROUP', readGroup);
  return readers;
}

export { SerializerError };
