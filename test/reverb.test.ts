import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  PRESET_SLOT,
  REVERB_EARLY_SETS,
  REVERB_PAIR_RATIOS,
  REVERB_PRESETS,
  REVERB_REMAP,
  REVERB_TAP_SETS,
  Reverb,
  millibelToLinear,
  reverbPreset,
} from '../src/audio/effects.ts';

const RATE = 48000;

/** A mono impulse into the send bus, the way the renderer feeds it. */
function impulseResponse(preset: readonly number[], frames: number): Float32Array {
  const reverb = new Reverb(RATE, preset);
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const v = i === 0 ? 1 : 0;
    const r = reverb.process(v, v);
    out[i * 2] = r.left;
    out[i * 2 + 1] = r.right;
  }
  return out;
}

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
  assert.deepEqual([...REVERB_PAIR_RATIOS], [0.93, 1.06]);
  // Slot 0 is pinned at -800 by the constructor and never written from the table.
  for (const p of REVERB_PRESETS) assert.equal(p[PRESET_SLOT.dryLevel], -800);
});

test('millibels convert the way v0x3fcd50 does, floor included', () => {
  assert.equal(millibelToLinear(0), 1);
  assert.ok(Math.abs(millibelToLinear(-200) - 10 ** -1) < 1e-9, '-200 mB is -20 dB');
  assert.ok(Math.abs(millibelToLinear(-100) - 10 ** -0.5) < 1e-9);
  // Below -80 dB the engine returns a hard zero rather than something tiny.
  assert.equal(millibelToLinear(-800), 0, 'the -8000 floor is on v*10, so -800 hits it');
  assert.equal(millibelToLinear(-1000), 0);
});

test('the DSP is a pure send effect: the dry level is a hard zero', () => {
  // slot 0 = -800 on every preset, and the floor makes that exactly 0. So the
  // reverb never passes its input through, which is why the renderer adds its
  // own dry mix and this class only returns wet.
  for (let setting = 0; setting <= 5; setting += 1) {
    const reverb = new Reverb(RATE, reverbPreset(setting));
    assert.equal(reverb.dryLevel, 0, `setting ${setting}`);
  }
});

