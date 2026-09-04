/**
 * The live player: a song scheduled into the audio thread instead of a file.
 *
 * ⚠️ **It is not a second engine, and that is the whole design.** Every voice it
 * plays comes out of `renderSequencer` itself, through the `onVoice` seam and
 * with `planOnly` set, so the key splits, the pitch formula, the modulation
 * point, the stack layers, the sends, the pan width and the voice pool's
 * stealing are all decided by exactly the code that writes the WAV. This file
 * owns only *when* a voice is handed over, never *what* it is.
 *
 * The plan is built once, up front, because the voice pool has to be: the
 * allocator needs the whole note list to decide what gets stolen, and a
 * scheduler that only looked a second ahead would steal differently from the
 * renderer and drift.
 *
 * ⚠️ **`VoiceSpec.random` and `VoiceSpec.sample` cannot cross a thread** -- one
 * is a function and the other is megabytes of mipmaps. The sample is sent once
 * per instrument slot and referenced by id; the LFO phases are drawn here, from
 * the render's own seeded generator and in the render's own order, and sent as
 * numbers. See `lfoPhase` in `src/audio/mixer-worklet.ts`.
 */

import { HANDOFF_KEY, loaderFor, manifest, asset, type Manifest } from './assets.ts';
import { seqPicker } from './seq-picker.ts';
import { type VoiceSpec } from '../src/audio/mixer.ts';
import { readBackup, sequencersOf, type BackupResult } from '../src/core/backup.ts';
import {
  CHANNEL_COUNT, channelVolume, type LevelProject, type Sequencer,
} from '../src/core/project.ts';
import { fromFiles, isZip, openedTitle, saveNote, wireOpen } from './open-level.ts';
import { readBackupZip } from '../src/core/backup.ts';
import { webInflateRaw } from '../src/platform/web.ts';
import { LiveVoicePool, VOICES_UNLIMITED, VOICE_POOL_SIZE } from '../src/core/polyphony.ts';
import { swungFrame } from '../src/core/swing.ts';
import { samplesPerStep } from '../src/core/voice.ts';
import { PAN_WIDTH, RATE, renderSequencer } from '../src/core/render.ts';
import { webInflate } from '../src/platform/web.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const seqHost = $<HTMLDivElement>('seq');
const playButton = $<HTMLButtonElement>('play');
const rewindButton = $<HTMLButtonElement>('rewind');
const statusLine = $<HTMLDivElement>('status');
const clockLabel = $<HTMLSpanElement>('clock');
const loadLabel = $<HTMLSpanElement>('load');
const timeline = $<HTMLDivElement>('timeline');
const head = $<HTMLDivElement>('head');
const density = $<HTMLCanvasElement>('density');
const metersBox = $<HTMLDivElement>('meters');
const errorCard = $<HTMLElement>('errorCard');
const errorBox = $<HTMLPreElement>('error');
const dropZone = $<HTMLDivElement>('drop');
const dropTitle = $<HTMLElement>('dropTitle');
const dropHint = $<HTMLElement>('dropHint');
const fileInput = $<HTMLInputElement>('file');
const volSlider = $<HTMLInputElement>('vol');
const panWidthInput = $<HTMLInputElement>('panWidth');
const voicesInput = $<HTMLInputElement>('voices');
const noCapBox = $<HTMLInputElement>('optNoCap');
const staleNote = $<HTMLParagraphElement>('staleNote');
const tempoInput = $<HTMLInputElement>('tempo');
const swingInput = $<HTMLInputElement>('swing');
const channelsBox = $<HTMLDivElement>('channels');
const numChannelsInput = $<HTMLInputElement>('numChannels');

const setStatus = (text: string, bad = false) => {
  statusLine.textContent = text;
  statusLine.classList.toggle('bad', bad);
};
const setError = (text: string) => {
  errorBox.textContent = text;
  errorCard.classList.toggle('show', text !== '');
};

const clock = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

// --------------------------------------------------------------------- state

/**
 * One scheduled voice: when it starts, which sample it plays, and its spec.
 *
 * ⚠️ **`endFrame` and `cutFrame` are stored as DURATIONS here, not as the
 * absolute frames the render uses.** `Mixer.play` derives the note's life as
 * `endFrame - startFrame`, so a spec whose `startFrame` is rewritten to a
 * look-ahead delay while its `endFrame` still counts from the start of the song
 * gets a life of nearly the whole song -- every note rings until the end, which
 * is exactly what a first attempt sounded like. Rebasing at post time is the fix,
 * and keeping the durations rather than the absolutes is what makes it hard to
 * get wrong twice.
 */
