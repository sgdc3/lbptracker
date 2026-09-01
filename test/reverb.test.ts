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
  //
  // The tail is measured **relative to the reverb's own peak**, not against an
  // absolute threshold. An absolute one only tests how loud the wet bus happens
  // to be: normalising the comb bank moved every level by 9x and a 1e-4
  // threshold called that a broken decay. T60 from peak is the decay law
  // itself.
  for (let setting = 1; setting <= 5; setting += 1) {
    const preset = reverbPreset(setting);
    const rt60 = Math.max(0.05, preset[PRESET_SLOT.decay] / 10);
    const window = 2400;
    const frames = Math.round(RATE * (rt60 * 3 + 1));
    const reverb = new Reverb(RATE, preset);

    const envelope: number[] = [];
    let block = 0;
    for (let i = 0; i < frames; i += 1) {
      const out = reverb.process(i === 0 ? 1 : 0);
      assert.ok(Number.isFinite(out), `setting ${setting} went non-finite at ${i}`);
      block = Math.max(block, Math.abs(out));
      if (i % window === window - 1) {
        envelope.push(block);
        block = 0;
      }
    }

    const peak = Math.max(...envelope);
    assert.ok(peak > 0, `setting ${setting} is silent`);
    assert.ok(peak < 1, `setting ${setting} peaked at ${peak.toFixed(3)} from a unit impulse`);

    let last = 0;
    for (let k = 0; k < envelope.length; k += 1) {
      if (envelope[k] > peak / 1000) last = k + 1;
    }
    const t60 = (last * window) / RATE;
    assert.ok(
      t60 < frames / RATE,
      `setting ${setting} still rings at ${(frames / RATE).toFixed(1)}s, past three ` +
        `times its ${rt60.toFixed(1)}s RT60 -- the feedback is at or above unity`,
    );

    // ⚠️ Only where the preset asks for a late field at all. Setting 1's is
    // `[-800, -100, -700, ...]`: `millibelToLinear` reads tenths of a dB, so its
    // late level is **-70 dB** against early reflections at -10 dB. That preset
    // is early reflections and nothing else, and its tail is supposed to vanish
    // at once -- asserting one there tests a wish rather than the game.
    if (millibelToLinear(preset[PRESET_SLOT.level2]) > 1e-3) {
      // The measured T60 lands at **0.80 to 1.17** of nominal across settings
      // 2-5 (0.90, 1.17, 0.80, 0.82). Two effects pull opposite ways: the
      // damping one-pole sits inside the feedback loop and takes energy out on
      // every pass, shortening the tail, while the allpass cascade smears it
      // and lengthens it.
      //
      // ⚠️ These numbers used to be 0.40-0.61, and the improvement is evidence
      // rather than cosmetics: the comb bank carried an invented `1 - gain`
      // normalisation, and with it gone the decay follows the RT60 law the
      // preset actually asks for. A band that had to be 0.25-1.0 to fit is now
      // comfortably centred on 1.
      const ratio = t60 / rt60;
      assert.ok(
        ratio > 0.5 && ratio < 1.5,
        `setting ${setting} decayed in ${t60.toFixed(2)}s against a nominal ` +
          `${rt60.toFixed(1)}s RT60 (ratio ${ratio.toFixed(2)})`,
      );
    }
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

test('the echo delay is eight steps per unit of EchoTime', async () => {
  const { Echo } = await import('../src/audio/effects.ts');
  // v0x1c5d32 stores EchoTime * 0.5; 0x0faa rounds `stored * 16` to a whole
  // number of steps and multiplies by the step length, then aligns to 16
  // frames. So the delay is round(EchoTime * 8) steps.
  const fps = 4000; // 180 BPM at 48 kHz
  for (const [field, steps] of [[1, 8], [2, 16], [1.5, 12], [4, 32]] as [number, number][]) {
    const echo = new Echo(48000, field, fps, 0.5, 0.5);
    assert.equal(echo.seconds, ((steps * fps) & ~0xf) / 48000, `EchoTime ${field}`);
  }
  // ⚠️ The corpus is the sanity check: EchoTime is 2.00 on 189 of 338
  // sequencers, which is 16 steps -- a whole bar -- and 1.00 on 95, half a bar.
  const bar = new Echo(48000, 2, fps, 0.5, 0.5);
  assert.equal(bar.seconds, (16 * fps) / 48000, 'a full bar at four steps to the beat');
});
