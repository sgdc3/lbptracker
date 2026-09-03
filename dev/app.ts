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

/** A slider's raw value. */
const num = (id: string) => Number(($(id) as HTMLInputElement).value);
/** A slider scaled to 0..1. */
const unit = (id: string) => num(id) / 100;
const ticked = (id: string) => ($(id) as HTMLInputElement).checked;

/**
 * The live overrides, read at note-on.
 *
 * ⚠️ **Off by default, and that is the point.** Unticked, every group falls
 * through to the instrument's own measured parameters, so the bench still plays
 * the game. The sliders are for asking "what does this knob do", not for
 * inventing a patch and mistaking it for the engine.
 */
const overrideAdsr = () =>
  ticked('ovEnv')
    ? {
        attack: num('envA') / 100,
        decay: num('envD') / 100,
        sustain: unit('envS'),
        release: num('envR') / 100,
      }
    : undefined;

const overrideFilter = () =>
  ticked('ovFilter')
    ? {
        settings: {
          cutoff: unit('filCut'),
          resonance: unit('filRes'),
          keyTrack: num('filTrack') / 100,
          envAmount: num('filEnv') / 100,
        },
        envelope: { attack: 0, decay: 0.3, sustain: 1, release: 0.2 },
      }
    : undefined;

const overrideLfos = () =>
  ticked('ovLfo')
    ? ([0, 1, 2].map((i) => ({
        rate: num(`lfo${i + 1}r`) / 10,
        depth: unit(`lfo${i + 1}d`),
        spread: 0,
      })) as unknown as ReturnType<typeof currentLfos>)
    : undefined;

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

/**
 * A note that lasts until it is let go.
 *
 * The sequencer never needs this -- every note it writes already knows its own
 * length -- so the gate is left open (no `endFrame`) and `Mixer.release` closes
 * it when the key, the mouse or the MIDI note comes up. One tag per sounding
 * note; retriggering the same note releases the old one first, which is what a
 * keyboard does and what stops a stuck key ringing forever.
 */
let nextTag = 1;
const sounding = new Map<number, number>();

function noteOn(note: number, velocity = 96): void {
  const v = voiceFor(note);
  if (!v || !node || !context) return;
  // The browser-resampler control has no note-off; it stays timed, and says so.
  if (engine === 'browser') {
    playNote(note);
    return;
  }
  noteOff(note);
  const tag = nextTag++;
  sounding.set(note, tag);
  const adsr = overrideAdsr() ?? currentAdsr();
  node.port.postMessage({
    type: 'play',
    sampleId: `slot${v.zone}`,
    voice: {
      playbackRate: v.playbackRate,
      gain:
        velocityGain(velocity) * 2 * (instrument?.params[OUTPUT_PARAMS.level].x ?? 0.5),
      pan: unit('pPan'),
      drive: unit('pDrive'),
      echoSend: unit('echoSend'),
      reverbSend: unit('reverbSend'),
      // No `endFrame`: the gate stays open until `release` closes it.
      release: adsr ? 0 : Math.round(0.12 * context.sampleRate),
      decayDbPerSecond: adsr ? 0 : num('decay'),
      envelope: adsr,
      filter: overrideFilter() ?? currentFilter(),
      lfos: overrideLfos() ?? currentLfos(),
      tag,
    },
  });
  setKeyDown(note, true);
  $('detail').textContent = describe(note);
}

function noteOff(note: number): void {
  const tag = sounding.get(note);
  if (tag === undefined) return;
  sounding.delete(note);
  node?.port.postMessage({ type: 'release', tag });
  setKeyDown(note, false);
}

/** Let go of everything, for Escape and for a lost focus. */
function panic(): void {
  for (const note of [...sounding.keys()]) noteOff(note);
  node?.port.postMessage({ type: 'stopAll' });
}

/**
 * Push the whole output stage to the worklet.
 *
 * Rebuilding an effect drops its tail, so this is called when a control moves
 * and not per note.
 */
