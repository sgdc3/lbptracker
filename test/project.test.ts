import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  STEPS_PER_CELL,
  boardToGrid,
  duplicateRowsDropped,
  importLevel,
  schedule,
  trackFrom,
  type DumpRow,
} from '../src/core/project.ts';

/**
 * The corpus dump is other people's levels and is never committed. Regenerate
 * with tools/RawDump.java; see src/core/project.ts for why the extraction is
 * still Java.
 */
const DUMP = process.env.LBP_DUMP ?? 'fixtures/levels/sequencers.jsonl';

const row = (over: Partial<DumpRow> = {}): DumpRow => ({
  file: 'test',
  seqUID: 1,
  seqName: 'seq',
  tempo: 120,
  swing: 0,
  echoFeedback: 0,
  echoTime: 0,
  echoMix: 0,
  reverb: 0,
  loop: false,
  startPoint: 0,
  numChannels: 6,
  volumes: [1, 1, 1, 1, 1, 1],
  instIdx: 0,
  boardX: 0,
  boardY: 0,
  instRes: '0',
  instName: '',
  level: 1,
  pan: 0.5,
  echoSend: 0,
  reverbSend: 0,
  loops: 1,
  key: 0,
  scale: 0,
  noteCount: 0,
  notes: '',
  ...over,
});

// ------------------------------------------------------------- board geometry

test('board position maps to a grid cell, with the engine’s half-cell bias', () => {
  // gridX = floor(2x/105 - 0.5): a component at the first cell's centre, x =
  // 26.25, gives 2*26.25/105 - 0.5 = 0.0 -> cell 0.
  assert.deepEqual(boardToGrid(26.25, 0), { gridX: 0, gridY: 0 });
  assert.deepEqual(boardToGrid(78.75, 0), { gridX: 1, gridY: 0 });
  assert.deepEqual(boardToGrid(131.25, 0), { gridX: 2, gridY: 0 });
  // ⚠️ Without the -0.5 bias -- which is what the toolkit does -- x = 26.25
  // would land in cell 0 too, but x = 52.5 would move to cell 1 instead of
  // staying in 0. That is the divergence, and it is a whole cell.
  assert.deepEqual(boardToGrid(52.5, 0), { gridX: 0, gridY: 0 });
  assert.equal(Math.floor(52.5 / 52.5), 1, 'the toolkit would say 1 here');
  // Y is flipped: the board grows upward, rows number downward.
  assert.deepEqual(boardToGrid(26.25, -105), { gridX: 0, gridY: 1 });
  assert.deepEqual(boardToGrid(26.25, -210), { gridX: 0, gridY: 2 });
  assert.deepEqual(boardToGrid(26.25, 105), { gridX: 0, gridY: -1 });
});

test('a track’s step offset is its cell times the cell length', () => {
  const t = trackFrom(row({ boardX: 78.75, boardY: -105 }));
  assert.equal(t.gridX, 1);
  assert.equal(t.gridY, 1);
  assert.equal(t.stepOffset, STEPS_PER_CELL);
});

// --------------------------------------------------------------- the grouping

test('rows are grouped by sequencer and ordered by board index', () => {
  const rows = [
    row({ seqUID: 7, instIdx: 2, instName: 'c' }),
    row({ seqUID: 7, instIdx: 0, instName: 'a' }),
    row({ seqUID: 9, instIdx: 0, instName: 'x' }),
    row({ seqUID: 7, instIdx: 1, instName: 'b' }),
  ];
  const [level] = importLevel(rows);
  assert.equal(level.sequencers.length, 2);
  const seven = level.sequencers.find((s) => s.uid === 7)!;
  assert.deepEqual(seven.tracks.map((t) => t.name), ['a', 'b', 'c']);
});

test('a note lands at its cell offset plus its own step', () => {
  // One note: a single record at step 3, pitch 60, with the end flag.
  const notes = ((3 & 0x7f) | 0).toString(16).padStart(2, '0')
    + ((60 & 0x7f) | 0x80).toString(16).padStart(2, '0')
    + '60' + '40';
  const [level] = importLevel([row({ boardX: 78.75, notes, noteCount: 1 })]);
  const events = schedule(level.sequencers[0]);
  assert.equal(events.length, 1);
  assert.equal(events[0].step, STEPS_PER_CELL + 3);
  assert.equal(events[0].pitch, 60);
  assert.equal(events[0].durationSteps, 1);
});

// ------------------------------------------------------------- the real corpus

