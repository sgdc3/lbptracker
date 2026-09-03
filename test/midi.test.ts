import { strict as assert } from 'node:assert';
import test from 'node:test';

import { readNotes, NOTE_RECORD_SIZE } from '../src/core/notes.ts';
import { STEPS_PER_CELL, schedule, type Sequencer, type Track } from '../src/core/project.ts';
import { blockRoot, notePitch } from '../src/core/scale.ts';
import {
  DEFAULT_PPQ,
  STEPS_PER_QUARTER,
  midiToSequencer,
  sequencerToMidi,
} from '../src/core/midi.ts';
import { metaString, readMidi, writeMidi, writeVar, varLength } from '../src/core/smf.ts';

/* ---------------------------------------------------------------- fixtures */

/** One control point, in the shape the record format stores. */
interface Point {
  step: number;
  subStep?: 0 | 1 | 2;
  pitch: number;
  volume?: number;
  modulation?: number;
}

/** Build a track's note bytes the way the game stores them, then read them back. */
function makeTrack(notes: Point[][], over: Partial<Track> = {}): Track {
  const flat = notes.flat();
  const bytes = new Uint8Array(flat.length * NOTE_RECORD_SIZE);
  let at = 0;
  for (const note of notes) {
    note.forEach((point, index) => {
      const sub = point.subStep ?? 0;
      bytes[at] = (point.step & 0x7f) | (sub > 0 ? 0x80 : 0);
      bytes[at + 1] = (point.pitch & 0x7f) | (index === note.length - 1 ? 0x80 : 0);
      bytes[at + 2] = point.volume ?? 0x60;
      bytes[at + 3] = Math.round((point.modulation ?? 0) * 15) | (sub === 2 ? 0x40 : 0);
      at += NOTE_RECORD_SIZE;
    });
  }
  const grouped = readNotes(bytes);
  return {
    guid: 1234, name: 'test', gridX: 0, gridY: 0, stepOffset: 0,
    level: 1, pan: 0.5, echoSend: 0, reverbSend: 0, key: 0, scale: 0,
    notes: grouped.notes, trailingRecords: grouped.trailing.length,
    ...over,
  };
}

function makeSequencer(tracks: Track[], over: Partial<Sequencer> = {}): Sequencer {
  let lengthSteps = 0;
  for (const track of tracks) {
    for (const note of track.notes) {
      lengthSteps = Math.max(lengthSteps, track.stepOffset + note.endStep + 1);
    }
  }
  return {
    uid: 7, name: 'fixture', tempo: 120, swing: 0,
    echoFeedback: 0.54, echoTime: 1, echoMix: 0.6, reverb: 5,
    loop: true, startPoint: 0, numChannels: 1, volumes: [1, 1, 1, 1, 1, 1],
    tracks, lengthSteps,
    ...over,
  };
}

/**
 * A sequencer's music, sampled -- which is the thing a round trip must preserve.
 *
 * ⚠️ **Not the control points.** The exporter resamples a glide so that it is
 * still a glide in a receiver that does not interpolate, and the importer folds
 * the samples back up; a point list can legitimately come back with a different
 * number of entries and describe the same line. What cannot change is where the
 * line is, so this reads pitch and volume at every third of a step, which is the
 * finest position the record format has.
 */
function music(sequencer: Sequencer) {
  return schedule(sequencer).map((event) => {
    const track = sequencer.tracks[event.track];
    const root = blockRoot(track.key);
    const midi = (raw: number) => notePitch(raw, track.scale, root);
    const samples: [number, number][] = [];
    const last = event.points[event.points.length - 1].step;
    for (let thirds = 0; thirds <= Math.round(last * 3); thirds += 1) {
      const at = thirds / 3;
      let i = 0;
      while (i + 1 < event.points.length && event.points[i + 1].step <= at) i += 1;
      const from = event.points[i];
      const to = event.points[i + 1];
      const span = to ? to.step - from.step : 0;
      const t = to && span > 0 ? (at - from.step) / span : 0;
      const pitch = to ? midi(from.pitch) + (midi(to.pitch) - midi(from.pitch)) * t : midi(from.pitch);
      const volume = to ? from.volume + (to.volume - from.volume) * t : from.volume;
      samples.push([pitch, volume]);
    }
    return {
      step: Math.round(event.step * 3) / 3,
      durationSteps: Math.round(event.durationSteps * 3) / 3,
      pitch: midi(event.pitch),
      volume: event.volume,
      modulation: Math.round(event.modulation * 15),
      samples,
    };
  });
}

