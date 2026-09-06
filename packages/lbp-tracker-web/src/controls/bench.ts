/**
 * The instrument bench's controls — the Keyboard view, `daw/keyboard-view.ts`.
 *
 * See `kit.ts` for what this table replaced and why the shape is what it is.
 * ⚠️ **`as const satisfies` narrows away the optional fields**: it is what makes
 * the ids a union, and it also narrows each row to exactly the keys it wrote, so
 * `fader.step` is an error on the rows that omit it. The arrays are therefore
 * declared once and exported widened — neither form manages both.
 */

import {
  createControls,
  type Check,
  type Fader,
  type Group,
  type Spec,
} from './kit.ts';

const twoDp = (v: number) => v.toFixed(2);
const seconds = (v: number) => `${v.toFixed(2)}s`;

const GROUP_SPECS = [
  { key: 'voice', title: 'voice' },
  { key: 'env', title: 'amplitude envelope', override: 'ovEnv' },
  { key: 'filter', title: 'ladder filter', override: 'ovFilter' },
  { key: 'lfo', title: 'LFOs', override: 'ovLfo' },
  { key: 'echo', title: 'echo' },
  {
    key: 'reverb',
    title: 'reverb & output',
    note:
      'The plugin hard-clips its own output to ±1 before the reverb send — the one ' +
      'nonlinearity in the output stage.',
  },
] as const satisfies readonly Group[];

const FADER_SPECS = [
  { id: 'gain', group: 'voice', label: 'master', min: 0, max: 100, start: 50,
    per: 100, format: twoDp },
  { id: 'pPan', group: 'voice', label: 'pan', min: 0, max: 100, start: 50, per: 100,
    format: (v) =>
      v === 0.5 ? 'centre' : `${v < 0.5 ? 'L' : 'R'} ${Math.round(Math.abs(v - 0.5) * 200)}%` },
  { id: 'pDrive', group: 'voice', label: 'drive', min: 0, max: 95, start: 0,
    per: 100, format: twoDp },

  { id: 'envA', group: 'env', label: 'attack', min: 0, max: 200, start: 0, per: 100,
    format: seconds },
  { id: 'envD', group: 'env', label: 'decay', min: 0, max: 300, start: 60, per: 100,
    format: seconds },
  { id: 'envS', group: 'env', label: 'sustain', min: 0, max: 100, start: 100, per: 100,
    format: twoDp },
  { id: 'envR', group: 'env', label: 'release', min: 0, max: 300, start: 20, per: 100,
    format: seconds },

  { id: 'filCut', group: 'filter', label: 'cutoff', min: 0, max: 100, start: 100,
    per: 100, format: twoDp },
  { id: 'filRes', group: 'filter', label: 'resonance', min: 0, max: 100, start: 0,
    per: 100, format: twoDp },
  { id: 'filEnv', group: 'filter', label: 'env amount', min: -100, max: 100, start: 0,
    per: 100, format: twoDp },
  { id: 'filTrack', group: 'filter', label: 'key track', min: 0, max: 200, start: 100,
    per: 100, format: twoDp },

  { id: 'lfo1r', group: 'lfo', label: 'LFO 1 rate', min: 0, max: 200, start: 0, per: 10,
    format: (v) => `${v.toFixed(1)} Hz` },
  { id: 'lfo1d', group: 'lfo', label: 'LFO 1 depth', min: 0, max: 100, start: 0,
    per: 100, format: twoDp },
  { id: 'lfo2r', group: 'lfo', label: 'LFO 2 rate', min: 0, max: 200, start: 0, per: 10,
    format: (v) => `${v.toFixed(1)} Hz` },
  { id: 'lfo2d', group: 'lfo', label: 'LFO 2 depth', min: 0, max: 100, start: 0,
    per: 100, format: twoDp },
  { id: 'lfo3r', group: 'lfo', label: 'LFO 3 rate', min: 0, max: 200, start: 0, per: 10,
    format: (v) => `${v.toFixed(1)} Hz` },
  { id: 'lfo3d', group: 'lfo', label: 'LFO 3 depth', min: 0, max: 100, start: 0,
    per: 100, format: twoDp },

  { id: 'echoSend', group: 'echo', label: 'send', min: 0, max: 100, start: 0, per: 100,
    format: twoDp, effects: true },
  { id: 'echoTime', group: 'echo', label: 'time (beats)', min: 0, max: 80, step: 1, start: 10,
    per: 10, format: (v) => `${v.toFixed(2)} beats`, effects: true },
  { id: 'echoFb', group: 'echo', label: 'feedback', min: 0, max: 95, start: 54, per: 100,
    format: twoDp, effects: true },
  { id: 'echoMix', group: 'echo', label: 'mix', min: 0, max: 100, start: 60, per: 100,
    format: twoDp, effects: true },
  { id: 'tempo', group: 'echo', label: 'tempo', min: 40, max: 300, step: 1, start: 120,
    per: 1, format: (v) => `${v} BPM`, effects: true },

  { id: 'reverbSend', group: 'reverb', label: 'send', min: 0, max: 100, start: 0,
    per: 100, format: twoDp, effects: true },
  { id: 'reverbSet', group: 'reverb', label: 'setting', min: 0, max: 15, step: 1, start: 5,
    per: 1, format: String, effects: true },

  // Not in the panel: it lives beside the bench's sequence buttons, but it is
  // the same kind of control and belongs to the same table.
  { id: 'length', group: 'bench', label: 'note length', min: 10, max: 400, start: 120,
    per: 100, format: seconds },
] as const satisfies readonly Fader[];

