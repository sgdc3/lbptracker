/**
 * Check the TypeScript level walk against `tools/RawDump.java`'s output.
 *
 *   node --experimental-strip-types dev/verify-levels.ts [dir]
 *
 * This is the golden-fixture test steering asked for: the Java dump is 129,696
 * rows produced by a reader nobody in this project wrote, so agreeing with it is
 * evidence the walk is right rather than merely self-consistent.
 *
 * ⚠️ It compares what both sides genuinely know: the sequencer's UID, and for
 * each instrument placement the GUID, the note count and **the note bytes**.
 * Board coordinates are deliberately left out — `RawDump` rebuilds them from the
 * Thing graph when the circuit board is open and takes them from the component
 * record otherwise, and reproducing that choice is a separate question from
 * whether the bytes were read correctly.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { readLevel } from '../src/core/level.ts';
import { partReaders, type InstrumentPart, type Microchip, type SequencerPart } from '../src/core/parts.ts';
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
  // ⚠️ `RawDump` re-emits some sequencers wholesale; `instIdx` repeating is how
  // that shows. Keep the first pass only, as `importLevel` does.
  if (rows.length === row.instIdx) {
    rows.push({ guid: row.instRes, noteCount: row.noteCount, notes: row.notes });
  }
}

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

let filesChecked = 0;
let sequencersMatched = 0;
let placementsMatched = 0;
const problems: string[] = [];

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

  for (const thing of things) {
    if (!thing) continue;
    const sequencer = thing.parts.get('SEQUENCER') as SequencerPart | undefined;
    const chip = thing.parts.get('MICROCHIP') as Microchip | undefined;
    if (!sequencer || !chip || !sequencer.musicSequencer) continue;

    const rows = expected.get(thing.uid);
    if (!rows) {
      problems.push(`${entry.name.slice(0, 8)} seq ${thing.uid} is not in the dump`);
      continue;
    }

    const ours = chip.components
      .map((c) => c.thing?.parts.get('INSTRUMENT') as InstrumentPart | undefined)
      .filter((i): i is InstrumentPart => i !== undefined);

    if (ours.length !== rows.length) {
      problems.push(
        `${entry.name.slice(0, 8)} seq ${thing.uid}: ${ours.length} placements, dump has ${rows.length}`,
      );
      continue;
    }

    let ok = true;
    for (const [i, mine] of ours.entries()) {
      const theirs = rows[i];
      const guid = mine.guid ? `g${mine.guid}` : '';
      if (guid !== theirs.guid || mine.notes.length / 4 !== theirs.noteCount) {
        problems.push(
          `${entry.name.slice(0, 8)} seq ${thing.uid} #${i}: ${guid}/${mine.notes.length / 4} ` +
            `vs ${theirs.guid}/${theirs.noteCount}`,
        );
        ok = false;
        break;
      }
      if (hex(mine.notes) !== theirs.notes) {
        problems.push(`${entry.name.slice(0, 8)} seq ${thing.uid} #${i}: note bytes differ`);
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
    `exactly, ${placementsMatched} instrument placements byte for byte`,
);
for (const problem of problems.slice(0, 20)) console.log(`  ${problem}`);
if (problems.length > 20) console.log(`  … and ${problems.length - 20} more`);
