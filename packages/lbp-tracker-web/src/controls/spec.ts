/**
 * Every control on the instrument bench, declared once.
 *
 * ❗ **This table replaces two.** Until 2026-09-06 each fader was written twice:
 * once in `index.html` as an `<input type="range">` with its `min`, `max` and
 * `value`, and once in `app.ts` as a row of a `knobs` array carrying its
 * formatter — joined by a **string id**, with `${id}Label` naming a third
 * element. Nothing checked that the three agreed. A typo in an id read the
 * neighbouring parameter and the page still worked; a slider whose formatter
 * divided by 100 while its reader divided by 10 showed one number and played
 * another.
 *
 * Both failures are gone, and not by being careful:
 *
 * - `FaderId` is the union of the ids **in this file**, so `raw('envAa')` is a
 *   compile error rather than a `null` at runtime.
 * - `scale` is applied once. The label and the engine are handed the *same*
 *   number, so they cannot disagree — `format` never sees the slider position.
 *
 * ⚠️ **`start` is the double-click default**, and it used to be the `value=`
 * attribute in the HTML. That was a good rule while the markup was hand-written
 * — the attribute genuinely was the default, with no second copy to drift — and
 * it is now this field, for the same reason.
 */

export interface Fader<Id extends string = string> {
  readonly id: Id;
  readonly group: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  /** Where the slider sits on load, and where a double-click puts it back. */
  readonly start: number;
  /** Slider position → the number the engine is given. */
  readonly scale: (raw: number) => number;
  /** That same number → what the reader sees. Never the slider position. */
  readonly format: (value: number) => string;
  /** Moving it rebuilds the worklet's output stage. */
  readonly effects?: boolean;
}

export interface Check<Id extends string = string> {
  readonly id: Id;
  readonly group: string;
  readonly label: string;
  readonly start: boolean;
  readonly title?: string;
  readonly effects?: boolean;
}

export interface Group {
  readonly key: string;
  readonly title: string;
  /** The check that gates the group; the group greys out while it is off. */
  readonly override?: string;
  readonly note?: string;
}

const unit = (raw: number) => raw / 100;
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
    scale: unit, format: twoDp },
  { id: 'pPan', group: 'voice', label: 'pan', min: 0, max: 100, start: 50,
    scale: unit,
    format: (v) =>
      v === 0.5 ? 'centre' : `${v < 0.5 ? 'L' : 'R'} ${Math.round(Math.abs(v - 0.5) * 200)}%` },
  { id: 'pDrive', group: 'voice', label: 'drive', min: 0, max: 95, start: 0,
    scale: unit, format: twoDp },

  { id: 'envA', group: 'env', label: 'attack', min: 0, max: 200, start: 0,
    scale: unit, format: seconds },
  { id: 'envD', group: 'env', label: 'decay', min: 0, max: 300, start: 60,
    scale: unit, format: seconds },
  { id: 'envS', group: 'env', label: 'sustain', min: 0, max: 100, start: 100,
    scale: unit, format: twoDp },
  { id: 'envR', group: 'env', label: 'release', min: 0, max: 300, start: 20,
    scale: unit, format: seconds },

  { id: 'filCut', group: 'filter', label: 'cutoff', min: 0, max: 100, start: 100,
    scale: unit, format: twoDp },
  { id: 'filRes', group: 'filter', label: 'resonance', min: 0, max: 100, start: 0,
    scale: unit, format: twoDp },
  { id: 'filEnv', group: 'filter', label: 'env amount', min: -100, max: 100, start: 0,
    scale: unit, format: twoDp },
  { id: 'filTrack', group: 'filter', label: 'key track', min: 0, max: 200, start: 100,
    scale: unit, format: twoDp },

  { id: 'lfo1r', group: 'lfo', label: 'LFO 1 rate', min: 0, max: 200, start: 0,
    scale: (raw) => raw / 10, format: (v) => `${v.toFixed(1)} Hz` },
  { id: 'lfo1d', group: 'lfo', label: 'LFO 1 depth', min: 0, max: 100, start: 0,
    scale: unit, format: twoDp },
  { id: 'lfo2r', group: 'lfo', label: 'LFO 2 rate', min: 0, max: 200, start: 0,
    scale: (raw) => raw / 10, format: (v) => `${v.toFixed(1)} Hz` },
  { id: 'lfo2d', group: 'lfo', label: 'LFO 2 depth', min: 0, max: 100, start: 0,
    scale: unit, format: twoDp },
  { id: 'lfo3r', group: 'lfo', label: 'LFO 3 rate', min: 0, max: 200, start: 0,
    scale: (raw) => raw / 10, format: (v) => `${v.toFixed(1)} Hz` },
  { id: 'lfo3d', group: 'lfo', label: 'LFO 3 depth', min: 0, max: 100, start: 0,
    scale: unit, format: twoDp },

  { id: 'echoSend', group: 'echo', label: 'send', min: 0, max: 100, start: 0,
    scale: unit, format: twoDp, effects: true },
  { id: 'echoTime', group: 'echo', label: 'time (beats)', min: 0, max: 80, step: 1, start: 10,
    scale: (raw) => raw / 10, format: (v) => `${v.toFixed(2)} beats`, effects: true },
  { id: 'echoFb', group: 'echo', label: 'feedback', min: 0, max: 95, start: 54,
    scale: unit, format: twoDp, effects: true },
  { id: 'echoMix', group: 'echo', label: 'mix', min: 0, max: 100, start: 60,
    scale: unit, format: twoDp, effects: true },
  { id: 'tempo', group: 'echo', label: 'tempo', min: 40, max: 300, step: 1, start: 120,
    scale: (raw) => raw, format: (v) => `${v} BPM`, effects: true },

  { id: 'reverbSend', group: 'reverb', label: 'send', min: 0, max: 100, start: 0,
    scale: unit, format: twoDp, effects: true },
  { id: 'reverbSet', group: 'reverb', label: 'setting', min: 0, max: 15, step: 1, start: 5,
    scale: (raw) => raw, format: String, effects: true },

  // Not in the panel: it lives beside the bench's sequence buttons, but it is
  // the same kind of control and belongs to the same table.
  { id: 'length', group: 'bench', label: 'note length', min: 10, max: 400, start: 120,
    scale: unit, format: seconds },
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

export type FaderId = (typeof FADER_SPECS)[number]['id'];
export type CheckId = (typeof CHECK_SPECS)[number]['id'];

/**
 * ⚠️ **Declared twice on purpose, and it is the same table.** `as const` is
 * what makes the ids a union, and it also narrows each row to exactly the keys
 * it wrote — so `fader.step` is a type error on the rows that omit it. Widening
 * to `Fader<FaderId>[]` here gives back the optional fields **and** keeps the
 * union, which neither form manages alone.
 */
export const GROUPS: readonly Group[] = GROUP_SPECS;
export const FADERS: readonly Fader<FaderId>[] = FADER_SPECS;
export const CHECKS: readonly Check<CheckId>[] = CHECK_SPECS;

export const fadersIn = (group: string): readonly Fader<FaderId>[] =>
  FADERS.filter((f) => f.group === group);
export const checksIn = (group: string): readonly Check<CheckId>[] =>
  CHECKS.filter((c) => c.group === group);
