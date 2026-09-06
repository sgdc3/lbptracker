<script setup lang="ts">
/**
 * The inspector: the selected placement's settings -- every field of
 * `PInstrument` the game lets a composer set -- and the selected point's.
 * ⚠️ Not the name: a placed instrument cannot be renamed in the game, so
 * `Clip.name` is carried from the file and shown, never edited.
 * The song's own settings are the mixer's (`daw/MixerPanel.vue`).
 *
 * Reads go through `state.version` so the panel follows the canvases; writes
 * go through `state.edit` with a key per control, so a slider drag is one
 * undo step. The song object itself is not reactive -- see `state.ts`.
 */
import { computed } from 'vue';
import { SCALE_NAMES } from '@lbptracker/lib/scale.ts';
import { CLIP_STEP_CHOICES, highestStep, resizeClip, type ChangeKindLike } from './inspector-support.ts';
import { STEPS_PER_BAR, barOfCell, noteName, positionLabel } from './geometry.ts';
import type { InstrumentInfo } from './instruments.ts';
import type { EditorState } from './state.ts';

const props = defineProps<{ state: EditorState; instruments: InstrumentInfo[] }>();
const emit = defineEmits<{ duplicate: []; remove: []; status: [text: string] }>();

// Every computed below touches `version` first so that it re-runs on a change.
const clip = computed(() => {
  void props.state.version.value;
  return props.state.clip();
});
const point = computed(() => {
  void props.state.version.value;
  return props.state.point();
});
const stepChoices = CLIP_STEP_CHOICES;
const keyChoices = [
  { value: 0, label: 'default (C)' },
  ...['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map((n, i) => ({ value: 12 + i, label: n })),
];

const num = (event: Event) => Number((event.target as HTMLInputElement).value);

const setClip = (kind: ChangeKindLike, key: string, fn: (value: number) => void) => (event: Event) => {
  // A select with no matching option reports '' -- which `Number` reads as 0,
  // and 0 is a real value for the sound (no instrument). Not a change.
  if ((event.target as HTMLInputElement).value === '') return;
  const value = num(event);
  if (!Number.isFinite(value) || !clip.value) return;
  props.state.edit(kind, () => fn(value), key);
};

const setSteps = (event: Event) => {
  const c = clip.value;
  if (!c) return;
  const wanted = num(event);
  let ok = true;
  props.state.edit('notes', () => {
    ok = resizeClip(c, wanted);
  }, 'steps');
  if (!ok) {
    emit('status', `the grid cannot be shorter than its notes: the last one is on step ${highestStep(c) + 1}`);
    (event.target as HTMLSelectElement).value = String(c.steps);
  }
};

const setPoint = (field: 'pitch' | 'volume' | 'timbre') => (event: Event) => {
  const sel = point.value;
  if (!sel) return;
  const value = num(event);
  props.state.edit('notes', () => {
    sel.point[field] = Math.max(0, Math.min(field === 'timbre' ? 15 : 127, Math.round(value)));
  }, `point-${field}`);
};

const fmt = (v: number, dp = 2) => v.toFixed(dp);
</script>

<template>
  <div class="inspector">
    <div class="group" :class="{ off: !clip }">
      <h3>instrument</h3>
      <template v-if="clip">
        <div class="knob">
          <label for="clipGuid">sound</label>
          <select id="clipGuid" class="wide" :value="clip.guid" autocomplete="off"
                  @change="setClip('notes', 'guid', (v) => { clip!.guid = v; })($event)">
            <option v-if="!instruments.some((i) => i.guid === clip!.guid)" :value="clip.guid">
              {{ clip.guid ? `unknown (${clip.guid})` : '(none)' }}
            </option>
            <option v-for="i in instruments" :key="i.guid" :value="i.guid">{{ i.name }}</option>
          </select>
          <output></output>
        </div>
        <div class="knob">
          <label for="clipSteps">grid</label>
          <select id="clipSteps" :value="clip.steps" autocomplete="off" @change="setSteps">
            <option v-for="s in stepChoices" :key="s" :value="s">{{ s / STEPS_PER_BAR }} bars · {{ s }} steps</option>
          </select>
          <output></output>
        </div>
        <div class="knob">
          <label for="clipKey">key</label>
          <select id="clipKey" :value="clip.key" autocomplete="off"
                  @change="setClip('notes', 'key', (v) => { clip!.key = v; })($event)">
            <option v-for="k in keyChoices" :key="k.value" :value="k.value">{{ k.label }}</option>
          </select>
          <output></output>
        </div>
        <div class="knob">
          <label for="clipScale">scale</label>
          <select id="clipScale" :value="clip.scale" autocomplete="off"
                  @change="setClip('notes', 'scale', (v) => { clip!.scale = v; })($event)">
            <option v-for="(name, i) in SCALE_NAMES" :key="i" :value="i">{{ name }}</option>
          </select>
          <output></output>
        </div>
        <div class="knob">
          <label for="clipLevel">level</label>
          <input id="clipLevel" type="range" min="0" max="200" step="1" :value="Math.round(clip.level * 100)" autocomplete="off"
                 @input="setClip('notes', 'level', (v) => { clip!.level = v / 100; })($event)">
          <output>{{ fmt(clip.level) }}</output>
        </div>
        <div class="knob">
          <label for="clipPan">pan</label>
          <input id="clipPan" type="range" min="0" max="100" step="1" :value="Math.round(clip.pan * 100)" autocomplete="off"
                 @input="setClip('notes', 'pan', (v) => { clip!.pan = v / 100; })($event)">
          <output>{{ fmt(clip.pan) }}</output>
        </div>
        <div class="knob">
          <label for="clipEcho">echo send</label>
          <input id="clipEcho" type="range" min="0" max="100" step="1" :value="Math.round(clip.echoSend * 100)" autocomplete="off"
                 @input="setClip('notes', 'echoSend', (v) => { clip!.echoSend = v / 100; })($event)">
          <output>{{ fmt(clip.echoSend) }}</output>
        </div>
        <div class="knob">
          <label for="clipReverb">reverb send</label>
          <input id="clipReverb" type="range" min="0" max="100" step="1" :value="Math.round(clip.reverbSend * 100)" autocomplete="off"
                 @input="setClip('notes', 'reverbSend', (v) => { clip!.reverbSend = v / 100; })($event)">
          <output>{{ fmt(clip.reverbSend) }}</output>
        </div>
        <div class="row" style="margin-top:.6rem">
          <span class="hintline" style="margin:0">bar {{ barOfCell(clip.cell) }}, row {{ clip.row }} · {{ clip.notes.length }} note{{ clip.notes.length === 1 ? '' : 's' }}</span>
          <span class="spacer"></span>
          <button type="button" @click="emit('duplicate')" title="Ctrl+D">duplicate</button>
          <button type="button" @click="emit('remove')" title="Delete, with the board focused">remove</button>
        </div>
      </template>
      <p v-else class="hintline">Select an instrument on the board.</p>
    </div>

    <div class="group" :class="{ off: !point }">
      <h3>point</h3>
      <template v-if="point">
        <div class="knob">
          <label for="ptPitch">pitch</label>
          <input id="ptPitch" type="range" min="0" max="127" step="1" :value="point.point.pitch" autocomplete="off"
                 @input="setPoint('pitch')($event)">
          <output>{{ noteName(point.point.pitch) }} · {{ point.point.pitch }}</output>
        </div>
        <div class="knob">
          <label for="ptVolume">volume</label>
          <input id="ptVolume" type="range" min="0" max="127" step="1" :value="point.point.volume" autocomplete="off"
                 @input="setPoint('volume')($event)">
          <output>{{ point.point.volume }}</output>
        </div>
        <div class="knob">
          <label for="ptTimbre">timbre</label>
          <input id="ptTimbre" type="range" min="0" max="15" step="1" :value="point.point.timbre" autocomplete="off"
                 @input="setPoint('timbre')($event)">
          <output>{{ point.point.timbre }} / 15</output>
        </div>
        <p class="hintline">
          At {{ positionLabel(point.point.thirds) }}, point {{ point.index + 1 }} of {{ point.note.points.length }}.
          The size of a point is its volume, its colour its timbre: blue at 0, orange at 15. The
          engine glides pitch and volume between points, and reads the timbre once, at the note-on.
        </p>
      </template>
      <p v-else class="hintline">Click a point on the grid.</p>
    </div>
  </div>
</template>