const CHECK_SPECS = [
  { id: 'ovEnv', group: 'env', label: 'override', start: false },
  { id: 'ovFilter', group: 'filter', label: 'override', start: false },
  { id: 'ovLfo', group: 'lfo', label: 'override', start: false },
  { id: 'optClip', group: 'reverb', label: 'output clip', start: true, effects: true },

  // What the page listens to on an MPE controller. Not overrides — they only
  // say whether the dimension is read at all.
  { id: 'mpePress', group: 'mpe', label: 'press → volume', start: true,
    title: "MPE's Z: channel pressure, per note" },
  { id: 'mpeSlide', group: 'mpe', label: 'slide → cutoff', start: true,
    title: "MPE's Y: CC 74, per note" },

  // The instrument's own stages, switched in and out to compare them with the
  // stand-ins above. These sit in the bench section rather than in the panel.
  { id: 'useEnvelope', group: 'stage', label: 'envelope', start: true },
  { id: 'useFilter', group: 'stage', label: 'filter', start: true },
  { id: 'useLfos', group: 'stage', label: 'LFOs', start: true },
] as const satisfies readonly Check[];

export type BenchFader = (typeof FADER_SPECS)[number]['id'];
export type BenchCheck = (typeof CHECK_SPECS)[number]['id'];

// GROUPS holds the panel's groups only. `bench`, `stage` and `mpe` are
// placement keys on controls drawn elsewhere on the page.
export const BENCH: Spec<BenchFader, BenchCheck, never> = {
  groups: GROUP_SPECS,
  faders: FADER_SPECS,
  checks: CHECK_SPECS,
};

export const bench = createControls(BENCH);

/** Everything the worklet's output stage is built from. */
export const effectSettings = (sampleRate: number) => ({
  echoTime: bench.value('echoTime'),
  framesPerStep: (60 / bench.value('tempo') / 4) * sampleRate,
  feedback: bench.value('echoFb'),
  mix: bench.value('echoMix'),
  reverbSetting: bench.value('reverbSet'),
  echoOn: bench.value('echoSend') > 0,
  reverbOn: bench.value('reverbSend') > 0,
  clip: bench.on('optClip'),
});

/**
 * The live overrides, read at note-on.
 *
 * ⚠️ **Off by default, and that is the point.** Unticked, every group falls
 * through to the instrument's own measured parameters, so the bench still plays
 * the game. The sliders are for asking "what does this knob do", not for
 * inventing a patch and mistaking it for the engine.
 */
export const overrideAdsr = () =>
  bench.on('ovEnv')
    ? {
        attack: bench.value('envA'),
        decay: bench.value('envD'),
        sustain: bench.value('envS'),
        release: bench.value('envR'),
      }
    : undefined;

export const overrideFilter = () =>
  bench.on('ovFilter')
    ? {
        settings: {
          cutoff: bench.value('filCut'),
          resonance: bench.value('filRes'),
          keyTrack: bench.value('filTrack'),
          envAmount: bench.value('filEnv'),
        },
        envelope: { attack: 0, decay: 0.3, sustain: 1, release: 0.2 },
      }
    : undefined;

type LfoSetting = { rate: number; depth: number; spread: number };

export const overrideLfos = () =>
  bench.on('ovLfo')
    ? ([1, 2, 3].map((n) => ({
        rate: bench.value(`lfo${n}r` as BenchFader),
        depth: bench.value(`lfo${n}d` as BenchFader),
        spread: 0,
      })) as [LfoSetting, LfoSetting, LfoSetting])
    : undefined;
