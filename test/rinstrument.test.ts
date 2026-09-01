import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { ByteReader } from '../src/core/stream.ts';
import { readInstrument, usedSlots } from '../src/core/rinstrument.ts';
import { loadResourceFile } from '../src/platform/node.ts';

/**
 * The .rinst files are extracted from the user's own game with
 * tools/ExtractGuid.java and are never committed. Without them these skip.
 */
const RINST = process.env.LBP_RINST ?? 'fixtures/rinst';

// ------------------------------------------------------------------- varints

test('varuint decodes LEB128 groups least-significant first', () => {
  const cases: [number[], number][] = [
    [[0x00], 0],
    [[0x08], 8],
    [[0x7f], 127],
    [[0x80, 0x01], 128],
    [[0xa8, 0x01], 168],
    [[0xc9, 0xbe, 0x07], 122697], // a real sample GUID from piano.rinst
    [[0xff, 0xff, 0xff, 0xff, 0x0f], 0xffffffff],
  ];
  for (const [bytes, expected] of cases) {
    const reader = new ByteReader(Uint8Array.from(bytes));
    assert.equal(reader.varuint(), expected, bytes.map((b) => b.toString(16)).join(' '));
    assert.equal(reader.remaining, 0, 'consumed every byte');
  }
});

test('varint zigzag-decodes to signed values', () => {
  const cases: [number[], number][] = [
    [[0x00], 0],
    [[0x01], -1],
    [[0x02], 1],
    [[0x03], -2],
    [[0xa8, 0x01], 84], // piano.rinst slot 0 baseNote = C6
    [[0x90, 0x01], 72],
    [[0x78], 60],
    [[0x60], 48],
    [[0x48], 36],
  ];
  for (const [bytes, expected] of cases) {
    assert.equal(new ByteReader(Uint8Array.from(bytes)).varint(), expected);
  }
});

test('a varint longer than five bytes is rejected rather than silently wrapped', () => {
  const runaway = Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
  assert.throws(() => new ByteReader(runaway).varuint(), RangeError);
});

// --------------------------------------------------------------- instruments

test('piano.rinst decodes to the multisample the FileDB describes', async (t) => {
  const file = path.join(RINST, 'piano.rinst');
  if (!existsSync(file)) {
    t.skip(`no ${file} (extract with tools/ExtractGuid.java, or set LBP_RINST)`);
    return;
  }
  const resource = await loadResourceFile(file);
  assert.equal(resource.magic, 'INSb');

  const instrument = readInstrument(resource.data);
  const used = usedSlots(instrument);
  assert.equal(used.length, 5, 'the piano is a five-way multisample');

  // Slots run high to low, and the GUIDs are piano_c6 .. piano_c2 in the FileDB.
  assert.deepEqual(
    used.map((u) => u.slot.baseNote),
    [84, 72, 60, 48, 36],
  );
  assert.deepEqual(
    used.map((u) => u.guid),
    [122697, 122696, 122695, 122694, 122693],
  );
  for (const { slot } of used) {
    assert.equal(slot.pitched, true, 'a piano is pitched');
    assert.equal(slot.baseBpm, 149.5, 'the default sample tempo');
    assert.equal(slot.fineTune, 0);
  }
});

test('every instrument the game ships parses, consuming its payload exactly', async (t) => {
  if (!existsSync(RINST)) {
    t.skip(`no ${RINST} (extract with tools/ExtractGuid.java, or set LBP_RINST)`);
    return;
  }
  const files = (await readdir(RINST)).filter((f) => f.endsWith('.rinst'));
  if (files.length === 0) {
    t.skip(`no .rinst files in ${RINST}`);
    return;
  }

  const revisions = new Set<string>();
  let pitchedSlots = 0;
  let unpitchedSlots = 0;
  let multisamples = 0;
  let fitBpm = 0;

  for (const name of files) {
    const resource = await loadResourceFile(path.join(RINST, name));
    assert.equal(resource.magic, 'INSb', `${name} magic`);
    revisions.add(resource.revision.toString());

    // readInstrument throws unless the payload is consumed to the last byte,
    // which is the real assertion: a misread varint lands somewhere else.
    const instrument = readInstrument(resource.data);

    assert.equal(instrument.slots.length, 8, `${name} slots`);
    assert.equal(instrument.splitNotes.length, 9, `${name} splits`);
    assert.equal(instrument.params.length, 27, `${name} params`);
    assert.equal(instrument.arpeggio.length, 32, `${name} arpeggio`);

    const used = usedSlots(instrument);
    assert.ok(used.length > 0, `${name} uses at least one sample`);
    if (used.length > 1) multisamples += 1;
    for (const { slot, guid } of used) {
      assert.ok(guid > 0 && guid < 0x7fffffff, `${name} guid ${guid} is plausible`);
      assert.ok(
        slot.baseNote >= 0 && slot.baseNote <= 127,
        `${name} baseNote ${slot.baseNote} is a MIDI note`,
      );
      if (slot.pitched) pitchedSlots += 1;
      else unpitchedSlots += 1;
      if (slot.fitBpm) fitBpm += 1;
    }
  }

  console.log(
    `    ${files.length} instruments, ${multisamples} multisampled, ` +
      `${pitchedSlots} pitched / ${unpitchedSlots} unpitched slots, ` +
      `${fitBpm} with fitBpm`,
  );
  console.log(`    revisions: ${[...revisions].sort().join(', ')}`);
  assert.ok(files.length >= 60, 'expected the full instrument set');
});
