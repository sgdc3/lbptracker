import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  cubic,
  DEFAULT_INTERPOLATOR,
  INTERPOLATORS,
  linear,
  nearest,
  sinc8,
} from '../src/audio/interpolate.ts';
import { Mixer, type SampleBuffer } from '../src/audio/mixer.ts';
import {
  DEFAULT_SLOT,
  resolveSlot,
  type Instrument,
  type SampleSlot,
} from '../src/core/instrument.ts';
import {
  panGains,
  pitchRatio,
  samplesPerStep,
  velocityGain,
  voiceFor,
} from '../src/core/voice.ts';

const slot = (over: Partial<SampleSlot> = {}): SampleSlot => ({
  ...DEFAULT_SLOT,
  ...over,
});

const instrument = (over: Partial<Instrument> = {}): Instrument => ({
  slots: [slot()],
  splitNotes: [0, 127, 0, 0, 0, 0, 0, 0, 0],
  numStack: 1,
  arpeggiate: false,
  arpeggio: [],
  ...over,
});

// ---------------------------------------------------------------- interpolation

test('linear interpolation hits the midpoint of a ramp', () => {
  const data = Float32Array.from([0, 1, 2, 3]);
  assert.equal(linear(data, 0), 0);
  assert.equal(linear(data, 1.5), 1.5);
  assert.equal(linear(data, 2.25), 2.25);
});

test('every interpolator is exact on integer positions', () => {
  const data = Float32Array.from([0.5, -0.25, 0.75, -1]);
  for (const interp of [nearest, linear, cubic]) {
    for (let i = 0; i < data.length; i += 1) {
      assert.ok(
        Math.abs(interp(data, i) - data[i]) < 1e-6,
        `${interp.name} at ${i}`,
      );
    }
  }
});

test('interpolators read silence outside the buffer instead of crashing', () => {
  const data = Float32Array.from([1, 1, 1]);
  for (const interp of [nearest, linear, cubic]) {
    assert.equal(interp(data, -5), 0, `${interp.name} before the start`);
    assert.equal(interp(data, 99), 0, `${interp.name} past the end`);
  }
});

test('cubic reproduces a straight line exactly', () => {
  // Catmull-Rom is interpolating and linear-exact; if it is not, the
  // coefficients are wrong.
  const data = Float32Array.from([0, 1, 2, 3, 4, 5]);
  for (const p of [2.0, 2.25, 2.5, 2.75, 3.0]) {
    assert.ok(Math.abs(cubic(data, p) - p) < 1e-5, `cubic at ${p}`);
  }
});

test('resampling SNR: the reason linear is not the default', () => {
  // Resample a 22050 Hz source to 44100 (playbackRate 0.5) and compare against
  // the analytic sine. This is exactly what a piano sample does, and it is how
  // the first listening test's "extreme distortion" was diagnosed: linear
  // interpolation gives a 16% amplitude error at 4 kHz, where a piano attack
  // has plenty of energy.
  const SRC = 22050;
  const OUT = 44100;

  const snrAt = (freq: number, interp: typeof linear): number => {
    const src = new Float32Array(SRC);
    for (let i = 0; i < src.length; i += 1) {
      src[i] = Math.sin((2 * Math.PI * freq * i) / SRC) * 0.8;
    }
    const mixer = new Mixer(OUT, interp);
    mixer.play({
      sample: { channels: [src], sampleRate: SRC },
      playbackRate: 0.5,
      gain: 1,
      pan: 0.5,
    });
    const n = 16384;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    mixer.render(left, right);

    const g = 0.8 * Math.SQRT1_2;
    let err = 0;
    let sig = 0;
    for (let i = 32; i < n - 32; i += 1) {
      const ideal = Math.sin((2 * Math.PI * freq * (i * 0.5)) / SRC) * g;
      err += (left[i] - ideal) ** 2;
      sig += ideal ** 2;
    }
    return 10 * Math.log10(sig / err);
  };

  const linear4k = snrAt(4000, linear);
  const cubic4k = snrAt(4000, cubic);
  const sinc4k = snrAt(4000, sinc8);

  assert.ok(linear4k < 25, `linear at 4 kHz should be poor, got ${linear4k.toFixed(1)} dB`);
  assert.ok(cubic4k > linear4k, 'cubic beats linear');
  assert.ok(
    sinc4k > 60,
    `sinc8 at 4 kHz should be clean, got ${sinc4k.toFixed(1)} dB`,
  );
  assert.ok(snrAt(2000, sinc8) > 60, 'sinc8 is clean at 2 kHz too');
  console.log(
    `    4 kHz SNR — linear ${linear4k.toFixed(1)} dB, ` +
      `cubic ${cubic4k.toFixed(1)} dB, sinc8 ${sinc4k.toFixed(1)} dB`,
  );
});

