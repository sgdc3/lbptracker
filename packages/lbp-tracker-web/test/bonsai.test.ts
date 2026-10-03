/**
 * Opening a level off Bonsai: the pure half of `src/bonsai.ts`.
 *
 * ⚠️ **Everything here reads what a stranger sent.** The box takes whatever a
 * reader pasted and the API answers with whatever a publisher typed, and both
 * end in a fetch URL or on screen, so what the readers REFUSE is as much the
 * point as what they accept.
 *
 * The level below is the shape of a real answer from `lbp.lbpbonsai.com`,
 * `GET /api/v3/levels/id/20091`, taken on 2026-10-04 and cut down to the
 * fields the panel reads plus enough of the rest to be recognisable.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  bonsaiAssetUrl, bonsaiByUserUrl, bonsaiLevelPage, bonsaiSearchUrl, bonsaiUserUrl, levelScore,
  looksLikeName, rankLevels, readAnswer, readBonsaiLevel, readBonsaiPaste, readBonsaiUser,
  readSearch, searchSummary, songlessWhy,
} from '../src/bonsai.ts';

const SHA1 = 'a837ce2d104c89ad944375fee299af3d8f3d6316';

const LEVEL = {
  levelId: 20091,
  publisher: { userId: '69e4c90e4712a33367c6e6ec', username: 'PotatoBoii2', iconHash: '0' },
  isReUpload: false,
  originalPublisher: null,
  isAdventure: false,
  title: "Derelict Dragon's Den (3D)",
  iconHash: '09663ea22d3bf0014e5f771e368e9382d38b9b8b',
  rootLevelHash: SHA1,
  gameVersion: 1,
  hearts: 1,
  slotType: 0,
};

test('a level is read off the answer, and the creator of a reupload is its original one', () => {
  assert.deepEqual(readBonsaiLevel(LEVEL), {
    id: 20091,
    title: "Derelict Dragon's Den (3D)",
    author: 'PotatoBoii2',
    publisher: 'PotatoBoii2',
    original: undefined,
    sha1: SHA1,
    game: 1,
    hearts: 1,
    icon: '09663ea22d3bf0014e5f771e368e9382d38b9b8b',
  });
  const reupload = readBonsaiLevel({ ...LEVEL, isReUpload: true, originalPublisher: 'Adamaniac' });
  assert.equal(reupload?.author, 'Adamaniac');
});

// The root goes into a fetch URL and the icon into an `<img src>`.
test('a level whose root is not a SHA-1 is not a level, and a GUID icon is no icon', () => {
  assert.equal(readBonsaiLevel({ ...LEVEL, rootLevelHash: '../../admin' }), undefined);
  assert.equal(readBonsaiLevel({ ...LEVEL, rootLevelHash: SHA1.slice(1) }), undefined);
  assert.equal(readBonsaiLevel({ ...LEVEL, levelId: 0 }), undefined);
  assert.equal(readBonsaiLevel({ ...LEVEL, levelId: '20091' }), undefined);
  assert.equal(readBonsaiLevel(null), undefined);
  assert.equal(readBonsaiLevel({ ...LEVEL, iconHash: 'g18451' })?.icon, undefined);
  assert.equal(readBonsaiLevel({ ...LEVEL, iconHash: '0' })?.icon, undefined);
  assert.equal(readBonsaiLevel({ ...LEVEL, rootLevelHash: SHA1.toUpperCase() })?.sha1, SHA1);
  assert.equal(readBonsaiLevel({ ...LEVEL, title: '   ' })?.title, 'level 20091');
});

test('the API wraps answers and errors alike, and an error says why', () => {
  assert.deepEqual(readAnswer({ success: true, data: 1 }), { data: 1, next: undefined, total: undefined });
  // The real 404, verbatim.
  const missing = {
    success: false,
    error: { name: 'ApiNotFoundError', message: 'The level could not be found', statusCode: 404 },
  };
  assert.equal(readAnswer(missing).error, 'The level could not be found');
  assert.ok(readAnswer('<html>').error);
});

// Measured on "music gallery", 19 levels, pages of 10: the first page says
// `nextPageIndex: 11`, the second says `0` -- and zero is a valid-looking skip
// that would start the list over.
test('a search page knows where the next one starts, and that the last has none', () => {
  const first = readSearch({ success: true, data: [LEVEL, { bogus: true }], listInfo: { nextPageIndex: 11, totalItems: 19 } });
  assert.equal(first.levels.length, 1, 'an unreadable row is dropped, not shown');
  assert.equal(first.next, 11);
  assert.equal(first.total, 19);
  const last = readSearch({ success: true, data: [LEVEL], listInfo: { nextPageIndex: 0, totalItems: 19 } });
  assert.equal(last.next, undefined);
  assert.equal(readSearch({ success: false, error: { message: 'no' } }).error, 'no');
});

test('the search asks for the two games whose levels open here, one-based', () => {
  const url = new URL(bonsaiSearchUrl('music gallery'));
  assert.equal(url.origin + url.pathname, 'https://lbp.lbpbonsai.com/api/v3/levels/search');
  assert.equal(url.searchParams.get('query'), 'music gallery');
  assert.deepEqual(url.searchParams.getAll('game'), ['lbp2', 'lbp3']);
  assert.equal(url.searchParams.get('skip'), null);
  assert.equal(new URL(bonsaiSearchUrl('x', 21)).searchParams.get('skip'), '21');
});

test('the routes are the ones measured against the live server', () => {
  assert.equal(bonsaiAssetUrl(SHA1), `https://lbp.lbpbonsai.com/api/v3/assets/${SHA1}/download`);
  assert.equal(bonsaiLevelPage(2488), 'https://lbp.lbpbonsai.com/level/2488');
});

test('a level\'s link, its number or its hash opens it; anything else is a search', () => {
  assert.deepEqual(readBonsaiPaste('https://lbp.lbpbonsai.com/level/2488'), { kind: 'id', id: 2488 });
  assert.deepEqual(readBonsaiPaste(' https://lbp.lbpbonsai.com/level/2488/some-title?x=1 '), { kind: 'id', id: 2488 });
  assert.deepEqual(readBonsaiPaste('lbp.lbpbonsai.com/levels/77#comments'), { kind: 'id', id: 77 });
  assert.deepEqual(readBonsaiPaste('2488'), { kind: 'id', id: 2488 });
  assert.deepEqual(readBonsaiPaste('#2488'), { kind: 'id', id: 2488 });
  assert.deepEqual(readBonsaiPaste(SHA1.toUpperCase()), { kind: 'hash', sha1: SHA1 });
  assert.deepEqual(readBonsaiPaste('  music gallery '), { kind: 'words', query: 'music gallery' });
  assert.deepEqual(readBonsaiPaste('level 2'), { kind: 'words', query: 'level 2' });
  assert.deepEqual(readBonsaiPaste(''), { kind: 'empty' });
  // Not a number Refresh could have handed out: an `int`, and positive.
  assert.deepEqual(readBonsaiPaste('0'), { kind: 'words', query: '0' });
  assert.deepEqual(readBonsaiPaste('99999999999'), { kind: 'words', query: '99999999999' });
});

/** A level as the ranking sees it: a title, and who made it. */
const lv = (id: number, title: string, publisher = 'someone', original?: string) =>
  readBonsaiLevel({ ...LEVEL, levelId: id, title, publisher: { username: publisher }, originalPublisher: original ?? null })!;

