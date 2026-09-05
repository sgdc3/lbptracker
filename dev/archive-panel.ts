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
 * ⚠️ **Two hosts, and the level comes from the second one.** The search goes
 * through `dev/serve.mjs` because zaprit.fish sends no CORS headers; the
 * **bytes come straight from archive.org to the page**, because it does. See
 * `dev/lbpsearch.ts`. The consequence worth knowing: **the search needs the dev
 * server**, so a page opened from `file://` gets a clear message instead of a
 * silent failure.
 *
 * ❗ **Names from the archive are put in the DOM as text, never as markup.**
 * A level title is whatever its creator typed in 2011, arriving over the
 * network from a site we do not control; `textContent` on an element built here
 * is the whole defence and it costs nothing.
 */

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
    '<input class="archive-q" type="text" placeholder="a level, or an author…" ' +
    'aria-label="Search the LBP archive" autocomplete="off">' +
    '<select class="archive-sort" aria-label="Sort">' +
    '<option value="hearts">most hearted</option>' +
    '<option value="name">by name</option>' +
    '<option value="author">by author</option>' +
    '</select>' +
    '<button type="button" class="archive-go primary">search</button>' +
    '</div>' +
    '<p class="archive-note">Levels published to the Mm servers before they closed, from the ' +
    'Internet Archive. The level is downloaded to your browser and read there.</p>' +
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
   * somebody looking in the wrong place entirely.
   */
  async function ask<T>(path: string): Promise<T> {
    let answer: Response;
    try {
      answer = await fetch(path, { headers: { accept: 'application/json' } });
    } catch {
      throw new Error('cannot reach the dev server — the search needs `node dev/serve.mjs`');
    }
    if (answer.status === 404) {
      throw new Error('this page is not being served by `node dev/serve.mjs`, which the search needs');
    }
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
    button_.addEventListener('click', () => void open_(row));
    return button_;
  };

  async function search(to: number): Promise<void> {
    if (busy) return;
    const q = query.value.trim();
    if (q === '') {
      query.focus();
      return;
    }
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

  /** Fetch one level: its hash from the index, then its bytes from the archive. */
  async function open_(row: ArchiveRow): Promise<void> {
    if (busy) return;
    busy = true;
    say(`opening “${row.name}”…`);
    try {
      const slot = await ask<ArchiveSlot>(`/zaprit/slot/${row.id}`);
      if (slot.missing) {
        throw new Error('the archive never got this level’s data — its bytes are missing');
      }
      // ❗ Straight from archive.org, not through the dev server: the level is
      // the one thing that must not travel over it. `mode: 'cors'` is the
      // default and is spelled out because it is the property being relied on.
      const answer = await fetch(slot.url, { mode: 'cors' });
      if (!answer.ok) throw new Error(`the archive answered ${answer.status} for the level`);
      const bytes = new Uint8Array(await answer.arrayBuffer());
      say('');
      host.hidden = true;
      await onOpen({
        label: `${slot.name} — ${slot.author}`,
        // Named after its SHA-1, which is what a backup calls it too.
        files: [{ name: slot.sha1, bytes }],
        many: false,
      });
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    } finally {
      busy = false;
    }
  }

  button.addEventListener('click', () => {
    host.hidden = !host.hidden;
    if (!host.hidden) query.focus();
  });
  go.addEventListener('click', () => void search(0));
  query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void search(0);
    }
  });
  sort.addEventListener('change', () => {
    if (query.value.trim() !== '') void search(0);
  });
  prev.addEventListener('click', () => void search(Math.max(0, page - 1)));
  next.addEventListener('click', () => void search(page + 1));
}
