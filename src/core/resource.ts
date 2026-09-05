/**
 * The LBP serialised-resource container (`LVLb`, `PLNb`, ...).
 *
 * Port of tools/lbpres.py, which is the reference implementation. Layout and
 * how it was verified are in steering/sequencer-data-model.md; the short
 * version is that on 18 real levels every chunk inflates to its declared size
 * and the end of chunk data lands exactly on the dependency-table offset.
 *
 * Inflation is injected rather than imported so this file stays free of Node
 * built-ins: the browser passes a DecompressionStream wrapper, Node passes
 * zlib.inflateSync. See src/platform/.
 */

import { ByteReader, Revision } from './stream.ts';

/** Inflate one zlib stream. May be sync or async; `rawSize` is the expected output length. */
export type Inflate = (
  deflated: Uint8Array,
  rawSize: number,
) => Uint8Array | Promise<Uint8Array>;

export interface ResourceChunk {
  readonly compressedSize: number;
  readonly rawSize: number;
}

export interface Resource {
  /** Four-character magic, e.g. "LVLb". */
  readonly magic: string;
  readonly revision: Revision;
  /** Branch id and revision, a separate pair from the head word's subVersion. */
  readonly branchId: number;
  readonly branchRevision: number;
  /** See `COMPRESSED_INTEGERS` in serializer.ts -- this changes how to read everything. */
  readonly compressionFlags: number;
  readonly isCompressed: boolean;
  /** Offset of the dependency table, which is also the end of the chunk data. */
  readonly dependencyTableOffset: number;
  readonly chunks: readonly ResourceChunk[];
  /** All chunks inflated and concatenated. */
  readonly data: Uint8Array;
}

const HEADER_MIN = 0x16;

export class ResourceFormatError extends Error {}

function magicOf(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
}

/**
 * Parse a serialised resource and inflate its payload.
 *
 * Throws ResourceFormatError when the container does not hold together --
 * never returns a half-decoded result, because a silently truncated buffer is
 * the worst possible input to a deserialiser.
 */
export async function loadResource(
  bytes: Uint8Array,
  inflate: Inflate,
): Promise<Resource> {
  if (bytes.length < HEADER_MIN) {
    throw new ResourceFormatError(
      `too short to be a resource: ${bytes.length} bytes`,
    );
  }

  const reader = new ByteReader(bytes);
  const magic = magicOf(bytes);
  reader.position = 4;
  const revision = new Revision(reader.u32());
  const dependencyTableOffset = reader.u32();

  // ⚠️ These three sit between the dependency-table offset and the chunk table,
  // and the reader used to jump straight past them. `compressionFlags` is not
  // optional detail: with its COMPRESSED_INTEGERS bit set, every 32- and 64-bit
  // integer in the payload is a LEB128 varint instead of four bytes, so a
  // deserialiser that does not know it reads the whole stream wrong.
  const branchId = reader.u16();
  const branchRevision = reader.u16();
  const compressionFlags = reader.u8();
  const isCompressed = reader.u8() !== 0;

  // ⚠️ **`isCompressed` is a real branch and was ignored here for months.** An
  // uncompressed resource has no chunk table at all: the payload starts right
  // after this byte and runs to the dependency table. Every level and plan in
  // the corpus is compressed, so reading the table unconditionally worked until
  // the first `CHKb` streaming chunk arrived -- and then it read a chunk count
  // out of the payload's first bytes ("96 chunks") and failed to inflate the
  // level geometry it found behind it.
  if (!isCompressed) {
    return {
      magic, revision, branchId, branchRevision, compressionFlags, isCompressed,
      dependencyTableOffset, chunks: [],
      data: bytes.subarray(0x12, dependencyTableOffset),
    };
  }

  // 0x12 is a flag that is always 0x0001; the chunk count follows it.
  reader.position = 0x14;
  const chunkCount = reader.u16();

  const chunks: ResourceChunk[] = [];
  let totalRaw = 0;
  for (let i = 0; i < chunkCount; i += 1) {
    const compressedSize = reader.u16();
    const rawSize = reader.u16();
    chunks.push({ compressedSize, rawSize });
    totalRaw += rawSize;
  }

  const out = new Uint8Array(totalRaw);
  let written = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const { compressedSize, rawSize } = chunks[i];
    let deflated: Uint8Array;
    try {
      deflated = reader.slice(compressedSize);
    } catch (cause) {
      throw new ResourceFormatError(
        `chunk ${i}/${chunkCount} runs past the end of the file`,
        { cause },
      );
    }
    let inflated: Uint8Array;
    try {
      inflated = await inflate(deflated, rawSize);
    } catch (cause) {
      throw new ResourceFormatError(`chunk ${i}/${chunkCount} failed to inflate`, {
        cause,
      });
    }
    if (inflated.length !== rawSize) {
      throw new ResourceFormatError(
        `chunk ${i}/${chunkCount} inflated to ${inflated.length}, header says ${rawSize}`,
      );
    }
    out.set(inflated, written);
    written += rawSize;
  }

  // The header never tells the parser where chunk data ends -- it works that
  // out by summing the table. Landing exactly on the dependency table is
  // therefore an independent check that the whole header was read correctly.
  if (reader.position !== dependencyTableOffset) {
    throw new ResourceFormatError(
      `chunk data ends at 0x${reader.position.toString(16)} but the dependency ` +
        `table is at 0x${dependencyTableOffset.toString(16)}`,
    );
  }

  return {
    magic, revision, branchId, branchRevision, compressionFlags, isCompressed,
    dependencyTableOffset, chunks, data: out,
  };
}