interface Planned {
  /**
   * Where the voice starts and ends **in steps**, not in frames.
   *
   * ❗ **Tempo, swing and the channel mixer are applied when the note is
   * posted, not when the plan is built.** None of the three changes a voice:
   * they change where it starts, how long it lasts and how loud it is, and all
   * three of those are one line of arithmetic over a musical position. Storing
   * frames instead meant every turn of the tempo knob re-ran the whole voice
   * pass -- `Ascetic` is 1,150 tracks -- on the thread that also feeds the
   * audio, which is exactly the stutter a listener heard.
   *
   * ⚠️ Tempo is only free of the voice because **no instrument the game
   * ships sets `fitBpm`** (0 of 68). One that did would have its playback rate
   * scaled by the tempo and would need a rebuild after all.
   */
  readonly startStep: number;
  readonly endStep?: number;
  /** The board row, which picks the mixer channel through `NumChannels`. */
  readonly row: number;
  /** `voice.gain` with the channel's factor divided out, so it can be redone. */
  readonly baseGain: number;
  /**
   * The pool's score, likewise without the channel factor.
   *
   * ❗ The pool is in STEPS and so is immune to tempo and swing -- but its score
   * is `channelVolume * velocityGain`, so a fader or `NumChannels` changes
   * which voice gets stolen. That has to follow the mixer or the pool decides
   * by a mix nobody is listening to.
   */
  readonly baseScore: number;
  /**
   * Each control point's offset from the note's start, in steps.
   *
   * ❗ `automation` and `morph.points` hold frames from the voice's own start,
   * and those frames were bent by the tempo AND the swing. Everything else
   * about a voice is in seconds or is a ratio, so this is the only part a live
   * change has to rebuild. `dev/live-settings.ts` proves the rebuild exact.
   */
  readonly pointSteps: readonly number[];
  readonly sampleId: string;
  readonly voice: Omit<VoiceSpec, 'sample' | 'random' | 'startFrame' | 'endFrame' | 'cutFrame'>;
  readonly lfoPhase: readonly [number, number, number];
  /**
   * What the voice pool needs, in its own units.
   *
   * ⚠️ **The plan carries no cuts.** It is built uncapped and the pool is
   * applied as each voice is handed over, one note at a time, which is what the
   * engine does and what lets the size be changed without rebuilding anything.
   * `LiveVoicePool` is proved to decide exactly what `allocateVoices` decides
   * (test/polyphony.test.ts), and `dev/live-sim.ts` proves the audio is
   * bit-identical at pools of 2, 4, 8 and 32.
   */
  readonly poolStart: number;
  readonly poolEnd: number;
  readonly score: number;
  readonly index: number;
}

let project: LevelProject | null = null;
/**
 * Every sequencer the open backup holds, by the picker's key.
 *
 * ⚠️ **A uid is unique inside a level, not across a backup.** A folder of
 * forty levels routinely holds two sequencers numbered 7, so the page indexes
 * on `file#uid` and keeps the level beside the song -- the renderer needs both.
 */
let songs = new Map<string, { project: LevelProject; sequencer: Sequencer }>();
let rinstIndex: Manifest | null = null;
let smpIndex: Manifest | null = null;
let plan: Planned[] = [];
let songFrames = 0;
let songSeconds = 0;
let framesPerStep = 0;

let context: AudioContext | null = null;
let node: AudioWorkletNode | null = null;
let master: GainNode | null = null;

/** Where the playhead is, in song frames, and when that was true. */
let cursorFrames = 0;
let startedAt = 0;
let playing = false;
/** How far into `plan` the scheduler has already posted. */
let nextIndex = 0;
/**
 * What the audio thread last said it was holding.
 *
 * ⚠️ **Not the count of voices posted in the last tick**, which is what this
 * readout used to be and which is nearly always zero: the scheduler posts in
 * bursts every 100 ms, so on a sparse song most ticks post nothing while plenty
 * is still ringing. A voice can also outlive its gate by its release, which no
 * amount of counting on this side would know about.
 */
let sounding = 0;
let queued = 0;
/**
 * Worst block cost as a fraction of realtime; over 1 means the device starved.
 * `null` means the worklet could not read a clock, which must not read as zero.
 */
let audioLoad: number | null = null;
/** Blocks the audio thread failed to deliver since playback started. */
let dropouts = 0;
let lostMs = 0;
/** Voices the pool has taken back since playback started, counted as it goes. */
let stolenLive = 0;

function showLoad(): void {
  if (!playing && sounding === 0 && queued === 0) {
    loadLabel.textContent = plan.length ? 'ready' : 'idle';
    return;
  }
  // Both numbers, always: a field that appears and disappears as it crosses
  // zero draws the eye to the wrong thing and shifts everything beside it.
  // Dropouts rather than a load percentage: see `lastFrame` in the worklet for
  // why a percentage cannot be measured from there, and why this answers the
  // question a load meter was only being asked as a proxy for.
  //
  // ⚠️ Only the dropout count turns red. Colouring the whole line made the voice
  // counts look like part of the alarm, and they are just numbers.
  const health = dropouts === 0
    ? 'no dropouts'
    : `${dropouts} dropout${dropouts === 1 ? '' : 's'}` +
      (lostMs >= 1 ? ` (${lostMs.toFixed(0)} ms lost)` : '');
  const busy = audioLoad === null ? '' : `· audio ${(audioLoad * 100).toFixed(1)}% `;
  // ⚠️ More sounding than the pool holds means something is not respecting it.
  // Release tails are the honest reason -- a stolen voice keeps ringing while
  // its envelope lets go -- so this is a flag to look at, not an error. Never
  // flagged when the pool is uncapped, where there is nothing to exceed.
  const cap = poolSize();
  const over = Number.isFinite(cap) && sounding > cap;
  loadLabel.innerHTML =
    `<span class="${over ? 'bad' : ''}">${sounding} sounding</span> · ${queued} queued ${busy}· ` +
    `<button type="button" class="drops${dropouts > 0 ? ' bad' : ''}" ` +
    `title="Click to reset the count">${health}</button>`;
}

/**
 * How far ahead notes are posted.
 *
 * ⚠️ Long enough that a slow frame cannot leave a gap, short enough that moving
 * an effect control is heard within a beat. The worklet delays each voice by
 * `startFrame`, so accuracy does not depend on this -- only latency to a change
 * does.
 */
const LOOKAHEAD = 0.35;
const TICK = 100;

/**
 * The two switches that are decided when a song is prepared, not while it plays.
 *
 * ⚠️ **Neither can be live, and pretending otherwise would be a lie in the
 * UI.** The pan width is folded into each voice as it is built, and the voice
 * pool's stealing is decided over the whole note list at once -- the allocator
 * needs every note to know which ones lose their record. Moving either marks the
 * plan stale rather than doing nothing quietly.
 */
