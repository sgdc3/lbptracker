/**
 * The level-render page.
 *
 * All it does is drive `packages/lbp-tracker-web/src/render-worker.ts` and show what comes back: the
 * finished samples for the waveform, and the same 48 kHz WAV bytes
 * `packages/lbp-tracker-lib/dev/render-level.ts` would have written, handed to an `<audio>` element as a
 * blob. Playback is the browser's only job here -- no resampling, no
 * `playbackRate`, nothing that could differ between engines.
 */

import { createApp, h, watch } from 'vue';
import Checks from './controls/Checks.vue';
import { render } from './controls/render.ts';
import { CONTROLS } from './controls/kit.ts';
import { seqPicker } from './seq-picker.ts';
import { isZip, saveNote, type Opened } from './open-level.ts';
import { mountOpen } from './widgets/open-panel.ts';
import type { BackupResult } from '@lbptracker/cwlib/backup.ts';
import { VOICES_UNLIMITED, VOICE_POOL_SIZE } from '@lbptracker/lib/polyphony.ts';
import { mountFooter } from './footer.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const seqHost = $<HTMLDivElement>('seq');
// The five options, declared once in `src/controls/render.ts` and mounted where
// they already sat — beside the prose that explains each one.
for (const [at, group] of [
  ['#opt-range', 'range'],
  ['#opt-pool', 'pool'],
  ['#opt-stage', 'stage'],
  ['#opt-clip', 'clip'],
] as const) {
  const app = createApp({ render: () => h(Checks, { group }) });
  app.provide(CONTROLS, render);
  app.mount(at);
}
const rangeFields = $<HTMLSpanElement>('rangeFields');
const fromInput = $<HTMLInputElement>('from');
const toInput = $<HTMLInputElement>('to');
const voicesInput = $<HTMLInputElement>('voices');
const goButton = $<HTMLButtonElement>('go');
const saveButton = $<HTMLButtonElement>('save');
const statusLine = $<HTMLDivElement>('status');
const barFill = $<HTMLDivElement>('bar').firstElementChild as HTMLDivElement;
const statsGrid = $<HTMLDivElement>('stats');
const errorCard = $<HTMLElement>('errorCard');
const errorBox = $<HTMLPreElement>('error');
/** Show the error card only when it has something in it. */
const setError = (text: string) => {
  errorBox.textContent = text;
  errorCard.classList.toggle('show', text !== '');
};
const player = $<HTMLAudioElement>('player');
const canvas = $<HTMLCanvasElement>('wave');
const playPause = $<HTMLButtonElement>('playPause');
const timesLabel = $<HTMLSpanElement>('times');
const muteButton = $<HTMLButtonElement>('mute');
const volSlider = $<HTMLInputElement>('vol');
const drop = mountOpen('#open', { onOpen: (opened) => loadFrom(opened) });

voicesInput.value = String(VOICE_POOL_SIZE);

/**
 * The voice pool: a positive count, or no cap at all when `unlimited` is ticked.
 *
 * ⚠️ Uncapping it is the one switch here that makes the render *less* like the
 * game rather than differently like it -- the 32-voice pool is the engine's, and
 * a level written against it depends on the stealing. It exists because a render
 * with no cap is how the pool's effect was measured in the first place.
 *
 * The tick disables the box rather than clearing it, so the count you were using
 * is still there when you turn the cap back on.
 */
const readVoices = (): number | null => {
  if (render.on('optNoCap')) return VOICES_UNLIMITED;
  const text = voicesInput.value.trim();
  if (text === '') return VOICE_POOL_SIZE;
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : null;
};

const syncVoiceCap = () => {
  voicesInput.disabled = render.on('optNoCap');
  if (render.on('optNoCap')) voicesInput.classList.remove('bad');
};
watch(() => render.on('optNoCap'), syncVoiceCap);
syncVoiceCap();

// The renderer has nothing to do when a song is picked -- rendering waits for
// the button -- so the picker only filters here.
const picker = seqPicker(seqHost, () => {});

const worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' });

let wavUrl: string | null = null;
let wavName = 'render.wav';
/** The level currently loaded, so the drop zone can say what it is holding. */
let loadedName = '';

