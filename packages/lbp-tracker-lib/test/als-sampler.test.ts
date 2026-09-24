import { strict as assert } from 'node:assert';
import test from 'node:test';

import { DEFAULT_CHIP_COLOUR } from '@lbptracker/cwlib/chips.ts';
import { readNotes, NOTE_RECORD_SIZE } from '@lbptracker/cwlib/notes.ts';
import type { Sequencer, Track } from '@lbptracker/cwlib/project.ts';
import { alsProjectFiles, sequencerToAls } from '../src/als.ts';
import { Ids } from '../src/als-xml.ts';
import { samplerDevice, samplerSampleFile, samplerZones, type SamplerSample } from '../src/als-sampler.ts';
import type { SampleSlot } from '../src/instrument.ts';
import type { RInstrument } from '../src/rinstrument.ts';

/* ---------------------------------------------------------------- fixtures */

/** A `.smp` as the game ships one: RIFF, 16-bit PCM, its own rate, an optional `smpl` loop. */
function smp(frames: number, rate: number, loop?: [number, number]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const chunk = (id: string, body: Uint8Array) => {
    const out = new Uint8Array(8 + body.length + (body.length & 1));
    const view = new DataView(out.buffer);
    for (let i = 0; i < 4; i += 1) out[i] = id.charCodeAt(i);
    view.setUint32(4, body.length, true);
    out.set(body, 8);
    chunks.push(out);
  };
  const fmt = new DataView(new ArrayBuffer(16));
  fmt.setUint16(0, 1, true); fmt.setUint16(2, 1, true); fmt.setUint32(4, rate, true);
  fmt.setUint32(8, rate * 2, true); fmt.setUint16(12, 2, true); fmt.setUint16(14, 16, true);
  chunk('fmt ', new Uint8Array(fmt.buffer));
  const data = new DataView(new ArrayBuffer(frames * 2));
  for (let i = 0; i < frames; i += 1) data.setInt16(i * 2, (i * 37) % 2000 - 1000, true);
  chunk('data', new Uint8Array(data.buffer));
  if (loop) {
    const s = new DataView(new ArrayBuffer(36 + 24));
    s.setUint32(28, 1, true);
    s.setUint32(36 + 8, loop[0], true);
    s.setUint32(36 + 12, loop[1], true);
    chunk('smpl', new Uint8Array(s.buffer));
  }
  const body = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + body);
  const view = new DataView(out.buffer);
  out.set([82, 73, 70, 70], 0);
  view.setUint32(4, 4 + body, true);
  out.set([87, 65, 86, 69], 8);
  let at = 12;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const slot = (over: Partial<SampleSlot> = {}): SampleSlot =>
  ({ baseNote: 60, baseBpm: 120, fineTune: 0, pitched: true, fitBpm: false, ...over });

/** An instrument with every `Params` range flat at `x = y = value`, bar those given. */
function instrument(
  slots: SampleSlot[],
  splits: number[],
  params: Record<number, number | { x: number; y: number }> = {},
): RInstrument {
  return {
    slots,
    sampleGuids: slots.map((_, i) => 100 + i),
    splitNotes: [...splits, ...Array(9 - splits.length).fill(0)],
    numStack: 1,
    params: Array.from({ length: 27 }, (_, i) => {
      const p = params[i] ?? 0;
      return typeof p === 'number' ? { x: p, y: p } : p;
    }),
    arpeggio: [],
    arpeggiate: false,
  };
}

const sample = (file: string, frames = 1000, loop?: { start: number; end: number }): SamplerSample =>
  ({ file, frames, loop, wav: new Uint8Array(44 + frames * 2) });

/** A device member's value, found by the dotted path of the tags down to it. */
function valueAt(xml: string, path: string): number {
  let rest = xml;
  for (const part of path.split('.')) {
    const k = rest.search(new RegExp(`<${part}[ >]`));
    assert.ok(k >= 0, `no ${part} in ${path}`);
    rest = rest.slice(k);
  }
  return Number(/<Manual Value="([^"]*)"/.exec(rest)?.[1] ?? /Value="([^"]*)"/.exec(rest)?.[1]);
}

/* ---------------------------------------------------------------- tests */

test('an .smp becomes a WAV with the same frames under a 48 kHz header, and the engine\'s loop', () => {
  const bytes = smp(500, 44100, [100, 399]);
  const s = samplerSampleFile('piano_c4.smp', bytes);
  assert.equal(s.file, 'piano_c4.wav');
  assert.equal(s.frames, 500);
  // ❗ The game never reads the rate: a frame is a frame at 48 kHz.
  const view = new DataView(s.wav.buffer, s.wav.byteOffset);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(40, true), 1000);
  // The frames verbatim: the `data` chunk of the source, byte for byte.
  const source = bytes.subarray(12 + 8 + 16 + 8, 12 + 8 + 16 + 8 + 1000);
  assert.deepEqual([...s.wav.subarray(44)], [...source]);
  // The loader's region, `[dwStart, dwEnd + 1)`.
  assert.deepEqual(s.loop, { start: 100, end: 400 });
  assert.equal(samplerSampleFile('x.smp', smp(10, 48000)).loop, undefined);
});

