/**
 * The version in `src/version.ts` and the one in `package.json` are the same
 * number, and this is what keeps them that way.
 *
 * ❗ **Two files hold it because neither can hold it alone.** `package.json` is
 * what `npm` and anything reading the repository looks at; `src/version.ts` is
 * what the pages can import without a build step or a runtime `fetch`. The
 * drift between them is the whole risk, and it is exactly the kind that shows up
 * as a stale number in a footer months later.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { APP_VERSION } from '../src/version.ts';

test('the app version matches package.json', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { version: string };
  assert.equal(
    APP_VERSION,
    manifest.version,
    'src/version.ts and package.json disagree — change both, or neither',
  );
  // A version that is not a version would pass the equality and fail everywhere
  // else, so it is worth one line to say what shape it has to be.
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
});
