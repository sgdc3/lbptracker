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

import { loaderFor, manifest, asset, type Manifest } from './assets.ts';
import { type VoiceSpec } from '../src/audio/mixer.ts';
import { readLevelProject, type LevelProject } from '../src/core/project.ts';
import { VOICES_UNLIMITED, VOICE_POOL_SIZE } from '../src/core/polyphony.ts';
import { PAN_WIDTH, RATE, renderSequencer } from '../src/core/render.ts';
import { webInflate } from '../src/platform/web.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const seqSelect = $<HTMLSelectElement>('seq');
const prepareButton = $<HTMLButtonElement>('prepare');
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
  readonly at: number; // output frames from the start of the song
  readonly sampleId: string;
  readonly voice: Omit<VoiceSpec, 'sample' | 'random' | 'startFrame' | 'endFrame' | 'cutFrame'>;
  /** Frames from this voice's own start, or undefined when it had none. */
  readonly life?: number;
  readonly cut?: number;
  readonly lfoPhase: readonly [number, number, number];
}

let project: LevelProject | null = null;
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

function showLoad(): void {
  if (!playing && sounding === 0 && queued === 0) {
    loadLabel.textContent = plan.length ? 'ready' : 'idle';
    return;
  }
  // Both numbers, always: a field that appears and disappears as it crosses
  // zero draws the eye to the wrong thing and shifts everything beside it.
  // Three decimals: a worklet running twenty voices sits far under 1%, and the
  // question this meter has to answer first is whether it is measuring at all.
  const cpu = audioLoad === null ? 'n/a' : `${(audioLoad * 100).toFixed(3)}%`;
  loadLabel.textContent = `${sounding} sounding · ${queued} queued · cpu ${cpu}`;
  loadLabel.style.color = (audioLoad ?? 0) > 0.8 ? 'var(--bad)' : '';
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
  voiceLimit: noCapBox.checked ? VOICES_UNLIMITED : Number(voicesInput.value),
});

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
      type: string; id?: string; total?: number; sounding?: number; load?: number | null;
    };
    if (data.type === 'missingSample') setError(`the worklet has no sample "${data.id}"`);
    // The only place that knows what is actually sounding is the audio thread.
    if (data.type === 'voices') {
      sounding = data.sounding ?? 0;
      queued = (data.total ?? 0) - sounding;
      audioLoad = data.load ?? null;
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

async function prepare(): Promise<void> {
  const uid = Number(seqSelect.value);
  const seq = project?.sequencers.find((s) => s.uid === uid);
  if (!seq || !rinstIndex || !smpIndex) return;

  prepareButton.disabled = true;
  setError('');
  setStatus(`preparing "${seq.name}" — ${seq.tracks.length} tracks…`);
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
        sample: _s, random: _r, startFrame: _f, endFrame, cutFrame, ...rest
      } = voice;
      const at = where.startFrame;
      built.push({
        at,
        sampleId,
        voice: rest,
        life: endFrame === undefined ? undefined : Math.max(0, endFrame - at),
        cut: cutFrame === undefined ? undefined : Math.max(0, cutFrame - at),
        lfoPhase: phase,
      });
    },
    onProgress: (phase, done, total) => {
      if ((done & 0xfff) === 0) {
        setStatus(`preparing — ${phase} ${Math.round((done / Math.max(1, total)) * 100)}%`);
      }
    },
  });

  built.sort((a, b) => a.at - b.at);
  plan = built;
  preparedWith = JSON.stringify(planOptions());
  songFrames = result.frames;
  songSeconds = result.seconds;
  framesPerStep = result.framesPerStep;
  pushEffects();
  pushPanWidth();
  drawDensity();
  seek(0);

  playButton.disabled = false;
  rewindButton.disabled = false;
  prepareButton.disabled = false;
  timeline.setAttribute('aria-valuemax', songSeconds.toFixed(1));
  metersBox.innerHTML = [
    ['voices', built.length.toLocaleString()],
    ['notes', `${result.played.toLocaleString()} played, ${result.skipped} skipped`],
    ['stolen by the pool', result.stolen.toLocaleString()],
    ['samples', String(sent.size)],
    ['length', `${clock(songSeconds)} at ${seq.tempo} BPM`],
  ]
    .map(([k, v]) => `<span>${k} <b>${v}</b></span>`)
    .join('');
  markStale();
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
    const x = Math.min(width - 1, Math.max(0, Math.floor((p.at / songFrames) * width)));
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
  nextIndex = plan.findIndex((p) => p.at >= cursorFrames);
  if (nextIndex < 0) nextIndex = plan.length;
  paint();
  if (was) start();
}

