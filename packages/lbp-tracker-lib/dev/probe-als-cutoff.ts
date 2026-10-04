/**
 * Live's Sampler low-pass around its dial at several absolute frequencies, read
 * off Live's meters.
 *
 *     LBP_ALS_OUT=fixtures/out/cutoff-probe node packages/lbp-tracker-lib/dev/probe-als-cutoff.ts
 *
 * The export's Sampler, one sustained sine per track (`als-probe.ts`): the 1 kHz
 * sine played at keys 36, 60, 84 and 96 is a sine at 250 Hz, 1, 4 and 8 kHz.
 * Each sits under dials at 0.707, 1 and 1.414 of its own frequency, the
 * resonance at 0, no tracking, no envelope.
 *
 * | rows | what they read |
 * |---|---|
 * | `open 250`, `open 8k` | the filter off at the two ends: whether the Sampler itself loses level at a high rate |
 * | `250 /.7` .. `8k /1.4` | the sine at each frequency under a dial `f/0.707`, `f` and `f/1.414`: the attenuation around the dial |
 *
 * ❗ The export maps the engine's cutoff to Live's dial by equal attenuation
 * from these, against `MoogLadder` run on the same sines
 * (`steering/ableton-interchange.md`, *The instruments*).
 */

import { writeProbe, type ProbeRow } from './als-probe.ts';

/** `Params[3]` for a cutoff in Hz: the export writes `Params[3]² x 24 kHz`. */
const cutoff = (hz: number) => Math.sqrt(hz / 24000);

const SINES = [{ key: 36, hz: 250, label: '250' }, { key: 60, hz: 1000, label: '1k' }, { key: 84, hz: 4000, label: '4k' }, { key: 96, hz: 8000, label: '8k' }];
const RATIOS = [{ over: 0.707, label: '/.7' }, { over: 1, label: '/1' }, { over: 1.414, label: '/1.4' }];

const rows: ProbeRow[] = [
  { name: 'open 250', pitch: 36 },
  { name: 'open 8k', pitch: 96 },
  ...SINES.flatMap((sine) => RATIOS.map((ratio) => ({
    name: `${sine.label} ${ratio.label}`,
    pitch: sine.key,
    // A dial of f / (f/fc): the sine sits at `over` times the cutoff.
    params: { 3: cutoff(sine.hz / ratio.over) },
  }))),
];
const set = await writeProbe('Cutoff Probe', rows, process.env.LBP_ALS_OUT ?? 'fixtures/out/cutoff-probe');
console.log(`${set}: press Play in Live and read the fourteen peak boxes`);
for (const sine of SINES) console.log(`  ${sine.label}: dials ${RATIOS.map((r) => (sine.hz / r.over).toFixed(0)).join(', ')} Hz`);
