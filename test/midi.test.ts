import { strict as assert } from 'node:assert';
import test from 'node:test';

import { readNotes, NOTE_RECORD_SIZE } from '../src/core/notes.ts';
import { STEPS_PER_CELL, schedule, type Sequencer, type Track } from '../src/core/project.ts';
import { blockRoot, notePitch, quantise, unquantise, MAX_SCALE } from '../src/core/scale.ts';
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
    notes: grouped.notes, records: bytes, trailingRecords: grouped.trailing.length,
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

test('seventeen unisons cannot be carried, and say so instead of vanishing', () => {
  // ⚠️ The one case MPE genuinely cannot express: more copies of a single
  // pitch than there are channels to tell them apart. Sixteen go -- the fifteen
  // member channels and then the master, which the specification allows to
  // carry notes and which is the right place for one that can have no
  // expression anyway -- and the rest are reported. A converter that dropped
  // them quietly would be lying. One note in the corpus's 953,791 gets here.
  const chord: Point[][] = [];
  for (let i = 0; i < 24; i += 1) chord.push([{ step: 0, pitch: 60 }, { step: 8, pitch: 60 }]);
  const exported = sequencerToMidi(makeSequencer([makeTrack(chord)]));
  assert.equal(exported.notes, 16);
  assert.equal(exported.dropped, 8);
  assert.equal(assertNoPitchCollision(exported.bytes), 16);
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
  assert.equal(values[0], 8192, 'it starts centred');
  // ⚠️ The last event is the reset the note leaves behind: nothing else
  // re-centres a member channel, so the next note to land there would inherit
  // the pitch this one finished on.
  assert.equal(values[values.length - 1], 8192, 'and is undone when the note ends');
  const ramp = values.slice(0, -1);
  for (let i = 1; i < ramp.length; i += 1) {
    assert.ok(ramp[i] >= ramp[i - 1], 'the ramp only ever rises');
  }
  assert.ok(ramp[ramp.length - 1] > 8192 * 1.2, 'and reaches the note it glides to');
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

test('Key and Scale both come back, by different means', () => {
  // ⚠️ The exporter folds both into the note numbers so the file plays
  // anywhere. Undoing that is the difference between a transposition and a
  // projection: `blockRoot(key) - 12` is invertible, `quantise` is measured NOT
  // to be idempotent, so the scale is undone by taking the LOWEST note that
  // snaps to the one the file names -- which always sounds right and only
  // reproduces the author's own field where they wrote on the scale. The record
  // patch covers the rest, which is why the default export is exact either way.

  // A key alone: the placement comes back exactly as it was written.
  const keyed = makeSequencer([
    makeTrack([[{ step: 0, pitch: 61 }], [{ step: 4, pitch: 66 }]], { key: 14, scale: 0 }),
  ]);
  const back = midiToSequencer(sequencerToMidi(keyed).bytes).sequencer;
  assert.equal(back.tracks[0].key, 14, 'the key is restored');
  assert.deepEqual(
    back.tracks[0].notes.map((n) => n.points[0].pitch),
    [61, 66],
    'and the record pitches with it',
  );
  assert.deepEqual(music(back), music(keyed));

  const scaled = makeSequencer([
    makeTrack([[{ step: 0, pitch: 61 }], [{ step: 4, pitch: 66 }]], { key: 14, scale: 2 }),
  ]);
  const t = scaled.tracks[0];
  const heard = [61, 66].map((p) => notePitch(p, t.scale, blockRoot(t.key)));

  // Without the patch: the placement is right and sounds right, but 61 and 66
  // are off the natural minor and come back as the tones they snapped to.
  const loose = midiToSequencer(sequencerToMidi(scaled, { exact: false }).bytes).sequencer;
  assert.equal(loose.tracks[0].scale, 2, 'the scale is restored');
  assert.equal(loose.tracks[0].key, 14, 'and the key with it');
  assert.deepEqual(loose.tracks[0].notes.map((n) => n.points[0].pitch), [60, 65]);
  assert.deepEqual(
    loose.tracks[0].notes.map((n) => notePitch(n.points[0].pitch, 2, blockRoot(14))),
    heard,
    'a different field, the same sound',
  );
  assert.deepEqual(music(loose), music(scaled));

  // With it, which is the default: the author's own fields come back.
  const exact = sequencerToMidi(scaled);
  assert.equal(exact.patched, 1, 'the clip could not be said in MIDI alone');
  const tight = midiToSequencer(exact.bytes).sequencer;
  assert.deepEqual(tight.tracks[0].notes.map((n) => n.points[0].pitch), [61, 66]);
  assert.deepEqual([...tight.tracks[0].records], [...scaled.tracks[0].records]);
});

test('an off-scale note has a preimage only where the scale reaches it', () => {
  // The tables are non-decreasing, so a tone the scale contains is its own
  // lowest preimage and `unquantise` is the identity on it.
  for (let scale = 0; scale <= MAX_SCALE; scale += 1) {
    for (let note = 0; note < 128; note += 1) {
      const snapped = quantise(note, scale);
      assert.equal(
        quantise(unquantise(snapped, scale), scale),
        snapped,
        `scale ${scale} note ${note}`,
      );
    }
  }
  // Natural minor reaches no 1, 4, 6, 9 or 11, and those come back untouched.
  for (const off of [1, 4, 6, 9, 11]) assert.equal(unquantise(60 + off, 2), 60 + off);
});

test('byte 3 keeps its resting bit 6, per clip', () => {
  // ⚠️ Inert -- the engine reads it only when byte 0's bit 7 is set -- and
  // still a fact about the file: eight of the ten corpus levels set it on every
  // record and the oldest sets it on none. Dropping it made 78% of the corpus's
  // clips come back different.
  const set = makeTrack([[{ step: 0, pitch: 60 }]], { gridX: 0 });
  const clear = makeTrack([[{ step: 0, pitch: 60 }]], { gridX: 1 });
  set.records[3] |= 0x40;
  clear.records[3] &= ~0x40;
  const seq = makeSequencer([set, clear]);
  const back = midiToSequencer(sequencerToMidi(seq).bytes).sequencer;
  const at = (x: number) => back.tracks.find((t) => t.gridX === x)!;
  assert.equal(at(0).records[3] & 0x40, 0x40, 'the set clip keeps it');
  assert.equal(at(1).records[3] & 0x40, 0, 'the clear clip keeps it clear');
});

test('a sub-step record still owns bit 6, whatever the clip rests at', () => {
  // ❗ The bit is the sub-step's high half when byte 0's bit 7 is set, so a
  // record at a third must have it CLEAR and one at two thirds must have it SET,
  // no matter what the rest of the clip does.
  const seq = makeSequencer([
    makeTrack([
      [{ step: 0, pitch: 60 }],
      [{ step: 1, subStep: 1, pitch: 62 }],
      [{ step: 2, subStep: 2, pitch: 64 }],
    ]),
  ]);
  seq.tracks[0].records[3] |= 0x40;
  const back = midiToSequencer(sequencerToMidi(seq).bytes).sequencer;
  const points = back.tracks[0].notes.map((n) => n.points[0]);
  assert.deepEqual(points.map((p) => p.subStep), [0, 1, 2]);
  assert.deepEqual(points.map((p) => p.timbre & 0x40), [0x40, 0, 0x40]);
});

test('the two fields MIDI has no room for come back through the patch', () => {
  // ⚠️ **Both are zero in all 1,448,224 corpus records**, so this is the only
  // place either is exercised: a volume above 127, which MIDI has no velocity
  // for, and `timbre` bits 4-5, the per-block table select that picks one of
  // four level/pan/send records and that nothing in `render.ts` reads either.
  // They cost nothing to carry because the patch already exists for the clips
  // that need it -- but a level unlike any of the 22 would need them.
  const built = makeTrack([[{ step: 0, pitch: 60 }], [{ step: 4, pitch: 62 }]]);
  built.records[2] = 200;
  built.records[7] |= 0x30;
  const grouped = readNotes(built.records);
  const track: Track = {
    ...built, notes: grouped.notes, trailingRecords: grouped.trailing.length,
  };
  const seq = makeSequencer([track]);

  const loose = midiToSequencer(sequencerToMidi(seq, { exact: false }).bytes).sequencer;
  assert.equal(loose.tracks[0].records[2], 127, 'MIDI alone clamps the volume');
  assert.equal(loose.tracks[0].records[7] & 0x30, 0, 'and cannot say the table select');

  const tight = midiToSequencer(sequencerToMidi(seq).bytes).sequencer;
  assert.deepEqual([...tight.tracks[0].records], [...track.records]);
});

test('the record patch is written only for what MIDI could not say', () => {
  // A plain clip needs none of it, and says so.
  const plain = sequencerToMidi(makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])]));
  assert.equal(plain.patched, 0);
  assert.equal(plain.unpatched, 0);
  assert.ok(!new TextDecoder().decode(plain.bytes).includes('"fix"'));
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

