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
import { readThing, readThingRef, type PartReader, type Thing } from './thing.ts';

/** An array of Thing references — cwlib's `thingarray`. */
function things(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const count = s.i32();
  for (let i = 0; i < count; i += 1) readThingRef(s, readers);
}

/** `PBody`: velocities, a frozen flag and whoever is dragging it about. */
export function readBody(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  s.vector3(); // posVel
  s.f32(); // angVel
  s.i32(); // frozen
  // `(version >= 0x22c && subVersion < 0x84) || subVersion >= 0x8b` — true either
  // way for everything this reader accepts.
  readThingRef(s, readers); // editingPlayer
}

/**
 * `PPos`: where the Thing is, and whose bone it is.
 *
 * Returns `worldPosition`, so `thing.parts.get('POS')` is the 4x4 itself. It is
 * kept rather than stepped over because a component on an **open** circuit board
 * has no stored board cell -- see `boardCell` below, which is how one is
 * recovered.
 *
 * Column-major, as cwlib's `m44` hands the 16 floats straight to JOML's
 * `Matrix4f.set(float[])`: element 12..14 is the translation, and 0..2 / 4..6 /
 * 8..10 are the basis columns.
 */
export function readPos(s: Serializer, readers: ReadonlyMap<string, PartReader>): Float32Array {
  readThingRef(s, readers); // thingOfWhichIAmABone
  s.i32(); // animHash
  // Below 0x341 the local matrix is STORED as well; from 0x341 the game keeps
  // only the world one and regenerates the local. The old comment here said
  // "localPosition is regenerated above 0x341", which is true and was written as
  // if it were true everywhere -- so every pre-0x341 Thing was read 64 bytes
  // short. cwlib `PPos.serialize`.
  if (s.revision.version < 0x341) s.matrix(); // localPosition
  return s.matrix(); // worldPosition
}

/** `PJoint`: the connector between two Things. Long, and all of it fixed-width. */
export function readJoint(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  readThingRef(s, readers); // a
  readThingRef(s, readers); // b
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
  // ❗ **`requiresZ` arrives at 0x341, and below it there is no flag byte at
  // all** -- cwlib `Polygon.serialize` takes an early return where every vertex
  // is a v3. Reading the flag anyway costs a byte and then picks the vertex
  // width from whatever that byte happened to be.
  const requiresZ = s.revision.version < 0x341 ? true : s.bool();
  for (let i = 0; i < count; i += 1) {
    if (requiresZ) s.vector3();
    else {
      s.f32();
      s.f32();
    }
  }
  // ⚠️ An `intvector`, not an array: see `Serializer.intVector`.
  s.intVector(); // loops
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
  if (version >= 0x15c) s.resource(); // oldMaterial
  s.f32(); // thickness
  if (version >= 0x227) s.f32(); // massDepth
  // ❗ **The colour is four floats until 0x389 and a packed ARGB after.** The
  // comment here used to say exactly that above a line that always read the
  // packed form -- 12 bytes short on every pre-0x389 Thing. cwlib `PShape`.
  if (version <= 0x389) s.vector4();
  else s.i32(); // color
  if (version >= 0x301) s.f32(); // brightness
  s.f32(); // bevelSize
  if (version <= 0x340 || version >= 0x38e) s.matrix(); // COM
  if (version <= 0x306) {
    s.u8(); // interactPlayMode
    s.u8(); // interactEditMode
  }
  if (version >= 0x303) {
    s.i32(); // behavior
    if (version < 0x38a) s.vector4();
    else s.i32(); // colorOff
    s.f32(); // brightnessOff
  }
  if (version <= 0x345) s.i32(); // lethalType, an enum32 here and a u16 after
  else s.u16();
  if (version < 0x2b5) {
    // The flags word does not exist yet; three bools stand in for its bits.
    s.bool(); // COLLIDABLE_GAME
    if (version >= 0x224) s.bool(); // COLLIDABLE_POPPET
    s.bool(); // COLLIDABLE_WITH_PARENT
  }
  s.i32(); // soundEnumOverride
  if (version >= 0x29d && version < 0x30c) {
    s.f32(); // restitution
    if (version < 0x2b5) s.u8();
  }
  if (version >= 0x2a3) {
    if (version <= 0x367) s.i32();
    else s.u8(); // playerNumberColor
  }
  if (version >= 0x2b5) {
    if (version <= 0x345) s.u8();
    else s.i16(); // flags
  }
  if (version >= 0x307) readContactCache(s, readers);
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
  // ❗ Below 0x341 the flags byte does not exist; three separate bools carry
  // COPYRIGHT, EDITABLE and PICKUP_ALL_MEMBERS instead, each at its own gate.
  if (version >= 0x18e && version < 0x341) s.bool(); // COPYRIGHT
  readNetworkPlayerId(s); // creator
  s.resource(true); // planDescriptor, a descriptor
  if (version >= 0x25e && version < 0x341) s.bool(); // EDITABLE
  if (version >= 0x267) {
    readThingRef(s, readers); // emitter
    s.i32(); // lifetime
    s.i32(); // aliveFrames
  }
  if (version >= 0x26e && version < 0x341) s.bool(); // PICKUP_ALL_MEMBERS
  if (version >= 0x30f && version < 0x341) s.bool(); // mainSelectableObject
  if (version >= 0x341) s.u8(); // flags
}

/**
 * `LevelSettings`: one lighting preset. `PLevelSettings` is one of these
 * inline, followed by a list of the presets a level can cross-fade between.
 */
function readLevelSettings(s: Serializer): void {
  const { version, subVersion } = s.revision;
  s.vector3(); // sunPosition
  s.f32(); // sunPositionScale
  s.vector4(); // sunColor
  s.vector4(); // ambientColor
  s.f32(); // sunMultiplier
  s.f32(); // exposure
  s.vector4(); // fogColor
  s.f32(); // fogNear
  s.f32(); // fogFar
  s.vector4(); // rimColor
  s.vector4(); // rimColor2
  if (version >= 0x325) {
    s.f32(); // bakedShadowAmount
    s.f32(); // bakedShadowBlur
    s.f32(); // bakedAOBias
    s.f32(); // bakedAOScale
    s.f32(); // dynamicAOAmount
    s.f32(); // dofNear
  }
  if (version >= 0x326) s.f32(); // dofFar
  if (version >= 0x331) {
    s.f32(); // zEffectAmount
    s.f32(); // zEffectBright
    s.f32(); // zEffectContrast
  }
  if (subVersion >= 0x7a) {
    s.f32(); // dofNear2
    s.f32(); // dofFar2
    if (subVersion >= 0xce) s.f32(); // dofFar3
  }
}

/** `PLevelSettings`: the lighting, inline, then the presets and the backdrop. */
export function readLevelSettingsPart(s: Serializer): void {
  const { version, subVersion } = s.revision;
  readLevelSettings(s); // the superclass, serialised first
  if (version >= 0x153) {
    const count = s.i32();
    for (let i = 0; i < count; i += 1) readLevelSettings(s);
  }
  s.str(); // backdropAmbience
  if (version >= 0x2f3) s.resource(); // backdropMesh
  if (subVersion >= 0xaf) {
    s.i32(); // backgroundRepeatFlags
    s.f32(); // backgroundSkyHeight
  }
}

/**
 * `PGeneratedMesh`: the extruded mesh a shape gets its look from.
 *
 * ⚠️ The visibility flag is a `bool` while `subVersion < 0xfb` and an `i8` at or
 * above it — the same byte either way, but the *gate* differs, so a file with a
 * subVersion in between would read neither. Both branches are here.
 */
export function readGeneratedMesh(s: Serializer): void {
  const { version, subVersion } = s.revision;
  s.resource(); // gfxMaterial
  s.resource(); // bevel
  s.vector4(); // uvOffset
  if (version >= 0x258) s.guid(); // planGUID
  if (version >= 0x27c && subVersion < 0xfb) s.bool(); // visibilityFlags, as a bool
  if (subVersion >= 0xfb) s.u8(); // visibilityFlags, as a byte
  if (version >= 0x305) {
    s.f32(); // textureAnimationSpeed
    s.f32(); // textureAnimationSpeedOff
  }
  if (subVersion >= 0x34) s.bool(); // noBevel
  if (subVersion >= 0x97) s.bool(); // sharded
  if (subVersion >= 0x13d) s.bool(); // includeSides
  if (subVersion >= 0x155) s.u8(); // slideImpactDamping
  if (subVersion >= 0x13d) {
    s.u8(); // slideSteer
    s.u8(); // slideSpeed
  }
}

/** `PRenderMesh`: the mesh a Thing draws, its animation and its visibility. */
export function readRenderMesh(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version } = s.revision;
  s.resource(); // mesh
  things(s, readers); // boneThings
  s.resource(); // anim
  s.f32(); // animPos
  s.f32(); // animSpeed
  s.bool(); // animLoop
  s.f32(); // loopStart
  s.f32(); // loopEnd
  s.i32(); // editorColor -- four floats at or below 0x31a
  s.u8(); // castShadows, enum8
  s.bool(); // RTTEnable
  s.u8(); // visibilityFlags -- a bool at or below 0x2e2
  s.f32(); // poppetRenderScale
  if (version > 0x1f5 && version < 0x34d) {
    s.f32(); // parentDistanceFront
    s.f32(); // parentDistanceSide
  }
}

/**
 * `PSwitchKey`: the colour and name of a switch's key.
 *
 * ⚠️ `hideInPlayMode` and `isDummy` swap encodings twice. Below subVersion
 * 0x132 they share one byte and its layout changes again at version 0x3ed --
 * which is *inside* the corpus, so both branches are live here.
 */
export function readSwitchKey(s: Serializer): void {
  const { version, subVersion } = s.revision;
  s.s32(); // colorIndex
  if (version >= 0x2dc) s.wstr(); // name
  if (subVersion < 0x132 && version > 0x1bc) {
    if (version < 0x3ed) s.bool(); // hideInPlayMode
    else s.u8(); // hideInPlayMode and isDummy, packed into 0x80 and 0x40
  } else {
    if (version > 0x1bc) s.bool(); // hideInPlayMode
    if (subVersion >= 0x132) s.bool(); // isDummy
  }
}

/** `Decoration`: one sticker or decoration stuck to a Thing. */
function readDecoration(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version, subVersion } = s.revision;
  s.reference((self) => readRenderMesh(self, readers)); // renderMesh
  s.matrix(); // offset
  s.i32(); // parentBone
  s.i32(); // parentTriVert
  s.f32(); // baryU
  s.f32(); // baryV
  s.f32(); // decorationAngle
  s.s32(); // onCostumePiece
  s.s32(); // earthDecoration
  s.f32(); // decorationScale
  if (version >= 0x214) s.i16(); // placedBy
  s.bool(); // reversed
  if (subVersion >= 0xc4) s.bool(); // hasShadow
  if (subVersion >= 0x16c) s.bool(); // isQuest
  if (version >= 0x215) s.i32(); // playModeFrame
  if (version >= 0x25b) s.guid(); // planGUID
}

/** `PDecorations`: just the list. */
export function readDecorations(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const count = s.i32();
  for (let i = 0; i < count; i += 1) readDecoration(s, readers);
}

/**
 * A list the corpus never populates.
 *
 * Reading a zero count costs nothing; a non-zero one means this level uses a
 * structure that has never been exercised, and saying so beats inventing a
 * layout that would desynchronise everything after it.
 */
function emptyList(s: Serializer, what: string): void {
  const count = s.i32();
  if (count !== 0) {
    throw new SerializerError(
      `${what} has ${count} entries and no reader — it is empty everywhere in the ` +
        `corpus this was built against`,
    );
  }
}

