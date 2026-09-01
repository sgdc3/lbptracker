/**
 * The piano_C2..C6 listening test.
 *
 * The point of this page is to turn three unmeasured assumptions into
 * something audible: finetune units, the velocity curve, and the pan law (open
 * questions 5 and 7). It plays the shipped piano multisample across its key
 * splits, which is the first thing in this project that can be judged by ear
 * against the game.
 *
 * The bank never leaves the browser -- see steering/game-assets.md.
 */

import { findSample, readBank, type FsbBank, type FsbSample } from '../src/core/fsb.ts';
import { decodeIma, toFloatChannels } from '../src/core/ima.ts';
import { DEFAULT_SLOT, type Instrument } from '../src/core/instrument.ts';
import { resolveSlot } from '../src/core/instrument.ts';
import { pitchRatio, velocityGain, voiceFor } from '../src/core/voice.ts';
import { sampleData } from '../src/core/fsb.ts';

/**
 * The five shipped piano samples and the MIDI note each was recorded at.
 *
 * MIDI 48 = C3 = 130.81 Hz, which is what `tools/fsb.py` measured piano_C3's
 * fundamental to be (132.8 Hz, inside one autocorrelation bin). It is also the
 * default `baseNote` in the game's own sample slot.
 *
 * ⚠️ These splits are OUR construction, not the game's. Reading the real
 * `RInstrument` needs `SampleGuids` resolved -- open question 1. Each sample
 * covers its own octave here, which is the obvious reading of a one-sample-per-
 * octave bank but is not measured.
 */
const PIANO = [
  { name: 'piano_C2', baseNote: 36 },
  { name: 'piano_C3', baseNote: 48 },
  { name: 'piano_C4', baseNote: 60 },
  { name: 'piano_C5', baseNote: 72 },
  { name: 'piano_C6', baseNote: 84 },
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

interface LoadedSlot {
  readonly sample: FsbSample;
  readonly channels: Float32Array[];
}

let context: AudioContext | undefined;
let node: AudioWorkletNode | undefined;
let loaded: LoadedSlot[] = [];
let instrument: Instrument | undefined;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = (message: string, kind: 'info' | 'bad' = 'info') => {
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = message;
  $('log').prepend(line);
};

let master: GainNode | undefined;
/** Peak of the last second of output, for the clip readout. */
let analyser: AnalyserNode | undefined;

async function ensureAudio(): Promise<AudioWorkletNode> {
  if (node) return node;
  context = new AudioContext();
  await context.audioWorklet.addModule('/src/audio/mixer-worklet.ts');
  node = new AudioWorkletNode(context, 'lbp-mixer', { outputChannelCount: [2] });
  node.port.onmessage = (event) => {
    if (event.data?.type === 'missingSample') {
      log(`worklet has no sample "${event.data.id}"`, 'bad');
    }
  };

  // The mixer has no output limiting -- overlapping voices can sum past 1.0 and
  // the destination hard-clips, which sounds like harsh digital distortion.
  // Master gain is a diagnostic here, not a design decision: if turning it down
  // cleans the sound up, the problem is summing headroom rather than the
  // decoder.
  analyser = new AnalyserNode(context, { fftSize: 2048 });
  master = new GainNode(context, { gain: 0.5 });
  node.connect(analyser);
  analyser.connect(master);
  master.connect(context.destination);

  meter();
  log(`audio started at ${context.sampleRate} Hz, master gain 0.50`);
  return node;
}

/** Show pre-master peak, so clipping caused by summing is visible. */
function meter(): void {
  const buf = new Float32Array(analyser!.fftSize);
  const tick = () => {
    analyser!.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const a = Math.abs(buf[i]);
      if (a > peak) peak = a;
    }
    const over = peak > 1;
    $('meter').textContent = `pre-master peak ${peak.toFixed(3)}${over ? '  ← OVER 1.0, clipping' : ''}`;
    $('meter').className = over ? 'bad' : '';
    requestAnimationFrame(tick);
  };
  tick();
}

