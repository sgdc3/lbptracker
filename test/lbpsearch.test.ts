/**
 * The archive search reader, pinned against the site's real HTML.
 *
 * ⚠️ **These fixtures are trimmed copies of what <https://zaprit.fish> served
 * on 2026-09-05**, entities and all. They are here rather than in `fixtures/`
 * because they are three hundred bytes of somebody's public HTML, not a game
 * asset, and because a parser that reads a live site needs its input frozen
 * somewhere or the test only proves the site was up.
 *
 * If the site is redesigned these fail, and that is the point: the failure says
 * exactly which shape stopped being true.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeEntities, parseSearch, parseSlot, rootLevelUrl, searchUrl,
} from '../dev/lbpsearch.ts';

/** Two rows and a next-page link, in the template's own markup. */
const SEARCH = `
  <h2 class="header">Found Levels In 28ms</h2>
  <table>
    <tr>
      <th>Icon</th><th>Level ID</th><th>Level Name</th><th>Level Uploader</th>
      <th>Level Description</th><th>Uploaded In</th><th>First Published</th>
      <th>Last Updated</th><th>Heart Count (approximate)</th><th>Background ID</th>
    </tr>
    <tr>
      <td><a class="table-link" href="/slot/44229280">
        <img class="table-icon" src="/icon/0000e730" alt="the level icon" loading="lazy"/>
      </a></td>
      <td><a class="table-link" href="/slot/44229280">44229280</a></td>
      <td><a class="table-link" href="/slot/44229280">Music Gallery #3</a></td>
      <td><a class="table-link" href="/user/Hug-Of-War">Hug-Of-War</a></td>
      <td><a class="table-link" href="/slot/44229280">Tunes &amp; noise &#34;v2&#34;</a></td>
      <td><a class="table-link" href="/slot/44229280">LittleBigPlanet 3 PS4/PS5</a></td>
      <td><a class="table-link" href="/slot/44229280">2015-01-11 03:22:41</a></td>
      <td><a class="table-link" href="/slot/44229280">2016-08-16 08:36:35</a></td>
      <td><a class="table-link" href="/slot/44229280">1326</a></td>
      <td><a class="table-link" href="/slot/44229280">34408</a></td>
    </tr>
    <tr>
      <td><a class="table-link" href="/slot/1017"><img src="/icon/" /></a></td>
      <td><a class="table-link" href="/slot/1017">1017</a></td>
      <td><a class="table-link" href="/slot/1017">Metarub&#251;mu &lt;JP&gt;</a></td>
      <td><a class="table-link" href="/user/machiku86">machiku86</a></td>
      <td><a class="table-link" href="/slot/1017"></a></td>
      <td><a class="table-link" href="/slot/1017">LittleBigPlanet</a></td>
      <td><a class="table-link" href="/slot/1017">2009-04-19 12:41:48</a></td>
      <td><a class="table-link" href="/slot/1017">2010-08-16 08:36:35</a></td>
      <td><a class="table-link" href="/slot/1017">4</a></td>
      <td><a class="table-link" href="/slot/1017">34408</a></td>
    </tr>
  </table>
  <span>Page 0</span>
  <a href="/search?s=music&page=0">Previous Page</a>
  <a href="/search?s=music&page=2">Next Page</a>
`;

/** The same page with both pagers greyed out, as the last page renders. */
const LAST_PAGE = SEARCH
  .replace('<a href="/search?s=music&page=2">Next Page</a>', '<span style="color: gray">Next Page</span>');

const SLOT = `
  <h1 class="header">Music Gallery #3</h1>
  <h2 class="header">By <img class="avatar" alt="user avatar" src="/icon/">
    <a href="/user/Hug-Of-War">Hug-Of-War</a></h2>
  <div>
    <span class="code">8febe1f91343b2b97843530297d54df113043b89</span>
  </div>
  <a href="https://archive.org/download/dry23r8/dry8f.zip/8f%2Feb%2F8febe1f91343b2b97843530297d54df113043b89">Download RootLevel</a>
`;

const MISSING = SLOT.replace(
  '<div>',
  '<div class="toast"><h2>Missing Root Level</h2><p>The Root Level for this level is known to be missing</p></div><div>',
);

test('a search page yields its rows, with the escaping undone', () => {
  const { rows, more } = parseSearch(SEARCH);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: 44229280,
    name: 'Music Gallery #3',
    author: 'Hug-Of-War',
    description: 'Tunes & noise "v2"',
    game: 'LittleBigPlanet 3 PS4/PS5',
    hearts: 1326,
    firstPublished: '2015-01-11 03:22:41',
    lastUpdated: '2016-08-16 08:36:35',
  });
  // A level name is the one field that can hold anything at all.
  assert.equal(rows[1].name, 'Metarubûmu <JP>');
  assert.equal(rows[1].description, '');
  assert.equal(rows[1].hearts, 4);
  assert.equal(more, true);
});

// The header row has `<th>` and no `<td>`, and the previous-page anchor has the
// same shape as the next-page one. Both have been mistaken for the other thing.
test('the header row is not a result and Previous Page is not Next Page', () => {
  assert.equal(parseSearch(LAST_PAGE).rows.length, 2);
  assert.equal(parseSearch(LAST_PAGE).more, false);
  assert.deepEqual(parseSearch('<table><tr><th>Level ID</th></tr></table>'), {
    rows: [],
    more: false,
  });
});

test('a slot page yields the root level hash and where its bytes are', () => {
  const slot = parseSlot(SLOT, 44229280);
  assert.ok(slot);
  assert.equal(slot.sha1, '8febe1f91343b2b97843530297d54df113043b89');
  assert.equal(slot.name, 'Music Gallery #3');
  assert.equal(slot.author, 'Hug-Of-War');
  assert.equal(slot.missing, false);
  // Exactly the href the site's own "Download RootLevel" link carries, which
  // is what makes it safe for the page to build this without asking.
  assert.ok(SLOT.includes(`href="${slot.url}"`));
  assert.equal(parseSlot(MISSING, 44229280)?.missing, true);
  assert.equal(parseSlot('<h1>nothing here</h1>', 1), undefined);
});

// ⚠️ Zero-based, and the site's own printed page number disagrees: see
// `searchUrl`. Getting this wrong shows every page twice.
test('the first page carries no page parameter and the second carries 1', () => {
  assert.equal(searchUrl('cake'), 'https://zaprit.fish/search?s=cake&sort=hearts');
  assert.equal(searchUrl('cake', 1), 'https://zaprit.fish/search?s=cake&sort=hearts&page=1');
  assert.equal(
    searchUrl('a b', 0, 'name', true),
    'https://zaprit.fish/search?s=a+b&sort=name&invert=on',
  );
});

test('the archive URL is sharded by the first two hex digits', () => {
  assert.equal(
    rootLevelUrl('F28EFF9378955C668E84E87F5B7CE641B6996F67'),
    'https://archive.org/download/dry23rf/dryf2.zip/f2%2F8e%2Ff28eff9378955c668e84e87f5b7ce641b6996f67',
  );
});

test('an entity this site never emits is left exactly as it was', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#34;d&#39;'), `a & b <c> "d'`);
  assert.equal(decodeEntities('&hearts; &#x2665;'), '&hearts; ♥');
});