/** Export then import, with everything at its default. */
function roundTrip(sequencer: Sequencer, options = {}) {
  const exported = sequencerToMidi(sequencer, options);
  const imported = midiToSequencer(exported.bytes);
  return { exported, imported };
}

/* --------------------------------------------------------------------- SMF */

test('a variable-length quantity round-trips at every boundary', () => {
  const out = new Uint8Array(8);
  for (const value of [0, 1, 0x7f, 0x80, 0x2000, 0x3fff, 0x4000, 0x1fffff, 0x200000, 0x0fffffff]) {
    const end = writeVar(out, 0, value);
    assert.equal(end, varLength(value), `length of ${value}`);
    // Read it back the way readMidi does, through a one-event track.
    const file = readMidi(
      writeMidi({ format: 0, division: 480, tracks: [{ events: [{ tick: value, data: Uint8Array.of(0x90, 60, 100) }] }] }),
    );
    assert.equal(file.tracks[0].events[0].tick, value, `tick ${value}`);
  }
});

test('running status is decoded, and a file that uses it reads the same', () => {
  // Three note-ons sharing one status byte, as hardware writes them.
  const body = Uint8Array.of(
    0x00, 0x90, 60, 100,
    0x10, 62, 100,
    0x10, 64, 100,
    0x00, 0xff, 0x2f, 0x00,
  );
  const head = Uint8Array.of(
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xe0,
    0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, body.length,
  );
  const file = new Uint8Array(head.length + body.length);
  file.set(head);
  file.set(body, head.length);

  const read = readMidi(file);
  const notes = read.tracks[0].events.filter((e) => (e.data[0] & 0xf0) === 0x90);
  assert.equal(notes.length, 3, 'all three note-ons survive the shared status byte');
  assert.deepEqual([...notes.map((n) => n.data[1])], [60, 62, 64]);
  assert.deepEqual([...notes.map((n) => n.tick)], [0, 16, 32]);
});

/* ------------------------------------------------------------------ export */

test('a triplet lands on an exact tick — the 96-PPQ bug', () => {
  // ⚠️ This is divergence 4 in steering/lbp-modding-toolchain.md. The toolkit
  // maps a triplet with `group*96 + pos*32`, which puts four positions of 32
  // ticks inside a 96-tick quarter and pushes the fourth onto the next beat.
  // At 480 PPQ a step is 120 ticks and a third of one is exactly 40.
  const seq = makeSequencer([
    makeTrack([
      [{ step: 4, pitch: 60 }],
      [{ step: 4, subStep: 1, pitch: 62 }],
      [{ step: 4, subStep: 2, pitch: 64 }],
      [{ step: 5, pitch: 65 }],
    ]),
  ]);
  const { bytes } = sequencerToMidi(seq);
  const file = readMidi(bytes);
  const ons = file.tracks
    .flatMap((t) => t.events)
    .filter((e) => (e.data[0] & 0xf0) === 0x90 && e.data[2] > 0)
    .sort((a, b) => a.tick - b.tick);
  assert.deepEqual([...ons.map((e) => e.tick)], [480, 520, 560, 600]);
  assert.equal(DEFAULT_PPQ / STEPS_PER_QUARTER / 3, 40, 'a third of a step is a whole tick');
});

