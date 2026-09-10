/**
 * The LBP serialiser's **write** side, and the container around it.
 *
 * This is `serializer.ts` in reverse, method for method, and it has to be: the
 * two are only right together. Everything the reader knows about the format --
 * that the revision gates each field, that `COMPRESSED_INTEGERS` turns every 32-
 * and 64-bit integer into a LEB128 varint, that references are ids expanding
 * inline at their first mention -- is the same fact stated from the other side,
 * so the pairs live next to each other and a change to one is a change to both.
 *
 * ## What proves a writer
 *
 * A reader is proved by reading real files; a writer has no such corpus. Three
 * things stand in for it, in `test/write.test.ts` and `dev/verify-export.ts`:
 *
 * 1. **The reader reads it back.** Whatever this writes, `readPlan` opens and
 *    `importLevel` turns back into the same `Sequencer` -- the note records
 *    compared byte for byte, not note by note.
 * 2. **The container checks itself.** The end of the chunk data has to land
 *    exactly on the dependency-table offset, which is the same independent check
 *    `loadResource` applies to the game's own files.
 * 3. **The bytes match the game's.** The parts a sequencer plan carries that
 *    hold no music -- the mesh, the trigger, the two switches, the group -- are
 *    written from values measured out of 17 real LBP3 sequencer plans, and
 *    `dev/verify-export.ts` diffs our bytes against theirs span by span.
 *
 * ## Deflate is injected, and its window matters
 *
 * ⚠️ **The game writes a `0x68` zlib header -- CINFO 6, a 16 KiB window** (see
 * `steering/level-files.md`). Node can reproduce that exactly with
 * `deflateSync(chunk, { windowBits: 14 })`; the browser's `CompressionStream`
 * has no such control and emits `0x78`, which is what ennuo's toolkit emits too.
 * Both are valid zlib streams and both inflate; the difference is visible in a
 * hex dump and in nothing else. `deflate` is a parameter for the same reason
 * `inflate` is -- `src/platform/` holds the two adapters.
 */

import type { RevisionInfo } from './serializer.ts';
import { COMPRESSED_INTEGERS, COMPRESSED_MATRICES, COMPRESSED_VECTORS } from './serializer.ts';

