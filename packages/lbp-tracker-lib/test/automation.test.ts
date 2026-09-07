import { strict as assert } from 'node:assert';
import test from 'node:test';

import { Mixer, type AutomationPoint } from '../src/audio/mixer.ts';

const RATE = 48000;

/**
 * Render a DC sample so the output IS the gain, or a ramp so the output
 * position can be read back as a rate.
 */
function render(automation: AutomationPoint[] | undefined, frames = 4800, dc = true) {
  const data = new Float32Array(RATE);
  if (dc) data.fill(1);
  else for (let i = 0; i < RATE; i += 1) data[i] = i / RATE; // a ramp: value == position
  const mixer = new Mixer(RATE);
  mixer.play({
    sample: { channels: [data], sampleRate: RATE },
    playbackRate: 1,
    gain: 1,
    pan: 0.5,
    automation,
  });
  const left = new Float32Array(frames);
  mixer.render(left, new Float32Array(frames));
  return left;
}

test('one control point, or none, leaves the note flat', () => {
  const none = render(undefined);
  const one = render([{ frame: 0, pitch: 0, gain: 1 }]);
  assert.deepEqual([...none.slice(0, 100)], [...one.slice(0, 100)]);
});

test('a pitch bend moves the read position, exponentially in semitones', () => {
  // The sample is a ramp whose value equals its normalised position, so the
  // output reads back where the voice is in the sample.
  const flat = render([{ frame: 0, pitch: 0, gain: 1 }], 4800, false);
  const up = render(
    [{ frame: 0, pitch: 0, gain: 1 }, { frame: 4800, pitch: 12, gain: 1 }],
    4800,
    false,
  );
  // Bending up an octave over the block must end further into the sample.
  assert.ok(up[4799] > flat[4799], 'a rising bend advances faster');

  // ⚠️ Linear in SEMITONES, not in rate. Halfway through a 0->12 bend the rate
  // is 2^0.5 = 1.4142, not 1.5 -- so the distance covered is the integral of
  // the exponential, which is measurably less than the linear one would give.
  // /0.5 undoes the centred pan, which the linear law puts on each channel.
  const halfway = (up[2400] / 0.5) * RATE; // frames into the sample
  const linearRate = 0;
  let expected = 0;
  for (let i = 0; i < 2400; i += 1) expected += 2 ** ((12 * (i / 4800)) / 12);
  assert.ok(
    Math.abs(halfway - expected) < 2,
    `expected ~${expected.toFixed(1)} frames in, got ${halfway.toFixed(1)}`,
  );
  // The linear-in-rate reading would put it here, and it is a different number.
  let ifLinear = 0;
  for (let i = 0; i < 2400; i += 1) ifLinear += 1 + (2 - 1) * (i / 4800);
  assert.ok(
    Math.abs(ifLinear - expected) > 10,
    'the two readings must actually differ, or this test proves nothing',
  );
  assert.equal(linearRate, 0);
});

test('a volume glide interpolates the gain', () => {
  const out = render([
    { frame: 0, pitch: 0, gain: 1 },
    { frame: 4800, pitch: 0, gain: 0 },
  ]);
  const centre = 0.5; // the pan law is linear, so a centred voice is 0.5
  assert.ok(Math.abs(out[0] - centre) < 1e-3, `starts at full, got ${out[0]}`);
  assert.ok(Math.abs(out[2400] - centre * 0.5) < 1e-2, `halfway, got ${out[2400]}`);
  assert.ok(out[4799] < centre * 0.02, `ends near silence, got ${out[4799]}`);
});

test('past the last point the value holds', () => {
  const out = render([
    { frame: 0, pitch: 0, gain: 1 },
    { frame: 1000, pitch: 0, gain: 0.25 },
  ]);
  assert.ok(Math.abs(out[1200] - out[4700]) < 1e-6, 'held, not extrapolated');
  assert.ok(Math.abs(out[4700] - 0.5 * 0.25) < 1e-3);
});

test('two points on the same frame take the later value, not NaN', () => {
  // Authoring debris: a zero-length segment must not divide by zero.
  const out = render([
    { frame: 0, pitch: 0, gain: 1 },
    { frame: 0, pitch: 0, gain: 0.5 },
    { frame: 4800, pitch: 0, gain: 0.5 },
  ]);
  for (const v of out) assert.ok(Number.isFinite(v), 'no NaN from a zero-length segment');
});

// `0x209a`/`0x20de` in `fmodextinput.prx`: the renderer compares the volume
// ramp at the END of each chunk with zero and frees the record after a chunk
// that reaches it. A note that opens at 0 and holds it is therefore gone
// after one block and never sounds -- 3,132 corpus notes -- while one that
// opens at 0 and rises has a positive chunk-end ramp and lives.
test('a volume held at zero frees the voice after one block; a fade-in lives', () => {
  const held = render([
    { frame: 0, pitch: 0, gain: 0 },
    { frame: 1000, pitch: 0, gain: 0 },
    { frame: 2000, pitch: 0, gain: 1 },
  ]);
  assert.ok(held.every((v) => v === 0), 'the rise at frame 2000 never plays: the record is gone');

  const fade = render([
    { frame: 0, pitch: 0, gain: 0 },
    { frame: 1000, pitch: 0, gain: 1 },
  ]);
  assert.ok(fade[1200] > 0.45, `a fade-in from silence still arrives: ${fade[1200]}`);

  // And a fade-out to zero is rendered to its end, then the voice is freed --
  // nothing rings past the point, whatever the sample would have done.
  const out = render([
    { frame: 0, pitch: 0, gain: 1 },
    { frame: 1000, pitch: 0, gain: 0 },
  ]);
  assert.ok(out[500] > 0.2 && out[1500] === 0 && out[4000] === 0);
});
