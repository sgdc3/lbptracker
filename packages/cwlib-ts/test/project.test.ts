import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  STEPS_PER_CELL,
  boardToGrid,
  importLevel,
  readLevelProject,
  schedule,
  trackFrom,
  type LevelProject,
} from '../src/project.ts';
import { DEFAULT_CHIP_COLOUR } from '../src/chips.ts';
import type { InstrumentPart, SequencerPart } from '../src/parts.ts';
import type { Thing } from '../src/thing.ts';
import { nodeInflate } from '../src/platform/node.ts';

/**
 * Real levels are other people's work and are never committed. Point
 * `LBP_LEVELS` at a directory of them; the corpus tests skip without it.
 */
const LEVELS =
  process.env.LBP_LEVELS ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';

// ------------------------------------------------------------------ fixtures

const CELL = 52.5;

function instrument(over: Partial<InstrumentPart> = {}): InstrumentPart {
  return {
    guid: 129085,
    name: '',
    colour: DEFAULT_CHIP_COLOUR,
    loops: 1,
    key: 0,
    scale: 0,
    level: 1,
    pan: 0.5,
    echoSend: 0,
    reverbSend: 0,
    notes: new Uint8Array(),
    icon: 0,
    ...over,
  };
}

function thing(uid: number, parts: [string, unknown][]): Thing {
  return { uid, planGuid: 0, flags: 0, extraFlags: 0, parts: new Map(parts) };
}

const settings = (over: Partial<SequencerPart> = {}): SequencerPart => ({
  tempo: 120,
  swing: 0,
  echoFeedback: 0,
  echoTime: 0,
  echoMix: 0,
  reverbSettings: 0,
  loop: false,
  startPoint: 0,
  numChannels: 6,
  volumes: [1, 1, 1, 1, 1, 1],
  musicSequencer: true,
  ...over,
});

/**
 * A world holding one music sequencer with its board closed.
 *
 * A closed board is the common case — 1,306 of the corpus's 1,367 microchips —
 * and it is the one that can be written by hand: the components are a compact
 * list on the chip rather than Things scattered through the world.
 */
function world(
  uid: number,
  name: string,
  placements: { x: number; y: number; instrument: InstrumentPart }[],
  over: Partial<SequencerPart> = {},
): Thing[] {
  const components = placements.map((p, i) => ({
    thing: thing(uid * 1000 + i, [['INSTRUMENT', p.instrument]]),
    x: p.x,
    y: p.y,
  }));
  return [
    thing(uid, [
      ['SEQUENCER', settings(over)],
      ['MICROCHIP', { name, components, board: undefined }],
    ]),
    ...components.map((c) => c.thing),
  ];
}

/** Note records, four bytes each: `x | triplet<<7`, `y | end<<7`, volume, timbre. */
const records = (...bytes: number[]) => new Uint8Array(bytes);

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
  const t = trackFrom({ x: 78.75, y: -105, instrument: instrument() });
  assert.equal(t.gridX, 1);
  assert.equal(t.gridY, 1);
  assert.equal(t.stepOffset, STEPS_PER_CELL);
});

// --------------------------------------------------------------- the grouping

test('a level’s sequencers come back with their components as tracks', () => {
  const things = [
    ...world(7, 'seven', [
      { x: 0, y: -CELL, instrument: instrument({ name: 'a' }) },
      { x: CELL, y: -CELL, instrument: instrument({ name: 'b' }) },
    ]),
    ...world(9, 'nine', [{ x: 0, y: -CELL, instrument: instrument({ name: 'x' }) }]),
  ];
  const level = importLevel('test', things);
  assert.equal(level.sequencers.length, 2);
  const seven = level.sequencers.find((s) => s.uid === 7)!;
  assert.equal(seven.name, 'seven');
  assert.deepEqual(
    seven.tracks.map((t) => t.name),
    ['a', 'b'],
  );
});

/**
 * ⚠️ An animation or logic sequencer carries a `PSequencer` too, and it has no
 * music in it. `musicSequencer` is the flag that separates them; without it a
 * level's logic shows up as silent tracks.
 */
test('only music sequencers are imported', () => {
  const things = [
    ...world(7, 'music', [{ x: 0, y: -CELL, instrument: instrument() }]),
    ...world(8, 'logic', [{ x: 0, y: -CELL, instrument: instrument() }], {
      musicSequencer: false,
    }),
  ];
  assert.deepEqual(
    importLevel('test', things).sequencers.map((s) => s.uid),
    [7],
  );
});

test('a note lands at its cell offset plus its own step', () => {
  // One record: step 3, pitch 60, with the end flag.
  const things = world(1, 'seq', [
    { x: 78.75, y: -CELL, instrument: instrument({ notes: records(3, 60 | 0x80, 0x60, 0x40) }) },
  ]);
  const level = importLevel('test', things);
  const events = schedule(level.sequencers[0]);
  assert.equal(events.length, 1);
  assert.equal(events[0].step, STEPS_PER_CELL + 3);
  assert.equal(events[0].pitch, 60);
  assert.equal(events[0].durationSteps, 1);
});

