/**
 * Node adapters. Nothing in src/core imports this -- it exists so core can stay
 * free of platform APIs and still be driven from `node --test` and CLI tools.
 */

import { deflateSync, inflateRawSync, inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

import type { Inflate, Resource } from '../resource.ts';
import { loadResource } from '../resource.ts';
import type { Deflate } from '../writer.ts';

export const nodeInflate: Inflate = (deflated) =>
  new Uint8Array(inflateSync(deflated));

/** Raw DEFLATE, which is what a ZIP entry stores -- no zlib header, no checksum. */
export const nodeInflateRaw: Inflate = (deflated) =>
  new Uint8Array(inflateRawSync(deflated));

/**
 * Deflate one resource chunk, **with the game's own window size**.
 *
 * ⚠️ `windowBits: 14` is not a tuning choice: it puts CINFO 6 in the zlib
 * header, so a chunk written here starts `0x68` exactly as the game's do, and
 * a hex dump of our output lines up with a hex dump of theirs. The default 15
 * would write `0x78` -- valid, inflatable, and visibly not what LBP writes.
 * See steering/level-files.md and the header of `src/writer.ts`.
 */
export const nodeDeflate: Deflate = (raw) =>
  new Uint8Array(deflateSync(raw, { windowBits: 14, level: 9 }));

export async function loadResourceFile(path: string): Promise<Resource> {
  const bytes = new Uint8Array(await readFile(path));
  return loadResource(bytes, nodeInflate);
}