test('the file announces an MPE lower zone and its bend range', () => {
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])]);
  const { bytes } = sequencerToMidi(seq, { bendRange: 48 });
  const head = readMidi(bytes).tracks[0].events.filter((e) => (e.data[0] & 0xf0) === 0xb0);
  const rpn = (channel: number, lsb: number) => {
    for (let i = 0; i + 2 < head.length; i += 1) {
      if (
        head[i].data[0] === (0xb0 | channel) && head[i].data[1] === 101 && head[i].data[2] === 0 &&
        head[i + 1].data[1] === 100 && head[i + 1].data[2] === lsb && head[i + 2].data[1] === 6
      ) {
        return head[i + 2].data[2];
      }
    }
    return undefined;
  };
  assert.equal(rpn(0, 6), 15, 'MCM on the master channel: 15 member channels');
  assert.equal(rpn(1, 0), 48, 'bend range on the first member channel');
  assert.equal(rpn(0, 0), 2, 'the master keeps MPE’s own smaller range');
});

/** Walk a file's note events, asserting no channel ever holds one pitch twice. */
function assertNoPitchCollision(bytes: Uint8Array): number {
  const sounding = new Set<number>();
  let written = 0;
  const events = readMidi(bytes)
    .tracks.flatMap((t) => t.events)
    .sort((a, b) => a.tick - b.tick);
  for (const event of events) {
    const kind = event.data[0] & 0xf0;
    const key = ((event.data[0] & 0x0f) << 8) | event.data[1];
    if (kind === 0x90 && event.data[2] > 0) {
      assert.ok(!sounding.has(key), `channel ${event.data[0] & 0x0f} already holds note ${event.data[1]}`);
      sounding.add(key);
      written += 1;
    } else if (kind === 0x80) {
      sounding.delete(key);
    }
  }
  return written;
}

test('a chord bigger than the zone shares channels rather than colliding', () => {
  // Twenty different pitches at once, fifteen member channels. Sharing a
  // channel costs those notes their own expression and nothing else, so it is
  // the right thing to give up -- but it has to be counted.
  const chord: Point[][] = [];
  for (let i = 0; i < 20; i += 1) chord.push([{ step: 0, pitch: 40 + i }, { step: 8, pitch: 40 + i }]);
  const exported = sequencerToMidi(makeSequencer([makeTrack(chord)]));
  assert.equal(exported.notes, 20, 'every note is written');
  assert.equal(exported.dropped, 0);
  assert.equal(exported.sharedChannel, 5, '20 notes over 15 channels');
  assert.equal(assertNoPitchCollision(exported.bytes), 20);
});

test('sixteen unisons cannot be carried, and say so instead of vanishing', () => {
  // ⚠️ The one case MPE genuinely cannot express: more copies of a single
  // pitch than there are channels to tell them apart. Fifteen go, the rest are
  // reported -- a converter that dropped them quietly would be lying.
  const chord: Point[][] = [];
  for (let i = 0; i < 24; i += 1) chord.push([{ step: 0, pitch: 60 }, { step: 8, pitch: 60 }]);
  const exported = sequencerToMidi(makeSequencer([makeTrack(chord)]));
  assert.equal(exported.notes, 15);
  assert.equal(exported.dropped, 9);
  assert.equal(assertNoPitchCollision(exported.bytes), 15);
});

test('a glide is written as a glide, not as two steps', () => {
  // ⚠️ The trap this catches: MIDI pitch bend holds until the next message, so
  // two events an octave apart are a jump. The engine ramps between control
  // points, so the export has to resample.
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 48 }, { step: 16, pitch: 60 }]])]);
  const { bytes } = sequencerToMidi(seq);
  const bends = readMidi(bytes)
    .tracks.flatMap((t) => t.events)
    .filter((e) => (e.data[0] & 0xf0) === 0xe0);
  assert.ok(bends.length > 16, `expected a resampled ramp, got ${bends.length} bend events`);
  const values = bends.map((e) => (e.data[2] << 7) | e.data[1]);
  for (let i = 1; i < values.length; i += 1) {
    assert.ok(values[i] >= values[i - 1], 'the ramp only ever rises');
  }
  assert.equal(values[0], 8192, 'it starts centred');
});