// ------------------------------------------------------------- the real corpus

/** Every level under `LEVELS`, imported. */
async function corpus(): Promise<LevelProject[] | null> {
  if (!existsSync(LEVELS)) return null;
  const out: LevelProject[] = [];
  for (const entry of await readdir(LEVELS, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    out.push(
      await readLevelProject(
        entry.name,
        new Uint8Array(await readFile(path.join(LEVELS, entry.name))),
        nodeInflate,
      ),
    );
  }
  return out;
}

test('every sequencer in the corpus imports, and the notes survive it', async (t) => {
  const levels = await corpus();
  if (!levels) {
    t.skip(`no ${LEVELS} — set LBP_LEVELS to a directory of levels`);
    return;
  }

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

  console.log(
    `    ${levels.length} files, ${sequencers} sequencers, ${tracks} tracks, ` +
      `${notes} notes, longest ${longest} steps, ${emptyGuid} tracks with no instrument`,
  );

  // ⚠️ `tools/PartCensus.java` counted 62,158 `INSTRUMENT` parts across these
  // ten files, and the walk finds exactly that many placements. It is the one
  // number here produced by an implementation nobody in this project wrote, so
  // pin it: a walk that visited a Thing twice, or missed a board, would move it.
  assert.equal(levels.length, 10, 'the corpus is ten level files');
  assert.equal(tracks, 62158, 'every INSTRUMENT part in the corpus becomes a track');
  assert.ok(sequencers > 100, `expected many sequencers, got ${sequencers}`);
  assert.ok(notes > 10_000, `expected many notes, got ${notes}`);

  // ⚠️ Records after the last end flag mean the record format or the grouping
  // is wrong. The corpus should be clean; if this ever trips, do not raise the
  // bound -- go and find out which.
  assert.equal(trailing, 0, `${trailing} records fell outside a note`);
});

test('the corpus’s tempos and grid cells are in sane ranges', async (t) => {
  const levels = await corpus();
  if (!levels) {
    t.skip(`no ${LEVELS}`);
    return;
  }

  let minTempo = Infinity;
  let maxTempo = -Infinity;
  let minCell = Infinity;
  let maxCell = -Infinity;
  const rows = new Set<number>();
  for (const level of levels) {
    for (const seq of level.sequencers) {
      if (seq.tracks.length === 0) continue;
      minTempo = Math.min(minTempo, seq.tempo);
      maxTempo = Math.max(maxTempo, seq.tempo);
      for (const track of seq.tracks) {
        minCell = Math.min(minCell, track.gridX);
        maxCell = Math.max(maxCell, track.gridX);
        rows.add(track.gridY);
      }
    }
  }
  console.log(
    `    tempo ${minTempo}..${maxTempo}, gridX ${minCell}..${maxCell}, ` +
      `${rows.size} distinct rows: ${[...rows].sort((a, b) => a - b).join(',')}`,
  );
  // ⚠️ A negative cell would mean the half-cell bias or the sign is wrong -- and
  // for a board recovered from world matrices, that the frame change in
  // `boardCell` is wrong. One of the corpus's open boards is rotated 90°, which
  // without it swaps the time axis with the row axis. See packages/cwlib-ts/dev/board-probe.ts.
  assert.ok(minCell >= 0, `gridX went negative: ${minCell}`);
  assert.ok(minTempo > 0, 'tempos are positive');
});

test('the corpus resolves to real instrument GUIDs', async (t) => {
  const levels = await corpus();
  if (!levels) {
    t.skip(`no ${LEVELS}`);
    return;
  }
  let resolved = 0;
  let unresolved = 0;
  const guids = new Set<number>();
  for (const level of levels) {
    for (const seq of level.sequencers) {
      for (const track of seq.tracks) {
        if (track.guid > 0) {
          resolved += 1;
          guids.add(track.guid);
        } else unresolved += 1;
      }
    }
  }
  console.log(
    `    ${resolved} tracks resolve to ${guids.size} distinct instrument GUIDs, ` +
      `${unresolved} do not`,
  );
  // ⚠️ A placement with no instrument is a real case -- an empty cell, or a
  // level shipping its own `RInstrument` as an embedded resource, which has a
  // SHA1 and no GUID. What is not real is *all* of them: that is what a broken
  // resource descriptor looks like, and it happened once, silently.
  assert.ok(resolved > (resolved + unresolved) * 0.9, `only ${resolved} resolved`);
});

// ------------------------------------------------------------------ triplets

test('a triplet lands on its third of a step, not on the beat', () => {
  // Three records at step 4, sub-steps 0, 1 and 2, each its own one-record
  // note. Byte 3 carries bit 30, which is what turns sub-step 1 into 2.
  const notes = records(0x04, 0x80, 0x60, 0x00, 0x84, 0x80, 0x60, 0x00, 0x84, 0x80, 0x60, 0x40);
  const things = world(1, 'seq', [{ x: 26.25, y: -CELL, instrument: instrument({ notes }) }]);
  const events = schedule(importLevel('test', things).sequencers[0]);
  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map((e) => e.step),
    [4, 4 + 1 / 3, 4 + 2 / 3],
  );
});

