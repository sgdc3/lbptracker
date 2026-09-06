/**
 * Where this reader is when it gives up on a level, and what it read to get there.
 *
 *     node --experimental-strip-types dev/trace-level.ts <file-or-prefix> [tail-lines]
 *
 * ❗ **The other half of `tools/CwlibTrace.java`.** That prints cwlib's part
 * boundaries with their byte offsets; this prints ours in the same units, so a
 * divergence is a diff:
 *
 * ```
 *   CwlibTrace spans fixtures/archive/0-c33a7e*   |  cwlib   SHAPE 121..233
 *   trace-level.ts 0-c33a7e                       |  ours    SHAPE 121..248
 * ```
 *
 * The first part whose span disagrees is the reader to fix, and it names the
 * file to open in cwlib's `structs/things/parts/`. That loop closed seven
 * readers on 2026-09-06; see question 28 in `steering/open-questions.md`.
 *
 * ⚠️ **To reach an LBP1 file at all, lower `LBP3_MIN_VERSION` in
 * `src/core/serializer.ts` by hand** -- the walk refuses `0x272` long before any
 * of this runs, and that bound is deliberate. Put it back afterwards; the golden
 * fixture (`dev/verify-levels.ts`) is what says you did.
 *
 * The trace fires twice per frame: on entry with an end of -1, on exit with the
 * real end. The frames still open when it throws are the ones holding the bug,
 * so they are printed separately.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { readLevel } from '../src/core/level.ts';
import { partReaders } from '../src/core/parts.ts';
import { setTrace } from '../src/core/thing.ts';
import { nodeInflate } from '../src/platform/node.ts';

const arg = process.argv[2];
const tail = Number(process.argv[3] ?? 24);
if (!arg) {
  console.error('usage: trace-level.ts <file-or-prefix> [tail-lines]');
  process.exit(1);
}

/** A path, or a prefix to look up in the archive sample. */
const resolve = async (): Promise<string> => {
  if (arg.includes('/') || arg.includes('\\')) return arg;
  const dir = 'fixtures/archive';
  const hit = (await readdir(dir)).find((n) => n.startsWith(arg));
  if (!hit) throw new Error(`no file in ${dir} starts with ${arg}`);
  return path.join(dir, hit);
};

const file = await resolve();
const bytes = new Uint8Array(await readFile(file));

const open: string[] = [];
const log: string[] = [];
setTrace((event, start, end) => {
  if (end < 0) {
    open.push(`${event}@${start}`);
    log.push(`${'  '.repeat(open.length)}${event} @${start}`);
  } else {
    open.pop();
    log.push(`${'  '.repeat(open.length + 1)}${event} ${start}..${end}`);
  }
});

try {
  const result = await readLevel(bytes, nodeInflate, partReaders());
  console.log(`${path.basename(file)}: ${result.things.length} things, revision `
    + `0x${result.revision.version.toString(16)}/0x${result.revision.subVersion.toString(16)}`);
  console.log('\ncompare with:  CwlibTrace parts "%s"', file);
} catch (error) {
  console.log(log.slice(-tail).join('\n'));
  console.log('\nstill open: %s', open.join(' > '));
  console.log('FAILED: %s', (error as Error).message);
  console.log('\ncompare with:  CwlibTrace spans "%s"', file);
}
setTrace(undefined);
