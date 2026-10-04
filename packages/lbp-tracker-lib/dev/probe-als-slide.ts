/**
 * How Live's Sampler moves its filter cutoff with the per-note slide, read off
 * Live's meters.
 *
 *     LBP_ALS_OUT=fixtures/out/slide-probe node packages/lbp-tracker-lib/dev/probe-als-slide.ts
 *
 * The export's Sampler, one sustained 1 kHz sine per track (`als-probe.ts`).
 * The filter dial sits at 125 Hz, three octaves under the sine, so the slide
 * that opens it shows as level. The Slide row (`MidiCtrl.4`) goes to Filter
 * Freq (`Connection` 12) at Amount 100, and each note carries one slide value
 * as a per-note CC 74 list.
 *
 * | rows | what they read |
 * |---|---|
 * | `F125` .. `F2000` | the sine under those cutoffs with no slide routed: the curve to read the rest against |
 * | `slide 0` .. `slide 127` | the dial at 125 Hz and that slide value: the cutoff each opens to |
 *
 * ❗ Each slide row's level, found on the calibration rows' curve, is a cutoff.
 * The cutoffs against the slide values are the law: whether 0 leaves the dial
 * where it is, and how many semitones 127 moves it.
 */

import { slideToCutoff as slide, writeProbe, type ProbeRow } from './als-probe.ts';

/** `Params[3]` for a cutoff in Hz: the export writes `Params[3]² x 24 kHz`. */
const cutoff = (hz: number) => Math.sqrt(hz / 24000);

const rows: ProbeRow[] = [
  ...[125, 250, 500, 1000, 2000].map((hz) => ({ name: `F${hz}`, params: { 3: cutoff(hz) } })),
  ...[0, 16, 32, 48, 64, 80, 96, 112, 127].map((value) => ({ name: `slide ${value}`, params: { 3: cutoff(125) }, edit: slide(value) })),
];
const set = await writeProbe('Slide Probe', rows, process.env.LBP_ALS_OUT ?? 'fixtures/out/slide-probe');
console.log(`${set}: press Play in Live and read the fourteen peak boxes`);
