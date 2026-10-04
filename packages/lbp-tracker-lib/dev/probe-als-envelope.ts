/**
 * How Live's Sampler filter envelope moves the cutoff, alone and with the slide,
 * read off Live's meters.
 *
 *     LBP_ALS_OUT=fixtures/out/envelope-probe node packages/lbp-tracker-lib/dev/probe-als-envelope.ts
 *
 * The export's Sampler, one sustained 1 kHz sine per track (`als-probe.ts`), its
 * filter envelope set in the XML to rise at once and hold at a sustain level,
 * so the cutoff it gives is a steady one the meters can read.
 *
 * | rows | what they read |
 * |---|---|
 * | `open`, `F250` .. `F4000` | the filter off, then plain cutoffs: the curve to read the rest against |
 * | `env +12` .. `env +48` | the dial at 125 Hz, the envelope holding at 1 with Amount 12 .. 48 |
 * | `env +48 sus.5` | the same at a sustain of 0.5: whether the amount scales with the level |
 * | `env +24 slide+12` | the envelope and the slide together: whether they add |
 * | `pulse 0`, `pulse +12` | `pulse_wave`'s own shape: the dial at 30 Hz, Amount 67.7, sustain 1, slide 0 and slide 21.2 |
 *
 * ❗ If the amount is semitones times the level, the `env` rows read like the
 * plain cutoffs 250 .. 2000 Hz, `sus.5` like 500, `slide+12` like 1000, and the
 * two `pulse` rows like 1.5 kHz and 3 kHz.
 */

import { setFilter, slideToCutoff, writeProbe, type ProbeRow } from './als-probe.ts';

/** `Params[3]` for a cutoff in Hz: the export writes `Params[3]² x 24 kHz`. */
const cutoff = (hz: number) => Math.sqrt(hz / 24000);
/** The envelope rising at once and holding at `sustain`, `amount` semitones, on a dial of `hz`. */
const envelope = (hz: number, amount: number, sustain = 1) => setFilter({
  Freq: hz,
  'Envelope.IsOn': true,
  'Envelope.Amount': amount,
  'Envelope.AttackTime': 0.1,
  'Envelope.AttackLevel': 0,
  'Envelope.DecayTime': 1,
  'Envelope.DecayLevel': 1,
  'Envelope.SustainLevel': sustain,
});
const both = (...edits: ((track: string) => string)[]) => (track: string) => edits.reduce((t, e) => e(t), track);
/** A slide that raises the cutoff by `semitones`, by the measured 72 x s/127. */
const up = (semitones: number) => slideToCutoff((127 * semitones) / 72);

const rows: ProbeRow[] = [
  { name: 'open' },
  ...[250, 500, 1000, 2000, 4000].map((hz) => ({ name: `F${hz}`, params: { 3: cutoff(hz) } })),
  ...[12, 24, 36, 48].map((st) => ({ name: `env +${st}`, params: { 3: cutoff(125) }, edit: envelope(125, st) })),
  { name: 'env +48 sus.5', params: { 3: cutoff(125) }, edit: envelope(125, 48, 0.5) },
  { name: 'env +24 slide+12', params: { 3: cutoff(125) }, edit: both(envelope(125, 24), up(12)) },
  { name: 'pulse 0', params: { 3: cutoff(125) }, edit: envelope(30, 67.7262907876) },
  { name: 'pulse +12', params: { 3: cutoff(125) }, edit: both(envelope(30, 67.7262907876), up(12)) },
];
const set = await writeProbe('Envelope Probe', rows, process.env.LBP_ALS_OUT ?? 'fixtures/out/envelope-probe');
console.log(`${set}: press Play in Live and read the fourteen peak boxes`);