/** `Decal`: one sticker. */
function readDecal(s: Serializer): void {
  const { version } = s.revision;
  s.resource(); // texture
  s.f32(); // u
  s.f32(); // v
  s.f32(); // xvecu
  s.f32(); // xvecv
  s.f32(); // yvecu
  s.f32(); // yvecv
  if (version >= 0x260) s.i16(); // color
  if (version >= 0x158) {
    s.u8(); // type, enum8
    s.i16(); // metadataIndex
    // ⚠️ Version-dependent *inside* the corpus: 0x3b8 and 0x3ba have this, the
    // rest do not.
    if (version <= 0x3ba) s.i16(); // numMetadata
  }
  if (version >= 0x214) s.i16(); // placedBy
  if (version >= 0x215) s.i32(); // playModeFrame
  if (version >= 0x219) s.bool(); // scorchMark
  if (version >= 0x34c) s.resource(true); // plan, a descriptor
  else if (version >= 0x25b) s.guid();
}

/** `PStickers`: the decals on a Thing, plus the costume and eyetoy lists. */
export function readStickers(s: Serializer): void {
  const { version } = s.revision;
  const decals = s.i32();
  for (let i = 0; i < decals; i += 1) readDecal(s);
  const costumes = s.i32();
  for (let i = 0; i < costumes; i += 1) {
    const n = s.i32();
    for (let j = 0; j < n; j += 1) readDecal(s);
  }
  // ⚠️ `paintControl` exists only up to 0x3ba, and the corpus starts at 0x3b8.
  if (version >= 0x158 && version <= 0x3ba) {
    const n = s.i32();
    for (let i = 0; i < n; i += 1) s.bytes(4); // x, y, startRadius, endRadius
  }
  if (version >= 0x15d) {
    const n = s.i32();
    for (let i = 0; i < n; i += 1) readEyetoyData(s);
  }
}

/** `PCheckpoint`: a spawn point. Almost all of its later fields are subVersion-gated. */
export function readCheckpoint(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version, subVersion } = s.revision;
  if (subVersion > 0x101) s.u8();
  else s.bool(); // activeFlags
  s.i32(); // activationFrame
  if (version >= 0x1a7) s.s32(); // spawnsLeft
  if (version >= 0x1c6) s.s32(); // maxSpawnsLeft
  if (version >= 0x1eb) s.bool(); // instanceInfiniteSpawns
  if (version >= 0x1f3) {
    things(s, readers); // spawningList
    s.i32(); // spawningDelay
  }
  if (version >= 0x1fa) s.i32(); // lifeMultiplier
  if (version >= 0x2ae && subVersion < 0x100) s.i32(); // teamFilter
  if (subVersion >= 0x1 && subVersion < 0x127) s.u8(); // persistPoint
  if (subVersion >= 0x88) {
    if (subVersion <= 0x12a) s.resource();
    if (subVersion >= 0xc5) s.s32(); // creatureToSpawnAs
  }
  if (subVersion >= 0xcb) s.bool(); // isStartPoint
  if (subVersion >= 0xd5) s.bool(); // linkVisibleOnPlanet
  if (subVersion >= 0x108 && subVersion < 0x129) s.u8();
  if (subVersion >= 0xcb) s.wstr(); // name
  if (subVersion >= 0xe4) s.i32();
  if (subVersion >= 0xd1) s.wstr();
  if (subVersion >= 0x101) {
    s.i32(); // checkpointType
    s.i32(); // teamFlags
  }
  if (subVersion >= 0x15a) s.bool(); // enableAudio
  if (subVersion >= 0x191) s.bool(); // continueMusic
  if (subVersion >= 0x199) {
    s.i32(); // creatureToChangeBackTo
    s.bool(); // changeBackGate
  }
  if (subVersion >= 0x19b) s.bool(); // persistLives
}

/**
 * `PPhysicsTweak`: the movement tweaker.
 *
 * ⚠️ Two of its blocks are **data-dependent**, not revision-dependent: the move
 * recording appears only when `configuration` is 0xd, and the attract-o-gel
 * block only when it is 0xe. A reader that ignores the value it just read will
 * work on every level that happens not to use those tools.
 */
export function readPhysicsTweak(s: Serializer): void {
  const { version, subVersion } = s.revision;
  s.f32(); // tweakGravity
  if (version > 0x2ff) s.f32(); // tweakBuoyancy
  if (version > 0x280) s.vector3(); // tweakDampening
  s.vector3(); // input
  s.vector3(); // middleVel
  if (version > 0x280) s.f32(); // velRange
  if (version > 0x280) {
    s.f32(); // accelStrength
    if (version > 0x285) s.f32(); // decelStrength
  }
  if (subVersion > 0xa3) {
    s.u8(); // directionModifier
    s.u8(); // movementModifier
  }
  s.bool(); // localSpace
  let configuration = 0;
  if (version > 0x278) configuration = s.i32();
  if (version > 0x282) s.bool(); // hideInPlayMode
  if (version > 0x28d) s.i32(); // colorIndex
  if (version > 0x2db) s.wstr(); // name
  if (version < 0x3e8) {
    if (version > 0x2ad) s.u8(); // teamFilter
  } else if (subVersion < 0x132) {
    if (version >= 0x2ae) s.u8(); // teamFilter
  } else {
    s.i32(); // followerPlayerMode
  }
  if (version > 0x2c5) s.i32(); // behavior
  if (version > 0x2dc) {
    s.bool(); // allowInOut
    s.bool(); // allowUpDown
    s.f32(); // minRange
    s.f32(); // maxRange
    s.bool(); // followKey
  }
  if (version > 0x381) s.f32(); // angleRange
  if (version > 0x2fe) s.bool(); // flee
  if (subVersion > 0x6f) s.bool(); // stabiliser
  if (subVersion > 0x12f) {
    s.bool(); // shardDephysicalised
    s.bool(); // shardPhysicsAudio
  }
  if (subVersion > 0x43) s.bool(); // isLBP2PhysicsTweak
  if (version > 0x36a) {
    s.f32(); // maximumMass
    s.bool(); // canPush
    s.s32(); // zBehavior
    s.f32(); // lastKnownActivation
    s.bool(); // waitingToMove
  }
  if (subVersion > 0xf6) s.u8(); // zPhase
  if (version > 0x3b8 && configuration === 0xd) {
    s.resource(); // recording
    s.f32(); // playHead
    if (version < 0x3c4) s.u8();
    s.u8(); // type
    s.u8(); // dir
    s.vector3(); // prevDesiredPos
    s.u8(); // prevDesiredPosSet
    s.matrix(); // startOrientation
    s.f32(); // speed
    if (version > 0x3c4) s.u8(); // pathIsAbsolute
  }
  if (configuration === 0xe && version > 0x3e3) {
    s.f32();
    s.i32();
    s.f32();
    s.f32();
    s.i32();
    s.f32();
    s.f32();
    s.u8();
    s.u8();
    s.u8();
    s.u8();
  }
  if (subVersion > 0x56) {
    s.i16(); // gridSnap
    s.i16(); // gridStrength
  }
  if (subVersion > 0x99) s.f32(); // gridGoalW
  if (subVersion > 0x98) s.vector3(); // gridGoal
}

/** `SwitchType` values this reader has to branch on. */
const SWITCH_STICKER = 5;
const SWITCH_MICROCHIP = 36;
const SWITCH_POCKET_ITEM = 50;
const SWITCH_DATA_SAMPLER = 65;
const SWITCH_GAME_LIVE_STREAMING_CHOICE = 75;

/** `SwitchSignal`: an activation level, a ternary state and a player index. */
function readSwitchSignal(s: Serializer): void {
  const { version } = s.revision;
  s.f32(); // activation
  if (version >= 0x310) s.s32(); // ternary
  if (version >= 0x2a3) s.i32(); // player
}

/** `SwitchTarget`: one Thing a switch drives, and which port on it. */
function readSwitchTarget(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  readThingRef(s, readers); // thing
  if (s.revision.version > 0x326) s.i32(); // port
}

/** `SwitchOutput`: one output port and everything wired to it. */
function readSwitchOutput(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  readSwitchSignal(s);
  const count = s.i32();
  for (let i = 0; i < count; i += 1) readSwitchTarget(s, readers);
  if (s.revision.version >= 0x34d) s.wstr(); // userDefinedName
}

/**
 * `PSwitch`: the logic behind every switch, sensor and gate on a circuit board.
 *
 * The longest part in the format, and the one with the most branches that depend
 * on **data rather than revision**: `stickerPlan` appears or not according to
 * the switch's own `type` (and, for a microchip, on the value of
 * `includeTouching` read a few fields earlier), and a data sampler carries an
 * extra block. Reading `type` and then ignoring it works on every level that
 * happens to use no stickers.
 */
export function readSwitch(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version, subVersion } = s.revision;
  s.bool(); // inverted
  s.f32(); // radius
  if (version >= 0x382) s.f32(); // minRadius
  s.s32(); // colorIndex
  if (version >= 0x2dc) s.wstr(); // name
  if (version >= 0x38f) s.bool(); // crappyOldLbp1Switch
  s.s32(); // behaviorOld

  if (version < 0x329) {
    s.f32(); // the single output's activation
    if (version > 0x2a2) s.i32(); // player
    const targets = s.i32();
    for (let i = 0; i < targets; i += 1) readSwitchTarget(s, readers);
  } else {
    const count = s.i32();
    for (let i = 0; i < count; i += 1) {
      s.reference((self) => readSwitchOutput(self, readers));
    }
  }

  if (version < 0x398 && version >= 0x140) s.resource(true); // stickerPlan

  if (version > 0x197) s.bool(); // hideInPlayMode
  let type = 0;
  if (version > 0x1a4) {
    // ⚠️ `enum32(type, true)` — the second argument is **signed**, not "force
    // fixed-width", so this is a zigzag varint. Read plainly it still consumes
    // the right number of bytes for small values, which is why seven levels
    // parsed anyway; what it gets wrong is the *value*, and `type` decides
    // whether a sticker plan follows. A wrong type here costs one byte, one
    // Thing later.
    type = s.s32();
    readThingRef(s, readers); // referenceThing
    readSwitchSignal(s); // manualActivation
  }

  // ⚠️ Data-dependent: only a sticker switch (or a pocket item, above subVersion
  // 0x10) carries a plan here.
  if (
    version >= 0x398 &&
    (type === SWITCH_STICKER || (type === SWITCH_POCKET_ITEM && subVersion > 0x10))
  ) {
    s.resource(true);
  }

  if (version > 0x1a4 && version < 0x368) s.f32(); // platformVisualFactor
  if (version > 0x1a4) s.s32(); // activationHoldTime
  if (version > 0x1a4) s.bool(); // requireAll

  let includeTouching = 0;
  if (version > 0x23d) {
    s.f32(); // angleRange
    includeTouching = s.s32();
    if (version >= 0x398 && type === SWITCH_MICROCHIP && includeTouching === 1) {
      s.resource(true); // stickerPlan
    }
  }

  if (subVersion > 0x165 && type === SWITCH_GAME_LIVE_STREAMING_CHOICE) {
    throw new SerializerError(
      'a live-streaming-choice switch carries fields cwlib does not implement either',
    );
  }

  if (version > 0x243) s.s32(); // bulletsRequired
  if (version === 0x244) s.i32();
  if (version > 0x244) s.s32(); // bulletsDetected
  if (version > 0x245 && version < 0x398) s.i32(); // bulletPlayerNumber
  if (version > 0x248) s.i32(); // bulletRefreshTime
  if (version >= 0x2f5) s.bool(); // resetWhenFull
  if (version > 0x24a && version < 0x327) s.bool(); // hideConnectors
  if (version > 0x272 && version < 0x398) s.i32(); // logicType
  if (version > 0x272 && version < 0x369) s.i32(); // updateFrame
  if (version > 0x272) things(s, readers); // inputList
  if (version > 0x276 && version < 0x327) readThingRef(s, readers);
  if (version > 0x283) s.bool(); // includeRigidConnectors
  if (version > 0x284 && version < 0x327) {
    s.vector4(); // customPortOffset
    s.vector4(); // customConnectorOffset
  }
  if (version > 0x28c) {
    s.f32(); // timerCount
    if (version < 0x2c4) s.u8(); // timerAutoCount
  }
  if (version > 0x2ad && subVersion < 0x100) s.i32(); // teamFilter
  if (version > 0x2c3) s.i32(); // behavior, enum32
  if (version < 0x329 && version > 0x2c3) s.s32();
  if (version > 0x2c3) {
    s.i32(); // randomBehavior
    s.i32(); // randomPattern
    s.i32(); // randomOnTimeMin
    s.i32(); // randomOnTimeMax
    s.i32(); // randomOffTimeMin
    s.i32(); // randomOffTimeMax
    if (version < 0x3ad) {
      s.u8(); // randomPhaseOn
      s.s32(); // randomPhaseTime
    }
    s.bool(); // retardedOldJoint
  }
  if (version > 0x30f) s.i32(); // keySensorMode
  if (version > 0x34c) {
    s.i32(); // userDefinedColour
    s.bool(); // wiresVisible
  }
  if (version > 0x34f) s.u8(); // bulletTypes
  if (version > 0x390) s.bool(); // detectUnspawnedPlayers
  if (subVersion > 0x216) s.u8(); // unspawnedBehavior
  if (version > 0x3a4) s.bool(); // playSwitchAudio
  if (version > 0x3ec) s.u8(); // playerMode

  // ⚠️ Data-dependent again, and the block is not small.
  if (version > 0x3ee && type === SWITCH_DATA_SAMPLER) {
    s.i32(); // labelIndex
    s.bytes(16); // creatorID.data
    s.u8(); // creatorID.term
    s.bytes(3); // creatorID.dummy
    s.wstr(); // labelName
    s.array((self) => self.f32()); // analogue
    s.array((self) => self.u8()); // ternary
  }

  if (subVersion > 0x21) s.bool(); // relativeToSequencer
  if (subVersion > 0x2f) s.u8(); // layerRange
  if (subVersion > 0x7a) {
    s.bool(); // breakSound
    s.s32(); // colorTimer
  }
  if (subVersion > 0x67) s.bool(); // isLbp3Switch
  if (subVersion > 0x68) s.bool(); // randomNonRepeating
  if (subVersion > 0x102) s.i32(); // stickerSwitchMode
}

