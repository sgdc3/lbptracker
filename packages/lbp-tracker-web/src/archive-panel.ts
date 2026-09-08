/**
 * The third way to open a song: a level out of the Internet Archive.
 *
 * "Open a file" and "open a folder" both assume a listener already has a PS3
 * backup. Most do not. The official servers are gone, but every level published
 * to them survives in an archive indexed by <https://zaprit.fish>, and a root
 * level fetched from there is exactly the resource `packages/cwlib-ts/src/level.ts` already
 * reads -- so this ends in the same `onOpen` as a dropped file, with the same
 * bytes in the same reader.
 *
 * ❗ **One field, and it takes a hash.** The listener searches on zaprit.fish
 * itself -- a real search, with icons and hearts and everything this box would
 * only have imitated -- and copies the 40 hex digits from the level's page.
 * `rootLevelUrl` is a pure function of those digits and archive.org answers any
 * origin, so **nothing here needs a server**: not the dev server, not a proxy,
 * not anything. That is the whole reason the box is shaped like this; see
 * `packages/lbp-tracker-web/src/lbparchive.ts` for what was measured and what was removed.
 *
 * ❗ **The level's own name is put in the DOM as text, never as markup** -- it
 * comes out of a resource somebody wrote in 2011 and arrived over the network.
 */

import { createApp, h, reactive } from 'vue';
import ArchivePanel from './widgets/ArchivePanel.vue';
import { readPaste, rootLevelUrl, SEARCH_HOST } from './lbparchive.ts';
import { rememberLevel } from './link.ts';
import { loading, type LoadingJob } from './widgets/loading.ts';
import { OPENABLE_DEPENDENCIES, readDependencies } from '@lbptracker/cwlib/resource.ts';
import { looksLikeLevel } from '@lbptracker/cwlib/backup.ts';
import type { BackupFile } from '@lbptracker/cwlib/backup.ts';
import type { Opened } from './open-level.ts';

/**
 * How many resources one paste may pull in, and how many at a time.
 *
 * ⚠️ **The walk fetches only what can be opened, and the list is measured.** A
 * level's dependency table names its textures, meshes and materials too, and
 * `packages/cwlib-ts/src/backup.ts` would throw every one of them away -- it opens `LVLb`,
 * `PLNb` and `CHKb` and nothing else. So the walk follows exactly the three
 * types that are those: 9, 38 and 61, each checked against the magic of what
 * actually came back. See `OPENABLE_DEPENDENCIES`.
 *
 * The cap is a guard against a level that references half the archive, not a
 * measured limit: "Music Gallery #3" needs 17, and an adventure map's levels and
 * chunks together came to 25.
 */
const RESOURCE_LIMIT = 250;
const AT_A_TIME = 6;