test('the zones are the engine\'s walk run backwards, moved by the track\'s Key', () => {
  const inst = instrument([slot({ baseNote: 72 }), slot({ baseNote: 60 }), slot({ baseNote: 48 })], [87, 66, 54]);
  const files = new Map([[100, sample('a.wav')], [101, sample('b.wav')], [102, sample('c.wav')]]);
  const zones = samplerZones(inst, (g) => files.get(g), 0, 120);
  // A bound belongs to the zone above it: 66 is the top zone's, 54 the middle's.
  assert.deepEqual(zones.map((z) => [z.sample.file, z.lo, z.hi, z.root]), [
    ['a.wav', 66, 127, 72], ['b.wav', 54, 65, 60], ['c.wav', 0, 53, 48],
  ]);
  // Key 14 transposes by 2: the engine picks the zone off the raw note, Live off the key it gets.
  const moved = samplerZones(inst, (g) => files.get(g), 2, 120);
  assert.deepEqual(moved.map((z) => [z.lo, z.hi, z.root]), [[68, 127, 72], [56, 67, 60], [2, 55, 48]]);
});

test('fine tune and fitBpm go into the root and the cents; an unpitched slot is a zone per key', () => {
  const tuned = samplerZones(instrument([slot({ fineTune: 0.3 })], [87]), () => sample('a.wav'), 0, 120)[0];
  assert.deepEqual([tuned.root, Math.round(tuned.detune)], [60, 30]);
  const sharp = samplerZones(instrument([slot({ fineTune: 0.7 })], [87]), () => sample('a.wav'), 0, 120)[0];
  // 0.7 of a semitone up is a root one lower and 30 cents down.
  assert.deepEqual([sharp.root, Math.round(sharp.detune)], [59, -30]);
  // At twice its tempo a synced slot plays an octave up.
  const synced = samplerZones(instrument([slot({ fitBpm: true, baseBpm: 60 })], [87]), () => sample('a.wav'), 0, 120)[0];
  assert.deepEqual([synced.root, Math.round(synced.detune)], [48, 0]);
  const drum = samplerZones(instrument([slot({ pitched: false }), slot()], [87, 126]), () => sample('k.wav'), 0, 120);
  // 126 and 127 play the unpitched slot, each at its own root; the rest is one zone.
  assert.deepEqual(drum.map((z) => [z.lo, z.hi, z.root]), [[126, 126, 126], [127, 127, 127], [0, 125, 60]]);
});

test('the Sampler: 32 voices, no retrigger, the level, the envelopes and the filter from the engine\'s terms', () => {
  const inst = instrument([slot()], [87], {
    3: 0.5, 4: 0.25, 5: 1, 6: 0.75, // cutoff 0.25 of Nyquist, envelope amount 0.75
    11: 0.5, 12: 0.5, 13: 0.5, 14: 1, // attack 1 s, decay 1 s, sustain 0.5, release 4 s
    24: 0.25, // output level: 2 x 0.25 = 0.5, -6 dB
  });
  const xml = samplerDevice(new Ids(), inst, () => sample('a.wav', 1000, { start: 10, end: 900 }),
    { modulation: 0, keyShift: 0, tempo: 120, name: 'saw_wave' });
  const at = (path: string) => valueAt(xml, path);
  assert.match(xml, /<NumVoices Value="14" \/>/);
  assert.match(xml, /<RetriggerMode Value="false" \/>/);
  assert.ok(Math.abs(at('VolumeAndPan.Volume') - 20 * Math.log10(0.5)) < 1e-6);
  assert.equal(at('VolumeAndPan.Envelope.AttackTime'), 1000);
  // The decay falls 1 → 0.5 at one unit a second; the release from the sustain.
  assert.equal(at('VolumeAndPan.Envelope.DecayTime'), 500);
  assert.equal(at('VolumeAndPan.Envelope.SustainLevel'), 0.5);
  assert.equal(at('VolumeAndPan.Envelope.ReleaseTime'), 2000);
  // Resting at cutoff x (1 - amount), the envelope's full swing as semitones.
  assert.ok(Math.abs(at('SimplerFilter.Freq') - 0.25 * 0.25 * 24000) < 1e-6);
  assert.ok(Math.abs(at('SimplerFilter.Envelope.Amount') - 12 * Math.log2(4)) < 1e-6);
  assert.equal(at('SimplerFilter.Res'), 0.25);
  assert.equal(at('SimplerFilter.ModByPitch'), 1);
  // The zone: the loop as the loader reads it, forward, and the project-relative file.
  assert.match(xml, /<SustainLoop>\n<Start Value="10" \/>\n<End Value="900" \/>\n<Mode Value="1" \/>/);
  assert.match(xml, /<RelativePathType Value="3" \/>\n<RelativePath Value="Samples\/Imported\/a.wav" \/>/);
  // Pressure (`MidiCtrl.0`) to Volume (18).
  assert.match(xml, /<MidiCtrl\.0>\n<ModConnections\.0>\n<Amount Value="100" \/>\n<Connection Value="18" \/>/);
});