/** One component placed on a circuit board: which Thing, and where on the grid. */
export interface Component {
  readonly thing?: Thing;
  readonly x: number;
  readonly y: number;
}

/** What a `MICROCHIP` part yields: the board's name and what is on it. */
export interface Microchip {
  readonly name: string;
  readonly components: readonly Component[];
  /**
   * The board's own extent, in world units.
   *
   * ❗ **`sizeY` is what routes a track to a mixer channel.** The engine cuts the
   * board into `NumChannels` horizontal bands -- `floor(sizeY / 105 + 0.5)` rows
   * divided by the channel count -- and a placement's channel is its band. Both
   * fields were read and discarded here until 2026-09-05; see `channelVolume` in
   * `project.ts` and answered question 9.
   */
  readonly sizeX: number;
  readonly sizeY: number;
  /**
   * The board Thing.
   *
   * ⚠️ Needed because `components` is **empty while the board is open in the
   * editor**: the game promotes the components to real Things parented to the
   * board and stops maintaining the compact list. `musicSequencers` in
   * `level.ts` rebuilds it from the Thing graph in that case.
   */
  readonly board?: Thing;
}

/**
 * The five XML entities the editor escapes with, and nothing else.
 *
 * ⚠️ Deliberately not the HTML set. The game escapes for XML, so `&nbsp;` and
 * the other 250-odd HTML names would be a guess; anything not listed here is
 * left exactly as it was found, which is the safe way to be wrong.
 */
const NAMED_ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['apos', "'"],
  ['quot', '"'],
  ['lt', '<'],
  ['gt', '>'],
]);

/**
 * Undo the editor's XML escaping in a creator-authored name.
 *
 * **Measured over the 22-level dump**: `&apos;` appears 46 times across the
 * sequencer names and 416 times across the instrument names, `&amp;` 7 times,
 * and nothing else does. Nineteen sequencers are titled entirely in quotes --
 * `&apos;Sands of the Cosmos&apos;` -- so without this the quotes are the first
 * thing a user sees on the sequencer they came to hear.
 *
 * ⚠️ **One pass, not five.** Replacing `&amp;` and then `&apos;` would turn a
 * literal `&amp;apos;` into an apostrophe -- the classic double-unescape. A
 * single regex sees each `&…;` once, so `&amp;apos;` correctly comes out as the
 * text `&apos;`.
 *
 * ⚠️ **This is a decode at read time, so a writer has to re-escape.** Step 7,
 * round-trip export, must put `&` and `'` back before writing a name, or every
 * save-and-reload strips another layer. There is deliberately no encoder here
 * yet: writing one now would be untested speculation about which characters the
 * editor escapes, and the corpus only proves two of them.
 */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body[0] !== '#') return NAMED_ENTITIES.get(body) ?? whole;
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    // A lone surrogate or an out-of-range code point would throw, and an
    // unreadable escape is better left visible than turned into a replacement
    // character.
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return whole;
    if (code >= 0xd800 && code <= 0xdfff) return whole;
    return String.fromCodePoint(code);
  });
}

/**
 * `PMicrochip`: a circuit board.
 *
 * This is the part the whole level parse exists for — a music sequencer is a
 * `SEQUENCER` on a Thing whose `MICROCHIP` holds one component per instrument,
 * and the component's `x`/`y` are the board cell that `project.ts` turns into a
 * track's step offset and row.
 */
export function readMicrochip(
  s: Serializer,
  readers: ReadonlyMap<string, PartReader>,
): Microchip {
  const { version, subVersion } = s.revision;
  const board = readThingRef(s, readers); // circuitBoardThing
  if (version >= 0x283) s.bool(); // hideInPlayMode
  if (version >= 0x2b8) s.bool(); // wiresVisible
  if (version >= 0x2e4) s.s32(); // lastTouched
  if (version >= 0x2e9) s.vector4(); // offset

  let name = '';
  let sizeX = 0;
  let sizeY = 0;
  const components: Component[] = [];
  if (version >= 0x34d) {
    name = decodeEntities(s.wstr());
    const count = s.i32();
    for (let i = 0; i < count; i += 1) {
      const thing = readThingRef(s, readers);
      const x = s.f32();
      const y = s.f32();
      s.f32(); // angle
      s.f32(); // scaleX
      s.f32(); // scaleY
      s.bool(); // flipped
      components.push({ thing, x, y });
    }
    sizeX = s.f32(); // circuitBoardSizeX
    sizeY = s.f32(); // circuitBoardSizeY
  }

  if (subVersion >= 0x1d) s.bool(); // keepVisualVertical
  if (subVersion >= 0x2d) s.u8(); // broadcastType
  return { name, components, board, sizeX, sizeY };
}

/** `CameraNode`: one framing in a camera zone's list. */
function readCameraNode(s: Serializer): void {
  s.vector4(); // targetBox
  s.vector3(); // pitchAngle
  s.f32(); // zoomDistance
  s.bool(); // localSpaceRoll
}

/** `PCameraTweak`: a camera zone and its cut-scene settings. */
export function readCameraTweak(s: Serializer): void {
  const { version, subVersion } = s.revision;
  if (version < 0x37e) {
    s.vector3(); // pitchAngle
    s.vector4(); // targetBox
  }
  s.vector4(); // triggerBox
  if (subVersion >= 0x1b) {
    s.u8(); // triggerLayerOffset
    s.u8(); // triggerLayerDepth
    if (subVersion >= 0x3d) s.bool(); // isCameraZRelative
  }
  if (version < 0x37e) s.f32(); // zoomDistance
  s.f32(); // positionFactor
  if (version >= 0x1f5) s.i32(); // photoBoothTimerLength
  s.s32(); // cameraType -- a u8 below 0x1d7
  if (version > 0x196 && version < 0x2c4) s.f32(); // activationLimit
  if (version >= 0x1ff) s.bool(); // disableZoomMode
  if (version >= 0x26a) s.bool(); // requireAll
  if (version >= 0x2ba) s.bool(); // motionControllerZone
  if (version >= 0x2c4) s.i32(); // behavior
  if (version >= 0x2f8 && version < 0x37e) s.u8();
  if (version >= 0x2eb) {
    s.u8(); // cutSceneTransitionType
    s.i32(); // cutSceneHoldTime
    s.bool(); // cutSceneSkippable
  }
  if (subVersion >= 0x9f) s.bool(); // cutSceneUseHoldTime
  if (version > 0x2ed) {
    s.u8(); // cutSceneTimeSinceUsed
    s.i32(); // cutSceneTransitionTime
    if (version < 0x35a) s.bool();
  }
  if (version > 0x359) s.i32(); // cutSceneColour
  if (version > 0x2ed) s.bool(); // cutSceneMovieMode
  if (version > 0x2f7) {
    s.f32(); // cutSceneDepthOfField
    s.f32(); // cutSceneFog
  }
  if (version > 0x2f8) s.f32(); // cutSceneFOV
  if (version > 0x315) s.f32(); // cutSceneShake
  if (version > 0x318) s.bool(); // fadeAudio
  if (version > 0x33e) s.bool(); // oldStyleCameraZone
  if (version > 0x369) s.bool(); // cutSceneTrackPlayer
  if (version > 0x395) s.bool(); // cutSceneSendsSignalOnCancelled
  if (version > 0x396) s.bool(); // cutSceneWasActiveLastFrame
  if (version > 0x37d) {
    const count = s.i32();
    for (let i = 0; i < count; i += 1) readCameraNode(s);
  }
  if (subVersion > 0x7d) s.f32(); // frontDOF
  if (subVersion > 0x79) s.f32(); // sackTrackDOF
  if (subVersion > 0x7f) s.bool(); // allowSmoothZTransition
}

/** What an `INSTRUMENT` part yields — one placement on a sequencer's board. */
export interface InstrumentPart {
  /** The `RInstrument` GUID, or 0 when the placement is empty. */
  readonly guid: number;
  readonly name: string;
  readonly loops: number;
  readonly key: number;
  readonly scale: number;
  readonly level: number;
  readonly pan: number;
  readonly echoSend: number;
  readonly reverbSend: number;
  /** The note records, four bytes each, exactly as they sit on disk. */
  readonly notes: Uint8Array;
}

/**
 * `PInstrument`: one instrument placed on a music sequencer's board.
 *
 * The note list comes back as raw bytes rather than decoded notes, because
 * `src/core/notes.ts` already decodes that record and is the measured reader for
 * it. Four bytes each: `x | triplet<<7`, `y | end<<7`, volume, timbre.
 */
export function readInstrumentPart(s: Serializer): InstrumentPart {
  const { version } = s.revision;
  const resource = s.resource();
  const name = version >= 0x35b ? decodeEntities(s.wstr()) : '';
  s.i32(); // color
  const loops = s.i32();
  const key = s.i32();
  const scale = s.i32();
  const level = s.f32();
  const pan = s.f32();
  const echoSend = s.f32();
  const reverbSend = s.f32();
  if (version >= 0x389) {
    s.i16(); // scrollX
    s.i16(); // scrollY
    s.i16(); // cursorX
    s.i16(); // cursorY
  }
  const count = s.i32();
  const notes = s.bytes(count * 4).slice();
  if (version >= 0x379) s.resource(); // icon
  return {
    guid: resource?.guid ?? 0,
    name,
    loops,
    key,
    scale,
    level,
    pan,
    echoSend,
    reverbSend,
    notes,
  };
}

