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
import { pitchRatio, voiceFor } from '../src/core/voice.ts';
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
  node.connect(context.destination);
  log(`audio started at ${context.sampleRate} Hz`);
  return node;
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
    slots.push({ sample, channels: toFloatChannels(pcm, sample.channels) });
    log(
      `${sample.name}: ${sample.lengthSamples} frames, ${sample.freq} Hz, ` +
        `${sample.channels}ch, base ${noteName(wanted.baseNote)}`,
    );
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
    worklet.port.postMessage(
      {
        type: 'load',
        sample: {
          id: `slot${i}`,
          channels: slot.channels,
          sampleRate: slot.sample.freq,
        },
      },
      slot.channels.map((c) => c.buffer),
    );
    // The buffers were transferred, so re-decode is needed if we ever reload.
  }

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
      playNote(note);
      $('detail').textContent = describe(note);
    });
    keys.append(key);
  }
}

function playSequence(notes: number[], stepSeconds: number): void {
  notes.forEach((note, i) => playNote(note, i * stepSeconds));
  $('detail').textContent = `${notes.length} notes, ${stepSeconds.toFixed(3)}s apart`;
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
}

init();