/* ------------------------------------------------------------- round trips */

test('a plain sequencer survives the round trip note for note', () => {
  const seq = makeSequencer([
    makeTrack([
      [{ step: 0, pitch: 60, volume: 0x60 }],
      [{ step: 4, pitch: 64, volume: 0x40 }],
      [{ step: 8, pitch: 67, volume: 0x7f }],
      [{ step: 12, subStep: 1, pitch: 72, volume: 0x20 }],
    ]),
  ]);
  const { imported } = roundTrip(seq);
  assert.equal(imported.ours, true, 'it recognises its own header');
  assert.equal(imported.notes, 4);
  assert.deepEqual(music(imported.sequencer), music(seq));
});

test('glides, fades and modulation all come back', () => {
  const seq = makeSequencer([
    makeTrack([
      // A pitch glide of an octave over four steps.
      [{ step: 0, pitch: 48 }, { step: 4, pitch: 60 }],
      // A fade in from silence -- the case that used to render as nothing.
      [{ step: 8, pitch: 55, volume: 0 }, { step: 16, pitch: 55, volume: 0x7f }],
      // Both at once, and a modulation the note carries throughout.
      [
        { step: 24, pitch: 40, volume: 0x10, modulation: 1 },
        { step: 28, pitch: 47, volume: 0x70, modulation: 1 },
      ],
    ]),
  ]);
  const { imported } = roundTrip(seq);
  const before = music(seq);
  const after = music(imported.sequencer);
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i += 1) {
    assert.equal(after[i].step, before[i].step, `note ${i} position`);
    assert.equal(after[i].durationSteps, before[i].durationSteps, `note ${i} duration`);
    assert.equal(after[i].modulation, before[i].modulation, `note ${i} modulation`);
    for (let s = 0; s < before[i].samples.length; s += 1) {
      const [p0, v0] = before[i].samples[s];
      const [p1, v1] = after[i].samples[s];
      assert.ok(Math.abs(p1 - p0) <= 0.5, `note ${i} pitch at ${s / 3}: ${p1} vs ${p0}`);
      assert.ok(Math.abs(v1 - v0) <= 1, `note ${i} volume at ${s / 3}: ${v1} vs ${v0}`);
    }
  }
});

test('a glide comes back as the two points it was written with', () => {
  // The resampling is an export detail. If it leaked into the import, every
  // glide would come back as a hundred records and a re-export would grow again.
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 48 }, { step: 16, pitch: 60 }]])]);
  const { imported } = roundTrip(seq);
  const points = imported.sequencer.tracks[0].notes[0].points;
  assert.equal(points.length, 2, `expected 2 points, got ${points.length}`);
  assert.equal(points[0].pitch, 48);
  assert.equal(points[1].pitch, 60);
});

test('Key and Scale are baked into the notes, not applied twice', () => {
  // ⚠️ The trap: the exporter writes what you hear, so the importer must NOT
  // re-apply a key. Restoring `key` here would transpose the part a second time.
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 61 }], [{ step: 4, pitch: 66 }]], { key: 14, scale: 2 }),
  ]);
  const track = seq.tracks[0];
  const expected = [61, 66].map((p) => notePitch(p, track.scale, blockRoot(track.key)));
  const { imported } = roundTrip(seq);
  const got = imported.sequencer.tracks[0].notes.map((n) => n.points[0].pitch);
  assert.deepEqual(got, expected, 'the imported record pitch IS the MIDI note');
  assert.equal(imported.sequencer.tracks[0].key, 12, 'and the placement is chromatic C');
  assert.equal(imported.sequencer.tracks[0].scale, 0);
  assert.deepEqual(music(imported.sequencer), music(seq));
});

