/**
 * Sample real levels out of the public archive and say what the reader makes of them.
 *
 *     node packages/cwlib-ts/dev/archive-sample.mjs [count] [dir]
 *
 * ❗ **This is what turns question 28 from a browser errand into a measurement.**
 * The reader's coverage used to be argued from ten levels that all came from one
 * creator and one console generation; the sweep behind `LBP3_MIN_VERSION` runs
 * over 103 levels spread across LBP1, LBP2 and LBP3 slots, and it took one
 * command. Every real bug in `packages/cwlib-ts/src/parts.ts` found since 2026-09-05 came out
 * of a file no PS3 save on this machine contains.
 *
 * ## What it needs
 *
 * ⚠️ **The archive's own index, `dry.db`** — 2.6 GB of SQLite from
 * <https://archive.org/download/dry23db>, 10,467,874 level slots. `LBP_DRY_DB`
 * points at it; the default is where `lbp-download` puts it. It is the user's
 * own download and is never in this repository.
 *
 * The `slot` table's `rootLevel` is the 20-byte SHA1 the archive is keyed by and
 * `game` is which title the slot was published for — **not** the revision the
 * file carries. A level published as LBP2 and last saved in LBP3 is stored as
 * LBP3, which is why `game` 1 spans `0x3b7`–`0x3f9` and only `game` 0 reaches
 * LEERDAMMER.
 *
 * ## Why the sample is spread by id and not random
 *
 * Ids are chronological, so an even spread over the id range is an even spread
 * over the game's life, which is what puts revisions in the sample. Fifty random
 * ids would mostly be the same busy year.
 *
 * ## Politeness
 *
 * Four requests at a time, and anything already downloaded is skipped, so a
 * second run of the same sample asks the archive for nothing. The URL is
 * `rootLevelUrl` from `packages/lbp-tracker-web/src/lbparchive.ts`, restated here because this is a Node
 * script and that is a browser module -- see the note there for how it was
 * derived from LBPSearch's own handler.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const COUNT = Number(process.argv[2] ?? 60);
const DIR = process.argv[3] ?? path.join('fixtures', 'archive');
const DB = process.env.LBP_DRY_DB
  ?? 'C:/Users/sgdc3/Desktop/LBP/lbp-download/dry.db';
const PYTHON = process.env.LBP_PYTHON
  ?? 'C:/Users/sgdc3/AppData/Local/Programs/Python/Python314/python.exe';

/** Where a root level's bytes are. See `rootLevelUrl` in `packages/lbp-tracker-web/src/lbparchive.ts`. */
const rootLevelUrl = (sha1) => {
  const h = sha1.toLowerCase();
  return `https://archive.org/download/dry23r${h[0]}/dry${h.slice(0, 2)}.zip/`
    + `${h.slice(0, 2)}%2F${h.slice(2, 4)}%2F${h}`;
};

// ⚠️ Node has no SQLite that ships with it on every version this repo targets,
// and the query is four lines, so it goes through the Python that `tools/`
// already depends on rather than adding a package.
const query = `
import sqlite3, json, sys
db = sqlite3.connect(sys.argv[1])
out = []
for game in (0, 1, 2):
    lo, hi = db.execute("select min(id), max(id) from slot where game=?", (game,)).fetchone()
    n = max(2, int(sys.argv[2]) // 3)
    for k in range(n):
        at = lo + (hi - lo) * k // (n - 1)
        row = db.execute(
            "select id, rootLevel from slot where game=? and id>=? and rootLevel is not null "
            "and length(rootLevel)=20 order by id limit 1", (game, at)).fetchone()
        if row:
            out.append({"game": game, "sha1": row[1].hex()})
print(json.dumps(out))
`;

const picked = spawnSync(PYTHON, ['-c', query, DB, String(COUNT)], { encoding: 'utf8' });
if (picked.status !== 0) {
  console.error(picked.stderr || picked.error);
  console.error(`\ncould not read the index at ${DB} — set LBP_DRY_DB, and see the header`);
  process.exit(1);
}
const picks = JSON.parse(picked.stdout);
const seen = new Set();
const wanted = picks.filter((p) => !seen.has(p.sha1) && seen.add(p.sha1));

await mkdir(DIR, { recursive: true });
const already = new Set(await readdir(DIR).catch(() => []));
let got = 0;
let failed = 0;
const jobs = wanted.map((p) => async () => {
  const name = `${p.game}-${p.sha1}`;
  if (already.has(name)) { got += 1; return; }
  try {
    const res = await fetch(rootLevelUrl(p.sha1), { redirect: 'follow' });
    if (!res.ok) { failed += 1; return; }
    const bytes = new Uint8Array(await res.arrayBuffer());
    // ⚠️ **A 200 is not a level.** The archive answers a missing entry with a
    // short body rather than a 404, and one two-byte file in the first sweep
    // reached `walk-levels.ts` as "too short to be a resource" — a reader bug
    // report for something that was never downloaded.
    if (bytes.length < 0x16) { failed += 1; return; }
    await writeFile(path.join(DIR, name), bytes);
    got += 1;
  } catch { failed += 1; }
});
const AT_A_TIME = 4;
for (let i = 0; i < jobs.length; i += AT_A_TIME) {
  await Promise.all(jobs.slice(i, i + AT_A_TIME).map((j) => j()));
}
console.log(`${got} levels in ${DIR}, ${failed} could not be fetched`);
console.log(`now: node --experimental-strip-types packages/cwlib-ts/dev/walk-levels.ts ${DIR}`);
// ⚠️ **Nothing else goes in this directory.** An earlier version wrote a
// `.gitignore` here as belt and braces -- `fixtures/` is ignored wholesale
// already -- and `walk-levels.ts` dutifully reported it as "too short to be a
// resource: 2 bytes", which is a reader bug report for two bytes of our own.
