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

import { Mixer, type SampleBuffer, type VoiceSpec } from '../src/audio/mixer.ts';
import { buildMipChain } from '../src/audio/mipmap.ts';
import { FILTER_PARAMS } from '../src/audio/moog.ts';
import { ADSR_PARAMS, ADSR_PARAMS_B, evaluateAdsr } from '../src/core/envelope.ts';
import { resolveSlot } from '../src/core/instrument.ts';
import { LFO_PARAMS, OUTPUT_PARAMS } from '../src/core/params.ts';
import { importLevel, schedule, type DumpRow } from '../src/core/project.ts';
import { readInstrument, usedSlots, type RInstrument } from '../src/core/rinstrument.ts';
import { quantise } from '../src/core/scale.ts';
import { loadResourceFile } from '../src/platform/node.ts';
import { pitchRatio, samplesPerStep, velocityGain } from '../src/core/voice.ts';
import { readWav, writeWav, loopRegion } from '../src/core/wav.ts';

const RATE = 48000;
const seqIndex = Number(process.argv[2] ?? 0);
const seconds = Number(process.argv[3] ?? 20);

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

const framesPerStep = samplesPerStep(RATE, seq.tempo);
const frames = Math.round(seconds * RATE);
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
  const zone = resolveSlot(loaded.inst, note, loaded.slots.length);
  const slot = loaded.slots[Math.min(zone, loaded.slots.length - 1)];
  const definition = loaded.inst.slots[Math.min(zone, loaded.inst.slots.length - 1)];
  const p = loaded.inst.params;
  const lfo = (n: 0 | 1 | 2) => ({
    rate: p[LFO_PARAMS[n].rate].x,
    depth: p[LFO_PARAMS[n].depth].x,
    spread: p[LFO_PARAMS[n].spread].x,
  });

  const spec: VoiceSpec = {
    sample: slot.wav,
    playbackRate: pitchRatio(definition, note, seq.tempo) * (slot.wav.sampleRate / RATE),
    gain: velocityGain(event.volume) * track.level * 2 * p[OUTPUT_PARAMS.level].x,
    pan: track.pan,
    startFrame: Math.round(event.step * framesPerStep),
    endFrame: Math.round((event.step + event.durationSteps) * framesPerStep),
    envelope: evaluateAdsr(p, ADSR_PARAMS, 0),
    filter: {
      settings: {
        cutoff: p[FILTER_PARAMS.cutoff].x,
        resonance: p[FILTER_PARAMS.resonance].x,
        keyTrack: p[FILTER_PARAMS.keyTrack].x,
        envAmount: p[FILTER_PARAMS.envAmount].x,
      },
      envelope: evaluateAdsr(p, ADSR_PARAMS_B, 0),
    },
    lfos: [lfo(0), lfo(1), lfo(2)],
  };
  mixer.play(spec);
  played += 1;
}

mixer.render(left, right);

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
console.log(
  `${played} notes played, ${skipped} skipped (instrument not extracted), ` +
    `peak ${peak.toFixed(3)}${norm !== 1 ? ` (normalised by ${norm.toFixed(3)})` : ''} -> ${out}`,
);
