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
}

/**
 * Mount the drop zone and wire it to one handler.
 *
 * ❗ **The markup is the component's, not the page's.** All three pages used to
 * carry their own copy of it — and of its CSS — and the copies had already
 * drifted apart; see `widgets/OpenLevel.vue`. A page now supplies an empty
 * element and this returns the three things it actually drives.
 *
 * ❗ **The archive is the third button and it lives here** rather than beside
 * each page's own wiring. Three pages open levels; the last time two of them
 * grew their own copy of something this small it cost a day.
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
  if (ui.archiveButton && ui.archiveHost) {
    wireArchiveOpen({ button: ui.archiveButton, host: ui.archiveHost, onOpen: opts.onOpen });
  }

  void openFromQuery(give);

  return {
    say: (title, hint) => ui.say(title, hint),
    busy: (on) => ui.setBusy(on),
    loaded: (on) => ui.setLoaded(on),
  };
}

