/**
 * Render one sequencer from a real level to a WAV.
 *
 * This is the end-to-end proof for level import: dump row -> notes -> key
 * splits -> pitch formula -> mipmapped linear sampler -> ADSR -> Moog ladder ->
 * LFOs -> mixer -> file. Everything the project has recovered, in one pass over
 * somebody's actual composition.
 *
 *   node --experimental-strip-types dev/render-level.ts [seqIndex] [seconds]
 *
 * Needs the corpus dump at fixtures/levels/sequencers.jsonl (tools/RawDump.java)
 * and the extracted instruments at fixtures/rinst and fixtures/smp
 * (tools/ExtractGuid.java). All of that is the user's own game data and none of
 * it is committed.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Echo, Reverb, reverbPreset } from '../src/audio/effects.ts';
import { Mixer, type SampleBuffer, type VoiceSpec } from '../src/audio/mixer.ts';
import { buildMipChain } from '../src/audio/mipmap.ts';
import { FILTER_PARAMS } from '../src/audio/moog.ts';
import {
  ADSR_PARAMS,
  ADSR_PARAMS_B,
  evaluateAdsr,
  evaluateParam,
} from '../src/core/envelope.ts';
import { resolveSlot } from '../src/core/instrument.ts';
import { LFO_PARAMS, OUTPUT_PARAMS, STACK_PARAMS } from '../src/core/params.ts';
import { importLevel, schedule, type DumpRow } from '../src/core/project.ts';
import { readInstrument, usedSlots, type RInstrument } from '../src/core/rinstrument.ts';
import { quantise } from '../src/core/scale.ts';
import { loadResourceFile } from '../src/platform/node.ts';
import { pitchRatio, samplesPerStep, velocityGain } from '../src/core/voice.ts';
import { readWav, writeWav, loopRegion } from '../src/core/wav.ts';

const RATE = 48000;
const seqIndex = Number(process.argv[2] ?? 0);
// 0 (or no argument) renders the sequencer end to end.
const secondsArg = Number(process.argv[3] ?? 0);

const manifest = async (dir: string) =>
  new Map<number, { file: string }>(
    (JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as {
      guid: number;
      file: string;
    }[]).map((r) => [r.guid, r]),
  );

const rinstIndex = await manifest('fixtures/rinst');
const smpIndex = await manifest('fixtures/smp');

// The dump carries creator-authored names, which are not always valid UTF-8.
const rows: DumpRow[] = [];
for (const line of (await readFile('fixtures/levels/sequencers.jsonl', 'latin1')).split('\n')) {
  if (line.startsWith('{')) rows.push(JSON.parse(line));
}

// Pick a sequencer with enough going on to be worth listening to.
const candidates = importLevel(rows)
  .flatMap((level) => level.sequencers.map((s) => ({ level: level.file, seq: s })))
  .filter((c) => c.seq.tracks.length >= 3 && c.seq.lengthSteps > 32)
  .sort((a, b) => b.seq.tracks.length - a.seq.tracks.length);

const chosen = candidates[Math.min(seqIndex, candidates.length - 1)];
if (!chosen) throw new Error('no sequencer with enough notes in the dump');
const { seq } = chosen;
console.log(
  `${chosen.level} seq ${seq.uid} "${seq.name}" — ${seq.tracks.length} tracks, ` +
    `${seq.lengthSteps} steps, tempo ${seq.tempo}, swing ${seq.swing}`,
);

/** Load one instrument and its samples, by GUID. */
const cache = new Map<number, { inst: RInstrument; slots: { wav: SampleBuffer; base: number }[] } | null>();
async function loadInstrument(guid: number) {
  if (cache.has(guid)) return cache.get(guid);
  const row = rinstIndex.get(guid);
  if (!row) return cache.set(guid, null).get(guid);
  const inst = readInstrument((await loadResourceFile(path.join('fixtures/rinst', row.file))).data);
  const slots = [];
  for (const { slot, guid: sampleGuid } of usedSlots(inst)) {
    const s = smpIndex.get(sampleGuid);
    if (!s) continue;
    const wav = readWav(await readFile(path.join('fixtures/smp', s.file)));
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

const started = process.hrtime.bigint();
// The stack randomises detune, pan and start offset per layer. A fixed seed
// keeps a render reproducible, which matters when the point of a render is to
// compare it against the last one.
let seed = 0x2545f491;
const rand = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 0x100000) / 0x100000;
};

