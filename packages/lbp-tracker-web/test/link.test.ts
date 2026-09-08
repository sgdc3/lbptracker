/**
 * What a link to a song says, read back: `src/link.ts`.
 *
 * ⚠️ **Both values reach something that cannot take rubbish** -- the hash
 * goes into a fetch URL and the uid into a map key -- so what the parsers
 * REFUSE is as much the point here as what they accept.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { levelFromQuery, pickWanted, songFromQuery } from '../src/link.ts';
import { matches, uidLabel } from '../src/widgets/picker-state.ts';

const SHA1 = '8febe1f91343b2b97843530297d54df113043b89';

// The shareable link: `?level=<sha1>` is the hash and nothing else, and the
// walk rides along because it changes what the link opens.
test('a level link carries a hash, and a bad one is no level at all', () => {
  const sha1 = SHA1;
  assert.deepEqual(levelFromQuery(`?level=${sha1.toUpperCase()}`), { sha1, deep: false });
  assert.deepEqual(levelFromQuery(`?level=${sha1}&deep=1`), { sha1, deep: true });
  assert.deepEqual(levelFromQuery(`?level=${sha1}&deep=0`), { sha1, deep: false });
  assert.equal(levelFromQuery(''), undefined);
  assert.equal(levelFromQuery('?level=deadbeef'), undefined);
  assert.equal(levelFromQuery(`?level=${sha1}0`), undefined);
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