test('the mixer travels in the header — divergence 5', () => {
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])], {
    numChannels: 3, volumes: [0.5, 0.25, 1, 1, 1, 1], swing: 0.4, tempo: 173, reverb: 9,
  });
  const { imported } = roundTrip(seq);
  assert.equal(imported.sequencer.numChannels, 3);
  assert.deepEqual(imported.sequencer.volumes, [0.5, 0.25, 1, 1, 1, 1]);
  assert.equal(imported.sequencer.swing, 0.4);
  assert.equal(imported.sequencer.tempo, 173);
  assert.equal(imported.sequencer.reverb, 9);
});

test('a part longer than a clip is re-cut, and the music does not move', () => {
  // A record's step field is seven bits, so 128 steps is a clip. Notes past
  // that have to open a new one -- on a cell boundary, `gridX * 16`.
  const notes: Point[][] = [];
  for (let step = 0; step < 400; step += 8) notes.push([{ step: step % 128, pitch: 60 }]);
  const tracks = [0, 128, 256, 384].map((offset, index) =>
    makeTrack(
      notes.filter((_, i) => Math.floor((i * 8) / 128) === index).map((n) => n),
      { gridX: offset / STEPS_PER_CELL, stepOffset: offset },
    ),
  );
  const seq = makeSequencer(tracks.filter((t) => t.notes.length > 0));
  const { imported } = roundTrip(seq);
  assert.ok(imported.clips > 1, `expected several clips, got ${imported.clips}`);
  assert.equal(imported.dropped, 0);
  for (const track of imported.sequencer.tracks) {
    assert.equal(track.stepOffset % STEPS_PER_CELL, 0, 'clips start on a cell');
    for (const note of track.notes) assert.ok(note.endStep <= 127, 'and stay inside seven bits');
  }
  assert.deepEqual(music(imported.sequencer), music(seq));
});

test('clips that share an instrument and a row merge into one part', () => {
  // 1150 placements would be 1150 MIDI tracks; a DAW would be unusable. Clips
  // differing only in `gridX` are one part played at different times.
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 60 }]], { gridX: 0, stepOffset: 0 }),
    makeTrack([[{ step: 0, pitch: 62 }]], { gridX: 1, stepOffset: 16 }),
    makeTrack([[{ step: 0, pitch: 64 }]], { gridX: 2, stepOffset: 32 }),
    makeTrack([[{ step: 0, pitch: 67 }]], { gridX: 0, stepOffset: 0, gridY: 1, guid: 99 }),
  ]);
  const { exported, imported } = roundTrip(seq);
  assert.equal(exported.parts, 2, 'two instruments, two parts');
  assert.deepEqual(music(imported.sequencer), music(seq));
});

test('plain mode spends channels on parts and says what it dropped', () => {
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 48 }, { step: 8, pitch: 60 }], [{ step: 16, pitch: 55 }]]),
  ]);
  const exported = sequencerToMidi(seq, { mpe: false });
  assert.equal(exported.droppedGlides, 1, 'the glide could not be written, and is counted');
  const file = readMidi(exported.bytes);
  const bends = file.tracks.flatMap((t) => t.events).filter((e) => (e.data[0] & 0xf0) === 0xe0);
  assert.equal(bends.length, 0, 'and no channel-wide bend is invented in its place');
  const ons = file.tracks.flatMap((t) => t.events).filter((e) => (e.data[0] & 0xf0) === 0x90);
  assert.equal(new Set(ons.map((e) => e.data[0] & 0x0f)).size, 1, 'one channel for the part');
});