const planOptions = () => ({
  // ❗ Raw pans in the plan: the worklet owns the width so it can be swept while
  // the song plays. Sending anything but 1 here would apply it twice.
  panWidth: 1,
  // ❗ And no cap: the pool is applied live, per note. See `Planned`.
  voiceLimit: VOICES_UNLIMITED,
});

/**
 * The song's own settings, as the listener has left them.
 *
 * ✅ **All four are applied live and none of them rebuilds anything.** The plan
 * holds musical positions and a gain with the channel factor divided out, so a
 * new tempo, swing, channel count or fader is three numbers and the next note
 * posted uses them. What is already sounding keeps the timing it was given,
 * which is what a DAW does too.
 *
 * ⚠️ They used to rebuild: every turn of the knob re-ran the whole voice
 * pass on the thread that feeds the audio, and a listener heard it stutter.
 */
let overrides: {
  tempo?: number;
  swing?: number;
  volumes?: number[];
  numChannels?: number;
} = {};

const withOverrides = <
  T extends { tempo: number; swing: number; volumes: readonly number[]; numChannels: number },
>(
  seq: T,
): T => {
  const volumes = overrides.volumes ?? seq.volumes;
  return {
    ...seq,
    tempo: overrides.tempo ?? seq.tempo,
    swing: overrides.swing ?? seq.swing,
    numChannels: overrides.numChannels ?? seq.numChannels,
    volumes,
  };
};

/** The pool size the listener has asked for. */
const poolSize = () => (noCapBox.checked ? VOICES_UNLIMITED : Number(voicesInput.value));

let pool = new LiveVoicePool(poolSize());
/**
 * The STEP at which each handed-over voice started, so a theft can reach it.
 *
 * ❗ A step and not a frame: the tempo can move after the voice was handed
 * over, and a frame written under the old clock would measure a steal's cut
 * from the wrong place -- too long a cut leaves a stolen voice sounding, which
 * is loudness nobody asked for.
 */
const handed = new Map<number, number>();
let stepFrames = 0;
let swing = 0;
/** The song's own length in steps, and the render's tail, so a tempo change can
 * put `songFrames` back without asking the renderer. */
let songSteps = 0;
let tailFrames = 0;
const cutFrameAt = (step: number) => Math.round(swungFrame(step, stepFrames, swing));

/**
 * Where a planned voice starts, how long it lasts and how loud it is, **now**.
 *
 * ❗ The three settings a listener turns while the music runs are applied here
 * and nowhere else, which is what makes them free: `startedAt` is untouched, no
 * message goes to the worklet, and the plan is read, not rewritten.
 */
const frameOf = (p: Planned) => cutFrameAt(p.startStep);
const lifeOf = (p: Planned) =>
  (p.endStep === undefined ? undefined : Math.max(0, cutFrameAt(p.endStep) - frameOf(p)));
const mixerNow = () => ({ numChannels: liveChannels, volumes: liveVolumes });
const gainOf = (p: Planned) => p.baseGain * channelVolume(mixerNow(), { gridY: p.row });
const scoreOf = (p: Planned) => p.baseScore * channelVolume(mixerNow(), { gridY: p.row });
/** The voice with its in-note automation put back on the current clock. */
const onClock = (p: Planned): Planned['voice'] => {
  const base = swungFrame(p.startStep, stepFrames, swing);
  const frameAt = (offset: number) =>
    Math.round(swungFrame(p.startStep + offset, stepFrames, swing) - base);
  const v = p.voice;
  return {
    ...v,
    automation: v.automation?.map((point, index) => ({
      ...point, frame: frameAt(p.pointSteps[index] ?? 0),
    })),
    morph: v.morph === undefined ? undefined : {
      ...v.morph,
      points: v.morph.points.map((point, index) => ({
        ...point, frame: frameAt(p.pointSteps[index] ?? 0),
      })),
    },
  };
};
/** The mixer as the faders have it, read by `gainOf` on every note posted. */
let liveChannels = 1;
let liveVolumes: readonly number[] = [1, 1, 1, 1, 1, 1];

/**
 * Rebuild the pool's state so it matches a playthrough that reached `upTo`.
 *
 * ⚠️ Changing the size cannot just start an empty pool from here: the engine's
 * stealing depends on what it is holding, so a pool that forgot the last minute
 * of the song would steal differently from one that had been this size all
 * along. Replaying the decisions is pure arithmetic over the notes already
 * passed -- no audio, no rebuild of the plan.
 */
function rebuildPool(upTo: number): void {
  rebuildPoolTo(plan.findIndex((p) => frameOf(p) >= upTo));
}

/**
 * Replay the pool over the first `limit` notes of the plan, `-1` meaning all.
 *
 * ❗ **By INDEX, not by frame, when the clock has just moved.** A settings
 * change re-points the playhead, and everything already handed to the worklet
 * has to stay in the pool -- rebuilding to the playhead instead would forget
 * the look-ahead window and then hand it over a second time.
 */
function rebuildPoolTo(limit: number): void {
  pool = new LiveVoicePool(poolSize());
  const upTo = limit < 0 ? plan.length : limit;
  for (let i = 0; i < upTo; i += 1) {
    const p = plan[i];
    pool.add(p.index, { start: p.poolStart, end: p.poolEnd, score: scoreOf(p) });
  }
}

const pushPanWidth = () =>
  node?.port.postMessage({ type: 'panWidth', width: Number(panWidthInput.value) / 100 });

let preparedWith = '';
const markStale = () => {
  staleNote.hidden = plan.length === 0 || JSON.stringify(planOptions()) === preparedWith;
};

// --------------------------------------------------------------------- audio

