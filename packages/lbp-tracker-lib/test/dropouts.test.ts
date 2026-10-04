/**
 * The dropout counter, fed the way the page feeds it: one reading of
 * `getOutputTimestamp()` a tenth of a second.
 *
 * The output is simulated as Chrome was measured on 2026-10-04 (see
 * `src/audio/dropouts.ts`): when the thread falls behind, the device plays
 * silence and the context's audio comes out that much later, for good. The two
 * clocks also drift apart, about 200 ppm there, and a reading wobbles a little.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { DropoutCounter } from '../src/audio/dropouts.ts';

/** A small deterministic generator, so a failure reproduces. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

interface Run {
  readonly seconds: number;
  /** Milliseconds of silence the device plays in the tenth of a second ending at `t` ms. */
  readonly silence?: (t: number) => number;
  /** The audio clock's rate against the wall's, less one, in parts per million. */
  readonly ppm?: number;
  /** A reading's wobble, in milliseconds either way. */
  readonly jitter?: number;
}

function simulate(run: Run): { dropouts: number; lostMs: number; truthMs: number } {
  const counter = new DropoutCounter();
  const random = lcg(3);
  const rate = 1 - (run.ppm ?? 200) / 1e6;
  let audio = 0;
  let silence = 0;
  let dropouts = 0;
  let lostMs = 0;
  for (let t = 100; t <= run.seconds * 1000; t += 100) {
    const gap = run.silence?.(t) ?? 0;
    silence += gap;
    audio += (100 - gap) * rate;
    const wobble = ((random() * 2 - 1) * (run.jitter ?? 0.5)) / 1000;
    const r = counter.observe(1000 + t, audio / 1000 + wobble);
    dropouts += r.dropouts;
    lostMs += r.lostMs;
  }
  return { dropouts, lostMs, truthMs: silence };
}

test('an output that keeps up loses nothing, whichever way the clocks drift', () => {
  for (const ppm of [-500, -200, 0, 200, 500]) {
    const r = simulate({ seconds: 300, ppm, jitter: 1 });
    assert.equal(r.dropouts, 0, `${ppm} ppm: ${r.lostMs} ms`);
  }
});

test('one gap is one dropout, and the time it cost', () => {
  const r = simulate({ seconds: 20, silence: (t) => (t === 10_000 ? 30 : 0) });
  assert.equal(r.dropouts, 1);
  assert.ok(Math.abs(r.lostMs - 30) <= 2, `lost ${r.lostMs}`);
});

test('a gap too short to count is not one', () => {
  const r = simulate({ seconds: 20, silence: (t) => (t === 10_000 ? 3 : 0) });
  assert.equal(r.dropouts, 0);
});

test('a thread just past 100 % loses a little at a time, and all of it is counted', () => {
  // 0.5 ms a reading, 5 ms a second: compared reading against reading, none of
  // it counts.
  const r = simulate({ seconds: 20, silence: (t) => (t > 5000 && t <= 15_000 ? 0.5 : 0) });
  assert.equal(r.truthMs, 50);
  assert.equal(r.dropouts, 1);
  // Short of it by what the creep took (500 ppm of 10 s) and the last rise
  // still under a step.
  assert.ok(r.lostMs >= 40 && r.lostMs <= 50, `lost ${r.lostMs}`);
});

test('an overload is one dropout, and what it cost', () => {
  // 249 ms in 5 s, as measured at 97 %.
  const r = simulate({ seconds: 20, silence: (t) => (t > 5000 && t <= 10_000 ? 4.98 : 0) });
  assert.equal(r.dropouts, 1);
  assert.ok(Math.abs(r.lostMs - r.truthMs) <= 5, `lost ${r.lostMs}, truth ${r.truthMs}`);
});

test('two losses seconds apart are two dropouts', () => {
  const r = simulate({ seconds: 20, silence: (t) => (t === 5000 || t === 12_000 ? 20 : 0) });
  assert.equal(r.dropouts, 2);
});

test('a pause is not a loss, and neither is a reading from before it', () => {
  const counter = new DropoutCounter();
  for (let n = 1; n <= 10; n += 1) counter.observe(1000 + 100 * n, 0.1 * n);
  // Paused a minute: the wall moved on, the audio did not.
  counter.reset();
  // A stale reading first, then fresh ones.
  assert.deepEqual(counter.observe(2000, 1.0), { dropouts: 0, lostMs: 0 });
  for (let n = 1; n <= 10; n += 1) {
    assert.deepEqual(counter.observe(62_000 + 100 * n, 1.0 + 0.1 * n), { dropouts: 0, lostMs: 0 });
  }
});

test('a context that has output nothing yet is not read', () => {
  const counter = new DropoutCounter();
  for (let n = 1; n <= 5; n += 1) assert.deepEqual(counter.observe(1000 + 100 * n, 0), { dropouts: 0, lostMs: 0 });
});
