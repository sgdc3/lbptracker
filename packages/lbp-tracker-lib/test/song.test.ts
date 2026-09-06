/**
 * The editor's model and its boundary with the file's records.
 *
 * `encodeNotes` is tested here rather than in `cwlib` for the reason
 * `notes.test.ts` gives: the corpus check below needs the level reader, and
 * the model that drives the encoder lives in this package.
 */

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { decodeRecords, encodeNotes, readNotes, type WriteNote } from '@lbptracker/cwlib/notes.ts';
import { readLevelProject, type Track } from '@lbptracker/cwlib/project.ts';
import { nodeInflate } from '@lbptracker/cwlib/platform/node.ts';

import {
  addClip,
  addNote,
  addPoint,
  clipStepsFor,
  movePoint,
  moveNote,
  newSong,
  removePoint,
  resizeClip,
  sequencerFromSong,
  songFromJson,
  songFromSequencer,
  songToJson,
  trackFromClip,
} from '../src/song.ts';

const LEVELS =
  process.env.LBP_LEVELS ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';

const point = (
  step: number,
  pitch: number,
  over: Partial<WriteNote['points'][number]> = {},
): WriteNote['points'][number] => ({ step, subStep: 0, pitch, volume: 96, timbre: 0, ...over });

// ------------------------------------------------------------ encodeNotes

test('encodeNotes writes the measured order: position, then pitch descending, then the end', () => {
  const bytes = encodeNotes([
    { points: [point(4, 60), point(7, 60)] }, // longer, same pitch as the next
    { points: [point(4, 60), point(5, 60)] }, // shorter -> first of the two
    { points: [point(4, 72)] }, // higher -> first at step 4
    { points: [point(0, 48)] }, // earliest
  ]);
  const notes = readNotes(bytes).notes;
  assert.deepEqual(
    notes.map((n) => [n.startStep, n.points[0].pitch, n.endStep]),
    [
      [0, 48, 0],
      [4, 72, 4],
      [4, 60, 5],
      [4, 60, 7],
    ],
  );
  assert.equal(readNotes(bytes).trailing.length, 0);
});

test('encodeNotes packs the sub-step and the resting bit the way the engine reads them', () => {
  const bytes = encodeNotes(
    [{ points: [point(2, 60, { subStep: 0 }), point(2, 60, { subStep: 1 }), point(3, 62, { subStep: 2, timbre: 15 })] }],
    1,
  );
  const records = decodeRecords(bytes);
  assert.deepEqual(records.map((r) => [r.step, r.subStep, r.end]), [[2, 0, false], [2, 1, false], [3, 2, true]]);
  // Bit 6 of byte 3: set at rest (rest = 1), clear at sub-step 1, set at sub-step 2.
  assert.equal(bytes[3] & 0x40, 0x40, 'the resting bit is written on an inert record');
  assert.equal(bytes[7] & 0x40, 0, 'sub-step 1 needs the bit clear');
  assert.equal(bytes[11] & 0x40, 0x40, 'sub-step 2 needs it set');
  assert.equal(bytes[11] & 0x0f, 15, 'the nibble is the timbre');
  assert.equal(records[2].modulation, 1);

  const cleared = encodeNotes([{ points: [point(0, 60)] }], 0);
  assert.equal(cleared[3] & 0x40, 0, 'rest = 0 leaves an inert record clear');
});

test('encodeNotes clamps to the record grid rather than wrapping', () => {
  const bytes = encodeNotes([{ points: [point(0, 200, { volume: 300, timbre: 99 })] }]);
  const [r] = decodeRecords(bytes);
  assert.equal(r.pitch, 127);
  assert.equal(r.volume, 127);
  assert.equal(r.timbre & 0x0f, 15);
});

// ------------------------------------------------------------------ the model

