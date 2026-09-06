/**
 * What `Inspector.vue` needs from the model, re-exported in one place so that
 * the component's imports stay short and the type of a change kind is named
 * once. Nothing here is logic.
 */

export { MAX_CLIP_STEPS, MIXER_CHANNELS, highestStep, resizeClip } from '@lbptracker/lib/song.ts';
export type { ChangeKind as ChangeKindLike } from './state.ts';