function pushEffects(): void {
  const framesPerStep = ((60 / num('tempo')) / 4) * (context?.sampleRate ?? 48000);
  node?.port.postMessage({
    type: 'effects',
    echoTime: num('echoTime') / 10,
    framesPerStep,
    feedback: unit('echoFb'),
    mix: unit('echoMix'),
    reverbSetting: num('reverbSet'),
    echoOn: unit('echoSend') > 0,
    reverbOn: unit('reverbSend') > 0,
    clip: ticked('optClip'),
  });
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

/**
 * Which computer key plays a note, inverted from KEY_MAP for the caps.
 *
 * ⚠️ A `KeyboardEvent.code` is a name, not a character: `Comma`, `Period` and
 * `Slash` are three of the twenty-five keys in the map, and printing the code
 * verbatim put whole words across the keys they label.
 */
const CODE_GLYPH: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=',
  Backquote: '`',
};

function capsFor(note: number): string {
  const offset = note - octaveBase;
  for (const [code, value] of Object.entries(KEY_MAP)) {
    if (value !== offset) continue;
    return CODE_GLYPH[code] ?? code.replace(/^(Key|Digit)/, '');
  }
  return '';
}

/**
 * A real piano: white keys in a row, black keys overlaid between them.
 *
 * ⚠️ The black key's position cannot be derived from a count of naturals
 * alone -- there is no black key between E/F or B/C -- so each one is placed at
 * the boundary of the white key it follows. The offsets below are that
 * boundary, in white-key widths.
 */
const PIANO_LOW = 24; // C1
const PIANO_HIGH = 96; // C7
const BLACK_AFTER = new Set([0, 2, 5, 7, 9]); // C D F G A

function buildKeyboard(): void {
  const piano = $('piano');
  piano.textContent = '';
  const whites: number[] = [];
  for (let note = PIANO_LOW; note <= PIANO_HIGH; note += 1) {
    if (!NOTE_NAMES[note % 12].includes('#')) whites.push(note);
  }
  const width = 100 / whites.length;

  whites.forEach((note, index) => {
    const key = document.createElement('div');
    key.className = 'wkey';
    key.dataset.note = String(note);
    key.title = describe(note);
    const v = voiceFor(note);
    const zone = document.createElement('div');
    zone.className = 'zone';
    if (v) zone.style.background = zoneColour(v.zone);
    const caps = document.createElement('div');
    caps.className = 'caps';
    caps.textContent = capsFor(note);
    const label = document.createElement('div');
    label.className = 'lbl';
    label.textContent = note % 12 === 0 ? noteName(note) : '';
    key.append(zone, caps, label);
    piano.append(key);

    // The sharp above this white key, if the pair has one.
    if (BLACK_AFTER.has(note % 12) && note + 1 <= PIANO_HIGH) {
      const sharp = note + 1;
      const black = document.createElement('div');
      black.className = 'bkey';
      black.dataset.note = String(sharp);
      black.title = describe(sharp);
      black.style.left = `${(index + 1) * width}%`;
      black.style.width = `${width * 0.62}%`;
      black.style.marginLeft = `${-width * 0.31}%`;
      const bz = document.createElement('div');
      bz.className = 'zone';
      const bv = voiceFor(sharp);
      if (bv) bz.style.background = zoneColour(bv.zone);
      const bc = document.createElement('div');
      bc.className = 'caps';
      bc.textContent = capsFor(sharp);
      black.append(bz, bc);
      piano.append(black);
    }
  });
}

