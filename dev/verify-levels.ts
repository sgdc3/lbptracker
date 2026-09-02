/**
 * Check the TypeScript level walk against a frozen dump of the same levels.
 *
 *   node --experimental-strip-types dev/verify-levels.ts [dir]
 *
 * This is the golden-fixture test steering asked for: `fixtures/levels/sequencers.jsonl`
 * is 129,696 rows produced by a reader nobody in this project wrote -- cwlib's,
 * driven by a small Java tool -- so agreeing with it is evidence the walk is
 * right rather than merely self-consistent.
 *
 * ⚠️ **The fixture can no longer be regenerated.** The Java tool that produced
 * it was deleted on 2026-09-02 once the TypeScript walk replaced it everywhere,
 * so this checks the corpus it was built from and nothing else: point it at a
 * level that is not in the dump and it will simply skip the file. That is the
 * price of the deletion, and it is worth knowing before trusting a clean run on
 * new data. `steering/lbp-modding-toolchain.md` records what the tool did.
 *
 * ⚠️ It compares what both sides genuinely know: the sequencer's UID, and for
 * each instrument placement the GUID, the note count and **the note bytes**.
 * Board coordinates are not in the dump, so they are checked here against the
 * shape they have to have instead: every cell a whole number of steps, and no
 * two components in one cell. `dev/board-probe.ts` is where the formula itself
 * is measured.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { musicSequencers, readLevel } from '../src/core/level.ts';
import { partReaders } from '../src/core/parts.ts';
import { nodeInflate } from '../src/platform/node.ts';

const DIR = process.argv[2] ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';
const DUMP = 'fixtures/levels/sequencers.jsonl';

/** The dump's rows for one level file, keyed by sequencer UID. */
const dump = new Map<string, Map<number, { guid: string; noteCount: number; notes: string }[]>>();
for (const line of (await readFile(DUMP, 'latin1')).split('\n')) {
  if (!line.startsWith('{')) continue;
  const row = JSON.parse(line) as {
    file: string;
    seqUID: number;
    instIdx: number;
    instRes: string;
    noteCount: number;
    notes: string;
  };
  let byUid = dump.get(row.file);
  if (!byUid) dump.set(row.file, (byUid = new Map()));
  let rows = byUid.get(row.seqUID);
  if (!rows) byUid.set(row.seqUID, (rows = []));
  // ⚠️ The dump re-emits some sequencers wholesale -- its outer loop could
  // reach one Thing twice -- and `instIdx` repeating is how that shows. Keep the
  // first pass only. The TypeScript walk reads `PWorld.things` once and cannot
  // produce it.
  if (rows.length === row.instIdx) {
    rows.push({ guid: row.instRes, noteCount: row.noteCount, notes: row.notes });
  }
}

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

let filesChecked = 0;
let sequencersMatched = 0;
let placementsMatched = 0;
let emptySequencers = 0;
let cellsChecked = 0;
const problems: string[] = [];

/** One horizontal step; rows are twice it. See `boardToGrid` in project.ts. */
const CELL = 52.5;

for (const entry of await readdir(DIR, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const expected = dump.get(entry.name);
  if (!expected) continue;

  let things;
  try {
    ({ things } = await readLevel(
      new Uint8Array(await readFile(path.join(DIR, entry.name))),
      nodeInflate,
      partReaders(),
    ));
  } catch (error) {
    console.log(`${entry.name.slice(0, 8)}  not parsed: ${String((error as Error).message).slice(0, 60)}`);
    continue;
  }
  filesChecked += 1;

  for (const sequencer of musicSequencers(things)) {
    const rows = expected.get(sequencer.uid);
    if (!rows) {
      // ⚠️ Not a mismatch when the sequencer is empty: the dump writes one row
      // per instrument placement, so a sequencer with none produces no rows at
      // all and cannot appear in the dump. 5aa77945's uid 2470000 is one --
      // zero placements, default tempo. The walk reports something the dump's
      // shape cannot express.
      if (sequencer.placements.length > 0) {
        problems.push(`${entry.name.slice(0, 8)} seq ${sequencer.uid} is not in the dump`);
      } else {
        emptySequencers += 1;
      }
      continue;
    }
    const ours = sequencer.placements.map((p) => p.instrument);
    if (ours.length !== rows.length) {
      problems.push(
        `${entry.name.slice(0, 8)} seq ${sequencer.uid}: ${ours.length} placements, dump has ${rows.length}`,
      );
      continue;
    }
    // A board cell holds one component, and a component sits on a cell -- true
    // whether the pair was stored or recovered from the matrices, so it catches
    // a wrong frame without needing the dump to carry coordinates.
    const seen = new Set<string>();
    for (const placement of sequencer.placements) {
      const cx = placement.x / CELL;
      const cy = placement.y / CELL;
      if (!Number.isFinite(cx) || Math.abs(cx - Math.round(cx)) > 1e-3) {
        problems.push(`${entry.name.slice(0, 8)} seq ${sequencer.uid}: x ${placement.x} is not a cell`);
        break;
      }
      if (!Number.isFinite(cy) || Math.abs(cy - Math.round(cy)) > 1e-3 || Math.abs(Math.round(cy)) % 2 !== 1) {
        problems.push(`${entry.name.slice(0, 8)} seq ${sequencer.uid}: y ${placement.y} is not a row centre`);
        break;
      }
      const key = `${Math.round(cx)},${Math.round(cy)}`;
      if (seen.has(key)) {
        problems.push(`${entry.name.slice(0, 8)} seq ${sequencer.uid}: two components in cell ${key}`);
        break;
      }
      seen.add(key);
      cellsChecked += 1;
    }

    let ok = true;
    for (const [i, mine] of ours.entries()) {
      const theirs = rows[i];
      const guid = mine.guid ? `g${mine.guid}` : '';
      if (guid !== theirs.guid || mine.notes.length / 4 !== theirs.noteCount) {
        problems.push(
          `${entry.name.slice(0, 8)} seq ${sequencer.uid} #${i}: ${guid}/${mine.notes.length / 4} ` +
            `vs ${theirs.guid}/${theirs.noteCount}`,
        );
        ok = false;
        break;
      }
      if (hex(mine.notes) !== theirs.notes) {
        problems.push(`${entry.name.slice(0, 8)} seq ${sequencer.uid} #${i}: note bytes differ`);
        ok = false;
        break;
      }
      placementsMatched += 1;
    }
    if (ok) sequencersMatched += 1;
  }
}

console.log(
  `\n${filesChecked} levels parsed, ${sequencersMatched} music sequencers matched the dump ` +
    `exactly, ${placementsMatched} instrument placements byte for byte, ` +
    `${cellsChecked} board cells whole and distinct` +
    (emptySequencers ? `; ${emptySequencers} empty sequencers the dump cannot express` : ''),
);
for (const problem of problems.slice(0, 20)) console.log(`  ${problem}`);
if (problems.length > 20) console.log(`  … and ${problems.length - 20} more`);