test('every sequencer and placement field that survives, does', () => {
  // The whole inventory in one place, so that adding a field to `Sequencer` or
  // `Track` and forgetting the header meta shows up here rather than in a DAW.
  const seq = makeSequencer(
    [makeTrack([[{ step: 0, pitch: 60 }]], {
      guid: 4242, name: 'kalimba', gridY: 5,
      level: 0.375, pan: 0.8, echoSend: 0.25, reverbSend: 0.6,
    })],
    {
      uid: 98765, name: 'A Song', tempo: 173, swing: 0.35,
      echoFeedback: 0.42, echoTime: 3, echoMix: 0.75, reverb: 11,
      loop: false, startPoint: 7, numChannels: 4,
      volumes: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
    },
  );
  const { sequencer: back } = midiToSequencer(sequencerToMidi(seq).bytes);
  for (const field of [
    'uid', 'name', 'tempo', 'swing', 'echoFeedback', 'echoTime', 'echoMix',
    'reverb', 'loop', 'startPoint', 'numChannels',
  ] as const) {
    assert.deepEqual(back[field], seq[field], `sequencer.${field}`);
  }
  assert.deepEqual(back.volumes, seq.volumes);
  for (const field of [
    'guid', 'name', 'gridY', 'level', 'pan', 'echoSend', 'reverbSend',
  ] as const) {
    assert.deepEqual(back.tracks[0][field], seq.tracks[0][field], `track.${field}`);
  }
  assert.equal(back.tracks[0].key, seq.tracks[0].key, 'track.key');
  assert.equal(back.tracks[0].scale, seq.tracks[0].scale, 'track.scale');
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

test('a glide keeps its channel when flat notes are competing for it', () => {
  // ⚠️ **This is the shared-channel problem.** A zone has fifteen member
  // channels and this engine has thirty-two voices, so a dense passage runs
  // out — and allocating in plain time order let fifteen flat notes take every
  // channel a moment before the one note that actually needed one. Across the
  // corpus that flattened 3,593 notes where at most 1,172 ever had to.
  // Fifteen flat notes holding for sixteen steps, and one glide starting inside
  // them: in time order the flat ones take every channel first.
  const notes: Point[][] = [];
  for (let i = 0; i < 15; i += 1) {
    notes.push([{ step: 0, pitch: 40 + i }, { step: 15, pitch: 40 + i }]);
  }
  notes.push([{ step: 1, pitch: 72 }, { step: 9, pitch: 84 }]);
  const seq = makeSequencer([makeTrack(notes)]);

  const exported = sequencerToMidi(seq);
  assert.equal(exported.notes, 16);
  assert.equal(exported.flattened, 0, 'the glide is not the one that gives way');
  assert.ok(exported.sharedChannel > 0, 'something had to share — just not the glide');

  const { sequencer } = midiToSequencer(exported.bytes);
  const glide = schedule(sequencer).find((e) => e.pitch === 72);
  assert.ok(glide, 'the gliding note came back');
  assert.equal(glide.points.length, 2);
  assert.equal(glide.points[1].pitch, 84, 'and it still reaches where it was going');
});

test('a note in front of a glide takes it away, and the loss is declared', () => {
  // The case the ordering cannot save: a flat note that starts BEFORE the glide
  // it has to share with. A reader tells the channel's owner by who arrived
  // first, so the glide has to be given up — never silently.
  const notes: Point[][] = [];
  // Every member channel taken by a glide that starts later than the flat notes.
  for (let i = 0; i < 15; i += 1) {
    notes.push([{ step: 4, pitch: 40 + i }, { step: 12, pitch: 52 + i }]);
  }
  // Two flat notes of ONE pitch, so the second cannot go on the master either.
  notes.push([{ step: 0, pitch: 100 }, { step: 15, pitch: 100 }]);
  notes.push([{ step: 0, pitch: 100 }, { step: 15, pitch: 100 }]);
  const exported = sequencerToMidi(makeSequencer([makeTrack(notes)]));
  assert.equal(exported.notes, 17, 'every note is written');
  assert.equal(exported.dropped, 0, 'nothing is thrown away to save a glide');
  assert.equal(exported.flattened, 1, 'exactly one glide gave way, and it is counted');
});

// ------------------------------------------------------------------- splitting

test('splitting puts the parts in as few files as their polyphony needs', async () => {
  const { splitSequencerToMidi } = await import('../src/core/midi.ts');
  // Two parts of ten simultaneous notes each: twenty at once is over a zone's
  // fifteen, ten is not, so they belong in one file each and no note shares.
  const part = (row: number, base: number) =>
    makeTrack(
      Array.from({ length: 10 }, (_, i) => [{ step: 0, pitch: base + i }, { step: 15, pitch: base + i }]),
      { gridY: row, guid: 1000 + row },
    );
  const seq = makeSequencer([part(0, 40), part(1, 60)]);

  const whole = sequencerToMidi(seq);
  assert.ok(whole.sharedChannel > 0, 'one file cannot hold twenty at once');

  const split = splitSequencerToMidi(seq);
  assert.equal(split.files.length, 2);
  assert.equal(split.notes, whole.notes, 'and every note is still written');
  assert.equal(split.sharedChannel, 0, 'with nothing left sharing');
  assert.ok(split.files.every((f) => /\.mid$/.test(f.name)));
});

test('a song that fits stays one file, and keeps the plain name', async () => {
  const { splitSequencerToMidi } = await import('../src/core/midi.ts');
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]])], { name: 'Small Song' });
  const split = splitSequencerToMidi(seq);
  assert.equal(split.files.length, 1);
  assert.equal(split.files[0].name, 'Small Song.mid');
});