async function ensureAudio(): Promise<AudioWorkletNode> {
  if (node) return node;
  context = new AudioContext({ sampleRate: RATE });
  await context.audioWorklet.addModule(asset('src/audio/mixer-worklet.ts'));
  node = new AudioWorkletNode(context, 'lbp-mixer', { outputChannelCount: [2] });
  master = new GainNode(context, { gain: Number(volSlider.value) });
  node.connect(master).connect(context.destination);
  node.port.onmessage = (event: MessageEvent) => {
    const data = event.data as {
      type: string; id?: string; total?: number; sounding?: number;
      load?: number | null; dropouts?: number; lostFrames?: number;
    };
    if (data.type === 'missingSample') setError(`the worklet has no sample "${data.id}"`);
    // The only place that knows what is actually sounding is the audio thread.
    if (data.type === 'voices') {
      sounding = data.sounding ?? 0;
      queued = (data.total ?? 0) - sounding;
      audioLoad = data.load ?? null;
      dropouts += data.dropouts ?? 0;
      lostMs = ((data.lostFrames ?? 0) / RATE) * 1000;
      showLoad();
    }
  };
  return node;
}

/** Push the song's own output stage, with whatever the knobs currently say. */
function pushEffects(): void {
  const num = (id: string) => Number(($(id) as HTMLInputElement).value);
  node?.port.postMessage({
    type: 'effects',
    echoTime: num('echoTime') / 10,
    framesPerStep,
    feedback: num('echoFb') / 100,
    mix: num('echoMix') / 100,
    reverbSetting: num('reverbSet'),
    echoOn: ($('optEcho') as HTMLInputElement).checked,
    reverbOn: ($('optReverb') as HTMLInputElement).checked,
    clip: ($('optClip') as HTMLInputElement).checked,
  });
}

// ------------------------------------------------------------------ the plan

/**
 * Build the plan, and put the transport where the caller asks.
 *
 * `restart` is the whole difference between picking a song and changing the
 * voice pool: one starts from the top, the other keeps playing.
 */
async function prepare(restart = true): Promise<void> {
  const chosen = songs.get(picker.value());
  const original = chosen?.sequencer;
  if (!original || !chosen || !rinstIndex || !smpIndex) return;
  project = chosen.project;
  if (restart) overrides = {};
  const seq = withOverrides(original);
  // Where we are in the music, not in seconds: a tempo change moves one and
  // not the other, and the music is what a listener is following.
  const stepBefore = !restart && framesPerStep > 0 ? songPosition() / framesPerStep : 0;
  const wasPlaying = playing;

  if (restart) {
    setError('');
    setStatus(`getting "${seq.name}" ready — ${seq.tracks.length} tracks…`);
  }
  await ensureAudio();

  const load = await loaderFor(rinstIndex, smpIndex);
  const sent = new Set<string>();
  const built: Planned[] = [];

  // The song's own output stage, so the knobs start where the sequencer has them
  // rather than at a made-up default. `echoTime` is in beats and the slider is
  // tenths of a beat; `reverb` is the setting index straight through.
  const setSlider = (id: string, value: number) => {
    const el = $<HTMLInputElement>(id);
    el.value = String(Math.min(Number(el.max), Math.max(Number(el.min), Math.round(value))));
    el.dispatchEvent(new Event('input'));
  };
  setSlider('echoTime', seq.echoTime * 10);
  setSlider('echoFb', seq.echoFeedback * 100);
  setSlider('echoMix', seq.echoMix * 100);
  setSlider('reverbSet', seq.reverb);

  const result = await renderSequencer(seq, load, {
    planOnly: true,
    ...planOptions(),
    onVoice: (voice, where) => {
      const sampleId = `g${where.guid}z${where.zone}`;
      if (!sent.has(sampleId)) {
        sent.add(sampleId);
        const sample = voice.sample;
        node!.port.postMessage({
          type: 'load',
          sample: {
            id: sampleId,
            // Copies, because the worklet keeps them and this thread replays
            // the same buffers for every later voice on the same slot.
            channels: sample.channels.map((c) => new Float32Array(c)),
            sampleRate: sample.sampleRate,
            loop: sample.loop,
          },
        });
      }
      // Drawn here, from the render's own seeded generator and in the render's
      // own order, so the phases are the ones the WAV would have had.
      const draw = voice.random ?? Math.random;
      const phase = [0, 1, 2].map(
        (n) => draw() * 2 * Math.PI + (voice.lfoPhaseOffset?.[n] ?? 0),
      ) as unknown as readonly [number, number, number];
      const {
        sample: _s, random: _r, startFrame: _f, endFrame, cutFrame: _c, ...rest
      } = voice;

      built.push({
        startStep: where.startStep,
        endStep: where.endStep,
        row: where.row,
        // ❗ Divided out so the faders can put a different one back. It is never
        // zero: `CHANNEL_HEADROOM` is 0.75 and a volume of 0 would have made
        // the voice silent in the render too.
        baseGain: where.channelGain === 0 ? rest.gain : rest.gain / where.channelGain,
        baseScore: where.channelGain === 0 ? where.score : where.score / where.channelGain,
        pointSteps: where.pointSteps,
        sampleId,
        voice: rest,

        lfoPhase: phase,
        poolStart: where.poolStart,
        poolEnd: where.poolEnd,
        score: where.score,
        index: built.length,
      });
    },
    onProgress: (phase, done, total) => {
      if ((done & 0xfff) === 0) {
        setStatus(`preparing — ${phase} ${Math.round((done / Math.max(1, total)) * 100)}%`);
      }
    },
  });

  // Sorted by musical position, which is the order they will be posted in at
  // any tempo: swing is monotonic in the step.
  built.sort((a, b) => a.startStep - b.startStep);
  plan = built;
  preparedWith = JSON.stringify(planOptions());
  songFrames = result.frames;
  songSeconds = result.seconds;
  framesPerStep = result.framesPerStep;
  stepFrames = result.framesPerStep;
  songSteps = original.lengthSteps;
  tailFrames = Math.max(0, result.frames - Math.round(original.lengthSteps * stepFrames));
  swing = seq.swing;
  liveChannels = seq.numChannels;
  liveVolumes = seq.volumes;
  pushEffects();
  pushPanWidth();
  drawDensity();
  if (restart) {
    seek(0);
  } else {
    // ⚠️ **Swapped underneath a running transport, without touching the audio.**
    // Voices already handed to the worklet keep their old cuts and finish as
    // they were going to; only notes not yet posted come from the new plan.
    // Re-pointing `nextIndex` at the current position is the whole handover --
    // no `stopAll`, no seek, no gap.
    cursorFrames = Math.min(songFrames, stepBefore * framesPerStep);
    if (context) startedAt = context.currentTime;
    playing = wasPlaying;
    const now = songPosition();
    nextIndex = plan.findIndex((p) => frameOf(p) >= now);
    if (nextIndex < 0) nextIndex = plan.length;
    handed.clear();
    rebuildPool(now);
  }

  playButton.disabled = false;
  rewindButton.disabled = false;
  timeline.setAttribute('aria-valuemax', songSeconds.toFixed(1));
  metersBox.innerHTML = [
    ['voices', built.length.toLocaleString()],
    // ⚠️ "skipped" means the instrument was not there, not that the pool dropped
    // the note: `renderSequencer` counts a note as skipped when
    // `loadInstrument` returns nothing for its GUID, which happens when that
    // instrument is missing from the extracted assets. It reads 0 on a complete
    // extraction, and the label says which question it is answering.
    [
      'notes',
      `${result.played.toLocaleString()} played` +
        (result.skipped > 0 ? `, ${result.skipped} with no instrument` : ''),
    ],
    // Counted as the song plays rather than read off a finished plan: the pool
    // decides its stealing live now, so this is the only place the number
    // exists. `stolenCell` is updated in `pump`.
    ['stolen so far', '<b id="stolenCell">0</b>'],
    ['samples', String(sent.size)],
    ['length', `${clock(songSeconds)} at ${seq.tempo} BPM`],
  ]
    .map(([k, v]) => `<span>${k} ${v.startsWith('<b') ? v : `<b>${v}</b>`}</span>`)
    .join('');
  if (restart) {
    tempoInput.value = String(Math.round(original.tempo));
    swingInput.value = String(Math.round(original.swing * 100));
    numChannelsInput.value = String(
      Math.min(CHANNEL_COUNT, Math.max(1, original.numChannels)),
    );
    buildFaders(original, original.volumes);
    $('numChannels').textContent = `NumChannels ${original.numChannels}`;
    showSongOptions();
  }
  markStale();
  showPlanOptions();
  setStatus(`ready — ${built.length.toLocaleString()} voices scheduled, press play`);
}

