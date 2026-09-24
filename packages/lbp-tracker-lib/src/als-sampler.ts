/**
 * An LBP instrument as Live's Sampler: the `.rinst`'s zones, samples, loops,
 * envelopes, filter and level, for a track of the `.als` export.
 *
 * ❗ **What this can be is measured, and so is where it stops.** Every member
 * below is written as Live 11.3 writes it -- the Sampler and its Shaper are
 * trees read out of Live's own Core Library (`SAMPLER`, `SHAPER`, generated,
 * never typed) -- and every number that says what a Live value means was read
 * off Live itself, a debug set opened and its device panel captured
 * (`steering/ableton-interchange.md`, *The instruments*).
 *
 * | the engine | the Sampler |
 * |---|---|
 * | a slot and its key zone (`resolveSlot`) | a zone, shifted by the track's `Key`: the engine picks the zone off the raw note, Live off the key it is given, which already carries `Key` |
 * | the slot's root and fine tune | `RootKey` and `Detune`: the ratio is `2^((note − root + fine)/12)` |
 * | an unpitched slot, which plays at one rate | one zone per key, each its own root |
 * | `fitBpm`, `tempo / baseBpm` | in `Detune`: the tempo is the song's, fixed |
 * | the sample, played frame for frame at 48 kHz whatever its header says | a WAV written with a 48 kHz header, the frames verbatim (`samplerSampleFile`) |
 * | the loop, `[dwStart, dwEnd + 1)` as the game's loader reads it | the sustain loop, forward, no crossfade |
 * | the amplitude ADSR, linear, a stage time `param² × 4 s` | Live's, with linear slopes and the times the engine's rates give |
 * | the Moog ladder's cutoff, resonance, key tracking and envelope | Live's filter, low-pass, set to the same corners |
 * | `Params[24]`, the output level, ×2 | the Sampler's volume |
 * | `Params[26]`, the drive | the Shaper |
 * | the note's level and its ramp | per-note pressure, every note's (`als.ts`), through the Pressure row to Volume |
 *
 * ⚠️ **The modulation is fixed per track.** Every `Params` range is evaluated
 * at the modulation the track's notes use most -- 95.6% of the corpus's notes
 * use their part's -- because Live's Sampler routes a per-note source to two
 * destinations and an LBP instrument moves seven with it, twenty on the ray
 * gun. The notes at another value are counted, not bent.
 *
 * Not here: the unison stack, the three LFOs, the mip levels and the ladder's
 * own saturation. Each is either absent from the Sampler or would be set with
 * a unit nobody has measured; the steering says which.
 */

import { emitDevice, Ids, v, type DeviceNode } from './als-xml.ts';
import { ADSR_PARAMS, ADSR_PARAMS_B, evaluateAdsr, evaluateParam, type Adsr } from './envelope.ts';
import { FILTER_PARAMS } from './audio/moog.ts';
import { zoneCount } from './instrument.ts';
import { OUTPUT_PARAMS } from './params.ts';
import { usedSlots, type RInstrument } from './rinstrument.ts';
import { loopRegion, readWav } from './wav.ts';

/** An instrument and the sample files it plays, as the caller fetched them. */
export interface AlsInstrumentSource {
  readonly instrument: RInstrument;
  /** Sample GUID to its `.smp` file: the name it had and its bytes. */
  readonly samples: ReadonlyMap<number, { readonly name: string; readonly bytes: Uint8Array }>;
}

/** A sample as the set holds it: a WAV in the project's `Samples/Imported`. */
export interface SamplerSample {
  /** The file's name, `piano_c4.wav`. */
  readonly file: string;
  readonly frames: number;
  /** The engine's loop region, `[start, end)`, when the sample has one. */
  readonly loop?: { readonly start: number; readonly end: number };
  /** The WAV itself: the `.smp`'s frames, verbatim, under a 48 kHz header. */
  readonly wav: Uint8Array;
}

/** The rate the engine plays every sample's frames at, whatever the file says. */
const ENGINE_RATE = 48000;

/**
 * An `.smp` as a WAV Live plays exactly as the engine does.
 *
 * ❗ **The engine never reads the sample rate** (`steering/synth-engine.md`,
 * *The loader*): a frame is a frame at 48 kHz, and the 42 samples recorded at
 * 44.1 kHz play 8.8% fast in the game. Writing every file with a 48 kHz header
 * and the frames untouched gives Live the same frames at the same rate, with
 * nothing to correct in the zones. Only `fmt ` and `data` are kept; the loop is
 * the Sampler's own member, not the `smpl` chunk.
 */