test('every file of a split imports on its own', async () => {
  const { splitSequencerToMidi } = await import('../src/core/midi.ts');
  const part = (row: number, base: number) =>
    makeTrack(
      Array.from({ length: 10 }, (_, i) => [{ step: 0, pitch: base + i }, { step: 15, pitch: base + i }]),
      { gridY: row, guid: 1000 + row },
    );
  const seq = makeSequencer([part(0, 40), part(1, 60)], { tempo: 137, numChannels: 2 });
  const split = splitSequencerToMidi(seq);
  let notes = 0;
  for (const file of split.files) {
    const imported = midiToSequencer(file.result.bytes);
    assert.equal(imported.ours, true, `${file.name} carries the header`);
    assert.equal(imported.sequencer.tempo, 137, 'every file knows the tempo');
    assert.equal(imported.sequencer.numChannels, 2, 'and the mixer');
    notes += imported.notes;
  }
  assert.equal(notes, 20, 'and between them they hold the whole song');
});

test('a zip of the split reads back as the files that went in', async () => {
  const { writeZip, crc32 } = await import('../src/core/zip.ts');
  const one = Uint8Array.of(1, 2, 3, 4, 5);
  const two = new Uint8Array(1000).fill(0x41);
  const zip = writeZip([{ name: 'one.mid', bytes: one }, { name: 'two.mid', bytes: two }]);

  // Read it the way an unzipper does: the central directory is the index.
  const view = new DataView(zip.buffer);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50, 'end of central directory');
  assert.equal(view.getUint16(end + 8, true), 2, 'two entries');
  let at = view.getUint32(end + 16, true);
  const found: { name: string; bytes: Uint8Array }[] = [];
  for (let i = 0; i < 2; i += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const offset = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLen));
    // The local header repeats the name and the sizes; both copies must agree.
    assert.equal(view.getUint32(offset, true), 0x04034b50, `${name} local header`);
    assert.equal(view.getUint32(offset + 18, true), size, `${name} size agrees`);
    assert.equal(view.getUint32(offset + 14, true), crc, `${name} crc agrees`);
    const from = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    const bytes = zip.subarray(from, from + size);
    assert.equal(crc32(bytes), crc, `${name} contents match their checksum`);
    found.push({ name, bytes });
    at += 46 + nameLen;
  }
  assert.deepEqual(found.map((f) => f.name), ['one.mid', 'two.mid']);
  assert.deepEqual([...found[0].bytes], [...one]);
  assert.equal(found[1].bytes.length, 1000);
});

