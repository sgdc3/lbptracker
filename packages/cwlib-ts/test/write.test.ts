import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CHIP_COLOUR } from '../src/chips.ts';
import { readPlan } from '../src/level.ts';
import { decodeEntities, escapeEntities, partReaders } from '../src/parts.ts';
import { nodeDeflate, nodeInflate } from '../src/platform/node.ts';
import { importLevel, type Sequencer, type Track } from '../src/project.ts';
import { loadResource, readDependencies } from '../src/resource.ts';
import { Serializer } from '../src/serializer.ts';
import {
  DEFAULT_PLAN_ICON,
  LBP3_PS3,
  LBP3_PS4,
  MUSIC_SEQUENCER_MESH,
  sequencerThings,
  writeSequencerPlan,
} from '../src/write-plan.ts';
import { Writer } from '../src/writer.ts';

/**
 * The plans fetched by `dev/fetch-plan.ts`. Other people's levels are never
 * committed, so the corpus check skips without them.
 *
 * ⚠️ **Resolved from this file, not from the working directory.** `npm test`
 * runs from the repository root and `npm test -w @lbptracker/cwlib` runs from
 * the package, so a relative path silently skips the corpus in one of the two
 * -- which is the same as not having written the check.
 */
const PLANS = process.env.LBP_PLANS
  ?? fileURLToPath(new URL('../../../fixtures/plans', import.meta.url));

/* ------------------------------------------------------------- fixtures */

/** Four note records: two one-record notes and a two-record held note. */
function records(...steps: number[]): Uint8Array {
  const out = new Uint8Array(steps.length * 4);
  steps.forEach((step, i) => {
    out[i * 4] = step & 0x7f;
    out[i * 4 + 1] = (60 + i) | (i === steps.length - 1 ? 0x80 : 0);
    out[i * 4 + 2] = 0x60;
    out[i * 4 + 3] = 0x40;
  });
  return out;
}

function track(over: Partial<Track> = {}): Track {
  return {
    guid: 129085,
    name: '',
    colour: DEFAULT_CHIP_COLOUR,
    gridX: 0,
    gridY: 0,
    stepOffset: 0,
    level: 1,
    pan: 0.5,
    echoSend: 0,
    reverbSend: 0,
    key: 0,
    scale: 0,
    notes: [],
    records: records(0),
    trailingRecords: 0,
    ...over,
  };
}

function sequencer(over: Partial<Sequencer> = {}): Sequencer {
  return {
    uid: 1,
    name: 'test song',
    tempo: 130,
    swing: 0,
    echoFeedback: 0.54,
    echoTime: 1,
    echoMix: 0.6,
    reverb: 5,
    loop: true,
    startPoint: 0,
    numChannels: 1,
    volumes: [1, 1, 1, 1, 1, 1],
    boardRows: 4,
    tracks: [track()],
    lengthSteps: 1,
    ...over,
  };
}

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Write a plan and read it straight back through the ordinary reader. */
async function roundTrip(seq: Sequencer, revision = LBP3_PS3): Promise<Sequencer> {
  const bytes = await writeSequencerPlan(seq, nodeDeflate, { revision });
  const { things } = await readPlan(bytes, nodeInflate, partReaders());
  const project = importLevel('written.plan', things, 'plan');
  assert.equal(project.sequencers.length, 1, 'exactly one sequencer read back');
  return project.sequencers[0];
}

/* -------------------------------------------------- the writer primitives */

test('the writer and the reader agree on every primitive', () => {
  const w = new Writer(LBP3_PS3, 7);
  w.u8(0xaa);
  w.i32(0);
  w.i32(-1);
  w.s32(-7);
  w.s32(63);
  w.u64Big(146599346232n);
  w.f32(52.5);
  w.wstr("it's <fine> & \"quoted\"");
  w.str('ascii');
  w.matrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 0, 1]);
  w.intVector([0, 1, 300]);

  const s = new Serializer(w.done(), LBP3_PS3, 7);
  assert.equal(s.u8(), 0xaa);
  assert.equal(s.i32(), 0);
  assert.equal(s.i32(), -1);
  assert.equal(s.s32(), -7);
  assert.equal(s.s32(), 63);
  assert.equal(s.u64Big(), 146599346232n);
  assert.equal(s.f32(), 52.5);
  assert.equal(s.wstr(), "it's <fine> & \"quoted\"");
  assert.equal(s.str(), 'ascii');
  assert.deepEqual([...s.matrix()], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 4, 0, 1]);
  assert.deepEqual(s.intVector(), [0, 1, 300]);
  assert.equal(s.remaining, 0, 'the reader consumed exactly what the writer wrote');
});

