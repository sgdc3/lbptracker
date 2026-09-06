/**
 * The live player's controls — `live.html`.
 *
 * ⚠️ **The ids repeat the bench's and the ranges do not.** `tempo` here is
 * 20..400 and on the bench 40..300; `echoTime` is the same but `optClip` means
 * a different signal. That is why every page builds its own store from its own
 * spec instead of sharing one table — see `kit.ts`.
 *
 * ❗ **Three grids, one spec.** The page draws these groups in three separate
 * sections, so `ControlPanel` takes an `only` list rather than the panel being
 * one block. The spec's order is still the page's order within each.
 */

import { createControls, type Check, type Fader, type Group, type Spec } from './kit.ts';

const twoDp = (v: number) => v.toFixed(2);

const GROUP_SPECS = [
  {
    key: 'pool',
    title: 'voice pool',
    note:
      'Live — move it while it plays. The engine’s is 32. Its stealing is decided over the whole ' +
      'song at once, so changing it rebuilds the plan, but the rebuild is swapped in underneath: ' +
      'nothing stops, and what is already sounding finishes. Uncapping it plays every note, ' +
      'which is not the game.',
  },
  {
    key: 'timing',
    title: 'timing',
    note:
      'Both are written into the song, and both move every note — but neither rebuilds anything. ' +
      'The plan holds musical positions, so a new tempo or swing is three numbers and the next ' +
      'note played uses them; your place is kept in the music rather than in seconds, since a ' +
      'tempo change moves the second a bar sits at. What is already sounding keeps the timing it ' +
      'was given, which is what a DAW does too.',
  },
  {
    key: 'channels',
    title: 'channels',
    slotId: 'channels',
    note:
      'NumChannels and the song’s own mixer. A board row feeds channel row mod NumChannels, so ' +
      'with one channel every row goes through the one fader, and raising it fans the same rows ' +
      'out — the count beside each fader is how many tracks land on it. 308 of the 338 ' +
      'sequencers in the corpus declare one. Live, like the timing: a fader is one factor of a ' +
      'voice’s gain and nothing else.',
  },
  { key: 'echo', title: 'echo' },
  { key: 'reverb', title: 'reverb & output' },
] as const satisfies readonly Group[];

const FADER_SPECS = [
  // ⚠️ The label reads `off` when the pool is uncapped, which is why `format`
  // is handed the checkbox reader: the alternative is a second writer of this
  // label somewhere in `live.ts`, which is what it used to be.
  { id: 'voices', group: 'pool', label: 'size', min: 1, max: 128, step: 1, start: 32,
    per: 1, disabledBy: 'optNoCap',
    format: (v, on) => (on('optNoCap') ? 'off' : String(v)) },

  { id: 'tempo', group: 'timing', label: 'tempo', min: 20, max: 400, step: 1, start: 120,
    per: 1, format: (v) => `${v} BPM` },
  { id: 'swing', group: 'timing', label: 'swing', min: 0, max: 100, step: 1, start: 0,
    per: 100, format: twoDp },

  { id: 'numChannels', group: 'channels', label: 'how many', min: 1, max: 8, step: 1,
    start: 1, per: 1, format: String },

  { id: 'echoTime', group: 'echo', label: 'time (beats)', min: 0, max: 80, step: 1, start: 10,
    per: 10, format: (v) => `${v.toFixed(2)} beats`, effects: true },
  { id: 'echoFb', group: 'echo', label: 'feedback', min: 0, max: 95, start: 54, per: 100,
    format: twoDp, effects: true },
  { id: 'echoMix', group: 'echo', label: 'mix', min: 0, max: 100, start: 60, per: 100,
    format: twoDp, effects: true },

  { id: 'reverbSet', group: 'reverb', label: 'setting', min: 0, max: 15, step: 1, start: 5,
    per: 1, format: String, effects: true },
] as const satisfies readonly Fader[];

const CHECK_SPECS = [
  { id: 'optNoCap', group: 'pool', label: 'unlimited', start: false },
  { id: 'optEcho', group: 'reverb', label: 'echo', start: true, effects: true },
  { id: 'optReverb', group: 'reverb', label: 'reverb', start: true, effects: true },
  { id: 'optClip', group: 'reverb', label: 'output clip', start: true, effects: true },
] as const satisfies readonly Check[];

export type LiveFader = (typeof FADER_SPECS)[number]['id'];
export type LiveCheck = (typeof CHECK_SPECS)[number]['id'];

export const LIVE: Spec<LiveFader, LiveCheck, never> = {
  groups: GROUP_SPECS,
  faders: FADER_SPECS,
  checks: CHECK_SPECS,
};

export const live = createControls(LIVE);
