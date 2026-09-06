/**
 * The version in `packages/lbp-tracker-web/src/version.ts` and the one in `package.json` are the same
 * number, and this is what keeps them that way.
 *
 * ❗ **Two files hold it because neither can hold it alone.** `package.json` is
 * what `npm` and anything reading the repository looks at; `packages/lbp-tracker-web/src/version.ts` is
 * what the pages can import without a runtime `fetch`. The drift between them is
 * the whole risk, and it is exactly the kind that shows up as a stale number in a
 * footer months later.
 *
 * ⚠️ **Since the monorepo there are two manifests to agree with**, and both are
 * checked: this package's, which owns `version.ts`, and the repository root's,
 * which is what a reader sees first. They are also resolved against this file
 * rather than the working directory — `node --test` runs from the root, but a
 * `npm test -w` does not, and a `readFile('package.json')` would then read a
 * different manifest and still pass.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { APP_VERSION } from '../src/version.ts';

const manifest = async (from: string): Promise<string> =>
  (JSON.parse(await readFile(new URL(from, import.meta.url), 'utf8')) as { version: string })
    .version;

test('the app version matches package.json', async () => {
  for (const [where, file] of [
    ['this package', '../package.json'],
    ['the repository root', '../../../package.json'],
  ] as const) {
    assert.equal(
      APP_VERSION,
      await manifest(file),
      `packages/lbp-tracker-web/src/version.ts and ${where}'s package.json disagree — change both, or neither`,
    );
  }
  // A version that is not a version would pass the equality and fail everywhere
  // else, so it is worth one line to say what shape it has to be.
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});