test('a matrix writes only what differs from the identity', () => {
  // ✔ The game's own `PPos` carries mask 0x3433 for a scale, a small rotation
  // and a translation with z left at zero -- 7 elements, 14 bytes plus the
  // mask. An identity matrix is the mask alone.
  const w = new Writer(LBP3_PS3, 7);
  w.matrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.equal(hex(w.done()), '0000');
});

test('the buffer grows without losing what was already written', () => {
  // ❗ The regression that motivated the comment on `Writer.need`: the offset
  // has to be taken before the buffer is touched, or everything past the first
  // capacity lands in a discarded array.
  const w = new Writer(LBP3_PS3, 7, 8);
  const payload = new Uint8Array(1000).map((_, i) => i & 0xff);
  w.u8(1);
  w.bytes(payload);
  w.f32(52.5);
  const out = w.done();
  assert.equal(out.length, 1005);
  assert.equal(out[0], 1);
  assert.equal(hex(out.subarray(1, 1001)), hex(payload));
  assert.equal(new Serializer(out.subarray(1001), LBP3_PS3, 7).f32(), 52.5);
});

test('the entity escape is the decode run backwards', () => {
  for (const text of ["'Sands of the Cosmos'", 'Rock & Roll', 'plain', '<a> "b"']) {
    assert.equal(decodeEntities(escapeEntities(text)), text);
  }
  assert.equal(escapeEntities("'x'"), '&apos;x&apos;');
});

/* ------------------------------------------------------------- the plan */

test('a written plan is a container the reader accepts', async () => {
  const bytes = await writeSequencerPlan(sequencer(), nodeDeflate);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'PLNb');
  // ❗ `loadResource` checks that the chunk data ends exactly on the dependency
  // table, which is the same independent check it applies to the game's files:
  // a header written wrongly fails here rather than in the payload.
  const resource = await loadResource(bytes, nodeInflate);
  assert.equal(resource.revision.version, 0x3f9);
  assert.equal(resource.revision.branch, 0x213);
  assert.equal(resource.compressionFlags, 7);
  assert.ok(resource.isCompressed);
  // ⚠️ The game's own zlib header, CINFO 6. `webDeflate` cannot produce it and
  // says so; this pins the Node path the rest of the suite runs on.
  const firstChunk = bytes[0x16 + resource.chunks.length * 4];
  assert.equal(firstChunk, 0x68);
});

test('a sequencer survives the round trip, records byte for byte', async () => {
  const original = sequencer({
    name: "'Wayward'",
    tracks: [
      track({ gridX: 0, gridY: 0, records: records(0, 4, 8) }),
      track({
        guid: 129031, gridX: 2, gridY: 1, pan: 0.25, echoSend: 0.5, key: 12,
        // A chip the composer re-tinted: the plan carries the placement's own
        // colour, not the instrument's factory one.
        colour: 0xffff00ff | 0, records: records(1, 30),
      }),
    ],
  });
  const back = await roundTrip(original);
  assert.equal(back.name, original.name, 'the name survives the editor XML escaping');
  assert.equal(back.tempo, 130);
  assert.equal(back.reverb, 5);
  assert.equal(back.loop, true);
  assert.equal(back.numChannels, 1);
  assert.deepEqual([...back.volumes], [1, 1, 1, 1, 1, 1]);
  assert.equal(back.tracks.length, 2);
  for (let i = 0; i < 2; i += 1) {
    const a = original.tracks[i];
    const b = back.tracks[i];
    assert.equal(b.guid, a.guid);
    assert.equal(b.gridX, a.gridX, 'the board cell comes back through the position');
    assert.equal(b.gridY, a.gridY);
    assert.equal(b.pan, a.pan);
    assert.equal(b.echoSend, a.echoSend);
    assert.equal(b.key, a.key);
    assert.equal(b.colour, a.colour, 'the chip keeps its tint');
    assert.equal(hex(b.records), hex(a.records), 'note records are the same bytes');
  }
});

