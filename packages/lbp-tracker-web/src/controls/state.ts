/**
 * The bench's controls as reactive state, and the only way to read them.
 *
 * ❗ **The DOM is no longer the store.** `app.ts` used to reach for
 * `getElementById(id).value` at note-on, which made every control a string
 * lookup that could not be checked and made the panel's markup the source of
 * truth for numbers the engine consumes. The panel is now a view of this
 * object; nothing reads an `<input>`.
 *
 * ⚠️ **`raw` and `value` are not the same number, and the difference matters.**
 * `raw` is where the slider sits — an integer, because that is what a range
 * input gives — and `value` is what the engine is handed, after the fader's own
 * `scale`. Ask for `value` unless you are drawing the slider.
 */

import { reactive } from 'vue';
import { CHECKS, FADERS, type CheckId, type FaderId } from './spec.ts';

const faderById = new Map(FADERS.map((f) => [f.id as string, f]));

/** Slider positions, keyed by id. Written by the panel, read through `value`. */
export const positions = reactive<Record<string, number>>(
  Object.fromEntries(FADERS.map((f) => [f.id, f.start])),
);

/** The checkboxes, keyed by id. */
export const checked = reactive<Record<string, boolean>>(
  Object.fromEntries(CHECKS.map((c) => [c.id, c.start])),
);

/** Where the slider sits. */
export const raw = (id: FaderId): number => positions[id]!;

/** What the engine is given — the slider position through the fader's `scale`. */
export const value = (id: FaderId): number => faderById.get(id)!.scale(positions[id]!);

/** What the reader sees, from the same number the engine gets. */
export const shown = (id: FaderId): string => faderById.get(id)!.format(value(id));

export const on = (id: CheckId): boolean => checked[id]!;

/** Put one fader back where it started — what a double-click does. */
export const reset = (id: FaderId): void => {
  positions[id] = faderById.get(id)!.start;
};

/**
 * Everything the worklet's output stage is built from.
 *
 * Kept here rather than in `app.ts` so that the `effects: true` flags in the
 * spec and the fields of this object are read side by side; a fader that feeds
 * the output stage without the flag would move without rebuilding anything, and
 * that is a silent failure.
 */
export const effectSettings = (sampleRate: number) => ({
  echoTime: value('echoTime'),
  framesPerStep: (60 / value('tempo') / 4) * sampleRate,
  feedback: value('echoFb'),
  mix: value('echoMix'),
  reverbSetting: value('reverbSet'),
  echoOn: value('echoSend') > 0,
  reverbOn: value('reverbSend') > 0,
  clip: on('optClip'),
});

/**
 * Everything a change to which has to rebuild the output stage, as one array to
 * watch.
 *
 * ❗ **Generated from the spec's `effects` flags, not written out.** A fader
 * added to the echo group with the flag would otherwise move and change nothing
 * until somebody remembered to extend a watcher here — a silent failure, and
 * the exact drift this file exists to remove.
 */
export const effectsSignature = (): (number | boolean)[] => [
  ...FADERS.filter((f) => f.effects).map((f) => positions[f.id]!),
  ...CHECKS.filter((c) => c.effects).map((c) => checked[c.id]!),
];

/**
 * The live overrides, read at note-on.
 *
 * ⚠️ **Off by default, and that is the point.** Unticked, every group falls
 * through to the instrument's own measured parameters, so the bench still plays
 * the game. The sliders are for asking "what does this knob do", not for
 * inventing a patch and mistaking it for the engine.
 */
export const overrideAdsr = () =>
  on('ovEnv')
    ? {
        attack: value('envA'),
        decay: value('envD'),
        sustain: value('envS'),
        release: value('envR'),
      }
    : undefined;

export const overrideFilter = () =>
  on('ovFilter')
    ? {
        settings: {
          cutoff: value('filCut'),
          resonance: value('filRes'),
          keyTrack: value('filTrack'),
          envAmount: value('filEnv'),
        },
        envelope: { attack: 0, decay: 0.3, sustain: 1, release: 0.2 },
      }
    : undefined;

export const overrideLfos = () =>
  on('ovLfo')
    ? ([1, 2, 3].map((n) => ({
        rate: value(`lfo${n}r` as FaderId),
        depth: value(`lfo${n}d` as FaderId),
        spread: 0,
      })) as [
        { rate: number; depth: number; spread: number },
        { rate: number; depth: number; spread: number },
        { rate: number; depth: number; spread: number },
      ])
    : undefined;