const setStatus = (text: string, bad = false) => {
  statusLine.textContent = text;
  statusLine.classList.toggle('bad', bad);
};
/**
 * Read a time box: `90`, `1:30` and `01:30` all mean the same 90 seconds, and
 * empty means "not set" rather than zero.
 *
 * Returns `null` for anything it cannot read, which the caller shows as an
 * error rather than silently treating as the start of the song.
 */
function parseTime(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const parts = trimmed.split(':');
  if (parts.length > 2 || parts.some((p) => p === '' || !/^\d+(\.\d+)?$/.test(p))) return null;
  const seconds = parts.length === 2 ? Number(parts[0]) * 60 + Number(parts[1]) : Number(parts[0]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** `1 sequencers` was on screen for about a minute before anyone typed this. */
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const setBar = (fraction: number) => {
  barFill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
};

/**
 * How much of a render each phase is worth.
 *
 * ⚠️ **Measured, not guessed.** `renderSequencer` returns per-phase timings, and
 * on the 368-second reference render they are voices 0.33 s, mix 15.88 s,
 * effects 1.25 s -- so the mix is **92%** of the wait. Weighting the phases
 * equally, or tracking only the phases around the mix, is what made the bar run
 * to the top and then sit still for fifteen seconds.
 */
const WEIGHTS: Record<string, { start: number; span: number; label: string }> = {
  voices: { start: 0, span: 0.02, label: 'scheduling voices' },
  mix: { start: 0.02, span: 0.92, label: 'mixing voices' },
  effects: { start: 0.94, span: 0.06, label: 'echo and reverb' },
};

/**
 * Clear whatever the last render left behind.
 *
 * Called before a new dump is opened. Without it a stale waveform, a stale stats
 * table and -- worse -- a playable audio element from the *previous* dump sit
 * under a picker that has just been pointed at a different file.
 */
function resetResults() {
  if (wavUrl) URL.revokeObjectURL(wavUrl);
  wavUrl = null;
  player.removeAttribute('src');
  player.load();
  saveButton.disabled = true;
  statsGrid.innerHTML = '';
  setError('');
  peaks = null;
  canvas.classList.add('empty');
  for (const el of [playPause, muteButton, volSlider]) el.disabled = true;
  paint();
  syncTransport();
}

/**
 * Whether the picker accepts a new file. Refused while a load or a render runs.
 *
 * ⚠️ `.busy` is `pointer-events: none`, so failing to clear it does not look
 * like a bug: the box simply stops responding, with nothing in the console. It
 * was being cleared from a branch placed *after* the `done` handler's own
 * `return`, so it never ran and the picker died the moment a render finished.
 */
function setBusy(value: boolean) {
  drop.busy(value);
}

/*
 * ---------------------------------------------------------------- the player
 *
 * The waveform *is* the transport: it draws the position, it takes the clicks
 * and the keyboard, and the row beneath it holds only what a picture cannot do
 * (a play button, a clock, a volume).
 *
 * ⚠️ **The `<audio>` element is still there, hidden.** It stays the decoder and
 * the clock -- everything here drives it and reads it back. Reimplementing
 * playback over `AudioContext` would mean owning buffering and seek, and would
 * put a second audio path in a project whose whole point is that the render is
 * the only arithmetic that matters.
 */

/** One peak per canvas column, computed once per render and reused every frame. */
let peaks: Float32Array | null = null;
/** Set while a pointer drag is scrubbing, so the clock does not fight the hand. */
let scrubbing = false;

const PLAY = '\u25b6';
const PAUSE = '\u23f8';
const LOUD = '\ud83d\udd0a';
const MUTED = '\ud83d\udd07';

/** `0:00` / `5:39`, and `-` before anything is loaded. */
const clock = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

/** Draw the envelope, split at the playhead. */
function paint() {
  const context = canvas.getContext('2d')!;
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  if (!peaks) return;

  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  const played = duration > 0 ? Math.round((player.currentTime / duration) * width) : 0;
  const mid = height / 2;

  for (let x = 0; x < width; x += 1) {
    const h = Math.max(1, peaks[x] * (height - 6));
    context.fillStyle = x <= played ? '#6fd3a0' : '#3d4a52';
    context.fillRect(x, mid - h / 2, 1, h);
  }
  if (duration > 0) {
    context.fillStyle = '#e6e8ec';
    context.fillRect(Math.min(played, width - 2), 0, 2, height);
  }
}

/** Keep the clock, the button and the slider's ARIA in step with the element. */
function syncTransport() {
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  timesLabel.textContent = `${clock(player.currentTime)} / ${clock(duration)}`;
  playPause.textContent = player.paused ? PLAY : PAUSE;
  playPause.setAttribute('aria-label', player.paused ? 'Play' : 'Pause');
  muteButton.textContent = player.muted || player.volume === 0 ? MUTED : LOUD;
  muteButton.setAttribute('aria-label', player.muted ? 'Unmute' : 'Mute');
  canvas.setAttribute('aria-valuemax', duration.toFixed(1));
  canvas.setAttribute('aria-valuenow', player.currentTime.toFixed(1));
  canvas.setAttribute(
    'aria-valuetext',
    peaks ? `${clock(player.currentTime)} of ${clock(duration)}` : 'nothing rendered yet',
  );
}

/**
 * Repaint on every animation frame while playing.
 *
 * ⚠️ `timeupdate` alone is not enough: it fires about four times a second, which
 * makes the playhead visibly step rather than move. The loop stops itself as
 * soon as playback does, so a paused page costs nothing.
 */
function frame() {
  paint();
  syncTransport();
  if (!player.paused && !player.ended) requestAnimationFrame(frame);
}

/** Seek from a pointer position over the canvas. */
function seekTo(clientX: number) {
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  if (!peaks || duration <= 0) return;
  const box = canvas.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  player.currentTime = ratio * duration;
  paint();
  syncTransport();
}

canvas.addEventListener('pointerdown', (event) => {
  if (!peaks) return;
  scrubbing = true;
  canvas.setPointerCapture(event.pointerId);
  seekTo(event.clientX);
});
canvas.addEventListener('pointermove', (event) => {
  if (scrubbing) seekTo(event.clientX);
});
canvas.addEventListener('pointerup', (event) => {
  scrubbing = false;
  canvas.releasePointerCapture(event.pointerId);
});

const togglePlay = () => {
  if (!peaks) return;
  if (player.paused) void player.play();
  else player.pause();
};

playPause.addEventListener('click', togglePlay);

// Space and Enter play, the arrows scrub, Home/End jump. This is the whole
// reason the canvas carries `tabindex` and `role="slider"`.
canvas.addEventListener('keydown', (event) => {
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  if (!peaks || duration <= 0) return;
  const step = event.shiftKey ? 30 : 5;
  const set = (t: number) => {
    player.currentTime = Math.min(duration, Math.max(0, t));
    paint();
    syncTransport();
  };
  switch (event.key) {
    case ' ':
    case 'Enter': togglePlay(); break;
    case 'ArrowLeft': set(player.currentTime - step); break;
    case 'ArrowRight': set(player.currentTime + step); break;
    case 'Home': set(0); break;
    case 'End': set(duration); break;
    case 'ArrowUp': volSlider.value = String(Math.min(1, player.volume + 0.05));
                    volSlider.dispatchEvent(new Event('input')); break;
    case 'ArrowDown': volSlider.value = String(Math.max(0, player.volume - 0.05));
                      volSlider.dispatchEvent(new Event('input')); break;
    default: return;
  }
  event.preventDefault();
});

volSlider.addEventListener('input', () => {
  player.volume = Number(volSlider.value);
  player.muted = player.volume === 0;
  syncTransport();
});

muteButton.addEventListener('click', () => {
  player.muted = !player.muted;
  syncTransport();
});

player.addEventListener('play', frame);
player.addEventListener('pause', () => { paint(); syncTransport(); });
player.addEventListener('ended', () => { paint(); syncTransport(); });
player.addEventListener('loadedmetadata', () => { paint(); syncTransport(); });
player.addEventListener('timeupdate', () => { if (!scrubbing) syncTransport(); });

/** A cheap peak envelope, so a finished render is visible as well as audible. */
function drawWave(left: Float32Array, right: Float32Array) {
  const { width } = canvas;
  const envelope = new Float32Array(width);
  const per = Math.max(1, Math.floor(left.length / width));
  for (let x = 0; x < width; x += 1) {
    let peak = 0;
    const start = x * per;
    for (let i = start; i < start + per && i < left.length; i += 1) {
      const v = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      if (v > peak) peak = v;
    }
    envelope[x] = peak;
  }
  peaks = envelope;
  canvas.classList.remove('empty');
  for (const el of [playPause, muteButton, volSlider]) el.disabled = false;
  paint();
  syncTransport();
}

worker.onmessage = (event: MessageEvent) => {
  const message = event.data as Record<string, unknown>;

  if (message.type === 'status') {
    setStatus(String(message.text));
    return;
  }

  if (message.type === 'progress') {
    const done = Number(message.done);
    const total = Number(message.total);
    const phase = String(message.phase);
    if (phase === 'level') {
      setBar(total > 0 ? done / total : 0);
      setStatus(`reading the level… ${(done / 1048576).toFixed(1)} MB`);
      return;
    }
    const weight = WEIGHTS[phase];
    if (!weight) return;
    const within = total > 0 ? done / total : 0;
    setBar(weight.start + weight.span * within);
    setStatus(`${weight.label}… ${(within * 100).toFixed(0)}%`);
    return;
  }

  if (message.type === 'loaded') {
    const list = message.list as {
      key: string; name: string; tracks: number; file?: string;
    }[];
    picker.setRows(list);
    // This Is Halloween, if it is in here: the one every render is judged on.
    const halloween = list.find((item) => item.key.endsWith('#737099'));
    if (halloween) picker.select(halloween.key);
    // ⚠️ A level that would not open is said out loud, never swallowed.
    for (const bad of (message.failed as { name: string; why: string }[] | undefined) ?? []) {
      setStatus(`${bad.name}: ${bad.why}`, true);
    }
    // ⚠️ A save game that would not open is a bug in this parser and says so;
    // one that opened needs no sentence, because its levels are in the list.
    const saves = (message.saves as BackupResult['saves'] | undefined) ?? [];
    const note = saveNote({ saves });
    if (note) setStatus(note, true);
    // ❗ The worker composes this: a PS3 backup calls itself `32406766.zip`
    // while the save inside calls itself "FJ's Music Hub by Festerd_Jester", and
    // what came out of it is plans as often as levels.
    const title = (message.title as string | undefined) ?? loadedName;
    goButton.disabled = false;
    setBusy(false);
    setBar(1);
    // ⚠️ The zone stays. Swapping one level for another without reloading the
    // page is the first thing anyone tries, and hiding the picker after the
    // first load made it impossible.
    drop.loaded(true);
    drop.say(title, 'Click, or drop a level, a backup folder or a zip.');
    setStatus(
      `ready — ${plural(list.length, 'sequencer')}, ` +
        `${plural(Number(message.instruments), 'instrument')}, ` +
        `${plural(Number(message.samples), 'sample')}`,
    );
    return;
  }

  if (message.type === 'done') {
    const stats = message.stats as Record<string, number | number[]>;
    const left = message.left as Float32Array;
    const right = message.right as Float32Array;
    const wav = message.wav as Uint8Array;

    drawWave(left, right);
    if (wavUrl) URL.revokeObjectURL(wavUrl);
    wavUrl = URL.createObjectURL(new Blob([wav as BlobPart], { type: 'audio/wav' }));
    // ❗ The uid, out of the key: two levels in one backup can both hold a
    // sequencer numbered 7, and a file called `level-seq7-browser.wav` twice is
    // a download that overwrites itself.
    wavName = `level-seq${String(message.key).split('#').pop()}-browser.wav`;
    player.src = wavUrl;
    saveButton.disabled = false;
    goButton.disabled = false;

    const seconds = Number(stats.seconds);
    const rows: [string, string][] = [
      ['sequencer', `${String(message.name)} — ${message.tracks} tracks, ${message.tempo} BPM`],
      ['rendered', `${seconds.toFixed(1)} s, ${Number(stats.frames).toLocaleString()} frames`],
      ['notes', `${stats.played} played, ${stats.skipped} skipped, ${stats.stolen} cut by the voice pool`],
      ['effects', `echo ${(Number(stats.echoRel) * 100).toFixed(1)}%, reverb ${(Number(stats.reverbRel) * 100).toFixed(1)}% of the dry mix`],
      ['echo delay', `${Number(stats.echoSeconds).toFixed(3)} s`],
      ['reverb preset', `[${(stats.reverbPreset as number[]).join(', ')}]`],
      ['output clip', `${((100 * Number(stats.clippedFrames)) / Number(stats.frames)).toFixed(2)}% of frames`],
      ['peak / RMS', `${Number(stats.peak).toFixed(3)} / ${Number(stats.rms).toFixed(5)}` +
        (Number(stats.norm) !== 1 ? ` (normalised by ${Number(stats.norm).toFixed(3)})` : '')],
      ['render time', `${Number(stats.elapsed).toFixed(2)} s — ${(seconds / Number(stats.elapsed)).toFixed(1)}x realtime`],
      ['  of which', `voices ${(Number(stats.voicesMs) / 1000).toFixed(2)} s, mix ${(Number(stats.mixMs) / 1000).toFixed(2)} s, effects ${(Number(stats.effectsMs) / 1000).toFixed(2)} s`],
    ];
    // A row whose value is long gets the full width rather than being squeezed
    // into a column; everything measured still shows, which is the point.
    statsGrid.innerHTML = rows
      .map(([k, v]) => {
        const wide = v.length > 44 ? ' wide' : '';
        return `<div class="stat${wide}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
      })
      .join('');
    setBar(1);
    setBusy(false);
    setStatus(`done — ${seconds.toFixed(1)} s rendered in ${Number(stats.elapsed).toFixed(2)} s`);
    return;
  }

  if (message.type === 'error') {
    goButton.disabled = false;
    setBusy(false);
    setStatus('failed', true);
    setError(String(message.text));
  }
};

goButton.addEventListener('click', () => {
  setError('');
  goButton.disabled = true;
  saveButton.disabled = true;
  // The whole song unless the box is ticked. A section is the exception, and
  // making it the default meant every first render silently answered a question
  // nobody had asked.
  const from = render.on('useRange') ? parseTime(fromInput.value) : undefined;
  const to = render.on('useRange') ? parseTime(toInput.value) : undefined;
  fromInput.classList.toggle('bad', from === null);
  toInput.classList.toggle('bad', to === null);
  if (from === null || to === null) {
    goButton.disabled = false;
    setStatus('a time looks like 90 or 1:30', true);
    return;
  }
  if (to !== undefined && to <= (from ?? 0)) {
    toInput.classList.add('bad');
    goButton.disabled = false;
    setStatus('the end has to come after the start', true);
    return;
  }
  const voiceLimit = readVoices();
  if (voiceLimit === null) {
    voicesInput.classList.add('bad');
    goButton.disabled = false;
    setStatus('the voice pool is a whole number, or "off"', true);
    return;
  }
  setBusy(true);
  setBar(0);
  worker.postMessage({
    type: 'render',
    key: picker.value(),
    // An empty end means "to the end of the song", which the renderer spells as
    // a length of zero.
    from: from ?? 0,
    seconds: to === undefined ? 0 : to - (from ?? 0),
    voiceLimit,
    reverb: render.on('optReverb'),
    echo: render.on('optEcho'),
    clip: render.on('optClip'),
  });
});

saveButton.addEventListener('click', () => {
  if (!wavUrl) return;
  const link = document.createElement('a');
  link.href = wavUrl;
  link.download = wavName;
  link.click();
});

/** Hand the worker a `File`; it does the reading, so this thread stays free. */
/**
 * Hand a level, a backup folder or a zip to the worker.
 *
 * ❗ The bytes are read here and the pile goes over as plain arrays: a worker
 * cannot walk a dropped directory, and structured clone will not carry a
 * `FileSystemEntry`.
 */
function loadFrom(opened: Opened) {
  loadedName = opened.label;
  resetResults();
  picker.setRows([]);
  goButton.disabled = true;
  setBusy(true);
  setBar(0);
  setStatus(`reading ${opened.label}…`);
  const only = opened.files.length === 1 ? opened.files[0] : undefined;
  worker.postMessage({
    type: 'load',
    files: opened.files,
    zip: Boolean(only && isZip(only)),
    label: opened.label,
  });
}

watch(() => render.on('useRange'), () => {
  const on = render.on('useRange');
  fromInput.disabled = !on;
  toInput.disabled = !on;
  rangeFields.classList.toggle('off', !on);
  if (!on) {
    fromInput.classList.remove('bad');
    toInput.classList.remove('bad');
  } else {
    fromInput.focus();
  }
});


// ⚠️ Nothing is loaded until the user opens a file. The page does **not** try
// the server first: level data is other people's work, this app is meant to be a
// static site, and a page that quietly pulls 81 MB of levels off its own host is
// the thing `steering/game-assets.md` rules out. Ask, always.
setStatus('open a level to begin');
setBar(0);

mountFooter();
