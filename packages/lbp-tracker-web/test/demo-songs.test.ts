import { strict as assert } from 'node:assert';
import test from 'node:test';

import { DEMO_SONGS, demoDeck, type DemoSong } from '../src/demo-songs.ts';
import { levelFromQuery, songFromQuery } from '../src/link.ts';

test('every demo is a link the page can follow, and none is listed twice', () => {
  const seen = new Set<string>();
  for (const demo of DEMO_SONGS) {
    const search = `?level=${demo.level}&seq=${demo.uid}`;
    assert.deepEqual(levelFromQuery(search), { from: 'archive', sha1: demo.level, deep: false });
    assert.deepEqual(songFromQuery(search), { uid: demo.uid });
    seen.add(search);
  }
  assert.equal(seen.size, DEMO_SONGS.length);
});

const key = (s: DemoSong) => `${s.level}#${s.uid}`;

test('the deck deals every song once before any comes round again', () => {
  const deal = demoDeck();
  for (let round = 0; round < 3; round += 1) {
    const dealt = Array.from(DEMO_SONGS, () => key(deal()));
    assert.equal(new Set(dealt).size, DEMO_SONGS.length, `round ${round} repeated a song`);
  }
});

// The seam between two shuffles is where a deck can still repeat itself: the
// last card of one and the first of the next. A die that always rolls the
// same face stacks every reshuffle identically, which is the worst case.
test('no song follows itself, not even across a reshuffle', () => {
  for (const roll of [0, 0.5, 0.999999]) {
    const deal = demoDeck(DEMO_SONGS, () => roll);
    let before = key(deal());
    for (let i = 1; i < DEMO_SONGS.length * 4; i += 1) {
      const now = key(deal());
      assert.notEqual(now, before, `roll ${roll}, deal ${i}`);
      before = now;
    }
  }
  // Stacked so that the second shuffle would put the song just dealt on top:
  // with two songs the first roll keeps the order [a, b] (dealing b, then a)
  // and the second swaps it to [b, a], whose top is a again.
  const [a, b] = DEMO_SONGS;
  const rolls = [0.9, 0.1];
  const two = demoDeck([a, b], () => rolls.shift() ?? 0.9);
  assert.deepEqual([two(), two(), two()].map(key), [b, a, b].map(key));

  const [only] = DEMO_SONGS;
  const one = demoDeck([only]);
  assert.equal(one(), only);
  assert.equal(one(), only, 'a list of one has nothing else to give');
});
