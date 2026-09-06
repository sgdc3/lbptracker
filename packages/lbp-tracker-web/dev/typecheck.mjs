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
 * So the repository carries **two** compilers, deliberately and narrowly:
 *
 * | | |
 * |---|---|
 * | `typescript` (7, native) | `cwlib-ts` and `lbp-tracker-lib`, plain `tsc -p` |
 * | `typescript5` (an npm alias for 5.9) | this package only, through `vue-tsc` |
 *
 * ❗ **The alias is the whole trick.** `vue-tsc` resolves `typescript/lib/tsc`
 * from its own directory, so a nested install would not reach it and the two
 * versions cannot both be called `typescript`. `run()` takes the path instead,
 * which is a supported entry point rather than a patch.
 *
 * When Volar supports the native compiler this file and the `typescript5`
 * devDependency both go away, and `npm run typecheck` goes back to three `tsc`s.
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

require('vue-tsc').run(require.resolve('typescript5/lib/tsc'));