test('the default interpolator is the band-limited one', () => {
  assert.equal(DEFAULT_INTERPOLATOR, 'sinc8');
  assert.equal(INTERPOLATORS[DEFAULT_INTERPOLATOR], sinc8);
});

// ------------------------------------------------------------------ pitch math

test('a note at the slot base note plays at rate 1', () => {
  assert.equal(pitchRatio(slot({ baseNote: 48 }), 48, 120), 1);
});

test('an octave up doubles the rate, an octave down halves it', () => {
  const s = slot({ baseNote: 48 });
  assert.ok(Math.abs(pitchRatio(s, 60, 120) - 2) < 1e-9);
  assert.ok(Math.abs(pitchRatio(s, 36, 120) - 0.5) < 1e-9);
});

test('a semitone is the twelfth root of two', () => {
  const s = slot({ baseNote: 48 });
  assert.ok(Math.abs(pitchRatio(s, 49, 120) - 2 ** (1 / 12)) < 1e-12);
});

test('fineTune of 100 (assumed cents) equals one semitone', () => {
  const tuned = pitchRatio(slot({ baseNote: 48, fineTune: 100 }), 48, 120);
  const semitone = pitchRatio(slot({ baseNote: 48 }), 49, 120);
  assert.ok(Math.abs(tuned - semitone) < 1e-12);
});

test('an unpitched slot ignores the note entirely', () => {
  const drum = slot({ baseNote: 48, pitched: false });
  assert.equal(pitchRatio(drum, 24, 120), 1);
  assert.equal(pitchRatio(drum, 96, 120), 1);
});

test('fitBpm scales the rate by tempo over the sample tempo', () => {
  const loop = slot({ baseNote: 48, pitched: false, fitBpm: true, baseBpm: 120 });
  assert.ok(Math.abs(pitchRatio(loop, 48, 180) - 1.5) < 1e-9);
});

test('playbackRate folds in the sample-rate conversion', () => {
  // A 22050 Hz sample played at its base note on a 44100 Hz device advances
  // half a frame per output frame.
  const v = voiceFor({
    note: 48,
    volume: 127,
    instrument: instrument(),
    level: 1,
    pan: 0.5,
    sampleRate: 22050,
    outputRate: 44100,
    tempo: 120,
  });
  assert.ok(Math.abs(v.playbackRate - 0.5) < 1e-12);
  assert.equal(v.slot, 0);
  assert.ok(Math.abs(v.gain - 1) < 1e-12);
});

test('gain multiplies note volume by the instrument level', () => {
  assert.equal(velocityGain(127), 1);
  assert.equal(velocityGain(0), 0);
  const v = voiceFor({
    note: 48,
    volume: 96, // the record default, 0x60
    instrument: instrument(),
    level: 0.5,
    pan: 0.5,
    sampleRate: 44100,
    outputRate: 44100,
    tempo: 120,
  });
  assert.ok(Math.abs(v.gain - (96 / 127) * 0.5) < 1e-12);
});

test('pan is 0..1 centred at 0.5 and equal-power', () => {
  const centre = panGains(0.5);
  assert.ok(Math.abs(centre.left - centre.right) < 1e-12, 'centre is balanced');
  assert.ok(
    Math.abs(centre.left ** 2 + centre.right ** 2 - 1) < 1e-12,
    'constant power',
  );
  assert.ok(panGains(0).left > 0.999, 'pan 0 is hard left');
  assert.ok(panGains(1).right > 0.999, 'pan 1 is hard right');
});

