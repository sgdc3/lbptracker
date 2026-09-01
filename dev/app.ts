/**
 * The instrument bench: play the game's own sequencer instruments.
 *
 * Every piece of the chain this project has recovered meets here — the FARC
 * extraction, the varint `INSb` reader, the key splits, the pitch formula, the
 * mixer and the worklet. If any of them is wrong, this is where it becomes
 * audible.
 *
 * Assets are read from `fixtures/`, which is the user's own game data
 * extracted locally with `tools/ExtractGuid.java` and never committed. The dev
 * server only serves the repository, so nothing leaves this machine.
 */

import { resolveSlot } from '../src/core/instrument.ts';
import { readInstrument, usedSlots, type RInstrument } from '../src/core/rinstrument.ts';
import { loadResource } from '../src/core/resource.ts';
import { pitchRatio, velocityGain } from '../src/core/voice.ts';
import { loopRegion, readWav, type WavData } from '../src/core/wav.ts';
import { webInflate } from '../src/platform/web.ts';

interface ManifestRow {
  guid: number;
  file: string;
  path: string;
  size: number;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = (message: string, kind: 'info' | 'bad' = 'info') => {
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = message;
  $('log').prepend(line);
};

let context: AudioContext | undefined;
let node: AudioWorkletNode | undefined;
let master: GainNode | undefined;
let analyser: AnalyserNode | undefined;

let sampleIndex = new Map<number, ManifestRow>();
let instrument: RInstrument | undefined;
let loadedSlots: { guid: number; wav: WavData; name: string; baseNote: number }[] = [];
let engine: 'ours' | 'browser' = 'ours';

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
  analyser = new AnalyserNode(context, { fftSize: 2048 });
  master = new GainNode(context, { gain: 0.5 });
  node.connect(analyser);
  analyser.connect(master);
  master.connect(context.destination);
  meter();
  log(`audio started at ${context.sampleRate} Hz`);
  return node;
}

/** Pre-master peak, so clipping from summed voices is visible rather than guessed at. */
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

async function fetchManifest(dir: string): Promise<ManifestRow[]> {
  const response = await fetch(`/fixtures/${dir}/manifest.json`);
  if (!response.ok) {
    throw new Error(
      `no ${dir}/manifest.json — extract the game's data first with tools/ExtractGuid.java`,
    );
  }
  return response.json();
}

async function loadInstrument(row: ManifestRow): Promise<void> {
  $('status').textContent = `loading ${row.file}…`;

  const bytes = new Uint8Array(await (await fetch(`/fixtures/rinst/${row.file}`)).arrayBuffer());
  const resource = await loadResource(bytes, webInflate);
  instrument = readInstrument(resource.data);

  const used = usedSlots(instrument);
  const slots: typeof loadedSlots = [];
  for (const { guid, slot } of used) {
    const sample = sampleIndex.get(guid);
    if (!sample) {
      log(`slot base ${slot.baseNote}: no sample for GUID ${guid}`, 'bad');
      continue;
    }
    const wavBytes = new Uint8Array(
      await (await fetch(`/fixtures/smp/${sample.file}`)).arrayBuffer(),
    );
    const wav = readWav(wavBytes);
    slots.push({ guid, wav, name: sample.file, baseNote: slot.baseNote });
  }
  loadedSlots = slots;

  const worklet = await ensureAudio();
  slots.forEach((s, i) => {
    worklet.port.postMessage({
      type: 'load',
      sample: {
        id: `slot${i}`,
        channels: s.wav.channels,
        sampleRate: s.wav.sampleRate,
        // loopRegion, not smpl's fields verbatim -- see its docstring.
        loop: s.wav.loop
          ? loopRegion(s.wav.loop, s.wav.channels[0].length)
          : undefined,
      },
    });
  });

  log(
    `${row.file}: ${slots.length} slots, revision ${resource.revision}, ` +
      `numStack ${instrument.numStack}${instrument.arpeggiate ? ', arpeggiate' : ''}`,
  );
  for (const s of slots) {
    log(
      `   ${s.name} — base ${noteName(s.baseNote)} (${s.baseNote}), ` +
        `${s.wav.sampleRate} Hz, ${s.wav.channels[0].length} frames` +
        (s.wav.loop ? `, loop ${s.wav.loop.start}..${s.wav.loop.end}` : ', no loop'),
    );
  }
  $('splits').textContent =
    `splitNotes ${instrument.splitNotes.slice(0, slots.length + 1).join(', ')}`;

  buildKeyboard();
  $('status').textContent = `${row.path.replace(/^gamedata\/audio\/music\/instruments\//, '')}`;
  $('controls').hidden = false;
  (window as unknown as { __lbp: unknown }).__lbp = { instrument, loadedSlots, context, node };
}

function voiceFor(note: number) {
  if (!instrument || !context || loadedSlots.length === 0) return undefined;
  const zone = resolveSlot(instrument, note, loadedSlots.length);
  const s = loadedSlots[zone];
  const slot = usedSlots(instrument)[zone].slot;
  const ratio = pitchRatio(slot, note, 120);
  return { zone, s, ratio, playbackRate: ratio * (s.wav.sampleRate / context.sampleRate) };
}

/** Held-note length in seconds, from the slider. */
function noteSeconds(): number {
  return Number(($('length') as HTMLInputElement).value) / 100;
}

