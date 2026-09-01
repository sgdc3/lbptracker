import { strict as assert } from 'node:assert';
import test from 'node:test';

import { LFO_RATE_SCALE, Lfo, gainFactor, panFold, pitchFactor } from '../src/audio/lfo.ts';
import { Mixer } from '../src/audio/mixer.ts';

const off = { rate: 0.5, depth: 0, spread: 0 };
const fixed = (v: number) => () => v;

test('the rate scales are the engine’s: 100, 100, 50', () => {
  assert.deepEqual([...LFO_RATE_SCALE], [100, 100, 50]);
});

test('a phase starts random in [0, 2π) and advances at the given rate', () => {
  // Two voices of the same instrument must not modulate in lockstep -- that is
  // the whole point of randomising the phase at note start.
  const a = new Lfo(fixed(0));
  const b = new Lfo(fixed(0.5));
  assert.equal(a.radians, 0);
  assert.ok(Math.abs(b.radians - Math.PI) < 1e-12);
  assert.notEqual(a.value, b.value);

  a.advance(1, Math.PI / 2);
  assert.ok(Math.abs(a.value - 1) < 1e-12, 'a quarter turn from zero is the peak');
});

test('the phase stays bounded rather than drifting into float mush', () => {
  const lfo = new Lfo(fixed(0));
  for (let i = 0; i < 100_000; i += 1) lfo.advance(1 / 48000, 100);
  assert.ok(Math.abs(lfo.radians) <= 2 * Math.PI);
  assert.ok(Number.isFinite(lfo.value));
});

test('depth zero is exactly neutral for all three destinations', () => {
  assert.equal(pitchFactor(1, 0), 1);
  assert.equal(pitchFactor(-1, 0), 1);
  assert.equal(gainFactor(1, 0), 1);
  assert.equal(gainFactor(-1, 0), 1);
  // Pan folds to whatever the base says and ignores the oscillator.
  assert.equal(panFold(1, 0, 0), 0);
  assert.equal(panFold(-1, 0, 1), 1);
});

test('pitch swings ±5% at full depth, and carries the unison detune', () => {
  assert.ok(Math.abs(pitchFactor(1, 1) - 1.05) < 1e-12);
  assert.ok(Math.abs(pitchFactor(-1, 1) - 0.95) < 1e-12);
  // The detune is the base the vibrato rides on, at the same scale.
  assert.ok(Math.abs(pitchFactor(1, 1, 1.05) - 1.1) < 1e-12);
  // ±5% is a little under a semitone, which is a sane maximum vibrato.
  const semitone = 2 ** (1 / 12);
  assert.ok(1.05 < semitone, `5% is ${(1.05).toFixed(3)}, a semitone is ${semitone.toFixed(3)}`);
});

test('pan folds into a triangle over 0..1 rather than a raw sine', () => {
  // ⚠️ A raw sine would linger at the extremes; the fold turns and comes back,
  // which is what the engine does at 0x25fc-0x2634.
  for (let base = 0; base <= 4; base += 0.05) {
    const v = panFold(0, 0, base);
    assert.ok(v >= 0 && v <= 1, `base ${base} gave ${v}`);
  }
  assert.ok(Math.abs(panFold(0, 0, 0) - 0) < 1e-12);
  assert.ok(Math.abs(panFold(0, 0, 1) - 1) < 1e-12);
  assert.ok(Math.abs(panFold(0, 0, 2) - 0) < 1e-12, 'it turns at 1 and comes back');
  assert.ok(Math.abs(panFold(0, 0, 3) - 1) < 1e-12);
  // Symmetric about zero: the engine takes the absolute value first.
  assert.ok(Math.abs(panFold(0, 0, -0.4) - panFold(0, 0, 0.4)) < 1e-12);
});

// ------------------------------------------------------------ through a voice

const render = (lfos: Parameters<Mixer['play']>[0]['lfos'], frames = 4800) => {
  const rate = 48000;
  const mixer = new Mixer(rate);
  mixer.play({
    sample: { channels: [new Float32Array(rate).fill(1)], sampleRate: rate, loop: { start: 0, end: rate - 1 } },
    playbackRate: 1,
    gain: 1,
    pan: 0.5,
    lfos,
    random: fixed(0.25), // phase π/2, so the first sample sits at the peak
  });
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  mixer.render(left, right);
  return { left, right };
};

test('an all-off LFO set changes nothing', () => {
  const flat = render([off, off, off]).left;
  const none = render(undefined).left;
  assert.deepEqual([...flat.slice(0, 200)], [...none.slice(0, 200)]);
});

// A rate of 0.63 scales to ~63 rad/s, so a 4800-frame block at 48 kHz covers
// one full cycle. Anything slower only walks a fraction of a radian and the
// swing is too small to assert on -- which is a property of the engine's rate
// scale, not of the test.
test('LFO 2 modulates the amplitude', () => {
  const tremolo = render([off, { rate: 0.63, depth: 0.5, spread: 0 }, off]).left;
  // The factor swings 0.5..1.5, so a span of 1.0 -- but a centred pan puts
  // sqrt(1/2) on each channel, so what reaches `left` is 1.0 * 0.7071.
  const span = (Math.max(...tremolo) - Math.min(...tremolo)) / Math.SQRT1_2;
  assert.ok(span > 0.95 && span < 1.05, `depth 0.5 should swing 1.0, got ${span.toFixed(4)}`);
  // Depth zero must be flat over the same span, or the swing above proves nothing.
  const flat = render([off, off, off]).left;
  assert.ok(Math.max(...flat) - Math.min(...flat) < 1e-6);
});

test('LFO 3 moves the stereo balance', () => {
  const panned = render([off, off, { rate: 0.63, depth: 1, spread: 0 }]);
  const balance = (i: number) => panned.left[i] - panned.right[i];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 4800; i += 1) {
    lo = Math.min(lo, balance(i));
    hi = Math.max(hi, balance(i));
  }
  assert.ok(hi - lo > 0.5, `pan should sweep across the block, got ${(hi - lo).toFixed(4)}`);
  // And with the LFO off the balance must not move at all.
  const still = render([off, off, off]);
  assert.ok(Math.abs((still.left[0] - still.right[0]) - (still.left[4799] - still.right[4799])) < 1e-6);
});