/** What a `SEQUENCER` part yields. */
export interface SequencerPart {
  readonly tempo: number;
  readonly swing: number;
  readonly echoFeedback: number;
  readonly echoTime: number;
  readonly echoMix: number;
  readonly reverbSettings: number;
  readonly loop: boolean;
  readonly startPoint: number;
  readonly numChannels: number;
  readonly volumes: readonly number[];
  /** False for an animation or logic sequencer — those carry no music. */
  readonly musicSequencer: boolean;
}

/**
 * `PSequencer`: the music sequencer itself.
 *
 * ⚠️ `volume` is a **fixed six floats**, not a length-prefixed array. Six is the
 * channel count the UI exposes; `numChannels` says how many are in use and is
 * read separately.
 */
export function readSequencerPart(s: Serializer, readers: ReadonlyMap<string, PartReader>): SequencerPart {
  const { version, subVersion } = s.revision;
  const tempo = s.f32();
  const swing = s.f32();
  const echoFeedback = s.f32();
  const echoTime = s.f32();
  const echoMix = s.f32();
  const reverbSettings = version > 0x370 ? s.i32() : 0;
  const loop = version > 0x36e ? s.bool() : false;
  const startPoint = s.f32();
  const numChannels = s.i32();
  const volumes: number[] = [];
  for (let i = 0; i < 6; i += 1) volumes.push(s.f32());
  if (version > 0x369) {
    s.f32(); // playHead
    s.bool(); // isPlaying
  }
  const musicSequencer = version > 0x36c ? s.bool() : false;
  if (subVersion > 0x28) s.bool(); // animationSequencer
  if (version > 0x371) s.i32(); // behavior
  if (version > 0x3a0) {
    s.i32(); // triggerPlayer
    readThingRef(s, readers); // previewThing
  }
  return {
    tempo,
    swing,
    echoFeedback,
    echoTime,
    echoMix,
    reverbSettings,
    loop,
    startPoint,
    numChannels,
    volumes,
    musicSequencer,
  };
}

/**
 * `EggLink`: the prize a bubble hands out.
 *
 * ⚠️ The painting at the end is behind a **bool it reads first**, not a
 * revision gate — `hasPainting` decides whether a resource follows.
 */
function readEggLink(s: Serializer): void {
  const { version } = s.revision;
  s.resource(); // plan
  if (version > 0x23b) s.bool(); // shareable
  if (version > 0x3e0 && s.bool()) s.resource(true); // painting
}

/** `PGameplayData`: what a Thing is worth when collected. */
export function readGameplayData(s: Serializer): void {
  const { version, subVersion } = s.revision;
  if (subVersion >= 0xef && version > 0x2d0) s.i32(); // gameplayType
  s.s32(); // fluffCost
  s.reference(readEggLink);
  s.reference((self) => {
    self.i32(); // SlotID.slotType
    self.u32(); // SlotID.slotNumber
  });
  if (version >= 0x2d1 && subVersion < 0xef) s.i32(); // gameplayType
  if (subVersion >= 0xf3) {
    s.i32(); // treasureType
    s.i16(); // treasureCount
  }
}

/** `PAudioWorld`: a sound object. */
export function readAudioWorld(s: Serializer): void {
  const { version, subVersion } = s.revision;
  s.str(); // soundName
  s.f32(); // initialVolume
  s.f32(); // initialPitch
  s.f32(); // initialParam1
  s.f32(); // maxFalloff
  s.f32(); // impactTolerance
  if (version < 0x2c4) {
    s.bool(); // triggerByFalloff
    s.bool(); // triggerByImpact
    s.bool(); // triggerBySwitch
    if (version >= 0x1ad) s.bool(); // triggerByDestroy
  } else s.i32(); // playMode, enum32
  s.bool(); // paramAffectVol
  s.bool(); // paramAffectPitch
  s.bool(); // paramAffectParam
  if (version >= 0x165) s.bool(); // isLocal
  if (version >= 0x198) s.bool(); // hideInPlayMode
  if (version >= 0x2c4) s.i32(); // behavior
  if (version >= 0x380) {
    s.guid(); // soundNames
    s.i32(); // meshColor
  }
  if (subVersion >= 0x178) s.i32(); // categoryGUID
  if (subVersion >= 0x191) s.bool(); // activatedLastFrame
}

/** `InputRecording`: a captured controller performance. */
function readInputRecording(s: Serializer): void {
  const { version } = s.revision;
  if (version > 0x28f) {
    s.bytes(s.i32()); // inputBuffer
    s.intVector(); // offsetBuffer
  }
  if (version > 0x2a5) s.intVector(); // absoluteExpressionBuffer
  if (version > 0x2dd) {
    s.matrix(); // startWorldTransform
    const count = s.i32();
    for (let i = 0; i < count; i += 1) s.matrix(); // startLocalSceneGraph
  }
  if (version > 0x2df) s.vector3(); // startFootPos
  if (version > 0x2e0) {
    const count = s.i32();
    for (let i = 0; i < count; i += 1) s.vector3(); // startVelocities
  }
  if (version > 0x3c4) s.bool(); // recordingContainsMoveData
}

/** `ActingData`: what a sackbot is performing. */
function readActingData(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version, subVersion } = s.revision;
  const thing = () => readThingRef(s, readers);
  if (version > 0x2d9) {
    s.i32(); // state
    thing(); // recordingNpc
  }
  if (version > 0x295) {
    readInputRecording(s);
    thing(); // recordingPlayer
    s.i32(); // currentFrame
  }
  if (version > 0x2a5) s.s32(); // recordingCountdown
  if (version >= 0x33e) s.resource(); // VoIPRecording
  if (subVersion >= 0xb6) s.bool(); // transformOnRestart
  if (subVersion >= 0xbd) s.u8(); // previousState
}

/** `NpcBehavior`: how a sackbot patrols, follows or acts. */
function readNpcBehavior(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version, subVersion } = s.revision;
  if (version <= 0x293) return;
  const thing = () => readThingRef(s, readers);
  thing(); // npc
  thing(); // targetThing
  s.s32(); // type
  s.i32(); // attributes
  s.f32(); // maxMoveSpeed
  s.s32(); // maxWaitTime
  if (version > 0x2e5) s.wstr(); // waypointKeyName
  if (version > 0x2d4) s.s32(); // waypointKeyColorIndex
  if (version > 0x2e5) {
    s.wstr(); // poiKeyName
    s.s32(); // poiKeyColorIndex
  }
  if (version > 0x295) s.reference((self) => readActingData(self, readers));
  if (version > 0x2ac) {
    s.f32(); // awarenessRadius
    s.i32(); // sharedStateTimer
    s.vector3(); // idleLookAtPos
  }
  if (version > 0x2d7) s.vector3(); // lastGoodPosition
  if (version > 0x2d8) s.bool(); // lastPositionValid
  if (version > 0x2ce) {
    s.vector3(); // patrolDirection
    for (let i = 0; i < 8; i += 1) s.s32(); // the patrol grid counters
  }
  if (version > 0x2e6) s.s32(); // animSet
  if (version > 0x371) {
    s.u8(); // expressionType
    s.u8(); // expressionLevel
  }
  if (version > 0x375) s.bool(); // willRecordAudio
  if (subVersion > 0xc6) s.i32(); // awarenessRange
  if (subVersion > 0x10e) s.f32(); // lookAtSpeed
  if (subVersion > 0x175) s.bool(); // showAdvancedOptions
}

/** `PSwitchInput`: an input port on a circuit board. */
export function readSwitchInput(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version } = s.revision;
  const thing = () => readThingRef(s, readers);
  if (version < 0x2c4) {
    readSwitchSignal(s);
    s.i32(); // updateFrame
  }
  thing(); // dataSource
  if (version > 0x273) s.i32(); // updateType
  if (version > 0x274) s.i32(); // lethalType
  if (version > 0x277 && version < 0x327) thing(); // portThing
  if (version > 0x287) s.bool(); // includeRigidConnectors
  if (version > 0x28a) {
    s.i32(); // lethalActivationFrame
    s.bool(); // lethalInverted
  }
  if (version > 0x297) s.bool(); // hideInPlayMode
  if (version > 0x298 && version < 0x2c4) s.bool(); // oneShot
  if (version > 0x38f) s.bool(); // disableLethalAudio
  if (version > 0x29a) s.reference((self) => readNpcBehavior(self, readers));
  if (version > 0x2aa && version < 0x2d5) s.i32(); // sackbotColor
  if (version > 0x2d4) s.s32(); // sackbotObjectColorIndex
  if (version > 0x2c3) s.i32(); // behavior
  if (version > 0x308) s.i32(); // effectDestroy
  if (version > 0x3ec) s.u8(); // playerMode
}

/** `PControlinator`: the controller seat. */
export function readControlinator(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version, subVersion } = s.revision;
  const thing = () => readThingRef(s, readers);
  thing(); // attachedPlayer
  thing(); // lastAttachedPlayer
  thing(); // prompt
  thing(); // promptPlayer
  s.i32(); // colorIndex
  s.f32(); // radius
  s.bool(); // sideMode
  s.i32(); // remoteControlState
  s.bool(); // disablePoppetControls
  s.bool(); // autoDock
  s.bool(); // overrideSackbot
  if (subVersion > 0x6e) s.bool(); // killRiderOnCreatureDeath
  thing(); // padSwitch
  if (subVersion > 0x4b) {
    // ⚠️ **One byte, not an `i32`, and the difference only shows in an
    // uncompressed stream.** With `COMPRESSED_INTEGERS` an `i32` of 0 is a
    // single varint byte, so `s.i32()` read this correctly on the whole corpus
    // -- every file in it is `cf7`. In a `cf0` chunk out of the public archive
    // the same call ate four bytes and put the reader three past the next
    // Thing's marker. Measured on chunk `9712345a…` island 48: the field is the
    // `00` at 65640 and `parentBoneOffset` begins at 65641 with `3f 80 00 00`,
    // an identity matrix whose four 1.0s land exactly on m00, m05, m10 and m15.
    // See question 36 in steering/answered-questions.md.
    s.u8(); // parentBoneIndex
    s.matrix(); // parentBoneOffset
  }
  if (version > 0x3ec) s.u8(); // playerMode
  if (subVersion > 0x189) s.u8(); // layerRange
}

/** `EmittedObjectSource`: what an emitter emits. */
function readEmittedObjectSource(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  things(s, readers);
  s.resource(); // plan
  if (s.revision.subVersion > 0xcc) {
    for (let i = 0; i < 6; i += 1) s.f32();
    s.u8();
  }
}

/**
 * `PEmitter`: the object emitter.
 *
 * ⚠️ Seven of its booleans are written **twice over** in cwlib — once under a
 * `version >= n && subVersion < 0x64` gate and again under `subVersion > 0x64`.
 * Only one of the two can fire for any given revision, so each is exactly one
 * byte; writing both conditions out is the only way to keep that true across the
 * corpus, and collapsing them to an unconditional read would break the older
 * files.
 */
