import { strict as assert } from 'node:assert';
import test from 'node:test';

import { STEPS_PER_BEAT, stepLength, swungFrame } from '../src/core/swing.ts';

test('the engine’s step constant confirms four steps to the beat', () => {
  // fmodextinput.prx 0x0bf7 divides 720000 by the tempo. At the engine's own
  // default tempo of 125 that is 5,760, and 48000 * 60 / (125 * 4) is 5,760.
  assert.equal(720000 / 125, (48000 * 60) / (125 * STEPS_PER_BEAT));
});

test('swing stretches the even step and squeezes the odd one equally', () => {
  // The parity table at v0x4530 is [1, -1], so the pair still lasts 2L and
  // swing never drifts against the bar.
  const L = 1000;
  for (const s of [0, 0.1, 0.5, 0.99]) {
    const even = stepLength(0, L, s);
    const odd = stepLength(1, L, s);
    assert.ok(Math.abs(even + odd - 2 * L) < 1e-9, `pair drifts at swing ${s}`);
    assert.equal(even, L * (1 + s / 2));
    assert.equal(odd, L * (1 - s / 2));
  }
});

test('a swung position lands where the accumulated steps put it', () => {
  const L = 1000;
  const s = 0.5;
  assert.equal(swungFrame(0, L, s), 0);
  // The off-beat is late by half a swing unit; the next downbeat is not moved.
  assert.equal(swungFrame(1, L, s), L + (L * s) / 2);
  assert.equal(swungFrame(2, L, s), 2 * L);
  assert.equal(swungFrame(4, L, s), 4 * L);
  // A fraction inside a step scales with that step's own length, which is what
  // makes a triplet inside a stretched step stretch with it.
  assert.equal(swungFrame(0.5, L, s), 0.5 * L * (1 + s / 2));
});

test('swing zero is the plain step clock', () => {
  for (const p of [0, 0.5, 1, 1.5, 7, 63.333]) {
    assert.equal(swungFrame(p, 1234, 0), p * 1234);
  }
});
