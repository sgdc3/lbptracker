/**
 * What a link to a song says, read back: `src/link.ts`.
 *
 * ⚠️ **Both values reach something that cannot take rubbish** -- the hash
 * goes into a fetch URL and the uid into a map key -- so what the parsers
 * REFUSE is as much the point here as what they accept.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { levelFromQuery, pickWanted, sameLevel, songFromQuery } from '../src/link.ts';
import { matches, uidLabel } from '../src/widgets/picker-state.ts';

const SHA1 = '8febe1f91343b2b97843530297d54df113043b89';

// The shareable link: `?level=<sha1>` is the hash and nothing else, and the
// walk rides along because it changes what the link opens.
test('a level link carries a hash, and a bad one is no level at all', () => {
  const sha1 = SHA1;
  const from = 'archive';
  assert.deepEqual(levelFromQuery(`?level=${sha1.toUpperCase()}`), { from, sha1, deep: false });
  assert.deepEqual(levelFromQuery(`?level=${sha1}&deep=1`), { from, sha1, deep: true });
  assert.deepEqual(levelFromQuery(`?level=${sha1}&deep=0`), { from, sha1, deep: false });
  assert.equal(levelFromQuery(''), undefined);
  assert.equal(levelFromQuery('?level=deadbeef'), undefined);
  assert.equal(levelFromQuery(`?level=${sha1}0`), undefined);
});

// A Bonsai level is named by the number in its page's address, which goes
// into a fetch URL like the hash does.
test('a Bonsai link carries a level number, and nothing else is one', () => {
  const from = 'bonsai';
  assert.deepEqual(levelFromQuery('?bonsai=2488'), { from, id: 2488, deep: false });
  assert.deepEqual(levelFromQuery('?bonsai=2488&deep=1&seq=7'), { from, id: 2488, deep: true });
  for (const bad of ['0', '-3', '2488x', '1e3', '0x10', '99999999999', '2147483648', '']) {
    assert.equal(levelFromQuery(`?bonsai=${bad}`), undefined, bad);
  }
  assert.deepEqual(levelFromQuery('?bonsai=2147483647'), { from, id: 2147483647, deep: false });
});

// The page never writes both; one written by hand reads the same whichever
// order its parameters were typed in.
test('a link naming both stores is the archive\'s', () => {
  const want = { from: 'archive', sha1: SHA1, deep: false };
  assert.deepEqual(levelFromQuery(`?bonsai=2488&level=${SHA1}`), want);
  assert.deepEqual(levelFromQuery(`?level=${SHA1}&bonsai=2488`), want);
});

test('two links are the same level when the store and its name agree, walk or no walk', () => {
  const archive = { from: 'archive', sha1: SHA1, deep: false } as const;
  const bonsai = { from: 'bonsai', id: 2488, deep: false } as const;
  assert.ok(sameLevel(archive, { ...archive, deep: true }));
  assert.ok(sameLevel(bonsai, { ...bonsai, deep: true }));
  assert.ok(!sameLevel(bonsai, { ...bonsai, id: 2489 }));
  assert.ok(!sameLevel(archive, bonsai));
  assert.ok(!sameLevel(undefined, bonsai));
});

// A uid is what the picker's rows are keyed on inside one level; a backup of
// several levels can repeat one, and then the file has to go in the link too.
test('a song is named by its uid, or by its file and uid together', () => {
  assert.deepEqual(songFromQuery('?seq=7'), { uid: 7 });
  assert.deepEqual(songFromQuery(`?seq=${SHA1}%237`), { key: `${SHA1}#7` });
  assert.equal(songFromQuery(''), undefined);
  assert.equal(songFromQuery('?seq='), undefined);
  assert.equal(songFromQuery('?seq=seven'), undefined);
  assert.equal(songFromQuery('?seq=-1'), undefined);
  assert.equal(songFromQuery('?seq=1.5'), undefined);
});

test('the wanted row is found by uid, by key, or not at all', () => {
  const rows = [
    { key: 'a#7', uid: 7 },
    { key: 'b#3', uid: 3 },
  ];
  assert.equal(pickWanted(rows, { uid: 3 }), rows[1]);
  assert.equal(pickWanted(rows, { key: 'a#7' }), rows[0]);
  assert.equal(pickWanted(rows, { uid: 9 }), undefined);
  assert.equal(pickWanted(rows, undefined), undefined);
});

// The picker's rows now carry the uid, because that is what a link names a song
// by; a reader who copies it back into the search box has to find it again.
test('a row is found by its uid, from the start of the number', () => {
  const row = { key: 'a#9819', name: 'Intro', tracks: 3, uid: 9819 };
  assert.ok(matches(row, '9819'));
  assert.ok(matches(row, '#9819'));
  assert.ok(matches(row, '98'));
  assert.ok(matches(row, 'intro'));
  assert.ok(matches(row, ''));
  assert.ok(!matches(row, '819'));
  assert.ok(!matches(row, '1234'));
  assert.ok(!matches({ key: 'a#1', name: 'Intro', tracks: 3 }, '1'));
  assert.equal(uidLabel(row), '#9819');
  assert.equal(uidLabel({ key: 'a', name: 'Intro', tracks: 3 }), '');
});