/** What a wired panel lets the page do without the reader touching it. */
export interface ArchiveOpen {
  /** Open a root level by its SHA-1, as if it had been pasted into the box. */
  open(sha1: string, opts?: { deep?: boolean }): Promise<void>;
}

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
}): ArchiveOpen {
  const { button, host, onOpen } = opts;
  host.classList.add('archive');
  host.hidden = true;

  // The markup is `widgets/ArchivePanel.vue`; this keeps the state it binds to
  // and the logic that reads it. ❗ The panel used to be a 20-line `innerHTML`
  // string, which is why the note's default had to be read back out of the DOM.
  const ui = reactive({ query: '', deep: false, note: '', bad: false, busy: false });
  let focusField = () => {};
  createApp({
    render: () =>
      h(ArchivePanel, {
        searchHost: SEARCH_HOST,
        busy: ui.busy,
        query: ui.query,
        'onUpdate:query': (v: string) => (ui.query = v),
        deep: ui.deep,
        'onUpdate:deep': (v: boolean) => (ui.deep = v),
        note: ui.note,
        bad: ui.bad,
        onSubmit: () => void submit(),
        ref: (el: unknown) => {
          focusField = (el as { focus(): void } | null)?.focus.bind(el) ?? (() => {});
        },
      }),
  }).mount(host);

  let busy = false;

  const say = (text: string, bad = false) => {
    ui.note = text;
    ui.bad = bad;
  };

  // ❗ **Progress goes to two places.** The panel's note is where a reader
  // who opened the box is looking; the loader is what everyone else sees,
  // including a `?level=` link that never opened the box at all. `job` runs for
  // as long as one open does (`widgets/loading.ts`), and the two lines are
  // worded for where they appear: the note sits under a field that already
  // holds the hash, the loader has to say what is going on from nothing.
  let job: LoadingJob | undefined;
  const progress = (note: string, loud = note) => {
    say(note);
    job?.note(loud);
  };

  /** One resource out of the archive. Throws with something worth reading. */
  async function grab(sha1: string): Promise<Uint8Array> {
    // ❗ `mode: 'cors'` is the default and is spelled out because it is the
    // property being relied on: archive.org echoes the asking origin, so this
    // works from a dev server, a static host or a file:// page alike.
    const answer = await fetch(rootLevelUrl(sha1), { mode: 'cors' });
    if (!answer.ok) {
      throw new Error(
        `the archive answered ${answer.status}; check the hash, or the archive `
        + 'may never have received this level',
      );
    }
    return new Uint8Array(await answer.arrayBuffer());
  }

  /**
   * The openable resources this one depends on that have not been asked for yet.
   *
   * A resource whose tail will not parse contributes nothing and is not an
   * error: the level itself is already in hand, and one unreadable dependency
   * table is no reason to refuse the songs that did arrive.
   */
  function partsOf(bytes: Uint8Array, seen: Set<string>): string[] {
    const out: string[] = [];
    let deps;
    try {
      deps = readDependencies(bytes);
    } catch {
      return out;
    }
    for (const dep of deps) {
      if (dep.kind !== 'sha1' || seen.has(dep.sha1)) continue;
      if (!OPENABLE_DEPENDENCIES.includes(dep.type)) continue;
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
   *
   * ❗ **The walk is a checkbox, off by default.** Measured on "Music Gallery
   * #3": the level plus its 17 plans took 10 s against 3 s for the level alone,
   * and gave 46 sequencer rows instead of 31 — but **16 distinct songs either
   * way**, every plan being a copy of a song already placed in the level. So on
   * most levels it is seven seconds and fifteen duplicate rows for nothing,
   * which is why it is off; the one thing it can find that the level cannot, a
   * song living only as a plan, is one tick away and `?deep=1` in a link.
   *
   * ⚠️ **Except when the root cannot be opened at all**, and then the walk is
   * not optional. An adventure (`ADCb`) has no world of its own: `readBackup`
   * skips it on its magic and its levels are type-9 dependencies, so with the
   * box unticked a perfectly good hash would do nothing whatsoever. Four of
   * twelve "adventure map" hashes taken off the index are `ADCb`, so this is not
   * a corner case.
   */
  async function open_(sha1: string, deep = ui.deep): Promise<void> {
    if (busy) return;
    busy = true;
    ui.busy = true;
    ui.query = sha1;
    ui.deep = deep;
    job = loading(`Opening ${sha1.slice(0, 8)}… from the archive`);
    progress(`fetching ${sha1.slice(0, 8)}…`, 'asking archive.org for the level…');
    try {
      const root = await grab(sha1);
      const files: BackupFile[] = [{ name: sha1, bytes: root }];
      const seen = new Set([sha1]);
      // ❗ **Read once, at the start.** Ticking the box while eighteen fetches
      // are in flight must not change what this open is doing halfway through.
      // ❗ Not optional when the root is not itself openable: see above.
      const withParts = deep || !looksLikeLevel(root);
      const queue = withParts ? partsOf(root, seen) : [];
      let missing = 0;
      while (queue.length > 0 && files.length < RESOURCE_LIMIT) {
        progress(`${files.length} of ${files.length + queue.length} resources…`);
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
          // An adventure names levels, a level names chunks and plans, and a
          // plan can name further plans, so the walk continues from what came
          // back rather than stopping at the root's own list.
          queue.push(...partsOf(bytes, seen));
        }
      }
      say(
        missing === 0
          ? ''
          : `${missing} of its parts ${missing === 1 ? 'is' : 'are'} not in the archive`,
        missing > 0,
      );
      host.hidden = missing === 0;
      // ❗ **The address bar becomes the link to share.** A level opened
      // from the archive is fully named by its hash, so writing it into the URL
      // costs one `replaceState` and gives the reader something to copy; the
      // walk goes with it because it changes what the link opens. See
      // `link.ts`.
      rememberLevel(sha1, deep);
      // No name to give it: naming levels is what the index does, and not
      // needing the index is the point. The songs carry their own titles anyway.
      await onOpen({
        // Files are named after their SHA-1, which is what a backup calls them.
        label: `root level ${sha1.slice(0, 8)}`,
        files,
        many: files.length > 1,
        archive: { sha1, deep },
      });
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), true);
    } finally {
      busy = false;
      ui.busy = false;
      job?.done();
      job = undefined;
    }
  }

  function submit(): void {
    if (busy) return;
    const pasted = readPaste(ui.query);
    if (pasted.kind === 'hash') {
      void open_(pasted.sha1);
    } else if (pasted.kind === 'link') {
      // The hash is on that page and the page cannot be read from here; saying
      // so beats a failed fetch that looks like the archive being down.
      say('that is a link to a level’s page: open it and copy the hash from it', true);
    } else if (ui.query.trim() === '') {
      focusField();
    } else {
      say('that is not a root level hash: it is 40 hex digits, from the level’s page', true);
    }
  }

  button.addEventListener('click', () => {
    host.hidden = !host.hidden;
    if (!host.hidden) focusField();
  });

  return {
    open: (sha1, o) => {
      // Opened from a link rather than from the box: show the box anyway, or a
      // hash that 404s reports itself into a panel nobody can see.
      host.hidden = false;
      return open_(sha1.toLowerCase(), o?.deep ?? ui.deep);
    },
  };
}