test('samplesPerStep converts tempo to frames', () => {
  // 120 BPM, 4 steps per beat, 48 kHz -> half a second per beat, 6000 per step.
  assert.equal(samplesPerStep(48000, 120, 4), 6000);
  assert.throws(() => samplesPerStep(48000, 0), RangeError);
});

// --------------------------------------------------------------------- splits

test('a one-slot instrument sends every note to slot 0', () => {
  // The game's own shape for these: bounds 87, then zeros.
  const inst = instrument({ splitNotes: [87, 0, 0, 0, 0, 0, 0, 0, 0] });
  for (const note of [0, 40, 60, 127]) {
    assert.equal(resolveSlot(inst, note, 1), 0);
  }
});

test('a bound belongs to the zone above it — the real piano', () => {
  // The game's piano.rinst: bounds 87, 66, 54, 40, 30 over bases 84, 72, 60,
  // 48, 36. Slot i owns splitNotes[i+1] <= note < splitNotes[i].
  const inst = instrument({
    slots: [slot({ baseNote: 84 }), slot({ baseNote: 72 }), slot({ baseNote: 60 }),
            slot({ baseNote: 48 }), slot({ baseNote: 36 })],
    splitNotes: [87, 66, 54, 40, 30, 0, 0, 0, 0],
  });
  const at = (n: number) => resolveSlot(inst, n, 5);

  assert.equal(at(127), 0, 'above every bound stays in the first zone');
  assert.equal(at(66), 0, 'a bound belongs to the zone above it');
  assert.equal(at(65), 1);
  assert.equal(at(54), 1);
  assert.equal(at(53), 2);
  assert.equal(at(40), 2);
  assert.equal(at(39), 3);
  assert.equal(at(30), 3);
  assert.equal(at(29), 4);
  assert.equal(at(0), 4, 'below every bound stays in the last zone');
});

test('key splits: bass_guitar reads the same way', () => {
  // bounds 87, 42, 31, 20 over bases 48, 36, 28, 28.
  const inst = instrument({
    slots: [slot({ baseNote: 48 }), slot({ baseNote: 36 }),
            slot({ baseNote: 28 }), slot({ baseNote: 28 })],
    splitNotes: [87, 42, 31, 20, 0, 0, 0, 0, 0],
  });
  const at = (n: number) => resolveSlot(inst, n, 4);
  assert.equal(at(48), 0, "the top slot's own base note lands in it");
  assert.equal(at(42), 0);
  assert.equal(at(41), 1);
  assert.equal(at(36), 1, "and so does the second slot's");
  assert.equal(at(31), 1);
  assert.equal(at(30), 2);
  assert.equal(at(28), 2, 'and the third');
  assert.equal(at(20), 2);
  assert.equal(at(19), 3);
});

// --------------------------------------------------------------------- mixing

function ramp(n: number): SampleBuffer {
  const data = new Float32Array(n);
  for (let i = 0; i < n; i += 1) data[i] = i / n;
  return { channels: [data], sampleRate: 44100 };
}

test('rate 1 reproduces the sample exactly', () => {
  const mixer = new Mixer(44100);
  const sample = ramp(16);
  mixer.play({ sample, playbackRate: 1, gain: 1, pan: 0 });
  const left = new Float32Array(16);
  const right = new Float32Array(16);
  mixer.render(left, right);
  for (let i = 0; i < 16; i += 1) {
    assert.ok(Math.abs(left[i] - sample.channels[0][i]) < 1e-6, `frame ${i}`);
  }
});

test('rate 2 takes every other frame', () => {
  const mixer = new Mixer(44100);
  const sample = ramp(16);
  mixer.play({ sample, playbackRate: 2, gain: 1, pan: 0 });
  const left = new Float32Array(8);
  const right = new Float32Array(8);
  mixer.render(left, right);
  for (let i = 0; i < 8; i += 1) {
    assert.ok(Math.abs(left[i] - sample.channels[0][i * 2]) < 1e-6, `frame ${i}`);
  }
});

test('rate 0.5 lands on the midpoints under linear interpolation', () => {
  // Explicitly linear: the default is band-limited and deliberately does not
  // land on the arithmetic midpoint.
  const mixer = new Mixer(44100, linear);
  const sample = ramp(8);
  mixer.play({ sample, playbackRate: 0.5, gain: 1, pan: 0 });
  const left = new Float32Array(8);
  const right = new Float32Array(8);
  mixer.render(left, right);
  const src = sample.channels[0];
  assert.ok(Math.abs(left[1] - (src[0] + src[1]) / 2) < 1e-6);
  assert.ok(Math.abs(left[3] - (src[1] + src[2]) / 2) < 1e-6);
});