export function samplerSampleFile(name: string, bytes: Uint8Array): SamplerSample {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  let channels = 1;
  let data: Uint8Array | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === 'fmt ') channels = view.getUint16(at + 10, true);
    if (tag(at) === 'data') data = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
    at += 8 + size + (size & 1);
  }
  if (data === undefined) throw new Error(`${name}: no data chunk`);
  const wav = new Uint8Array(44 + data.length);
  const out = new DataView(wav.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) wav[at + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  out.setUint32(4, 36 + data.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, channels, true);
  out.setUint32(24, ENGINE_RATE, true);
  out.setUint32(28, ENGINE_RATE * channels * 2, true);
  out.setUint16(32, channels * 2, true);
  out.setUint16(34, 16, true);
  ascii(36, 'data');
  out.setUint32(40, data.length, true);
  wav.set(data, 44);

  const read = readWav(bytes);
  const frames = read.channels[0].length;
  const region = read.loop ? loopRegion(read.loop, frames) : undefined;
  return {
    file: name.replace(/\.smp$/i, '') + '.wav',
    frames,
    loop: region !== undefined && region.end > region.start ? region : undefined,
    wav,
  };
}

/** What the track decides for the instrument it holds. */
export interface SamplerSettings {
  /** The modulation, 0..1, every `Params` range is read at. */
  readonly modulation: number;
  /** `Key`'s transposition in semitones, which the zones move by. */
  readonly keyShift: number;
  /** The song's tempo, for a slot with `fitBpm`. */
  readonly tempo: number;
  /** The name the device shows. */
  readonly name: string;
}

/** One zone: which keys it answers, what it plays and at what pitch. */
export interface SamplerZone {
  readonly sample: SamplerSample;
  readonly lo: number;
  readonly hi: number;
  readonly root: number;
  /** Cents. */
  readonly detune: number;
}

/**
 * The zones the engine's walk makes of an instrument, as Live's key ranges.
 *
 * `resolveSlot`'s rule run backwards: zone `z` answers the raw notes from
 * `splitNotes[z + 1]` (0 for the last) up to `splitNotes[z] − 1` (127 for the
 * first), its sample is the `z`-th slot that has one -- the renderer's
 * compacted list -- and its root, tuning and flags are slot `z`'s.
 */
export function samplerZones(
  instrument: RInstrument,
  sample: (guid: number) => SamplerSample | undefined,
  keyShift: number,
  tempo: number,
): SamplerZone[] {
  const used = usedSlots(instrument)
    .map((u) => ({ ...u, sample: sample(u.guid) }))
    .filter((u): u is typeof u & { sample: SamplerSample } => u.sample !== undefined);
  if (used.length === 0) return [];
  const splits = instrument.splitNotes;
  const usable = Math.max(1, Math.min(used.length, splits.length, zoneCount(instrument)));
  const zones: SamplerZone[] = [];
  const clampKey = (k: number) => Math.min(127, Math.max(0, k));
  for (let z = 0; z < usable; z += 1) {
    const lo = z + 1 < usable ? splits[z + 1] : 0;
    const hi = z === 0 ? 127 : splits[z] - 1;
    if (lo > hi) continue;
    const played = used[Math.min(z, used.length - 1)];
    const slot = instrument.slots[Math.min(z, instrument.slots.length - 1)];
    // `2^((note − base + fine)/12) × tempo/baseBpm`, as a root and cents.
    const cents = 100 * slot.fineTune + (slot.fitBpm ? 1200 * Math.log2(tempo / slot.baseBpm) : 0);
    const whole = Math.round(cents / 100);
    const detune = cents - 100 * whole;
    const from = clampKey(lo + keyShift);
    const to = clampKey(hi + keyShift);
    if (slot.pitched) {
      zones.push({ sample: played.sample, lo: from, hi: to, root: clampKey(slot.baseNote - whole), detune });
    } else {
      // ❗ An unpitched slot plays every note at the same rate, and a Sampler
      // zone transposes: one zone per key, each its own root, is the same.
      for (let key = from; key <= to; key += 1) {
        zones.push({ sample: played.sample, lo: key, hi: key, root: clampKey(key - whole), detune });
      }
    }
  }
  return zones;
}

