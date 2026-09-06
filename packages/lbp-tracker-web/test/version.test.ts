/**
 * The version the pages show and the one in the repository root's
 * `package.json` are the same number, and this is what keeps them that way.
 *
 * ❗ **Two manifests hold it because neither can hold it alone.** The web
 * package's is what `packages/lbp-tracker-web/src/version.ts` imports, so the
 * footer reads it; the root's is what a reader of the repository sees first.
 * The drift between them is the whole risk, and it is exactly the kind that
 * shows up as a stale number in a footer months later.
 *
 * ⚠️ The root manifest is resolved against this file rather than the working
 * directory — `node --test` runs from the root, but `npm test -w` does not,
 * and a `readFile('package.json')` would then read a different manifest and
 * still pass.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { APP_VERSION } from '../src/version.ts';

const manifest = async (from: string): Promise<string> =>
  (JSON.parse(await readFile(new URL(from, import.meta.url), 'utf8')) as { version: string })
    .version;

test('the app version matches package.json', async () => {
  assert.equal(
    APP_VERSION,
    await manifest('../../../package.json'),
    'packages/lbp-tracker-web/package.json and the repository root\'s disagree — change both, or neither',
  );
  // A version that is not a version would pass the equality and fail everywhere
  // else, so it is worth one line to say what shape it has to be.
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});
