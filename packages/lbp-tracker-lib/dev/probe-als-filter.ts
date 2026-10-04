/**
 * Where Live's Sampler filter sits against the engine's, read off Live's meters.
 *
 *     LBP_ALS_OUT=fixtures/out/filter-probe node packages/lbp-tracker-lib/dev/probe-als-filter.ts
 *
 * The export's Sampler, one sustained sine per track (`als-probe.ts`), the
 * filter set through the instrument's own `Params` as the export maps them:
 * the cutoff (`Params[3]²` of 24 kHz), the resonance (`Params[4]`) and the key
 * tracking (`Params[5]`). Every Sampler's volume goes back to 0 dB, so the
 * passband compensation the export would write does not hide what Live's
 * filter does.
 *
 * | rows | what they read |
 * |---|---|
 * | `open` | the filter off: the reference, −8.52 dBFS |
 * | `F500` .. `F4000` | a 1 kHz sine under a cutoff of 500 Hz .. 4 kHz: Live's low-pass curve, the attenuation at each ratio |
 * | `F8000 r.53`, `F1000 r.53` | the resonance at 0.53 (`ghost`'s): well under the cutoff, and at it |
 * | `track K36` .. `K84` | key tracking 1, the cutoff dial at 1 kHz, notes 36 .. 84 on a zone rooted at 60 |
 *
 * ❗ The tracking rows are the point. With tracking that follows the note an
 * octave per octave, the sine and the cutoff move together and every one reads
 * the same; that level, found on the calibration rows' curve, says how far
 * Live's reference note is from the zone's root of 60.
 */

import { writeProbe, type ProbeRow } from './als-probe.ts';

/** `Params[3]` for a cutoff in Hz: the export writes `Params[3]² x 24 kHz`. */
const cutoff = (hz: number) => Math.sqrt(hz / 24000);
/** Every Sampler back at 0 dB, whatever passband compensation the export wrote. */
const zeroDb = (track: string) => {
  const out = track.replace(/(<VolumeAndPan>\n<Volume>\n<LomId Value="0" \/>\n<Manual Value=")[^"]*(")/, '$10$2');
  if (!/<VolumeAndPan>\n<Volume>\n<LomId Value="0" \/>\n<Manual Value="0"/.test(out)) throw new Error('no Sampler volume');
  return out;
};

const rows: ProbeRow[] = [
  { name: 'open', edit: zeroDb },
  ...[500, 707, 1000, 1414, 2000, 4000].map((hz) => ({ name: `F${hz}`, params: { 3: cutoff(hz) }, edit: zeroDb })),
  { name: 'F8000 r.53', params: { 3: cutoff(8000), 4: 0.53 }, edit: zeroDb },
  { name: 'F1000 r.53', params: { 3: cutoff(1000), 4: 0.53 }, edit: zeroDb },
  ...[36, 48, 60, 72, 84].map((k) => ({ name: `track K${k}`, pitch: k, params: { 3: cutoff(1000), 5: 1 }, edit: zeroDb })),
];
const set = await writeProbe('Filter Probe', rows, process.env.LBP_ALS_OUT ?? 'fixtures/out/filter-probe');
console.log(`${set}: press Play in Live and read the fourteen peak boxes; 'open' should be -8.52 dBFS`);
