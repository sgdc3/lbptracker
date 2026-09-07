/**
 * The master bus: ours, so what is tested is that it behaves, not that it
 * matches a recording of anything.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import { MasterBus, MASTER_DEFAULTS } from '../src/audio/master.ts';

const RATE = 48000;
const dbToGain = (db: number) => 10 ** (db / 20);

/** Run a signal through and return the output, both channels the same. */
function run(bus: MasterBus, input: readonly number[]): number[] {
  return input.map((v) => bus.process(v, v).left);
}

/** A sine at `hz`, `frames` long, at a peak of `peak`. */
function sine(hz: number, frames: number, peak: number): number[] {
  return Array.from({ length: frames }, (_, i) => peak * Math.sin((2 * Math.PI * hz * i) / RATE));
}

test('the limiter holds the ceiling, whatever is thrown at it', () => {
  const bus = new MasterBus(RATE, { amount: 0, ceilingDb: -0.3 });
  const ceiling = dbToGain(-0.3);
  // A second of a loud sine, then a jump to well over full scale.
  const out = run(bus, [...sine(220, RATE, 0.9), ...sine(220, RATE / 2, 4)]);
  const peak = Math.max(...out.map(Math.abs));
  assert.ok(peak <= ceiling + 1e-6, `peak ${peak.toFixed(4)} is over the ceiling ${ceiling.toFixed(4)}`);
  // And it is not simply silence: the loud passage still arrives near the top.
  const tail = out.slice(-1000);
  assert.ok(Math.max(...tail.map(Math.abs)) > ceiling * 0.8, 'the limiter squashed it flat');
});

test('a peak is caught before it plays, not after: the lookahead does its job', () => {
  const bus = new MasterBus(RATE, { amount: 0, ceilingDb: -0.3 });
  // Silence, then one sample at ten times full scale, then silence.
  const spike = new Array(200).fill(0);
  spike[100] = 10;
  const out = run(bus, spike);
  assert.ok(Math.max(...out.map(Math.abs)) <= dbToGain(-0.3) + 1e-6,
    'a lone sample over the ceiling still came out over it');
});

test('quiet material passes through untouched', () => {
  const bus = new MasterBus(RATE, { amount: 0, ceilingDb: -0.3 });
  const input = sine(440, 4000, 0.2);
  const out = run(bus, input);
  // Compare past the lookahead, where the delay has filled.
  const lookahead = Math.round((2 / 1000) * RATE);
  for (let i = lookahead + 10; i < input.length; i += 1) {
    assert.ok(Math.abs(out[i] - input[i - lookahead]) < 1e-6,
      `frame ${i} changed a signal that never approached the ceiling`);
  }
});

test('the knob squeezes: the gap between the loud and the quiet closes', () => {
  // Loud, quiet, loud: what glue does is bring those closer together, which
  // is what to measure. ⚠️ The crest factor of the whole thing is not: the
  // loud parts dominate both the peak and the RMS, so squeezing them moves
  // the two together and the ratio barely stirs.
  const LOUD = 12000;
  const QUIET = 6000;
  const signal = [...sine(220, LOUD, 0.9), ...sine(220, QUIET, 0.12), ...sine(220, LOUD, 0.9)];
  const rms = (out: number[]) => Math.sqrt(out.reduce((s, v) => s + v * v, 0) / out.length);
  // Past the attack and the release either side, so the envelope has settled.
  const loudOf = (out: number[]) => rms(out.slice(2000, LOUD - 2000));
  const quietOf = (out: number[]) => rms(out.slice(LOUD + 2000, LOUD + QUIET - 2000));
  const gap = (out: number[]) => 20 * Math.log10(loudOf(out) / quietOf(out));

  const off = run(new MasterBus(RATE, { amount: 0, ceilingDb: -0.3 }), signal);
  const on = run(new MasterBus(RATE, { amount: 10, ceilingDb: -0.3 }), signal);
  assert.ok(gap(on) < gap(off) - 1,
    `the gap was ${gap(off).toFixed(1)} dB and is ${gap(on).toFixed(1)} dB: that is not glue`);

  // And it is glue rather than a fader: the loud part keeps its level.
  const change = 20 * Math.log10(loudOf(on) / loudOf(off));
  assert.ok(Math.abs(change) < 6, `the loud part moved ${change.toFixed(1)} dB`);
});
test('the default is a light setting, and reset really resets', () => {
  assert.equal(MASTER_DEFAULTS.ceilingDb, -0.3);
  assert.ok(MASTER_DEFAULTS.amount > 0 && MASTER_DEFAULTS.amount <= 10);
  const bus = new MasterBus(RATE, MASTER_DEFAULTS);
  run(bus, sine(220, 2000, 3));
  bus.reset();
  const after = run(bus, sine(220, 2000, 0.1));
  assert.ok(Math.max(...after.map(Math.abs)) > 0.05, 'a reset bus is still holding an old gain down');
});