export function readEmitter(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version, subVersion } = s.revision;
  /** One of the doubled booleans described above. */
  const doubled = (since: number) => {
    if ((version >= since && subVersion < 0x64) || subVersion > 0x64) s.bool();
  };

  if (version < 0x368) s.vector3(); // posVel
  s.f32(); // angVel
  s.i32(); // frequency
  s.i32(); // phase
  s.i32(); // lifetime
  doubled(0x2fe); // recycleEmittedObjects
  s.resource(); // plan
  s.i32(); // maxEmitted
  if (version >= 0x1c8) s.i32(); // maxEmittedAtOnce
  s.f32(); // speedScaleStartFrame
  s.f32(); // speedScaleDeltaFrames
  readSwitchSignal(s); // speedScale
  if (version < 0x2c4) s.f32(); // lastUpdateFrame
  if (version >= 0x137) {
    if (version < 0x314) {
      s.vector4(); // worldOffset
      s.f32(); // worldRotation
    }
    if (version >= 0x38e) s.f32(); // worldRotationForEditorEmitters
    s.f32(); // emitScale
    s.f32(); // linearVel
    if (version < 0x314) readThingRef(s, readers);
  }
  if (version >= 0x13f) s.i32(); // currentEmitted
  doubled(0x144); // emitFlip
  if (version >= 0x1ce) {
    s.vector4(); // parentRelativeOffset
    s.f32(); // parentRelativeRotation
    s.f32(); // worldZ
    s.f32(); // zOffset
    s.f32(); // emitFrontZ
    s.f32(); // emitBackZ
  }
  doubled(0x226); // hideInPlayMode
  if (version >= 0x230 && version < 0x2c4) s.bool(); // modScaleActive
  if (version >= 0x2c4) s.i32(); // behavior
  if (version >= 0x308) {
    if (version >= 0x38d) {
      s.u8(); // effectCreate
      s.u8(); // effectDestroy
    } else {
      s.i32();
      s.i32();
    }
  }
  doubled(0x32e); // ignoreParentsVelocity
  if (version >= 0x340) s.reference((self) => readEmittedObjectSource(self, readers));
  doubled(0x361); // editorEmitter
  doubled(0x38d); // isLimboFlippedForGunEmitter
  if (version >= 0x3ae) s.f32(); // the z offset cwlib names less politely
  if (subVersion >= 0x18e) s.bool();
  if ((subVersion >= 0x31 && subVersion < 0x65) || subVersion >= 0x65) s.bool(); // soundEnabled
  if (subVersion >= 0x41 && subVersion < 0x1a7) s.bool();
  if (subVersion > 0x64) s.bool(); // emitByReferenceInPlayMode
  if (subVersion > 0x75) s.bool(); // emitToNearestRearLayer
}

/** `PSpriteLight`: a light. */
export function readSpriteLight(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version, subVersion } = s.revision;
  s.vector4(); // color
  if (version >= 0x2fd) s.vector4(); // colorOff
  s.f32(); // multiplier
  if (version >= 0x30a) s.f32(); // multiplierOff
  s.f32(); // glowRadius
  s.f32(); // farDist
  s.f32(); // sourceSize
  s.resource(); // falloffTexture
  readThingRef(s, readers); // lookAt
  s.bool(); // spotlight
  if (version < 0x337) {
    s.bool(); // enableFogShadows
    s.bool(); // enableFog
  }
  if (version >= 0x139) s.f32(); // fogAmount
  if (version >= 0x13a) {
    if (version < 0x2c4) s.f32(); // onDest
    s.f32(); // onSpeed
    s.f32(); // offSpeed
    s.f32(); // flickerProb
    s.f32(); // flickerAmount
  }
  if (version >= 0x2c4) s.i32(); // behavior
  if (subVersion >= 0x113) s.bool(); // highBeam
  if (subVersion >= 0x146) s.bool(); // tracker
  if (subVersion >= 0x14a) s.u8(); // trackerType
  if (subVersion >= 0x151) {
    s.f32(); // causticStrength
    s.f32(); // causticWidth
  }
  if (subVersion >= 0x16f) {
    s.f32(); // trackingLimit
    s.f32(); // trackingAccel
    s.f32(); // trackingSpeed
    s.s32(); // movementInput
    s.s32(); // lightingInput
    s.vector3(); // beamDir
    s.vector3(); // azimuth
  }
}

/** `MachineType`: how a script field's value is stored. */
const MACHINE_BOOL = 0x1;
const MACHINE_CHAR = 0x2;
const MACHINE_S32 = 0x3;
const MACHINE_F32 = 0x4;
const MACHINE_V4 = 0x5;
const MACHINE_M44 = 0x6;
const MACHINE_OBJECT_REF = 0xb;
const MACHINE_SAFE_PTR = 0xa;

/** `ModifierType.DIVERGENT` is bit 0xc of the modifier flags. */
const MODIFIER_DIVERGENT = 1 << 0xc;

interface FieldLayout {
  readonly machineType: number;
  readonly divergent: boolean;
}

/**
 * `FieldLayoutDetails`: the name, type and modifiers of one script field.
 *
 * ⚠️ **At 0x3d9 the record stops being enums and becomes bytes**, and reading
 * the new one with the old code is invisible on a compressed stream: an `enum32`
 * is a varint there, and a machine type below 128 takes exactly the one byte a
 * `u8` would. The first UNCOMPRESSED resource -- a streaming island's plan --
 * read nine bytes too many per field and landed in the middle of the next
 * field's name, which is how "read of 1634429294 bytes" (`aimn`, out of a
 * script's own text) turned out to mean this. 101 of the corpus's 2,553 islands.
 */
function readFieldLayout(s: Serializer): FieldLayout {
  const { version } = s.revision;
  s.str(); // name
  if (version >= 0x3d9) {
    const flags = s.i16();
    const machineType = s.u8();
    s.u8(); // fishType
    s.i8(); // dimensionCount
    s.u8(); // arrayBaseMachineType
    s.i32(); // instanceOffset
    return { machineType, divergent: (flags & MODIFIER_DIVERGENT) !== 0 };
  }
  const flags = s.i32();
  const machineType = s.i32();
  if (version >= 0x145) s.i32(); // fishType
  s.i8(); // dimensionCount
  s.i32(); // arrayBaseMachineType
  s.i32(); // instanceOffset
  return { machineType, divergent: (flags & MODIFIER_DIVERGENT) !== 0 };
}

/**
 * `ScriptInstance`: a script and the values of its reflected fields.
 *
 * ⚠️ **This is the only part of the format that is genuinely self-describing,
 * and it is the only one where the layout is data.** The stream carries a field
 * table — name, modifiers, machine type — and then one value per field, sized by
 * that type. There is no way to read the values without having read the table,
 * and no way to skip a field whose type is unknown.
 *
 * ⚠️ The layout is behind a **pointer**, not a reference: the id is read raw and
 * a repeat means "the same layout as before", which for a level full of copies
 * of one script is most of them. Treating it as a plain inline struct would
 * re-read a table that is not there.
 *
 * `DIVERGENT` fields are in the table but **not** in the value stream unless the
 * `reflectDivergent` flag that precedes it says so.
 */
function readScriptInstance(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version } = s.revision;
  s.resource(); // script

  let serialize = true;
  if (version > 0x1a0) serialize = s.bool();
  if (!serialize) return;

  const pointer = s.i32();
  if (pointer === 0) return;

  let layout = s.pointers.get(pointer) as FieldLayout[] | undefined;
  if (layout === undefined) {
    const fields: FieldLayout[] = [];
    const count = s.i32();
    for (let i = 0; i < count; i += 1) fields.push(readFieldLayout(s));
    s.i32(); // instanceSize
    layout = fields;
    s.pointers.set(pointer, layout);
  }

  const reflectDivergent = version > 0x19c ? s.bool() : false;
  for (const field of layout) {
    if (field.divergent && !reflectDivergent) continue;
    switch (field.machineType) {
      case MACHINE_BOOL:
        s.bool();
        break;
      case MACHINE_CHAR:
        s.i16();
        break;
      case MACHINE_S32:
        s.i32();
        break;
      case MACHINE_F32:
        s.f32();
        break;
      case MACHINE_V4:
        s.vector4();
        break;
      case MACHINE_M44:
        s.matrix();
        break;
      case MACHINE_SAFE_PTR:
        readThingRef(s, readers);
        break;
      case MACHINE_OBJECT_REF:
        readScriptObject(s, readers);
        break;
      default:
        throw new SerializerError(
          `script field machine type 0x${field.machineType.toString(16)} has no reader`,
        );
    }
  }
}

/** `PScript`: a script attached to a Thing. */
export function readScript(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  readScriptInstance(s, readers);
}

/** `ScriptObjectType`: what a boxed script value holds. */
const OBJ_NULL = 0;
const OBJ_ARRAY_BOOL = 1;
const OBJ_ARRAY_S32 = 3;
const OBJ_ARRAY_F32 = 4;
const OBJ_ARRAY_VECTOR4 = 5;
const OBJ_ARRAY_SAFE_PTR = 10;
const OBJ_ARRAY_OBJECT_REF = 11;
const OBJ_RESOURCE = 12;
const OBJ_INSTANCE = 13;
const OBJ_STRINGW = 14;
const OBJ_AUDIOHANDLE = 15;
const OBJ_STRINGA = 16;

/**
 * `ScriptObject`: a boxed value in a script field.
 *
 * ⚠️ Pointer-shared like the field layout, and for the same reason — one array
 * can be referenced by many scripts. `AUDIOHANDLE` is a type with **no bytes at
 * all**: it reads its id and stops.
 */
function readScriptObject(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const type = s.i32();
  if (type === OBJ_NULL) return;
  if (type === OBJ_INSTANCE) {
    s.reference((self) => readScriptInstance(self, readers));
    return;
  }
  const pointer = s.i32();
  if (pointer === 0) return;
  if (s.pointers.has(pointer)) return;
  s.pointers.set(pointer, true);

  switch (type) {
    case OBJ_ARRAY_BOOL: {
      const n = s.i32();
      for (let i = 0; i < n; i += 1) s.bool();
      break;
    }
    case OBJ_ARRAY_S32:
      s.intVector();
      break;
    case OBJ_ARRAY_F32: {
      const n = s.i32();
      for (let i = 0; i < n; i += 1) s.f32();
      break;
    }
    case OBJ_ARRAY_VECTOR4: {
      const n = s.i32();
      for (let i = 0; i < n; i += 1) s.vector4();
      break;
    }
    case OBJ_STRINGW:
      s.wstr();
      break;
    case OBJ_STRINGA:
      s.str();
      break;
    case OBJ_RESOURCE: {
      // The resource's own type is written first, and `INVALID` means no
      // descriptor follows at all.
      const resourceType = s.i32();
      if (resourceType !== 0) s.resource();
      break;
    }
    case OBJ_AUDIOHANDLE:
      break;
    case OBJ_ARRAY_SAFE_PTR:
      things(s, readers);
      break;
    case OBJ_ARRAY_OBJECT_REF: {
      const n = s.i32();
      for (let i = 0; i < n; i += 1) readScriptObject(s, readers);
      break;
    }
    default:
      throw new SerializerError(`script object type ${type} has no reader`);
  }
}

/** `ColorCorrection`: six floats. */
function readColorCorrection(s: Serializer): void {
  for (let i = 0; i < 6; i += 1) s.f32();
}

/** `EyetoyData`: a photo stuck to a Thing. */
function readEyetoyData(s: Serializer): void {
  const { version } = s.revision;
  if (version < 0x15e) return;
  s.resource(); // frame
  s.resource(); // alphaMask
  s.matrix(); // colorCorrection
  readColorCorrection(s);
  if (version > 0x39f) s.resource(); // outline
}