test('a plan large enough to need several chunks still reads back', async () => {
  // 0x8000 raw per chunk, so 40 chips of 200 notes each crosses the boundary
  // several times -- the case that catches both the chunk table and the
  // writer's buffer growth.
  const many = Array.from({ length: 40 }, (_, i) =>
    track({ gridX: i * 2, gridY: i % 4, records: records(...Array.from({ length: 200 }, (_, n) => n % 64)) }));
  const bytes = await writeSequencerPlan(sequencer({ tracks: many, boardRows: 4 }), nodeDeflate);
  const resource = await loadResource(bytes, nodeInflate);
  assert.ok(resource.chunks.length > 1, `expected several chunks, got ${resource.chunks.length}`);
  const back = await roundTrip(sequencer({ tracks: many, boardRows: 4 }));
  assert.equal(back.tracks.length, 40);
  assert.equal(hex(back.tracks[39].records), hex(many[39].records));
});

test('the dependency table names the mesh and every instrument, all by GUID', async () => {
  const bytes = await writeSequencerPlan(
    sequencer({ tracks: [track({ guid: 129085 }), track({ guid: 129031, gridX: 2 })] }),
    nodeDeflate,
  );
  const deps = readDependencies(bytes);
  // ❗ A hashed dependency would be a USER resource -- a file that has to travel
  // beside the plan. Everything here is a GUID, which is why the plan is
  // self-contained.
  assert.ok(deps.every((d) => d.kind === 'guid'), 'no hashed dependencies');
  const guids = deps.map((d) => (d.kind === 'guid' ? `${d.guid}/${d.type}` : ''));
  assert.ok(guids.includes(`${MUSIC_SEQUENCER_MESH}/2`), 'the gadget mesh');
  assert.ok(guids.includes('129085/48'), 'the first instrument');
  assert.ok(guids.includes('129031/48'), 'the second instrument');
  assert.ok(guids.includes('128331/1'), "the first instrument's chip icon");
  // The gadget's own plan is a DESCRIPTOR and deliberately not listed.
  assert.ok(!guids.some((g) => g.startsWith('120863/')), 'the gadget plan is not a dependency');
});

/**
 * The plan's tail, walked by hand as far as the inventory icon.
 *
 * `readPlan` does not read `InventoryItemDetails` at all, so there is nothing
 * to assert through the reader: the icon has to be found in the bytes. It sits
 * after `thingData`, past four raw fields and six varints.
 */
async function iconDescriptor(bytes: Uint8Array): Promise<{ flags: number; guid: number }> {
  const resource = await loadResource(bytes, nodeInflate);
  let at = resource.revision.branch >= 0xcc ? 1 : 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = resource.data[at];
      at += 1;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
    }
  };
  varint(); // the plan's own revision, which the reader ignores
  // ⚠️ **Not `at += varint()`.** `at` is read before the call that advances it,
  // so the skip comes out short by the length's own bytes -- the same
  // evaluation-order trap `Writer.need` carries a comment about.
  const thingData = varint();
  at += thingData;
  for (let i = 0; i < 10; i += 1) varint(); // four raw fields, then six through colour
  const flags = resource.data[at];
  at += 1;
  return { flags, guid: (flags & 2) !== 0 ? varint() : 0 };
}

test('the inventory icon is written, because the game will not import a plan without one', async () => {
  // ❗ **Measured in the game, 2026-09-10**: with `InventoryItemDetails.Icon`
  // null the resource never reaches ready and `AddInventoryItem` never adds it
  // to the popit. Everything else this writer simplifies was cleared by the
  // same bisection; this one field was not. See `DEFAULT_PLAN_ICON`.
  const bytes = await writeSequencerPlan(sequencer(), nodeDeflate);
  assert.deepEqual(await iconDescriptor(bytes), { flags: 2, guid: DEFAULT_PLAN_ICON });
  const deps = readDependencies(bytes);
  assert.ok(
    deps.some((d) => d.kind === 'guid' && d.guid === DEFAULT_PLAN_ICON && d.type === 1),
    'the icon texture is declared as a dependency',
  );
});

test('a caller can choose the icon, and choosing none is possible and refused by the game', async () => {
  const mine = await writeSequencerPlan(sequencer(), nodeDeflate, { icon: 128331 });
  assert.deepEqual(await iconDescriptor(mine), { flags: 2, guid: 128331 });
  assert.ok(readDependencies(mine).some((d) => d.kind === 'guid' && d.guid === 128331));
  // ⚠️ 0 writes the null descriptor the game rejects. It exists so the failure
  // can be reproduced, not for anybody to use.
  const none = await writeSequencerPlan(sequencer(), nodeDeflate, { icon: 0 });
  assert.deepEqual(await iconDescriptor(none), { flags: 0, guid: 0 });
});

