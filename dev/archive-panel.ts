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
import { DEPENDENCY_PLAN, readDependencies } from '../src/core/resource.ts';
import type { BackupFile } from '../src/core/backup.ts';
import type { Opened } from './open-level.ts';

/**
 * How many resources one paste may pull in, and how many at a time.
 *
 * ⚠️ **The walk is plans only, and that is measured rather than assumed.** A
 * level's dependency table names its textures, meshes and materials too, and
 * `src/core/backup.ts` would throw every one of them away -- it opens `LVLb`,
 * `PLNb` and `CHKb` and nothing else. Fetching them would be minutes of somebody
 * else's bandwidth for no song. Type 38 is the plan, checked against the magic
 * of what actually came back.
 *
 * The cap is a guard against a level that references half the archive, not a
 * measured limit: "Music Gallery #3" needs 17.
 */
const RESOURCE_LIMIT = 250;
const AT_A_TIME = 6;

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
    '<p class="archive-note">Paste the 40 digits and the level — with the plans it depends on — ' +
    'is downloaded to your browser and read there.</p>' +
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

  /** One resource out of the archive. Throws with something worth reading. */
  async function grab(sha1: string): Promise<Uint8Array> {
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
    return new Uint8Array(await answer.arrayBuffer());
  }

  /**
   * The plans a resource depends on that have not been asked for yet.
   *
   * A resource whose tail will not parse contributes nothing and is not an
   * error: the level itself is already in hand, and one unreadable dependency
   * table is no reason to refuse the songs that did arrive.
   */
  function plansOf(bytes: Uint8Array, seen: Set<string>): string[] {
    const out: string[] = [];
    let deps;
    try {
      deps = readDependencies(bytes);
    } catch {
      return out;
    }
    for (const dep of deps) {
      if (dep.kind !== 'sha1' || dep.type !== DEPENDENCY_PLAN || seen.has(dep.sha1)) continue;
      seen.add(dep.sha1);
      out.push(dep.sha1);
    }
    return out;
  }

  /**
   * Fetch a level and the plans it depends on, and hand the pile over.
   *
   * ❗ **This is the whole backup as far as the tracker is concerned**, and the
   * dependency table is what makes it possible without a server: a hashed
   * dependency is a *user* resource and lives in the archive under the same URL
   * as the level, while a GUID one is a game asset that is not in the archive at
   * all (140 of "Music Gallery #3"'s 160 dependencies are GUIDs).
   *
   * ⚠️ **A missing plan is not a failed open.** Only the level itself is
   * required; anything else that will not come is counted and said out loud.
   */
  async function open_(sha1: string): Promise<void> {
    if (busy) return;
    busy = true;
    go.disabled = true;
    say(`fetching ${sha1.slice(0, 8)}…`);
    try {
      const root = await grab(sha1);
      const files: BackupFile[] = [{ name: sha1, bytes: root }];
      const seen = new Set([sha1]);
      const queue = plansOf(root, seen);
      let missing = 0;
      while (queue.length > 0 && files.length < RESOURCE_LIMIT) {
        say(`${files.length} of ${files.length + queue.length} resources…`);
        const wave = await Promise.all(
          queue.splice(0, AT_A_TIME).map(async (hash) => {
            try {
              return [hash, await grab(hash)] as const;
            } catch {
              return [hash, undefined] as const;
            }
          }),
        );
        for (const [hash, bytes] of wave) {
          if (!bytes) {
            missing += 1;
            continue;
          }
          files.push({ name: hash, bytes });
          queue.push(...plansOf(bytes, seen));
        }
      }
      say(missing === 0 ? '' : `${missing} plan${missing === 1 ? '' : 's'} the archive does not have`, missing > 0);
      host.hidden = missing === 0;
      // No name to give it: naming levels is what the index does, and not
      // needing the index is the point. The songs carry their own titles anyway.
      await onOpen({
        // Files are named after their SHA-1, which is what a backup calls them.
        label: `root level ${sha1.slice(0, 8)}`,
        files,
        many: files.length > 1,
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