/** A zone as Live writes a `MultiSamplePart` -- the member list of a part Live saved. */
function zoneXml(zone: SamplerZone, id: number): string {
  const s = zone.sample;
  const loop = s.loop;
  const range = (tag: string, min: number, max: number) =>
    [`<${tag}>`, v('Min', min), v('Max', max), v('CrossfadeMin', min), v('CrossfadeMax', max), `</${tag}>`].join('\n');
  return [
    `<MultiSamplePart Id="${id}" HasImportedSlicePoints="false" NeedsAnalysisData="false">`,
    v('LomId', 0), v('Name', s.file), v('Selection', id === 0), v('IsActive', true), v('Solo', false),
    range('KeyRange', zone.lo, zone.hi), range('VelocityRange', 1, 127), range('SelectorRange', 0, 127),
    v('RootKey', zone.root), v('Detune', Math.round(zone.detune)), v('TuneScale', 100), v('Panorama', 0),
    v('Volume', 1), v('Link', false), v('SampleStart', 0), v('SampleEnd', s.frames),
    // Mode 1 is the forward loop and 0 none; 3 switches the release loop off.
    // Read off Live's Sample tab: `steering/ableton-interchange.md`.
    '<SustainLoop>', v('Start', loop?.start ?? 0), v('End', loop?.end ?? s.frames), v('Mode', loop ? 1 : 0),
    v('Crossfade', 0), v('Detune', 0), '</SustainLoop>',
    '<ReleaseLoop>', v('Start', 0), v('End', s.frames), v('Mode', 3), v('Crossfade', 0), v('Detune', 0), '</ReleaseLoop>',
    '<SampleRef>', '<FileRef>',
    // ❗ 3 is "inside the current project": Live finds the file by the relative
    // path when the project folder has `Ableton Project Info` in it. Measured.
    v('RelativePathType', 3), v('RelativePath', `Samples/Imported/${s.file}`), v('Path', `Samples/Imported/${s.file}`),
    v('Type', 1), v('LivePackName', ''), v('LivePackId', ''), v('OriginalFileSize', s.wav.length), v('OriginalCrc', 0),
    '</FileRef>', v('LastModDate', 0), '<SourceContext />', v('SampleUsageHint', 0),
    v('DefaultDuration', s.frames), v('DefaultSampleRate', ENGINE_RATE), '</SampleRef>',
    v('SlicingThreshold', 100), v('SlicingBeatGrid', 4), v('SlicingRegions', 8), v('SlicingStyle', 0),
    '<SampleWarpProperties>', '<WarpMarkers>',
    '<WarpMarker Id="0" SecTime="0" BeatTime="0" />', '<WarpMarker Id="1" SecTime="0.0156250004415619675" BeatTime="0.03125" />',
    '</WarpMarkers>', v('WarpMode', 0), v('GranularityTones', 30), v('GranularityTexture', 65),
    v('FluctuationTexture', 25), v('ComplexProFormants', 100), v('ComplexProEnvelope', 128),
    v('TransientResolution', 6), v('TransientLoopMode', 2), v('TransientEnvelope', 100), v('IsWarped', false),
    '<Onsets>', '<UserOnsets />', v('HasUserOnsets', false), '</Onsets>',
    '<TimeSignature>', '<TimeSignatures>', '<RemoteableTimeSignature Id="0">', v('Numerator', 4), v('Denominator', 4),
    v('Time', 0), '</RemoteableTimeSignature>', '</TimeSignatures>', '</TimeSignature>',
    '<BeatGrid>', v('FixedNumerator', 1), v('FixedDenominator', 16), v('GridIntervalPixel', 20), v('Ntoles', 2),
    v('SnapToGrid', true), v('Fixed', false), '</BeatGrid>',
    '</SampleWarpProperties>',
    '<SlicePoints />', '<ManualSlicePoints />', '<BeatSlicePoints />', '<RegionSlicePoints />',
    v('UseDynamicBeatSlices', true), v('UseDynamicRegionSlices', true),
    '</MultiSamplePart>',
  ].join('\n');
}

/** Milliseconds, inside the range a Sampler envelope takes. */
const ms = (seconds: number, floor: number) => Math.min(60000, Math.max(floor, seconds * 1000));

