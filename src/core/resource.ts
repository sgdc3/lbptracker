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
