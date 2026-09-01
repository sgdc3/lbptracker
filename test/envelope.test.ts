import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  ADSR_PARAMS,
  ENVELOPE_SECONDS_PER_UNIT,
  Envelope,
  evaluateAdsr,
  evaluateParam,
} from '../src/core/envelope.ts';
import { readInstrument } from '../src/core/rinstrument.ts';
import { loadResourceFile } from '../src/platform/node.ts';
import { MAX_SCALE, SCALE_TABLES, notePitch, quantise } from '../src/core/scale.ts';

const RINST = process.env.LBP_RINST ?? 'fixtures/rinst';

// --------------------------------------------------------------- param ranges

test('a param pair is a range the note picks a point inside', () => {
  const p = { x: 0.2, y: 0.8 };
  assert.equal(evaluateParam(p, 0), 0.2);
  assert.equal(evaluateParam(p, 1), 0.8);
  assert.ok(Math.abs(evaluateParam(p, 0.5) - 0.5) < 1e-9);
  // Where x === y the modulation does nothing, which is most of the corpus.
  assert.equal(evaluateParam({ x: 0.35, y: 0.35 }, 0.73), 0.35);
});

test('times are the parameter squared, the sustain is a level', () => {
  const params = Array.from({ length: 27 }, () => ({ x: 0, y: 0 }));
  params[ADSR_PARAMS.attack] = { x: 0.5, y: 0.5 };
  params[ADSR_PARAMS.decay] = { x: 0.25, y: 0.25 };
  params[ADSR_PARAMS.sustain] = { x: 0.6, y: 0.6 };
  params[ADSR_PARAMS.release] = { x: 0.1, y: 0.1 };
  const adsr = evaluateAdsr(params, ADSR_PARAMS, 0);
  assert.ok(Math.abs(adsr.attack - 0.25 * ENVELOPE_SECONDS_PER_UNIT) < 1e-9);
  assert.ok(Math.abs(adsr.decay - 0.0625 * ENVELOPE_SECONDS_PER_UNIT) < 1e-9);
  assert.ok(Math.abs(adsr.release - 0.01 * ENVELOPE_SECONDS_PER_UNIT) < 1e-9);
  assert.equal(adsr.sustain, 0.6, 'the sustain is not a time and is not squared');
});

// -------------------------------------------------------------- the generator

const run = (adsr: ReturnType<typeof evaluateAdsr>, steps: [number, boolean][]) => {
  const env = new Envelope();
  return steps.map(([dt, gate]) => env.advance(dt, gate, adsr));
};

test('a held note rises over the attack and settles on the sustain', () => {
  const adsr = { attack: 1, decay: 1, sustain: 0.5, release: 1 };
  const out = run(adsr, [
    [0.25, true],
    [0.25, true],
    [0.25, true],
    [0.25, true], // attack completes exactly here
    [0.25, true],
    [0.25, true],
  ]);
  assert.ok(Math.abs(out[0] - 0.25) < 1e-9, 'linear rise, not a curve');
  assert.ok(Math.abs(out[1] - 0.5) < 1e-9);
  assert.ok(Math.abs(out[3] - 1) < 1e-9, 'full level at the end of the attack');
  assert.ok(Math.abs(out[4] - 0.75) < 1e-9, 'then decays linearly');
  assert.ok(Math.abs(out[5] - 0.5) < 1e-9, 'and stops at the sustain');
  // It must stay there rather than keep falling.
  const env = new Envelope();
  for (let i = 0; i < 40; i += 1) env.advance(0.25, true, adsr);
  assert.ok(Math.abs(env.level - 0.5) < 1e-9, 'the sustain holds');
});

test('the attack spends its leftover time on the decay, not on nothing', () => {
  // Attack needs 0.1 s; the step is 0.5 s, so 0.4 s must go into the decay.
  const adsr = { attack: 0.1, decay: 1, sustain: 0, release: 1 };
  const env = new Envelope();
  const level = env.advance(0.5, true, adsr);
  assert.ok(
    Math.abs(level - 0.6) < 1e-9,
    `expected 1 - 0.4/1 = 0.6, got ${level} — the handover dropped the remainder`,
  );
});

