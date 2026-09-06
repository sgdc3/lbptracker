/**
 * The renderer's options — the Render view, `daw/render-view.ts`.
 *
 * ⚠️ **This page had nothing of the drift the others had**, and the conversion
 * is deliberately smaller for it. There are no `*Label` outputs here, no
 * formatters and no scales: five plain checkboxes, each read once. So the
 * markup keeps its shape — the options live in `.switch` cards *beside the
 * prose that explains them*, which is the page's whole idea — and only the five
 * checks move into this table, mounted where they already were.
 *
 * ❗ **`from`, `to` and `voices` stay imperative on purpose.** They are free
 * text with validation and a `bad` class, not sliders with a range and a
 * default; forcing them into a fader spec would describe them wrongly. They are
 * still coupled to the checks — `optNoCap` disables `voices`, `useRange`
 * enables the other two — and `daw/render-view.ts` now watches the store for that
 * instead of listening on the elements.
 */

import { createControls, type Check, type Group, type Spec } from './kit.ts';

const GROUP_SPECS = [
  { key: 'range', title: 'range' },
  { key: 'pool', title: 'voice pool' },
  { key: 'stage', title: 'output stage' },
  { key: 'clip', title: 'clip' },
] as const satisfies readonly Group[];

const CHECK_SPECS = [
  { id: 'useRange', group: 'range', label: 'just a section', start: false },
  { id: 'optNoCap', group: 'pool', label: 'unlimited', start: false },
  { id: 'optReverb', group: 'stage', label: 'reverb', start: true },
  { id: 'optEcho', group: 'stage', label: 'echo', start: true },
  { id: 'optClip', group: 'clip', label: 'output clip', start: true },
] as const satisfies readonly Check[];

export type RenderCheck = (typeof CHECK_SPECS)[number]['id'];

// The groups exist to give the checks a placement key; this page draws no
// `ControlGroup`, only bare `Checks` rows inside its own cards.
export const RENDER: Spec<never, RenderCheck, never> = {
  groups: GROUP_SPECS,
  faders: [],
  checks: CHECK_SPECS,
};

export const render = createControls(RENDER);