/**
 * The engine's ADSR as a Live envelope's segment times.
 *
 * ❗ **The engine's stages are rates, Live's are durations.** The engine climbs
 * 0 → 1 in `attack`, falls at `1/decay` a second until it reaches the sustain,
 * and after the gate falls at `1/release` from wherever it is (`envelope.ts`).
 * So the decay lasts `decay × (1 − sustain)`, and the release `release ×` the
 * level it starts from -- the sustain when the note was held that long, which
 * is what this writes; a note let go during its decay releases for less in
 * the game than here. Every slope is 0: the engine's stages are straight lines.
 */
function envelopeSet(prefix: string, adsr: Adsr, floor: number): Record<string, number> {
  return {
    [`${prefix}.AttackTime`]: ms(adsr.attack, 0.1),
    [`${prefix}.AttackSlope`]: 0,
    [`${prefix}.DecayTime`]: ms(adsr.decay * (1 - adsr.sustain), 1),
    [`${prefix}.DecaySlope`]: 0,
    [`${prefix}.SustainLevel`]: Math.min(1, Math.max(floor, adsr.sustain)),
    [`${prefix}.ReleaseTime`]: ms(adsr.release * (adsr.sustain > 0 ? adsr.sustain : 1), 1),
    [`${prefix}.ReleaseSlope`]: 0,
  };
}

/**
 * An instrument as a Sampler device, for a track's device chain.
 *
 * `sample` hands back the prepared WAV for a sample GUID; the zones name
 * their files by it, so the caller writes the same files into the project.
 */
export function samplerDevice(
  ids: Ids,
  instrument: RInstrument,
  sample: (guid: number) => SamplerSample | undefined,
  settings: SamplerSettings,
): string {
  const P = (index: number) => evaluateParam(instrument.params[index] ?? { x: 0, y: 0 }, settings.modulation);
  const zones = samplerZones(instrument, sample, settings.keyShift, settings.tempo);

  // The filter, the ladder's own terms put where Live keeps them. The cutoff
  // is a fraction of Nyquist at the engine's 48 kHz; the envelope multiplies
  // it by `1 + amount · (env − 1)`, so the cutoff at rest is `cutoff × (1 −
  // amount)` and the envelope's full swing is that ratio in semitones.
  // ❗ Past Live's 72 semitones the peak is kept and the rest rises: kept at
  // the rest, concertina's amount of 1 would peak at 6 % of its cutoff.
  const cutoff = P(FILTER_PARAMS.cutoff) ** 2;
  const amount = P(FILTER_PARAMS.envAmount);
  const swing = Math.min(72, Math.max(-72, 12 * Math.log2(1 / Math.max(0.001, 1 - amount))));
  const resting = cutoff / 2 ** (swing / 12);
  const bypassed = cutoff >= 0.99 && amount <= 0;
  const filter = 'Filter.Slot.Value.SimplerFilter';
  const drive = Math.min(1, Math.max(0, P(OUTPUT_PARAMS.drive)));
  // `Params[24]` enters the gain with a factor of 2 (`synth-engine.md`).
  const level = 2 * P(OUTPUT_PARAMS.level);

  return emitDevice(ids, ['c', 'MultiSampler', { Id: '0' }, SAMPLER_MEMBERS], {
    LastPresetRef: { xml: '<Value />' },
    SourceContext: { xml: '<Value />' },
    UserName: settings.name,
    ShouldShowPresetName: false,
    'Player.MultiSampleMap.SampleParts': { xml: zones.map(zoneXml).join('\n') },
    // ❗ **32 voices, and a repeated key does not cut the one before.** The
    // engine's pool is 32 (`synth-engine.md`) and it gives two notes of one key
    // a voice each. `NumVoices` is an index, read off Live: 5 shows 6 voices,
    // 13 shows 24 and 14 shows 32. The default 6 would have cut every chord
    // denser than that; the default retrigger, every overlap.
    'Globals.NumVoices': 14,
    'Globals.RetriggerMode': false,
    'VolumeAndPan.Volume': level > 0 ? 20 * Math.log10(level) : -36,
    'VolumeAndPan.VolumeVelScale': 1,
    ...envelopeSet('VolumeAndPan.Envelope', evaluateAdsr(instrument.params, ADSR_PARAMS, settings.modulation), 0.0003162277571),
    'Filter.IsOn': !bypassed,
    [`${filter}.Freq`]: resting * (ENGINE_RATE / 2),
    [`${filter}.Res`]: P(FILTER_PARAMS.resonance),
    [`${filter}.ModByPitch`]: Math.min(1, Math.max(0, P(FILTER_PARAMS.keyTrack))),
    [`${filter}.Envelope.IsOn`]: amount !== 0,
    [`${filter}.Envelope.Amount`]: swing,
    [`${filter}.Envelope.DecayLevel`]: 1,
    [`${filter}.Envelope.AttackLevel`]: 0,
    [`${filter}.Envelope.ReleaseLevel`]: 0,
    ...envelopeSet(`${filter}.Envelope`, evaluateAdsr(instrument.params, ADSR_PARAMS_B, settings.modulation), 0),
    'Shaper.IsOn': drive > 0,
    'Shaper.Slot.Value': drive > 0 ? { xml: emitDevice(ids, SHAPER, { Amount: drive * 100 }) } : { xml: '' },
    // The note's level and its ramp ride on per-note pressure (`als.ts`); the
    // Pressure row is `MidiCtrl.0` and Volume is destination 18, both read off
    // Live's MIDI tab. ❗ At 100 a note with no pressure is silent, so every
    // note the set holds carries some.
    'MidiCtrl.0.ModConnections.0.Amount': 100,
    'MidiCtrl.0.ModConnections.0.Connection': 18,
  });
}