test('a zero attack starts at full level', () => {
  const adsr = { attack: 0, decay: 1, sustain: 0.25, release: 1 };
  const env = new Envelope();
  // A tiny step: the attack is instant, so almost all of it is already decay.
  const level = env.advance(1e-6, true, adsr);
  assert.ok(level > 0.999, `struck instruments start loud, got ${level}`);
});

test('a zero decay drops straight to the sustain', () => {
  const env = new Envelope();
  const level = env.advance(0.01, true, { attack: 0, decay: 0, sustain: 0.3, release: 1 });
  assert.ok(Math.abs(level - 0.3) < 1e-9);
});

test('releasing falls from wherever the level was, and ends the voice', () => {
  const adsr = { attack: 0, decay: 4, sustain: 1, release: 0.5 };
  const env = new Envelope();
  env.advance(0.001, true, adsr); // up to full
  assert.ok(!env.finished);
  assert.ok(Math.abs(env.advance(0.25, false, adsr) - 0.5) < 1e-3);
  assert.ok(!env.finished, 'still sounding halfway through the release');
  env.advance(0.3, false, adsr);
  assert.equal(env.level, 0);
  assert.ok(env.finished, 'a released envelope that reaches zero frees the voice');
});

test('a zero release cuts immediately rather than hanging', () => {
  const env = new Envelope();
  env.advance(0.001, true, { attack: 0, decay: 1, sustain: 1, release: 0 });
  assert.equal(env.advance(0.01, false, { attack: 0, decay: 1, sustain: 1, release: 0 }), 0);
  assert.ok(env.finished);
});

// ------------------------------------------------------- against the real set

test('the shipped instruments give musically sensible envelopes', async (t) => {
  if (!existsSync(RINST)) {
    t.skip(`no ${RINST} (extract with tools/ExtractGuid.java, or set LBP_RINST)`);
    return;
  }
  const files = (await readdir(RINST)).filter((f) => f.endsWith('.rinst'));
  if (files.length === 0) {
    t.skip(`no .rinst files in ${RINST}`);
    return;
  }
  const load = async (name: string) =>
    evaluateAdsr(
      readInstrument((await loadResourceFile(path.join(RINST, `${name}.rinst`))).data).params,
      ADSR_PARAMS,
      0,
    );

  // Struck instruments hold nothing; blown and bowed ones hold everything.
  // These are facts about the instruments, so they are a real check on the
  // index assignment rather than a restatement of the data.
  for (const name of ['glockenspiel', 'marimba', 'vibraphone', 'harp', 'musicbox']) {
    if (!existsSync(path.join(RINST, `${name}.rinst`))) continue;
    const a = await load(name);
    assert.equal(a.sustain, 0, `${name} should not sustain`);
    assert.ok(a.decay > 0.5, `${name} should have a real decay, got ${a.decay}s`);
    assert.equal(a.attack, 0, `${name} is struck, so it has no attack`);
  }
  for (const name of ['choir', 'brass', 'clarinet', 'strings_ensemble']) {
    if (!existsSync(path.join(RINST, `${name}.rinst`))) continue;
    const a = await load(name);
    assert.equal(a.sustain, 1, `${name} should sustain fully`);
  }
  if (existsSync(path.join(RINST, 'piano.rinst'))) {
    const a = await load('piano');
    assert.ok(a.sustain > 0 && a.sustain < 0.2, `a piano holds a little, got ${a.sustain}`);
    assert.ok(a.decay > 0.5 && a.decay < 3, `piano decay ${a.decay}s`);
    console.log(
      `    piano — attack ${a.attack.toFixed(3)}s decay ${a.decay.toFixed(3)}s ` +
        `sustain ${a.sustain.toFixed(3)} release ${a.release.toFixed(3)}s`,
    );
  }
});

// ------------------------------------------------------------------ the scale

