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

import { ADSR_PARAMS, ADSR_PARAMS_B, evaluateAdsr } from '../src/core/envelope.ts';
import { FILTER_PARAMS } from '../src/audio/moog.ts';
import { LFO_PARAMS, OUTPUT_PARAMS } from '../src/core/params.ts';
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

/**
 * Fetch an asset, failing loudly if the server did not serve it.
 *
 * Without the status check a 404 comes back as an HTML error page, and the
 * first thing to notice is `readWav` saying "not a RIFF/WAVE file" -- which
 * points at the parser instead of at the URL. That is exactly how the `#` in
 * `choir_g#4_v2.smp` hid for as long as it did.
 */
async function fetchAsset(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} fetching ${url}`);
  }
  return response.arrayBuffer();
}
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

/**
 * Computer-keyboard layout, the one every tracker and DAW uses: the home row is
 * one octave with its sharps on the row above, and QWERTY is the octave above
 * that. The arrow keys shift octave.
 */
const KEY_MAP: Record<string, number> = {
  KeyZ: 0, KeyS: 1, KeyX: 2, KeyD: 3, KeyC: 4, KeyV: 5, KeyG: 6,
  KeyB: 7, KeyH: 8, KeyN: 9, KeyJ: 10, KeyM: 11, Comma: 12, KeyL: 13,
  Period: 14, Semicolon: 15, Slash: 16,
  KeyQ: 12, Digit2: 13, KeyW: 14, Digit3: 15, KeyE: 16, KeyR: 17, Digit5: 18,
  KeyT: 19, Digit6: 20, KeyY: 21, Digit7: 22, KeyU: 23, KeyI: 24, Digit9: 25,
  KeyO: 26, Digit0: 27, KeyP: 28,
};

/** MIDI note of the bottom key of the home row. C3 = 48 by default. */
let octaveBase = 48;
const heldKeys = new Set<string>();

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

  const bytes = new Uint8Array(await fetchAsset(`/fixtures/rinst/${encodeURIComponent(row.file)}`));
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
    // ⚠️ encodeURIComponent, not the bare name. Three of the game's 216 sample
    // files are named for sharps -- `choir_g#4_v2.smp`, `choir_f#3_v2.smp`,
    // `violin_spic_string4_f#4.smp` -- and a `#` in a URL starts the fragment,
    // so the browser requested `/fixtures/smp/choir_g` and silently dropped the
    // rest. It 404s, `readWav` then reports "not a RIFF/WAVE file", and the
    // instrument looks like a parser bug rather than a URL one. The 48 files
    // with spaces in their names had been working only because the browser
    // encodes those for you.
    const wavBytes = new Uint8Array(
      await fetchAsset(`/fixtures/smp/${encodeURIComponent(sample.file)}`),
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
  {
    const a = evaluateAdsr(instrument.params, ADSR_PARAMS, 0);
    log(
      `   ADSR — attack ${a.attack.toFixed(3)}s, decay ${a.decay.toFixed(3)}s, ` +
        `sustain ${a.sustain.toFixed(3)}, release ${a.release.toFixed(3)}s ` +
        `(Params[11..14])`,
    );
    const p = instrument.params;
    const b = evaluateAdsr(p, ADSR_PARAMS_B, 0);
    const lfos = LFO_PARAMS.map((l, n) =>
      p[l.depth].x > 0 || p[l.depth].y > 0
        ? `LFO${n + 1} rate ${p[l.rate].x.toFixed(2)} depth ${p[l.depth].x.toFixed(2)}`
        : null,
    ).filter(Boolean);
    log(
      `   output — level ${p[OUTPUT_PARAMS.level].x.toFixed(3)}, ` +
        `send ${p[OUTPUT_PARAMS.send].x.toFixed(3)}, ` +
        `drive ${p[OUTPUT_PARAMS.drive].x.toFixed(3)}; ` +
        (lfos.length ? lfos.join(', ') : 'no LFO'),
    );
    log(
      `   filter — cutoff ${p[3].x.toFixed(2)}, resonance ${p[4].x.toFixed(2)}, ` +
        `keytrack ${p[5].x.toFixed(2)}, env amount ${p[6].x.toFixed(2)}; ` +
        `its ADSR ${b.attack.toFixed(2)}/${b.decay.toFixed(2)}/` +
        `${b.sustain.toFixed(2)}/${b.release.toFixed(2)} (Params[3..10])`,
    );
  }
  $('splits').textContent =
    `splitNotes ${instrument.splitNotes.slice(0, slots.length + 1).join(', ')}`;

  buildKeyboard();
  $('octave').textContent = `octave: ${noteName(octaveBase)}`;
  $('status').textContent = `${row.path.replace(/^gamedata\/audio\/music\/instruments\//, '')}`;
  $('controls').hidden = false;
  // Everything a console session needs to tap either engine. `master` matters:
  // it is where the worklet path and the AudioBufferSource path converge, so it
  // is the only place an A/B measurement can hear both.
  (window as unknown as { __lbp: unknown }).__lbp = {
    instrument, loadedSlots, context, node, master, analyser,
  };
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

/**
 * The instrument's own ADSR, or undefined when the bench is asked to fall back
 * to the stand-ins so the two can be compared.
 *
 * `mod` is 0 here: the bench has no note word, so every `Params` range is taken
 * at its `.x` end, which is what a note with the modulation field at zero gets.
 */
function currentAdsr() {
  if (!instrument) return undefined;
  if (!($('useEnvelope') as HTMLInputElement).checked) return undefined;
  return evaluateAdsr(instrument.params, ADSR_PARAMS, 0);
}

/**
 * The instrument's Moog ladder, or undefined when it is switched off.
 *
 * Left open (cutoff 1, no resonance, no envelope) the filter still colours the
 * sound -- this approximation loses a little even wide open -- so the checkbox
 * bypasses it entirely rather than setting it flat.
 */
function currentFilter() {
  if (!instrument) return undefined;
  if (!($('useFilter') as HTMLInputElement).checked) return undefined;
  const p = instrument.params;
  return {
    settings: {
      cutoff: p[FILTER_PARAMS.cutoff].x,
      resonance: p[FILTER_PARAMS.resonance].x,
      keyTrack: p[FILTER_PARAMS.keyTrack].x,
      envAmount: p[FILTER_PARAMS.envAmount].x,
    },
    envelope: evaluateAdsr(p, ADSR_PARAMS_B, 0),
  };
}

/** The instrument's three LFOs, evaluated at modulation 0, or undefined when off. */
function currentLfos() {
  if (!instrument) return undefined;
  if (!($('useLfos') as HTMLInputElement).checked) return undefined;
  const p = instrument.params;
  const one = (l: (typeof LFO_PARAMS)[number]) => ({
    rate: p[l.rate].x,
    depth: p[l.depth].x,
    spread: p[l.spread].x,
  });
  return [one(LFO_PARAMS[0]), one(LFO_PARAMS[1]), one(LFO_PARAMS[2])] as const;
}

function playNote(note: number, atSeconds = 0): void {
  const v = voiceFor(note);
  if (!v || !node || !context) return;
  const held = noteSeconds();
  const adsr = currentAdsr();
  const filter = currentFilter();
  const lfos = currentLfos();
  if (engine === 'browser') {
    const buffer = context.createBuffer(1, v.s.wav.channels[0].length, v.s.wav.sampleRate);
    buffer.copyToChannel(new Float32Array(v.s.wav.channels[0]), 0);
    const opts: AudioBufferSourceOptions = { buffer, playbackRate: v.ratio };
    if (v.s.wav.loop) {
      const region = loopRegion(v.s.wav.loop, v.s.wav.channels[0].length);
      opts.loop = true;
      opts.loopStart = region.start / v.s.wav.sampleRate;
      opts.loopEnd = region.end / v.s.wav.sampleRate;
    }
    const source = new AudioBufferSourceNode(context, opts);

    // ⚠️ The control is only worth having if it is actually equivalent. `loop`,
    // `loopStart` and `loopEnd` belong to AudioBufferSourceNode, NOT to
    // AudioBuffer -- setting them on the buffer is silently ignored, which left
    // this path not looping at all for three commits while our own mixer did.
    // A control that quietly differs is worse than no control, so say so loudly.
    if (Boolean(v.s.wav.loop) !== source.loop) {
      log(
        `control mismatch: sample ${v.s.name} ${v.s.wav.loop ? 'has' : 'has no'} loop ` +
          `but the browser source has loop=${source.loop} — the A/B is not comparing like with like`,
        'bad',
      );
    }

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
      // The instrument's own level, Params[24]. ⚠️ The engine also folds in
      // sqrt(1/Numstack) here, the equal-power correction for stacking -- left
      // out deliberately, because this bench plays one layer and applying the
      // correction without the layers would just make stacked instruments
      // quiet by exactly the factor the missing layers would restore.
      gain: velocityGain(96) * 2 * (instrument?.params[OUTPUT_PARAMS.level].x ?? 0.5),
      pan: 0.5,
      startFrame: Math.round(atSeconds * context.sampleRate),
      // The samples loop, so a voice never ends on its own -- it has to be
      // released. Without this, low notes ring on and high notes cut off with
      // the sample rather than with the note.
      // With the instrument's own ADSR the end frame is the GATE, not the end:
      // the release runs on past it. Without it, the old stand-ins apply -- a
      // fixed 0.12 s linear fade and the diagnostic decay slider.
      endFrame: Math.round(
        (atSeconds + held + (adsr ? 0 : 0.12)) * context.sampleRate,
      ),
      release: adsr ? 0 : Math.round(0.12 * context.sampleRate),
      decayDbPerSecond: adsr ? 0 : Number(($('decay') as HTMLInputElement).value),
      envelope: adsr,
      filter,
      lfos,
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

/** Light the on-screen key so the mapping is visible while playing. */
function flashKey(note: number): void {
  const el = [...document.querySelectorAll<HTMLElement>('#keys .key')]
    .find((k) => k.textContent === noteName(note));
  if (!el) return;
  el.classList.add('lit');
  setTimeout(() => el.classList.remove('lit'), 140);
}

function bindKeyboard(): void {
  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

    if (event.code === 'ArrowLeft' || event.code === 'ArrowDown') {
      octaveBase = Math.max(0, octaveBase - 12);
      $('octave').textContent = `octave: ${noteName(octaveBase)}`;
      event.preventDefault();
      return;
    }
    if (event.code === 'ArrowRight' || event.code === 'ArrowUp') {
      octaveBase = Math.min(108, octaveBase + 12);
      $('octave').textContent = `octave: ${noteName(octaveBase)}`;
      event.preventDefault();
      return;
    }

    const offset = KEY_MAP[event.code];
    if (offset === undefined) return;
    event.preventDefault();
    // Key repeat would retrigger the note dozens of times a second.
    if (event.repeat || heldKeys.has(event.code)) return;
    heldKeys.add(event.code);

    const note = octaveBase + offset;
    if (note < 0 || note > 127) return;
    playNote(note);
    flashKey(note);
    $('detail').textContent = describe(note);
  });

  window.addEventListener('keyup', (event) => heldKeys.delete(event.code));
  // A dropped keyup (alt-tab mid-note) would otherwise wedge the key.
  window.addEventListener('blur', () => heldKeys.clear());
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
  bindKeyboard();
  $<HTMLSelectElement>('engine').addEventListener('change', (e) => {
    engine = (e.target as HTMLSelectElement).value as 'ours' | 'browser';
    log(`engine: ${engine}`);
  });
  $<HTMLSelectElement>('interp').addEventListener('change', (e) => {
    const name = (e.target as HTMLSelectElement).value;
    node?.port.postMessage({ type: 'interpolator', name });
    log(
      name === 'engine'
        ? "sampler: the game's — linear, with the /2 and /4 copies above rate 2 and 4"
        : `sampler: ${name} over the full-rate sample (not what the game does)`,
    );
  });
  const decay = $<HTMLInputElement>('decay');
  const showDecay = () => {
    const v = Number(decay.value);
    $('decayLabel').textContent = v === 0 ? 'off (faithful)' : `${v} dB/s (ours)`;
  };
  decay.addEventListener('input', showDecay);
  showDecay();

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