const framesPerStep = samplesPerStep(RATE, seq.tempo);
// End to end means the last step plus whatever tail the effects still have
// to give: a reverb cut off at the final note is not the whole render.
const TAIL_SECONDS = 6;
const fullSeconds = (seq.lengthSteps * framesPerStep) / RATE + TAIL_SECONDS;
const seconds = secondsArg > 0 ? secondsArg : fullSeconds;
const frames = Math.round(seconds * RATE);
console.log(
  `rendering ${seconds.toFixed(1)}s (${seq.lengthSteps} steps at ${framesPerStep.toFixed(0)} ` +
    `frames/step` + (secondsArg > 0 ? ', truncated' : ` + ${TAIL_SECONDS}s tail`) + `)`,
);
const left = new Float32Array(frames);
const right = new Float32Array(frames);
const mixer = new Mixer(RATE);

const events = schedule(seq).filter((e) => e.step * framesPerStep < frames);
let played = 0;
let skipped = 0;
for (const event of events) {
  const loaded = await loadInstrument(event.guid);
  if (!loaded || loaded.slots.length === 0) {
    skipped += 1;
    continue;
  }
  const track = seq.tracks[event.track];
  // ⚠️ The scale quantiser is applied; the key/root offset is not. Which field
  // supplies the engine's root is open question 4, and getting it wrong
  // transposes rather than detunes -- so it is left off rather than guessed.
  const note = quantise(event.pitch, track.scale);
  // ⚠️ The slot comes from the RAW note, not the quantised one: the engine's
  // walk at 0x05a0 takes bits 8..14 of the note word with `bextr` and compares
  // that. The quantiser applies to the pitch below, not to the choice of sample.
  const zone = resolveSlot(loaded.inst, event.pitch, loaded.slots.length);
  const slot = loaded.slots[Math.min(zone, loaded.slots.length - 1)];
  const definition = loaded.inst.slots[Math.min(zone, loaded.inst.slots.length - 1)];
  const p = loaded.inst.params;
  // The note's own modulation picks a point inside EVERY parameter's `x..y`
  // range -- `voice+0x28` in the engine, `(byte3 & 0x0f) / 15`. Reading `.x`
  // instead, as this did, pins every note to the low end of every range: 19% of
  // corpus records carry a non-zero modulation and 10% carry a full one, and on
  // `synth/ghost.rinst` alone that is the difference between resonance 0.90 and
  // resonance 0.53.
  const mod = event.modulation;
  const P = (index: number) => evaluateParam(p[index], mod);
  const lfo = (n: 0 | 1 | 2) => ({
    rate: P(LFO_PARAMS[n].rate),
    depth: P(LFO_PARAMS[n].depth),
    spread: P(LFO_PARAMS[n].spread),
  });

  // The note's control points as mixer automation: semitones and gain relative
  // to the first point, at frame offsets. A one-point note gives one entry and
  // the voice stays flat.
  const base = event.points[0];
  const automation = event.points.map((p) => ({
    frame: Math.round(p.step * framesPerStep),
    pitch: quantise(p.pitch, track.scale) - note,
    gain: base.volume > 0 ? p.volume / base.volume : 1,
  }));

  // The unison stack. `Numstack` layers of the same sample, each with its own
  // random detune, pan offset and start point, at `sqrt(1 / Numstack)` gain --
  // all four measured and all four previously unused, which is why a
  // three-layer patch like `synth/ghost.rinst` came out as one thin copy.
  const layers = Math.max(1, loaded.inst.numStack);
  const stackGain = Math.sqrt(1 / layers);
  const sampleFrames = slot.wav.channels[0].length;
  const bipolar = () => rand() * 2 - 1;

  const spec: VoiceSpec = {
    sample: slot.wav,
    playbackRate: pitchRatio(definition, note, seq.tempo) * (slot.wav.sampleRate / RATE),
    gain: velocityGain(event.volume) * track.level * 2 * P(OUTPUT_PARAMS.level) * stackGain,
    pan: track.pan,
    startFrame: Math.round(event.step * framesPerStep),
    endFrame: Math.round((event.step + event.durationSteps) * framesPerStep),
    envelope: evaluateAdsr(p, ADSR_PARAMS, mod),
    filter: {
      settings: {
        cutoff: P(FILTER_PARAMS.cutoff),
        resonance: P(FILTER_PARAMS.resonance),
        keyTrack: P(FILTER_PARAMS.keyTrack),
        envAmount: P(FILTER_PARAMS.envAmount),
      },
      envelope: evaluateAdsr(p, ADSR_PARAMS_B, mod),
    },
    lfos: [lfo(0), lfo(1), lfo(2)],
    automation,
    echoSend: track.echoSend,
    reverbSend: track.reverbSend,
  };
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  for (let layer = 0; layer < layers; layer += 1) {
    mixer.play({
      ...spec,
      playbackRate: spec.playbackRate * (1 + 0.05 * P(STACK_PARAMS.detune) * bipolar()),
      pan: clamp01(spec.pan + 0.5 * P(STACK_PARAMS.spread) * bipolar()),
      startPosition: P(STACK_PARAMS.startOffset) * sampleFrames * rand(),
      lfoPhaseOffset: [0, 1, 2].map(
        (n) => P(LFO_PARAMS[n].spread) * ((2 * Math.PI) / layers) * layer,
      ) as unknown as readonly [number, number, number],
    });
  }
  played += 1;
}

