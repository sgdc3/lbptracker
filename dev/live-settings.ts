/**
 * Prove that tempo, swing and the channel mixer can be applied LIVE.
 *
 *   node --experimental-strip-types dev/live-settings.ts     (LBP_UID picks the song)
 *
 * `dev/live.ts` used to rebuild its whole plan whenever one of those four
 * settings moved -- the tempo, the swing, `NumChannels` or a channel fader --
 * which meant re-running the render's voice pass on the thread that also feeds
 * the audio. On `Ascetic`, 1,150 tracks. A listener heard it stutter.
 *
 * None of the four changes a voice. They change **where it starts, how long it
 * lasts and how loud it is**, and all three are one line of arithmetic over a
 * musical position -- so the plan now holds steps rather than frames and a gain
 * with the channel factor divided out, and the scheduler derives the rest as it
 * posts each note.
 *
 * This is the check that says so: build the plan at the song's own settings,
 * apply new ones the way the page does, and compare against a render of a
 * sequencer that had those settings all along. The two should be identical.
 *
 * ⚠️ **The one thing that would break it is `fitBpm`**, which scales a slot's
 * playback rate by the tempo. No instrument the game ships sets it -- 0 of 68 --
 * and `test/instrument.test.ts` says so; an instrument that did would need the
 * rebuild after all.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { buildMipChain } from '../src/audio/mipmap.ts';
import { Mixer, type SampleBuffer, type VoiceSpec } from '../src/audio/mixer.ts';
import { VOICES_UNLIMITED } from '../src/core/polyphony.ts';
import { channelVolume, readLevelProject, type LevelProject } from '../src/core/project.ts';
import { RATE, renderSequencer, type LoadedInstrument } from '../src/core/render.ts';
import { loadResource } from '../src/core/resource.ts';
import { readInstrument, usedSlots } from '../src/core/rinstrument.ts';
import { swungFrame } from '../src/core/swing.ts';
import { samplesPerStep } from '../src/core/voice.ts';
import { loopRegion, readWav } from '../src/core/wav.ts';
import { nodeInflate } from '../src/platform/node.ts';

const LEVELS =
  process.env.LBP_LEVELS ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';
const wantUid = Number(process.env.LBP_UID ?? 740380);
const SECONDS = Number(process.env.LBP_SECONDS ?? 20);

/** The settings to turn to, as a listener would. */
const TEMPO = Number(process.env.LBP_TEMPO ?? 0) || undefined;
const SWING = process.env.LBP_SWING === undefined ? 0.42 : Number(process.env.LBP_SWING);
const CHANNELS = Number(process.env.LBP_CHANNELS ?? 3);

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
  const found = cache.get(guid);
  if (found !== undefined) return found;
  const entry = rinstIndex.get(guid);
  if (!entry) {
    cache.set(guid, null);
    return null;
  }
  const bytes = new Uint8Array(await readFile(path.join('fixtures/rinst', entry.file)));
  const inst = readInstrument((await loadResource(bytes, nodeInflate)).data);
  const slots = [];
  for (const { slot, guid: sampleGuid } of usedSlots(inst)) {
    const smp = smpIndex.get(sampleGuid);
    if (!smp) continue;
    const wav = readWav(new Uint8Array(await readFile(path.join('fixtures/smp', smp.file))));
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

let project: LevelProject | undefined;
for (const entry of await readdir(LEVELS, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  try {
    const found = await readLevelProject(
      entry.name,
      new Uint8Array(await readFile(path.join(LEVELS, entry.name))),
      nodeInflate,
    );
    if (found.sequencers.some((s) => s.uid === wantUid)) {
      project = found;
      break;
    }
  } catch {
    // Not a level, or one this parser does not read. Keep looking.
  }
}
const seq = project?.sequencers.find((s) => s.uid === wantUid);
if (!seq) throw new Error(`no sequencer ${wantUid} under ${LEVELS}`);

/** What the plan holds: musical position, the row, and the gain without it. */
interface Planned {
  readonly startStep: number;
  readonly endStep?: number;
  readonly row: number;
  readonly baseGain: number;
  /** Each control point's offset from the note's start, in steps. */
  readonly pointSteps: readonly number[];
  readonly spec: VoiceSpec;
}

/**
 * The voice with its in-note automation put back on the current clock.
 *
 * ❗ `automation` and `morph.points` are frames from the voice's own start, and
 * those frames were bent by the tempo AND the swing. Everything else about a
 * voice is in seconds or is a ratio, so this is the only part a live change has
 * to rebuild -- a handful of numbers per note.
 */
function onClock(p: Planned, stepFrames: number, swing: number): VoiceSpec {
  const base = swungFrame(p.startStep, stepFrames, swing);
  const frameAt = (offset: number) =>
    Math.round(swungFrame(p.startStep + offset, stepFrames, swing) - base);
  const spec = p.spec;
  return {
    ...spec,
    automation: spec.automation?.map((point, index) => ({
      ...point,
      frame: frameAt(p.pointSteps[index] ?? 0),
    })),
    morph: spec.morph === undefined ? undefined : {
      ...spec.morph,
      points: spec.morph.points.map((point, index) => ({
        ...point,
        frame: frameAt(p.pointSteps[index] ?? 0),
      })),
    },
  };
}

const plan: Planned[] = [];
await renderSequencer(seq, loadInstrument, {
  planOnly: true,
  panWidth: 1,
  voiceLimit: VOICES_UNLIMITED,
  onVoice: (voice, where) => {
    // The phases are drawn here, from the render's own generator, exactly as
    // the page does -- otherwise each mixer draws its own and the two renders
    // differ for a reason that has nothing to do with the settings.
    const draw = voice.random ?? Math.random;
    const phase = [0, 1, 2].map(
      (n) => draw() * 2 * Math.PI + (voice.lfoPhaseOffset?.[n] ?? 0),
    ) as unknown as readonly [number, number, number];
    plan.push({
      startStep: where.startStep,
      endStep: where.endStep,
      row: where.row,
      baseGain: where.channelGain === 0 ? voice.gain : voice.gain / where.channelGain,
      pointSteps: where.pointSteps,
      spec: { ...voice, random: () => 0, lfoPhaseOffset: phase },
    });
  },
});
plan.sort((a, b) => a.startStep - b.startStep);

/* ------------------------------------------------- the settings, applied live */

const tempo = TEMPO ?? seq.tempo * 1.37;
const volumes = seq.volumes.map((v, i) => (i % 2 === 0 ? v : v * 0.5));
const turned = { ...seq, tempo, swing: SWING, numChannels: CHANNELS, volumes };

const stepFrames = samplesPerStep(RATE, tempo);
const frameOf = (step: number) => Math.round(swungFrame(step, stepFrames, SWING));
const frames = Math.round(SECONDS * RATE);

function renderLive(): [Float32Array, Float32Array] {
  const mixer = new Mixer(RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (const p of plan) {
    const at = frameOf(p.startStep);
    if (at >= frames) continue;
    const life = p.endStep === undefined ? undefined : Math.max(0, frameOf(p.endStep) - at);
    mixer.play({
      ...onClock(p, stepFrames, SWING),
      gain: p.baseGain * channelVolume(turned, { gridY: p.row }),
      startFrame: at,
      endFrame: life === undefined ? undefined : at + life,
    });
  }
  mixer.render(left, right);
  return [left, right];
}

async function renderTurned(): Promise<[Float32Array, Float32Array]> {
  const mixer = new Mixer(RATE);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  await renderSequencer(turned, loadInstrument, {
    planOnly: true,
    panWidth: 1,
    voiceLimit: VOICES_UNLIMITED,
    onVoice: (voice) => {
      const draw = voice.random ?? Math.random;
      const phase = [0, 1, 2].map(
        (n) => draw() * 2 * Math.PI + (voice.lfoPhaseOffset?.[n] ?? 0),
      ) as unknown as readonly [number, number, number];
      if ((voice.startFrame ?? 0) >= frames) return;
      mixer.play({ ...voice, random: () => 0, lfoPhaseOffset: phase });
    },
  });
  mixer.render(left, right);
  return [left, right];
}

const [ll, lr] = renderLive();
const [tl, tr] = await renderTurned();

const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) || 0;
let err = 0;
let sig = 0;
let worst = 0;
let worstAt = 0;
for (let i = 0; i < frames; i += 1) {
  for (const [a, b] of [[ll, tl], [lr, tr]] as [Float32Array, Float32Array][]) {
    const d = Math.abs(a[i] - b[i]);
    err += d * d;
    sig += b[i] * b[i];
    if (d > worst) {
      worst = d;
      worstAt = i;
    }
  }
}
const dB = 10 * Math.log10(err / Math.max(sig, 1e-30));

console.log(`"${seq.name}" — ${seq.tracks.length} tracks`);
console.log(`  settings turned: ${seq.tempo} -> ${tempo.toFixed(1)} BPM, swing ${seq.swing} -> ` +
  `${SWING}, NumChannels ${seq.numChannels} -> ${CHANNELS}, every odd fader halved`);
console.log(`  applied live   rms ${rms(ll).toFixed(6)}`);
console.log(`  rendered with  rms ${rms(tl).toFixed(6)}`);
console.log(`  difference: ${dB.toFixed(1)} dB relative, worst ${worst.toExponential(2)} at ` +
  `${(worstAt / RATE).toFixed(3)} s`);
process.exit(dB < -100 ? 0 : 1);
