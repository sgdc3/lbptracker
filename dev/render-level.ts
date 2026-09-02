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

import { Echo, Reverb, clipToUnit, reverbPreset } from '../src/audio/effects.ts';
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
import { swungFrame } from '../src/core/swing.ts';
import { LFO_PARAMS, OUTPUT_PARAMS, STACK_PARAMS } from '../src/core/params.ts';
import {
  channelVolume,
  importLevel,
  schedule,
  type DumpRow,
} from '../src/core/project.ts';
import {
  VOICES_UNLIMITED,
  VOICE_POOL_SIZE,
  allocateVoices,
} from '../src/core/polyphony.ts';
import { readInstrument, usedSlots, type RInstrument } from '../src/core/rinstrument.ts';
import { quantise } from '../src/core/scale.ts';
import { loadResourceFile } from '../src/platform/node.ts';
import { pitchRatio, samplesPerStep, velocityGain } from '../src/core/voice.ts';
import { readWav, writeWav, loopRegion } from '../src/core/wav.ts';

const RATE = 48000;
const seqIndex = Number(process.argv[2] ?? 0);
// 0 (or no argument) renders the sequencer end to end.
const secondsArg = Number(process.argv[3] ?? 0);
// Start offset in seconds, for rendering a window out of the middle.
const fromArg = Number(process.env.LBP_FROM ?? 0);
/**
 * ⚠️ A/B switch, not a setting. With `LBP_UNPITCHED_PERCUSSION=1` a slot whose
 * sample has no loop plays at its own rate rather than being transposed by
 * `note - baseNote`. It exists because whether the engine pitches a drum kit's
 * slots is unsettled: `a_kit_1`'s ride sits in a zone spanning notes 60..72 with
 * a base note of 78, so notes 66 and 68 come out an octave down, and an octave
 * down is exactly what a cymbal that sounds too quiet would be doing.
 */
const unpitchedPercussion = process.env.LBP_UNPITCHED_PERCUSSION === '1';
/** Comma-separated instrument GUIDs to keep (`LBP_ONLY`) or drop (`LBP_SKIP`). */
const onlyGuids = (process.env.LBP_ONLY ?? '').split(',').filter(Boolean).map(Number);
const skipGuids = (process.env.LBP_SKIP ?? '').split(',').filter(Boolean).map(Number);
/**
 * ⚠️ A/B switch. `LBP_NO_KEYTRACK=1` forces `Params[5]` to zero, which makes
 * `keytrack = 1 + (rate - 1) * 0 = 1` -- exactly what happens if the value the
 * engine feeds that term is the constant 1.0 rather than the playback rate.
 *
 * There is real evidence for it: the slot feeding the term starts at 1.0
 * (`0x1e25`) and is only modified through a gate whose divisor is the slot
 * record's `+4`, which the eboot's builder fills with `baseBpm` -- 149.5 on
 * every shipped instrument, with `fitBpm` false on all of them. If that is the
 * whole story the term is inert, and `a_kit_1`'s cutoff of 1.0 stops being
 * dragged down to 0.50 by a ride playing an octave low.
 */
const noKeyTrack = process.env.LBP_NO_KEYTRACK === '1';
/**
 * Whether the plugin's own output clip runs. `LBP_NO_CLIP=1` removes it.
 *
 * `fmodextinput.prx` 0x0889 hard-clips all four output channels to +-1 once per
 * frame, after the echo's wet has been added. It is the only nonlinearity in the
 * sequencer's output stage. Whether it should engage on our renders depends on
 * our absolute level being the game's, which is not independently checked --
 * hence the switch and the reported percentage.
 */
const clip = process.env.LBP_NO_CLIP !== '1';
/**
 * How many voices the pool holds. `LBP_VOICES=off` (or 0) removes the cap.
 *
 * 📝 To be exposed in the UI -- see `VOICES_UNLIMITED` in `src/core/polyphony.ts`.
 */
const voiceLimit =
  process.env.LBP_VOICES === 'off' || process.env.LBP_VOICES === '0'
    ? VOICES_UNLIMITED
    : Number(process.env.LBP_VOICES ?? VOICE_POOL_SIZE);