const echoL = new Float32Array(frames);
const echoR = new Float32Array(frames);
const reverbL = new Float32Array(frames);
const reverbR = new Float32Array(frames);
mixer.render(left, right, { echo: [echoL, echoR], reverb: [reverbL, reverbR] });

// The two sends, mixed back over the dry signal. ⚠️ The echo's topology and the
// reverb itself are not measured -- see src/audio/effects.ts, which says which
// parts are the game's and which are ours.
const echo = new Echo(RATE, seq.echoTime, seq.tempo, seq.echoFeedback, seq.echoMix);
const preset = reverbPreset(seq.reverb);
const reverb = new Reverb(RATE, preset);
// No extra wet gain here: the preset's own millibel levels are the wet level,
// and multiplying them by a taste factor is how the reverb went inaudible.
// Measured rather than assumed: how much of the finished mix each effect is.
let dryEnergy = 0;
let echoEnergy = 0;
let reverbEnergy = 0;
for (let i = 0; i < frames; i += 1) {
  dryEnergy += left[i] ** 2 + right[i] ** 2;
  const e = echo.process(echoL[i], echoR[i]);
  echoEnergy += e.left ** 2 + e.right ** 2;
  const rl = reverb.process(reverbL[i]);
  const rr = reverb.process(reverbR[i]);
  reverbEnergy += rl ** 2 + rr ** 2;
  left[i] += e.left + rl;
  right[i] += e.right + rr;
}
const rel = (x: number) => `${(100 * Math.sqrt(x / dryEnergy)).toFixed(1)}%`;
console.log(`effect level against the dry mix — echo ${rel(echoEnergy)}, reverb ${rel(reverbEnergy)}`);
console.log(
  `echo ${seq.echoTime} beats = ${echo.seconds.toFixed(3)}s at ${seq.tempo} BPM, ` +
    `feedback ${seq.echoFeedback}, mix ${seq.echoMix}; ` +
    `reverb setting ${seq.reverb} -> preset [${preset.join(', ')}]`,
);

let peak = 0;
for (let i = 0; i < frames; i += 1) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
const norm = peak > 0.99 ? 0.99 / peak : 1;
const pcm = new Int16Array(frames * 2);
for (let i = 0; i < frames; i += 1) {
  pcm[i * 2] = Math.max(-32768, Math.min(32767, Math.round(left[i] * norm * 32767)));
  pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(right[i] * norm * 32767)));
}
const out = `fixtures/level-seq${seq.uid}.wav`;
await writeFile(out, writeWav(pcm, 2, RATE));
const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
console.log(
  `${played} notes played, ${skipped} skipped (instrument not extracted), ` +
    `peak ${peak.toFixed(3)}${norm !== 1 ? ` (normalised by ${norm.toFixed(3)})` : ''} -> ${out}`,
);
console.log(
  `render took ${elapsed.toFixed(2)}s for ${seconds.toFixed(1)}s of audio ` +
    `(${(seconds / elapsed).toFixed(1)}x realtime)`,
);