async function loadBank(file: File): Promise<void> {
  $('status').textContent = `reading ${file.name}…`;
  const bank: FsbBank = readBank(new Uint8Array(await file.arrayBuffer()));
  log(`${file.name}: ${bank.sampleCount} samples, version 0x${bank.version.toString(16)}`);

  const slots: LoadedSlot[] = [];
  for (const wanted of PIANO) {
    const sample = findSample(bank, wanted.name);
    if (!sample) {
      log(`missing ${wanted.name} — is this sfxbank_compressed.fsb?`, 'bad');
      continue;
    }
    if (sample.codec !== 'ima_adpcm') {
      log(`${sample.name} is ${sample.codec}, not ADPCM`, 'bad');
      continue;
    }
    const pcm = decodeIma(sampleData(bank, sample), sample.channels, sample.lengthSamples);
    const channels = toFloatChannels(pcm, sample.channels);
    slots.push({ sample, channels });

    // Measure what actually came out of the decoder, in this browser, on this
    // machine. piano_C3 is the one with published reference numbers
    // (tools/fsb.py: peak 28588, rms 2770 in 16-bit), so a mismatch here says
    // the decode is wrong; a match says the problem is downstream in playback.
    const data = channels[0];
    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < data.length; i += 1) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
      sumSquares += data[i] * data[i];
    }
    const rms = Math.sqrt(sumSquares / data.length);
    log(
      `${sample.name}: ${sample.lengthSamples} frames, ${sample.freq} Hz, ` +
        `${sample.channels}ch, base ${noteName(wanted.baseNote)} — ` +
        `peak ${peak.toFixed(4)} rms ${rms.toFixed(4)}`,
    );
    if (sample.name.startsWith('piano_C3')) {
      const peakOk = Math.abs(peak - 28588 / 32768) < 1e-3;
      const rmsOk = Math.abs(rms - 2770 / 32768) < 2e-3;
      log(
        `piano_C3 vs the Python reference: peak ${peakOk ? 'MATCH' : 'MISMATCH'}, ` +
          `rms ${rmsOk ? 'MATCH' : 'MISMATCH'}`,
        peakOk && rmsOk ? 'info' : 'bad',
      );
    }
  }

  if (slots.length === 0) {
    $('status').textContent = 'no piano samples found in that bank';
    return;
  }

  loaded = slots;
  instrument = {
    slots: slots.map((s, i) => ({
      ...DEFAULT_SLOT,
      baseNote: PIANO[i].baseNote,
    })),
    // One octave per sample, plus the closing fencepost.
    splitNotes: [
      ...slots.map((_, i) => PIANO[i].baseNote),
      PIANO[slots.length - 1].baseNote + 12,
      0,
      0,
      0,
    ].slice(0, 9),
    numStack: slots.length,
    arpeggiate: false,
    arpeggio: [],
  };

  const worklet = await ensureAudio();
  for (const [i, slot] of slots.entries()) {
    // Deliberately NOT transferred: transferring detaches the buffers on this
    // side, which makes the decoded audio impossible to inspect and breaks
    // loading a second bank. Five piano samples are ~1.3 MB; the copy is free
    // next to the decode that produced them.
    worklet.port.postMessage({
      type: 'load',
      sample: {
        id: `slot${i}`,
        channels: slot.channels,
        sampleRate: slot.sample.freq,
      },
    });
  }
  // Handy from the console when something sounds wrong.
  (window as unknown as { __lbp: unknown }).__lbp = {
    bank,
    loaded,
    instrument,
    context,
    node,
  };

  $('status').textContent = `${slots.length} piano samples loaded — play something`;
  buildKeyboard();
  $('controls').hidden = false;
}

function playNote(note: number, atSeconds = 0, velocity = 96): void {
  if (!instrument || !node || !context) return;
  const slotIndex = resolveSlot(instrument, note);
  const slot = loaded[slotIndex];
  if (!slot) return;

  const params = voiceFor({
    note,
    volume: velocity,
    instrument,
    level: 1,
    pan: 0.5,
    sampleRate: slot.sample.freq,
    outputRate: context.sampleRate,
    tempo: 120,
  });

  node.port.postMessage({
    type: 'play',
    sampleId: `slot${slotIndex}`,
    voice: {
      playbackRate: params.playbackRate,
      gain: params.gain,
      pan: params.pan,
      startFrame: Math.round(atSeconds * context.sampleRate),
    },
  });
}

/**
 * The control: the same sample, the same pitch, through the browser's own
 * resampler instead of ours.
 *
 * `AudioBuffer` carries its own sampleRate, so the browser does the 22050 ->
 * device conversion with whatever interpolator it ships, and `playbackRate`
 * only applies the musical ratio. If this sounds clean and our path does not,
 * the fault is ours. If both sound the same, the character is in the asset --
 * IMA ADPCM at 4 bits is not transparent -- and we are chasing nothing.
 */