test('every sequencer in the corpus imports, and the notes survive it', async (t) => {
  if (!existsSync(DUMP)) {
    t.skip(`no ${DUMP} (regenerate with tools/RawDump.java, or set LBP_DUMP)`);
    return;
  }
  // The dump carries creator-authored names, which are not always valid UTF-8.
  const text = await readFile(DUMP, 'latin1');
  const rows: DumpRow[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('{')) rows.push(JSON.parse(line));
  }
  assert.ok(rows.length > 1000, `expected a real corpus, got ${rows.length} rows`);

  const levels = importLevel(rows);
  let sequencers = 0;
  let tracks = 0;
  let notes = 0;
  let trailing = 0;
  let emptyGuid = 0;
  let longest = 0;
  for (const level of levels) {
    for (const seq of level.sequencers) {
      sequencers += 1;
      longest = Math.max(longest, seq.lengthSteps);
      for (const track of seq.tracks) {
        tracks += 1;
        notes += track.notes.length;
        trailing += track.trailingRecords;
        if (track.guid === 0) emptyGuid += 1;
      }
    }
  }

  // Nothing may be lost except the rows `RawDump` emitted twice.
  //
  // ⚠️ It re-emits a whole sequencer when its Thing is reachable twice in
  // `world.things`, and 60 of the corpus's 338 sequencers come out that way --
  // `instIdx` 0..N followed by 0..N again, byte for byte. `importLevel` drops
  // the repeat; this pins the count so a change in either direction is visible.
  assert.equal(
    tracks + duplicateRowsDropped,
    rows.length,
    'every dump row becomes a track or is a counted duplicate',
  );
  assert.equal(duplicateRowsDropped, 23911, 'the corpus carries 23,911 duplicate rows');
  assert.ok(sequencers > 100, `expected many sequencers, got ${sequencers}`);
  assert.ok(notes > 10_000, `expected many notes, got ${notes}`);

  // ⚠️ Records after the last end flag mean the record format or the grouping
  // is wrong. The corpus should be clean; if this ever trips, do not raise the
  // bound -- go and find out which.
  assert.equal(trailing, 0, `${trailing} records fell outside a note`);

  console.log(
    `    ${levels.length} files, ${sequencers} sequencers, ${tracks} tracks, ` +
      `${notes} notes, longest ${longest} steps, ${emptyGuid} tracks with no instrument`,
  );
});

test('the corpus’s tempos and grid cells are in sane ranges', async (t) => {
  if (!existsSync(DUMP)) {
    t.skip(`no ${DUMP}`);
    return;
  }
  const text = await readFile(DUMP, 'latin1');
  const rows: DumpRow[] = [];
  for (const line of text.split('\n')) if (line.startsWith('{')) rows.push(JSON.parse(line));
  const levels = importLevel(rows);

  let minTempo = Infinity;
  let maxTempo = -Infinity;
  let minCell = Infinity;
  let maxCell = -Infinity;
  const rows2 = new Set<number>();
  for (const level of levels) {
    for (const seq of level.sequencers) {
      minTempo = Math.min(minTempo, seq.tempo);
      maxTempo = Math.max(maxTempo, seq.tempo);
      for (const track of seq.tracks) {
        minCell = Math.min(minCell, track.gridX);
        maxCell = Math.max(maxCell, track.gridX);
        rows2.add(track.gridY);
      }
    }
  }
  console.log(
    `    tempo ${minTempo}..${maxTempo}, gridX ${minCell}..${maxCell}, ` +
      `${rows2.size} distinct rows: ${[...rows2].sort((a, b) => a - b).join(',')}`,
  );
  // A negative cell would mean the half-cell bias or the sign is wrong.
  assert.ok(minCell >= 0, `gridX went negative: ${minCell}`);
  assert.ok(minTempo > 0, 'tempos are positive');
});

// ------------------------------------------------------- resource descriptors

test('an instrument reference is a descriptor, not a number', async () => {
  const { parseResourceGuid } = await import('../src/core/project.ts');
  // ⚠️ This is the whole bug that made a first import play nothing: every real
  // value is `g` + digits, `Number('g129085')` is NaN, and NaN became 0, so
  // every instrument looked missing and 1,642 notes were silently skipped.
  assert.equal(parseResourceGuid('g129085'), 129085);
  assert.equal(parseResourceGuid(' g122737 '), 122737);
  assert.equal(parseResourceGuid(''), 0);
  // A bare SHA1 means the level carries its own instrument -- a real case, and
  // not resolvable against the game's FileDB, so 0 rather than a guess.
  assert.equal(parseResourceGuid('5aa779456cf3407f2ed16251f461eb2dd5970f3f'), 0);
  assert.equal(parseResourceGuid('129085'), 0, 'a bare number is not a descriptor');
});

