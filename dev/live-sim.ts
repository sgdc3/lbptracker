/**
 * Reproduce the live scheduler under Node, so a bug in it can be found in
 * seconds instead of by ear.
 *
 *   node --experimental-strip-types dev/live-sim.ts        (LBP_UID picks the song)
 *
 * It builds the plan exactly as `dev/live.ts` does -- `renderSequencer` with
 * `planOnly` and `onVoice` -- and then feeds it to a `Mixer` the way the page
 * feeds the worklet: in look-ahead bursts, with `startFrame` rewritten to a
 * delay and `endFrame`/`cutFrame` rebased onto it. The result is compared
 * against the plain render of the same voices.
 *
 * ⚠️ **The two should be identical.** They are the same voices with the same
 * specs; only the moment each is handed over differs, and a delay the mixer
 * counts down is supposed to make that invisible. Any difference is the
 * scheduler's, and this is the smallest thing that can show it.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { buildMipChain } from '../src/audio/mipmap.ts';
import { Mixer, type SampleBuffer, type VoiceSpec } from '../src/audio/mixer.ts';
import { allocateVoices, LiveVoicePool, VOICES_UNLIMITED } from '../src/core/polyphony.ts';
import { readLevelProject, type LevelProject } from '../src/core/project.ts';
import { RATE, renderSequencer, type LoadedInstrument } from '../src/core/render.ts';
import { loadResource } from '../src/core/resource.ts';
import { readInstrument, usedSlots } from '../src/core/rinstrument.ts';
import { loopRegion, readWav } from '../src/core/wav.ts';
import { swungFrame } from '../src/core/swing.ts';
import { nodeInflate } from '../src/platform/node.ts';

const LEVELS =
  process.env.LBP_LEVELS ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';
const wantUid = Number(process.env.LBP_UID ?? 740380);
/** Seconds of look-ahead and the tick, matching dev/live.ts. */
const LOOKAHEAD = Number(process.env.LBP_LOOKAHEAD ?? 0.35);
const TICK = Number(process.env.LBP_TICK ?? 0.1);
const SECONDS = Number(process.env.LBP_SECONDS ?? 30);
const STRIP = (process.env.LBP_STRIP ?? '').split(',').filter(Boolean);

const manifest = async (dir: string) =>
  new Map(
    (JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
      guid: number;
      file: string;
    }[]).map((r) => [r.guid, r]),
  );
const rinstIndex = await manifest('fixtures/rinst');
const smpIndex = await manifest('fixtures/smp');

