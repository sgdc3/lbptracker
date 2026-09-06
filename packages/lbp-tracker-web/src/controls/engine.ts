/**
 * The engine switches the mixer view offers while the song plays.
 *
 * What used to be the live page's `pool` and `reverb` groups, minus the song's
 * own settings: tempo, swing, the channels, the echo and the reverb are the
 * song's fields now, edited on the song itself (`MixerPanel.vue`), so the only
 * controls declared here are the ones that are not in the file.
 */

import { createControls, type Check, type Fader, type Group, type Spec } from './kit.ts';

const GROUP_SPECS = [
  {
    key: 'pool',
    title: 'voice pool',
    note:
      'Live. The engine’s is 32, and its stealing is decided over the whole song, so a new size ' +
      'replays the pool up to the playhead without stopping anything. Uncapping it plays every ' +
      'note, which is not the game.',
  },
  {
    key: 'stage',
    title: 'output stage',
    note:
      'Take an effect off to hear the voices alone; each removes the effect’s return, not its ' +
      'send. The clip is the plugin’s own hard limit at ±1.',
  },
] as const satisfies readonly Group[];

const FADER_SPECS = [
  { id: 'voices', group: 'pool', label: 'size', min: 1, max: 128, step: 1, start: 32,
    per: 1, disabledBy: 'optNoCap',
    format: (v, on) => (on('optNoCap') ? 'off' : String(v)) },
] as const satisfies readonly Fader[];

const CHECK_SPECS = [
  { id: 'optNoCap', group: 'pool', label: 'unlimited', start: false },
  { id: 'optEcho', group: 'stage', label: 'echo', start: true, effects: true },
  { id: 'optReverb', group: 'stage', label: 'reverb', start: true, effects: true },
  { id: 'optClip', group: 'stage', label: 'output clip', start: true, effects: true },
] as const satisfies readonly Check[];

export type EngineFader = (typeof FADER_SPECS)[number]['id'];
export type EngineCheck = (typeof CHECK_SPECS)[number]['id'];

export const ENGINE: Spec<EngineFader, EngineCheck, never> = {
  groups: GROUP_SPECS,
  faders: FADER_SPECS,
  checks: CHECK_SPECS,
};

export const engine = createControls(ENGINE);