test('a song round-trips through a sequencer and through JSON', () => {
  const song = newSong('test');
  song.tempo = 150;
  song.swing = 0.25;
  song.numChannels = 2;
  song.boardRows = 6;
  const clip = addClip(song, { cell: 3, row: 2 }, 129085, 'lead');
  clip.key = 14;
  clip.scale = 3;
  clip.level = 0.7;
  clip.pan = 0.25;
  clip.echoSend = 0.5;
  clip.reverbSend = 0.3;
  const held = addNote(song, clip, { thirds: 3, pitch: 60, volume: 100, timbre: 4 });
  addPoint(clip, held, 12); // a held note: two points
  const bend = addNote(song, clip, { thirds: 0, pitch: 72 });
  addPoint(clip, bend, 4);
  movePoint(clip, bend, bend.points[1], { pitch: 79 });
  const triplet = addNote(song, clip, { thirds: 16, pitch: 64 }); // step 5 + 1/3

  const seq = sequencerFromSong(song, 7);
  assert.equal(seq.uid, 7);
  assert.equal(seq.tempo, 150);
  assert.equal(seq.tracks.length, 1);
  const track = seq.tracks[0];
  assert.equal(track.stepOffset, 48);
  assert.equal(track.gridY, 2);
  assert.equal(track.key, 14);
  assert.equal(track.notes.length, 3);
  // The bend at step 0 comes first, then the held note at step 1, then the triplet.
  assert.deepEqual(
    track.notes.map((n) => [n.startPosition, n.endStep, n.points[0].pitch, n.hasPitchAutomation]),
    [
      [0, 1, 72, true],
      [1, 4, 60, false],
      [5 + 1 / 3, 5, 64, false],
    ],
  );
  assert.equal(seq.lengthSteps, 48 + 5 + 1);
  assert.equal(track.notes[1].points[0].modulation, 4 / 15);

  const back = songFromSequencer(seq);
  assert.equal(back.tempo, 150);
  assert.equal(back.swing, 0.25);
  assert.equal(back.clips.length, 1);
  const again = back.clips[0];
  assert.equal(again.cell, 3);
  assert.equal(again.row, 2);
  assert.equal(again.steps, 64);
  assert.equal(again.rest, 1);
  assert.equal(again.notes.length, 3);
  const flat = (c: typeof clip) =>
    c.notes
      .map((n) => n.points.map((p) => [p.thirds, p.pitch, p.volume, p.timbre]))
      .sort((a, b) => a[0][0] - b[0][0] || b[0][1] - a[0][1]);
  assert.deepEqual(flat(again), flat(clip));

  const text = songToJson(back);
  const parsed = songFromJson(text);
  assert.deepEqual(flat(parsed.clips[0]), flat(clip));
  assert.equal(parsed.clips[0].key, 14);
  assert.equal(parsed.boardRows, 6);
  assert.throws(() => songFromJson('{"format":"something else"}'), /not an LBP Tracker song/);

  void triplet;
});

