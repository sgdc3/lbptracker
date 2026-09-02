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
 * ⚠️ **The dump is opened by the user, and only by the user.** The page hands
 * this worker a `File` and it reads that; there is no fetch path and no fallback
 * to a copy on the host. That is not a preference, it is what lets the whole
 * thing be a static site -- a bucket cannot host other people's levels, and
 * `steering/game-assets.md` says it must not try.
 *
 * ❗ The game's own instrument definitions and samples (`fixtures/rinst`,
 * `fixtures/smp`) are **still fetched**, and they are the same class of asset.
 * They have to move to the same footing before this can be deployed anywhere.
 *
 * ⚠️ **The dump is 81 MB.** Parsing all 129,696 rows in a browser tab is
 * possible but wasteful, so this keeps the text and parses only the lines of the
 * sequencer being rendered, found by a substring match on `"seqUID":<uid>,`.
 * The index the page picks from is built with one regex pass instead.
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
import { importLevel, type DumpRow } from '../src/core/project.ts';
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

let dumpText: string | null = null;
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

/**
 * ⚠️ latin1, not UTF-8: the dump carries creator-authored names that are not
 * always valid UTF-8, and the Node renderer reads it the same way. It only
 * affects the display name -- every field the audio depends on is ASCII.
 */
const decode = (bytes: AllowSharedBufferSource) =>
  new TextDecoder('windows-1252').decode(bytes);

/** Read a dump the user opened. Nothing leaves the browser. */
async function readDump(file: File): Promise<string> {
  post({ type: 'progress', phase: 'dump', done: 0, total: file.size });
  const bytes = await file.arrayBuffer();
  post({ type: 'progress', phase: 'dump', done: file.size, total: file.size });
  return decode(bytes);
}

/** The sequencer list, without parsing 129,696 JSON objects. */
function index(text: string) {
  const seen = new Map<number, { uid: number; name: string; rows: number }>();
  const re = /"seqUID":(\d+),"seqName":"((?:[^"\\]|\\.)*)"/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const uid = Number(m[1]);
    const hit = seen.get(uid);
    if (hit) hit.rows += 1;
    else seen.set(uid, { uid, name: m[2], rows: 1 });
  }
  return [...seen.values()].sort((a, b) => b.rows - a.rows);
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
      say(`reading ${message.file.name}…`);
      dumpText = await readDump(message.file);
      say('indexing…');
      const list = index(dumpText);
      [rinstIndex, smpIndex] = await Promise.all([manifest('fixtures/rinst'), manifest('fixtures/smp')]);
      post({ type: 'loaded', list, instruments: rinstIndex.size, samples: smpIndex.size });
      return;
    }

    if (message.type === 'render') {
      const uid = message.uid!;
      say('parsing the sequencer…');
      const needle = `"seqUID":${uid},`;
      const rows: DumpRow[] = [];
      for (const line of dumpText!.split('\n')) {
        if (line.startsWith('{') && line.includes(needle)) rows.push(JSON.parse(line));
      }
      const seq = importLevel(rows)
        .flatMap((level) => level.sequencers)
        .find((s) => s.uid === uid);
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
