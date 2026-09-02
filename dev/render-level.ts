/**
 * Render one sequencer from a real level to a WAV, under Node.
 *
 * This is the end-to-end proof for level import: dump row -> notes -> key
 * splits -> pitch formula -> mipmapped linear sampler -> ADSR -> Moog ladder ->
 * LFOs -> mixer -> echo -> reverb -> file. Everything the project has
 * recovered, in one pass over somebody's actual composition.
 *
 *   node --experimental-strip-types dev/render-level.ts [seqIndex] [seconds]
 *
 * ⚠️ **The pipeline itself is not here.** It lives in `src/core/render.ts`, so
 * that the browser runs the same code; this file is the Node half of the
 * wrapper -- argument parsing, file loading, reporting -- and
 * `dev/render-worker.ts` is the browser half. `test/render.test.ts` asserts the
 * two agree bit for bit.
 *
 * Needs the corpus dump at fixtures/levels/sequencers.jsonl (tools/RawDump.java)
 * and the extracted instruments at fixtures/rinst and fixtures/smp
 * (tools/ExtractGuid.java). All of that is the user's own game data and none of
 * it is committed.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildMipChain } from '../src/audio/mipmap.ts';
import { type SampleBuffer } from '../src/audio/mixer.ts';
import {
  RATE,
  renderSequencer,
  toPcm16,
  type LoadedInstrument,
} from '../src/core/render.ts';
import { VOICES_UNLIMITED, VOICE_POOL_SIZE } from '../src/core/polyphony.ts';
import {
  duplicateRowsDropped,
  importLevel,
  type DumpRow,
} from '../src/core/project.ts';
import { readInstrument, usedSlots } from '../src/core/rinstrument.ts';
import { loadResourceFile } from '../src/platform/node.ts';
import { readWav, writeWav, loopRegion } from '../src/core/wav.ts';

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
/**
 * ⚠️ A/B switch. `LBP_PITCH=<guid>:<semitones>[,...]` scales one instrument's
 * playback rate by `2^(semitones/12)`.
 *
 * It answers exactly one question: **is a sample mapped to the wrong octave?**
 * It multiplies the rate and leaves the note, the key-zone walk and the filter's
 * key-tracking alone, so what changes is the sample's pitch and nothing else.
 * Transposing the note instead would move the zone and the cutoff too, and the
 * result would not be readable.
 *
 * `LBP_PITCH=129082:-12` is `robot` an octave down.
 */
const pitchShift = new Map<number, number>(
  (process.env.LBP_PITCH ?? '')
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [guid, semis] = entry.split(':');
      return [Number(guid), 2 ** (Number(semis) / 12)] as [number, number];
    }),
);
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

if (duplicateRowsDropped) {
  console.log(
    `⚠ dropped ${duplicateRowsDropped} duplicate dump rows -- RawDump re-emits whole ` +
      `sequencers; see importLevel`,
  );
}
// `LBP_UID` picks a sequencer by its own UID, which is stable; the positional
// index is not -- it is a rank in a list sorted by track count, so anything that
// changes a track count reshuffles it. Deduplicating the dump changed it once.
const wantUid = Number(process.env.LBP_UID ?? 0);
const chosen = wantUid
  ? candidates.find((c) => c.seq.uid === wantUid)
  : candidates[Math.min(seqIndex, candidates.length - 1)];
if (!chosen) {
  throw new Error(wantUid ? `no sequencer with uid ${wantUid}` : 'no sequencer in the dump');
}
const { seq } = chosen;
console.log(
  `${chosen.level} seq ${seq.uid} "${seq.name}" — ${seq.tracks.length} tracks, ` +
    `${seq.lengthSteps} steps, tempo ${seq.tempo}, swing ${seq.swing}`,
);

/** Load one instrument and its samples, by GUID. */
const cache = new Map<number, LoadedInstrument | null>();
async function loadInstrument(guid: number): Promise<LoadedInstrument | null> {
  const hit = cache.get(guid);
  if (hit !== undefined) return hit;
  const row = rinstIndex.get(guid);
  if (!row) {
    cache.set(guid, null);
    return null;
  }
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
const result = await renderSequencer(seq, loadInstrument, {
  secondsArg,
  fromArg,
  onlyGuids,
  skipGuids,
  unpitchedGuids,
  unpitchedPercussion,
  noKeyTrack,
  voiceLimit,
  clip,
  pitchShift,
});

console.log(
  `rendering ${result.seconds.toFixed(1)}s (${seq.lengthSteps} steps at ` +
    `${result.framesPerStep.toFixed(0)} frames/step` +
    (secondsArg > 0 ? ', truncated' : ' + 6s tail') + ')',
);
if (result.stolen > 0) {
  const worst = [...result.stolenBy]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([g, n]) => `${rinstIndex.get(g)?.file.replace(/\.\w+$/, '') ?? g}:${n}`)
    .join('  ');
  console.log(`  most affected: ${worst}`);
}
console.log(
  Number.isFinite(voiceLimit)
    ? `${voiceLimit}-voice pool: ${result.stolen} of ${result.events} notes cut short by voice stealing`
    : `voice limit off: all ${result.events} notes run to their written end`,
);
const rel = (x: number) => `${(100 * x).toFixed(1)}%`;
console.log(
  `effect level against the dry mix — echo ${rel(result.echoRel)}, reverb ${rel(result.reverbRel)}`,
);
console.log(
  `echo ${seq.echoTime} beats = ${result.echo.frames} frames = ` +
    `${result.echo.seconds.toFixed(3)}s at ${seq.tempo} BPM, feedback ${seq.echoFeedback}, ` +
    `mix ${seq.echoMix}; reverb setting ${seq.reverb} -> preset [${result.preset.join(', ')}]; ` +
    `reverb levels late ${result.reverb.lateLevel.toFixed(4)}, ` +
    `early ${result.reverb.earlyLevel.toFixed(5)}` +
    (clip
      ? `; output clip touched ${((100 * result.clippedFrames) / result.frames).toFixed(2)}% of frames`
      : '; output clip OFF'),
);
console.log(`pre-normalisation RMS ${result.rms.toFixed(5)}`);

const { pcm, norm } = toPcm16(result.left, result.right);
const out = `fixtures/level-seq${seq.uid}${fromArg ? `-at${Math.round(fromArg)}` : ''}${onlyGuids.length ? `-only${onlyGuids.join('_')}` : ''}${skipGuids.length ? '-skip' : ''}${noKeyTrack ? '-nokeytrack' : ''}${unpitchedGuids.length ? '-unpitchedkit' : ''}${Number.isFinite(voiceLimit) ? '' : '-novoicelimit'}${clip ? '' : '-noclip'}${
  pitchShift.size ? `-pitch${[...pitchShift.keys()].join('_')}` : ''
}${unpitchedPercussion ? '-unpitched' : ''}.wav`;
await writeFile(out, writeWav(pcm, 2, RATE));
const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
console.log(
  `${result.played} notes played, ${result.skipped} skipped (instrument not extracted), ` +
    `peak ${result.peak.toFixed(3)}${norm !== 1 ? ` (normalised by ${norm.toFixed(3)})` : ''} -> ${out}`,
);
console.log(
  `render took ${elapsed.toFixed(2)}s for ${result.seconds.toFixed(1)}s of audio ` +
    `(${(result.seconds / elapsed).toFixed(1)}x realtime)`,
);
