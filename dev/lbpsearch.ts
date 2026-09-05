/**
 * A reader for the LBP archive search at <https://zaprit.fish>.
 *
 * The Mm servers were shut down in 2021 and the levels survive as an
 * Internet Archive dump of the official server's resource store, indexed by
 * Zaprit's "LBP Search Facility" (<https://github.com/Zaprit/LBPSearch>). That
 * is where a listener without a PS3 backup of their own gets a song to open.
 *
 * ❗ **There is no API; this reads the HTML.** The site is Go `html/template`
 * rendering a fixed table (`pkg/website_old/templates/index.html`), so the
 * shape is stable and the escaping is Go's, which is why `decodeEntities`
 * below is as short as it is. If a redesign breaks these, the test pins what
 * they were reading and the fix is visible in one diff.
 *
 * ⚠️ **Two hosts, and only one of them is fetched by the browser.**
 *
 * - `zaprit.fish` sends **no CORS headers**, so a page cannot read it. It is
 *   fetched by `dev/serve.mjs`, which parses it here and returns JSON. Only
 *   the listener's own search words go out.
 * - `archive.org` sends `Access-Control-Allow-Origin`, so **the level itself is
 *   fetched by the page, straight from the archive** -- it never passes through
 *   the dev server, which keeps the promise in `serve.mjs` that no level ever
 *   does. Verified: a 339 KB `LVLb` fetched this way parses into 31 sequencers.
 *
 * ❗ Everything here is pure text-in, text-out, so `dev/serve.mjs` (Node) and
 * `test/lbpsearch.test.ts` run exactly the same code.
 */

/** Where the index lives. */
export const SEARCH_HOST = 'https://zaprit.fish';

/** How the site orders results. Its own three, spelled its way. */
export type SearchSort = 'hearts' | 'name' | 'author';

/** One level in a result page. Strings are already unescaped. */
export interface ArchiveRow {
  readonly id: number;
  readonly name: string;
  readonly author: string;
  readonly description: string;
  /** "LittleBigPlanet 2", "LittleBigPlanet 3 PS4/PS5"... the site's own words. */
  readonly game: string;
  readonly hearts: number;
  readonly firstPublished: string;
  readonly lastUpdated: string;
}

export interface ArchiveSearch {
  readonly rows: readonly ArchiveRow[];
  /** Whether the site offered a next page. */
  readonly more: boolean;
}

/** A level's own page, which is the only place the root level's hash appears. */
export interface ArchiveSlot {
  readonly id: number;
  readonly name: string;
  readonly author: string;
  readonly sha1: string;
  /** The site's own warning that the archive is missing this level's bytes. */
  readonly missing: boolean;
  /** Where the bytes are, on archive.org. */
  readonly url: string;
}

/**
 * Undo the escaping a Go template applied.
 *
 * ⚠️ **This is not a general HTML entity decoder and does not need to be.**
 * `html/template` escapes text nodes to exactly `&amp;`, `&lt;`, `&gt;`,
 * `&#34;`, `&#39;`, and leaves everything else -- accents, kana, emoji, all of
 * which LBP level names are full of -- as UTF-8. The numeric forms are handled
 * generally anyway, because they cost two lines.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    const named: Record<string, string> = {
      amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    };
    return named[body.toLowerCase()] ?? whole;
  });
}

/** A cell's visible text: tags dropped, entities undone, whitespace squeezed. */
const textOf = (html: string): string =>
  decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/**
 * The search URL for a query, as the site's own form would have built it.
 *
 * ⚠️ **`page` is ZERO-based**, because the handler's offset is `page * 50` and
 * the first page is `page=0`. The number the site *prints* is not a reliable
 * guide to this: `SearchHandler` sets `Page` to `page + 1` and then overwrites
 * it with `page` whenever the page is full, so a full first page renders
 * "Page 0" and a short one renders "Page 1". That is upstream's bug and it is
 * why `parseSearch` does not report a page number at all -- the caller knows
 * which page it asked for, and that is the only trustworthy answer.
 */
export function searchUrl(
  query: string,
  page = 0,
  sort: SearchSort = 'hearts',
  invert = false,
): string {
  const params = new URLSearchParams({ s: query, sort });
  // The form posts the checkbox only when it is ticked, and the handler tests
  // for the parameter rather than its value.
  if (invert) params.set('invert', 'on');
  if (page > 0) params.set('page', String(page));
  return `${SEARCH_HOST}/search?${params}`;
}