test('startFrame delays a voice sample-accurately', () => {
  const mixer = new Mixer(44100);
  mixer.play({ sample: ramp(8), playbackRate: 1, gain: 1, pan: 0, startFrame: 4 });
  const left = new Float32Array(8);
  const right = new Float32Array(8);
  mixer.render(left, right);
  for (let i = 0; i < 4; i += 1) assert.equal(left[i], 0, `silent before ${i}`);
  assert.ok(left[5] > 0, 'sounding after the start frame');
});

test('a finished voice is dropped and leaves silence', () => {
  const mixer = new Mixer(44100);
  mixer.play({ sample: ramp(4), playbackRate: 1, gain: 1, pan: 0.5 });
  const left = new Float32Array(8);
  const right = new Float32Array(8);
  mixer.render(left, right);
  assert.equal(mixer.voiceCount, 0, 'voice retired');
  for (let i = 4; i < 8; i += 1) assert.equal(left[i], 0, `silence at ${i}`);

  mixer.render(left, right);
  assert.ok(left.every((v) => v === 0), 'buffers are cleared each block');
});

test('voices sum, and panning splits them between the channels', () => {
  const mixer = new Mixer(44100);
  const flat: SampleBuffer = {
    channels: [Float32Array.from([1, 1, 1, 1])],
    sampleRate: 44100,
  };
  mixer.play({ sample: flat, playbackRate: 1, gain: 0.5, pan: 0 }); // hard left
  mixer.play({ sample: flat, playbackRate: 1, gain: 0.5, pan: 1 }); // hard right
  const left = new Float32Array(4);
  const right = new Float32Array(4);
  mixer.render(left, right);
  assert.ok(Math.abs(left[0] - 0.5) < 1e-6, 'left carries the left voice only');
  assert.ok(Math.abs(right[0] - 0.5) < 1e-6, 'right carries the right voice only');
});

test('a looping sample keeps sounding past its end', () => {
  const mixer = new Mixer(44100);
  const sample: SampleBuffer = {
    channels: [Float32Array.from([1, 1, 1, 1])],
    sampleRate: 44100,
    loop: { start: 0, end: 4 },
  };
  mixer.play({ sample, playbackRate: 1, gain: 1, pan: 0, endFrame: 16 });
  const left = new Float32Array(16);
  const right = new Float32Array(16);
  mixer.render(left, right);
  for (let i = 0; i < 16; i += 1) {
    assert.ok(Math.abs(left[i] - 1) < 1e-6, `frame ${i} still sounding`);
  }
});

test('rendering is deterministic across runs', () => {
  const render = () => {
    const mixer = new Mixer(44100);
    mixer.play({ sample: ramp(64), playbackRate: 1.37, gain: 0.8, pan: 0.25 });
    const left = new Float32Array(48);
    const right = new Float32Array(48);
    mixer.render(left, right);
    return [...left, ...right];
  };
  assert.deepEqual(render(), render());
});