test('past Live\'s 72 semitones the filter envelope keeps its peak, and the rest rises', () => {
  // Envelope amount 1, as concertina has it: the engine goes from 0 to the whole cutoff.
  const xml = samplerDevice(new Ids(), instrument([slot()], [87], { 3: 0.5, 6: 1 }), () => sample('a.wav'),
    { modulation: 0, keyShift: 0, tempo: 120, name: 'concertina' });
  assert.equal(valueAt(xml, 'SimplerFilter.Envelope.Amount'), 72);
  // The peak is 0.25 of Nyquist, as the engine's; the rest is 72 semitones under it.
  assert.ok(Math.abs(valueAt(xml, 'SimplerFilter.Freq') - 0.25 * 24000 / 64) < 1e-6);
});

test('with instruments the set gets a Sampler per track, its samples and the project around them', () => {
  const bytes = new Uint8Array(3 * NOTE_RECORD_SIZE);
  // One flat note, and one whose volume moves -- which hands its volume to the pressure.
  bytes.set([0, 60 | 0x80, 96, 0], 0);
  bytes.set([4, 62, 30, 15], 4);
  bytes.set([8, 62 | 0x80, 90, 15], 8);
  const grouped = readNotes(bytes);
  const track: Track = {
    guid: 7, name: '', colour: DEFAULT_CHIP_COLOUR, gridX: 0, gridY: 0, stepOffset: 0,
    level: 1, pan: 0.5, echoSend: 0, reverbSend: 0, key: 0, scale: 0,
    notes: grouped.notes, records: bytes, trailingRecords: 0,
  };
  const seq: Sequencer = {
    uid: 1, name: 'Song (1)', author: '', tempo: 120, swing: 0, echoFeedback: 0, echoTime: 1, echoMix: 0.5,
    reverb: 0, loop: false, startPoint: 0, numChannels: 1, volumes: [1, 1, 1, 1, 1, 1], boardRows: 0,
    tracks: [track], lengthSteps: 9,
  };
  const inst = instrument([slot()], [87]);
  const instruments = new Map([[7, { instrument: inst, samples: new Map([[100, { name: 'tone.smp', bytes: smp(64, 48000) }]]) }]]);
  const plain = sequencerToAls(seq);
  assert.equal(plain.samples.length, 0);
  assert.doesNotMatch(plain.xml, /<MultiSampler/);

  const r = sequencerToAls(seq, { instruments });
  assert.equal(r.instrumentTracks, 1);
  assert.deepEqual(r.samples.map((s) => s.file), ['tone.wav']);
  assert.equal((r.xml.match(/<MultiSampler Id="0">/g) ?? []).length, 1);
  // Half the notes are at modulation 0 and half at 1: the tie goes to the first seen.
  assert.equal(r.offModulation, 1);
  // Every note's level rides on the pressure, the flat note's as one point: a
  // note with none is silent through the Pressure row at 100.
  const velocities = [...r.xml.matchAll(/<MidiNoteEvent [^>]* Velocity="(\d+)" VelocityDeviation/g)].map((m) => Number(m[1]));
  assert.deepEqual(velocities, [127, 127]);
  const pressures = [...r.xml.matchAll(/<PerNoteEventList [^>]*CC="-1">\n<Events>\n([\s\S]*?)<\/Events>/g)]
    .map((m) => [...m[1].matchAll(/TimeOffset="([^"]+)" Value="([^"]+)"/g)].map((p) => [Number(p[1]), Number(p[2])]));
  assert.deepEqual(pressures, [[[0, 96]], [[0, 30], [1, 90]]]);
  // Without the Sampler only the ramp is on the pressure, and the flat note's level is its velocity.
  assert.equal((plain.xml.match(/CC="-1"/g) ?? []).length, 1);
  assert.match(plain.xml, /Velocity="96"/);

  const files = alsProjectFiles(seq.name, new Uint8Array([1]), r.samples).map((f) => f.name);
  assert.deepEqual(files, [
    'Song _1_ Project/Song _1_.als',
    'Song _1_ Project/Ableton Project Info/',
    'Song _1_ Project/Samples/Imported/tone.wav',
  ]);
});