/**
 * ⚠️ A/B switch: instrument GUIDs whose slots play at their own rate instead of
 * being transposed by `note - baseNote`.
 *
 * Per-instrument on purpose. An earlier version of this applied to every
 * loopless sample at once, which is a bad experiment: `a_kit_1` is transposed
 * *down* on every hit (its base notes 87..21 all sit above the notes used,
 * 12..68, giving rates 0.50-0.94), while `baiyon_drums_1` is transposed *up*
 * (notes 44 and 46 against a base of 36, rates 1.59 and 1.78). Forcing both to
 * 1.0 improves one and ruins the other, so the comparison says nothing.
 */
const unpitchedGuids = (process.env.LBP_UNPITCHED ?? '')
  .split(',')
  .filter(Boolean)
  .map(Number);

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
// The stack randomises detune, pan and start offset per layer, and every voice
// randomises its three LFO start phases. A fixed seed keeps a render
// reproducible, which matters when the point of a render is to compare it
// against the last one.
//
// ⚠️ That claim used to be false: `VoiceSpec.random` was never set, so the LFO
// phases came from `Math.random` and two runs of the same build produced
// different files. It surfaced when a hash was used to check that an
// optimisation had not changed the output -- the hash changed on every run.
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

const fromFrame = Math.round(fromArg * RATE);
const events = schedule(seq)
  .filter((e) => e.step * framesPerStep < fromFrame + frames)
  .map((e) => ({ ...e, step: e.step - fromFrame / framesPerStep }))
  .filter((e) => (e.step + e.durationSteps) * framesPerStep > 0)
  .filter((e) => (onlyGuids.length === 0 || onlyGuids.includes(e.guid)))
  .filter((e) => !skipGuids.includes(e.guid));