test('per-part channels give every part all fifteen, in one file', () => {
  // ⚠️ The point a DAW makes true: a file's tracks share one set of sixteen
  // channels, but Reaper — and anything else that lands one project track per
  // MIDI track — hands each track its own instrument, and that instrument sees
  // only its own track's events. There the parts never meet.
  const part = (row: number, base: number) =>
    makeTrack(
      Array.from({ length: 10 }, (_, i) => [{ step: 0, pitch: base + i }, { step: 15, pitch: base + i }]),
      { gridY: row, guid: 1000 + row },
    );
  const seq = makeSequencer([part(0, 40), part(1, 60)]);

  const shared = sequencerToMidi(seq);
  assert.ok(shared.sharedChannel > 0, 'twenty at once does not fit in fifteen');

  const split = sequencerToMidi(seq, { channelsPerPart: true });
  assert.equal(split.sharedChannel, 0, 'ten and ten do');
  assert.equal(split.notes, shared.notes);

  // Both parts really are using the same channel numbers — that is the trade.
  const used = new Map<number, Set<number>>();
  for (const [index, track] of readMidi(split.bytes).tracks.entries()) {
    for (const e of track.events) {
      if ((e.data[0] & 0xf0) !== 0x90 || e.data[2] === 0) continue;
      const set = used.get(index) ?? new Set<number>();
      set.add(e.data[0] & 0x0f);
      used.set(index, set);
    }
  }
  const [a, b] = [...used.values()];
  assert.ok([...a].some((ch) => b.has(ch)), 'the two parts overlap on channel numbers');
});

