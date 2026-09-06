/**
 * Browser adapters.
 *
 * The user's own game files are read client-side and never uploaded -- see
 * steering/game-assets.md. That constraint is why this file exists at all:
 * everything here works on a File the user picked, with no network.
 */

import type { Inflate, Resource } from '../resource.ts';
import { loadResource } from '../resource.ts';

/**
 * Inflate with the platform's own DecompressionStream. Note LBP's zlib streams
 * carry a 0x68 header (16 KiB window), not the more familiar 0x78 -- that is a
 * valid zlib header and 'deflate' handles it.
 */
export const webInflate: Inflate = async (deflated, rawSize) => {
  const stream = new Blob([deflated as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  const out = new Uint8Array(rawSize);
  let written = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    if (written + chunk.length > out.length) {
      // Longer than the header promised; loadResource reports the mismatch.
      const grown = new Uint8Array(written + chunk.length);
      grown.set(out.subarray(0, written));
      grown.set(chunk, written);
      return grown;
    }
    out.set(chunk, written);
    written += chunk.length;
  }
  return written === out.length ? out : out.subarray(0, written);
};

/**
 * Raw DEFLATE, which is what a ZIP entry stores.
 *
 * ❗ `deflate-raw`, not `deflate`: a ZIP has no zlib header and no Adler
 * checksum, and feeding one to the wrapped decoder fails on the first byte.
 */
export const webInflateRaw = async (deflated: Uint8Array, rawSize: number) => {
  const stream = new Blob([deflated as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return rawSize > 0 && out.length > rawSize ? out.subarray(0, rawSize) : out;
};

/** Read a resource from a File the user picked. Nothing leaves the browser. */
export async function loadResourceFile(file: File): Promise<Resource> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return loadResource(bytes, webInflate);
}