/** `PMaterialTweak`: the per-Thing material overrides. */
export function readMaterialTweak(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version, subVersion } = s.revision;
  if (version < 0x2c4) s.f32(); // activation
  s.bool(); // hideInPlayMode
  if (version < 0x2cd) s.i32(); // colorIndex
  if (version > 0x2b6) s.f32(); // restitution
  if (version > 0x30c) s.f32(); // frictionScale
  if (version >= 0x2b7 && version < 0x343) {
    s.u8();
    s.u8();
  }
  if (version > 0x342) s.u8(); // grabbability
  if (version > 0x3bc) s.u8(); // grabFilter
  if (version > 0x342) s.u8(); // stickiness
  if (version > 0x2b8) s.bool(); // noAutoDestruct
  if (subVersion > 0x2) s.bool(); // isProjectile
  if (version >= 0x2df && version < 0x327) readThingRef(s, readers);
  if (version > 0x356) s.bool(); // disablePhysicsAudio
  if (subVersion > 0x3) s.bool(); // isUsableByPoppetAudio
  if (version > 0x3ec || subVersion > 5) s.bool(); // hasShadow
  if (subVersion > 0x33) s.bool(); // noBevel
  if (subVersion > 0xdb) s.bool(); // zSlice
  if (subVersion > 0x48) s.bool(); // climbability
  if (subVersion > 0x8c) {
    s.bool(); // ppGrab
    s.u8(); // ppTweakability
    s.bool(); // ppRigidConnection
  }
  if (subVersion >= 0x8d) {
    if (subVersion < 0x13d) s.f32();
    if (subVersion < 0x92) s.u8();
    if (subVersion >= 0x92 && subVersion < 0x13d) s.i32();
  }
  if (subVersion > 0xa7) s.bool(); // ppMaterialMergeable
}

/** `PEnemy`: one part of a creature. */
export function readEnemy(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version } = s.revision;
  const thing = () => readThingRef(s, readers);
  if (version >= 0x15d) s.i32(); // partType
  if (version >= 0x16d) s.f32(); // radius
  if (version >= 0x19f) s.i32(); // snapVertex
  if (version >= 0x1a9) {
    s.vector3(); // centerOffset
    thing(); // animThing
    s.f32(); // animSpeed
  }
  if (version >= 0x246) s.i32(); // sourcePlayerNumber
  if (version >= 0x265) s.bool(); // newWalkConstraintMass
  if (version >= 0x31e) s.i32(); // smokeColor
  if (version >= 0x39a) s.f32(); // smokeBrightness
}

/** `WhipSim`: the grappling hook's state, shared by pointer. */
function readWhipSim(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const thing = () => readThingRef(s, readers);
  thing(); // creatureThing
  s.matrix(); // baseHandleMatrix
  s.vector3(); // prevDir
  s.vector3(); // currDir
  s.i32(); // stateTimer
  s.i32(); // state
  thing(); // attachedThing
  s.vector3(); // attachedLocalPos
  s.vector3(); // attachedLocalNormal
  s.f32(); // attachedLocalAngle
  s.f32(); // attachedScale
  s.bool(); // playedFailToFireSound
  s.f32(); // attachedZOffset
}

/**
 * `PCreature`: a sackboy or sackbot.
 *
 * The longest part after `PSwitch`, and almost all of it is live state rather
 * than authored settings — where the creature is looking, how long it has been
 * in the air, which bullet emitter is next. It is here because it has to be
 * stepped over, not because anything reads it.
 */
export function readCreature(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version, subVersion } = s.revision;
  const thing = () => readThingRef(s, readers);

  s.resource(); // config
  s.s32(); // jumpFrame
  s.f32(); // groundDistance
  s.vector3(); // groundNormal
  thing(); // grabJoint
  thing(); // jumpingOff
  s.i32(); // state
  if (subVersion >= 0x132) s.i32(); // subState
  s.i32(); // stateTimer
  s.f32(); // speedModifier
  s.f32(); // jumpModifier
  s.f32(); // strengthModifier
  s.i32(); // zMode
  s.s32(); // playerAwareness
  s.s32(); // moveDirection
  s.vector3(); // forceThatSmashedCreature
  s.i32(); // crushFrames
  s.f32(); // awarenessRadius
  if (version >= 0x1df) s.i32(); // airTime
  if (version >= 0x354) {
    s.intVector(); // bouncepadThingUIDs
    s.intVector(); // grabbedThingUIDs
  }
  if (version >= 0x221) s.bool(); // haveNotTouchedGroundSinceUsingJetpack
  if (version >= 0x15d) {
    things(s, readers); // legList
    things(s, readers); // lifeSourceList
    thing(); // lifeCreature
    thing(); // aiCreature
  }
  if (version >= 0x163) {
    s.i32(); // jumpInterval
    s.i32(); // jumpIntervalPhase
  }
  if (version >= 0x169) s.bool(); // meshDirty
  if (version >= 0x166) {
    things(s, readers); // eyeList
    things(s, readers); // brainAiList
    things(s, readers); // brainLifeList
  }
  if (version >= 0x19c) s.bool(); // reactToLethal
  if (version >= 0x1a9) {
    s.matrix(); // oldAnimMatrix
    s.f32(); // animOffset
  }
  if (version >= 0x1fc) s.vector3(); // groundNormalRaw
  if (version >= 0x212) {
    s.vector3(); // groundNormalSmooth
    s.f32(); // bodyAdjustApplied
  }
  if (version >= 0x240 && version < 0x2c4) s.f32(); // switchScale
  if (version >= 0x243) s.vector3(); // gunDirAndDashVec
  if (subVersion >= 0x19e) s.f32(); // gunDirAndDashVecW
  if (version >= 0x246) thing(); // resourceThing
  if (version >= 0x247) s.i32(); // gunFireFrame
  if (version >= 0x248) s.i32(); // bulletCount
  if (version >= 0x24a) s.i32(); // bulletImmuneTimer
  if (version >= 0x24d) thing(); // bulletEmitter0
  if (version >= 0x3a2) thing(); // bulletEmitter1
  if (version >= 0x24e) s.i32(); // bulletPosIndex
  if (version >= 0x24f) {
    s.i32(); // maxBulletCount
    s.f32(); // ammoFillFactor
  }
  if (version >= 0x252) s.bool(); // gunDirPrecisionMode
  if (version >= 0x320) {
    s.i32(); // fireRate
    s.f32(); // gunAccuracy
    s.vector3(); // bulletEmitOffset
    s.f32(); // bulletEmitRotation
    thing(); // gunThing
    thing(); // gunTrigger
    s.i32(); // lastGunTriggerUID
  }
  if (version >= 0x272) s.i32(); // airTimeLeft
  if (version >= 0x2c9) {
    s.f32(); // amountBodySubmerged
    s.f32(); // amountHeadSubmerged
  }
  if (version >= 0x289) s.bool(); // hasScubaGear
  if (version >= 0x289 && version < 0x2c8) s.resource(); // headPiece
  if (version >= 0x289) s.bool(); // outOfWaterJumpBoost
  if (version >= 0x2a9) s.resource(); // handPiece
  if (version >= 0x273) {
    thing(); // head
    thing(); // toolTetherJoint
    s.f32(); // toolTetherWidth
    thing(); // jetpack
    s.s32(); // wallJumpDir
    s.vector3(); // wallJumpPos
    const contacts = s.i32();
    for (let i = 0; i < contacts; i += 1) s.vector3(); // bootContactForceList
    s.s32(); // gunType
    s.bool(); // wallJumpMat
  }
  if (version >= 0x29e && version < 0x336) thing(); // lastDirectControlPrompt
  if (version > 0x2e4) thing(); // directControlPrompt
  if (version >= 0x29e && version < 0x336) {
    s.vector3(); // smoothedDirectControlStick
    s.i16(); // directControlAnimFrame
    s.u8(); // directControlAnimState
  }
  if (version >= 0x29f && version < 0x2c1) s.u8(); // directControlMode
  if (version >= 0x2c1 && version < 0x336) s.u8();
  if (version >= 0x2a5) {
    s.i32(); // responsiblePlayer
    s.i32(); // responsibleFramesLeft
  }
  if (version >= 0x32c) s.bool(); // canDropPowerup
  if (version >= 0x3f0) s.u8(); // capeExtraMaxVelocityCap
  if (version >= 0x35a) s.i32(); // behavior
  if (version >= 0x373) s.i32(); // effectDestroy
  if (version >= 0x3c0) s.reference((self) => readWhipSim(self, readers));
  if (subVersion >= 0x88 && subVersion <= 0xa4) s.resource();
  if (subVersion >= 0xaa) thing(); // alternateFormWorld
  if (subVersion >= 0xd7) s.i32(); // hookHatState
  if (subVersion >= 0xd7 && subVersion < 0xea) {
    thing();
    thing();
  }
  if (subVersion >= 0xdf) thing(); // hookHatBogey
  if (subVersion >= 0x196) {
    for (let i = 0; i < 7; i += 1) s.i32(); // the flying timers
    s.f32(); // flyingLegScale
    s.vector4(); // flyingVels
    s.bool(); // flyingFlapLockout
    s.bool(); // flyingFallLockout
    s.bool(); // flyingInWind
    s.bool(); // flyingThrustLatched
    s.i16(); // glidingTime
  }
  if (subVersion >= 0x20c) {
    s.u8(); // springState
    s.bool(); // springHasSprung
    s.reference((self) => {
      readThingRef(self, readers); // springThing
      self.i32(); // springTimer
      self.vector3(); // springDirection
      self.vector3(); // springThingPosition
    });
    s.u8(); // springPower
    s.bool(); // springSeparateForces
    s.u8(); // springForce
    s.u8(); // springStateTimer
  }
}

/** `Primitive`: one draw call of a mesh. */
function readPrimitive(s: Serializer): void {
  s.resource(); // material
  // `Revisions.MESH_TEXTURE_ALTERNATIVES` is 0x179, not something in the 0x3xx
  // range -- a guess at that constant cost one debugging round.
  if (s.revision.version >= 0x179) s.resource(); // textureAlternatives
  s.i32(); // minVert
  s.i32(); // maxVert
  s.i32(); // firstIndex
  s.i32(); // numIndices
  s.i32(); // region
}

/** `CostumePiece`: one wearable. */
function readCostumePiece(s: Serializer): void {
  const { version, subVersion } = s.revision;
  s.resource(); // mesh
  s.i32(); // categoriesUsed
  if (subVersion < 0x105) {
    const n = s.i32();
    for (let i = 0; i < n; i += 1) s.i32(); // morphParamRemap, an i32 each
  } else s.bytes(s.i32());
  const prims = s.i32();
  for (let i = 0; i < prims; i += 1) readPrimitive(s);
  if (version >= 0x19a) s.resource(true); // plan
}

/** `PCostume`: what a creature is wearing. */
export function readCostume(s: Serializer): void {
  const { version, subVersion } = s.revision;
  s.resource(); // mesh
  s.resource(); // material
  if (version >= 0x19a) s.resource(true); // materialPlan
  s.intVector(); // meshPartsHidden
  const prims = s.i32();
  for (let i = 0; i < prims; i += 1) readPrimitive(s);
  // ⚠️ An `i32`, not a byte. It was a byte here and no compressed file could
  // tell: a varint under 128 is one byte either way. See `readFieldLayout`.
  if (subVersion >= 0xdb) s.i32(); // creatureFilter
  const pieces = s.i32();
  for (let i = 0; i < pieces; i += 1) readCostumePiece(s);
  if (version >= 0x2c5) {
    const temp = s.i32();
    for (let i = 0; i < temp; i += 1) readCostumePiece(s);
  }
}

/** `NpcJumpSolver`: where a sackbot is jumping to. */
function readNpcJumpSolver(s: Serializer): void {
  if (s.revision.version > 0x2cd) {
    s.bool(); // isCurrentJumpFlipped
    s.vector3(); // curSource
    s.vector3(); // curTarget0
    s.vector3(); // curTarget1
    s.s32(); // currentJump
    s.i32(); // currentJumpPos
  }
}

