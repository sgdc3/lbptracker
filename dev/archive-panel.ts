/**
 * The third way to open a song: search the LBP archive instead of your disk.
 *
 * "Open a file" and "open a folder" both assume a listener already has a PS3
 * backup. Most do not. The official servers are gone, but every level published
 * to them survives in an Internet Archive dump indexed by
 * <https://zaprit.fish>, and a root level fetched from there is exactly the
 * resource `src/core/level.ts` already reads -- so this ends in the same
 * `onOpen` as a dropped file, with the same bytes in the same reader.
 *
 * ⚠️ **Two hosts, and they do not have the same manners.**
 *
 * - `zaprit.fish` sends **no CORS headers**, so a page cannot read it. The
 *   search goes through `dev/serve.mjs`, which is why **searching by words
 *   needs the dev server**.
 * - `archive.org` sends `Access-Control-Allow-Origin` and echoes whatever origin
 *   asks (verified from `https://example.github.io`), so **the level itself is
 *   fetched by the page**, from anywhere, with no server in between.
 *
 * ❗ **That asymmetry is why this box takes a hash as well as words.**
 * `rootLevelUrl` is a pure function of the root level's SHA-1, which every level
 * page on zaprit.fish prints in a box made to be copied. Paste those 40 digits
 * and the level opens with no proxy at all -- from a static host, or from
 * `file://`. It is the whole answer to "can this work without a backend", and
 * the reason the answer is not simply no. The measurements behind it are in
 * *The public archive* in `steering/lbp-modding-toolchain.md`.
 *
 * ❗ **Names from the archive are put in the DOM as text, never as markup.**
 * A level title is whatever its creator typed in 2011, arriving over the
 * network from a site we do not control; `textContent` on an element built here
 * is the whole defence and it costs nothing.
 */

import { readQuery, rootLevelUrl, SEARCH_HOST } from './lbpsearch.ts';
import type { Opened } from './open-level.ts';
import type { ArchiveRow, ArchiveSearch, ArchiveSlot, SearchSort } from './lbpsearch.ts';

/** Which games could possibly hold a music sequencer. LBP1 had none. */
const HAS_SEQUENCER = /LittleBigPlanet [23]/;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** What a row says about itself under its name. */
const detail = (row: ArchiveRow): string => {
  const hearts = `${row.hearts.toLocaleString()} heart${row.hearts === 1 ? '' : 's'}`;
  const year = row.firstPublished.slice(0, 4);
  return `${row.author} · ${row.game}${year ? ` · ${year}` : ''} · ${hearts}`;
};

/**
 * Wire a button to a search panel it builds itself.
 *
 * `onOpen` gets the same shape a dropped file produces, so a page needs no new
 * code path: the level arrives as one `BackupFile` named after its SHA-1, which
 * is what it is called in a real backup too.
 */