test('an instrument the chip table has never seen still writes', async () => {
  // ⚠️ `chips.ts` has all 68 of the game's instruments; anything else gets no
  // plan GUID and no icon rather than a guess, and the plan is still a plan.
  const back = await roundTrip(sequencer({ tracks: [track({ guid: 999999 })] }));
  assert.equal(back.tracks[0].guid, 999999);
  assert.equal(back.tracks[0].colour, DEFAULT_CHIP_COLOUR, 'and the tint it was given');
});

test('the Thing graph is the shape the game writes', () => {
  const things = sequencerThings(sequencer({ tracks: [track(), track({ gridX: 2 })] }));
  assert.deepEqual(things.map((t) => t.uid), [2, 3, 4, 5, 6]);
  const [root, groupThing, board, first] = things;
  assert.deepEqual(root.parts.map((p) => p.name),
    ['RENDER_MESH', 'POS', 'TRIGGER', 'STICKERS', 'SWITCH', 'GROUP', 'MICROCHIP', 'SEQUENCER']);
  assert.deepEqual(groupThing.parts.map((p) => p.name), ['GROUP']);
  assert.deepEqual(board.parts.map((p) => p.name), ['SWITCH']);
  assert.deepEqual(first.parts.map((p) => p.name), ['INSTRUMENT']);
  assert.equal(board.parent, root);
  assert.equal(board.groupHead, root);
  assert.equal(root.groupHead, groupThing);
  assert.equal(first.parent, board);
  assert.equal(first.groupHead, groupThing);
});

test('an empty sequencer is still a plan', async () => {
  const back = await roundTrip(sequencer({ tracks: [] }));
  assert.equal(back.tracks.length, 0);
  assert.equal(back.tempo, 130);
});

/* ------------------------------------------------------------- the corpus */

test('every real sequencer plan survives being written and read again', async (t) => {
  if (!existsSync(PLANS)) {
    t.skip(`no plans under ${PLANS} -- run dev/fetch-plan.ts`);
    return;
  }
  const readers = partReaders();
  let checked = 0;
  for (const name of await readdir(PLANS)) {
    const bytes = new Uint8Array(await readFile(path.join(PLANS, name)));
    if (bytes.length < 0x16 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'PLNb') continue;
    let project;
    try {
      project = importLevel(name, (await readPlan(bytes, nodeInflate, readers)).things, 'plan');
    } catch {
      continue; // older revisions the reader refuses on purpose
    }
    for (const original of project.sequencers) {
      const back = await roundTrip(original, LBP3_PS4);
      checked += 1;
      assert.equal(back.tracks.length, original.tracks.length, `${name}: track count`);
      assert.equal(back.tempo, original.tempo, `${name}: tempo`);
      assert.equal(back.name, original.name, `${name}: name`);
      for (let i = 0; i < original.tracks.length; i += 1) {
        assert.equal(hex(back.tracks[i].records), hex(original.tracks[i].records),
          `${name}: track ${i} records`);
        assert.equal(back.tracks[i].gridX, original.tracks[i].gridX, `${name}: track ${i} cell`);
        assert.equal(back.tracks[i].gridY, original.tracks[i].gridY, `${name}: track ${i} row`);
      }
    }
  }
  assert.ok(checked > 0, 'the corpus held no sequencer plans');
});

test('a revision this writer does not implement is refused, not guessed at', async () => {
  // ❗ The reader goes back to LBP1 and the writer does not: `PSwitch` alone has
  // nine gates below 0x398 that nothing here writes. A file for one of those
  // would read back plausibly and be wrong, which is what the bound prevents.
  await assert.rejects(
    () => writeSequencerPlan(sequencer(), nodeDeflate, {
      revision: { version: 0x36e, subVersion: 0, branchId: 0, branchRevision: 0 },
    }),
    /not 0x36e/,
  );
  await assert.rejects(
    () => writeSequencerPlan(sequencer(), nodeDeflate, {
      revision: { version: 0x3f9, subVersion: 0x213, branchId: 0x4c44, branchRevision: 0x17 },
    }),
    /branch 0x4c44/,
  );
});
