/**
 * The audio-thread load meter, against the timing Chrome really gives it.
 *
 * The simulation is the one measured in Chrome on 2026-10-04 (see the header
 * of `src/audio/load-meter.ts`): a device callback every 10 ms exactly, each
 * rendering 128-frame quanta back to back in the pattern 4, 4, 4, 3, and a clock
 * that only says whole milliseconds. Time itself is continuous here, so the
 * truth is known exactly; the meter only ever sees `Math.floor` of it.
 *
 * ⚠️ **What these pin is the trap, not just the code.** `oldMeter` is the sum
 * the worklet used to take -- `Date.now()` around each `process()` -- and the
 * first test shows it reading 0 % and 10 % for the same 3 % load, depending on
 * nothing but where the callback falls inside the millisecond.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { LoadMeter } from '../src/audio/load-meter.ts';

/** A small deterministic generator, so a failure reproduces. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const QUANTA = [4, 4, 4, 3];

interface Run {
  /** Where inside the millisecond each callback starts. */
  readonly phase: number;
  /** Milliseconds one quantum takes, by callback. */
  readonly quantum: (callback: number) => number;
  readonly seconds?: number;
  readonly active?: boolean;
}

/**
 * Run the meter over a simulated stream; return its last reading, the truth, and
 * the old sum. A callback that comes while the thread is busy waits for it, so
 * past 100 % the thread never rests.
 */
function simulate(run: Run): { reading: number | null; readings: (number | null)[]; truth: number; old: number; waits: number } {
  let t = 0;
  let waits = 0;
  const clock = () => Math.floor(t);
  const meter = new LoadMeter(clock, lcg(7), (fraction) => {
    waits += 1;
    t += fraction;
  });
  meter.setActive(run.active ?? true);
  const callbacks = (run.seconds ?? 20) * 100;
  let busy = 0;
  let oldBusy = 0;
  let reading: number | null = null;
  const readings: (number | null)[] = [];
  for (let n = 0; n < callbacks; n += 1) {
    t = Math.max(t, run.phase + n * 10);
    for (let q = 0; q < QUANTA[n % 4]; q += 1) {
      meter.begin();
      const began = clock();
      const cost = run.quantum(n);
      t += cost;
      busy += cost;
      oldBusy += clock() - began;
      meter.end();
    }
    if (n % 10 === 9) {
      reading = meter.report();
      readings.push(reading);
    }
  }
  const wall = Math.max(t, callbacks * 10);
  return { reading, readings, truth: busy / wall, old: oldBusy / wall, waits };
}

test('a light load reads true wherever the callback falls in the millisecond', () => {
  // 0.08 ms a quantum: 0.3 ms a callback, 3 % of the thread.
  for (const phase of [0.05, 0.4, 0.9]) {
    const { reading, truth, old } = simulate({ phase, quantum: () => 0.08 });
    assert.ok(Math.abs(truth - 0.03) < 1e-9);
    assert.ok(Math.abs(reading! - truth) < 0.02, `phase ${phase}: read ${reading}, truth ${truth}`);
    // The old sum, for the record: the same load read as next to nothing or as
    // a tenth. (Not exactly nothing: the dither's waits move the sampled bursts.)
    if (phase === 0.05) assert.ok(old < 0.005, `old ${old}`);
    if (phase === 0.9) assert.ok(old > 0.09, `old ${old}`);
  }
});

test('a heavy load stops dithering and still reads close', () => {
  // 1.8 ms a quantum: 6.75 ms a callback on average, 67.5 %.
  const { reading, truth } = simulate({ phase: 0.3, quantum: () => 1.8 });
  assert.ok(Math.abs(reading! - truth) < 0.08, `read ${reading}, truth ${truth}`);
});

test('past 100 % the thread never rests, and the meter says so', () => {
  // 3 ms a quantum: 112.5 % of the thread. No gap ever closes the burst.
  const { reading } = simulate({ phase: 0.6, quantum: () => 3 });
  assert.ok(reading! > 0.97, `read ${reading}`);
});

test('an overload shows while it lasts, not after', () => {
  // Light, then 3 s past 100 % from 10 s, then light again. One report a
  // tenth of a second: 100 is 10 s in.
  const { readings } = simulate({ phase: 0.2, quantum: (n) => (n >= 1000 && n < 1300 ? 3 : 0.3), seconds: 30 });
  const during = readings[128]!;
  assert.ok(during > 0.4, `2.8 s into the overload: ${during}`);
  // The meter used to count a burst only when it closed: it read low through
  // the overload and high once it was over.
  const peakAfter = Math.max(...readings.slice(140).map((r) => r!));
  assert.ok(peakAfter <= during + 0.05, `after: ${peakAfter}, during: ${during}`);
});

test('nothing is spent waiting while nothing plays', () => {
  const idle = simulate({ phase: 0.2, quantum: () => 0.02, active: false });
  assert.equal(idle.waits, 0);
  const playing = simulate({ phase: 0.2, quantum: () => 0.02 });
  // One callback in ten on average: 2,000 callbacks, about 200 waits.
  assert.ok(playing.waits > 150 && playing.waits < 250, `waits ${playing.waits}`);
});

test('a reset forgets the last reading', () => {
  let t = 0;
  const meter = new LoadMeter(() => Math.floor(t), lcg(1), (f) => (t += f));
  meter.setActive(true);
  for (let n = 0; n < 200; n += 1) {
    t = Math.max(t, n * 10);
    meter.begin();
    t += 0.5;
    meter.end();
    if (n % 10 === 9) meter.report();
  }
  assert.notEqual(meter.report(), null);
  meter.reset();
  assert.equal(meter.report(), null);
});
