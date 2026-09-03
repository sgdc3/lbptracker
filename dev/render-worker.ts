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

import { loaderFor, manifest, type Manifest } from './assets.ts';
import {
  RATE,
  renderSequencer,
  toPcm16,
  type LoadedInstrument,
} from '../src/core/render.ts';
import { readLevelProject, type LevelProject } from '../src/core/project.ts';
import { writeWav } from '../src/core/wav.ts';
import { webInflate } from '../src/platform/web.ts';

let project: LevelProject | null = null;
let rinstIndex: Manifest | null = null;
let smpIndex: Manifest | null = null;

const post = (message: unknown, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

const say = (text: string) => post({ type: 'status', text });

self.onmessage = async (event: MessageEvent) => {
  const message = event.data as {
    type: string;
    uid?: number;
    seconds?: number;
    from?: number;
    /**
     * Engine switches; each absent one leaves its measured default.
     *
     * ⚠️ **More are accepted here than the page offers.** `oneShot`,
     * `noKeyTrack` and `unpitchedPercussion` stay reachable because they are how
     * their laws were measured, but each of those laws is now settled, so a
     * switch for it on the page would only offer a way to render something known
     * to be wrong. `dev/render-level.ts` still exposes them as env vars.
     */
    panWidth?: number;
    oneShot?: 'full' | 'natural' | 'gate';
    voiceLimit?: number;
    reverb?: boolean;
    echo?: boolean;
    clip?: boolean;
    noKeyTrack?: boolean;
    unpitchedPercussion?: boolean;
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
      const result = await renderSequencer(seq, await loaderFor(rinstIndex!, smpIndex!), {
        secondsArg: message.seconds ?? 0,
        fromArg: message.from ?? 0,
        // Each absent field means the measured default; the page always sends them.
        ...(message.panWidth === undefined ? {} : { panWidth: message.panWidth }),
        ...(message.oneShot === undefined ? {} : { oneShot: message.oneShot }),
        ...(message.voiceLimit === undefined ? {} : { voiceLimit: message.voiceLimit }),
        ...(message.reverb === undefined ? {} : { reverb: message.reverb }),
        ...(message.echo === undefined ? {} : { echo: message.echo }),
        ...(message.clip === undefined ? {} : { clip: message.clip }),
        ...(message.noKeyTrack === undefined ? {} : { noKeyTrack: message.noKeyTrack }),
        ...(message.unpitchedPercussion === undefined
          ? {}
          : { unpitchedPercussion: message.unpitchedPercussion }),
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