/** `PNpc`: a sackbot's runtime state. */
export function readNpc(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version, subVersion } = s.revision;
  if (version < 0x273) return;
  readNpcJumpSolver(s);
  if (subVersion < 0x118) s.bytes(s.i32()); // soundRecording
  s.intVector(); // soundRecordingDataNbytes
  s.i32(); // soundRecordingPacket
  s.i32(); // soundRecordingPacketOffset
  s.intVector(); // sackbotRecordingTimes
  if (version > 0x2da || (version < 0x29b && version > 0x294)) {
    s.reference((self) => readNpcBehavior(self, readers));
  }
  if (version > 0x2ac) {
    s.i32(); // flags
    if (version < 0x2ce) s.s32();
  }
  if (version > 0x29a) readThingRef(s, readers); // behaviorThing
  if (version > 0x2d5) readThingRef(s, readers); // rootBehaviorThing
  if (version > 0x2cd && version < 0x36e) {
    s.i32();
    s.i32();
    s.i32();
  }
  if (version > 0x2ac) {
    s.vector3(); // moveTarget
    if (version < 0x36e) s.vector3(); // lookAt
    if (version > 0x2d6 && version < 0x2e6) s.vector3();
    if (version < 0x2ce) s.s32();
    s.s32(); // waitTime
    if (version < 0x2ce) s.f32();
  }
  if (version > 0x2ae) s.i32(); // playerNumber
  if (version > 0x2aa && version < 0x2d5) s.i32();
  if (version > 0x338) s.wstr(); // actorName
  if (version > 0x353) {
    if (version === 0x354 || version === 0x355) {
      s.f32();
      s.f32();
    } else {
      s.i32(); // lastTimeThrown
      s.i32(); // lastTimeHitTheGround
    }
    s.i32(); // lastThrower
  }
  if (version > 0x391) s.u8(); // costumeToCopy
  if (subVersion > 0x1a5) s.bool(); // copyFormAsWell
}

/** `PScriptName`: a length-prefixed blob this reader only has to step over. */
function readScriptName(s: Serializer): void {
  s.bytes(s.s32());
}

/** `PQuest`: an adventure's objective marker. */
/**
 * `PMetadata`: what an inventory item calls itself.
 *
 * ❗ **Only reachable below LBP3**, which is why it had no reader: the walk
 * refuses at `LBP3_MIN_VERSION` long before a file carrying one is opened. It is
 * here because it is what nine of the archive's LBP1 levels stop on once the
 * Thing header is read correctly -- see question 28.
 *
 * ⚠️ **The LAMS branch is the only one implemented.** cwlib takes translation
 * *tags* -- four strings -- when the file predates `LD_LAMS_KEYS` (LEERDAMMER
 * revision 8) and 0x2ba; every LBP1 level in the sample is LEERDAMMER 0x17, so
 * the four `u32` keys are what they carry and the tag branch has never been run
 * against a file. It refuses rather than guessing.
 */
function readMetadata(s: Serializer): void {
  const { version, branchId, branchRevision } = s.revision;
  const leerdammer = branchId === 0x4c44;
  // cwlib `hasDepreciatedValue`: a `CValue` struct that LEERDAMMER dropped at
  // its revision 2 and everyone else at 0x297.
  const deprecatedValue = leerdammer
    ? branchRevision < 0x2
    : version < 0x297;
  if (deprecatedValue) {
    throw new SerializerError('PMetadata with the deprecated CValue has no reader');
  }
  if (!((leerdammer && branchRevision >= 0x8) || version > 0x2ba)) {
    throw new SerializerError('PMetadata with translation tags rather than LAMS keys has no reader');
  }
  s.u32(); // titleKey
  s.u32(); // descriptionKey
  s.u32(); // location
  s.u32(); // category
  if (version >= 0x195) s.i32(); // primaryIndex
  s.i32(); // fluffCost
  s.i32(); // type, a flags word
  s.i32(); // subType
  s.u32(); // creationDate
  s.resource(); // icon
  // ⚠️ Never seen non-null on a level: a `PhotoMetadata` belongs to a photo, and
  // the reference costs one byte when it is null. It refuses if one turns up
  // rather than reading a struct nothing here has checked.
  s.reference(() => {
    throw new SerializerError('PMetadata carries a PhotoMetadata, which has no reader');
  });
  if (version >= 0x15f) s.bool(); // referencable
  if (version >= 0x205) s.bool(); // allowEmit
}

function readQuest(s: Serializer): void {
  const type = s.i32();
  // ⚠️ cwlib refuses anything but 5 and so does this: the other types carry a
  // trailing block whose shape depends on the type, and none of the corpus's
  // 2,553 islands has one to check it against.
  if (type !== 5) throw new SerializerError(`quest type ${type} has no reader`);
  s.wstr(); // questID
  s.wstr(); // objectiveID
  s.i32(); // questKey
  s.i32(); // objectiveKey
}

/** `PWormhole`: the door between two islands. */
/**
 * `PEffector`: the volume physics behaves differently inside — gravity, and
 * water.
 *
 * ❗ **No version gates at all.** cwlib's `PEffector` reads the same nine fields
 * at every revision it knows, so this is correct wherever the walk reaches it
 * rather than correct only in the range `requireLbp3` asserts. Its width is
 * fixed at **46 bytes** under any compression flags, because not one of the nine
 * is an integer and `cf7` only compresses those.
 *
 * ⚠️ **UNEXERCISED, and that is measured rather than suspected.** `EFFECTOR`
 * appears in 13 of the archive sample's 19 LBP1 levels and **all 13 are a null
 * reference** — one byte of id and no body. This function has never run. It is
 * a faithful port and it is not a tested one; the first file that carries a real
 * effector is what would settle it, and 103 archive levels do not contain one.
 *
 * ⚠️ **Adding it is also not what unblocked those levels.** They were failing on
 * the *declaration*, in the walk, before the reference was read — see the note
 * beside `UnimplementedPartError` in `src/core/thing.ts`.
 */
function readEffector(s: Serializer): void {
  s.vector3(); // posVel
  s.f32(); // angVel
  s.f32(); // viscosity
  s.f32(); // density
  s.vector3(); // gravity, defaulting to (0, -2.7, 0)
  s.bool(); // pushBack
  s.bool(); // swimmable
  s.f32(); // viscosityCheap
  s.f32(); // modScale
}

function readWormhole(s: Serializer): void {
  s.s32(); // type
  s.i8(); // activeTypeForTwoWayHole, subVersion >= 0x111
  s.s32(); // playerMode
  s.bool(); // audioEnabled
  s.bool(); // trigger
  s.bool(); // finished
  s.bool(); // activated
  s.i32(); // exitCount
  s.i32(); // exitDelay
}

/** `RegionOverride`: one material swapped on one region of a mesh. */
function readRegionOverride(s: Serializer): void {
  s.i32(); // region
  s.resource(true); // materialPlan
  s.resource(); // material
  s.vector3(); // uvScale
  if (s.revision.subVersion >= 0x158) {
    s.i32(); // color
    s.i8(); // brightness
  }
}

/** `PMaterialOverride`, at version >= 0x360. */
function readMaterialOverride(s: Serializer): void {
  const { subVersion } = s.revision;
  s.array(readRegionOverride);
  s.resource(); // mesh
  if (subVersion >= 0x15f) {
    s.i32(); // color
    if (subVersion >= 0x191) s.i8(); // brightness
  }
}

/** `PConnectorHook`: a grapple point's motor settings. */
function readConnectorHook(s: Serializer): void {
  const { subVersion } = s.revision;
  s.i32(); // mode
  s.i32(); // inputAction
  s.f32(); // poweredSpeed
  s.f32(); // accel
  s.f32(); // decel
  s.f32(); // delay
  s.bool(); // reverse
  if (subVersion > 0xfd) {
    s.bool(); // tryLatch
    s.bool(); // clamped
    s.i32(); // collidable
    s.f32(); // angle
    s.f32(); // friction
    s.vector4(); // pivot
  }
  if (subVersion >= 0xff && subVersion < 0x15d) s.i32();
  s.f32(); // spinDamping
  s.bool(); // audioEnable
  s.i32(); // hookType, subVersion > 0x14e
}

/** `PAnimation`: a plain animation playing on a Thing. */
function readAnimation(s: Serializer): void {
  s.resource(); // animation
  s.f32(); // velocity
  s.f32(); // position
}

/** `PAtmosphericTweak`: an island's weather. */
function readAtmosphericTweak(s: Serializer): void {
  const { subVersion } = s.revision;
  s.s32(); // atmosType
  s.f32(); // intensity
  s.f32(); // directionStrength
  s.s32(); // inputAction
  if (subVersion < 0x1a8) s.bool(); // disableAudio
  s.f32(); // maxParticles, subVersion > 0x135
  s.f32(); // currentInput
  if (subVersion > 0x19b) {
    s.f32(); // intensityOff
    s.f32(); // directionStrengthOff
  }
}

/** `PPowerUp`: a power-up a player is holding, at subVersion >= 0x18d. */
function readPowerUp(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  s.matrix(); // spawnedRootMatrix
  s.matrix(); // spawnedChipMatrix
  s.vector4(); // rootHandle
  s.resource(true); // plan
  readThingRef(s, readers); // powerUpThing
  readThingRef(s, readers); // powerUpHandle
  s.bool(); // flipped
  s.bool(); // justFlipped
  s.i32(); // fireStartTime
  s.f32(); // initialRotation
  s.vector3(); // deterministicPosition
  s.f32(); // deterministicRotation
  s.f32(); // offsetForEmitters
  s.f32(); // prevAngle
  s.f32(); // currAngle
}

/** `PWindTweak`: a wind volume's strength, shape and behaviour. */
function readWindTweak(s: Serializer): void {
  const { subVersion } = s.revision;
  s.f32(); // windStrength
  s.vector3(); // direction
  s.f32(); // angle
  s.f32(); // decay
  s.f32(); // currentInput
  s.f32(); // minRadius
  s.f32(); // maxRadius
  s.f32(); // angleRange
  s.i32(); // behavior
  s.f32(); // maxSpeed
  s.bool(); // affectsCharacters
  s.bool(); // blowAtTag
  s.bool(); // blasterEffect
  s.bool(); // occluders, subVersion > 0x171
  s.i8(); // effectType
  if (subVersion > 0x211) {
    s.i8(); // horizontalSpeed
    s.i8(); // verticalSpeed
  }
}

/** `PStreamingData`: whether a streamed Thing is currently hidden. */
function readStreamingData(s: Serializer): void {
  s.i8(); // hidden
  s.i16(); // originator, subVersion > 0xdd
}

/**
 * `PStreamingHint`: the volume that asks for a chunk to be streamed in.
 *
 * ⚠️ **`connected` is `things`, not `references(readThingRef)`.** The second
 * reads a reference id and then calls a builder that reads *another* one, so
 * every element cost two ids instead of one -- and the whole corpus missed it
 * because `connected` is empty in every file of it, so the loop never ran. It
 * took a level out of the public archive with a single connected Thing to
 * expose it: measured on `8b904be1`, the array's count is 1 at byte 120322, its
 * one id is read at 120323, and the extra read then ate the next Thing's `0xaa`.
 */
function readStreamingHint(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  s.i32(); // type
  s.vector3(); // offset
  s.vector3(); // size
  readThingRef(s, readers); // relativeToThing
  things(s, readers); // connected
}

/** `PoppetMode`: what the popit has open, and its sub-mode. */
function readPoppetMode(s: Serializer): void {
  s.i32(); // mode
  s.i32(); // subMode
}

