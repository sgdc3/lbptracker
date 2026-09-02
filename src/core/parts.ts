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
  if (version >= 0x15d) emptyList(s, 'PStickers.eyetoyData');
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
  s.reference((self) => readThing(self, readers)); // thing
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
    type = s.i32(); // enum32, forced fixed-width
    s.reference((self) => readThing(self, readers)); // referenceThing
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
  if (version > 0x276 && version < 0x327) s.reference((self) => readThing(self, readers));
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
  s.reference((self) => readThing(self, readers)); // circuitBoardThing
  if (version >= 0x283) s.bool(); // hideInPlayMode
  if (version >= 0x2b8) s.bool(); // wiresVisible
  if (version >= 0x2e4) s.s32(); // lastTouched
  if (version >= 0x2e9) s.vector4(); // offset

  let name = '';
  const components: Component[] = [];
  if (version >= 0x34d) {
    name = s.wstr();
    const count = s.i32();
    for (let i = 0; i < count; i += 1) {
      const thing = s.reference((self) => readThing(self, readers));
      const x = s.f32();
      const y = s.f32();
      s.f32(); // angle
      s.f32(); // scaleX
      s.f32(); // scaleY
      s.bool(); // flipped
      components.push({ thing, x, y });
    }
    s.f32(); // circuitBoardSizeX
    s.f32(); // circuitBoardSizeY
  }

  if (subVersion >= 0x1d) s.bool(); // keepVisualVertical
  if (subVersion >= 0x2d) s.u8(); // broadcastType
  return { name, components };
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
  const name = version >= 0x35b ? s.wstr() : '';
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
    s.reference((self) => readThing(self, readers)); // previewThing
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
  return readers;
}

export { SerializerError };