function start(): void {
  if (!context || !node || playing) return;
  void context.resume();
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
  while (nextIndex < plan.length && plan[nextIndex].at < until) {
    const p = plan[nextIndex];
    // The delay this voice waits before it starts, and its own end rebased onto
    // that delay so the mixer's `endFrame - startFrame` is still its length.
    const delay = Math.max(0, Math.round(p.at - now));
    node.port.postMessage({
      type: 'play',
      sampleId: p.sampleId,
      voice: {
        ...p.voice,
        startFrame: delay,
        endFrame: p.life === undefined ? undefined : delay + p.life,
        cutFrame: p.cut === undefined ? undefined : delay + p.cut,
      },
      lfoPhase: p.lfoPhase,
    });
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
 * The pool cannot be live, so it re-plans itself instead of waiting to be asked.
 *
 * ⚠️ The allocator needs the whole note list at once to decide what gets
 * stolen, so there is no way to change the size without rebuilding the plan.
 * Debounced, because it is a slider and every pixel of it would otherwise start
 * a render; the playhead and whether it was playing are both kept.
 */
let replanTimer = 0;
const replanSoon = () => {
  showPlanOptions();
  if (!plan.length) return;
  window.clearTimeout(replanTimer);
  replanTimer = window.setTimeout(() => {
    const at = songPosition();
    const wasPlaying = playing;
    void prepare().then(() => {
      seek(at);
      if (wasPlaying) start();
    });
  }, 400);
};
voicesInput.addEventListener('input', replanSoon);
noCapBox.addEventListener('change', replanSoon);
showPlanOptions();

prepareButton.addEventListener('click', () => {
  void prepare().catch((error: unknown) => {
    prepareButton.disabled = false;
    setStatus('failed', true);
    setError(String((error as Error).stack ?? error));
  });
});

// ------------------------------------------------------------------ the file

async function openFile(file: File): Promise<void> {
  stop();
  plan = [];
  playButton.disabled = true;
  rewindButton.disabled = true;
  metersBox.innerHTML = '';
  setError('');
  dropZone.classList.add('busy');
  setStatus(`reading ${file.name}…`);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    project = await readLevelProject(file.name, bytes, webInflate);
    [rinstIndex, smpIndex] = await Promise.all([
      manifest('fixtures/rinst'),
      manifest('fixtures/smp'),
    ]);
    const list = project.sequencers
      .map((s) => ({ uid: s.uid, name: s.name, tracks: s.tracks.length }))
      .sort((a, b) => b.tracks - a.tracks);
    seqSelect.innerHTML = list
      .map((s) => `<option value="${s.uid}">${s.name || '(untitled)'} — ${s.tracks} instruments</option>`)
      .join('');
    seqSelect.disabled = list.length === 0;
    prepareButton.disabled = list.length === 0;
    dropZone.classList.add('loaded');
    dropTitle.textContent = `${file.name} — ${list.length} sequencers`;
    dropHint.textContent = 'Click or drop to open a different file.';
    setStatus(`ready — ${list.length} sequencers, pick one and prepare it`);
  } catch (error) {
    setStatus('failed', true);
    setError(String((error as Error).stack ?? error));
  } finally {
    dropZone.classList.remove('busy');
  }
}

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
});
for (const type of ['dragenter', 'dragover']) {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.remove('over');
  });
}
dropZone.addEventListener('drop', (event) => {
  const file = (event as DragEvent).dataTransfer?.files?.[0];
  if (file) void openFile(file);
});
