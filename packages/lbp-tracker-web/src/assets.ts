/**
 * Fetching the game's own instruments and samples, for whichever page needs them.
 *
 * ⚠️ **One copy on purpose.** The URL rules below cost this project a day when
 * they lived in one page and not another: three of the 216 samples carry a `#`
 * in the name, and a caller that forgot to encode it fetched a truncated path,
 * got an error page back, and blamed `readWav`. Anything that loads these
 * assets imports this rather than writing its own fetch.
 *
 * ❗ The assets are the user's own game data, extracted locally with
 * `tools/ExtractGuid.java` and never committed. The dev server serves only the
 * repository, so nothing leaves this machine.
 */

import { buildMipChain } from '@lbptracker/lib/audio/mipmap.ts';
import { type SampleBuffer } from '@lbptracker/lib/audio/mixer.ts';
import { loadResource } from '@lbptracker/cwlib/resource.ts';
import { type LoadedInstrument } from '@lbptracker/lib/render.ts';
import { readInstrument, usedSlots } from '@lbptracker/lib/rinstrument.ts';
import { readWav, loopRegion } from '@lbptracker/lib/wav.ts';
import { webInflate } from '@lbptracker/cwlib/platform/web.ts';

export type Manifest = Map<number, { file: string; path?: string }>;

/**
 * Where the MIDI page leaves a song for the live player to pick up.
 *
 * ⚠️ It lives here rather than in either page because both need it and
 * neither can import the other: a page module runs its whole side-effectful
 * body on import, so `live.ts` reaching into `midi-app.ts` for one string would
 * build a second MIDI page inside the live one.
 */
export const HANDOFF_KEY = 'lbp.importedSequencer';

/**
 * A path under the site root, resolved against this module rather than the page.
 *
 * ⚠️ A bare relative URL in a worker resolves against the **worker's own
 * directory**, not the document's, so `fetch('fixtures/…')` from a worker under
 * `/workers/` asks for `/workers/fixtures/…` and 404s. A leading slash would work
 * on the dev server and break under any static host that serves the app from a
 * prefix. `import.meta.url` is the one form that is right in both.
 *
 * ⚠️ **Every segment is percent-encoded, and `new URL` is not enough on its
 * own.** Three of the game's 216 samples have a `#` in the name --
 * `violin_spic_string4_f#4.smp`, `choir_f#3_v2.smp`, `choir_g#4_v2.smp` -- and
 * `new URL` treats that as the start of a fragment, so the request goes out for
 * `…/violin_spic_string4_f` and comes back 404. The 404 body is then handed to
 * `readWav`, which says `not a RIFF/WAVE file` and names nothing. Any level
 * using the violin or the choir failed to render in the browser and rendered
 * perfectly under Node, which reads the same files by path. 48 more samples have
 * a space; those survived, because `new URL` does encode a space.
 */
export const asset = (p: string) =>
  // The `@vite-ignore` is the point, not an escape: this URL is meant to be
  // resolved at runtime against whatever directory the module ended up in, so
  // there is nothing for the bundler to rewrite and its warning would be noise
  // on every build. See the chunk-depth note in steering/tracker-architecture.md.
  new URL(
    p.split('/').map(encodeURIComponent).join('/'),
    new URL(/* @vite-ignore */ '../', import.meta.url),
  ).href;

export async function manifest(dir: string): Promise<Manifest> {
  const rows = (await (await fetch(asset(`${dir}/manifest.json`))).json()) as {
    guid: number;
    file: string;
  }[];
  return new Map(rows.map((r) => [r.guid, r]));
}

export async function loaderFor(
  rinstIndex: Manifest,
  smpIndex: Manifest,
): Promise<(guid: number) => Promise<LoadedInstrument | null>> {
  const cache = new Map<number, LoadedInstrument | null>();
  /**
   * Fetch one asset, and fail with its name and status rather than with whatever
   * the parser makes of an error page. A 404 body reaching `readWav` produced
   * `not a RIFF/WAVE file` and no clue which of 216 samples was missing.
   */
  const bytes = async (url: string) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${response.status} fetching ${decodeURIComponent(new URL(url).pathname)}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  };
  return async (guid: number) => {
    const hit = cache.get(guid);
    if (hit !== undefined) return hit;
    const row = rinstIndex.get(guid);
    if (!row) {
      cache.set(guid, null);
      return null;
    }
    const resource = await loadResource(await bytes(asset(`fixtures/rinst/${row.file}`)), webInflate);
    const inst = readInstrument(resource.data);
    const slots = [];
    for (const { slot, guid: sampleGuid } of usedSlots(inst)) {
      const s = smpIndex.get(sampleGuid);
      if (!s) continue;
      const wav = readWav(await bytes(asset(`fixtures/smp/${s.file}`)));
      slots.push({
        base: slot.baseNote,
        wav: {
          channels: wav.channels,
          sampleRate: wav.sampleRate,
          loop: wav.loop ? loopRegion(wav.loop, wav.channels[0].length) : undefined,
          mips: wav.channels.map((c) => buildMipChain(c)),
        } satisfies SampleBuffer,
      });
    }
    const loaded = { inst, slots };
    cache.set(guid, loaded);
    return loaded;
  };
}
