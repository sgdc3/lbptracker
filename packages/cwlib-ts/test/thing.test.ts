/**
 * Which part a Thing's mask bit means, and the two part readers that got it
 * wrong for a while: `PQuest` and `PWormhole`.
 *
 * ⚠️ **Below subVersion `0x107` a mask bit is not a part index.** `PCreatorAnim`
 * has bit `0x29` and every part above `0x28` sits one bit higher (`partBit` in
 * `src/thing.ts`, and the game's Thing loader at `v0xd49d92`). Read with the live
 * bits, an LBP2 level's `PWormhole` came out as a `PQuest` of type 2 and the level
 * would not open. The Things below are built byte by byte; the part bodies are
 * real ones, copied out of two levels on Bonsai (#24 and #14163).
 *
 * The quest layouts for types 1 to 4 have never been seen in a file. They are
 * pinned here as the game's loader reads them (`v0xdc0290`), so a change to
 * `readQuest` has to be a change to that reading, not an accident.
 */

import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { readBackup, sequencersOf } from '../src/backup.ts';
import { partReaders } from '../src/parts.ts';
import { COMPRESSED_INTEGERS, Serializer, type RevisionInfo } from '../src/serializer.ts';
import { partBit, readThing, UnimplementedPartError } from '../src/thing.ts';
import { nodeInflate } from '../src/platform/node.ts';

const LBP2 = { version: 0x3f8, subVersion: 0, branchId: 0, branchRevision: 0 };
const LBP3_PS4 = { version: 0x3f9, subVersion: 0x218, branchId: 0, branchRevision: 0 };

/** An unsigned LEB128, which is what every integer is in a compressed stream. */
function varint(n: bigint | number): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    out.push(v === 0n ? byte : byte | 0x80);
  } while (v !== 0n);
  return out;
}

/** One Thing at version 0x3f8 or later, carrying exactly the parts the mask bits name. */
function thingBytes(revision: RevisionInfo, bits: number[], parts: number[]): Uint8Array {
  let mask = 0n;
  for (const bit of bits) mask |= 1n << BigInt(bit);
  return Uint8Array.from([
    0xaa, // test marker
    0x01, // uid
    0x00, 0x00, 0x00, // parent, groupHead, oldEmitter: all null
    0x00, 0x00, 0x00, 0x00, // createdBy, changedBy: raw i16s
    0x00, // planGuid
    0x00, // flags
    ...(revision.subVersion >= 0x110 ? [0x00] : []), // extraFlags
    0x7e, // parts revision 0x3f, zigzag
    ...varint(mask),
    ...parts,
  ]);
}

function read(revision: RevisionInfo, bytes: Uint8Array) {
  const s = new Serializer(bytes, revision, COMPRESSED_INTEGERS);
  const thing = readThing(s, partReaders());
  return { thing, left: s.remaining };
}

// The wormhole out of level #24, behind reference id 2: type 1, player mode 1,
// audio on, three flags off, exit count 39, exit delay 109810.
const WORMHOLE_SV0 = [0x02, 0x02, 0x02, 0x01, 0x00, 0x00, 0x00, 0x27, 0xf2, 0xd9, 0x06];
// A quest out of level #14163, behind reference id 2: type 5, two empty
// strings, the quest key, an objective key of 0.
const QUEST_SV218 = [0x02, 0x05, 0x00, 0x00, 0xcb, 0xb4, 0xcb, 0xaf, 0x09, 0x00];

test('bit 0x31 is a wormhole below subVersion 0x107, and a quest above it', () => {
  const old = read(LBP2, thingBytes(LBP2, [0x31], WORMHOLE_SV0));
  assert.deepEqual([...old.thing.parts.keys()], ['WORMHOLE']);
  assert.equal(old.left, 0, 'the wormhole is exactly its eight fields at subVersion 0');

  const live = read(LBP3_PS4, thingBytes(LBP3_PS4, [0x31], QUEST_SV218));
  assert.deepEqual([...live.thing.parts.keys()], ['QUEST']);
  assert.equal(live.left, 0);
});

