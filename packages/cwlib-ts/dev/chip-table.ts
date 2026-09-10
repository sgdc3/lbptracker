/**
 * The instrument chip table: RInstrument GUID -> the plan it comes from and
 * the icon on it, measured over every sequencer in reach.
 *
 * Run it over `fixtures/plans`, `fixtures/archive` and any level folder; it
 * reports disagreements rather than picking a winner.
 *
 * ⚠️ **`tools/InstrumentColours.java` is the better source and this is the
 * check on it**: a chip is placed from the instrument's own popit plan, so the
 * game's own data answers for all 68 instruments while a corpus answers only
 * for the ones somebody used. The two agreed on 50 of 50 rows on 2026-09-10.
 *
 * It also tallies `PInstrument.Colour`, which the table cannot get from a
 * corpus at all -- a creator re-tints a chip and the corpus then holds the
 * choice, not the default. What the tally is for is the shape of the field:
 * how many distinct values there are, and how many chips are tinted away from
 * what their instrument ships with.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { factoryColour } from '@lbptracker/cwlib/chips.ts';
import { readChunk, readLevel, readPlan } from '@lbptracker/cwlib/level.ts';
import { partReaders } from '@lbptracker/cwlib/parts.ts';
import { nodeInflate } from '@lbptracker/cwlib/platform/node.ts';
import type { Thing } from '@lbptracker/cwlib/thing.ts';
import type { InstrumentPart } from '@lbptracker/cwlib/parts.ts';

const rows = new Map<number, Map<string, number>>();
const tints = new Map<number, number>();
let placements = 0;
let tinted = 0;

async function walk(dir: string) {
  for (const name of await readdir(dir)) {
    const file = path.join(dir, name);
    if ((await stat(file)).isDirectory()) { await walk(file); continue; }
    const bytes = new Uint8Array(await readFile(file));
    if (bytes.length < 0x16) continue;
    const magic = String.fromCharCode(...bytes.subarray(0, 4));
    const read = magic === 'PLNb' ? readPlan : magic === 'LVLb' ? readLevel : magic === 'CHKb' ? readChunk : undefined;
    if (!read) continue;
    let things: (Thing | undefined)[];
    try { things = (await read(bytes, nodeInflate, partReaders())).things; } catch { continue; }
    for (const t of things) {
      const inst = t?.parts.get('INSTRUMENT') as InstrumentPart | undefined;
      if (!inst || !t) continue;
      const key = `plan=${t.planGuid} icon=${inst.icon}`;
      const row = rows.get(inst.guid) ?? new Map<string, number>();
      row.set(key, (row.get(key) ?? 0) + 1);
      rows.set(inst.guid, row);
      placements += 1;
      tints.set(inst.colour, (tints.get(inst.colour) ?? 0) + 1);
      if (inst.colour !== factoryColour(inst.guid)) tinted += 1;
    }
  }
}

for (const dir of process.argv.slice(2)) await walk(dir);
console.log(`${rows.size} instrument GUIDs`);
let disagree = 0;
for (const [guid, row] of [...rows].sort((a, b) => a[0] - b[0])) {
  const sorted = [...row].sort((a, b) => b[1] - a[1]);
  if (sorted.length > 1) disagree += 1;
  console.log(`${guid}\t${sorted.map(([k, n]) => `${k} x${n}`).join('  |  ')}`);
}
console.log(`${disagree} GUIDs with more than one answer`);

const hex = (v: number) => `0x${(v >>> 0).toString(16).padStart(8, '0')}`;
console.log(`
${placements} placements, ${tints.size} distinct colours, ` +
  `${tinted} tinted away from the instrument's own (${((tinted / placements) * 100).toFixed(1)}%)`);
for (const [colour, n] of [...tints].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(7)}  ${hex(colour)}`);
}
