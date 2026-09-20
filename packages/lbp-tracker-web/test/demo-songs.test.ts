import { strict as assert } from 'node:assert';
import test from 'node:test';

import { DEMO_SONGS, pickDemo } from '../src/demo-songs.ts';
import { levelFromQuery, songFromQuery } from '../src/link.ts';

test('every demo is a link the page can follow, and none is listed twice', () => {
  const seen = new Set<string>();
  for (const demo of DEMO_SONGS) {
    const search = `?level=${demo.level}&seq=${demo.uid}`;
    assert.deepEqual(levelFromQuery(search), { sha1: demo.level, deep: false });
    assert.deepEqual(songFromQuery(search), { uid: demo.uid });
    seen.add(search);
  }
  assert.equal(seen.size, DEMO_SONGS.length);
});

test('the dice never land on the song just played, and reach both ends of the list', () => {
  const [first, second] = DEMO_SONGS;
  assert.equal(pickDemo(undefined, () => 0), first);
  assert.equal(pickDemo(first, () => 0), second);
  assert.equal(pickDemo(undefined, () => 0.999999), DEMO_SONGS[DEMO_SONGS.length - 1]);
  for (let i = 0; i < 200; i += 1) assert.notEqual(pickDemo(first), first);
  assert.equal(pickDemo(first, () => 0, [first]), first, 'a list of one has nothing else to give');
});