/** Pointer play: press, glide across keys, release anywhere. */
function bindPiano(): void {
  const piano = $('piano');
  let gliding = false;
  let last = -1;
  const noteAt = (target: EventTarget | null): number => {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>('[data-note]');
    return el ? Number(el.dataset.note) : -1;
  };
  piano.addEventListener('pointerdown', (event) => {
    const note = noteAt(event.target);
    if (note < 0) return;
    gliding = true;
    last = note;
    piano.setPointerCapture(event.pointerId);
    noteOn(note);
    event.preventDefault();
  });
  piano.addEventListener('pointermove', (event) => {
    if (!gliding) return;
    // `elementFromPoint`, because the capture sends every move to the piano.
    const note = noteAt(document.elementFromPoint(event.clientX, event.clientY));
    if (note < 0 || note === last) return;
    noteOff(last);
    last = note;
    noteOn(note);
  });
  const up = () => {
    if (!gliding) return;
    gliding = false;
    noteOff(last);
    last = -1;
  };
  piano.addEventListener('pointerup', up);
  piano.addEventListener('pointercancel', up);
}

function zoneColour(zone: number): string {
  const hues = [150, 200, 265, 320, 20, 45, 90, 175];
  return `hsl(${hues[zone % hues.length]} 60% 55%)`;
}

/** Light the on-screen key, so the mapping is visible while playing. */
function setKeyDown(note: number, down: boolean): void {
  const el = document.querySelector<HTMLElement>(`#piano [data-note="${note}"]`);
  el?.classList.toggle('down', down);
}

/** A flash for the timed bench buttons, which have no key-up to wait for. */
function flashKey(note: number): void {
  setKeyDown(note, true);
  setTimeout(() => setKeyDown(note, false), 140);
}

/** Octave changed: let go of everything and redraw the key caps. */
function shiftedOctave(): void {
  panic();
  $('octave').textContent = `octave: ${noteName(octaveBase)}`;
  for (const el of document.querySelectorAll<HTMLElement>('#piano [data-note]')) {
    const caps = el.querySelector('.caps');
    if (caps) caps.textContent = capsFor(Number(el.dataset.note));
  }
}

/**
 * Web MIDI, when the browser has it and the user allows it.
 *
 * ⚠️ `requestMIDIAccess` prompts, so it is asked for only when a device is
 * chosen -- opening the page must not put a permission dialog in the way of the
 * mouse and the computer keyboard, which need no permission at all.
 */
let midiAccess: MIDIAccess | null = null;

async function enableMidi(): Promise<void> {
  const state = $('midiState');
  if (typeof navigator.requestMIDIAccess !== 'function') {
    state.textContent = 'not supported by this browser';
    return;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
  } catch (error) {
    state.textContent = `refused: ${(error as Error).message}`;
    state.classList.remove('on');
    return;
  }
  const select = $<HTMLSelectElement>('midiIn');
  const listed = [...(midiAccess?.inputs.values() ?? [])];
  select.innerHTML = '<option value="">none</option>';
  for (const input of listed) {
    const option = document.createElement('option');
    option.value = input.id;
    option.textContent = input.name;
    select.append(option);
  }
  state.textContent = listed.length
    ? `${listed.length} input${listed.length === 1 ? '' : 's'} — pick one`
    : 'no inputs found';
  state.classList.toggle('on', listed.length > 0);
  if (listed.length === 1) {
    select.value = listed[0].id;
    listenTo(listed[0].id);
  }
}

function listenTo(id: string): void {
  for (const input of midiAccess?.inputs.values() ?? []) {
    input.onmidimessage = null;
  }
  const port = [...(midiAccess?.inputs.values() ?? [])].find((p) => p.id === id);
  const state = $('midiState');
  if (!port) {
    state.textContent = 'no input selected';
    state.classList.remove('on');
    return;
  }
  port.onmidimessage = (event) => {
    const [status, a, b] = event.data ?? [];
    if (status === undefined) return;
    const kind = status & 0xf0;
    // 0x90 with velocity 0 is a note-off; every controller sends it that way.
    if (kind === 0x90 && b > 0) noteOn(a, b);
    else if (kind === 0x80 || (kind === 0x90 && b === 0)) noteOff(a);
    else if (kind === 0xb0 && (a === 120 || a === 123)) panic();
  };
  state.textContent = `listening to ${port.name}`;
  state.classList.add('on');
}