/** A voice-per-second histogram, so the song has a shape before it plays. */
function drawDensity(): void {
  const ctx = density.getContext('2d')!;
  const { width, height } = density;
  ctx.clearRect(0, 0, width, height);
  if (!plan.length || songFrames <= 0) return;
  const bins = new Float32Array(width);
  for (const p of plan) {
    const x = Math.min(width - 1, Math.max(0, Math.floor((frameOf(p) / songFrames) * width)));
    bins[x] += 1;
  }
  const peak = Math.max(...bins) || 1;
  ctx.fillStyle = '#3d4a52';
  for (let x = 0; x < width; x += 1) {
    const h = Math.max(1, (bins[x] / peak) * (height - 8));
    ctx.fillRect(x, height - h, 1, h);
  }
}

// ---------------------------------------------------------------- transport

function songPosition(): number {
  if (!playing || !context) return cursorFrames;
  return cursorFrames + (context.currentTime - startedAt) * RATE;
}

function seek(frames: number): void {
  const was = playing;
  if (was) stop(false);
  cursorFrames = Math.min(songFrames, Math.max(0, frames));
  // Everything before the cursor is skipped rather than replayed. A voice that
  // straddles the point is not resurrected: the engine has no way to start a
  // note in the middle and neither has this.
  nextIndex = plan.findIndex((p) => frameOf(p) >= cursorFrames);
  if (nextIndex < 0) nextIndex = plan.length;
  handed.clear();
  rebuildPool(cursorFrames);
  stolenLive = 0;
  const cell = document.getElementById('stolenCell');
  if (cell) cell.textContent = '0';
  paint();
  if (was) start();
}

function start(): void {
  if (!context || !node || playing) return;
  void context.resume();
  // The detector compares against the last block it saw, and a suspended
  // context has not produced one since before the pause. Tell it to start over.
  node.port.postMessage({ type: 'resetHealth' });
  dropouts = 0;
  lostMs = 0;
  startedAt = context.currentTime;
  playing = true;
  playButton.textContent = '⏸';
  playButton.setAttribute('aria-label', 'Pause');
  pump();
}

function stop(clear = true): void {
  if (!playing) return;
  cursorFrames = songPosition();
  playing = false;
  playButton.textContent = '▶';
  playButton.setAttribute('aria-label', 'Play');
  if (clear) {
    node?.port.postMessage({ type: 'stopAll' });
    sounding = 0;
    queued = 0;
    dropouts = 0;
    lostMs = 0;
  }
  showLoad();
}

/**
 * Post everything that starts inside the look-ahead window.
 *
 * `startFrame` is a delay the worklet counts down, so a voice posted early is
 * still sample-accurate; the window only has to be wide enough that the next
 * tick is never late.
 */
