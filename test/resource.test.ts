import { strict as assert } from 'node:assert';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadResource, ResourceFormatError } from '../src/core/resource.ts';
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
  new DataView(bytes.buffer).setUint16(0x14, 0, false);
  await assert.rejects(
    () => loadResource(bytes, nodeInflate),
    ResourceFormatError,
  );
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