function playNote(note: number, atSeconds = 0): void {
  const v = voiceFor(note);
  if (!v || !node || !context) return;
  const held = noteSeconds();
  if (engine === 'browser') {
    const buffer = context.createBuffer(1, v.s.wav.channels[0].length, v.s.wav.sampleRate);
    buffer.copyToChannel(v.s.wav.channels[0], 0);
    if (v.s.wav.loop) {
      const region = loopRegion(v.s.wav.loop, v.s.wav.channels[0].length);
      buffer.loop = true;
      buffer.loopStart = region.start / v.s.wav.sampleRate;
      buffer.loopEnd = region.end / v.s.wav.sampleRate;
    }
    const source = new AudioBufferSourceNode(context, { buffer, playbackRate: v.ratio });
    const gain = new GainNode(context, { gain: velocityGain(96) * Math.SQRT1_2 });
    const at = context.currentTime + atSeconds;
    gain.gain.setValueAtTime(velocityGain(96) * Math.SQRT1_2, at + held);
    gain.gain.linearRampToValueAtTime(0, at + held + 0.12);
    source.connect(gain);
    gain.connect(master!);
    source.start(at);
    source.stop(at + held + 0.15);
    return;
  }
  node.port.postMessage({
    type: 'play',
    sampleId: `slot${v.zone}`,
    voice: {
      playbackRate: v.playbackRate,
      gain: velocityGain(96),
      pan: 0.5,
      startFrame: Math.round(atSeconds * context.sampleRate),
      // The samples loop, so a voice never ends on its own -- it has to be
      // released. Without this, low notes ring on and high notes cut off with
      // the sample rather than with the note.
      endFrame: Math.round((atSeconds + held + 0.12) * context.sampleRate),
      release: Math.round(0.12 * context.sampleRate),
    },
  });
}

function describe(note: number): string {
  const v = voiceFor(note);
  if (!v) return '';
  const semitones = note - v.s.baseNote;
  return (
    `${noteName(note)} (${note}) → slot ${v.zone} ${v.s.name} ` +
    `base ${noteName(v.s.baseNote)}, ${semitones >= 0 ? '+' : ''}${semitones} semitones, ` +
    `rate ${v.playbackRate.toFixed(4)}`
  );
}

/** Colour each key by the slot it resolves to, so the zones are visible. */
function buildKeyboard(): void {
  const keys = $('keys');
  keys.textContent = '';
  for (let note = 12; note <= 96; note += 1) {
    const v = voiceFor(note);
    const key = document.createElement('button');
    key.className = 'key' + (NOTE_NAMES[note % 12].includes('#') ? ' sharp' : '');
    if (v) key.style.borderBottom = `3px solid ${zoneColour(v.zone)}`;
    key.textContent = noteName(note);
    key.title = describe(note);
    key.addEventListener('click', () => {
      playNote(note);
      $('detail').textContent = describe(note);
    });
    keys.append(key);
  }
}

function zoneColour(zone: number): string {
  const hues = [150, 200, 265, 320, 20, 45, 90, 175];
  return `hsl(${hues[zone % hues.length]} 60% 55%)`;
}

function playSequence(notes: number[], step: number): void {
  notes.forEach((n, i) => playNote(n, i * step));
  $('detail').textContent =
    `${notes.length} notes — ${engine === 'ours' ? 'our mixer' : "the browser's resampler"}`;
}

async function init(): Promise<void> {
  try {
    const [instruments, samples] = await Promise.all([
      fetchManifest('rinst'),
      fetchManifest('smp'),
    ]);
    sampleIndex = new Map(samples.map((s) => [s.guid, s]));

    const select = $<HTMLSelectElement>('instrument');
    instruments
      .sort((a, b) => a.file.localeCompare(b.file))
      .forEach((row, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = row.file.replace('.rinst', '');
        select.append(option);
      });
    select.addEventListener('change', () => {
      const row = instruments[Number(select.value)];
      void loadInstrument(row).catch((e) => log(String(e), 'bad'));
    });
    $('status').textContent =
      `${instruments.length} instruments and ${samples.length} samples ready — pick one`;
    log(`manifest: ${instruments.length} instruments, ${samples.length} samples`);
  } catch (error) {
    $('status').textContent = String(error);
    log(String(error), 'bad');
    return;
  }

  $('octaves').addEventListener('click', () => {
    // One note per slot, at that slot's own base note: every one plays at
    // ratio 1.0, so they should sound like one instrument.
    playSequence(loadedSlots.map((s) => s.baseNote).reverse(), 0.7);
  });
  $('scale').addEventListener('click', () => {
    const major = [0, 2, 4, 5, 7, 9, 11];
    const notes: number[] = [];
    for (let octave = 0; octave < 5; octave += 1) {
      for (const step of major) notes.push(36 + octave * 12 + step);
    }
    playSequence(notes, 0.16);
  });
  $('chromatic').addEventListener('click', () => {
    const notes: number[] = [];
    for (let n = 24; n <= 96; n += 1) notes.push(n);
    playSequence(notes, 0.12);
  });
  $('stop').addEventListener('click', () => node?.port.postMessage({ type: 'stopAll' }));
  $<HTMLSelectElement>('engine').addEventListener('change', (e) => {
    engine = (e.target as HTMLSelectElement).value as 'ours' | 'browser';
    log(`engine: ${engine}`);
  });
  $<HTMLSelectElement>('interp').addEventListener('change', (e) => {
    const name = (e.target as HTMLSelectElement).value;
    node?.port.postMessage({ type: 'interpolator', name });
    log(`interpolator: ${name}`);
  });
  const length = $<HTMLInputElement>('length');
  const showLength = () => {
    $('lengthLabel').textContent = `${(Number(length.value) / 100).toFixed(2)}s`;
  };
  length.addEventListener('input', showLength);
  showLength();

  const gain = $<HTMLInputElement>('gain');
  gain.addEventListener('input', () => {
    const value = Number(gain.value) / 100;
    $('gainLabel').textContent = value.toFixed(2);
    if (master && context) master.gain.setTargetAtTime(value, context.currentTime, 0.01);
  });
}

void init();