function pump(): void {
  if (!playing || !node) return;
  const now = songPosition();
  const until = now + LOOKAHEAD * RATE;
  while (nextIndex < plan.length && frameOf(plan[nextIndex]) < until) {
    const p = plan[nextIndex];
    // ❗ **Never twice.** The index arithmetic is supposed to guarantee this and
    // once did not: a settings change re-pointed the playhead into the middle of
    // the look-ahead window and every voice in it was handed over again, which
    // sounded like the notes repeating and the mix getting very loud. `handed`
    // is cleared by `seek`, where re-posting IS right because the worklet has
    // been told to stop everything.
    if (handed.has(p.index)) {
      nextIndex += 1;
      continue;
    }
    // ❗ Frames and gain derived HERE, from the tempo, swing and faders as they
    // stand this instant. Everything else about the voice was decided once.
    const at = frameOf(p);
    const life = lifeOf(p);
    // The delay this voice waits before it starts, and its own end rebased onto
    // that delay so the mixer's `endFrame - startFrame` is still its length.
    const delay = Math.max(0, Math.round(at - now));
    const { end, stole } = pool.add(p.index, {
      start: p.poolStart,
      end: p.poolEnd,
      score: scoreOf(p),
    });
    const cut = end < p.poolEnd ? cutFrameAt(end) - at : undefined;
    node.port.postMessage({
      type: 'play',
      sampleId: p.sampleId,
      voice: {
        ...onClock(p),
        gain: gainOf(p),
        tag: p.index,
        startFrame: delay,
        endFrame: life === undefined ? undefined : delay + life,
        cutFrame: cut === undefined ? undefined : delay + cut,
      },
      lfoPhase: p.lfoPhase,
    });
    handed.set(p.index, p.startStep);
    if (stole) {
      stolenLive += 1;
      const cell = document.getElementById('stolenCell');
      if (cell) cell.textContent = stolenLive.toLocaleString();
      // The victim loses its record at the thief's start. `cutAt` counts the
      // frames it still gets to sound, so measure from wherever it is now.
      const startStep = handed.get(stole.index);
      if (startStep !== undefined) {
        node.port.postMessage({
          type: 'cutAt',
          tag: stole.index,
          frames: Math.max(0, cutFrameAt(stole.at) - Math.max(now, cutFrameAt(startStep))),
        });
      }
    }
    nextIndex += 1;
  }
  if (now >= songFrames) {
    stop();
    cursorFrames = songFrames;
  }
  paint();
  if (playing) window.setTimeout(pump, TICK);
}

function paint(): void {
  const frames = songPosition();
  const ratio = songFrames > 0 ? Math.min(1, frames / songFrames) : 0;
  head.style.left = `${ratio * 100}%`;
  clockLabel.textContent = `${clock(frames / RATE)} / ${clock(songSeconds)}`;
  timeline.setAttribute('aria-valuenow', (frames / RATE).toFixed(1));
  timeline.setAttribute('aria-valuetext', `${clock(frames / RATE)} of ${clock(songSeconds)}`);
}

// -------------------------------------------------------------------- wiring

playButton.addEventListener('click', () => (playing ? stop() : start()));
rewindButton.addEventListener('click', () => seek(0));

timeline.addEventListener('pointerdown', (event) => {
  if (!plan.length) return;
  const box = timeline.getBoundingClientRect();
  seek(((event.clientX - box.left) / box.width) * songFrames);
});

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  if (event.code !== 'Space' || !plan.length) return;
  event.preventDefault();
  if (playing) stop();
  else start();
});

// Delegated, because `showLoad` replaces the button ten times a second.
loadLabel.addEventListener('click', (event) => {
  if (!(event.target as HTMLElement).closest('.drops')) return;
  dropouts = 0;
  lostMs = 0;
  showLoad();
});

volSlider.addEventListener('input', () => {
  if (master && context) master.gain.setTargetAtTime(Number(volSlider.value), context.currentTime, 0.01);
});

for (const [id, format] of [
  ['echoTime', (v: number) => `${(v / 10).toFixed(2)} beats`],
  ['echoFb', (v: number) => (v / 100).toFixed(2)],
  ['echoMix', (v: number) => (v / 100).toFixed(2)],
  ['reverbSet', (v: number) => String(v)],
] as [string, (v: number) => string][]) {
  const el = $<HTMLInputElement>(id);
  const show = () => {
    $(`${id}Label`).textContent = format(Number(el.value));
    if (node) pushEffects();
  };
  el.addEventListener('input', show);
  show();
}
for (const id of ['optEcho', 'optReverb', 'optClip']) {
  $(id).addEventListener('change', () => node && pushEffects());
}

// The plan-time pair. Their labels update live; their effect waits for Prepare.
panWidthInput.value = String(Math.round(PAN_WIDTH * 100));
voicesInput.value = String(VOICE_POOL_SIZE);
const showPlanOptions = () => {
  $('panWidthLabel').textContent = (Number(panWidthInput.value) / 100).toFixed(2);
  $('voicesLabel').textContent = noCapBox.checked ? 'off' : voicesInput.value;
  voicesInput.disabled = noCapBox.checked;
  markStale();
};
panWidthInput.addEventListener('input', () => {
  showPlanOptions();
  pushPanWidth();
});
/**
 * The pool re-plans without stopping.
 *
 * ⚠️ The allocator needs the whole note list at once to decide what gets
 * stolen, so the size cannot be changed without rebuilding the plan -- but
 * rebuilding it does not have to interrupt anything. The new plan is swapped in
 * under the running transport and takes effect for notes not yet scheduled;
 * what is already sounding finishes as it was going to. Debounced, because it
 * is a slider and every pixel of it would otherwise start a rebuild.
 */
