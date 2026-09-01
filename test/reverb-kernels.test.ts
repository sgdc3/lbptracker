import { strict as assert } from 'node:assert';
import test from 'node:test';

import { allpassSection, combSum, dampedComb, onePoleInto } from '../src/audio/effects.ts';

test('combSum adds a delayed tap and scales', () => {
  const x = Float32Array.from([1, 2, 3, 4, 5, 6]);
  const out = new Float32Array(3);
  combSum(x, out, 2, 0.5, 3);
  assert.deepEqual([...out], [(1 + 3) * 0.5, (2 + 4) * 0.5, (3 + 5) * 0.5]);
});

test('onePoleInto filters and carries its memory across the block', () => {
  const buf = new Float32Array(8);
  buf[0] = 1; // an impulse
  const y = onePoleInto(buf, 4, 0.5, 0.5, 0, 4);
  // y: 0.5, 0.25, 0.125, 0.0625 -- a decaying pole, written four slots along.
  assert.ok(Math.abs(buf[4] - 0.5) < 1e-6);
  assert.ok(Math.abs(buf[5] - 0.25) < 1e-6);
  assert.ok(Math.abs(y - 0.0625) < 1e-6, 'the last y is returned for the next block');
  // Feeding the returned y back must continue the same decay, not restart it.
  const buf2 = new Float32Array(8);
  const y2 = onePoleInto(buf2, 4, 0.5, 0.5, y, 1);
  assert.ok(Math.abs(y2 - y * 0.5) < 1e-6);
});

test('allpassSection subtracts its own output, which is what makes it allpass', () => {
  const buf = Float32Array.from([1, 0, 0, 0]);
  const before = [...buf];
  const { y } = allpassSection(buf, 0.5, 0.3, 0.2, 0, 0, 4);
  // First sample: y = 0.3*1 = 0.3, buf[0] = 1 - 0.3 = 0.7.
  assert.ok(Math.abs(buf[0] - 0.7) < 1e-6);
  assert.ok(Math.abs(y) < 1, 'the state stays bounded');
  assert.notDeepEqual([...buf], before);
});

test('dampedComb accumulates, damps, and mixes the send', () => {
  const x = Float32Array.from([1, 0, 0]);
  const acc = Float32Array.from([10, 20, 30]);
  const send = Float32Array.from([0, 0, 0]);
  const out = new Float32Array(3);
  const y = dampedComb(x, acc, send, out, 0.5, 0.5, 2, 0, 3);
  assert.deepEqual([...acc], [11, 20, 30], 'the tap accumulates the input');
  assert.ok(Math.abs(out[0] - 2 * 0.5) < 1e-6);
  assert.ok(Math.abs(out[1] - 2 * 0.25) < 1e-6, 'and decays');
  assert.ok(Math.abs(y - 0.125) < 1e-6);
});
