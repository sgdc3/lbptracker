import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  FILTER_PARAMS,
  MoogLadder,
  filterAt,
  ladderCoefficients,
} from '../src/audio/moog.ts';

const SR = 48000;

/** Steady-state peak of a unit sine through the ladder, as a gain. */
function gainAt(hz: number, freq: number, res: number, amplitude = 0.5): number {
  const coefficients = ladderCoefficients(freq, res);
  const filter = new MoogLadder();
  const n = Math.round(SR * 0.3);
  let peak = 0;
  for (let i = 0; i < n; i += 1) {
    const out = filter.process(amplitude * Math.sin((2 * Math.PI * hz * i) / SR), coefficients);
    if (i > n * 0.7) peak = Math.max(peak, Math.abs(out));
  }
  return peak / amplitude;
}

// ------------------------------------------------------------- coefficients

test('the coefficients are the reference formula, by hand', () => {
  // freq 0.5: q = 0.5, p = 0.5 + 0.8*0.5*0.5 = 0.7, f = 2p - 1 = 0.4,
  // and the resonance compensation is 1 + 0.5*0.5*(1 - 0.5 + 5.6*0.25) = 1.475.
  const c = ladderCoefficients(0.5, 1);
  assert.ok(Math.abs(c.p - 0.7) < 1e-9, `p = ${c.p}`);
  assert.ok(Math.abs(c.f - 0.4) < 1e-9, `f = ${c.f}`);
  assert.ok(Math.abs(c.q - 1.475) < 1e-9, `q = ${c.q}`);
  // Resonance scales that term linearly and nothing else.
  assert.equal(ladderCoefficients(0.5, 0).q, 0);
  assert.ok(Math.abs(ladderCoefficients(0.5, 0.5).q - 0.7375) < 1e-9);
  assert.equal(ladderCoefficients(0.5, 0).p, ladderCoefficients(0.5, 1).p);
});

// ------------------------------------------------------------------ response

test('it low-passes, and lower cutoffs cut more', () => {
  const low = gainAt(100, 0.1, 0);
  const high = gainAt(6400, 0.1, 0);
  assert.ok(high < low / 10, `6.4 kHz ${high.toFixed(3)} vs 100 Hz ${low.toFixed(3)}`);
  // Opening the cutoff must let more through at a fixed frequency.
  assert.ok(gainAt(3200, 0.3, 0) > gainAt(3200, 0.1, 0));
  assert.ok(gainAt(3200, 0.7, 0) > gainAt(3200, 0.3, 0));
});

test('resonance lifts the corner above the passband', () => {
  // At cutoff 0.3 the corner sits up near 6 kHz. With resonance the passband
  // drops and the corner rises past unity -- if this ever stops holding, the
  // resonance term has been transcribed wrong.
  const passband = gainAt(200, 0.3, 0.9);
  const corner = gainAt(6400, 0.3, 0.9);
  assert.ok(corner > 1, `the corner should peak above unity, got ${corner.toFixed(3)}`);
  assert.ok(
    corner > passband * 3,
    `corner ${corner.toFixed(3)} vs passband ${passband.toFixed(3)}`,
  );
  // And with no resonance there is no such peak.
  assert.ok(gainAt(6400, 0.3, 0) < gainAt(200, 0.3, 0));
});

test('it stays finite and bounded at settings that would blow up a linear ladder', () => {
  for (const [freq, res] of [
    [0.9, 1],
    [1, 1],
    [0.5, 1],
    [0, 1],
  ]) {
    const coefficients = ladderCoefficients(freq, res);
    const filter = new MoogLadder();
    let peak = 0;
    for (let i = 0; i < SR * 2; i += 1) {
      const out = filter.process(Math.sin(i * 0.7) * 0.95, coefficients);
      assert.ok(Number.isFinite(out), `freq ${freq} res ${res} went non-finite at ${i}`);
      peak = Math.max(peak, Math.abs(out));
    }
    assert.ok(peak < 4, `freq ${freq} res ${res} peaked at ${peak.toFixed(2)}`);
  }
});