/**
 * One fader per channel the song has, with how many tracks land on each.
 *
 * ⚠️ **The count is the point of the display.** A board row feeds
 * `row mod NumChannels`, so rows far apart share a fader and raising the channel
 * count fans the same rows out rather than adding parts. Seeing 1150 tracks on
 * one fader, then 600 and 550 on two, is what makes that legible.
 *
 * Existing positions are carried over so that changing the count does not throw
 * away a mix -- a channel that survives keeps its level.
 */
function buildFaders(
  seq: { tracks: readonly { gridY: number }[]; volumes: readonly number[] },
  levels: readonly number[],
): void {
  const count = Math.min(CHANNEL_COUNT, Math.max(1, Number(numChannelsInput.value)));
  const perChannel = new Array<number>(count).fill(0);
  for (const t of seq.tracks) {
    perChannel[((t.gridY % count) + count) % count] += 1;
  }
  channelsBox.innerHTML = Array.from({ length: count }, (_, i) => {
    const v = i < levels.length ? levels[i] : 1;
    const used = perChannel[i];
    return (
      `<div class="knob"><label for="ch${i}" title="${used} track${used === 1 ? '' : 's'} ` +
      `on this channel">ch ${i} · ${used}</label>` +
      `<input type="range" id="ch${i}" class="chan" data-ch="${i}" min="0" max="150" ` +
      `value="${Math.round(v * 100)}"${used === 0 ? ' disabled' : ''}>` +
      `<output id="ch${i}Label">${v.toFixed(2)}</output></div>`
    );
  }).join('');
}

/**
 * Labels for the song's own settings, and the debounced rebuild they need.
 *
 * Slower than the pool's debounce because this one actually re-renders the
 * voices, where the pool is only arithmetic.
 */
const showSongOptions = () => {
  $('numChannelsLabel').textContent = numChannelsInput.value;
  $('tempoLabel').textContent = `${tempoInput.value} BPM`;
  $('swingLabel').textContent = (Number(swingInput.value) / 100).toFixed(2);
  for (const el of channelsBox.querySelectorAll<HTMLInputElement>('.chan')) {
    const out = document.getElementById(`ch${el.dataset.ch}Label`);
    if (out) out.textContent = (Number(el.value) / 100).toFixed(2);
  }
};

/**
 * Tempo, swing, channel count and the faders, applied without a rebuild.
 *
 * ✅ **Nothing the audio thread is working on is regenerated.** The samples it
 * holds, the voices already sounding and the plan itself are all untouched:
 * three numbers change, the playhead is carried over in STEPS because a tempo
 * change moves the seconds a musical position sits at, and the next note posted
 * uses the new values. There is no debounce because there is nothing to
 * debounce -- this is a handful of arithmetic, not a pass over the song.
 *
 * ⚠️ It used to set `overrides` and call `prepare(false)` behind a 450 ms
 * timer, which re-ran the whole voice pass -- 1,150 tracks on `Ascetic` -- on
 * the thread that also feeds the audio. That is the stutter a listener heard,
 * and the delay was there to make it happen less often rather than to fix it.
 */
const songChanged = () => {
  showSongOptions();
  if (!plan.length) return;
  const tempo = Number(tempoInput.value);
  overrides = {
    tempo,
    swing: Number(swingInput.value) / 100,
    numChannels: Number(numChannelsInput.value),
    volumes: [...channelsBox.querySelectorAll<HTMLInputElement>('.chan')].map(
      (el) => Number(el.value) / 100,
    ),
  };

  // Where we are in the music, not in seconds: a tempo change moves one and not
  // the other, and the music is what a listener is following.
  const stepNow = stepFrames > 0 ? songPosition() / stepFrames : 0;
  stepFrames = samplesPerStep(RATE, tempo);
  framesPerStep = stepFrames;
  swing = overrides.swing ?? 0;
  liveChannels = overrides.numChannels ?? liveChannels;
  liveVolumes = overrides.volumes ?? liveVolumes;

  songFrames = Math.round(songSteps * stepFrames) + tailFrames;
  songSeconds = songFrames / RATE;
  timeline.setAttribute('aria-valuemax', songSeconds.toFixed(1));
  cursorFrames = Math.min(songFrames, Math.round(stepNow * stepFrames));
  if (context) startedAt = context.currentTime;
  const now = songPosition();
  // ❗ **`nextIndex` must never go BACKWARDS.** `pump` posts a look-ahead window
  // to the worklet, and those voices are already there and already sounding; a
  // playhead that lands before the end of that window would hand every one of
  // them over a second time. Dragging the tempo slider did exactly that, thirty
  // times a second, and it sounded like the notes repeating and the mix getting
  // very loud -- because they were, and it was.
  //
  // ⚠️ `handed` is kept for the same reason: it is what a steal's `cutAt`
  // measures from, and clearing it left stolen voices uncut, which is the other
  // half of that loudness.
  const want = plan.findIndex((p) => frameOf(p) >= now);
  nextIndex = Math.max(nextIndex, want < 0 ? plan.length : want);
  rebuildPoolTo(nextIndex);
  // The echo delay is in beats, so it follows the tempo.
  pushEffects();
  drawDensity();
  paint();
};

/**
 * Changing the count redraws the faders before the rest of the handler reads
 * them, keeping the levels of the channels that survive.
 */
numChannelsInput.addEventListener('input', () => {
  const seq = songs.get(picker.value())?.sequencer;
  if (seq) {
    const kept = [...channelsBox.querySelectorAll<HTMLInputElement>('.chan')].map(
      (el) => Number(el.value) / 100,
    );
    buildFaders(seq, kept.length ? kept : seq.volumes);
  }
  songChanged();
});

tempoInput.addEventListener('input', songChanged);
swingInput.addEventListener('input', songChanged);
channelsBox.addEventListener('input', songChanged);