test('slot 1 is the late level and slot 2 the early level, and only slot 2 is divided by 100', () => {
  // v0x3fcdd5/v0x3fce0f/v0x3fce49 write slots 0, 1, 2 into [param+0x4c],
  // [param+0x48] and [param+0x50]; the block processor uses +0x4c on the input
  // (dry), +0x48 on the delayed comb sum (late) and +0x50 on the early taps.
  //
  // ⚠️ This file had slots 1 and 2 the other way round for a long time, and the
  // divide by 100 -- which is real, `vdivss` against a literal -- was tried on
  // the late level, where it silences the tail.
  for (let setting = 0; setting <= 5; setting += 1) {
    const preset = reverbPreset(setting);
    const reverb = new Reverb(RATE, preset);
    assert.equal(reverb.lateLevel, millibelToLinear(preset[PRESET_SLOT.lateLevel]));
    assert.equal(reverb.earlyLevel, millibelToLinear(preset[PRESET_SLOT.earlyLevel]) / 100);
  }
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

test('the two channels differ, and they differ because of the comb pairs', () => {
  // The right accumulator is a copy of the left taken after the mono combs and
  // before the pairs (0x1a41). Left then gets taps[0] and 0.93*taps[0], right
  // taps[1] and 1.06*taps[1]. That copy is the entire stereo width of the late
  // field, so if L and R came back identical the pairs would not be running.
  for (let setting = 1; setting <= 5; setting += 1) {
    const ir = impulseResponse(reverbPreset(setting), RATE);
    let diff = 0;
    let total = 0;
    for (let i = 0; i < RATE; i += 1) {
      diff += (ir[i * 2] - ir[i * 2 + 1]) ** 2;
      total += ir[i * 2] ** 2 + ir[i * 2 + 1] ** 2;
    }
    assert.ok(total > 0, `setting ${setting} is silent`);
    assert.ok(diff / total > 1e-4, `setting ${setting} came back effectively mono`);
  }
});

test('the reverb is stable and decays, at every setting', () => {
  // ⚠️ This caught a real blow-up once: reading the early rows' middle three
  // floats as decibels gave a gain of 100,000 and an impulse peak of 15,864.
  //
  // The tail is measured **relative to the reverb's own peak**, never against an
  // absolute threshold: an absolute one only tests how loud the wet bus happens
  // to be, and every change to the levels moves that.
  for (let setting = 1; setting <= 5; setting += 1) {
    const preset = [...reverbPreset(setting)];
    const rt60 = Math.max(0.05, preset[PRESET_SLOT.decay] / 10);
    const window = 2400;
    const frames = Math.round(RATE * (rt60 * 3 + 1));
    // ⚠️ The early reflections are muted here, and that is not a convenience.
    // They are three fixed taps with no decay at all, and on some presets they
    // are the louder half: preset 11 (`ReverbSetting` 4) has an early gain of
    // 100 against a late level of -28 dB, so its early taps set the peak and a
    // T60 measured from that peak reports 0.32 of nominal while the tail itself
    // is fine. What this test is checking is the comb law, so the comb bank is
    // what it has to look at.
    preset[PRESET_SLOT.earlyLevel] = -800;
    const ir = impulseResponse(preset, frames);

    const envelope: number[] = [];
    let block = 0;
    for (let i = 0; i < frames; i += 1) {
      assert.ok(
        Number.isFinite(ir[i * 2]) && Number.isFinite(ir[i * 2 + 1]),
        `setting ${setting} went non-finite at ${i}`,
      );
      block = Math.max(block, Math.abs(ir[i * 2]), Math.abs(ir[i * 2 + 1]));
      if (i % window === window - 1) {
        envelope.push(block);
        block = 0;
      }
    }

    const peak = Math.max(...envelope);
    assert.ok(peak > 0, `setting ${setting} is silent`);

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

    // The combs' gains are `10^(-0.003*ms/rt60)`, so a comb of length `ms`
    // decays 60 dB in exactly `rt60`. Measuring that back is what says the gain
    // law and the recursion are both right.
    const ratio = t60 / rt60;
    assert.ok(
      ratio > 0.6 && ratio < 1.6,
      `setting ${setting} decayed in ${t60.toFixed(2)}s against a nominal ` +
        `${rt60.toFixed(1)}s RT60 (ratio ${ratio.toFixed(2)})`,
    );
  }
});

test('a longer decay parameter gives a longer tail', () => {
  const tail = (decay: number) => {
    const preset = [...reverbPreset(5)];
    preset[PRESET_SLOT.decay] = decay;
    const ir = impulseResponse(preset, RATE * 6);
    let peak = 0;
    for (let i = 0; i < ir.length; i += 1) peak = Math.max(peak, Math.abs(ir[i]));
    let last = 0;
    for (let i = 0; i < RATE * 6; i += 1) {
      if (Math.abs(ir[i * 2]) > peak / 1000 || Math.abs(ir[i * 2 + 1]) > peak / 1000) last = i;
    }
    return last / RATE;
  };
  const short = tail(6);
  const long = tail(50);
  assert.ok(long > short * 2, `decay 6 gave ${short.toFixed(2)}s, decay 50 gave ${long.toFixed(2)}s`);
});

test('the output delay is slot 6 in milliseconds, and it delays the late field', () => {
  // The comb sum goes through a delay line of `slot6` ms before `lateLevel` is
  // applied (0x1d2a-0x1d90). With the early reflections muted, nothing may come
  // out before the shortest comb has run once *plus* that delay.
  const preset = [...reverbPreset(3)];
  preset[PRESET_SLOT.earlyLevel] = -800; // a hard zero, so only the late path is left
  const taps = REVERB_TAP_SETS[preset[PRESET_SLOT.tapSet]];
  const shortest = Math.min(...taps.slice(0, REVERB_TAP_SETS[preset[PRESET_SLOT.tapSet]].length));
  for (const ms of [0, 40]) {
    const withDelay = [...preset];
    withDelay[PRESET_SLOT.outputDelayMs] = ms;
    const ir = impulseResponse(withDelay, RATE);
    let first = -1;
    for (let i = 0; i < RATE && first < 0; i += 1) {
      if (Math.abs(ir[i * 2]) > 1e-9 || Math.abs(ir[i * 2 + 1]) > 1e-9) first = i;
    }
    const expected = Math.round(((shortest + ms) / 1000) * RATE);
    assert.ok(first > 0, `delay ${ms} ms produced nothing`);
    assert.ok(
      Math.abs(first - expected) <= 4,
      `delay ${ms} ms: first output at ${first}, expected about ${expected}`,
    );
  }
});

test('the echo delay is eight steps per unit of EchoTime', async () => {
  const { Echo } = await import('../src/audio/effects.ts');
  // v0x1c5d32 stores EchoTime * 0.5; 0x0f6a rounds `stored * 16` to a whole
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
