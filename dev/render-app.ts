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
const secsSelect = $<HTMLSelectElement>('secs');
const goButton = $<HTMLButtonElement>('go');
const saveButton = $<HTMLButtonElement>('save');
const statusLine = $<HTMLDivElement>('status');
const barFill = $<HTMLDivElement>('bar').firstElementChild as HTMLDivElement;
const statsTable = $<HTMLTableElement>('stats');
const errorBox = $<HTMLPreElement>('error');
const player = $<HTMLAudioElement>('player');
const canvas = $<HTMLCanvasElement>('wave');

const worker = new Worker(new URL('./render-worker.ts', import.meta.url), { type: 'module' });

let wavUrl: string | null = null;
let wavName = 'render.wav';

const setStatus = (text: string, bad = false) => {
  statusLine.textContent = text;
  statusLine.classList.toggle('bad', bad);
};
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
    if (phase === 'dump') {
      setBar(total > 0 ? done / total : 0);
      setStatus(`fetching the corpus dump… ${(done / 1048576).toFixed(0)} MB`);
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
    const list = message.list as { uid: number; name: string; rows: number }[];
    seqSelect.innerHTML = '';
    for (const item of list) {
      const option = document.createElement('option');
      option.value = String(item.uid);
      option.textContent = `${item.name || '(untitled)'} — ${item.rows} rows, uid ${item.uid}`;
      seqSelect.append(option);
    }
    // This Is Halloween, if it is in the dump: the one every render is judged on.
    const halloween = list.find((item) => item.uid === 737099);
    if (halloween) seqSelect.value = String(halloween.uid);
    seqSelect.disabled = false;
    goButton.disabled = false;
    setBar(1);
    setStatus(
      `ready — ${list.length} sequencers, ${message.instruments} instruments, ` +
        `${message.samples} samples`,
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
    setStatus(`done — ${seconds.toFixed(1)} s rendered in ${Number(stats.elapsed).toFixed(2)} s`);
    return;
  }

  if (message.type === 'error') {
    goButton.disabled = false;
    setStatus('failed', true);
    errorBox.textContent = String(message.text);
  }
};

goButton.addEventListener('click', () => {
  errorBox.textContent = '';
  goButton.disabled = true;
  saveButton.disabled = true;
  setBar(0);
  worker.postMessage({
    type: 'render',
    uid: Number(seqSelect.value),
    seconds: Number(secsSelect.value),
  });
});

saveButton.addEventListener('click', () => {
  if (!wavUrl) return;
  const link = document.createElement('a');
  link.href = wavUrl;
  link.download = wavName;
  link.click();
});

worker.postMessage({ type: 'load' });