const replanSoon = () => {
  showPlanOptions();
  if (!plan.length) return;
  // ❗ No rebuild at all any more: the plan has no cuts in it, so a new size is
  // a new pool and nothing else. Replayed up to the playhead so it holds what a
  // playthrough at this size would have been holding.
  rebuildPool(songPosition());
  setStatus(
    `voice pool ${noCapBox.checked ? 'uncapped' : voicesInput.value} — ` +
      `${plan.length.toLocaleString()} voices`,
  );
};
voicesInput.addEventListener('input', replanSoon);
noCapBox.addEventListener('change', replanSoon);
showPlanOptions();

/**
 * Choosing a song gets it ready. There is no button for it.
 *
 * ⚠️ Preparing means running the whole render's voice pass, which is where the
 * voice pool decides its stealing -- it cannot be skipped or done lazily. It is
 * fast (about a second for a five-minute song), so making the listener ask for
 * it twice, once by picking and once by pressing, bought nothing.
 */
const prepareNow = () => {
  stop();
  void prepare().catch((error: unknown) => {
    setStatus('failed', true);
    setError(String((error as Error).stack ?? error));
  });
};
const picker = seqPicker(seqHost, prepareNow);

// ------------------------------------------------------------------ the file

/**
 * Open whatever was dropped: one level, a backup folder, or a zip of one.
 *
 * ❗ A backup is a pile of resources named after their SHA-1, so the page reads
 * the pile and reports what was in it -- a listener should never have to find
 * the level among forty extensionless files by hand.
 */
async function openBackup(opened: {
  label: string;
  files: readonly { name: string; bytes: Uint8Array }[];
  many: boolean;
}): Promise<void> {
  stop();
  plan = [];
  playButton.disabled = true;
  rewindButton.disabled = true;
  metersBox.innerHTML = '';
  setError('');
  dropZone.classList.add('busy');
  setStatus(`reading ${opened.label}…`);
  try {
    const only = opened.files.length === 1 ? opened.files[0] : undefined;
    const result: BackupResult = only && isZip(only)
      ? await readBackupZip(only.bytes, webInflate, webInflateRaw)
      : await readBackup(opened.files, webInflate);
    [rinstIndex, smpIndex] = await Promise.all([
      manifest('fixtures/rinst'),
      manifest('fixtures/smp'),
    ]);
    songs = new Map();
    for (const p of result.projects) {
      for (const sequencer of p.sequencers) {
        songs.set(`${p.file}#${sequencer.uid}`, { project: p, sequencer });
      }
    }
    const rows = sequencersOf(result).map((r) => ({
      key: r.key,
      name: r.name,
      tracks: r.tracks,
      // Only worth showing when there is more than one level to tell apart.
      file: result.projects.length > 1 ? r.file : undefined,
    }));
    project = result.projects[0] ?? null;
    picker.setRows(rows);
    dropZone.classList.add('loaded');
    dropTitle.textContent = openedTitle(result, rows.length, opened.label);
    dropHint.textContent = 'Click, or drop a level, a backup folder or a zip.';
    // ⚠️ A save game that would not open is a bug here and says so; one that
    // opened needs no sentence, because its levels are in the list.
    const note = saveNote(result);
    if (rows.length) prepareNow();
    else if (note) setStatus(note, true);
    else if (result.failed.length) {
      setStatus(`nothing playable: ${result.failed[0].why}`, true);
    } else setStatus('no sequencers in there', true);
    // ⚠️ A level that would not open is reported, never swallowed: a backup
    // where one of forty fails is a bug here and should look like one.
    if (result.failed.length > 0) {
      setError(result.failed.map((f) => `${f.name}: ${f.why}`).join('\n'));
    }
  } catch (error) {
    setStatus('failed', true);
    setError(String((error as Error).stack ?? error));
  } finally {
    dropZone.classList.remove('busy');
  }
}

/**
 * A song handed over by the MIDI page, if there is one.
 *
 * ⚠️ **Taken once and then removed.** It is a one-way handover, not a
 * setting: leaving it in `sessionStorage` would resurrect last week's import
 * every time this tab was reloaded, in front of whatever level was open.
 */
async function takeHandoff(): Promise<void> {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(HANDOFF_KEY);
    if (stored !== null) sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    return; // storage refused; nothing was handed over
  }
  if (stored === null) return;
  dropZone.classList.add('busy');
  setStatus('reading the imported song\u2026');
  try {
    const seq = JSON.parse(stored) as LevelProject['sequencers'][number];
    project = { file: `${seq.name}.mid`, kind: 'level', sequencers: [seq] };
    [rinstIndex, smpIndex] = await Promise.all([
      manifest('fixtures/rinst'),
      manifest('fixtures/smp'),
    ]);
    const key = `${project.file}#${seq.uid}`;
    songs = new Map([[key, { project: project as LevelProject, sequencer: seq }]]);
    picker.setRows([{ key, name: seq.name, tracks: seq.tracks.length }]);
    dropZone.classList.add('loaded');
    dropTitle.textContent = `${seq.name} \u2014 imported from MIDI`;
    dropHint.textContent = 'Click or drop to open a level instead.';
    prepareNow();
  } catch (error) {
    setStatus('the imported song could not be read', true);
    setError(String((error as Error).stack ?? error));
  } finally {
    dropZone.classList.remove('busy');
  }
}

void takeHandoff();

wireOpen({
  zone: dropZone,
  fileInput,
  folderInput: document.getElementById('folder') as HTMLInputElement | null ?? undefined,
  fileButton: document.getElementById('pickFile'),
  folderButton: document.getElementById('pickFolder'),
  onOpen: openBackup,
});
void fromFiles;
