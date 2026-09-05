/**
 * The third way to open a song: a level out of the Internet Archive.
 *
 * "Open a file" and "open a folder" both assume a listener already has a PS3
 * backup. Most do not. The official servers are gone, but every level published
 * to them survives in an archive indexed by <https://zaprit.fish>, and a root
 * level fetched from there is exactly the resource `src/core/level.ts` already
 * reads -- so this ends in the same `onOpen` as a dropped file, with the same
 * bytes in the same reader.
 *
 * ❗ **One field, and it takes a hash.** The listener searches on zaprit.fish
 * itself -- a real search, with icons and hearts and everything this box would
 * only have imitated -- and copies the 40 hex digits from the level's page.
 * `rootLevelUrl` is a pure function of those digits and archive.org answers any
 * origin, so **nothing here needs a server**: not the dev server, not a proxy,
 * not anything. That is the whole reason the box is shaped like this; see
 * `dev/lbparchive.ts` for what was measured and what was removed.
 *
 * ❗ **The level's own name is put in the DOM as text, never as markup** -- it
 * comes out of a resource somebody wrote in 2011 and arrived over the network.
 */

import { readPaste, rootLevelUrl, SEARCH_HOST } from './lbparchive.ts';
import type { Opened } from './open-level.ts';

/**
 * Wire a button to a panel it builds itself.
 *
 * `onOpen` gets the same shape a dropped file produces, so a page needs no new
 * code path: the level arrives as one `BackupFile` named after its SHA-1, which
 * is what it is called in a real backup too.
 */
export function wireArchiveOpen(opts: {
  button: HTMLElement;
  host: HTMLElement;
  onOpen: (opened: Opened) => void | Promise<void>;
}): void {
  const { button, host, onOpen } = opts;
  host.classList.add('archive');
  host.hidden = true;
  host.innerHTML =
    '<div class="row">' +
    '<input class="archive-q" type="text" placeholder="a root level hash, or a link to its file…" ' +
    'aria-label="Root level hash" autocomplete="off" spellcheck="false">' +
    '<button type="button" class="archive-go primary">open</button>' +
    '</div>' +
    '<p class="archive-note">Paste the 40 digits and the level is downloaded to your browser ' +
    'and read there.</p>' +
    '<p class="archive-hint">Find a level at <a href="' + SEARCH_HOST + '" target="_blank" ' +
    'rel="noreferrer noopener">zaprit.fish</a> — its page shows the <b>root level</b> hash in a ' +
    'box of its own, under the title. Nothing here needs a server: the level comes straight from ' +
    'the Internet Archive.</p>';

  const query = host.querySelector<HTMLInputElement>('.archive-q')!;
  const go = host.querySelector<HTMLButtonElement>('.archive-go')!;
  const note = host.querySelector<HTMLElement>('.archive-note')!;

  const NOTE = note.textContent ?? '';
  let busy = false;

  const say = (text: string, bad = false) => {
    note.textContent = text || NOTE;
    note.classList.toggle('bad', bad);
  };

  /** Fetch a level's bytes and hand them on. */
  async function open_(sha1: string): Promise<void> {
    if (busy) return;
    busy = true;
    go.disabled = true;
    say(`fetching ${sha1.slice(0, 8)}…`);
    try {
      // ❗ `mode: 'cors'` is the default and is spelled out because it is the
      // property being relied on: archive.org echoes the asking origin, so this
      // works from a dev server, a static host or a file:// page alike.
      const answer = await fetch(rootLevelUrl(sha1), { mode: 'cors' });
      if (!answer.ok) {
        throw new Error(
          `the archive answered ${answer.status} — check the hash, or the archive `
          + 'may never have received this level',
        );
      }
      const bytes = new Uint8Array(await answer.arrayBuffer());
      say('');
      host.hidden = true;
      // No name to give it: naming levels is what the index does, and not
      // needing the index is the point. The songs carry their own titles anyway.
      await onOpen({
        label: `root level ${sha1.slice(0, 8)}`,
        // Named after its SHA-1, which is what a backup calls it too.
        files: [{ name: sha1, bytes }],
        many: false,
      });
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    } finally {
      busy = false;
      go.disabled = false;
    }
  }

  function submit(): void {
    if (busy) return;
    const pasted = readPaste(query.value);
    if (pasted.kind === 'hash') {
      void open_(pasted.sha1);
    } else if (pasted.kind === 'link') {
      // The hash is on that page and the page cannot be read from here; saying
      // so beats a failed fetch that looks like the archive being down.
      say('that is a link to a level’s page — open it and copy the hash from it', true);
    } else if (query.value.trim() === '') {
      query.focus();
    } else {
      say('that is not a root level hash — it is 40 hex digits, from the level’s page', true);
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
}
