import { strict as assert } from 'node:assert';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  DEPENDENCY_PLAN, DEPENDENCY_TEXTURE, loadResource, readDependencies, ResourceFormatError,
} from '../src/core/resource.ts';
import { nodeInflate, loadResourceFile } from '../src/platform/node.ts';

/**
 * The level corpus is other people's creative work and is never committed --
 * see steering/lbp-modding-toolchain.md. Point LBP_LEVELS at a directory of
 * level resources to run the corpus checks; without it they skip.
 */
const CORPUS =
  process.env.LBP_LEVELS ??
  'C:\\Users\\sgdc3\\Desktop\\LBP\\toolkit\\tools\\sequencerdump';

async function findLevels(root: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    // Only the data* folders hold resources; out* holds MIDI exports.
    if (entry.isDirectory()) {
      if (root === CORPUS && !entry.name.startsWith('data')) continue;
      await findLevels(full, out);
    } else if (/^[0-9a-f]{40}$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test('rejects a buffer too short to be a resource', async () => {
  await assert.rejects(
    () => loadResource(new Uint8Array(4), nodeInflate),
    ResourceFormatError,
  );
});

test('rejects a header whose chunk table does not reach the dependency table', async () => {
  // "LVLb", revision 0x3ee, deps at 0x999 (a lie), one tiny chunk.
  const bytes = new Uint8Array(0x16 + 4 + 8);
  bytes.set([0x4c, 0x56, 0x4c, 0x62], 0);
  new DataView(bytes.buffer).setUint32(4, 0x3ee, false);
  new DataView(bytes.buffer).setUint32(8, 0x999, false);
  // ⚠️ `isCompressed`, and it has to be set: an uncompressed resource has no
  // chunk table for this check to be about. Streaming chunks are the first
  // resources in the corpus that are stored that way.
  bytes[0x11] = 1;
  new DataView(bytes.buffer).setUint16(0x14, 0, false);
  await assert.rejects(
    () => loadResource(bytes, nodeInflate),
    ResourceFormatError,
  );
});

test('an uncompressed resource is its payload, with no chunk table', async () => {
  // ❗ **`isCompressed` was read and then ignored here.** Every level and plan
  // in the corpus is compressed, so reading a chunk table unconditionally worked
  // until the first `CHKb`: it took a chunk count out of the payload's own first
  // bytes -- 96 of them -- and failed to inflate the level geometry behind it.
  const payload = new TextEncoder().encode('the island geometry goes here');
  const bytes = new Uint8Array(0x12 + payload.length + 4);
  bytes.set(new TextEncoder().encode('CHKb'), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 0x021303f9, false);
  view.setUint32(8, 0x12 + payload.length, false); // the dependency table
  bytes[0x10] = 0; // compressionFlags: plain integers, as a chunk really has
  bytes[0x11] = 0; // isCompressed
  bytes.set(payload, 0x12);
  const resource = await loadResource(bytes, nodeInflate);
  assert.equal(resource.magic, 'CHKb');
  assert.equal(resource.chunks.length, 0);
  assert.equal(new TextDecoder().decode(resource.data), 'the island geometry goes here');
});

test('every level in the corpus parses, and chunk data ends on the dependency table', async (t) => {
  const levels = await findLevels(CORPUS);
  if (levels.length === 0) {
    t.skip(`no level corpus at ${CORPUS} (set LBP_LEVELS)`);
    return;
  }

  let totalRaw = 0;
  const revisions = new Set<string>();
  for (const file of levels) {
    const resource = await loadResourceFile(file);
    // loadResource already throws unless chunk data lands exactly on the
    // dependency table -- an offset it never uses while parsing, so this is an
    // independent check that the whole header was read correctly.
    assert.equal(resource.magic, 'LVLb', `${path.basename(file)} magic`);
    assert.ok(resource.revision.version >= 0x300, 'revision looks sane');
    assert.ok(resource.data.length > 0, 'inflated to something');
    const declared = resource.chunks.reduce((n, c) => n + c.rawSize, 0);
    assert.equal(resource.data.length, declared, 'inflated size matches the table');
    const onDisk = (await stat(file)).size;
    assert.ok(
      resource.data.length > onDisk,
      'inflated payload should exceed the compressed file',
    );
    totalRaw += resource.data.length;
    revisions.add(resource.revision.toString());
  }

  console.log(
    `    ${levels.length} levels, ${(totalRaw / 1e6).toFixed(1)} MB inflated, ` +
      `revisions: ${[...revisions].sort().join(', ')}`,
  );
  assert.ok(levels.length >= 10, 'expected the full corpus');
});

// ---------------------------------------------------------- dependency table

/**
 * A resource whose only real content is its dependency table.
 *
 * `readDependencies` reads the offset at byte 8 and walks from there, so the
 * head can be anything -- which is the point: the table is **after** the
 * compressed payload, in the file, not inside it.
 */
function withDependencies(entries: (readonly [1 | 2, number[] | number, number])[]): Uint8Array {
  const body: number[] = [];
  const u32 = (n: number) => body.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  u32(entries.length);
  for (const [kind, key, type] of entries) {
    body.push(kind);
    if (kind === 1) body.push(...(key as number[]));
    else u32(key as number);
    u32(type);
  }
  // A header of the shortest length a real one can have, with the dependency
  // table starting immediately after it. Only bytes 8..11 are read.
  const head = new Array(HEAD).fill(0);
  head[0] = 0x4c; head[1] = 0x56; head[2] = 0x4c; head[3] = 0x62; // "LVLb"
  head[8] = 0; head[9] = 0; head[10] = 0; head[11] = HEAD;        // the offset
  return new Uint8Array([...head, ...body]);
}

/** `HEADER_MIN` in `resource.ts`; an offset below it is rejected as nonsense. */
const HEAD = 0x16;

const HASH = Array.from({ length: 20 }, (_, i) => i + 1);
const HASH_HEX = '0102030405060708090a0b0c0d0e0f1011121314';

test('a dependency table separates hashed user resources from GUID game assets', () => {
  const bytes = withDependencies([
    [1, HASH, DEPENDENCY_PLAN],
    [2, 0x1234, DEPENDENCY_TEXTURE],
    [1, HASH.map((b) => b + 1), DEPENDENCY_TEXTURE],
  ]);
  assert.deepEqual(readDependencies(bytes), [
    { kind: 'sha1', sha1: HASH_HEX, type: DEPENDENCY_PLAN },
    { kind: 'guid', guid: 0x1234, type: DEPENDENCY_TEXTURE },
    { kind: 'sha1', sha1: '02030405060708090a0b0c0d0e0f101112131415', type: DEPENDENCY_TEXTURE },
  ]);
});

// The entries are variable-length, so a table that claims more than it holds
// walks off the end. Saying which entry ran out beats returning a short list
// that looks like a level with fewer plans than it has.
test('a truncated dependency table is an error, not a short list', () => {
  const bytes = withDependencies([[1, HASH, DEPENDENCY_PLAN]]);
  assert.throws(() => readDependencies(bytes.subarray(0, bytes.length - 8)), ResourceFormatError);
  const badKind = withDependencies([[1, HASH, DEPENDENCY_PLAN]]);
  // The first entry's kind byte: past the header and the u32 count.
  badKind[HEAD + 4] = 7;
  assert.throws(() => readDependencies(badKind), /neither hash nor GUID/);
});

test('an empty dependency table is a table, not a failure', () => {
  assert.deepEqual(readDependencies(withDependencies([])), []);
});