function bindKeyboard(): void {
  window.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

    if (event.code === 'Escape') {
      panic();
      event.preventDefault();
      return;
    }
    if (event.code === 'ArrowLeft' || event.code === 'ArrowDown') {
      octaveBase = Math.max(0, octaveBase - 12);
      shiftedOctave();
      event.preventDefault();
      return;
    }
    if (event.code === 'ArrowRight' || event.code === 'ArrowUp') {
      octaveBase = Math.min(108, octaveBase + 12);
      shiftedOctave();
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
    noteOn(note);
  });

  window.addEventListener('keyup', (event) => {
    if (!heldKeys.delete(event.code)) return;
    const offset = KEY_MAP[event.code];
    if (offset !== undefined) noteOff(octaveBase + offset);
  });
  // A dropped keyup (alt-tab mid-note) would otherwise wedge the key -- and now
  // that a note lasts as long as its key is held, a wedged key rings forever.
  window.addEventListener('blur', () => {
    heldKeys.clear();
    panic();
  });
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

  bindPiano();

  // Every remaining slider is label + value, so they are declared rather than
  // wired one at a time. `effects` marks the ones that rebuild the output stage.
  const knobs: [string, (v: number) => string, boolean][] = [
    ['pPan', (v) => (v === 50 ? 'centre' : `${v < 50 ? 'L' : 'R'} ${Math.abs(v - 50) * 2}%`), false],
    ['pDrive', (v) => (v / 100).toFixed(2), false],
    ['envA', (v) => `${(v / 100).toFixed(2)}s`, false],
    ['envD', (v) => `${(v / 100).toFixed(2)}s`, false],
    ['envS', (v) => (v / 100).toFixed(2), false],
    ['envR', (v) => `${(v / 100).toFixed(2)}s`, false],
    ['filCut', (v) => (v / 100).toFixed(2), false],
    ['filRes', (v) => (v / 100).toFixed(2), false],
    ['filEnv', (v) => (v / 100).toFixed(2), false],
    ['filTrack', (v) => (v / 100).toFixed(2), false],
    ['lfo1r', (v) => `${(v / 10).toFixed(1)} Hz`, false],
    ['lfo1d', (v) => (v / 100).toFixed(2), false],
    ['lfo2r', (v) => `${(v / 10).toFixed(1)} Hz`, false],
    ['lfo2d', (v) => (v / 100).toFixed(2), false],
    ['lfo3r', (v) => `${(v / 10).toFixed(1)} Hz`, false],
    ['lfo3d', (v) => (v / 100).toFixed(2), false],
    ['echoSend', (v) => (v / 100).toFixed(2), true],
    ['echoTime', (v) => `${(v / 10).toFixed(2)} beats`, true],
    ['echoFb', (v) => (v / 100).toFixed(2), true],
    ['echoMix', (v) => (v / 100).toFixed(2), true],
    ['tempo', (v) => `${v} BPM`, true],
    ['reverbSend', (v) => (v / 100).toFixed(2), true],
    ['reverbSet', (v) => String(v), true],
  ];
  for (const [id, format, effects] of knobs) {
    const el = $<HTMLInputElement>(id);
    const show = () => {
      $(`${id}Label`).textContent = format(Number(el.value));
      if (effects) pushEffects();
    };
    el.addEventListener('input', show);
    show();
  }
  $('optClip').addEventListener('change', pushEffects);

  // A group greys out until it is overriding, so it is obvious at a glance
  // whether what you hear is the instrument's or yours.
  for (const [box, group] of [['ovEnv', 'gEnv'], ['ovFilter', 'gFilter'], ['ovLfo', 'gLfo']]) {
    const el = $<HTMLInputElement>(box);
    const show = () => $(group).classList.toggle('off', !el.checked);
    el.addEventListener('change', show);
    show();
  }

  const midiSelect = $<HTMLSelectElement>('midiIn');
  midiSelect.addEventListener('mousedown', () => {
    if (!midiAccess) void enableMidi();
  }, { once: true });
  midiSelect.addEventListener('change', () => listenTo(midiSelect.value));
}

void init();