test('every scale table lands on a tone of its own scale, within two semitones', () => {
  // ⚠️ NOT "always downward" -- that was the first guess and the blues table
  // disproves it: position 2 goes UP to 3, because blues has no tone at 1 or 2.
  // Ties are not consistent either (position 4 goes up to 5, position 11 down
  // to 10), so the tables are the fact here and no rule is claimed.
  for (let s = 0; s <= MAX_SCALE; s += 1) {
    const tones = new Set(SCALE_TABLES[s]);
    for (let n = 0; n < 12; n += 1) {
      const q = SCALE_TABLES[s][n];
      assert.ok(q >= 0 && q <= 11, `scale ${s} entry ${n} out of range`);
      assert.ok(tones.has(q), `scale ${s} sent ${n} to ${q}, not a tone of the scale`);
      assert.ok(Math.abs(q - n) <= 2, `scale ${s} moved ${n} to ${q}, too far`);
    }
  }
  // ⚠️ These ids were wrong once, off by a row, because the table's address was
  // computed from the segment mapping instead of read from its relocation. Six
  // rows, and the first is the identity.
  assert.equal(SCALE_TABLES.length, 6);
  assert.deepEqual([...SCALE_TABLES[0]], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const tones = (s: number) => [...new Set(SCALE_TABLES[s])].sort((a, b) => a - b);
  assert.deepEqual(tones(1), [0, 2, 4, 5, 7, 9, 11], 'major');
  assert.deepEqual(tones(2), [0, 2, 3, 5, 7, 8, 10], 'natural minor');
  assert.deepEqual(tones(3), [0, 3, 5, 7, 10], 'minor pentatonic');
  assert.deepEqual(tones(4), [0, 3, 5, 6, 7, 10], 'blues');
  assert.deepEqual(tones(5), [0, 2, 4, 6, 7, 9, 11], 'lydian');
});

test('quantise preserves the octave and passes unknown scales through', () => {
  // C4 = 60. Scale 1 is major: C#4 (61) snaps to C4, F#4 (66) to F4.
  assert.equal(quantise(60, 1), 60);
  assert.equal(quantise(61, 1), 60);
  assert.equal(quantise(66, 1), 65, 'F#4 snaps to F4 in major');
  assert.equal(quantise(72, 1), 72, 'the octave above is untouched');
  assert.equal(quantise(73, 3), 72, 'pentatonic snaps C#5 to C5');
  // Lydian is major with the fourth raised, so it keeps F# and moves F.
  assert.equal(quantise(66, 5), 66, 'lydian keeps F#4');
  assert.equal(quantise(65, 5), 64, 'and pulls F4 down to E4');
  assert.equal(quantise(65, 1), 65, 'which major does not');
  // ⚠️ Out of range is chromatic, not an error -- the engine's own guard.
  assert.equal(quantise(61, 0), 61);
  assert.equal(quantise(61, 99), 61);
  assert.equal(quantise(61, -3), 61);
});

test('notePitch applies the root and the engine’s -12', () => {
  assert.equal(notePitch(60, 0, 12), 60, 'scale 0 leaves the note alone');
  assert.equal(notePitch(61, 1, 12), 60, 'quantised first, then offset');
  assert.equal(notePitch(60, 0, 0), 48);
});

// ------------------------------------------------------ through the mixer

test('a voice with an envelope outlives its endFrame and dies on its own', async () => {
  const { Mixer } = await import('../src/audio/mixer.ts');
  const rate = 48000;
  const data = new Float32Array(rate).fill(1); // DC, so the output IS the envelope
  const mixer = new Mixer(rate);
  mixer.play({
    sample: { channels: [data], sampleRate: rate, loop: { start: 0, end: rate - 1 } },
    playbackRate: 1,
    gain: 1,
    pan: 0.5,
    endFrame: Math.round(0.1 * rate), // the gate closes at 100 ms
    envelope: { attack: 0, decay: 10, sustain: 1, release: 0.2 },
  });

  const left = new Float32Array(Math.round(0.09 * rate));
  const right = new Float32Array(left.length);
  mixer.render(left, right);
  const gain = 0.5; // centre pan, and the law is linear
  assert.ok(left[10] / gain > 0.99, 'full level while the note is held');
  assert.equal(mixer.voiceCount, 1);

  // Past the end frame the release runs -- the old code returned silence here.
  mixer.render(left, right);
  assert.ok(left[left.length - 1] / gain > 0, 'still sounding into the release');
  assert.ok(left[left.length - 1] < left[0], 'and falling');
  assert.equal(mixer.voiceCount, 1, 'the voice is not dropped mid-release');

  // 0.2 s of release from the gate: it must be gone well before another 0.3 s.
  for (let i = 0; i < 4; i += 1) mixer.render(left, right);
  assert.equal(mixer.voiceCount, 0, 'the release ends the voice by itself');
});

test('a looping sample without an envelope still stops at its end frame', async () => {
  const { Mixer } = await import('../src/audio/mixer.ts');
  const rate = 48000;
  const mixer = new Mixer(rate);
  mixer.play({
    sample: {
      channels: [new Float32Array(rate).fill(1)],
      sampleRate: rate,
      // The loop is what makes this a sustained voice rather than a one-shot.
      loop: { start: 0, end: rate },
    },
    playbackRate: 1,
    gain: 1,
    pan: 0.5,
    endFrame: 100,
  });
  const left = new Float32Array(200);
  mixer.render(left, new Float32Array(200));
  assert.ok(left[99] !== 0, 'sounding up to the end frame');
  assert.equal(left[150], 0, 'and hard-stopped after it, as before');
});

test('a sample with no loop is a one-shot and outlives its note', async () => {
  const { Mixer } = await import('../src/audio/mixer.ts');
  const rate = 48000;
  const mixer = new Mixer(rate);
  // 300 frames of sample against a 100-frame note: percussion's whole shape.
  mixer.play({
    sample: { channels: [new Float32Array(300).fill(1)], sampleRate: rate },
    playbackRate: 1,
    gain: 1,
    pan: 0.5,
    endFrame: 100,
  });
  const left = new Float32Array(400);
  mixer.render(left, new Float32Array(400));
  assert.ok(left[99] !== 0, 'sounding during the note');
  assert.ok(left[150] !== 0, 'and still sounding after it -- this is the change');
  assert.ok(left[299] !== 0, 'right up to the last sample frame');
  assert.equal(left[320], 0, 'then it ends, because the sample does');
});

// --------------------------------------------------------- the whole block

test('all 27 Params are named, once each, and the sections agree', async () => {
  const { LFO_PARAMS, OUTPUT_PARAMS, PARAM_NAMES, STACK_PARAMS } = await import(
    '../src/core/params.ts'
  );
  const { FILTER_PARAMS } = await import('../src/audio/moog.ts');
  const { ADSR_PARAMS_B } = await import('../src/core/envelope.ts');

  assert.equal(PARAM_NAMES.length, 27, 'the block is 27 pairs');

  // Every index claimed exactly once, by exactly one section.
  const claimed = [
    ...Object.values(STACK_PARAMS),
    ...Object.values(FILTER_PARAMS),
    ...Object.values(ADSR_PARAMS_B),
    ...Object.values(ADSR_PARAMS),
    ...LFO_PARAMS.flatMap((l) => [l.rate, l.depth, l.spread]),
    ...Object.values(OUTPUT_PARAMS),
  ].sort((a, b) => a - b);
  assert.deepEqual(claimed, [...Array(27).keys()], 'no gaps and no index twice');

  // The LFO triples are contiguous and in (rate, depth, spread) order -- the
  // stride-3 layout is what made them recognisable in the first place.
  LFO_PARAMS.forEach((lfo, i) => {
    assert.equal(lfo.rate, 15 + i * 3);
    assert.equal(lfo.depth, 16 + i * 3);
    assert.equal(lfo.spread, 17 + i * 3);
  });
  assert.deepEqual(LFO_PARAMS.map((l) => l.rateScale), [100, 100, 50]);
});

test('the corpus behaves the way the naming says it should', async (t) => {
  if (!existsSync(RINST)) {
    t.skip(`no ${RINST}`);
    return;
  }
  const files = (await readdir(RINST)).filter((f) => f.endsWith('.rinst'));
  if (files.length === 0) {
    t.skip(`no .rinst files in ${RINST}`);
    return;
  }
  const { LFO_PARAMS, OUTPUT_PARAMS } = await import('../src/core/params.ts');
  const all: ReturnType<typeof readInstrument>[] = [];
  for (const name of files) {
    all.push(readInstrument((await loadResourceFile(path.join(RINST, name))).data));
  }
  const zeros = (i: number) => all.filter((p) => p.params[i].x === 0).length;

  // A depth of zero switches an LFO off, so most instruments must sit at zero
  // -- while the rates are set regardless. If these ever invert, the rate and
  // depth of a triple have been swapped.
  for (const lfo of LFO_PARAMS) {
    assert.ok(zeros(lfo.depth) > all.length * 0.8, `LFO depth ${lfo.depth} should mostly be off`);
    assert.ok(zeros(lfo.rate) < all.length * 0.2, `LFO rate ${lfo.rate} should mostly be set`);
    assert.ok(zeros(lfo.spread) > all.length * 0.8, `spread ${lfo.spread} is for stacked voices`);
  }

  // A level is the one parameter every instrument must set, and set differently.
  assert.equal(zeros(OUTPUT_PARAMS.level), 0, 'every instrument sets its level');
  const distinct = new Set(all.map((p) => p.params[OUTPUT_PARAMS.level].x)).size;
  assert.ok(distinct > all.length * 0.8, `only ${distinct} distinct levels across ${all.length}`);

  // Drive is a guitar pedal: almost nothing uses it, and what does is electric.
  assert.ok(zeros(OUTPUT_PARAMS.drive) > all.length * 0.9, 'drive is rare');
  console.log(
    `    zeros — LFO depths ${LFO_PARAMS.map((l) => zeros(l.depth)).join('/')}, ` +
      `level ${zeros(OUTPUT_PARAMS.level)}, send ${zeros(OUTPUT_PARAMS.send)}, ` +
      `drive ${zeros(OUTPUT_PARAMS.drive)} of ${all.length}`,
  );
});

test('a single-layer voice starts at the beginning of its sample', async () => {
  const { Mixer } = await import('../src/audio/mixer.ts');
  const rate = 48000;
  const mixer = new Mixer(rate);
  // A ramp, so where playback started is readable from the first output frame.
  const ramp = new Float32Array(1000);
  for (let i = 0; i < ramp.length; i += 1) ramp[i] = i / ramp.length;
  mixer.play({
    sample: { channels: [ramp], sampleRate: rate },
    playbackRate: 1,
    gain: 1,
    pan: 0.5,
    endFrame: 1000,
  });
  const left = new Float32Array(16);
  mixer.render(left, new Float32Array(16));
  assert.ok(left[0] < 0.01, `started ${(left[0] * 2 * ramp.length) | 0} frames in, not 0`);

  // ⚠️ The regression this guards. `Params[2]` is a per-layer random start, and
  // applying it to every voice destroyed every instrument with Numstack 1:
  // a_kit_1 sets it to 1.000, so each drum hit began at a uniformly random
  // point in its own sample -- on average half a kick, no transient, and a
  // click at the discontinuity. Isolated, the kit rendered at RMS 0.0186 and
  // peak 0.211; with the offset confined to layers after the first, 0.0711 and
  // 0.646 -- 11.6 dB of a drum kit.
  const withOffset = new Mixer(rate);
  withOffset.play({
    sample: { channels: [ramp], sampleRate: rate },
    playbackRate: 1,
    gain: 1,
    pan: 0.5,
    endFrame: 1000,
    startPosition: 500,
  });
  const shifted = new Float32Array(16);
  withOffset.render(shifted, new Float32Array(16));
  assert.ok(shifted[0] > 0.2, 'an explicit startPosition is still honoured');
});