/** A level's own page. */
export const slotUrl = (id: number): string => `${SEARCH_HOST}/slot/${id}`;

/**
 * Where a root level's bytes are in the Internet Archive.
 *
 * ❗ **A pure function of the hash**, which is why the page can build it
 * without asking anyone. Reproduced from `SlotHandler` in `handlers.go`:
 * the dump is sharded into `dry23r<first hex digit>` items holding
 * `dry<first two>.zip`, and inside the zip the file is at `aa/bb/<sha1>`.
 */
export function rootLevelUrl(sha1: string): string {
  const h = sha1.toLowerCase();
  const inZip = `${h.slice(0, 2)}%2F${h.slice(2, 4)}%2F${h}`;
  return `https://archive.org/download/dry23r${h[0]}/dry${h.slice(0, 2)}.zip/${inZip}`;
}

/**
 * What a listener typed: words to search for, a level to open, or a hash.
 *
 * ❗ **The hash is the one that needs no server at all.** `rootLevelUrl` is a
 * pure function and archive.org answers any origin, so a page with no proxy
 * behind it can still open a level -- the listener searches on zaprit.fish
 * itself and copies the 40 hex digits the level page shows. That is the whole
 * static-hosting story; see the note in `dev/archive-panel.ts`.
 *
 * A bare number is **words**, not a slot id: "1017" is a plausible level name
 * and guessing otherwise would silently open the wrong thing.
 */
export type Typed =
  | { readonly kind: 'hash'; readonly sha1: string }
  | { readonly kind: 'slot'; readonly id: number }
  | { readonly kind: 'words'; readonly words: string };

export function readQuery(text: string): Typed {
  const trimmed = text.trim();
  const slot = /\/slot\/(\d+)/.exec(trimmed);
  if (slot) return { kind: 'slot', id: Number(slot[1]) };
  // ⚠️ **The hash is what the text ENDS with, not a run found inside it.** A
  // word boundary cannot find one in `…eb%2F8febe1f9…`: the character before it
  // is the `F` of `%2F`, itself a hex digit, so `\b` fails there and a
  // backtracking match lands on a 40-digit window that is off by two. Taking the
  // last segment handles the bare hash and a pasted archive.org URL alike.
  const tail = trimmed.split(/[/\?#=]|%2F/i).pop() ?? '';
  if (/^[0-9a-f]{40}$/i.test(tail)) return { kind: 'hash', sha1: tail.toLowerCase() };
  return { kind: 'words', words: trimmed };
}

/**
 * Rows out of a search page.
 *
 * The table's ten columns are fixed by the template and are, in order: icon,
 * id, name, uploader, description, uploaded in, first published, last updated,
 * hearts, background. The header row is the one with no `<td>` in it.
 */
export function parseSearch(html: string): ArchiveSearch {
  const rows: ArchiveRow[] = [];
  for (const [, inner] of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = [...inner.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 10) continue;
    const id = Number(/href="\/slot\/(\d+)"/.exec(inner)?.[1]);
    if (!Number.isFinite(id)) continue;
    rows.push({
      id,
      name: textOf(cells[2]),
      author: textOf(cells[3]),
      description: textOf(cells[4]),
      game: textOf(cells[5]),
      hearts: Number(textOf(cells[8])) || 0,
      firstPublished: textOf(cells[6]),
      lastUpdated: textOf(cells[7]),
    });
  }
  return {
    rows,
    // The template renders a grey `<span>` instead of the link on the last
    // page, so an anchor whose text is "Next Page" is the whole test. The
    // "Previous Page" anchor has the same shape, hence matching the text too.
    more: /<a href="\/search\?[^"]*page=\d+"[^>]*>\s*Next Page/.test(html),
  };
}

/** A level's page, or `undefined` if it carries no root level hash. */
export function parseSlot(html: string, id: number): ArchiveSlot | undefined {
  const sha1 = /<span class="code">([0-9a-f]{40})<\/span>/i.exec(html)?.[1];
  if (!sha1) return undefined;
  return {
    id,
    name: textOf(/<h1 class="header">([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? ''),
    author: textOf(/<a href="\/user\/[^"]*">([\s\S]*?)<\/a>/.exec(html)?.[1] ?? ''),
    sha1: sha1.toLowerCase(),
    // The site knows which hashes the archive never got, and says so in a
    // toast. Worth passing on: the download would 404 and the page can say why.
    missing: /Missing Root Level/.test(html),
    url: rootLevelUrl(sha1),
  };
}
