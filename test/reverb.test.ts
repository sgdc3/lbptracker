import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  PRESET_SLOT,
  REVERB_EARLY_SETS,
  REVERB_PRESETS,
  REVERB_REMAP,
  REVERB_TAP_SETS,
  Reverb,
  millibelToLinear,
  reverbPreset,
} from '../src/audio/effects.ts';

const RATE = 48000;

test('the tables are the ones read out of the eboot', () => {
  assert.equal(REVERB_PRESETS.length, 12, '12 presets at v0x1062620');
  for (const p of REVERB_PRESETS) assert.equal(p.length, 11, 'eleven slots each');
  assert.deepEqual([...REVERB_REMAP], [3, 6, 8, 5, 11, 2, 0, 0]);
  assert.equal(REVERB_TAP_SETS.length, 19, '19 tap sets at v0xe1d5d0');
  for (const set of REVERB_TAP_SETS) {
    assert.ok(set.length >= 8 && set.length <= 10, `${set.length} taps`);
    for (const ms of set) assert.ok(ms > 0 && ms < 100, `${ms} ms is not a plausible tap`);
  }
  assert.equal(REVERB_EARLY_SETS.length, 7);
  for (const set of REVERB_EARLY_SETS) assert.equal(set.length, 9);
  // Slot 0 is pinned at -800 by the constructor and never written from the table.
  for (const p of REVERB_PRESETS) assert.equal(p[PRESET_SLOT.level0], -800);
});

test('millibels convert the way v0x3fcd50 does, floor included', () => {
  assert.equal(millibelToLinear(0), 1);
  assert.ok(Math.abs(millibelToLinear(-200) - 10 ** -1) < 1e-9, '-200 mB is -20 dB');
  assert.ok(Math.abs(millibelToLinear(-100) - 10 ** -0.5) < 1e-9);
  // Below -80 dB the engine returns a hard zero rather than something tiny.
  assert.equal(millibelToLinear(-800), 0, 'the -8000 floor is on v*10, so -800 hits it');
  assert.equal(millibelToLinear(-1000), 0);
});

test('every ReverbSetting the corpus uses selects a real preset', () => {
  // The corpus only ever writes 1..5.
  for (let setting = 0; setting <= 7; setting += 1) {
    const p = reverbPreset(setting);
    assert.equal(p.length, 11);
    assert.ok(REVERB_TAP_SETS[p[PRESET_SLOT.tapSet]], `setting ${setting} tap set`);
    assert.ok(REVERB_EARLY_SETS[p[PRESET_SLOT.earlySet]], `setting ${setting} early set`);
  }
});

test('the reverb is stable and decays, at every setting', () => {
  // ⚠️ This caught a real blow-up: reading the early rows' middle three floats
  // as decibels gave a gain of 100,000 and an impulse peak of 15,864.
  for (let setting = 1; setting <= 5; setting += 1) {
    const reverb = new Reverb(RATE, reverbPreset(setting));
    let peak = 0;
    let lastAudible = 0;
    for (let i = 0; i < RATE * 4; i += 1) {
      const out = reverb.process(i === 0 ? 1 : 0);
      assert.ok(Number.isFinite(out), `setting ${setting} went non-finite at ${i}`);
      const magnitude = Math.abs(out);
      if (magnitude > peak) peak = magnitude;
      if (magnitude > 1e-4) lastAudible = i;
    }
    assert.ok(peak < 1, `setting ${setting} peaked at ${peak.toFixed(3)} from a unit impulse`);
    assert.ok(peak > 0, `setting ${setting} is silent`);
    assert.ok(
      lastAudible < RATE * 4 - 1,
      `setting ${setting} never decays -- the feedback is at or above unity`,
    );
  }
});

test('a longer decay parameter gives a longer tail', () => {
  const tail = (decay: number) => {
    const preset = [...reverbPreset(5)];
    preset[PRESET_SLOT.decay] = decay;
    const reverb = new Reverb(RATE, preset);
    let last = 0;
    for (let i = 0; i < RATE * 6; i += 1) {
      if (Math.abs(reverb.process(i === 0 ? 1 : 0)) > 1e-4) last = i;
    }
    return last / RATE;
  };
  const short = tail(6);
  const long = tail(50);
  assert.ok(long > short * 2, `decay 6 gave ${short.toFixed(2)}s, decay 50 gave ${long.toFixed(2)}s`);
});
