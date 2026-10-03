/**
 * The drop zone, mounted.
 *
 * ⚠️ **Split from `open-level.ts` because a worker imports that file.**
 * `render-worker.ts` wants `openedTitle` and nothing else; when the mounting
 * lived beside it, the worker pulled in Vue and died on `document is not
 * defined` inside Vue's runtime. The build gives no warning about this at all.
 */

import { createApp, h } from 'vue';
import { wireArchiveOpen } from '../archive-panel.ts';
import { wireBonsaiOpen } from '../bonsai-panel.ts';
import { levelFromQuery } from '../link.ts';
import { asset } from '../assets.ts';
import { fromDrop, fromFiles, type Opened } from '../open-level.ts';
import OpenLevel from './OpenLevel.vue';

/**
 * `?open=fixtures/levels/x.lvl` opens a file the site itself serves.
 *
 * ❗ **A development affordance, and the only way a browser driven by a script
 * can open a level**: a file input cannot be filled from a page, and every
 * check of these pages in an automated browser was stuck at the drop zone
 * until this existed. The path is resolved like an asset -- under the site
 * root, every segment encoded -- so it cannot reach outside it; on the deployed
 * site only `fixtures/rinst` and `fixtures/smp` exist, and anything else 404s
 * into the page's own error line.
 */
async function openFromQuery(give: (from: Promise<Opened | undefined>) => Promise<void>): Promise<void> {
  const wanted = new URLSearchParams(window.location.search).get('open');
  if (!wanted) return;
  await give((async () => {
    const response = await fetch(asset(wanted));
    if (!response.ok) throw new Error(`${response.status} fetching ${wanted}`);
    const name = wanted.slice(wanted.lastIndexOf('/') + 1);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { label: name, files: [{ name, bytes }], many: false };
  })());
}

export interface OpenPanel {
  /** The zone's two lines. The hint keeps its last value when omitted. */
  say(title: string, hint?: string): void;
  /** Greyed out and inert while a level is being read. */
  busy(on: boolean): void;
  /** The compact form the zone takes once something is open. */
  loaded(on: boolean): void;
  /** Fetch a root level from the public archive, as a `?level=` link does. */
  openArchive(sha1: string): Promise<void>;
}

/**
 * Mount the drop zone and wire it to one handler.
 *
 * ❗ **The markup is the component's, not the page's.** All three pages used to
 * carry their own copy of it — and of its CSS — and the copies had already
 * drifted apart; see `widgets/OpenLevel.vue`. A page now supplies an empty
 * element and this returns the three things it actually drives.
 *
 * ❗ **The archive is the third button and Bonsai the fourth, and they live
 * here** rather than beside each page's own wiring. Three pages open levels;
 * the last time two of them grew their own copy of something this small it cost
 * a day.
 */
export function mountOpen(
  at: string | Element,
  opts: { onOpen: (opened: Opened) => void | Promise<void> },
): OpenPanel {
  const give = async (from: Promise<Opened | undefined>) => {
    const opened = await from;
    if (opened && opened.files.length > 0) await opts.onOpen(opened);
  };

  // ⚠️ The type is named rather than inferred from the holder: `as typeof panel`
  // inside the ref callback resolves to `null`, and every property read off it
  // then fails with "does not exist on type 'never'".
  interface Mounted {
    say(title: string, hint?: string): void;
    setBusy(on: boolean): void;
    setLoaded(on: boolean): void;
    archiveButton: HTMLElement | null;
    archiveHost: HTMLElement | null;
    bonsaiButton: HTMLElement | null;
    bonsaiHost: HTMLElement | null;
  }
  const held: { ui: Mounted | null } = { ui: null };

  createApp({
    render: () =>
      h(OpenLevel, {
        onFiles: (files: File[]) => void give(fromFiles(files)),
        onDrop: (transfer: DataTransfer) => void give(fromDrop(transfer)),
        ref: (el: unknown) => {
          held.ui = el as Mounted | null;
        },
      }),
  }).mount(at as Element);

  const ui = held.ui!;
  let openArchive = async (_sha1: string): Promise<void> => {};
  if (ui.archiveButton && ui.archiveHost && ui.bonsaiButton && ui.bonsaiHost) {
    const archive = wireArchiveOpen({
      button: ui.archiveButton,
      host: ui.archiveHost,
      onOpen: opts.onOpen,
    });
    const bonsai = wireBonsaiOpen({
      button: ui.bonsaiButton,
      host: ui.bonsaiHost,
      onOpen: opts.onOpen,
    });
    // One panel at a time: each button shows its own and puts the other away.
    // The panels' own listeners run first, having been added first.
    const { archiveHost, bonsaiHost } = ui;
    ui.archiveButton.addEventListener('click', () => (bonsaiHost.hidden = true));
    ui.bonsaiButton.addEventListener('click', () => (archiveHost.hidden = true));
    // ❗ **`?level=<sha1>` and `?bonsai=<number>` are the shareable links to a
    // song**, and they are handled here rather than in the panels so that every
    // query route is in one place. Neither is the same thing as `?open=`: that
    // one fetches a file this site serves, these fetch a published level from
    // archive.org or from Bonsai. See `link.ts` for the whole of what a URL may
    // say.
    const wanted = levelFromQuery(window.location.search);
    if (wanted?.from === 'archive') void archive.open(wanted.sha1, { deep: wanted.deep });
    if (wanted?.from === 'bonsai') void bonsai.open(wanted.id, { deep: wanted.deep });
    openArchive = (sha1) => {
      bonsaiHost.hidden = true;
      return archive.open(sha1, { deep: false });
    };
  }

  void openFromQuery(give);

  return {
    say: (title, hint) => ui.say(title, hint),
    busy: (on) => ui.setBusy(on),
    loaded: (on) => ui.setLoaded(on),
    openArchive: (sha1) => openArchive(sha1),
  };
}