test('points stay in order and inside the clip; a note goes with its last point', () => {
  const song = newSong();
  const clip = addClip(song, { cell: 0, row: 0 }, 129085);
  const note = addNote(song, clip, { thirds: 30, pitch: 60 });
  addPoint(clip, note, 60);
  const mid = addPoint(clip, note, 45);
  assert.deepEqual(note.points.map((p) => p.thirds), [30, 45, 60]);
  movePoint(clip, note, mid, { thirds: 200 });
  assert.equal(mid.thirds, 60, 'a point cannot pass its neighbour');
  movePoint(clip, note, mid, { thirds: -5 });
  assert.equal(mid.thirds, 30);
  movePoint(clip, note, note.points[2], { thirds: 1000, pitch: 500 });
  assert.equal(note.points[2].thirds, 64 * 3 - 1, 'the last position is the clip\'s last third');
  assert.equal(note.points[2].pitch, 127);
  moveNote(clip, note, -100, -100);
  assert.equal(note.points[0].thirds, 0);
  assert.equal(Math.min(...note.points.map((p) => p.pitch)), 0);
  assert.equal(note.points[2].thirds - note.points[0].thirds, 191 - 30, 'a shifted note keeps its shape');

  assert.equal(resizeClip(clip, 96), true);
  assert.equal(clip.steps, 96);
  moveNote(clip, note, 1000, 0);
  assert.equal(note.points[2].thirds, 96 * 3 - 1);
  assert.equal(resizeClip(clip, 64), false, 'a clip cannot shrink under its notes');
  assert.equal(clip.steps, 96);
  assert.equal(resizeClip(clip, 1000), true);
  assert.equal(clip.steps, 128, 'the ceiling is 8 bars');
  assert.equal(resizeClip(clip, 100), true);
  assert.equal(clip.steps, 96, 'lengths snap to 4, 6 or 8 bars');

  removePoint(clip, note, note.points[1]);
  removePoint(clip, note, note.points[0]);
  assert.equal(clip.notes.length, 1);
  removePoint(clip, note, note.points[0]);
  assert.equal(clip.notes.length, 0, 'the note went with its last point');
});

test('clipStepsFor: 4 bars by default, then 6 and 8, never past 128', () => {
  assert.equal(clipStepsFor(-1), 64);
  assert.equal(clipStepsFor(0), 64);
  assert.equal(clipStepsFor(31), 64);
  assert.equal(clipStepsFor(63), 64);
  assert.equal(clipStepsFor(64), 96);
  assert.equal(clipStepsFor(95), 96);
  assert.equal(clipStepsFor(96), 128);
  assert.equal(clipStepsFor(127), 128);
  assert.equal(clipStepsFor(500), 128);
});

// ---------------------------------------------------------------- the corpus

/**
 * Opening a level's tracks and writing them back reproduces the file's own
 * bytes on nearly every clip -- the order keys are measured at 99.43% on the
 * first and 100% on the ties, and the resting bit is uniform on all but 31 of
 * 62,106 clips. Anything under 98% means the encoder has drifted from the
 * measurement.
 */
test('the corpus survives songFromSequencer -> trackFromClip byte for byte, nearly everywhere', async (t) => {
  if (!existsSync(LEVELS)) {
    t.skip(`no ${LEVELS} — set LBP_LEVELS to a directory of levels`);
    return;
  }
  let clips = 0;
  let same = 0;
  let sameNotes = 0;
  const differing: string[] = [];
  for (const entry of await readdir(LEVELS, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const level = await readLevelProject(
      entry.name,
      new Uint8Array(await readFile(path.join(LEVELS, entry.name))),
      nodeInflate,
    );
    for (const seq of level.sequencers) {
      const song = songFromSequencer(seq);
      assert.equal(song.clips.length, seq.tracks.length);
      seq.tracks.forEach((track: Track, i) => {
        const back = trackFromClip(song.clips[i]);
        clips += 1;
        if (Buffer.compare(Buffer.from(back.records), Buffer.from(track.records)) === 0) same += 1;
        else if (differing.length < 5) differing.push(`${entry.name}#${seq.uid} cell ${track.gridX}`);
        // Whatever the bytes did, the music must be the same: same notes at the
        // same places with the same values.
        const flat = (tr: Track) =>
          tr.notes
            .map((n) => n.points.map((p) => [p.step, p.subStep, p.pitch, p.volume, p.timbre & 0x0f].join(':')).join(' '))
            .sort()
            .join('|');
        if (flat(back) === flat(track)) sameNotes += 1;
      });
    }
  }
  console.log(`    ${clips} clips: ${same} byte-identical, ${sameNotes} note-identical; e.g. ${differing.join(', ')}`);
  assert.ok(clips > 1000, 'the corpus was read');
  assert.equal(sameNotes, clips, 'every clip plays the same notes after a round trip');
  assert.ok(same / clips >= 0.98, `${same} of ${clips} byte-identical`);
});