// The engine has 32 voices and steals the quietest when they run out. Without
// that cap a dense passage plays every note and is louder than the game's --
// which is exactly where a listener hears it. Peak simultaneous notes in this
// sequencer is 88.
const pooled = allocateVoices(
  events.map((e) => {
    const track = seq.tracks[e.track];
    return {
      start: e.step,
      end: e.step + e.durationSteps,
      // voice[+0x04] * voice[+0x0c]: channel volume times note volume. The
      // instrument's own level and its envelope are not in the engine's score.
      score: channelVolume(seq, track) * velocityGain(e.volume),
    };
  }),
  voiceLimit,
);
const realEnd = new Map(pooled.map((p) => [p.index, p.end]));
let stolen = 0;
const stolenBy = new Map<number, number>();
for (const [i, e] of events.entries()) {
  if (realEnd.get(i)! < e.step + e.durationSteps) {
    stolen += 1;
    stolenBy.set(e.guid, (stolenBy.get(e.guid) ?? 0) + 1);
  }
}
if (stolen > 0) {
  const worst = [...stolenBy]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([g, n]) => `${rinstIndex.get(g)?.file.replace(/\.\w+$/, '') ?? g}:${n}`)
    .join('  ');
  console.log(`  most affected: ${worst}`);
}
console.log(
  Number.isFinite(voiceLimit)
    ? `${voiceLimit}-voice pool: ${stolen} of ${events.length} notes cut short by voice stealing`
    : `voice limit off: all ${events.length} notes run to their written end`,
);
let played = 0;
let skipped = 0;
for (const [eventIndex, event] of events.entries()) {
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
    frame: Math.round(
      swungFrame(event.step + p.step, framesPerStep, seq.swing) -
        swungFrame(event.step, framesPerStep, seq.swing),
    ),
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
    playbackRate:
      ((unpitchedPercussion && slot.wav.loop === undefined) ||
      unpitchedGuids.includes(event.guid)
        ? 1
        : pitchRatio(definition, note, seq.tempo)) *
      (slot.wav.sampleRate / RATE),
    gain:
      velocityGain(event.volume) *
      track.level *
      channelVolume(seq, track) *
      2 *
      P(OUTPUT_PARAMS.level) *
      stackGain,
    pan: track.pan,
    // Swing bends the step clock, so every frame position goes through it.
    startFrame: Math.round(swungFrame(event.step, framesPerStep, seq.swing)),
    endFrame: Math.round(
      swungFrame(
        realEnd.get(eventIndex) ?? event.step + event.durationSteps,
        framesPerStep,
        seq.swing,
      ),
    ),
    envelope: evaluateAdsr(p, ADSR_PARAMS, mod),
    filter: {
      settings: {
        cutoff: P(FILTER_PARAMS.cutoff),
        resonance: P(FILTER_PARAMS.resonance),
        keyTrack: noKeyTrack ? 0 : P(FILTER_PARAMS.keyTrack),
        envAmount: P(FILTER_PARAMS.envAmount),
      },
      envelope: evaluateAdsr(p, ADSR_PARAMS_B, mod),
    },
    lfos: [lfo(0), lfo(1), lfo(2)],
    automation,
    // The sends, `fmodextinput.prx` 0x3c8a-0x3d10 (true vaddrs). The note block
    // carries five floats per placement at `+0x420 + 20i` -- level, pan,
    // echoSend, reverbSend, instrument index -- and the two sends are treated
    // very differently:
    //
    //   voice+0x1c = clamp01( bipolar(Params[25], 2*echoSend - 1) )   the echo
    //   voice+0x24 = clamp01( reverbSend )                            the reverb
    //
    // ⚠️ The echo's placement field is a **bipolar offset**, not a blend.
    // `v0x1607e9` writes `2*echoSend - 1` into the note block and 0x3ca1 applies
    // it as `v + o*v` when `o < 0` and `v + o*(1 - v)` when `o >= 0`. So 0.5
    // leaves the instrument's own send alone, 0 mutes it and 1 forces unity. A
    // previous reading used `v + e*(1 - v)` with the raw field, which is only
    // the upper half of that curve.
    //
    // ⚠️ The reverb send is `reverbSend` **alone**. The instrument's own reverb
    // send does reach the voice, at `voice+0x20` from Params at `+0x5b8`, and
    // then **nothing reads it** -- a grep of the whole PRX finds the store and
    // no load.
    echoSend: (() => {
      const base = P(OUTPUT_PARAMS.send);
      const offset = 2 * track.echoSend - 1;
      const blended = offset < 0 ? base + offset * base : base + offset * (1 - base);
      return Math.min(1, Math.max(0, blended));
    })(),
    reverbSend: Math.min(1, Math.max(0, track.reverbSend)),
    // Seeded, so the LFO phases are reproducible along with everything else.
    random: rand,
  };
  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  for (let layer = 0; layer < layers; layer += 1) {
    mixer.play({
      ...spec,
      // ⚠️ All three of Params[0..2] are per-LAYER, and a voice with one layer
      // has nothing to spread against itself. Applying them regardless is what
      // broke the drums twice over: the random start turned every hit into half
      // a sample, and the random detune -- ±0.15% on `a_kit_1` -- put a phaser
      // over the kit, because this level plays every drum hit on TWO board
      // components at once (140 of 140 (step, pitch) slots in the window, across
      // 146 components) and two coherent copies a hair apart is a comb filter.
      playbackRate:
        spec.playbackRate *
        (layer === 0 ? 1 : 1 + 0.05 * P(STACK_PARAMS.detune) * bipolar()),
      pan: layer === 0 ? spec.pan : clamp01(spec.pan + 0.5 * P(STACK_PARAMS.spread) * bipolar()),
      // ⚠️ Layers after the first only. Applied to every voice, this destroys
      // any instrument whose `Numstack` is 1: `a_kit_1` sets `Params[2]` to
      // **1.000**, so every drum hit started at a uniformly random point
      // anywhere in its sample -- on average half a kick, with no transient and
      // a click where the waveform jumps. Six of the game's kits do the same
      // (`8bit_kit_1`, `a_kit_1`, `bb_kit_1`, `bb_kit_2`, `e_kit_1`,
      // `e_perc_1`), all with `Numstack` 1.
      //
      // A per-layer randomisation exists to decorrelate stacked layers, and a
      // single layer has nothing to decorrelate, so skipping it there is the
      // conservative reading. ⚠️ It does not explain why those kits set the
      // value at all -- see open question 12.
      startPosition:
        layer === 0 ? 0 : P(STACK_PARAMS.startOffset) * sampleFrames * rand(),
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

// The two sends, mixed back over the dry signal. Both are the game's own now --
// topology, levels and all -- so there is nothing to scale here.
const echo = new Echo(RATE, seq.echoTime, framesPerStep, seq.echoFeedback, seq.echoMix);
const preset = reverbPreset(seq.reverb);
const reverb = new Reverb(RATE, preset);
// The plugin's output stage, in the engine's order (`fmodextinput.prx` 0x07c0):
// the echo's wet is added to ALL FOUR channels -- the dry pair and the reverb
// send pair -- and then all four are hard-clipped to +-1. Only after that does
// the reverb DSP see its input.
//
// ⚠️ The clip is measured but its effect depends on our absolute level matching
// the game's, which nothing here verifies. The share of frames it touches is
// reported below; `LBP_NO_CLIP=1` removes it for an A/B.
let dryEnergy = 0;
let echoEnergy = 0;
let reverbEnergy = 0;
let clipped = 0;
for (let i = 0; i < frames; i += 1) {
  dryEnergy += left[i] ** 2 + right[i] ** 2;
  const e = echo.process(echoL[i], echoR[i]);
  echoEnergy += e.left ** 2 + e.right ** 2;
  let dryL = left[i] + e.left;
  let dryR = right[i] + e.right;
  let sendL = reverbL[i] + e.left;
  let sendR = reverbR[i] + e.right;
  if (clip) {
    if (dryL > 1 || dryL < -1 || dryR > 1 || dryR < -1) clipped += 1;
    dryL = clipToUnit(dryL);
    dryR = clipToUnit(dryR);
    sendL = clipToUnit(sendL);
    sendR = clipToUnit(sendR);
  }
  // ⚠️ One call per frame, stereo. It used to be two calls -- one per channel --
  // through a single instance, which ran every delay line at twice the frame
  // rate and put both channels through the same state.
  const r = reverb.process(sendL, sendR);
  reverbEnergy += r.left ** 2 + r.right ** 2;
  left[i] = dryL + r.left;
  right[i] = dryR + r.right;
}
const rel = (x: number) => `${(100 * Math.sqrt(x / dryEnergy)).toFixed(1)}%`;
console.log(`effect level against the dry mix — echo ${rel(echoEnergy)}, reverb ${rel(reverbEnergy)}`);
console.log(
  `echo ${seq.echoTime} beats = ${echo.frames} frames = ${echo.seconds.toFixed(3)}s at ` +
    `${seq.tempo} BPM, feedback ${seq.echoFeedback}, mix ${seq.echoMix}; ` +
    `reverb setting ${seq.reverb} -> preset [${preset.join(', ')}]; ` +
    `reverb levels late ${reverb.lateLevel.toFixed(4)}, early ${reverb.earlyLevel.toFixed(5)}` +
    (clip ? `; output clip touched ${((100 * clipped) / frames).toFixed(2)}% of frames` : '; output clip OFF'),
);

let peak = 0;
let energy = 0;
for (let i = 0; i < frames; i += 1) {
  peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  energy += left[i] ** 2 + right[i] ** 2;
}
console.log(`pre-normalisation RMS ${Math.sqrt(energy / (2 * frames)).toFixed(5)}`);
const norm = peak > 0.99 ? 0.99 / peak : 1;
const pcm = new Int16Array(frames * 2);
for (let i = 0; i < frames; i += 1) {
  pcm[i * 2] = Math.max(-32768, Math.min(32767, Math.round(left[i] * norm * 32767)));
  pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(right[i] * norm * 32767)));
}
const out = `fixtures/level-seq${seq.uid}${fromArg ? `-at${Math.round(fromArg)}` : ''}${onlyGuids.length ? `-only${onlyGuids.join('_')}` : ''}${skipGuids.length ? '-skip' : ''}${noKeyTrack ? '-nokeytrack' : ''}${unpitchedGuids.length ? '-unpitchedkit' : ''}${Number.isFinite(voiceLimit) ? '' : '-novoicelimit'}${clip ? '' : '-noclip'}${unpitchedPercussion ? '-unpitched' : ''}.wav`;
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