/** Deflate one chunk into a complete zlib stream. May be sync or async. */
export type Deflate = (raw: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/**
 * One entry of the resource's dependency table.
 *
 * ❗ **A GUID is a game asset and a hash is a user resource** (`resource.ts`).
 * Everything a sequencer plan written here refers to is a GUID -- the gadget's
 * mesh, its plan, and every `RInstrument` -- which is exactly why the plan can
 * travel on its own: there is no second file to ship with it.
 */
export interface DependencyOut {
  readonly guid?: number;
  readonly hash?: Uint8Array;
  readonly type: number;
}

/** `ResourceType.PLAN`, the one type a descriptor does not register as a dependency. */
export const RESOURCE_PLAN = 38;

export class WriterError extends Error {}

/**
 * Writes one payload.
 *
 * The reference table is per-`Writer`, as `Serializer.referenced` is
 * per-`Serializer`: the ids in a plan's nested `thingData` blob mean nothing
 * outside it, so that blob gets its own writer.
 */
export class Writer {
  readonly revision: RevisionInfo;
  readonly compressionFlags: number;
  private buffer: Uint8Array;
  private view: DataView;
  private at = 0;
  /** Object → the id already written for it. */
  private readonly ids = new Map<object, number>();
  private nextId = 1;
  /** Dependencies in first-mention order, deduplicated. */
  private readonly deps = new Map<string, DependencyOut>();

  constructor(revision: RevisionInfo, compressionFlags: number, capacity = 0x10000) {
    this.revision = revision;
    this.compressionFlags = compressionFlags;
    this.buffer = new Uint8Array(capacity);
    this.view = new DataView(this.buffer.buffer);
  }

  get compressedIntegers(): boolean {
    return (this.compressionFlags & COMPRESSED_INTEGERS) !== 0;
  }

  get position(): number {
    return this.at;
  }

  /** Everything written so far. A copy: the buffer keeps growing behind it. */
  done(): Uint8Array {
    return this.buffer.slice(0, this.at);
  }

  dependencies(): DependencyOut[] {
    return [...this.deps.values()];
  }

  /**
   * Make room for `n` bytes and return where they go.
   *
   * ❗ **Every caller must take the offset FIRST and touch `this.buffer` after,
   * never in one expression.** `this.buffer.set(v, this.need(n))` evaluates
   * `this.buffer` before the call that may replace it, so the bytes land in the
   * buffer that was just thrown away -- silently, and only once a payload grows
   * past the initial capacity. Measured the hard way: a plan of 116 chips wrote
   * its first 64 KB correctly and then filled the rest with zeros.
   */
  private need(n: number): number {
    if (this.at + n > this.buffer.length) {
      let size = this.buffer.length * 2;
      while (size < this.at + n) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(this.buffer.subarray(0, this.at));
      this.buffer = grown;
      this.view = new DataView(grown.buffer);
    }
    const start = this.at;
    this.at += n;
    return start;
  }

  bytes(value: Uint8Array): void {
    const at = this.need(value.length);
    this.buffer.set(value, at);
  }

  u8(value: number): void {
    const at = this.need(1);
    this.buffer[at] = value & 0xff;
  }

  i8(value: number): void {
    this.u8(value);
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  u16(value: number): void {
    const at = this.need(2);
    this.view.setUint16(at, value & 0xffff, false);
  }

  i16(value: number): void {
    const at = this.need(2);
    this.view.setInt16(at, value | 0, false);
  }

  f32(value: number): void {
    const at = this.need(4);
    this.view.setFloat32(at, value, false);
  }

  /** LEB128, least-significant group first. */
  uleb128(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new WriterError(`LEB128 of ${value}, which is not a non-negative integer`);
    }
    let rest = Math.floor(value);
    for (;;) {
      const group = rest % 128;
      rest = Math.floor(rest / 128);
      if (rest === 0) {
        this.u8(group);
        return;
      }
      this.u8(group | 0x80);
    }
  }

  /**
   * A 32-bit integer, varint when the flags say so. `force` overrides.
   *
   * ⚠️ **Negative values go through as their unsigned bit pattern.** The reader
   * takes `uleb128() | 0`, so `-1` is the five bytes `ff ff ff ff 0f` and not a
   * short negative encoding. A real sequencer plan holds exactly that:
   * `PSequencer.TriggerPlayer` is -1 and the board switch's manual activation
   * carries a player of -1.
   */
  i32(value: number, force = false): void {
    if (force || !this.compressedIntegers) {
      const at = this.need(4);
      this.view.setInt32(at, value | 0, false);
      return;
    }
    this.uleb128((value | 0) >>> 0);
  }

  u32(value: number, force = false): void {
    if (force || !this.compressedIntegers) {
      const at = this.need(4);
      this.view.setUint32(at, value >>> 0, false);
      return;
    }
    this.uleb128(value >>> 0);
  }

  /** A **zigzagged** 32-bit integer -- the encoding `s32` fields use. */
  s32(value: number): void {
    if (!this.compressedIntegers) {
      this.i32(value, true);
      return;
    }
    this.uleb128((((value | 0) << 1) ^ ((value | 0) >> 31)) >>> 0);
  }

  /** 64 bits, exact -- a part mask reaches bit 53 and beyond (`Serializer.u64Big`). */
  u64Big(value: bigint, force = false): void {
    if (force || !this.compressedIntegers) {
      const at = this.need(8);
      this.view.setBigUint64(at, value, false);
      return;
    }
    let rest = value;
    for (;;) {
      const group = Number(rest & 0x7fn);
      rest >>= 7n;
      if (rest === 0n) {
        this.u8(group);
        return;
      }
      this.u8(group | 0x80);
    }
  }

  /** Length-prefixed ASCII; the length is an `s32`, so a varint too. */
  str(value: string): void {
    this.s32(value.length);
    for (let i = 0; i < value.length; i += 1) this.u8(value.charCodeAt(i));
  }

  /**
   * Length-prefixed UTF-16, **big-endian**, the length in characters.
   *
   * ⚠️ **The editor XML-escapes creator text and `decodeEntities` undoes it on
   * read, so a name written back has to be escaped again** or every round trip
   * strips a layer. `escapeEntities` in `parts.ts` is the pair; this method
   * writes exactly the characters it is given and does not guess.
   */
  wstr(value: string): void {
    this.s32(value.length);
    for (let i = 0; i < value.length; i += 1) this.u16(value.charCodeAt(i));
  }

  guid(value: number): void {
    this.u32(value);
  }

  sha1(value: Uint8Array): void {
    if (value.length !== 20) throw new WriterError(`SHA-1 of ${value.length} bytes`);
    this.bytes(value);
  }

  /**
   * A resource reference, and the dependency it implies.
   *
   * `isDescriptor` suppresses the leading flags word, exactly as on the read
   * side. ❗ **A descriptor whose type is `PLAN` is not a dependency** -- cwlib
   * skips it when writing and when reading, and a real sequencer plan proves the
   * rule: `PGroup.planDescriptor` names the gadget's own plan GUID 120863 and
   * the table beside it does not list 120863 at all.
   */
  resource(value: DependencyOut | undefined, type: number, isDescriptor = false): void {
    if (this.revision.version > 0x22e && !isDescriptor) this.i32(0);
    const guid = value?.guid ?? 0;
    const hash = value?.hash;
    if (!value || (guid === 0 && !hash)) {
      this.u8(0);
      return;
    }
    let flags = 0;
    if (hash) flags |= 1;
    if (guid !== 0) flags |= 2;
    this.u8(flags);
    if ((flags & 2) !== 0) this.guid(guid);
    if ((flags & 1) !== 0) this.sha1(hash as Uint8Array);
    if (isDescriptor && type === RESOURCE_PLAN) return;
    const key = hash ? `h${[...hash].join('')}` : `g${guid}`;
    if (!this.deps.has(key)) this.deps.set(key, { guid: guid || undefined, hash, type });
  }

  /**
   * A reference to another object in the same stream.
   *
   * The wire format is an id: `0` is null, and an id not written before means
   * the object's bytes follow **right here**. Ids are handed out in first-mention
   * order from 1, which is what `Serializer.reference` expects to see and what
   * cwlib's own writer does.
   */
  reference<T extends object>(value: T | undefined, write: (self: Writer, value: T) => void): void {
    if (!value) {
      this.i32(0);
      return;
    }
    const seen = this.ids.get(value);
    if (seen !== undefined) {
      this.i32(seen);
      return;
    }
    const id = this.nextId;
    this.nextId += 1;
    this.ids.set(value, id);
    this.i32(id);
    write(this, value);
  }

  /** A length-prefixed array of references, which is what most Thing lists are. */
  references<T extends object>(
    values: readonly T[],
    write: (self: Writer, value: T) => void,
  ): void {
    this.i32(values.length);
    for (const value of values) this.reference(value, write);
  }

  vector3(value: readonly number[]): void {
    for (let i = 0; i < 3; i += 1) this.f32(value[i] ?? 0);
  }

  vector4(value: readonly number[]): void {
    for (let i = 0; i < 4; i += 1) this.f32(value[i] ?? 0);
  }

  /**
   * A 4x4 matrix, column-major.
   *
   * With `COMPRESSED_MATRICES` a `u16` says which of the sixteen components are
   * present and the rest come from the identity, so the mask is "which elements
   * differ from the identity". ✔ Checked against the game's own bytes: the
   * `PPos` of a real sequencer plan carries mask `0x3433` -- elements 0, 1, 4,
   * 5, 10, 12 and 13 -- for a matrix that is a scale, a small rotation in the
   * XY plane and a translation with `z` left at zero.
   */
  matrix(value: ArrayLike<number>): void {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    if ((this.compressionFlags & COMPRESSED_MATRICES) === 0) {
      for (let i = 0; i < 16; i += 1) this.f32(value[i]);
      return;
    }
    let mask = 0;
    for (let i = 0; i < 16; i += 1) if (value[i] !== identity[i]) mask |= 1 << i;
    this.u16(mask);
    for (let i = 0; i < 16; i += 1) if ((mask & (1 << i)) !== 0) this.f32(value[i]);
  }

  /**
   * A **byte-plane transposed** integer vector -- `Serializer.intVector`'s pair.
   *
   * The width is the number of bytes the widest value needs, and a width of 0
   * means every value is zero.
   */
  intVector(values: readonly number[]): void {
    if ((this.compressionFlags & COMPRESSED_VECTORS) === 0) {
      this.i32(values.length);
      for (const value of values) this.i32(value);
      return;
    }
    this.i32(values.length);
    if (values.length === 0) return;
    let width = 0;
    for (const value of values) {
      for (let byte = 4; byte > width; byte -= 1) {
        if ((value >>> ((byte - 1) * 8)) & 0xff) width = byte;
      }
    }
    this.u8(width);
    for (let plane = 0; plane < width; plane += 1) {
      for (const value of values) this.u8((value >>> (plane * 8)) & 0xff);
    }
  }
}

/** Everything the container needs around a payload. */
export interface ResourceOut {
  /** Four-character magic: `PLNb` for a plan. */
  readonly magic: string;
  readonly revision: RevisionInfo;
  readonly compressionFlags: number;
  readonly payload: Uint8Array;
  readonly dependencies: readonly DependencyOut[];
}

/** Raw chunk size. The game's own files are cut here; the last chunk is short. */
export const CHUNK_SIZE = 0x8000;

/**
 * Wrap a payload in the `LVLb`/`PLNb` container.
 *
 * The layout is `resource.ts`'s, written back: magic, revision head, a
 * placeholder for the dependency-table offset, the branch pair, the compression
 * flags, the `isCompressed` byte, the always-`0x0001` flag, the chunk table, the
 * chunks, and then the table at the end.
 *
 * ❗ **The dependency-table offset is the end of the chunk data**, which is why
 * `loadResource` can use it as a check on a header it never otherwise verifies.
 * Writing it as anything else produces a file that reads back with the right
 * Things and fails that check -- so the round-trip test in `test/write.test.ts`
 * is checking the header as much as the payload.
 */
export async function writeResource(
  resource: ResourceOut,
  deflate: Deflate,
): Promise<Uint8Array> {
  const { magic, revision, compressionFlags, payload, dependencies } = resource;
  if (magic.length !== 4) throw new WriterError(`magic ${JSON.stringify(magic)} is not 4 bytes`);

  const chunks: { deflated: Uint8Array; rawSize: number }[] = [];
  for (let at = 0; at < payload.length; at += CHUNK_SIZE) {
    const raw = payload.subarray(at, Math.min(at + CHUNK_SIZE, payload.length));
    chunks.push({ deflated: await deflate(raw), rawSize: raw.length });
  }

  let size = 0x16 + chunks.length * 4;
  for (const chunk of chunks) size += chunk.deflated.length;
  const depsAt = size;
  for (const dependency of dependencies) size += dependency.hash ? 25 : 9;
  size += 4;

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i += 1) out[i] = magic.charCodeAt(i);
  view.setUint32(4, ((revision.subVersion << 16) | revision.version) >>> 0, false);
  view.setUint32(8, depsAt, false);
  view.setUint16(12, revision.branchId, false);
  view.setUint16(14, revision.branchRevision, false);
  out[0x10] = compressionFlags;
  out[0x11] = 1; // isCompressed
  view.setUint16(0x12, 1, false); // the flag that is 0x0001 in every file seen
  view.setUint16(0x14, chunks.length, false);
  let at = 0x16;
  for (const chunk of chunks) {
    // ⚠️ Both sizes are u16, which is why a chunk is 0x8000 raw: 0x10000 would
    // not fit, and a chunk that deflates larger than 0xffff cannot be written.
    if (chunk.deflated.length > 0xffff) {
      throw new WriterError(`a chunk deflated to ${chunk.deflated.length} bytes, over 0xffff`);
    }
    view.setUint16(at, chunk.deflated.length, false);
    view.setUint16(at + 2, chunk.rawSize, false);
    at += 4;
  }
  for (const chunk of chunks) {
    out.set(chunk.deflated, at);
    at += chunk.deflated.length;
  }
  if (at !== depsAt) throw new WriterError(`chunk data ended at ${at}, table at ${depsAt}`);

  view.setUint32(at, dependencies.length, false);
  at += 4;
  for (const dependency of dependencies) {
    let flags = 0;
    if (dependency.hash) flags |= 1;
    if (dependency.guid) flags |= 2;
    out[at] = flags;
    at += 1;
    if (dependency.guid) {
      view.setUint32(at, dependency.guid, false);
      at += 4;
    }
    if (dependency.hash) {
      out.set(dependency.hash, at);
      at += 20;
    }
    view.setUint32(at, dependency.type, false);
    at += 4;
  }
  if (at !== out.length) throw new WriterError(`wrote ${at} bytes of ${out.length}`);
  return out;
}