/* ---------------------------------------------------------------- the trees */
// Generated from Live 11.3's own files -- see the header of als-sampler.ts.

/** Live's default Sampler, `Core Library/Defaults/Instruments/Sampler.adv`. */
const SAMPLER: DeviceNode =
['c', 'MultiSampler', {}, [
  ['v', 'LomId', 0],
  ['v', 'LomIdView', 0],
  ['v', 'IsExpanded', true],
  ['b', 'On', true],
  ['v', 'ModulationSourceCount', 0],
  ['x', 'ParametersListWrapper', {'LomId':'0'}],
  ['x', 'Pointee', {'Id':'0'}],
  ['v', 'LastSelectedTimeableIndex', 0],
  ['v', 'LastSelectedClipEnvelopeIndex', 0],
  ['c', 'LastPresetRef', {}, [
    ['c', 'Value', {}, [
      ['c', 'FilePresetRef', {'Id':'0'}, [
        ['c', 'FileRef', {}, [
          ['v', 'RelativePathType', 5],
          ['v', 'RelativePath', 'Defaults/Instruments/Sampler.adv'],
          ['v', 'Path', '/Volumes/data/tmp/trunk/Core Library/Defaults/Instruments/Sampler.adv'],
          ['v', 'Type', 2],
          ['v', 'LivePackName', 'Core Library'],
          ['v', 'LivePackId', 'www.ableton.com/0'],
          ['v', 'OriginalFileSize', 0],
          ['v', 'OriginalCrc', 0],
        ]],
      ]],
    ]],
  ]],
  ['x', 'LockedScripts', {}],
  ['v', 'IsFolded', false],
  ['v', 'ShouldShowPresetName', true],
  ['v', 'UserName', ''],
  ['v', 'Annotation', ''],
  ['c', 'SourceContext', {}, [
    ['x', 'Value', {}],
  ]],
  ['v', 'OverwriteProtectionNumber', 2820],
  ['c', 'Player', {}, [
    ['c', 'MultiSampleMap', {}, [
      ['x', 'SampleParts', {}],
      ['v', 'LoadInRam', false],
      ['v', 'LayerCrossfade', 0],
      ['x', 'SourceContext', {}],
    ]],
    ['c', 'LoopModulators', {}, [
      ['v', 'IsModulated', false],
      ['f', 'SampleStart', 0, 0, 1],
      ['f', 'SampleLength', 1, 0, 1],
      ['b', 'LoopOn', false],
      ['f', 'LoopLength', 1, 0, 1],
      ['f', 'LoopFade', 0, 0, 1],
    ]],
    ['b', 'Reverse', false],
    ['b', 'Snap', false],
    ['f', 'SampleSelector', 0, 0, 127],
    ['c', 'SubOsc', {}, [
      ['b', 'IsOn', false],
      ['c', 'Slot', {}, [
        ['x', 'Value', {}],
      ]],
    ]],
    ['v', 'InterpolationMode', 1],
    ['v', 'UseConstPowCrossfade', true],
  ]],
  ['c', 'Pitch', {}, [
    ['f', 'TransposeKey', 0, -48, 48],
    ['f', 'TransposeFine', 0, -50, 50],
    ['f', 'PitchLfoAmount', 0, 0, 1],
    ['c', 'Envelope', {}, [
      ['b', 'IsOn', false],
      ['c', 'Slot', {}, [
        ['x', 'Value', {}],
      ]],
    ]],
    ['v', 'ScrollPosition', -1073741824],
  ]],
  ['c', 'Filter', {}, [
    ['b', 'IsOn', true],
    ['c', 'Slot', {}, [
      ['c', 'Value', {}, [
        ['c', 'SimplerFilter', {'Id':'0'}, [
          ['e', 'LegacyType', 0],
          ['e', 'Type', 0],
          ['e', 'CircuitLpHp', 0],
          ['e', 'CircuitBpNoMo', 0],
          ['b', 'Slope', true],
          ['f', 'Freq', 22000, 30, 22000],
          ['f', 'LegacyQ', 0.6999999881, 0.3000000119, 10],
          ['f', 'Res', 0.09090908617, 0, 1.25],
          ['f', 'X', 0, 0, 1],
          ['f', 'Drive', 0, 0, 24],
          ['c', 'Envelope', {}, [
            ['f', 'AttackTime', 0.1000000015, 0.1000000015, 20000],
            ['f', 'AttackLevel', 0, 0, 1],
            ['f', 'AttackSlope', 0, -1, 1],
            ['f', 'DecayTime', 600, 1, 60000],
            ['f', 'DecayLevel', 1, 0, 1],
            ['f', 'DecaySlope', 1, -1, 1],
            ['f', 'SustainLevel', 0, 0, 1],
            ['f', 'ReleaseTime', 50, 1, 60000],
            ['f', 'ReleaseLevel', 0, 0, 1],
            ['f', 'ReleaseSlope', 1, -1, 1],
            ['e', 'LoopMode', 0],
            ['f', 'LoopTime', 100, 0.200000003, 20000],
            ['f', 'RepeatTime', 3, 0, 14],
            ['f', 'TimeVelScale', 0, -100, 100],
            ['v', 'CurrentOverlay', 0],
            ['b', 'IsOn', true],
            ['f', 'Amount', 0, -72, 72],
            ['v', 'ScrollPosition', 0],
          ]],
          ['f', 'ModByPitch', 1, 0, 1],
          ['f', 'ModByVelocity', 0, 0, 1],
          ['f', 'ModByLfo', 0, 0, 24],
        ]],
      ]],
    ]],
  ]],
  ['c', 'Shaper', {}, [
    ['b', 'IsOn', false],
    ['c', 'Slot', {}, [
      ['x', 'Value', {}],
    ]],
  ]],
  ['c', 'VolumeAndPan', {}, [
    ['f', 'Volume', -12, -36, 36],
    ['f', 'VolumeVelScale', 0, 0, 1],
    ['f', 'VolumeKeyScale', 0, -1, 1],
    ['f', 'VolumeLfoAmount', 0, 0, 1],
    ['f', 'Panorama', 0, -1, 1],
    ['f', 'PanoramaKeyScale', 0, -1, 1],
    ['f', 'PanoramaRnd', 0, 0, 1],
    ['f', 'PanoramaLfoAmount', 0, 0, 1],
    ['c', 'Envelope', {}, [
      ['f', 'AttackTime', 0.1000000015, 0.1000000015, 20000],
      ['f', 'AttackLevel', 0.0003162277571, 0.0003162277571, 1],
      ['f', 'AttackSlope', 0, -1, 1],
      ['f', 'DecayTime', 600, 1, 60000],
      ['f', 'DecayLevel', 1, 0.0003162277571, 1],
      ['f', 'DecaySlope', 1, -1, 1],
      ['f', 'SustainLevel', 1, 0.0003162277571, 1],
      ['f', 'ReleaseTime', 50, 1, 60000],
      ['f', 'ReleaseLevel', 0.0003162277571, 0.0003162277571, 1],
      ['f', 'ReleaseSlope', 1, -1, 1],
      ['e', 'LoopMode', 0],
      ['f', 'LoopTime', 100, 0.200000003, 20000],
      ['f', 'RepeatTime', 3, 0, 14],
      ['f', 'TimeVelScale', 0, -100, 100],
      ['v', 'CurrentOverlay', 0],
    ]],
    ['c', 'OneShotEnvelope', {}, [
      ['f', 'FadeInTime', 0.1000000015, 0, 2000],
      ['e', 'SustainMode', 0],
      ['f', 'FadeOutTime', 0.1000000015, 0, 2000],
    ]],
  ]],
  ['c', 'AuxEnv', {}, [
    ['b', 'IsOn', false],
    ['c', 'Slot', {}, [
      ['x', 'Value', {}],
    ]],
  ]],
  ['c', 'Lfo', {}, [
    ['b', 'IsOn', false],
    ['c', 'Slot', {}, [
      ['x', 'Value', {}],
    ]],
  ]],
  ['c', 'AuxLfos.0', {}, [
    ['b', 'IsOn', false],
    ['c', 'Slot', {}, [
      ['x', 'Value', {}],
    ]],
  ]],
  ['c', 'AuxLfos.1', {}, [
    ['b', 'IsOn', false],
    ['c', 'Slot', {}, [
      ['x', 'Value', {}],
    ]],
  ]],
  ['c', 'KeyDst', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
  ]],
  ['c', 'VelDst', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
  ]],
  ['c', 'RelVelDst', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
  ]],
  ['c', 'MidiCtrl.0', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['v', 'Feedback', 0],
  ]],
  ['c', 'MidiCtrl.1', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['v', 'Feedback', 0],
  ]],
  ['c', 'MidiCtrl.2', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['v', 'Feedback', 0],
  ]],
  ['c', 'MidiCtrl.3', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['v', 'Feedback', 0],
  ]],
  ['c', 'MidiCtrl.4', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['v', 'Feedback', 0],
  ]],
  ['c', 'MidiCtrl.5', {}, [
    ['c', 'ModConnections.0', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['c', 'ModConnections.1', {}, [
      ['v', 'Amount', 0],
      ['v', 'Connection', 0],
    ]],
    ['v', 'Feedback', 0],
  ]],
  ['c', 'Globals', {}, [
    ['v', 'NumVoices', 5],
    ['v', 'NumVoicesEnvTimeControl', false],
    ['v', 'RetriggerMode', true],
    ['v', 'ModulationResolution', 2],
    ['f', 'SpreadAmount', 0, 0, 100],
    ['f', 'KeyZoneShift', 0, -48, 48],
    ['e', 'PortamentoMode', 0],
    ['f', 'PortamentoTime', 50, 0.1000000015, 10000],
    ['v', 'PitchBendRange', 5],
    ['v', 'MpePitchBendRange', 48],
    ['v', 'ScrollPosition', 0],
    ['c', 'EnvScale', {}, [
      ['f', 'EnvTime', 0, -100, 100],
      ['f', 'EnvTimeKeyScale', 0, -100, 100],
      ['b', 'EnvTimeIncludeAttack', true],
    ]],
    ['v', 'IsSimpler', false],
    ['v', 'PlaybackMode', 0],
    ['v', 'LegacyMode', false],
  ]],
  ['c', 'ViewSettings', {}, [
    ['v', 'SelectedPage', 0],
    ['v', 'ZoneEditorVisible', false],
    ['v', 'Seconds', false],
    ['v', 'SelectedSampleChannel', 0],
    ['v', 'VerticalSampleZoom', 1],
    ['v', 'IsAutoSelectEnabled', false],
    ['v', 'SimplerBreakoutVisible', false],
  ]],
  ['c', 'SimplerSlicing', {}, [
    ['v', 'PlaybackMode', 0],
  ]],
]];

/** Live's Shaper, from the Core Library's `Saw Filtered Bass` Sampler preset. */
const SHAPER: DeviceNode =
['c', 'SimplerShaper', {'Id':'0'}, [
  ['e', 'Type', 0],
  ['f', 'Amount', 67, 0, 100],
  ['b', 'Structure', false],
]];

/** The Sampler's members, without the root's own attributes. */
const SAMPLER_MEMBERS = SAMPLER[0] === 'c' ? SAMPLER[3] : [];