/** `RaycastResults`: what the popit's cursor is pointing at. */
function readRaycastResults(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  s.vector4(); // hitpoint
  s.vector4(); // normal
  s.f32(); // baryU
  s.f32(); // baryV
  s.i32(); // triIndex
  readThingRef(s, readers); // hitThing
  readThingRef(s, readers); // refThing
  s.s32(); // onCostumePiece
  s.i32(); // decorationIdx
  s.bool(); // switchConnector
}

/** `PoppetMaterialOverride`: what the popit is painting with. */
function readPoppetMaterialOverride(s: Serializer): void {
  const { version, subVersion } = s.revision;
  // The plan moved to the front at 0x2ed; both writes are here because that is
  // how cwlib has it, and only one of them can fire.
  if (version >= 0x2ed) s.resource(true); // plan
  s.resource(); // gfxMaterial
  s.resource(); // bevel
  s.resource(); // physicsMaterial
  s.i32(); // soundEnum
  s.f32(); // bevelSize
  if (version < 0x2ed) s.resource(true); // plan
  if (subVersion > 0x62) s.bool(); // headDucking
}

/** `PoppetShapeOverride`: the shape the popit is drawing. */
function readPoppetShapeOverride(s: Serializer): void {
  // ⚠️ A plain count and that many vectors, not an `array` of structs: cwlib
  // writes the length itself here rather than going through its array helper.
  const count = s.i32();
  if (count < 0) throw new SerializerError(`negative polygon length ${count}`);
  for (let i = 0; i < count; i += 1) s.vector3(); // polygon
  s.intVector(); // loops
  s.s32(); // back
  s.s32(); // front
  s.f32(); // scale
  s.f32(); // angle
  if (s.revision.version > 0x317) s.matrix(); // worldMatrix
}

/**
 * `Poppet`: a player's popit and what it has open.
 *
 * ⚠️ **Only the post-0x2ec layout is here.** Below that revision `Poppet` is a
 * different structure entirely -- an edit state, a marquee selection, a camera
 * zone backup -- and `requireLbp3` rules every one of those files out before
 * this can be reached. Adding them means adding that whole branch, not relaxing
 * a gate.
 */
function readPoppet(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version } = s.revision;
  s.bool(); // isInUse
  s.array(readPoppetMode); // modeStack
  readRaycastResults(s, readers);
  if (version > 0x2ec) things(s, readers); // frozenList
  if (version > 0x2f1) things(s, readers); // hiddenList
  if (version >= 0x311) {
    readPoppetMaterialOverride(s);
    readPoppetShapeOverride(s);
  }
  if (version >= 0x3a0) things(s, readers); // tweakObjects
}

/**
 * `PYellowHead`: a player, and the popit they are holding.
 *
 * ✔ **Verified on the one file that has one.** A player's popit state appears in
 * a *save*, not in a published level -- none of the 43 levels or 86 further
 * resources pulled out of the public archive carries one -- but a plan in the
 * corpus saves does, and `test/plan.test.ts` opens it. That test verifies the
 * port properly rather than by not throwing: `readPlan` requires the Thing array
 * to fill `thingData` **exactly**, so every field below has been read at the
 * right width. The corpus went from 211 plans parsing to **212**.
 *
 * ✔ **What is settled is that LBP3 is a clean path through it.** cwlib throws a
 * `SerializationException` in two subVersion ranges -- `[0xc, 0x66)` and
 * `[0x88, 0xa3)` -- and the range this reader accepts starts at 0x207, so
 * neither can fire. Every version gate above 0x359 is likewise always true here;
 * they are written out anyway, because that is where the shape came from.
 */
export function readYellowHead(s: Serializer, readers: ReadonlyMap<string, PartReader>): void {
  const { version, subVersion } = s.revision;
  readThingRef(s, readers); // head
  if (version > 0x1fc) readThingRef(s, readers); // legacyToolTetherJoint
  s.f32(); // legacyToolTetherWidth
  s.s32(); // playerNumber
  // The gate is `version < 0x17f || (0x184 < v < 0x192) || v > 0x1b5`, and the
  // last arm is the live one.
  s.reference((self) => readPoppet(self, readers)); // poppet
  if (version >= 0x16b) s.bool(); // requestedSuicide
  readThingRef(s, readers); // legacyJetpack
  if (version > 0x193) s.f32(); // onScreenCounter
  if (version > 0x1d0) s.i8(); // onScreenStatus
  if (version > 0x1d3) s.bool(); // editJetpack
  if (version > 0x272) {
    if (version < 0x2df) s.bool(); // recording
    readThingRef(s, readers); // recordee
  }
  if (version > 0x359) s.i32(); // lastTimeSlappedAPlayer
  if (subVersion > 0xa5) s.i32(); // animSetKey
  if (subVersion > 0xd2) s.bool(); // monstrousHeadScale
  if (subVersion > 0x12a) {
    s.i32(); // creatureToSpawnAs
    s.bool(); // spawnAsAlternateForm
  }
}

/** `PRef`: a Thing standing in for a plan that has not been instanced. */
function readRef(s: Serializer): void {
  const { version } = s.revision;
  s.resource(true); // plan, a GlobalThingDescriptor below 0x160
  s.i32(); // oldLifetime
  if (version >= 0x1c9) s.i32(); // oldAliveFrames
  // Both of these went away at 0x321, which is why LBP3 never sees them.
  if (version < 0x321) s.bool(); // childrenSelectable
  if (version >= 0x13d && version < 0x321) s.bool(); // stripChildren
}

/** `PAnimationTweak`: an animated mesh's playback settings. */
function readAnimationTweak(s: Serializer): void {
  const { subVersion } = s.revision;
  s.f32(); // animSpeed
  s.f32(); // animPos
  s.f32(); // animBlendTime
  s.i32(); // behavior
  s.i32(); // blendAction
  s.resource(); // anim
  s.bool(); // animLoop
  s.guid(); // cachedMeshFile
  s.guid(); // containerFile
  s.f32(); // animStart
  s.f32(); // animEnd
  s.bool(); // animPlaying
  s.bool(); // animResetOnInactive
  s.f32(); // rootRotationX, subVersion > 0x146
  s.f32(); // rootRotationY
  s.bool(); // usesRootRotation
  s.i32(); // type
  s.i32(); // animToOverride
  if (subVersion >= 0x5c && subVersion < 0x152) s.u8();
  s.guid(); // tweakMeshFile
  s.i32(); // containerType
  s.i32(); // subContainerIndex
  s.wstr(); // actorName
  if (subVersion > 0x151) {
    s.f32(); // yawRate
    s.f32(); // pitchRate
    s.f32(); // rollRate
    s.f32(); // yawPosition
    s.f32(); // pitchPosition
    s.f32(); // rollPosition
    s.f32(); // rootRotationZ
  }
}

/** `PFader`: the scenery fade an island applies when the player is behind it. */
function readFader(s: Serializer): void {
  const { subVersion } = s.revision;
  s.bool(); // includeRigidConnectors
  if (subVersion >= 0xe0) s.bool(); // includeLights
  s.bool(); // requirePlayerObscuration
  s.f32(); // fadeAmount
  if (subVersion >= 0x17) s.bool(); // faderDisabled
  if (subVersion >= 0x39) s.f32(); // fadeTimeSeconds
  if (subVersion >= 0x3b) s.i8(); // inputBehavior
}

/**
 * `PTransition`: the doorway between two islands of a streaming level.
 *
 * Every island in an LBP3 adventure carries one, so this is the part that stood
 * between the reader and 2,553 islands of streamed level.
 */
function readTransition(s: Serializer): void {
  const { subVersion } = s.revision;
  s.s32(); // colorIndex
  if (subVersion <= 0xf) s.i32();
  if (subVersion >= 0x1a) s.wstr(); // label
  if (subVersion > 0x18) s.bool(); // enabled
  if (subVersion >= 0x14e && subVersion < 0x156) s.i32();
  if (subVersion > 0x17c) {
    s.bool(); // showColor
    s.bool(); // playAudio
  }
}

/**
 * `PPocketItem`: a power-up as it sits in a plan's inventory.
 *
 * Turned up only once plans were being read — two of the corpus's 224, both at
 * subVersion 0x208/0x209, where the layout is the four fields at the bottom.
 * ⚠️ **The earlier gates are cwlib's and are not exercised here**: every other
 * plan in the corpus is at subVersion 0, where a pocket item would take the
 * `str` branch instead, and none of them carries one. They are written out
 * rather than dropped because a silent misparse of the wrong branch is exactly
 * what the Thing marker cannot catch until the *next* Thing.
 */
function readPocketItem(s: Serializer): void {
  const { subVersion } = s.revision;
  if (subVersion < 0x15) {
    s.str();
    s.u16();
  }
  if (subVersion >= 0x15 && subVersion < 0x14d) s.u16();
  s.i16(); // flags
  if (subVersion >= 0x14 && subVersion < 0x60) s.resource(true); // plan
  if (subVersion >= 0x1e && subVersion < 0x78) s.u8();
  if (subVersion >= 0x2e && subVersion < 0x14d) s.u8();
  if (subVersion >= 0x2e && subVersion < 0x78) s.u8();
  if (subVersion > 0x3d) s.i8(); // powerUpType
  if (subVersion > 0x3f) s.f32(); // aimModifier
  if (subVersion > 0x55) s.i32(); // lifetime
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
  bind('LEVEL_SETTINGS', readLevelSettingsPart);
  bind('GENERATED_MESH', readGeneratedMesh);
  bind('RENDER_MESH', readRenderMesh);
  bind('SWITCH_KEY', readSwitchKey);
  bind('DECORATIONS', readDecorations);
  bind('STICKERS', readStickers);
  bind('CHECKPOINT', readCheckpoint);
  bind('PHYSICS_TWEAK', readPhysicsTweak);
  bind('SWITCH', readSwitch);
  bind('MICROCHIP', readMicrochip);
  bind('CAMERA_TWEAK', readCameraTweak);
  readers.set('INSTRUMENT', (s) => readInstrumentPart(s));
  bind('SEQUENCER', readSequencerPart);
  readers.set('GAMEPLAY_DATA', (s) => readGameplayData(s));
  readers.set('AUDIO_WORLD', (s) => readAudioWorld(s));
  bind('SWITCH_INPUT', readSwitchInput);
  bind('CONTROLINATOR', readControlinator);
  bind('EMITTER', readEmitter);
  bind('SPRITE_LIGHT', readSpriteLight);
  bind('SCRIPT', readScript);
  bind('MATERIAL_TWEAK', readMaterialTweak);
  bind('ENEMY', readEnemy);
  bind('CREATURE', readCreature);
  bind('YELLOWHEAD', readYellowHead);
  readers.set('COSTUME', (s) => readCostume(s));
  bind('NPC', readNpc);
  bind('POCKET_ITEM', readPocketItem);
  bind('TRANSITION', readTransition);
  bind('FADER', readFader);
  bind('ANIMATION_TWEAK', readAnimationTweak);
  bind('WIND_TWEAK', readWindTweak);
  bind('STREAMING_DATA', readStreamingData);
  bind('STREAMING_HINT', readStreamingHint);
  bind('REF', readRef);
  bind('POWER_UP', readPowerUp);
  bind('ANIMATION', readAnimation);
  bind('ATMOSPHERIC_TWEAK', readAtmosphericTweak);
  bind('SCRIPT_NAME', readScriptName);
  bind('QUEST', readQuest);
  bind('METADATA', readMetadata);
  bind('EFFECTOR', readEffector);
  bind('WORMHOLE', readWormhole);
  bind('MATERIAL_OVERRIDE', readMaterialOverride);
  bind('CONNECTOR_HOOK', readConnectorHook);
  return readers;
}

export { SerializerError };