// Bonsai sorts a search by rating alone and matches descriptions too; these are
// shaped on what "sequencer" and "sonic" really return.
test('a search is ranked by its title first, then by rating', () => {
  const served = [
    lv(1, "Wega's Challenge"), // says "sequencer" in its description only
    lv(2, 'Random Music Sequencer Melodies'),
    lv(3, 'Music Sequencers (LOGANWOOD ARCHIVE)'),
    lv(4, 'Sequencer'),
    lv(5, 'sequencer giveaway'),
  ];
  assert.deepEqual(rankLevels('sequencer', served).map((l) => l.id), [4, 5, 2, 3, 1]);
  // Equal scores keep the server's order, which is the rating.
  assert.deepEqual(rankLevels('music', [lv(7, 'Music Box'), lv(8, 'Music Hall')]).map((l) => l.id), [7, 8]);
  // Capitals and accents do not count, and neither does punctuation.
  assert.equal(levelScore('pokemon', lv(9, 'POKÉMON')), 100);
  assert.equal(levelScore('mario kart', lv(10, 'Mario-Kart Battle!')), 90);
  assert.equal(levelScore('kart mario', lv(10, 'Mario-Kart Battle!')), 60);
});

test('a creator\'s whole name ranks their levels just under a title that starts with it', () => {
  const served = [lv(1, 'Some other level'), lv(2, 'Ocean', 'Subyuko'), lv(3, 'Subyuko\'s Gallery')];
  assert.deepEqual(rankLevels('subyuko', served).map((l) => l.id), [3, 2, 1]);
  assert.equal(levelScore('fattymcintosh', lv(4, 'Giveaway', 'RunninPigeon', 'FattyMcIntosh')), 85);
});

