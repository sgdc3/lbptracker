/**
 * The table `als-sampler.ts` maps the engine's cutoff to Live's dial with:
 * where `MoogLadder` attenuates as much as Live's Sampler filter does at its
 * own dial.
 *
 *     node packages/lbp-tracker-lib/dev/ladder-knee.ts
 *
 * Live's Clean low-pass reads −8.0 dB at its dial, the same from 250 Hz to
 * 8 kHz (`probe-als-cutoff.ts`, 2026-10-04), so a dial is that point. For each
 * nominal cutoff of the ladder (`Params[3]²` of 24 kHz, at no resonance) this
 * finds the frequency where the ladder reaches −8.0 dB on a sine, and prints
 * the pairs as the literal `LADDER_KNEE` is. Run it again if the ladder in
 * `audio/moog.ts` changes; `test/als-sampler.test.ts` re-derives three points.
 */

import { ladderCoefficients, MoogLadder } from '../src/audio/moog.ts';

/** Live's attenuation at its own dial, measured. */
const LIVE_AT_DIAL_DB = -8.0;

export function ladderDb(sineHz: number, freq: number): number {
  const c = ladderCoefficients(freq, 0);
  const ladder = new MoogLadder();
  const settle = Math.max(4800, Math.round((48000 * 8) / sineHz));
  let peak = 0;
  for (let i = 0; i < 2 * settle; i++) {
    const y = ladder.process(0.25 * Math.sin((2 * Math.PI * sineHz * i) / 48000), c);
    if (i > settle) peak = Math.max(peak, Math.abs(y));
  }
  return 20 * Math.log10(peak / 0.25);
}

/** Where the ladder at `freq` reaches Live's attenuation-at-dial, or Infinity if not below 23.9 kHz. */
export function kneeHz(freq: number): number {
  let lo = 5, hi = 23900;
  if (ladderDb(hi, freq) > LIVE_AT_DIAL_DB) return Infinity;
  for (let k = 0; k < 40; k++) {
    const mid = Math.sqrt(lo * hi);
    if (ladderDb(mid, freq) > LIVE_AT_DIAL_DB) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

if (process.argv[1]?.endsWith('ladder-knee.ts')) {
  const rows: string[] = [];
  for (let k = 0; k <= 30; k++) {
    const nominal = 20 * (23900 / 20) ** (k / 30);
    const knee = kneeHz(nominal / 24000);
    if (!Number.isFinite(knee)) break;
    rows.push(`[${nominal.toFixed(1)}, ${knee.toFixed(1)}]`);
  }
  console.log(`export const LADDER_KNEE: readonly (readonly [nominal: number, knee: number])[] = [\n  ${rows.join(', ')},\n];`);
}