test('a per-part file still reads back correctly here', () => {
  // This importer reads each MIDI track on its own, which is exactly what a DAW
  // does — so a file written this way round-trips even though a single-stream
  // player would hear the parts collide.
  const part = (row: number, base: number) =>
    makeTrack(
      [
        ...Array.from({ length: 10 }, (_, i) => [{ step: 0, pitch: base + i }, { step: 15, pitch: base + i }]),
        [{ step: 2, pitch: base }, { step: 10, pitch: base + 7 }],
      ],
      { gridY: row, guid: 1000 + row },
    );
  const seq = makeSequencer([part(0, 40), part(1, 60)]);
  const exported = sequencerToMidi(seq, { channelsPerPart: true });
  assert.equal(exported.flattened, 0, 'and no glide had to be given up');
  const { sequencer } = midiToSequencer(exported.bytes);
  assert.deepEqual(music(sequencer), music(seq));
});

test('a track is named after its instrument when the level does not name it', () => {
  // ⚠️ `PInstrument` carries no name worth printing: `Track.name` is empty on
  // every placement of all 22 corpus levels. Without a resolver the file calls
  // every track `guid 148321` and a DAW is unreadable.
  const seq = makeSequencer([makeTrack([[{ step: 0, pitch: 60 }]], { name: '', guid: 148321 })]);

  const bare = readMidi(sequencerToMidi(seq).bytes);
  const named = readMidi(
    sequencerToMidi(seq, {
      instrumentName: (guid) => (guid === 148321 ? 'baiyon_drums_1' : undefined),
    }).bytes,
  );
  const names = (file: ReturnType<typeof readMidi>) =>
    file.tracks.flatMap((t) => t.events).map(metaString).filter((m) => m?.type === 0x03).map((m) => m?.text);

  assert.ok(names(bare).includes('guid 148321'), 'the GUID is the fallback, not the goal');
  assert.ok(names(named).includes('baiyon_drums_1'));
  // And it survives a round trip, so re-importing shows the name too.
  const back = midiToSequencer(
    sequencerToMidi(seq, { instrumentName: () => 'baiyon_drums_1' }).bytes,
  );
  assert.equal(back.sequencer.tracks[0].name, 'baiyon_drums_1');
  assert.equal(back.sequencer.tracks[0].guid, 148321, 'and the GUID still says what to play');
});

test('the board cells come back, because the file remembers them', () => {
  // ⚠️ Clips of one part overlap heavily — a cell is 16 steps apart and a clip
  // holds 128 — so a note two cells could hold is genuinely ambiguous, and the
  // last cell that can hold it is the answer taken. What matters is that the
  // cells themselves are the author's and not a fresh greedy cut.
  const at = (gridX: number, pitch: number) =>
    makeTrack([[{ step: 0, pitch }, { step: 3, pitch }]], {
      gridX, stepOffset: gridX * STEPS_PER_CELL, gridY: 2, guid: 77,
    });
  const seq = makeSequencer([at(0, 60), at(9, 62), at(23, 64), at(40, 65)]);

  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  assert.deepEqual(
    sequencer.tracks.map((t) => t.gridX).sort((a, b) => a - b),
    [0, 9, 23, 40],
    'the same cells, not a re-cut on multiples of eight',
  );
  for (const track of sequencer.tracks) {
    assert.equal(track.stepOffset, track.gridX * STEPS_PER_CELL);
    assert.equal(track.gridY, 2, 'and the row it was on');
  }
  assert.deepEqual(music(sequencer), music(seq));
});

