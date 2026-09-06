/**
 * The MIDI export's controls — the Convert view, `daw/convert-view.ts`.
 *
 * ⚠️ **The bend range is the one with the old drift in it.** `bendRangeLabel`
 * read `auto` or `±48` depending on a *checkbox*, written by a `showBend()` that
 * also had to remember to disable the slider — three facts about one control,
 * kept in step by hand. All three are in this table now: `format` is handed the
 * checkbox reader and `disabledBy` names the same box.
 */

import {
  createControls,
  type Check,
  type Choice,
  type Fader,
  type Group,
  type Spec,
} from './kit.ts';

const GROUP_SPECS = [
  {
    key: 'write',
    title: 'how to write it',
    stack: true,
    note:
      'A track is named row 4 - saw_wave, because the board row and the instrument are the two ' +
      'things MIDI has no message for — so the name is where they live, and editing it is how ' +
      'you move a part.',
  },
  {
    key: 'bend',
    title: 'bend range',
    note:
      'How far a full pitch bend reaches. MPE’s own default is ±48, and this corpus needs more: ' +
      '582 of its 1,448,224 control points glide further.',
  },
] as const satisfies readonly Group[];

const FADER_SPECS = [
  { id: 'bendRange', group: 'bend', label: 'semitones', min: 2, max: 96, step: 1, start: 48,
    per: 1, disabledBy: 'autoBend',
    format: (v, on) => (on('autoBend') ? 'auto' : `±${v}`) },
] as const satisfies readonly Fader[];

const CHECK_SPECS = [
  { id: 'bakeSwing', group: 'write', label: 'bake the swing into the timing', start: false,
    title: 'Write the swung positions instead of the straight grid' },
  { id: 'exact', group: 'write', label: 'carry what MIDI cannot say', start: true,
    title: 'Carry the records MIDI cannot express, so a round trip returns the same file' },
  { id: 'mergeRows', group: 'write', label: 'one track per row, not per placement', start: true,
    title: 'One track per board row and instrument, with the mixer as CC automation' },
  { id: 'autoBend', group: 'bend', label: 'pick it from the music', start: true },
] as const satisfies readonly Check[];

const CHOICE_SPECS = [
  {
    id: 'mode',
    group: 'write',
    label: 'channels',
    start: 'mpe',
    options: [
      { value: 'mpe', label: 'MPE — a channel per note' },
      { value: 'plain', label: 'plain — a channel per instrument' },
    ],
  },
  {
    id: 'split',
    group: 'write',
    label: 'files',
    start: 'one',
    options: [
      { value: 'one', label: 'one file' },
      { value: 'packed', label: 'split into several files' },
    ],
  },
] as const satisfies readonly Choice[];

export type MidiFader = (typeof FADER_SPECS)[number]['id'];
export type MidiCheck = (typeof CHECK_SPECS)[number]['id'];
export type MidiChoice = (typeof CHOICE_SPECS)[number]['id'];

export const MIDI: Spec<MidiFader, MidiCheck, MidiChoice> = {
  groups: GROUP_SPECS,
  faders: FADER_SPECS,
  checks: CHECK_SPECS,
  choices: CHOICE_SPECS,
};

export const midi = createControls(MIDI);