const drive = (amplitude: number, freq: number, res = 0): number => {
  const coefficients = ladderCoefficients(freq, res);
  const filter = new MoogLadder();
  let peak = 0;
  for (let i = 0; i < 8000; i += 1) {
    const out = filter.process(amplitude * Math.sin(i * 0.05), coefficients);
    if (!Number.isFinite(out)) return NaN;
    if (i > 4000) peak = Math.max(peak, Math.abs(out));
  }
  return peak;
};

test('the cubic saturation is there — gain falls as the input grows', () => {
  // Dropping `b4 - b4^3/6` makes the ratio flat, so this is a real check on the
  // saturation rather than on the filter.
  const quiet = drive(0.1, 0.8) / 0.1;
  const loud = drive(1.0, 0.8) / 1.0;
  assert.ok(quiet > 0.99, `a quiet signal passes at unity, got ${quiet.toFixed(4)}`);
  assert.ok(loud < 0.9, `a full-scale one is compressed, got ${loud.toFixed(4)}`);
});

test('⚠️ the ladder diverges above roughly ±1.4 — that is the engine’s too', () => {
  // The reference this reproduces documents its input as [-1, +1], and beyond
  // it the cube overpowers the state and the filter runs away to NaN. **Do not
  // "fix" it**: the engine carries the same cube, and its voices are int16/32768
  // so they never leave the domain. This test exists so the boundary is a known
  // property rather than a surprise the day something feeds it a hot signal.
  for (const freq of [0.2, 0.5, 0.8, 1]) {
    assert.ok(Number.isFinite(drive(1, freq)), `full scale must survive at cutoff ${freq}`);
  }
  assert.ok(Number.isFinite(drive(1.3, 0.8)), 'and there is headroom past it');
  assert.ok(Number.isNaN(drive(2, 0.8)), 'but it does run away eventually');
});

test('a reset ladder repeats itself exactly', () => {
  const coefficients = ladderCoefficients(0.3, 0.5);
  const filter = new MoogLadder();
  const first = Array.from({ length: 64 }, (_, i) => filter.process(Math.sin(i * 0.3), coefficients));
  filter.reset();
  const second = Array.from({ length: 64 }, (_, i) => filter.process(Math.sin(i * 0.3), coefficients));
  assert.deepEqual(first, second);
});

// ------------------------------------------------------------- the modulation

test('filterAt squares the cutoff, and clamps', () => {
  const base = { cutoff: 0.5, resonance: 0.4, keyTrack: 0, envAmount: 0 };
  const { freq, res } = filterAt(base, 1, 1);
  assert.equal(freq, 0.25, 'the cutoff parameter is squared');
  assert.equal(res, 0.4);
  // An open filter with key tracking on a high note must clamp, not overflow.
  assert.equal(filterAt({ ...base, cutoff: 1, keyTrack: 1 }, 1, 8).freq, 1);
  assert.equal(filterAt({ ...base, cutoff: 0.5, envAmount: 1 }, -5, 1).freq, 0);
});

test('key tracking follows the playback rate, and only when asked', () => {
  const base = { cutoff: 0.5, resonance: 0, keyTrack: 1, envAmount: 0 };
  // rate 2 (an octave up) doubles the cutoff: 0.25 * (1 + (2-1)*1) = 0.5.
  assert.equal(filterAt(base, 1, 2).freq, 0.5);
  assert.equal(filterAt({ ...base, keyTrack: 0 }, 1, 2).freq, 0.25, 'off means off');
  assert.equal(filterAt({ ...base, keyTrack: 0.5 }, 1, 3).freq, 0.5, 'and it scales');
});