test('a file with no cells to go on is still cut into legal clips', () => {
  // A DAW's file has no `LBP-TRK`, so there is nothing to restore; what it must
  // not do is write a step field that does not fit in seven bits.
  const bytes = writeMidi({
    format: 1,
    division: 480,
    tracks: [{
      events: Array.from({ length: 40 }, (_, i) => [
        { tick: i * 120 * 10, data: Uint8Array.of(0x90, 60 + (i % 12), 100) },
        { tick: i * 120 * 10 + 600, data: Uint8Array.of(0x80, 60 + (i % 12), 64) },
      ]).flat(),
    }],
  });
  const result = midiToSequencer(bytes);
  assert.ok(result.clips > 1, `a 400-step part needs several clips, got ${result.clips}`);
  for (const track of result.sequencer.tracks) {
    assert.equal(track.stepOffset % STEPS_PER_CELL, 0, 'clips start on a cell');
    for (const note of track.notes) assert.ok(note.endStep <= 127, 'and stay inside seven bits');
  }
  assert.equal(result.dropped, 0);
});

test('a clip length tells overlapping clips apart', () => {
  // ⚠️ Cells alone are not enough: clips of one part overlap — a cell is 16
  // steps and a clip may hold 128 — so on the cells alone 86.50% of the
  // corpus's notes fit more than one clip. With each clip's own extent as
  // well it is 0.09%.
  //
  // Here the clip at cell 0 is four steps long and the one at cell 1 is
  // twenty. A note at step 18 fits only the second — but on cells alone it
  // would fit both, and the first is the one the old rule would have taken.
  const short = makeTrack([[{ step: 0, pitch: 60 }, { step: 3, pitch: 60 }]], {
    gridX: 0, stepOffset: 0, gridY: 1, guid: 5,
  });
  const long = makeTrack(
    [[{ step: 2, pitch: 64 }, { step: 19, pitch: 64 }]],
    { gridX: 1, stepOffset: STEPS_PER_CELL, gridY: 1, guid: 5 },
  );
  const seq = makeSequencer([short, long]);

  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  const cells = sequencer.tracks
    .map((t) => ({ x: t.gridX, notes: t.notes.length }))
    .sort((a, b) => a.x - b.x);
  assert.deepEqual(cells, [{ x: 0, notes: 1 }, { x: 1, notes: 1 }], 'one note each, as written');
  assert.deepEqual(music(sequencer), music(seq));
});

test('a clip with no notes at all still comes back', () => {
  // ⚠️ 52 placements across the corpus hold nothing — an instrument dropped on
  // the board and never written in. There is nothing in a MIDI file to bring
  // one back except the cell list, so the importer emits every declared cell
  // whether or not anything landed in it.
  const empty = makeTrack([], { gridX: 154, stepOffset: 154 * STEPS_PER_CELL, gridY: 2, guid: 148321 });
  const played = makeTrack([[{ step: 0, pitch: 60 }]], {
    gridX: 3, stepOffset: 3 * STEPS_PER_CELL, gridY: 2, guid: 148321,
  });
  const seq = makeSequencer([empty, played]);

  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  assert.deepEqual(
    sequencer.tracks.map((t) => [t.gridX, t.notes.length]).sort((a, b) => a[0] - b[0]),
    [[3, 1], [154, 0]],
    'both cells, and the empty one is still empty',
  );
});

