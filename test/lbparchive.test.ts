/**
 * Opening an archived level by its hash: the two pure functions behind it.
 *
 * ⚠️ **`rootLevelUrl` must keep agreeing with the site's own download link**,
 * because that is the only thing that makes it safe to build the URL here
 * instead of asking. The expectation below is a real link copied from
 * <https://zaprit.fish> on 2026-09-05; if the archive is ever re-sharded this
 * fails, which is the point.
 *
 * ❗ This file used to also pin an HTML scraper for the site's search results.
 * The search was removed on 2026-09-05 -- it needed a proxy through the dev
 * server, and the whole appeal of the hash is that nothing needs a server. The
 * scraper and its fixtures are in the history if they are ever wanted again.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readPaste, rootLevelUrl } from '../dev/lbparchive.ts';

test('the archive URL is sharded by the first two hex digits', () => {
  assert.equal(
    rootLevelUrl('F28EFF9378955C668E84E87F5B7CE641B6996F67'),
    'https://archive.org/download/dry23rf/dryf2.zip/f2%2F8e%2Ff28eff9378955c668e84e87f5b7ce641b6996f67',
  );
});

// ⚠️ `\b` cannot find a hash in `…eb%2F8febe1f9…`: the character before it is
// the `F` of `%2F`, itself a hex digit, so the boundary fails there and a
// backtracking match lands on a 40-digit window two characters off. That is why
// it is the last path segment and not a run found inside the text.
test('a hash is recognised bare, upper-cased, or at the end of a pasted URL', () => {
  const sha1 = '8febe1f91343b2b97843530297d54df113043b89';
  assert.deepEqual(readPaste(`  ${sha1.toUpperCase()} `), { kind: 'hash', sha1 });
  assert.deepEqual(readPaste(rootLevelUrl(sha1)), { kind: 'hash', sha1 });
});

// A level's page is recognised only so the box can say what to do with it: the
// hash is on that page, the page sends no CORS headers, and following it is the
// server round trip this field exists to avoid.
test('a level link is told apart from a hash, and from nonsense', () => {
  assert.deepEqual(readPaste('https://zaprit.fish/slot/44229280'), { kind: 'link', id: 44229280 });
  assert.deepEqual(readPaste('music gallery'), { kind: 'neither' });
  assert.deepEqual(readPaste(''), { kind: 'neither' });
});

test('39 digits, 41 digits and a hex-looking word are not hashes', () => {
  const sha1 = '8febe1f91343b2b97843530297d54df113043b89';
  assert.equal(readPaste(sha1.slice(1)).kind, 'neither');
  assert.equal(readPaste(`${sha1}0`).kind, 'neither');
  assert.equal(readPaste('deadbeef').kind, 'neither');
});
