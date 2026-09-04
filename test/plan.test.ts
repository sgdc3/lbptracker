import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { musicSequencers, readPlan } from '../src/core/level.ts';
import { partReaders } from '../src/core/parts.ts';
import { readSaveArchive, saveArchiveRevision } from '../src/core/savearchive.ts';
import { nodeInflate } from '../src/platform/node.ts';

/**
 * The corpus is other people's creative work and is never committed -- see
 * `steering/lbp-modding-toolchain.md`. Point `LBP_LEVELS` at the checkout to run
 * the corpus checks; without it they skip.
 */
const CORPUS =
  process.env.LBP_LEVELS ?? 'C:\\Users\\sgdc3\\Desktop\\LBP\\toolkit\\tools\\sequencerdump';

/* ------------------------------------------------------------- synthetic */

/** LEB128, which is how an i32 is written when `COMPRESSED_INTEGERS` is set. */
function uleb(value: number): number[] {
  const out: number[] = [];
  let v = value;
  do {
    const byte = v & 0x7f;
    v >>>= 7;
    out.push(v === 0 ? byte : byte | 0x80);
  } while (v !== 0);
  return out;
}

/** A `PLNb` resource holding `thingData`, built the way the game's container is. */
function buildPlan(thingData: number[]): Uint8Array {
  const payload = Uint8Array.from([
    ...uleb(0x3ef), // the plan's own revision, which the reader ignores
    ...uleb(thingData.length),
    ...thingData,
  ]);
  const packed = new Uint8Array(deflateSync(payload));
  const out = new Uint8Array(0x16 + 4 + packed.length);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('PLNb'), 0);
  view.setUint32(4, 0x000003ef, false); // version 0x3ef, subVersion 0
  view.setUint32(8, out.length, false); // the dependency table, i.e. the end
  view.setUint16(12, 0, false); // branchId
  view.setUint16(14, 0, false); // branchRevision
  out[0x10] = 7; // compressionFlags: integers, vectors and matrices, as the corpus
  out[0x11] = 1; // isCompressed
  view.setUint16(0x12, 1, false);
  view.setUint16(0x14, 1, false); // one chunk
  view.setUint16(0x16, packed.length, false);
  view.setUint16(0x18, payload.length, false);
  out.set(packed, 0x1a);
  return out;
}

test('a plan with no Things in it reads as no Things', async () => {
  // ❗ The wrapper is what this exercises: the ignored revision, the
  // length-prefixed blob, and the count inside it. `RPlan` is four fields and
  // getting the blob's boundary wrong is the only way to get them wrong.
  const { things, revision } = await readPlan(
    buildPlan(uleb(0)),
    nodeInflate,
    partReaders(),
  );
  assert.deepEqual(things, []);
  assert.equal(revision.version, 0x3ef);
});

test('a plan whose Things do not fill thingData is refused', async () => {
  // ⚠️ **Left-over bytes mean a part reader took the wrong number**, and the
  // parse is wrong even though it ran to the end. Without this check that is a
  // plan that silently loses whatever came after the misread.
  await assert.rejects(
    () => readPlan(buildPlan([...uleb(0), 0x99]), nodeInflate, partReaders()),
    /left 1 of 2 bytes unread/,
  );
});

/* ---------------------------------------------------------------- corpus */

/** Every PS3 save folder under the corpus, by the `PARAM.SFO` beside its data. */
async function saveFolders(root: string, out: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  if (entries.some((e) => e.name.toUpperCase() === 'PARAM.SFO')) out.push(root);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (root === CORPUS && !entry.name.startsWith('data')) continue;
    await saveFolders(path.join(root, entry.name), out);
  }
  return out;
}

async function chunksOf(folder: string): Promise<Uint8Array[]> {
  const names = (await readdir(folder))
    .filter((name) => /^\d+$/.test(name))
    .sort((a, b) => Number(a) - Number(b));
  const out: Uint8Array[] = [];
  for (const name of names) out.push(new Uint8Array(await readFile(path.join(folder, name))));
  return out;
}

test('every plan in the corpus parses, and holds the music the levels do not', async (t) => {
  const folders = await saveFolders(CORPUS);
  if (folders.length === 0) {
    t.skip(`no save folders under ${CORPUS}`);
    return;
  }
  const readers = partReaders();
  let plans = 0;
  let parsed = 0;
  let sequencers = 0;
  const unexplained: string[] = [];
  for (const folder of folders) {
    const chunks = await chunksOf(folder);
    if (chunks.length === 0 || saveArchiveRevision(chunks[chunks.length - 1]) === undefined) continue;
    for (const resource of await readSaveArchive(chunks)) {
      const bytes = resource.bytes;
      if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'PLNb') continue;
      plans += 1;
      try {
        const { things } = await readPlan(bytes, nodeInflate, readers);
        parsed += 1;
        sequencers += musicSequencers(things).length;
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        // ❗ A failure is allowed to be a part this reader has not been taught or
        // a revision it refuses on purpose. Anything else is a bug in the plan
        // reader wearing a plausible message.
        if (!/no reader for part|outside the LBP3 range/.test(why)) {
          unexplained.push(`${resource.sha1.slice(0, 8)}: ${why}`);
        }
      }
    }
  }
  assert.deepEqual(unexplained, [], 'no plan failed for a reason other than a known gap');
  // Measured 2026-09-04 over the five saves in the checkout. The two that do not
  // parse are one `YELLOWHEAD` and one revision 0x272, both named above.
  assert.equal(plans, 213, 'plans in the corpus');
  assert.equal(parsed, 211, 'plans that parse');
  // ⚠️ **This is the number that says why plans matter.** The same five saves
  // hold five levels between them; the music is in the popit copies. 172 out of
  // 171 plans -- one plan carries two sequencers, which is why this counts the
  // sequencers and not the plans.
  assert.equal(sequencers, 172, 'music sequencers found inside plans');
});
