/**
 * Typecheck this package, `.vue` files included.
 *
 *     node packages/lbp-tracker-web/dev/typecheck.mjs [tsc args]
 *
 * ⚠️ **`vue-tsc` cannot run on the repository's own TypeScript.** `typescript@7`
 * is the **native** compiler — its package ships `getExePath.js` and a Go binary,
 * with no `lib/tsc.js` and no JavaScript API — and Volar, which is what puts
 * `.vue` files in front of the checker, patches that API. Running `vue-tsc`
 * against it fails with `ERR_PACKAGE_PATH_NOT_EXPORTED: './lib/tsc'`, which
 * reads like a broken install rather than a missing feature.
 *
 * ❗ **`typescript-native-bridge` is the way round it**, and it keeps the native
 * engine: a TypeScript fork carrying a `tsgoChecker` overlay, so the JavaScript
 * API Volar needs is there while the checking is still done by tsgo — pinned, in
 * the version installed here, to the same **7.0.2** the two libraries use. It
 * prints `TNB ACTIVE` when it takes over. An earlier pass here used an aliased
 * TypeScript 5.9 instead; the bridge replaced it on 2026-09-06.
 *
 * ⚠️ **It is a third-party fork, not Microsoft's**, by Volar's own author and
 * days old at the time of writing. That is why it checks **this package only**:
 * `cwlib-ts` and `lbp-tracker-lib` are checked by `tsc -p` against the real
 * `typescript`, so a fault in the bridge cannot quietly change what the two
 * libraries are held to. It is a devDependency and reaches nothing that ships.
 *
 * ⚠️ **An exit code of 0 from a checker means nothing on its own.** This setup
 * was accepted only after it was made to fail: a `const x: number = string` in
 * `Fader.vue` and a `max: 'oops'` in a spec both came back as TS2322, from the
 * `.vue` and the `.ts` alike.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.resolve(fileURLToPath(new URL('.', import.meta.url)));

// Default to this package unless the caller says otherwise, so the script is
// `node …/typecheck.mjs` from anywhere in the repository.
if (!process.argv.slice(2).some((a) => a === '-p' || a === '--project')) {
  process.argv.push('-p', path.join(HERE, '..'));
}

require('vue-tsc').run(require.resolve('typescript-native-bridge/lib/tsc'));