test('only a query shaped like a name is asked about as a creator', () => {
  // Refresh's own `UsernameRegex`: 3 to 16 of letters, digits, `-` and `_`.
  for (const name of ['Subyuko', 'Gr1M_ReAper3334', 'Velvet--Audio', 'abc']) assert.ok(looksLikeName(name), name);
  for (const not of ['music gallery', 'ab', 'a'.repeat(17), 'Pokémon', '!Subyuko']) assert.ok(!looksLikeName(not), not);
  assert.equal(readBonsaiUser({ username: 'Subyuko', userId: '66adb790e35b12aca68ea4e3' }), 'Subyuko');
  assert.equal(readBonsaiUser({ username: '<b>' }), undefined);
  assert.equal(readBonsaiUser(undefined), undefined);
});

test('the creator routes are the ones measured against the live server', () => {
  assert.equal(bonsaiUserUrl('subyuko'), 'https://lbp.lbpbonsai.com/api/v3/users/name/subyuko');
  const reuploads = new URL(bonsaiByUserUrl('!FattyMcIntosh'));
  assert.equal(reuploads.pathname, '/api/v3/levels/byUser');
  assert.equal(reuploads.searchParams.get('username'), '!FattyMcIntosh');
  assert.deepEqual(reuploads.searchParams.getAll('game'), ['lbp2', 'lbp3']);
  assert.equal(reuploads.searchParams.get('count'), '100');
});

test('the line over the results says what came from where', () => {
  assert.equal(searchSummary('sonic', 133), '133 levels for “sonic”');
  assert.equal(searchSummary('subyuko', 2, { name: 'Subyuko', count: 19 }), '19 levels by Subyuko, and 2 levels for “subyuko”');
  assert.equal(searchSummary('subyuko', 0, { name: 'Subyuko', count: 1 }), '1 level by Subyuko');
  assert.equal(searchSummary('zzz', 0), 'nothing on Bonsai for “zzz”');
});

test('a game with no music sequencer is refused before anything is downloaded', () => {
  assert.match(songlessWhy({ game: 0, title: 'Super Mario PS3' }) ?? '', /^LBP1 has no music sequencer/);
  assert.match(songlessWhy({ game: 4, title: 'x' }) ?? '', /^LBP PSP/);
  assert.equal(songlessWhy({ game: 1, title: 'x' }), undefined);
  assert.equal(songlessWhy({ game: 2, title: 'x' }), undefined);
  // Vita has a sequencer, so it is tried: the reader says what goes wrong.
  assert.equal(songlessWhy({ game: 3, title: 'x' }), undefined);
});