/**
 * One entry of a resource's dependency table.
 *
 * ❗ **A SHA-1 dependency is a USER resource and a GUID one is a GAME asset.**
 * That distinction is the whole usefulness of this table to us: the hashed ones
 * are in the public archive under the same URL as the level itself, and the
 * GUIDs are in the game's own FileDB and are not in the archive at all. Measured
 * on "Music Gallery #3": 160 dependencies, **20 hashed and 140 GUIDs**.
 */
export type Dependency =
  | { readonly kind: 'sha1'; readonly sha1: string; readonly type: number }
  | { readonly kind: 'guid'; readonly guid: number; readonly type: number };

/**
 * Dependency types, as far as they have been **measured** rather than read off
 * somebody's enum: every one was checked against the magic of the resource
 * actually downloaded for it, over levels from both PS3 and PS4.
 *
 * | type | magic | what it is | checked |
 * |---|---|---|---|
 * | 1 | `TEX ` | a texture | 3 |
 * | 9 | `LVLb` | a level **inside an adventure** | 10 |
 * | 38 | `PLNb` | a plan: a Thing saved in the popit | 17 |
 * | 61 | `CHKb` | a **streaming chunk** | 22 |
 * | 62 | `ADSb` | an adventure's shared data, 35-270 bytes | 2 |
 *
 * ❗ **Type 9 is why an adventure opens at all.** An `ADCb` has no world of its
 * own: `readBackup` cannot open one, and its levels are hashed dependencies of
 * this type. Following them turns "nothing happened" into the adventure.
 */
export const DEPENDENCY_TEXTURE = 1;
export const DEPENDENCY_LEVEL = 9;
export const DEPENDENCY_PLAN = 38;
export const DEPENDENCY_CHUNK = 61;
export const DEPENDENCY_ADVENTURE_SHARED = 62;

/**
 * The dependency types worth fetching: exactly what `readBackup` can open.
 *
 * ⚠️ **Anything else is somebody else's bandwidth for no song.** A level's table
 * names its textures, meshes and materials too, and `looksLikeLevel` throws all
 * of them away on the first four bytes.
 */
export const OPENABLE_DEPENDENCIES: readonly number[] = [
  DEPENDENCY_LEVEL, DEPENDENCY_PLAN, DEPENDENCY_CHUNK,
];

/**
 * The table at the end of a resource, which `loadResource` only points at.
 *
 * The layout is `u32 count` and then, per entry, `u8 kind` -- 1 for a 20-byte
 * SHA-1, 2 for a `u32` GUID -- followed by a `u32` resource type. It is **not**
 * inside the compressed payload: it sits after it, in the file, which is why
 * this takes the raw bytes rather than a `Resource`.
 *
 * ✔ The reading is self-checking: on a real level the table ended at exactly the
 * last byte of the file (0x52d02 of 0x52d02), which nothing but a correct walk
 * of 160 variable-length entries can do.
 */
export function readDependencies(bytes: Uint8Array): Dependency[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = view.getUint32(8);
  if (at < HEADER_MIN || at + 4 > bytes.length) {
    throw new ResourceFormatError(`dependency table offset 0x${at.toString(16)} is outside the file`);
  }
  const count = view.getUint32(at);
  at += 4;
  const out: Dependency[] = [];
  for (let i = 0; i < count; i += 1) {
    // ⚠️ **The length check has to know the kind**, because the two entries are
    // 25 and 9 bytes. Checking a fixed nine and then reading twenty was the
    // first attempt: `subarray` shortens silently at the end of a buffer, so a
    // truncated table produced a HASH THAT WAS SHORT rather than an error --
    // and a short hash is a URL that 404s for a reason nobody could see. The
    // test truncates a real table by eight bytes to keep this honest.
    if (at + 1 > bytes.length) {
      throw new ResourceFormatError(`dependency ${i} of ${count} runs past the end of the file`);
    }
    const kind = view.getUint8(at);
    at += 1;
    const needs = kind === 1 ? 24 : kind === 2 ? 8 : 0;
    if (needs === 0) {
      throw new ResourceFormatError(`dependency ${i} has kind ${kind}, which is neither hash nor GUID`);
    }
    if (at + needs > bytes.length) {
      throw new ResourceFormatError(`dependency ${i} of ${count} runs past the end of the file`);
    }
    if (kind === 1) {
      const sha1 = [...bytes.subarray(at, at + 20)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      at += 20;
      out.push({ kind: 'sha1', sha1, type: view.getUint32(at) });
    } else {
      const guid = view.getUint32(at);
      at += 4;
      out.push({ kind: 'guid', guid, type: view.getUint32(at) });
    }
    at += 4;
  }
  return out;
}
