/**
 * The browser half of the renderer: a module worker that runs
 * `src/core/render.ts` off the main thread.
 *
 * It is deliberately thin. Everything musical happens in `renderSequencer`,
 * which is the same function `dev/render-level.ts` calls under Node, so a
 * browser render is not a reimplementation — it is the same arithmetic with a
 * different way of reading files. On 2026-09-02 a browser render and a Node
 * render of the same level came out byte-identical; see the header of
 * `src/core/render.ts`.
 *
 * ⚠️ **The level is opened by the user, and only by the user.** The page hands
 * this worker a `File` and it reads that; there is no fetch path and no fallback
 * to a copy on the host. That is not a preference, it is what lets the whole
 * thing be a static site -- a bucket cannot host other people's levels, and
 * `steering/game-assets.md` says it must not try.
 *
 * ❗ The game's own instrument definitions and samples (`fixtures/rinst`,
 * `fixtures/smp`) are **still fetched**, and they are the same class of asset.
 * They have to move to the same footing before this can be deployed anywhere.
 *
 * The file it opens is a **level**, parsed here by `src/core/level.ts`. It used
 * to be an 81 MB JSON dump produced by a Java tool, indexed by regex and parsed
 * line by line to stay affordable in a tab; the whole level walk turns out to be
 * cheaper than that was.
 */

import { buildMipChain } from '../src/audio/mipmap.ts';
import { type SampleBuffer } from '../src/audio/mixer.ts';
import { loadResource } from '../src/core/resource.ts';
import {
  RATE,
  renderSequencer,
  toPcm16,
  type LoadedInstrument,
} from '../src/core/render.ts';
import { readLevelProject, type LevelProject } from '../src/core/project.ts';
import { readInstrument, usedSlots } from '../src/core/rinstrument.ts';
import { readWav, writeWav, loopRegion } from '../src/core/wav.ts';
import { webInflate } from '../src/platform/web.ts';

type Manifest = Map<number, { file: string }>;

/**
 * A path under the site root, resolved against this module rather than the page.
 *
 * ⚠️ A bare relative URL in a worker resolves against the **worker's own
 * directory**, not the document's, so `fetch('fixtures/…')` from `/dev/` asks for
 * `/dev/fixtures/…` and 404s. A leading slash would work on the dev server and
 * break under any static host that serves the app from a prefix. `import.meta.url`
 * is the one form that is right in both.
 */
const asset = (p: string) => new URL(`../${p}`, import.meta.url).href;

let project: LevelProject | null = null;
let rinstIndex: Manifest | null = null;
let smpIndex: Manifest | null = null;

const post = (message: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

const say = (text: string) => post({ type: 'status', text });

async function manifest(dir: string): Promise<Manifest> {
  const rows = (await (await fetch(asset(`${dir}/manifest.json`))).json()) as {
    guid: number;
    file: string;
  }[];
  return new Map(rows.map((r) => [r.guid, r]));
}

async function loaderFor(): Promise<(guid: number) => Promise<LoadedInstrument | null>> {
  const cache = new Map<number, LoadedInstrument | null>();
  const bytes = async (url: string) => new Uint8Array(await (await fetch(url)).arrayBuffer());
  return async (guid: number) => {
    const hit = cache.get(guid);
    if (hit !== undefined) return hit;
    const row = rinstIndex!.get(guid);
    if (!row) {
      cache.set(guid, null);
      return null;
    }
    const resource = await loadResource(await bytes(asset(`fixtures/rinst/${row.file}`)), webInflate);
    const inst = readInstrument(resource.data);
    const slots = [];
    for (const { slot, guid: sampleGuid } of usedSlots(inst)) {
      const s = smpIndex!.get(sampleGuid);
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

self.onmessage = async (event: MessageEvent) => {
  const message = event.data as {
    type: string;
    uid?: number;
    seconds?: number;
    from?: number;
    file?: File;
  };
  try {
    if (message.type === 'load') {
      if (!message.file) throw new Error('load needs a file');
      const file = message.file;
      say(`reading ${file.name}…`);
      post({ type: 'progress', phase: 'level', done: 0, total: file.size });
      const bytes = new Uint8Array(await file.arrayBuffer());
      post({ type: 'progress', phase: 'level', done: file.size, total: file.size });
      say('reading the level…');
      project = await readLevelProject(file.name, bytes, webInflate);
      // Busiest first: a sequencer with one instrument in it is rarely the one
      // somebody opened the file to hear.
      const list = project.sequencers
        .map((seq) => ({ uid: seq.uid, name: seq.name, tracks: seq.tracks.length }))
        .sort((a, b) => b.tracks - a.tracks);
      [rinstIndex, smpIndex] = await Promise.all([manifest('fixtures/rinst'), manifest('fixtures/smp')]);
      post({ type: 'loaded', list, instruments: rinstIndex.size, samples: smpIndex.size });
      return;
    }

    if (message.type === 'render') {
      const uid = message.uid!;
      const seq = project?.sequencers.find((s) => s.uid === uid);
      if (!seq) throw new Error(`no sequencer with uid ${uid}`);

      const started = performance.now();
      say(`rendering "${seq.name}" — ${seq.tracks.length} tracks, ${seq.lengthSteps} steps…`);
      const result = await renderSequencer(seq, await loaderFor(), {
        secondsArg: message.seconds ?? 0,
        fromArg: message.from ?? 0,
        onProgress: (phase, done, total) => {
          post({ type: 'progress', phase, done, total });
        },
      });
      const elapsed = (performance.now() - started) / 1000;
      const { pcm, norm } = toPcm16(result.left, result.right);
      const wav = writeWav(pcm, 2, RATE);
      post(
        {
          type: 'done',
          uid,
          name: seq.name,
          tempo: seq.tempo,
          tracks: seq.tracks.length,
          left: result.left,
          right: result.right,
          wav,
          stats: {
            seconds: result.seconds,
            frames: result.frames,
            events: result.events,
            played: result.played,
            skipped: result.skipped,
            stolen: result.stolen,
            echoRel: result.echoRel,
            reverbRel: result.reverbRel,
            clippedFrames: result.clippedFrames,
            peak: result.peak,
            rms: result.rms,
            norm,
            elapsed,
            echoSeconds: result.echo.seconds,
            reverbPreset: result.preset,
            voicesMs: result.timings.voicesMs,
            mixMs: result.timings.mixMs,
            effectsMs: result.timings.effectsMs,
          },
        },
        [result.left.buffer, result.right.buffer, wav.buffer],
      );
    }
  } catch (error) {
    post({ type: 'error', text: String((error as Error)?.stack ?? error) });
  }
};
