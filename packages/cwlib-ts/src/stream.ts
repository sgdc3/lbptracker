/**
 * Big-endian reader for LBP serialised data.
 *
 * LBP's formats are PS3-era and stayed big-endian even in the PS4 build --
 * measured: the game's own array serialiser byte-swaps with `movbe` at
 * v0xcc0f9d. See steering/sequencer-data-model.md.
 *
 * No DOM, no Web Audio, no Node built-ins: this file has to run unchanged in a
 * browser and under `node --test`.
 */

export class ByteReader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  private cursor = 0;

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.cursor = offset;
  }

  get position(): number {
    return this.cursor;
  }

  set position(value: number) {
    if (value < 0 || value > this.bytes.length) {
      throw new RangeError(`position ${value} outside 0..${this.bytes.length}`);
    }
    this.cursor = value;
  }

  get remaining(): number {
    return this.bytes.length - this.cursor;
  }

  private need(n: number): number {
    if (this.cursor + n > this.bytes.length) {
      throw new RangeError(
        `read of ${n} at ${this.cursor} runs past end (${this.bytes.length})`,
      );
    }
    const at = this.cursor;
    this.cursor += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.need(1));
  }

  i8(): number {
    return this.view.getInt8(this.need(1));
  }

  bool(): boolean {
    return this.view.getUint8(this.need(1)) !== 0;
  }

  u16(): number {
    return this.view.getUint16(this.need(2), false);
  }

  i16(): number {
    return this.view.getInt16(this.need(2), false);
  }

  u32(): number {
    return this.view.getUint32(this.need(4), false);
  }

  i32(): number {
    return this.view.getInt32(this.need(4), false);
  }

  f32(): number {
    return this.view.getFloat32(this.need(4), false);
  }

  /**
   * LEB128 varint: 7 bits per byte, least significant group first, high bit
   * marks continuation.
   *
   * ⚠️ **Most integers in LBP's serialised structs are varints, not the
   * fixed-width `u32`/`i32` above.** The resource *container* header is
   * fixed-width; the payload inside it is not. Measured by hand-decoding
   * `piano.rinst` -- see steering/sequencer-data-model.md for the worked
   * example. Reading a varint field as `u32` silently desynchronises
   * everything after it.
   */
  varuint(): number {
    let result = 0;
    let shift = 1;
    for (let i = 0; i < 5; i += 1) {
      const byte = this.u8();
      // Multiply rather than shift: `<<` is 32-bit signed and the fifth group
      // would overflow into the sign bit.
      result += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return result;
      shift *= 128;
    }
    throw new RangeError(`varint longer than 5 bytes at ${this.cursor - 5}`);
  }

  /** Zigzag-decoded signed varint: what the game's `s32` fields use. */
  varint(): number {
    const raw = this.varuint();
    return (raw >>> 1) ^ -(raw & 1);
  }

  /** A view onto `n` bytes, without copying. */
  slice(n: number): Uint8Array {
    const at = this.need(n);
    return this.bytes.subarray(at, at + n);
  }

  /** Peek a big-endian u32 without moving the cursor. */
  peekU32(at: number): number {
    if (at + 4 > this.bytes.length) {
      throw new RangeError(`peek at ${at} runs past end (${this.bytes.length})`);
    }
    return this.view.getUint32(at, false);
  }
}

/**
 * A resource's revision. Fields in LBP structs are gated on this, and reading a
 * gated field that is not present desynchronises everything after it -- so the
 * revision has to be threaded through every deserialiser.
 *
 * The high half of the revision word is a branch id when non-zero:
 * 0x021303f9 seen on an LBP3-branch level = branch 0x0213, version 0x03f9.
 */
export class Revision {
  readonly raw: number;

  constructor(raw: number) {
    this.raw = raw >>> 0;
  }

  /** The revision proper, with any branch id stripped. */
  get version(): number {
    return this.raw & 0xffff;
  }

  /** Branch id, or 0 for a mainline revision. */
  get branch(): number {
    return this.raw >>> 16;
  }

  /** `true` when the field gated on `min` is present. */
  atLeast(min: number): boolean {
    return this.version >= min;
  }

  /** `true` when the field gated on `after` is present (strictly greater). */
  after(after: number): boolean {
    return this.version > after;
  }

  toString(): string {
    return this.branch
      ? `0x${this.version.toString(16)} (branch 0x${this.branch.toString(16)})`
      : `0x${this.version.toString(16)}`;
  }
}