function playNoteViaBrowser(note: number, atSeconds = 0): void {
  if (!instrument || !context || !master) return;
  const slotIndex = resolveSlot(instrument, note);
  const slot = loaded[slotIndex];
  if (!slot) return;

  const data = slot.channels[0];
  const buffer = context.createBuffer(1, data.length, slot.sample.freq);
  buffer.copyToChannel(data, 0);

  const source = new AudioBufferSourceNode(context, {
    buffer,
    playbackRate: pitchRatio(instrument.slots[slotIndex], note, 120),
  });
  const gain = new GainNode(context, { gain: velocityGain(96) * Math.SQRT1_2 });
  source.connect(gain);
  gain.connect(master);
  source.start(context.currentTime + atSeconds);
}

function describe(note: number): string {
  if (!instrument) return '';
  const slotIndex = resolveSlot(instrument, note);
  const slot = loaded[slotIndex];
  if (!slot || !context) return '';
  const ratio = pitchRatio(instrument.slots[slotIndex], note, 120);
  const rate = ratio * (slot.sample.freq / context.sampleRate);
  return (
    `${noteName(note)} → ${slot.sample.name} ` +
    `(ratio ${ratio.toFixed(4)}, rate ${rate.toFixed(4)})`
  );
}

function buildKeyboard(): void {
  const keys = $('keys');
  keys.textContent = '';
  for (let note = 36; note <= 96; note += 1) {
    const key = document.createElement('button');
    const sharp = NOTE_NAMES[note % 12].includes('#');
    key.className = sharp ? 'key sharp' : 'key';
    key.textContent = noteName(note);
    key.title = 'click to play';
    key.addEventListener('click', () => {
      if (engine === 'ours') playNote(note);
      else playNoteViaBrowser(note);
      $('detail').textContent =
        `${describe(note)} — ${engine === 'ours' ? 'our mixer' : "browser"}`;
    });
    keys.append(key);
  }
}

/** Which engine the buttons and keys use. The A/B that answers "is it us?". */
let engine: 'ours' | 'browser' = 'ours';

function playSequence(notes: number[], stepSeconds: number): void {
  const play = engine === 'ours' ? playNote : playNoteViaBrowser;
  notes.forEach((note, i) => play(note, i * stepSeconds));
  $('detail').textContent =
    `${notes.length} notes, ${stepSeconds.toFixed(3)}s apart — ` +
    `${engine === 'ours' ? 'our mixer' : "the browser's resampler"}`;
}

function init(): void {
  const drop = $('drop');
  const input = $<HTMLInputElement>('file');

  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void loadBank(file).catch((e) => log(String(e), 'bad'));
  });
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('over');
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadBank(file).catch((e) => log(String(e), 'bad'));
  });

  $('octaves').addEventListener('click', () => {
    // The five sample base notes: every one of these should play at ratio 1.0,
    // so any audible timbre step between them means the splits are wrong.
    playSequence([36, 48, 60, 72, 84], 0.6);
  });
  $('chromatic').addEventListener('click', () => {
    const notes = [];
    for (let n = 36; n <= 96; n += 1) notes.push(n);
    playSequence(notes, 0.12);
  });
  $('scale').addEventListener('click', () => {
    const major = [0, 2, 4, 5, 7, 9, 11];
    const notes = [];
    for (let octave = 0; octave < 5; octave += 1) {
      for (const step of major) notes.push(36 + octave * 12 + step);
    }
    notes.push(96);
    playSequence(notes, 0.16);
  });
  $('stop').addEventListener('click', () => {
    node?.port.postMessage({ type: 'stopAll' });
  });
  $<HTMLSelectElement>('interp').addEventListener('change', (event) => {
    const name = (event.target as HTMLSelectElement).value;
    node?.port.postMessage({ type: 'interpolator', name });
    log(`interpolator: ${name}`);
  });
  $<HTMLSelectElement>('engine').addEventListener('change', (event) => {
    engine = (event.target as HTMLSelectElement).value as 'ours' | 'browser';
    log(`engine: ${engine === 'ours' ? 'our mixer + worklet' : "the browser's own resampler"}`);
  });
  const gain = $<HTMLInputElement>('gain');
  gain.addEventListener('input', () => {
    const value = Number(gain.value) / 100;
    $('gainLabel').textContent = value.toFixed(2);
    if (master && context) master.gain.setTargetAtTime(value, context.currentTime, 0.01);
  });
}

init();
