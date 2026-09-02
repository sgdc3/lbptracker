/**
 * The level-render page.
 *
 * All it does is drive `dev/render-worker.ts` and show what comes back: the
 * finished samples for the waveform, and the same 48 kHz WAV bytes
 * `dev/render-level.ts` would have written, handed to an `<audio>` element as a
 * blob. Playback is the browser's only job here -- no resampling, no
 * `playbackRate`, nothing that could differ between engines.
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const seqSelect = $<HTMLSelectElement>('seq');
const useRange = $<HTMLInputElement>('useRange');
const rangeFields = $<HTMLSpanElement>('rangeFields');
const fromInput = $<HTMLInputElement>('from');
const toInput = $<HTMLInputElement>('to');
const goButton = $<HTMLButtonElement>('go');
const saveButton = $<HTMLButtonElement>('save');
const statusLine = $<HTMLDivElement>('status');
const barFill = $<HTMLDivElement>('bar').firstElementChild as HTMLDivElement;
const statsTable = $<HTMLTableElement>('stats');
const errorBox = $<HTMLPreElement>('error');
const player = $<HTMLAudioElement>('player');
const canvas = $<HTMLCanvasElement>('wave');
const dropZone = $<HTMLDivElement>('drop');
const dropTitle = $<HTMLElement>('dropTitle');
const dropHint = $<HTMLElement>('dropHint');
const fileInput = $<HTMLInputElement>('file');

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
  statsTable.innerHTML = '';
  errorBox.textContent = '';
  canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
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
  dropZone.classList.toggle('busy', value);
}

/** A cheap peak envelope, so a finished render is visible as well as audible. */
function drawWave(left: Float32Array, right: Float32Array) {
  const context = canvas.getContext('2d')!;
  const { width, height } = canvas;
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#6fd3a0';
  const per = Math.max(1, Math.floor(left.length / width));
  for (let x = 0; x < width; x += 1) {
    let peak = 0;
    const start = x * per;
    for (let i = start; i < start + per && i < left.length; i += 1) {
      const v = Math.max(Math.abs(left[i]), Math.abs(right[i]));
      if (v > peak) peak = v;
    }
    const h = Math.max(1, peak * height);
    context.fillRect(x, (height - h) / 2, 1, h);
  }
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
    const list = message.list as { uid: number; name: string; tracks: number }[];
    seqSelect.innerHTML = '';
    for (const item of list) {
      const option = document.createElement('option');
      option.value = String(item.uid);
      option.textContent = `${item.name || '(untitled)'} — ${plural(item.tracks, 'instrument')}`;
      seqSelect.append(option);
    }
    // This Is Halloween, if it is in this level: the one every render is judged on.
    const halloween = list.find((item) => item.uid === 737099);
    if (halloween) seqSelect.value = String(halloween.uid);
    seqSelect.disabled = false;
    goButton.disabled = false;
    setBusy(false);
    setBar(1);
    // ⚠️ The zone stays. Swapping one level for another without reloading the
    // page is the first thing anyone tries, and hiding the picker after the
    // first load made it impossible.
    dropZone.classList.add('loaded');
    dropTitle.textContent = `${loadedName} — ${plural(list.length, 'sequencer')}`;
    dropHint.textContent = 'Click or drop to open a different file.';
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
    wavName = `level-seq${message.uid}-browser.wav`;
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
    statsTable.innerHTML = rows
      .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
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
    errorBox.textContent = String(message.text);
  }
};

goButton.addEventListener('click', () => {
  errorBox.textContent = '';
  goButton.disabled = true;
  saveButton.disabled = true;
  // The whole song unless the box is ticked. A section is the exception, and
  // making it the default meant every first render silently answered a question
  // nobody had asked.
  const from = useRange.checked ? parseTime(fromInput.value) : undefined;
  const to = useRange.checked ? parseTime(toInput.value) : undefined;
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
  setBusy(true);
  setBar(0);
  worker.postMessage({
    type: 'render',
    uid: Number(seqSelect.value),
    // An empty end means "to the end of the song", which the renderer spells as
    // a length of zero.
    from: from ?? 0,
    seconds: to === undefined ? 0 : to - (from ?? 0),
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
function loadFrom(file: File) {
  loadedName = file.name;
  resetResults();
  seqSelect.disabled = true;
  seqSelect.innerHTML = '<option>loading…</option>';
  goButton.disabled = true;
  setBusy(true);
  setBar(0);
  setStatus(`reading ${file.name}…`);
  worker.postMessage({ type: 'load', file });
}

useRange.addEventListener('change', () => {
  const on = useRange.checked;
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

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  // Cleared so that picking the *same* file again still fires `change`, which
  // is how you re-read a level you have just re-exported from the game.
  fileInput.value = '';
  if (file) loadFrom(file);
});
for (const event of ['dragenter', 'dragover'] as const) {
  dropZone.addEventListener(event, (e) => {
    e.preventDefault();
    dropZone.classList.add('over');
  });
}
for (const event of ['dragleave', 'drop'] as const) {
  dropZone.addEventListener(event, () => dropZone.classList.remove('over'));
}
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (file) loadFrom(file);
});

// ⚠️ Nothing is loaded until the user opens a file. The page does **not** try
// the server first: level data is other people's work, this app is meant to be a
// static site, and a page that quietly pulls 81 MB of levels off its own host is
// the thing `steering/game-assets.md` rules out. Ask, always.
setStatus('open a level to begin');
setBar(0);
