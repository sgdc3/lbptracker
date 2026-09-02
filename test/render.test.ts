import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { existsSync as exists } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { buildMipChain } from '../src/audio/mipmap.ts';
import { type SampleBuffer } from '../src/audio/mixer.ts';
import { RATE, renderSequencer, toPcm16, type LoadedInstrument } from '../src/core/render.ts';
import { readLevelProject, type Sequencer } from '../src/core/project.ts';
import { readInstrument, usedSlots } from '../src/core/rinstrument.ts';
import { loadResourceFile, nodeInflate } from '../src/platform/node.ts';
import { loopRegion, readWav } from '../src/core/wav.ts';

const LEVELS =
  process.env.LBP_LEVELS ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';
const RINST = 'fixtures/rinst';
const SMP = 'fixtures/smp';

/**
 * Load the reference sequencer and a Node instrument loader.
 *
 * ⚠️ This is the *same* loader shape `dev/render-worker.ts` builds from `fetch`,
 * and that is the whole point of `src/core/render.ts`: a browser render differs
 * from a Node one only in how bytes arrive. On 2026-09-02 both were run on
 * `This Is Halloween` end to end and produced the **same 70,704,044-byte file
 * with the same SHA-256** (`1785d0d8…`). ⚠️ That file predates the voice-pool
 * fix later the same day; the equality it demonstrates does not. A test cannot
 * drive a browser, so what
 * is pinned below is the property that made that comparison meaningful: the
 * pipeline is deterministic, and its output depends on the seed and on nothing
 * else.
 */
async function fixture(): Promise<{
  seq: Sequencer;
  load: (guid: number) => Promise<LoadedInstrument | null>;
} | null> {
  if (!exists(LEVELS) || !exists(RINST) || !exists(SMP)) return null;
  const manifest = async (dir: string) =>
    new Map<number, { file: string }>(
      (JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
        guid: number;
        file: string;
      }[]).map((r) => [r.guid, r]),
    );
  const rinstIndex = await manifest(RINST);
  const smpIndex = await manifest(SMP);

  const all: Sequencer[] = [];
  for (const entry of await readdir(LEVELS, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      const project = await readLevelProject(
        entry.name,
        new Uint8Array(await readFile(path.join(LEVELS, entry.name))),
        nodeInflate,
      );
      all.push(...project.sequencers);
    } catch {
      // A file that is not a level, or one this walk cannot read yet.
      // `dev/verify-levels.ts` is where that is a failure; here it is noise.
    }
  }
  const seq = all
    .filter((s) => s.tracks.length >= 3 && s.lengthSteps > 32)
    .sort((a, b) => b.tracks.length - a.tracks.length)[0];
  if (!seq) return null;

  const cache = new Map<number, LoadedInstrument | null>();
  const load = async (guid: number) => {
    const hit = cache.get(guid);
    if (hit !== undefined) return hit;
    const row = rinstIndex.get(guid);
    if (!row) {
      cache.set(guid, null);
      return null;
    }
    const inst = readInstrument((await loadResourceFile(path.join(RINST, row.file))).data);
    const slots = [];
    for (const { slot, guid: sampleGuid } of usedSlots(inst)) {
      const s = smpIndex.get(sampleGuid);
      if (!s) continue;
      const wav = readWav(await readFile(path.join(SMP, s.file)));
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
  return { seq, load };
}

const sha = (pcm: Int16Array) =>
  createHash('sha256').update(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)).digest('hex');

test('the pipeline is deterministic, which is what makes a cross-platform hash mean anything', async (t) => {
  const f = await fixture();
  if (!f) {
    t.skip(`no ${LEVELS} / ${RINST} / ${SMP} — see the header of dev/render-level.ts`);
    return;
  }
  const options = { secondsArg: 4 };
  const a = await renderSequencer(f.seq, f.load, options);
  const b = await renderSequencer(f.seq, f.load, options);
  assert.equal(a.frames, RATE * 4);
  assert.equal(sha(toPcm16(a.left, a.right).pcm), sha(toPcm16(b.left, b.right).pcm));
  // ⚠️ Not a tautology: `VoiceSpec.random` once came from `Math.random`, so two
  // runs of the same build produced different files and a hash could not be used
  // to check that an optimisation had changed nothing.
  assert.ok(a.played > 0, 'the window has notes in it');
  assert.ok(Number.isFinite(a.peak) && a.peak > 0);
});

test('the seed is actually used', async (t) => {
  const f = await fixture();
  if (!f) {
    t.skip(`no ${LEVELS}`);
    return;
  }
  // ⚠️ 20 seconds, not 2. The PRNG only reaches the output through an LFO phase
  // or a stack layer after the first, and the reference sequencer's opening two
  // seconds have neither -- 61 notes, all `Numstack` 1, no LFO depth -- so a
  // 2-second window renders identically under any seed and this test passed
  // vacuously in the other direction. At 20 seconds, 821 notes in, it does not.
  const a = await renderSequencer(f.seq, f.load, { secondsArg: 20 });
  const b = await renderSequencer(f.seq, f.load, { secondsArg: 20, seed: 0x1234567 });
  assert.notEqual(sha(toPcm16(a.left, a.right).pcm), sha(toPcm16(b.left, b.right).pcm));
});

test('the effects reach the mix, and turning the clip off changes the output', async (t) => {
  const f = await fixture();
  if (!f) {
    t.skip(`no ${LEVELS}`);
    return;
  }
  const withClip = await renderSequencer(f.seq, f.load, { secondsArg: 4 });
  assert.ok(withClip.reverbRel > 0, 'the reverb send reaches the reverb');
  const noClip = await renderSequencer(f.seq, f.load, { secondsArg: 4, clip: false });
  // The clip may or may not engage on this window; what must hold is that the
  // switch is wired to the output rather than only to the report.
  if (withClip.clippedFrames > 0) {
    assert.notEqual(
      sha(toPcm16(withClip.left, withClip.right).pcm),
      sha(toPcm16(noClip.left, noClip.right).pcm),
    );
  }
  assert.equal(noClip.clippedFrames, 0, 'a disabled clip counts nothing');
});
