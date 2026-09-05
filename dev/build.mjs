/**
 * Build the pages into a static site, with no bundler.
 *
 *     node dev/build.mjs [outdir]        default `dist/`
 *
 * The browser cannot strip TypeScript types, so `dev/serve.mjs` does it per
 * request. That is the whole development story and it stops at the machine the
 * server runs on. This does the same job once, ahead of time, so the result is a
 * directory of plain files that any static host — or a bucket — can serve.
 *
 * ❗ **Still no bundler, and that is the point.** Every module keeps its own file
 * and its own imports; the only changes are `stripTypeScriptTypes` and turning
 * `.ts` specifiers into `.js`. What runs in the browser is still the source
 * `node --test` runs, one file at a time, which is the property
 * steering/tracker-architecture.md picked this design for.
 *
 * ## What it walks, and why not just "every .ts"
 *
 * From the four pages, following imports. `dev/` holds Node-only tools as well
 * as page code — `live-sim.ts` and `walk-levels.ts` import `node:fs` — and
 * copying those would ship files that cannot load.
 *
 * ⚠️ **The AudioWorklet module is not statically imported by anything.** It is
 * fetched at runtime by a string, so it is a root here in its own right; miss it
 * and the build succeeds and the player is silent.
 *
 * ## Layout
 *
 * ```
 * dist/
 *   index.html live.html render.html midi.html ui.css
 *   dev/…js      the pages' own modules
 *   src/…js      the engine
 * ```
 *
 * ❗ **Pages at the root and modules under `dev/`**, rather than the dev server's
 * flattening of `dev/` onto the root. It keeps `../src/…` meaning the same thing
 * in both, and it makes the output **relocatable**: every path in it is relative,
 * so `dist/` works at a bucket's root or under a prefix. That is also how it gets
 * tested — the dev server can serve it at `/dist/`.
 *
 * ⚠️ `fixtures/` is not copied and never should be. The manifests and samples are
 * the user's own game data; `dev/assets.ts` fetches them from `../` relative to
 * itself, which is the deployment's own root, and where they come from is the
 * deployment's business. See steering/game-assets.md.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.resolve(ROOT, process.argv[2] ?? 'dist');

/** The pages, and the one module nothing imports. */
const PAGES = ['index.html', 'live.html', 'render.html', 'midi.html'];
const EXTRA_ROOTS = ['src/audio/mixer-worklet.ts'];

/**
 * Every relative specifier in a module.
 *
 * `import`, `export … from` and `import()` all take one, and all three appear in
 * this codebase — the dynamic form in `src/platform/`. Bare specifiers cannot
 * occur: there are no dependencies.
 */
const SPECIFIERS = /(?:from|import)\s*\(?\s*['"](\.[^'"]+\.ts)['"]/g;

/** Turn `.ts` specifiers into `.js`, in code and in worklet paths alike. */
const toJs = (source) => source.replace(/\.ts(['"])/g, '.js$1');

async function collect(entry, seen) {
  const rel = path.relative(ROOT, entry).replace(/\\/g, '/');
  if (seen.has(rel)) return;
  seen.set(rel, null);
  const source = await readFile(entry, 'utf8');
  seen.set(rel, source);
  for (const [, spec] of source.matchAll(SPECIFIERS)) {
    await collect(path.resolve(path.dirname(entry), spec), seen);
  }
}

const modules = new Map();
for (const page of PAGES) {
  const html = await readFile(path.join(ROOT, 'dev', page), 'utf8');
  for (const [, src] of html.matchAll(/<script[^>]+src="\.\/([^"]+\.ts)"/g)) {
    await collect(path.join(ROOT, 'dev', src), modules);
  }
}
for (const extra of EXTRA_ROOTS) await collect(path.join(ROOT, extra), modules);

await mkdir(OUT, { recursive: true });
for (const [rel, source] of modules) {
  const out = path.join(OUT, rel.replace(/\.ts$/, '.js'));
  await mkdir(path.dirname(out), { recursive: true });
  // `mode: 'strip'` keeps every byte that is not a type in place, so a stack
  // trace from the built site still points at the source's own lines.
  await writeFile(out, toJs(stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: rel })));
}

for (const page of PAGES) {
  const html = await readFile(path.join(ROOT, 'dev', page), 'utf8');
  // The page moves up a level and its modules do not, so its own `./x.ts`
  // becomes `./dev/x.js`. Everything else in the file is already relative.
  await writeFile(
    path.join(OUT, page),
    html.replace(/(<script[^>]+src=")\.\/([^"]+)\.ts(")/g, '$1./dev/$2.js$3'),
  );
}
for (const asset of (await readdir(path.join(ROOT, 'dev'))).filter((f) => f.endsWith('.css'))) {
  await writeFile(path.join(OUT, asset), await readFile(path.join(ROOT, 'dev', asset)));
}

const kb = (n) => `${(n / 1024).toFixed(0)} kB`;
let bytes = 0;
for (const source of modules.values()) bytes += source.length;
console.log(`${modules.size} modules (${kb(bytes)} of source) + ${PAGES.length} pages -> ${
  path.relative(ROOT, OUT)}/`);
console.log('serve that directory at any prefix; nothing in it is absolute.');