test('the corpus’s sub-steps are the two balanced thirds, not a flag', async (t) => {
  if (!existsSync(LEVELS)) {
    t.skip(`no ${LEVELS}`);
    return;
  }
  // ⚠️ The *records*, not the grouped notes: `subStep` is a field of the
  // four-byte record and grouping consumes it into a fractional start. Reading
  // it back off a `Note` would be measuring this module rather than the corpus.
  const { decodeRecords } = await import('../src/notes.ts');
  const { readLevel, musicSequencers } = await import('../src/level.ts');
  const { partReaders } = await import('../src/parts.ts');
  const counts = [0, 0, 0];
  let total = 0;
  for (const entry of await readdir(LEVELS, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const { things } = await readLevel(
      new Uint8Array(await readFile(path.join(LEVELS, entry.name))),
      nodeInflate,
      partReaders(),
    );
    for (const seq of musicSequencers(things)) {
      for (const placement of seq.placements) {
        for (const record of decodeRecords(placement.instrument.notes)) {
          counts[record.subStep] += 1;
          total += 1;
        }
      }
    }
  }
  console.log(`    sub-steps: 0 ${counts[0]}, 1 ${counts[1]}, 2 ${counts[2]} of ${total} records`);
  // ⚠️ Nothing may decode to a fourth value: `bit7 << bit30` cannot produce one,
  // so a non-zero count here would mean the field boundaries moved.
  // The ten-file corpus has ~4,600 and ~4,200 of them; the 19-file dump this
  // used to read had over 10,000 of each, hence the lower bound.
  assert.ok(counts[1] > 1_000 && counts[2] > 1_000, 'both thirds are used');
  // A triplet group puts one note on each third, so the two are comparable.
  // Wildly unbalanced counts would mean bit 30 is being read from the wrong byte.
  const ratio = counts[1] / counts[2];
  assert.ok(ratio > 0.5 && ratio < 2, `thirds are lopsided: ${ratio.toFixed(2)}`);
});

// ------------------------------------------------------------ mixer channels

// ⚠️ **This test asserted `row modulo EIGHT` until 2026-09-03**, which is what
// the plugin does and not what the song means: the eight records are the
// plugin's, and `mod 8` there is a bounds guard on a value the eboot has already
// reduced. A listener playing the game pointed out that a sequencer set to one
// channel puts everything through that channel's fader -- which `% 8` does not
// do, and which 308 of the corpus's 338 sequencers depend on.
//
// The cases below that separate the two readings are the ones with a row at or
// past `NumChannels` but under eight: `at(6)` was 0.75 under the old law and is
// `volumes[2]` under this one.
test('a track’s channel is its board row modulo NumChannels', async () => {
  const { channelVolume, CHANNEL_HEADROOM } = await import('../src/project.ts');
  const seq = {
    numChannels: 4,
    volumes: [1, 0.7, 0.5, 0.2, 1, 1],
  } as never as Parameters<typeof channelVolume>[0];
  const at = (gridY: number) =>
    channelVolume(seq, { gridY } as never as Parameters<typeof channelVolume>[1]);

  assert.equal(at(0), CHANNEL_HEADROOM * 1);
  assert.equal(at(1), CHANNEL_HEADROOM * 0.7);
  assert.equal(at(3), CHANNEL_HEADROOM * 0.2);
  // Wrapping at NumChannels, so every row lands on a channel the song has.
  assert.equal(at(4), at(0));
  assert.equal(at(6), at(2));
  assert.equal(at(7), at(3));
  assert.equal(at(24), at(0));
  assert.equal(at(6), CHANNEL_HEADROOM * 0.5, 'row 6 is channel 2, not an unused record');

  // One channel means one fader for the whole board, which is the case that
  // matters: it is what 308 of 338 sequencers are.
  const flat = { numChannels: 1, volumes: [0.5, 1, 1, 1, 1, 1] } as never as typeof seq;
  const flatAt = (gridY: number) =>
    channelVolume(flat, { gridY } as never as Parameters<typeof channelVolume>[1]);
  assert.equal(flatAt(0), CHANNEL_HEADROOM * 0.5);
  assert.equal(flatAt(3), CHANNEL_HEADROOM * 0.5, 'every row goes through channel 0');
  assert.equal(flatAt(17), CHANNEL_HEADROOM * 0.5);

  // ⚠️ Even an all-ones sequencer is not unity: the headroom is always there.
  const ones = { numChannels: 1, volumes: [1, 1, 1, 1, 1, 1] } as never as typeof seq;
  assert.equal(
    channelVolume(ones, { gridY: 3 } as never as Parameters<typeof channelVolume>[1]),
    0.75,
  );

  // A file claiming no channels still plays, through the one it must have.
  const none = { numChannels: 0, volumes: [0.25] } as never as typeof seq;
  assert.equal(
    channelVolume(none, { gridY: 9 } as never as Parameters<typeof channelVolume>[1]),
    CHANNEL_HEADROOM * 0.25,
  );
});