test('a part too polyphonic for one zone is split across tracks, and merged back', async () => {
  const { readMidi: read } = await import('../src/core/smf.ts');
  // ⚠️ Twenty notes of one part gliding at once. Fifteen member channels is
  // the ceiling, so five of them have nowhere to go — 825 notes across the
  // corpus lost a glide exactly here, and the two-pass allocator cannot help
  // when every note wants a channel of its own. Two tracks give the part thirty
  // channels, and a DAW plays them on two instances of the same instrument,
  // which is the same sound.
  const notes: Point[][] = [];
  for (let i = 0; i < 20; i += 1) {
    notes.push([{ step: 0, pitch: 40 + i }, { step: 15, pitch: 52 + i }]);
  }
  const seq = makeSequencer([makeTrack(notes, { guid: 7, gridY: 3, name: 'saw_wave' })]);

  const one = sequencerToMidi(seq);
  assert.ok(one.flattened > 0, 'one zone cannot hold twenty and keep the glide');

  const split = sequencerToMidi(seq, { channelsPerPart: true });
  assert.equal(split.flattened, 0, 'two lanes can');
  assert.equal(split.dropped, 0);
  assert.equal(split.parts, 1, 'and it is still reported as one part');

  const file = read(split.bytes);
  const named = file.tracks
    .flatMap((t) => t.events)
    .map(metaString)
    .filter((m) => m?.type === 0x03)
    .map((m) => m?.text);
  assert.ok(named.includes('saw_wave (1)'), `lanes are named: ${named.join(', ')}`);
  assert.ok(named.includes('saw_wave (2)'));

  // And they come back as one placement, with the glide intact.
  const { sequencer } = midiToSequencer(split.bytes);
  assert.equal(sequencer.tracks.length, 1, 'the lanes merged back into one clip');
  assert.equal(sequencer.tracks[0].name, 'saw_wave', 'under the part name, not a lane name');
  assert.deepEqual(music(sequencer), music(seq));
});

test('every one of the sixteen modulation values survives CC 74', () => {
  // ⚠️ The modulation is a FOUR-bit field riding on a seven-bit controller, so
  // the mapping has to be exact rather than close: `round(k*127/15)` back
  // through `round(v/127*15)` must return k for every k, or a round trip
  // returns a nibble one step from the one it was given.
  const notes: Point[][] = [];
  for (let k = 0; k <= 15; k += 1) notes.push([{ step: k * 2, pitch: 60, modulation: k / 15 }]);
  const seq = makeSequencer([makeTrack(notes)]);
  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  const got = schedule(sequencer)
    .sort((a, b) => a.step - b.step)
    .map((e) => Math.round(e.modulation * 15));
  assert.deepEqual(got, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
});

test('a modulation ramp comes back as a ramp', () => {
  // ⚠️ This was dropped until the engine was read: `sub_0x3930` writes a slide
  // rate for the modulation beside the ones for volume and pitch, so a note
  // that moves it changes its filter, level, LFOs and drive as it sounds. The
  // exporter carried only the opening value, which lost the ramp on all 34,449
  // corpus notes that have one.
  const seq = makeSequencer([
    makeTrack([[
      { step: 0, pitch: 60, modulation: 0 },
      { step: 16, pitch: 60, modulation: 1 },
    ]]),
  ]);
  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  const note = schedule(sequencer)[0];
  assert.equal(note.points.length, 2, `expected the two points back, got ${note.points.length}`);
  assert.equal(Math.round(note.points[0].modulation * 15), 0);
  assert.equal(Math.round(note.points[1].modulation * 15), 15);
  assert.equal(note.points[1].step, 16, 'and the ramp still ends where it did');
  // The record's own nibble, which is what the game reads.
  const records = sequencer.tracks[0].notes[0].points;
  assert.deepEqual(records.map((r) => r.timbre & 0x0f), [0, 15]);
});

test('a modulation that holds still writes no extra points', () => {
  const seq = makeSequencer([
    makeTrack([[
      { step: 0, pitch: 48, modulation: 0.4 },
      { step: 8, pitch: 60, modulation: 0.4 },
    ]]),
  ]);
  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  const note = schedule(sequencer)[0];
  assert.equal(note.points.length, 2, 'the glide, and nothing the modulation added');
  for (const p of note.points) assert.equal(Math.round(p.modulation * 15), 6);
});

test('a glide into a coincident pair keeps the glide', () => {
  // ⚠️ The last two notes in the corpus whose curve the round trip could not
  // explain, both in `Diode`: a dive from 68 down to 37 over two steps that
  // snaps back to 68 in the same instant it arrives. Coincident points collapse
  // to the later value — the engine's `t = span > 0 ? … : 1` — but collapsing
  // one mid-note dropped the record the ramp before it was aiming at, and the
  // dive came out flat.
  const seq = makeSequencer([
    makeTrack([[
      { step: 0, pitch: 68 },
      { step: 2, pitch: 37 },
      { step: 2, pitch: 68 },
    ]]),
  ]);
  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  const note = schedule(sequencer)[0];
  const low = Math.min(...note.points.map((p) => p.pitch));
  assert.ok(low < 50, `the dive is there: ${JSON.stringify(note.points.map((p) => [p.step, p.pitch]))}`);
  assert.equal(note.points[note.points.length - 1].pitch, 68, 'and it still snaps back');

  // ⚠️ **It reaches 42, not 37, and that is the closest anything can hear.**
  // The 37 exists only at the instant the pair supersedes it, so no sampler --
  // ours or the engine's -- ever reads it; the deepest value that sounds is the
  // ramp a third of a step earlier. The reconstruction aims its ramp at that
  // instead, which leaves the curve out by at most **a sixth of a semitone**.
  // That is the 0.167 the corpus check reports as its worst pitch deviation:
  // this case is where it comes from.
  const before = music(seq)[0].samples;
  const after = music(sequencer)[0].samples;
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i += 1) {
    assert.ok(
      Math.abs(after[i][0] - before[i][0]) <= 1 / 6 + 1e-9,
      `third ${i}: ${after[i][0]} against ${before[i][0]}`,
    );
    assert.equal(after[i][1], before[i][1], `volume at third ${i}`);
  }
});