test('swing can be baked into the timing, or carried in the header', () => {
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }], [{ step: 1, pitch: 62 }]])], {
    swing: 0.5,
  });
  const straight = readMidi(sequencerToMidi(seq).bytes);
  const swung = readMidi(sequencerToMidi(seq, { bakeSwing: true }).bytes);
  const firstOffbeat = (file: ReturnType<typeof readMidi>) =>
    file.tracks
      .flatMap((t) => t.events)
      .filter((e) => (e.data[0] & 0xf0) === 0x90 && e.data[1] === 62)[0].tick;
  assert.equal(firstOffbeat(straight), 120, 'the grid is straight by default');
  assert.ok(firstOffbeat(swung) > 120, 'and stretched when the swing is baked');
  // Either way the sequencer's own swing survives, so a re-import still swings.
  assert.equal(midiToSequencer(sequencerToMidi(seq).bytes).sequencer.swing, 0.5);
});

test('a file from somewhere else imports as a plain chromatic part', () => {
  // No LBP metas at all: two notes and a tempo, as any DAW would write them.
  const bytes = writeMidi({
    format: 1,
    division: 96,
    tracks: [
      {
        events: [
          { tick: 0, data: Uint8Array.of(0xff, 0x51, 0x03, 0x07, 0xa1, 0x20) },
          { tick: 0, data: Uint8Array.of(0x90, 60, 100) },
          { tick: 96, data: Uint8Array.of(0x80, 60, 64) },
          { tick: 96, data: Uint8Array.of(0x90, 64, 80) },
          { tick: 144, data: Uint8Array.of(0x80, 64, 64) },
        ],
      },
    ],
  });
  const result = midiToSequencer(bytes, 'from a DAW');
  assert.equal(result.ours, false);
  assert.equal(result.notes, 2);
  assert.equal(result.sequencer.name, 'from a DAW');
  assert.equal(Math.round(result.sequencer.tempo), 120);
  const events = schedule(result.sequencer);
  assert.deepEqual(events.map((e) => e.pitch), [60, 64]);
  // 96 ticks at 96 PPQ is a quarter: step 0 for four steps, then step 4 for two.
  assert.deepEqual(events.map((e) => e.step), [0, 4]);
  assert.deepEqual(events.map((e) => e.durationSteps), [4, 2]);
  assert.deepEqual(events.map((e) => e.volume), [100, 80]);
});

test('a note shorter than the grid is lengthened, and counted', () => {
  const bytes = writeMidi({
    format: 1,
    division: 480,
    tracks: [{
      events: [
        { tick: 0, data: Uint8Array.of(0x90, 60, 100) },
        { tick: 30, data: Uint8Array.of(0x80, 60, 64) },   // a 64th note
      ],
    }],
  });
  const result = midiToSequencer(bytes);
  assert.equal(result.lengthened, 1);
  assert.equal(schedule(result.sequencer)[0].durationSteps, 1, 'one step is the shortest there is');
});

test('the header survives a re-export, so a file can go round twice', () => {
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 48 }, { step: 8, pitch: 60 }], [{ step: 16, pitch: 55, volume: 0x30 }]], {
      key: 15, scale: 3,
    }),
  ], { tempo: 200, numChannels: 2, swing: 0.2 });
  const once = midiToSequencer(sequencerToMidi(seq).bytes).sequencer;
  const twice = midiToSequencer(sequencerToMidi(once).bytes).sequencer;
  assert.deepEqual(music(twice), music(once), 'the second trip changes nothing');
  assert.equal(twice.tempo, 200);
  assert.equal(twice.numChannels, 2);
});

test('the track name reaches the file and comes back', () => {
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]], { name: 'lbp3/piano', guid: 4242 })]);
  const { exported, imported } = roundTrip(seq);
  const names = readMidi(exported.bytes)
    .tracks.flatMap((t) => t.events)
    .map(metaString)
    .filter((m) => m?.type === 0x03)
    .map((m) => m?.text);
  assert.ok(names.includes('lbp3/piano'), `track names: ${names.join(', ')}`);
  assert.equal(imported.sequencer.tracks[0].name, 'lbp3/piano');
  assert.equal(imported.sequencer.tracks[0].guid, 4242, 'and the GUID, so it plays the same sample');
});
