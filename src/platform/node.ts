/**
 * Node adapters. Nothing in src/core imports this -- it exists so core can stay
 * free of platform APIs and still be driven from `node --test` and CLI tools.
 */

import { inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';

import type { Inflate, Resource } from '../core/resource.ts';
import { loadResource } from '../core/resource.ts';

export const nodeInflate: Inflate = (deflated) =>
  new Uint8Array(inflateSync(deflated));

export async function loadResourceFile(path: string): Promise<Resource> {
  const bytes = new Uint8Array(await readFile(path));
  return loadResource(bytes, nodeInflate);
}
