import { strict as assert } from 'node:assert';
import test from 'node:test';

import { dampedComb, mixPair, notchSection, onePoleInto } from '../src/audio/effects.ts';

test('mixPair is the stereo-to-mono downmix the late field starts from', () => {
  // 0x0a30, used by the block processor at 0x1695 with both gains at 0.5 and
  // the two halves of an interleaved-by-channel input buffer.
  const left = Float32Array.from([1, 2, 3]);
  const right = Float32Array.from([3, 4, 5]);
  const out = new Float32Array(3);
  mixPair(left, right, out, 0.5, 0.5, 3);
  assert.deepEqual([...out], [2, 3, 4]);
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

test('notchSection subtracts a resonator from the signal', () => {
  // ⚠️ Not an allpass, which is what this test used to claim. With
  // `a = 2r*cos(w)` and `c = -r*r` the recursion is a resonator, and `x - y` is
  // a notch. The block processor runs it on the **input** (0x1810).
  const buf = Float32Array.from([1, 0, 0, 0]);
  const before = [...buf];
  const { y } = notchSection(buf, 0.5, 0.3, 0.2, 0, 0, 4);
  // First sample: y = 0.3*1 = 0.3, buf[0] = 1 - 0.3 = 0.7.
  assert.ok(Math.abs(buf[0] - 0.7) < 1e-6);
  assert.ok(Math.abs(y) < 1, 'the state stays bounded');
  assert.notDeepEqual([...buf], before);
});

test('dampedComb accumulates the RAW delayed sample and gains the send too', () => {
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
