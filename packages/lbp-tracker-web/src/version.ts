/**
 * The app's version, read from this package's manifest.
 *
 * ❗ **`package.json` is the one source.** Node imports JSON natively and Vite
 * inlines it at build time, so the same import works under `node --test` and in
 * the bundle, and nothing on the page needs a runtime `fetch`. An earlier pass
 * kept a duplicate constant here because the pages ran unbundled; the bundler's
 * arrival (2026-09-06) made that duplicate a drift waiting to happen.
 *
 * ⚠️ **The import must stay a default import.** Node's JSON modules have no
 * named exports, so `import { version } from …` loads in Vite and fails under
 * `node --test`, which is exactly the kind of split this project must not have.
 *
 * ⚠️ **The bundle carries the whole manifest, not just the version** — measured
 * in the built footer chunk on 2026-09-06: Rolldown inlines the object and does
 * not shake a default JSON import down to one property. It is ~300 bytes of a
 * private package's name, scripts and dependency ranges, none of it secret.
 *
 * `packages/lbp-tracker-web/test/version.test.ts` fails if the repository
 * root's `package.json` disagrees with this one.
 */
import manifest from '../package.json' with { type: 'json' };

export const APP_VERSION: string = manifest.version;