test('the creator anim has bit 0x29 below subVersion 0x107, and must be null', () => {
  const nullAnim = read(LBP2, thingBytes(LBP2, [0x29], [0x00]));
  assert.deepEqual([...nullAnim.thing.parts.keys()], ['CREATOR_ANIM']);
  assert.equal(nullAnim.left, 0);
  assert.throws(
    () => read(LBP2, thingBytes(LBP2, [0x29], [0x02, 0x00])),
    (e: unknown) => e instanceof UnimplementedPartError && e.part === 'CREATOR_ANIM',
  );
});

test('the part bits, below and above the creator anim', () => {
  const at = (name: string, index: number, subVersion: number) => partBit({ name, index }, subVersion);
  assert.equal(at('POCKET_ITEM', 0x28, 0), 0x28, 'nothing below 0x29 moves');
  assert.equal(at('CREATOR_ANIM', 0x3e, 0), 0x29);
  assert.equal(at('TRANSITION', 0x29, 0), 0x2a);
  assert.equal(at('STREAMING_HINT', 0x35, 0x106), 0x36);
  assert.equal(at('CREATOR_ANIM', 0x3e, 0x107), undefined);
  assert.equal(at('TRANSITION', 0x29, 0x107), 0x29);
  assert.equal(at('QUEST', 0x31, 0x218), 0x31);
});

/** Read one quest body (no reference id) at a subVersion, and say how much is left. */
function quest(subVersion: number, bytes: number[]): number {
  const s = new Serializer(Uint8Array.from(bytes), { ...LBP2, subVersion }, COMPRESSED_INTEGERS);
  partReaders().get('QUEST')!(s, undefined as never);
  return s.remaining;
}

const WSTR_A = [0x02, 0x00, 0x41]; // one UTF-16 character, "A"

test('a quest reads what the game reads, at every gate', () => {
  // subVersion 0: the type and one byte (head <= 0x51ffff), nothing else.
  assert.equal(quest(0, [0x05, 0x00, 0xff]), 1);
  // 0x218: the two strings and the two keys, no byte, and no block for type 5.
  assert.equal(quest(0x218, [0x05, ...WSTR_A, 0x00, 0x07, 0x08, 0xff]), 1);
  // Type 2 at 0x218: one string after the keys.
  assert.equal(quest(0x218, [0x02, 0x00, 0x00, 0x07, 0x08, ...WSTR_A, 0xff]), 1);
  // Type 1 at 0x100: two strings, a byte, and the extra byte of 0x5e..0x126.
  assert.equal(quest(0x100, [0x01, 0x00, 0x00, ...WSTR_A, 0x00, 0x01, 0x01, 0xff]), 1);
  // Type 1 at 0x218: the extra byte is gone again.
  assert.equal(quest(0x218, [0x01, 0x00, 0x00, 0x07, 0x08, 0x00, 0x00, 0x01, 0xff]), 1);
  // Types 3 and 4: an integer and three strings.
  for (const type of [0x03, 0x04]) {
    assert.equal(quest(0x218, [type, 0x00, 0x00, 0x07, 0x08, 0x09, ...WSTR_A, 0x00, 0x00, 0xff]), 1);
  }
  // Below 0x47 no type has a block: type 2 at 0x46 is the type and the byte.
  assert.equal(quest(0x46, [0x02, 0x00, 0xff]), 1);
  assert.throws(() => quest(0x218, [0x06]), /quest type 6/);
});

/**
 * The two levels that found this, when they are on this machine.
 *
 * They are other people's levels and `fixtures/` is never committed, so this
 * skips without them; `steering/level-files.md` (*Bonsai*) says how to fetch
 * them again.
 */
const BONSAI = path.resolve(import.meta.dirname, '../../../fixtures/bonsai');
const LEVELS: [string, number][] = [
  ['24-c8add2439485c2ba38cc61c4b87f47af61746e0d', 3],
  ['19883-377607875fc21ddda72c26e89953a260382a3d96', 4],
];

test('the two LBP2 levels with a wormhole open, songs and all', async (t) => {
  for (const [file, songs] of LEVELS) {
    const at = path.join(BONSAI, file);
    if (!existsSync(at)) {
      t.skip(`${file} is not in fixtures/bonsai`);
      continue;
    }
    const result = await readBackup([{ name: file, bytes: new Uint8Array(readFileSync(at)) }], nodeInflate);
    assert.deepEqual(result.failed, [], file);
    assert.equal(sequencersOf(result).length, songs, file);
  }
});