const cache = new Map<number, LoadedInstrument | null>();
async function loadInstrument(guid: number): Promise<LoadedInstrument | null> {
  const hit = cache.get(guid);
  if (hit !== undefined) return hit;
  const row = rinstIndex.get(guid);
  if (!row) {
    cache.set(guid, null);
    return null;
  }
  const bytes = new Uint8Array(await readFile(path.join('fixtures/rinst', row.file)));
  const inst = readInstrument((await loadResource(bytes, nodeInflate)).data);
  const slots = [];
  for (const { slot, guid: sampleGuid } of usedSlots(inst)) {
    const s = smpIndex.get(sampleGuid);
    if (!s) continue;
    const wav = readWav(new Uint8Array(await readFile(path.join('fixtures/smp', s.file))));
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
}

type Seq = LevelProject['sequencers'][number];
let seq: Seq | undefined;
for (const entry of await readdir(LEVELS, { withFileTypes: true })) {
  if (!entry.isFile() || seq) continue;
  try {
    const project = await readLevelProject(
      entry.name,
      new Uint8Array(await readFile(path.join(LEVELS, entry.name))),
      nodeInflate,
    );
    seq = project.sequencers.find((s) => s.uid === wantUid);
  } catch {
    /* a level that does not parse is not the one we want */
  }
}
if (!seq) throw new Error(`no sequencer with uid ${wantUid} under ${LEVELS}`);
console.log(`"${seq.name}" — ${seq.tracks.length} tracks, ${seq.tempo} BPM`);

/** Every voice the render would mix, with its end kept as a duration. */
interface Planned {
  at: number;
  spec: VoiceSpec;
  life?: number;
  cut?: number;
  /** What the voice pool needs, in its own units. */
  poolStart: number;
  poolEnd: number;
  /** The note, and which stack layer of it: the pool counts notes. */
  note: number;
  layer: number;
  score: number;
  /** Frames per step, so a pool decision in steps becomes a cut in frames. */
  index: number;
}
const plan: Planned[] = [];
const planResult = await renderSequencer(seq, loadInstrument, {
  planOnly: true,
  panWidth: 1,
  // Uncapped on purpose: the point of the exercise is to apply the pool live,
  // so the plan must not have its cuts baked in.
  voiceLimit: VOICES_UNLIMITED,
  onVoice: (voice, where) => {
    // ⚠️ **The spec's `random` is the render's own seeded PRNG, and it is
    // shared.** Handing the same spec to three mixers means each `new Voice`
    // draws three more values from one stream, so the three renders get
    // different LFO phases and differ for a reason that has nothing to do with
    // what is being compared. Drawing the phases here -- exactly as
    // `dev/live.ts` does -- freezes them, and the variants become comparable.
    const draw = voice.random ?? Math.random;
    const phase = [0, 1, 2].map(
      (n) => draw() * 2 * Math.PI + (voice.lfoPhaseOffset?.[n] ?? 0),
    ) as unknown as readonly [number, number, number];
    // `LBP_STRIP=envelope,filter` drops fields from every spec before it is
    // played, which is how the block-size divergence gets bisected: strip until
    // the blocked render matches the direct one, and the last thing removed is
    // the trigger.
    const stripped: Record<string, unknown> = {
      ...voice,
      random: () => 0,
      lfoPhaseOffset: phase,
    };
    for (const field of STRIP) delete stripped[field];
    plan.push({
      note: where.note,
      layer: where.layer,
      poolStart: where.poolStart,
      poolEnd: where.poolEnd,
      score: where.score,
      index: plan.length,
      at: where.startFrame,
      spec: stripped as unknown as VoiceSpec,
      life: voice.endFrame === undefined ? undefined : Math.max(0, voice.endFrame - where.startFrame),
      cut: voice.cutFrame === undefined ? undefined : Math.max(0, voice.cutFrame - where.startFrame),
    });
  },
});
plan.sort((a, b) => a.at - b.at);
const stepFrames = planResult.framesPerStep;
const POOL = Number(process.env.LBP_POOL ?? 8);
const swing = seq.swing;
/** A pool decision, which the allocator gives in steps, as an absolute frame. */
const cutFrameAt = (step: number) => Math.round(swungFrame(step, stepFrames, swing));

// The reference: the cuts `allocateVoices` would have baked in for this pool,
// applied to the uncapped plan. `renderDirect` then renders exactly what the
// renderer would write at this pool size.
if (process.env.LBP_LIVEPOOL === '1') {
  // ❗ **One record per NOTE, not per stack layer** -- the engine plays every
  // layer of a note out of the one record. Asking per layer steals two and a
  // half times as often on a stacked song; see question 17.
  const firsts = plan.filter((p) => p.layer === 0);
  const decided = allocateVoices(
    firsts.map((p) => ({ start: p.poolStart, end: p.poolEnd, score: p.score })),
    POOL,
  );
  const cutOf = new Map<number, number>();
  for (const row of decided) {
    const p = firsts[row.index];
    if (row.end < p.poolEnd) cutOf.set(p.note, row.end);
  }
  let stolen = 0;
  for (const p of plan) {
    const end = cutOf.get(p.note);
    if (end === undefined) continue;
    const abs = cutFrameAt(end);
    p.cut = abs - p.at;
    // The one-call reference plays `spec` verbatim, so its cut has to be
    // there too -- in absolute frames, which is what that render counts in.
    (p.spec as unknown as { cutFrame?: number }).cutFrame = abs;
    if (p.layer === 0) stolen += 1;
  }
  console.log(`pool ${POOL}: ${stolen} of ${cutOf.size + (firsts.length - cutOf.size)} notes stolen offline`);
}
const frames = Math.min(Math.round(SECONDS * RATE), Math.max(...plan.map((p) => p.at)) + RATE);
console.log(`${plan.length} voices; comparing the first ${(frames / RATE).toFixed(1)} s`);

/** The straight render: every voice handed over at once, as renderSequencer does. */
function renderDirect(): [Float32Array, Float32Array] {
  const mixer = new Mixer(RATE);
  for (const p of plan) if (p.at < frames) mixer.play(p.spec);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  mixer.render(left, right);
  return [left, right];
}

/** The live path: bursts of voices, each with its frames rebased onto a delay. */
function renderScheduled(): [Float32Array, Float32Array] {
  const mixer = new Mixer(RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const block = Math.round(TICK * RATE);
  let next = 0;
  for (let start = 0; start < frames; start += block) {
    const now = start;
    const until = now + LOOKAHEAD * RATE;
    while (next < plan.length && plan[next].at < until) {
      const p = plan[next];
      const delay = Math.max(0, Math.round(p.at - now));
      mixer.play({
        ...p.spec,
        startFrame: delay,
        endFrame: p.life === undefined ? undefined : delay + p.life,
        cutFrame: p.cut === undefined ? undefined : delay + p.cut,
      });
      next += 1;
    }
    const size = Math.min(block, frames - start);
    mixer.render(left.subarray(start, start + size), right.subarray(start, start + size));
  }
  return [left, right];
}

/**
 * The same voices, all handed over at once as the render does, but rendered in
 * blocks as the worklet does. This separates two very different faults: a
 * scheduler that hands voices over badly, and a mixer whose output depends on
 * the size of the block it is asked for.
 */
function renderBlocked(): [Float32Array, Float32Array] {
  const mixer = new Mixer(RATE);
  for (const p of plan) if (p.at < frames) mixer.play(p.spec);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const block = Number(process.env.LBP_BLOCK ?? 128);
  for (let start = 0; start < frames; start += block) {
    const size = Math.min(block, frames - start);
    mixer.render(left.subarray(start, start + size), right.subarray(start, start + size));
  }
  return [left, right];
}

/**
 * `LBP_SCAN=1` renders each planned voice ON ITS OWN, once in a single call and
 * once in 128-frame blocks, and prints the ones that disagree.
 *
 * A whole song diverging says only that something is wrong; one voice diverging
 * hands over a spec small enough to put in a unit test.
 */
/** `LBP_DIFF=n` finds the first frame at which one voice's two renders part. */
if (process.env.LBP_DIFF !== undefined) {
  const p = plan[Number(process.env.LBP_DIFF)];
  const span = (p.life ?? 48000) + 24000;
  const one = (blockSize: number) => {
    const mixer = new Mixer(RATE);
    mixer.play({ ...p.spec, startFrame: 0 });
    const left = new Float32Array(span);
    const right = new Float32Array(span);
    for (let at = 0; at < span; at += blockSize) {
      const size = Math.min(blockSize, span - at);
      mixer.render(left.subarray(at, at + size), right.subarray(at, at + size));
    }
    return left;
  };
  const whole = one(span);
  const chunked = one(128);
  let first = -1;
  for (let i = 0; i < span; i += 1) {
    if (Math.abs(whole[i] - chunked[i]) > 1e-7) {
      first = i;
      break;
    }
  }
  const spec = p.spec as unknown as Record<string, unknown>;
  console.log(`life ${p.life}  loop ${JSON.stringify(p.spec.sample.loop)}  rate ${p.spec.playbackRate}`);
  console.log(`envelope ${JSON.stringify(spec.envelope)}  hold ${String(spec.holdFrames)}`);
  console.log(`first difference at frame ${first} (block ${Math.floor(first / 128)}, offset ${first % 128})`);
  for (let i = Math.max(0, first - 2); i < first + 6 && i < span; i += 1) {
    console.log(`  ${i}: one-call ${whole[i].toFixed(6)}   blocked ${chunked[i].toFixed(6)}`);
  }
  let lastOne = 0;
  let lastChunk = 0;
  for (let i = 0; i < span; i += 1) {
    if (whole[i] !== 0) lastOne = i;
    if (chunked[i] !== 0) lastChunk = i;
  }
  console.log(`last non-zero: one-call ${lastOne}, blocked ${lastChunk}`);
  process.exit(0);
}

if (process.env.LBP_SCAN === '1') {
  const limit = Number(process.env.LBP_SCAN_VOICES ?? 400);
  const block = 128;
  let bad = 0;
  for (let v = 0; v < Math.min(limit, plan.length); v += 1) {
    const p = plan[v];
    const span = (p.life ?? 48000) + 48000;
    const one = (blockSize: number) => {
      const mixer = new Mixer(RATE);
      mixer.play({ ...p.spec, startFrame: 0 });
      const left = new Float32Array(span);
      const right = new Float32Array(span);
      for (let at = 0; at < span; at += blockSize) {
        const size = Math.min(blockSize, span - at);
        mixer.render(left.subarray(at, at + size), right.subarray(at, at + size));
      }
      return left;
    };
    const whole = one(span);
    const chunked = one(block);
    let err = 0;
    let sig = 0;
    for (let i = 0; i < span; i += 1) {
      err += (whole[i] - chunked[i]) ** 2;
      sig += whole[i] ** 2;
    }
    if (sig > 1e-12 && err / sig > 1e-8) {
      bad += 1;
      if (bad <= 5) {
        const spec = p.spec as unknown as Record<string, unknown>;
        console.log(
          `voice ${v}: ${(10 * Math.log10(err / sig)).toFixed(1)} dB  ` +
            `life ${p.life}  loop ${JSON.stringify(p.spec.sample.loop)}  ` +
            `rate ${p.spec.playbackRate.toFixed(4)}  ` +
            `hold ${String(spec.holdFrames)}  env ${spec.envelope ? 'yes' : 'no'}  ` +
            `len ${p.spec.sample.channels[0].length}`,
        );
      }
    }
  }
  console.log(`${bad} of ${Math.min(limit, plan.length)} voices differ on their own`);
  process.exit(0);
}

/**
 * The live path with the pool run at post time by `LiveVoicePool`, against a
 * plan that has no cuts in it.
 *
 * ⚠️ This is the thing being proved: that deciding the stealing one note at a
 * time, as the engine does, gives the same audio as deciding it for the whole
 * song at once, as the renderer does.
 */
function renderLivePool(): [Float32Array, Float32Array] {
  const mixer = new Mixer(RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const block = Math.round(TICK * RATE);
  const pool = new LiveVoicePool(POOL);
  /** Voices handed over, so a steal can reach back and cut one. */
  const live = new Map<number, number>();
  let next = 0;
  for (let start = 0; start < frames; start += block) {
    const now = start;
    const until = now + LOOKAHEAD * RATE;
    while (next < plan.length && plan[next].at < until) {
      const p = plan[next];
      const { end, stole } = pool.add(p.index, {
        start: p.poolStart,
        end: p.poolEnd,
        score: p.score,
      });
      const delay = Math.max(0, Math.round(p.at - now));
      const cutFrames = end < p.poolEnd ? cutFrameAt(end) - p.at : undefined;
      mixer.play({
        ...p.spec,
        tag: p.index,
        startFrame: delay,
        endFrame: p.life === undefined ? undefined : delay + p.life,
        // ⚠️ From the live pool, never from `p.cut` -- that field holds the
        // reference the other variants render, and using it here would compare
        // the answer with itself.
        cutFrame: cutFrames === undefined ? undefined : delay + cutFrames,
      });
      live.set(p.index, p.at);
      if (stole) {
        // The victim stops at the thief's start. `cut` counts the frames it
        // still gets to sound, so measure from wherever it actually is.
        const startAbs = live.get(stole.index);
        if (startAbs !== undefined) {
          const atAbs = cutFrameAt(stole.at);
          mixer.cutAt(stole.index, Math.max(0, atAbs - Math.max(now, startAbs)));
        }
      }
      next += 1;
    }
    const size = Math.min(block, frames - start);
    mixer.render(left.subarray(start, start + size), right.subarray(start, start + size));
  }
  return [left, right];
}

const [dl, dr] = renderDirect();
const [bl, br] = renderBlocked();
const [sl, sr] = renderScheduled();

let err = 0;
let sig = 0;
let worst = 0;
let worstAt = 0;
for (let i = 0; i < frames; i += 1) {
  const e = (dl[i] - sl[i]) ** 2 + (dr[i] - sr[i]) ** 2;
  err += e;
  sig += dl[i] ** 2 + dr[i] ** 2;
  if (e > worst) {
    worst = e;
    worstAt = i;
  }
}
const rms = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < frames; i += 1) s += a[i] ** 2 + b[i] ** 2;
  return Math.sqrt(s / (2 * frames));
};
const compare = (label: string, a: Float32Array, b: Float32Array) => {
  let e = 0;
  let g = 0;
  for (let i = 0; i < frames; i += 1) {
    e += (dl[i] - a[i]) ** 2 + (dr[i] - b[i]) ** 2;
    g += dl[i] ** 2 + dr[i] ** 2;
  }
  console.log(
    `${label.padEnd(22)} rms ${rms(a, b).toFixed(6)}  ` +
      `vs direct ${(10 * Math.log10(e / Math.max(g, 1e-30))).toFixed(1)} dB`,
  );
};
compare('blocked, played once', bl, br);
compare('scheduled (live)', sl, sr);
if (process.env.LBP_LIVEPOOL === '1') {
  const [pl, pr] = renderLivePool();
  compare('live pool', pl, pr);
}
console.log(`direct    rms ${rms(dl, dr).toFixed(6)}`);
console.log(`scheduled rms ${rms(sl, sr).toFixed(6)}`);
console.log(
  `difference: ${(10 * Math.log10(err / Math.max(sig, 1e-30))).toFixed(1)} dB relative, ` +
    `worst at ${(worstAt / RATE).toFixed(3)} s`,
);