test('looping is continuous at the wrap — the high-note transient', () => {
  // A sine whose loop region holds an exact number of cycles: the looped signal
  // is then a pure tone, and any discontinuity at the wrap is ours. The frames
  // after loop.end are SILENT, which is what an interpolator reading past the
  // loop pulls in.
  //
  // ⚠️ The playback rate must be FRACTIONAL. At rate 1.0 every position lands
  // on an integer, no interpolation crosses the boundary, and the test passes
  // whether or not the bug is present -- which is how the first version of it
  // was written, and it was vacuous.
  const rate = 48000;
  const freq = 500;
  const loopStart = 480;
  const loopEnd = loopStart + 96 * 20;
  const data = new Float32Array(loopEnd + 64);
  for (let i = 0; i < loopEnd; i += 1) {
    data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * 0.8;
  }

  const sample = {
    channels: [data],
    sampleRate: rate,
    loop: { start: loopStart, end: loopEnd },
  };

  const playbackRate = 0.5442; // what a 48 kHz sample an octave down actually gets
  const outHz = freq * playbackRate;
  const allowed = 0.8 * Math.SQRT1_2 * 2 * Math.sin((Math.PI * outHz) / rate);

  const worstStep = (interp: typeof linear): number => {
    const mixer = new Mixer(rate, interp);
    mixer.play({ sample, playbackRate, gain: 1, pan: 0.5, endFrame: 20000 });
    const left = new Float32Array(20000);
    const right = new Float32Array(20000);
    mixer.render(left, right);
    let worst = 0;
    for (let i = 900; i < 19000; i += 1) {
      worst = Math.max(worst, Math.abs(left[i] - left[i - 1]));
    }
    return worst;
  };

  for (const [name, interp] of [['cubic', cubic], ['sinc8', sinc8]] as const) {
    const worst = worstStep(interp);
    assert.ok(
      worst < allowed * 1.1,
      `${name}: worst step ${worst.toFixed(4)} against ${allowed.toFixed(4)} for a ` +
        `continuous sine — the loop wrap is discontinuous`,
    );

    // And the same interpolator ignoring the loop must FAIL that bar, or this
    // test proves nothing.
    const blind: typeof linear = (d, p) => interp(d, p);
    assert.ok(
      worstStep(blind) > allowed * 1.1,
      `${name}: ignoring the loop should have been caught, so this assertion is vacuous`,
    );
  }

  // Still sounding well past the end of the sample data.
  const mixer = new Mixer(rate, sinc8);
  mixer.play({ sample, playbackRate, gain: 1, pan: 0.5, endFrame: 20000 });
  const left = new Float32Array(20000);
  const right = new Float32Array(20000);
  mixer.render(left, right);
  let tail = 0;
  for (let i = 19000; i < 19500; i += 1) tail = Math.max(tail, Math.abs(left[i]));
  assert.ok(tail > 0.3, 'the loop should still be sounding past the sample end');
});

test('the attack is not wrapped into the loop', () => {
  // Before reaching loop.start the taps behind the cursor are the attack and
  // must be read as they stand.
  const data = new Float32Array(200);
  for (let i = 0; i < 100; i += 1) data[i] = 1;       // attack: DC 1
  for (let i = 100; i < 200; i += 1) data[i] = -1;    // loop region: DC -1
  const mixer = new Mixer(48000, cubic);
  mixer.play({
    sample: { channels: [data], sampleRate: 48000, loop: { start: 100, end: 200 } },
    playbackRate: 1, gain: 1, pan: 0,
    endFrame: 400,
  });
  const left = new Float32Array(400);
  const right = new Float32Array(400);
  mixer.render(left, right);
  assert.ok(Math.abs(left[50] - 1) < 1e-6, 'the attack plays as recorded');
  assert.ok(Math.abs(left[150] + 1) < 1e-6, 'the loop region plays as recorded');
  assert.ok(Math.abs(left[350] + 1) < 1e-6, 'and keeps looping');
});

test('the optional decay is off by default and exact when set', () => {
  const flat = { channels: [new Float32Array(48000).fill(1)], sampleRate: 48000 };

  // Off by default: a voice must not fade on its own.
  const plain = new Mixer(48000);
  plain.play({ sample: flat, playbackRate: 1, gain: 1, pan: 0, endFrame: 48000 });
  const l0 = new Float32Array(48000);
  const r0 = new Float32Array(48000);
  plain.render(l0, r0);
  assert.ok(Math.abs(l0[0] - l0[47000]) < 1e-6, 'no decay unless asked for');

  // 20 dB/s must be exactly 20 dB down after one second.
  const decaying = new Mixer(48000);
  decaying.play({
    sample: flat, playbackRate: 1, gain: 1, pan: 0,
    endFrame: 48000, decayDbPerSecond: 20,
  });
  const l1 = new Float32Array(48000);
  const r1 = new Float32Array(48000);
  decaying.render(l1, r1);
  const dropDb = 20 * Math.log10(l1[47999] / l1[0]);
  assert.ok(Math.abs(dropDb + 20) < 0.1, `expected -20 dB after a second, got ${dropDb.toFixed(2)}`);
});
