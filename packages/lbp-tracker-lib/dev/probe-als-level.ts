/**
 * The level Live's Sampler plays our export at, read off Live's own meters.
 *
 *     LBP_ALS_OUT=fixtures/out/level-probe node packages/lbp-tracker-lib/dev/probe-als-level.ts
 *
 * Writes a Live project whose 14 tracks each hold one sustained 1 kHz sine at
 * half scale through the export's own Sampler (`sequencerToAls` with an
 * instrument at `Params[24]` = 1, no filter, sustain 1): thirteen at pressures
 * 127 down to 1, velocity 127, and one at pressure 127 and velocity 64. The
 * master sits at -inf, so nothing is heard, and the set opens on the Session
 * view, where all fourteen peak boxes fit. Open it in Live, press Play -- ⚠️ a
 * key posted to Live's window does not start it, someone has to -- and read the
 * boxes: each should be the printed expectation, `0.5 x 0.75` (the sine, the
 * track's fader) times `pressure / 127`, the engine's law, and the velocity
 * track the same as pressure 127.
 *
 * ❗ It exists because "Live opens it" never said how loud: the Samplers played
 * 22.8 dB over the engine for a month, from Vel -> Vol at 1, and only Live's
 * meters showed it (`steering/ableton-interchange.md`, *The instruments*).
 * ❌ A Max for Live recorder on the master was tried first: Live 11.3.43
 * crashed loading the hand-written device.
 */

import { replaceOnce, UNITY, writeProbe, type ProbeRow } from './als-probe.ts';

const PRESSURES = [127, 112, 96, 80, 64, 48, 42, 32, 24, 16, 8, 4, 1];

const rows: ProbeRow[] = [
  ...PRESSURES.map((p) => ({ name: `p${p}`, volume: p })),
  // The velocity row: its note at 64, which the Sampler should ignore.
  { name: 'p127 vel64', edit: replaceOnce(/Velocity="127"/, 'Velocity="64"') },
];
const set = await writeProbe('Level Probe', rows, process.env.LBP_ALS_OUT ?? 'fixtures/out/level-probe');
console.log(`${set}: press Play in Live, then each peak box should read`);
for (const row of rows) {
  console.log(`  ${row.name.padEnd(11)} ${(20 * Math.log10(UNITY * (row.volume ?? 127) / 127)).toFixed(2)} dBFS`);
}