test('a coincident pair at the note’s start keeps both pitches', () => {
  // The other half: a pair at position 0 writes both its samples onto the
  // note-on's own tick, where they are skipped, so that one collapses on the
  // way out and is rebuilt from the opening bend on the way in.
  const seq = makeSequencer([
    makeTrack([[{ step: 0, pitch: 17 }, { step: 0, pitch: 16 }, { step: 4, pitch: 16 }]]),
  ]);
  const { sequencer } = midiToSequencer(sequencerToMidi(seq).bytes);
  const points = sequencer.tracks[0].notes[0].points;
  assert.equal(points[0].pitch, 17, 'the key that was struck');
  assert.equal(points[1].pitch, 16, 'and where it went in the same instant');
});

test('a ramp that ends where another note starts keeps its last value', () => {
  // ⚠️ Both halves of one trap, on one channel. The exporter writes every
  // note's opening modulation immediately before its note-on, so a newcomer's
  // CC 74 must not join the ramp of whoever owns the channel — but it is the
  // LAST CC 74 before the note-on that belongs to the newcomer, not every one
  // at that tick. Excluding the whole tick threw away the owner's own final
  // sample whenever a note happened to start on the instant its ramp ended:
  // three notes in `Orb` and `Blackfire` stopped one step short.
  const on = (tick: number, ch: number, note: number, vel: number) =>
    ({ tick, data: Uint8Array.of(0x90 | ch, note, vel) });
  const off = (tick: number, ch: number, note: number) =>
    ({ tick, data: Uint8Array.of(0x80 | ch, note, 64) });
  const cc = (tick: number, ch: number, n: number, v: number) =>
    ({ tick, data: Uint8Array.of(0xb0 | ch, n, v) });

  const bytes = writeMidi({
    format: 1,
    division: 480,
    tracks: [{
      events: [
        // An MPE zone, so the reader routes by channel owner.
        cc(0, 0, 101, 0), cc(0, 0, 100, 6), cc(0, 0, 6, 15),
        cc(0, 1, 74, 127), on(0, 1, 60, 100),
        cc(480, 1, 74, 20),      // the owner's ramp, arriving
        cc(480, 1, 74, 127),     // and the newcomer's own opening, right behind
        on(480, 1, 64, 100),
        off(720, 1, 64),
        off(960, 1, 60),
      ],
    }],
  });

  const { sequencer } = midiToSequencer(bytes);
  const notes = schedule(sequencer).sort((a, b) => a.pitch - b.pitch);
  const owner = notes.find((n) => n.pitch === 60);
  const newcomer = notes.find((n) => n.pitch === 64);
  assert.ok(owner && newcomer);

  // 20/127 lands on nibble 2; the ramp has to arrive there rather than stop short.
  assert.equal(Math.round(owner.points[0].modulation * 15), 15, 'the owner opens full');
  assert.equal(
    Math.round(owner.points[owner.points.length - 1].modulation * 15),
    2,
    `the owner's ramp arrives: ${JSON.stringify(owner.points.map((p) => Math.round(p.modulation * 15)))}`,
  );
  // And the newcomer keeps its own, rather than inheriting the ramp it landed on.
  assert.equal(Math.round(newcomer.modulation * 15), 15, 'the newcomer keeps its own');
});
