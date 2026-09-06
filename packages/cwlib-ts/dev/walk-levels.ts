/**
 * Walk a directory of level resources and say what the reader still cannot read.
 *
 *   node --experimental-strip-types packages/cwlib-ts/dev/walk-levels.ts [dir]
 *
 * This is the loop that builds `packages/cwlib-ts/src/thing.ts`'s part table out: a Thing
 * carrying a part with no reader throws `UnimplementedPartError` naming it, so
 * the output is a work list rather than a stack trace. It reports the revision
 * of every file too, because the part list and half the field gates hang off it.
 *
 * The levels are the user's own and are not in the repository; the default path
 * is the corpus the golden fixture was built from.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readLevel } from '../src/level.ts';
import { loadResource } from '../src/resource.ts';
import { partReaders } from '../src/parts.ts';
import { UnimplementedPartError } from '../src/thing.ts';
import { nodeInflate } from '../src/platform/node.ts';

const DIR = process.argv[2] ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';
const readers = partReaders();

const missing = new Map<string, number>();
for (const entry of await readdir(DIR, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const bytes = new Uint8Array(await readFile(path.join(DIR, entry.name)));
  const head = await loadResource(bytes, nodeInflate).catch(() => null);
  const tag = head
    ? `${head.magic} v${head.revision.version.toString(16)}/${head.revision.branch.toString(16)} cf${head.compressionFlags}`
    : 'unreadable';
  try {
    const level = await readLevel(bytes, nodeInflate, readers);
    console.log(`${entry.name.slice(0, 8)}  ${tag}  ${level.things.length} things`);
  } catch (error) {
    const label =
      error instanceof UnimplementedPartError
        ? `part ${error.part}`
        : String((error as Error).message);
    console.log(`${entry.name.slice(0, 8)}  ${tag}  -> ${label}`);
    missing.set(label, (missing.get(label) ?? 0) + 1);
  }
}
console.log('');
for (const [what, n] of [...missing].sort((a, b) => b[1] - a[1])) console.log(`  ${n}x  ${what}`);