export function wireArchiveSearch(opts: {
  button: HTMLElement;
  host: HTMLElement;
  onOpen: (opened: Opened) => void | Promise<void>;
}): void {
  const { button, host, onOpen } = opts;
  host.classList.add('archive');
  host.hidden = true;
  host.innerHTML =
    '<div class="row">' +
    '<input class="archive-q" type="text" placeholder="a level, an author, or a root-level hash…" ' +
    'aria-label="Search the LBP archive" autocomplete="off" spellcheck="false">' +
    '<select class="archive-sort" aria-label="Sort">' +
    '<option value="hearts">most hearted</option>' +
    '<option value="name">by name</option>' +
    '<option value="author">by author</option>' +
    '</select>' +
    '<button type="button" class="archive-go primary">search</button>' +
    '</div>' +
    '<p class="archive-note">Levels published to the Mm servers before they closed, from the ' +
    'Internet Archive. The level is downloaded to your browser and read there.</p>' +
    '<p class="archive-hint">Searching needs the dev server. A level’s <b>root level</b> hash — ' +
    'the 40 digits on its page at <a href="' + SEARCH_HOST + '" target="_blank" ' +
    'rel="noreferrer noopener">zaprit.fish</a> — can be pasted here instead, and that works ' +
    'with no server at all.</p>' +
    '<div class="archive-list"></div>' +
    '<div class="row archive-pager" hidden>' +
    '<button type="button" class="archive-prev">previous</button>' +
    '<span class="archive-page"></span>' +
    '<button type="button" class="archive-next">next</button>' +
    '</div>';

  const query = host.querySelector<HTMLInputElement>('.archive-q')!;
  const sort = host.querySelector<HTMLSelectElement>('.archive-sort')!;
  const go = host.querySelector<HTMLButtonElement>('.archive-go')!;
  const note = host.querySelector<HTMLElement>('.archive-note')!;
  const list = host.querySelector<HTMLElement>('.archive-list')!;
  const pager = host.querySelector<HTMLElement>('.archive-pager')!;
  const prev = host.querySelector<HTMLButtonElement>('.archive-prev')!;
  const next = host.querySelector<HTMLButtonElement>('.archive-next')!;
  const pageLabel = host.querySelector<HTMLElement>('.archive-page')!;

  const NOTE = note.textContent ?? '';
  let page = 0;
  let busy = false;

  const say = (text: string, bad = false) => {
    note.textContent = text || NOTE;
    note.classList.toggle('bad', bad);
  };

  /**
   * Ask our own server, and be honest about the one way this fails.
   *
   * ⚠️ Opened from `file://` or a static host there is no `/zaprit/` route, so
   * the fetch either fails outright or returns the page's own HTML with a 404.
   * A JSON parse error on a 404 read as "the archive is down" would send
   * somebody looking in the wrong place entirely -- and the message names the
   * way out, because there is one and it is in this same box.
   */
  async function ask<T>(path: string): Promise<T> {
    const noServer = 'searching needs `node dev/serve.mjs` — but a root-level hash '
      + 'pasted in this box opens a level without it';
    let answer: Response;
    try {
      answer = await fetch(path, { headers: { accept: 'application/json' } });
    } catch {
      throw new Error(`cannot reach the dev server: ${noServer}`);
    }
    if (answer.status === 404) throw new Error(noServer);
    const body = (await answer.json().catch(() => ({}))) as T & { error?: string };
    if (!answer.ok) throw new Error(body.error ?? `the archive answered ${answer.status}`);
    return body;
  }

  const rowButton = (row: ArchiveRow): HTMLButtonElement => {
    const button_ = el('button', 'archive-row');
    button_.type = 'button';
    // ❗ Text, not markup: these strings came off a public site.
    button_.append(
      el('span', 'archive-name', row.name || '(untitled)'),
      el('span', 'archive-detail', detail(row)),
    );
    if (!HAS_SEQUENCER.test(row.game)) {
      // LBP1 has no Music Sequencer at all, so these can only ever open empty.
      // Shown rather than hidden: a listener searching for a name they know
      // should see it found, with the reason it will not play.
      button_.classList.add('archive-quiet');
      button_.title = 'LittleBigPlanet 1 has no music sequencer';
    }
    button_.addEventListener('click', () => void openSlot(row.id));
    return button_;
  };

  async function search(to: number): Promise<void> {
    const q = query.value.trim();
    busy = true;
    go.disabled = true;
    say('searching…');
    list.replaceChildren();
    pager.hidden = true;
    try {
      const found = await ask<ArchiveSearch & { page: number }>(
        `/zaprit/search?q=${encodeURIComponent(q)}&page=${to}&sort=${sort.value as SearchSort}`,
      );
      page = found.page;
      list.replaceChildren(...found.rows.map(rowButton));
      pager.hidden = found.rows.length === 0 || (page === 0 && !found.more);
      prev.disabled = page === 0;
      next.disabled = !found.more;
      pageLabel.textContent = `page ${page + 1}`;
      say(found.rows.length === 0 ? `nothing found for “${q}”` : '');
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    } finally {
      busy = false;
      go.disabled = false;
    }
  }

  /**
   * Fetch a level's bytes and hand them on.
   *
   * ❗ Straight from archive.org, not through the dev server: the level is the
   * one thing that must not travel over it. `mode: 'cors'` is the default and is
   * spelled out because it is the property being relied on.
   */
  async function fromArchive(url: string, label: string, sha1: string): Promise<void> {
    const answer = await fetch(url, { mode: 'cors' });
    if (!answer.ok) throw new Error(`the archive answered ${answer.status} for the level`);
    const bytes = new Uint8Array(await answer.arrayBuffer());
    say('');
    host.hidden = true;
    // Named after its SHA-1, which is what a backup calls it too.
    await onOpen({ label, files: [{ name: sha1, bytes }], many: false });
  }

  /** Open a level found by search: its hash from the index, then its bytes. */
  async function openSlot(id: number): Promise<void> {
    if (busy) return;
    busy = true;
    say('opening…');
    try {
      const slot = await ask<ArchiveSlot>(`/zaprit/slot/${id}`);
      if (slot.missing) {
        throw new Error('the archive never got this level’s data — its bytes are missing');
      }
      await fromArchive(slot.url, `${slot.name} — ${slot.author}`, slot.sha1);
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    } finally {
      busy = false;
    }
  }

  /** Open a level by its root level hash. **This one needs no server.** */
  async function openHash(sha1: string): Promise<void> {
    if (busy) return;
    busy = true;
    say(`fetching ${sha1.slice(0, 8)}…`);
    try {
      // No name to give it: the index is what knows names, and the whole point
      // of this path is not needing the index. The level's own title comes back
      // out of the resource anyway, on the songs in it.
      await fromArchive(rootLevelUrl(sha1), `root level ${sha1.slice(0, 8)}`, sha1);
    } catch (error) {
      say(
        error instanceof Error
          ? `${error.message} — check the hash, or that the archive has this level`
          : String(error),
        true,
      );
    } finally {
      busy = false;
    }
  }

  /** What the box does depends on what is in it; see `readQuery`. */
  function submit(): void {
    if (busy) return;
    const typed = readQuery(query.value);
    if (typed.kind === 'hash') {
      void openHash(typed.sha1);
    } else if (typed.kind === 'slot') {
      void openSlot(typed.id);
    } else if (typed.words === '') {
      query.focus();
    } else {
      void search(0);
    }
  }

  button.addEventListener('click', () => {
    host.hidden = !host.hidden;
    if (!host.hidden) query.focus();
  });
  go.addEventListener('click', submit);
  query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  });
  sort.addEventListener('change', () => {
    if (readQuery(query.value).kind === 'words' && query.value.trim() !== '') void search(0);
  });
  prev.addEventListener('click', () => void search(Math.max(0, page - 1)));
  next.addEventListener('click', () => void search(page + 1));
}