test('the envelope only moves the filter when the amount is set', () => {
  const base = { cutoff: 0.6, resonance: 0.4, keyTrack: 0, envAmount: 0 };
  // ⚠️ This is the redundancy the corpus shows: 27 of the 28 instruments with
  // amount 0 also leave envelope B inert, because either one neutralises the
  // pair. Both routes must give an unmodulated filter.
  for (const level of [0, 0.5, 1]) {
    assert.equal(filterAt(base, level, 1).freq, 0.36, `amount 0 at level ${level}`);
  }
  const modulated = { ...base, envAmount: 1 };
  assert.equal(filterAt(modulated, 1, 1).freq, 0.36, 'a level of 1 is the neutral point');
  assert.ok(filterAt(modulated, 0.5, 1).freq < 0.36, 'and below it the filter closes');
});

test('the param indices are the ones the renderer reads', () => {
  // ⚠️ 5 and 6 are envelope amount and key tracking, in that order, and this
  // test asserted the reverse. `fmodextinput.prx` loads the four as consecutive
  // (x,y) pairs at 0x2985-0x29bd and uses them at 0x2a02-0x2a90: 0x510 goes
  // into `1 + p*(envB - 1)` and 0x518 into `1 + (rate - 1)*p`. The array base is
  // pinned independently by Params[11..14] landing on the amplitude ADSR and
  // Params[24] on the output level.
  assert.deepEqual({ ...FILTER_PARAMS }, {
    cutoff: 3,
    resonance: 4,
    envAmount: 5,
    keyTrack: 6,
  });
});

// ------------------------------------------------- the two paths, kept apart

test('the resonance follows the key tracking, not the filter envelope', () => {
  // Read out of fmodextinput.prx at 0x2a90: `vmulps xmm1, xmm4, xmm1`, where
  // xmm4 is the keytrack built at 0x2a28 and xmm1 the interpolated Params[4].
  // The cutoff at 0x2a72 takes both keytrack and envFactor; the resonance takes
  // only keytrack, and this file asserted `resonance * envFactor` until the two
  // were read side by side.
  const settings = { cutoff: 0.89, resonance: 0.9, keyTrack: 0.6, envAmount: 0.63 };
  const rate = 2 ** ((25 - 48) / 12); // synth/ghost.rinst at its lowest note
  const keytrack = 1 + (rate - 1) * settings.keyTrack;

  // The filter envelope moves the cutoff...
  const open = filterAt(settings, 1, rate);
  const shut = filterAt(settings, 0, rate);
  assert.ok(open.freq > shut.freq, 'envelope B opens the cutoff');

  // ...and leaves the resonance alone.
  assert.equal(open.res, shut.res, 'envelope B must not touch the resonance');
  assert.ok(Math.abs(open.res - settings.resonance * keytrack) < 1e-12);

  // The size of the old error, on the patch that exposed it: ghost's amplitude
  // decay is 0.85s against a 1.04s filter attack, so envelope B never gets past
  // 0.194 and envFactor stays between 0.37 at the note's onset and 0.49 at the
  // envelope's peak. The wrong reading therefore delivered 0.33 where the right
  // one delivers 0.50 -- a factor of 1.51 at the attack, still 1.14 at the peak,
  // and it is the attack that a 0.85s note is mostly made of.
  const atOnset = 1 + settings.envAmount * (0 - 1);
  const atPeak = 1 + settings.envAmount * (0.194 - 1);
  assert.ok(
    keytrack / atOnset > 1.5 && keytrack / atPeak > 1.1,
    `keytrack ${keytrack.toFixed(3)} against envFactor ${atOnset.toFixed(3)}..${atPeak.toFixed(3)}`,
  );
});

test('a note far above the base note drives the cutoff to its ceiling', () => {
  // keytrack multiplies rather than offsets, so a high note can push
  // cutoff² * keytrack past 1. The clamp is ours -- the ladder diverges above
  // it -- and this pins the behaviour rather than leaving it to chance.
  const settings = { cutoff: 0.89, resonance: 0.9, keyTrack: 1, envAmount: 0 };
  assert.equal(filterAt(settings, 1, 4).freq, 1);
  assert.ok(filterAt(settings, 1, 4).res <= 1, 'resonance is clamped too');
});