test('the corpus resolves to real instrument GUIDs', async (t) => {
  if (!existsSync(DUMP)) {
    t.skip(`no ${DUMP}`);
    return;
  }
  const text = await readFile(DUMP, 'latin1');
  const rows: DumpRow[] = [];
  for (const line of text.split('\n')) if (line.startsWith('{')) rows.push(JSON.parse(line));
  const levels = importLevel(rows);
  let resolved = 0;
  let unresolved = 0;
  const guids = new Set<number>();
  for (const level of levels) {
    for (const seq of level.sequencers) {
      for (const track of seq.tracks) {
        if (track.guid > 0) { resolved += 1; guids.add(track.guid); } else unresolved += 1;
      }
    }
  }
  console.log(`    ${resolved} tracks resolve to ${guids.size} distinct instrument GUIDs, ${unresolved} do not`);
  // If this ever drops to zero again, the descriptor format has changed.
  const kept = rows.length - duplicateRowsDropped;
  assert.ok(resolved > kept * 0.9, `only ${resolved} of ${kept} resolved`);
});

// ------------------------------------------------------------------ triplets

test('a triplet lands on its third of a step, not on the beat', () => {
  // Three records at step 4, sub-steps 0, 1 and 2, each its own one-record
  // note. Byte 3 carries bit 30, which is what turns sub-step 1 into 2.
  const rec = (b0: number, b3: number) =>
    b0.toString(16).padStart(2, '0') + '80' + '60' + b3.toString(16).padStart(2, '0');
  const notes = rec(0x04, 0x00) + rec(0x84, 0x00) + rec(0x84, 0x40);
  const [level] = importLevel([row({ notes, noteCount: 3, boardX: 26.25 })]);
  const events = schedule(level.sequencers[0]);
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.step),
    [4, 4 + 1 / 3, 4 + 2 / 3],
  );
});

test('the corpus’s sub-steps are the two balanced thirds, not a flag', async (t) => {
  if (!existsSync(DUMP)) {
    t.skip(`no ${DUMP}`);
    return;
  }
  const { decodeRecords } = await import('../src/core/notes.ts');
  const text = await readFile(DUMP, 'latin1');
  const counts = [0, 0, 0];
  let records = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    const r = JSON.parse(line) as DumpRow;
    if (!r.notes) continue;
    const bytes = new Uint8Array(r.notes.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(r.notes.slice(i * 2, i * 2 + 2), 16);
    }
    for (const rec of decodeRecords(bytes)) {
      counts[rec.subStep] += 1;
      records += 1;
    }
  }
  console.log(
    `    sub-steps: 0 ${counts[0]}, 1 ${counts[1]}, 2 ${counts[2]} of ${records} records`,
  );
  // ⚠️ Nothing may decode to a fourth value: `bit7 << bit30` cannot produce one,
  // so a non-zero count here would mean the field boundaries moved.
  assert.ok(counts[1] > 10_000 && counts[2] > 10_000, 'both thirds are used');
  // A triplet group puts one note on each third, so the two are comparable.
  // Wildly unbalanced counts would mean bit 30 is being read from the wrong byte.
  const ratio = counts[1] / counts[2];
  assert.ok(ratio > 0.5 && ratio < 2, `thirds are lopsided: ${ratio.toFixed(2)}`);
});

// ------------------------------------------------------------ mixer channels

test('a track’s channel is its board row modulo eight', async () => {
  const { channelVolume, CHANNEL_HEADROOM } = await import('../src/core/project.ts');
  const seq = {
    numChannels: 4,
    volumes: [1, 0.7, 0.5, 0.2, 1, 1],
  } as never as Parameters<typeof channelVolume>[0];
  const at = (gridY: number) =>
    channelVolume(seq, { gridY } as never as Parameters<typeof channelVolume>[1]);

  assert.equal(at(0), CHANNEL_HEADROOM * 1);
  assert.equal(at(1), CHANNEL_HEADROOM * 0.7);
  assert.equal(at(3), CHANNEL_HEADROOM * 0.2);
  // The engine takes the row modulo eight (0x3afc-0x3b0b), which is what makes a
  // 24-row board safe against a NumChannels of at most 6.
  assert.equal(at(8), at(0));
  assert.equal(at(9), at(1));
  assert.equal(at(24), at(0));
  // Records past Volume[5] keep the engine's initialised 0.75, i.e. volume 1.
  assert.equal(at(6), CHANNEL_HEADROOM);
  assert.equal(at(7), CHANNEL_HEADROOM);
  // ⚠️ Even an all-ones sequencer is not unity: the headroom is always there.
  const flat = { numChannels: 1, volumes: [1, 1, 1, 1, 1, 1] } as never as typeof seq;
  assert.equal(channelVolume(flat, { gridY: 3 } as never as Parameters<typeof channelVolume>[1]), 0.75);
});
