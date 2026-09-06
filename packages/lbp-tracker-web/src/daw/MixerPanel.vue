<script setup lang="ts">
/**
 * The song's own settings: every field of `PSequencer` a composer sets in the
 * game -- tempo, swing, the channel count and faders, the echo, the reverb,
 * the loop flag -- plus the board's height, which bands rows into channels.
 *
 * Reads go through `state.version` so the panel follows the canvases; writes
 * go through `state.edit` with a key per control, so a slider drag is one
 * undo step. Tempo, swing, channels and faders are applied to the running
 * player without a rebuild (`Player.setSettings`); the echo and the reverb are
 * one message to the worklet.
 */
import { computed } from 'vue';
import { MIXER_CHANNELS, type Song } from '@lbptracker/lib/song.ts';
import { bandOf } from '../editor/geometry.ts';
import type { EditorState } from '../editor/state.ts';
import type { ChangeKind } from '../editor/state.ts';

const props = defineProps<{ state: EditorState }>();

/**
 * ⚠️ A COPY, taken on every change. The song is a plain object, and a computed
 * that returned it unchanged would not re-run its dependents -- Vue notifies
 * only when a computed's value differs -- so the panel froze at its first
 * render and a new channel's fader never appeared. The copy is for reading;
 * every write goes through `state.edit` to the song itself.
 */
const song = computed((): Song => {
  void props.state.version.value;
  return { ...props.state.song };
});
const channels = computed(() => Array.from({ length: song.value.numChannels }, (_, i) => i));
/** How many chips land on each channel, through the board's bands. */
const perChannel = computed(() => {
  const s = song.value;
  const counts = new Array<number>(s.numChannels).fill(0);
  for (const c of s.clips) counts[bandOf(c.row, s.boardRows, s.numChannels)] += 1;
  return counts;
});

const num = (event: Event) => Number((event.target as HTMLInputElement).value);
const set = (kind: ChangeKind, key: string, fn: (value: number, s: Song) => void) => (event: Event) => {
  const value = num(event);
  if (!Number.isFinite(value)) return;
  props.state.edit(kind, (s) => fn(value, s), key);
};
const fmt = (v: number) => v.toFixed(2);
</script>

<template>
  <div class="live">
    <div class="group">
      <h3>timing</h3>
      <div class="knob">
        <label for="mx-tempo">tempo</label>
        <input id="mx-tempo" type="range" min="20" max="400" step="1" :value="song.tempo" autocomplete="off"
               @input="set('settings', 'tempo', (v, s) => { s.tempo = v; })($event)">
        <output>{{ song.tempo }} BPM</output>
      </div>
      <div class="knob">
        <label for="mx-swing">swing</label>
        <input id="mx-swing" type="range" min="0" max="99" step="1" :value="Math.round(song.swing * 100)" autocomplete="off"
               @input="set('settings', 'swing', (v, s) => { s.swing = v / 100; })($event)">
        <output>{{ fmt(song.swing) }}</output>
      </div>
      <div class="row" style="margin-top:.5rem">
        <label class="check">
          <input type="checkbox" :checked="song.loop" autocomplete="off"
                 @change="state.edit('selection', (s) => { s.loop = ($event.target as HTMLInputElement).checked; })"> loop
        </label>
      </div>
      <p class="hintline">
        Both move every note and neither rebuilds anything: the plan holds musical positions, so
        the next note played uses them and your place is kept in the music. Loop is stored with
        the song; the player here runs to the end.
      </p>
    </div>

    <div class="group">
      <h3>channels</h3>
      <div class="knob">
        <label for="mx-channels">how many</label>
        <input id="mx-channels" type="range" min="1" :max="MIXER_CHANNELS" step="1" :value="song.numChannels" autocomplete="off"
               @input="set('settings', 'channels', (v, s) => { s.numChannels = v; })($event)">
        <output>{{ song.numChannels }}</output>
      </div>
      <div v-for="ch in channels" :key="ch" class="knob">
        <label :for="`mx-vol${ch}`" :title="`${perChannel[ch]} chips on this channel`">ch {{ ch }} · {{ perChannel[ch] }}</label>
        <input :id="`mx-vol${ch}`" type="range" min="0" max="150" step="1" :value="Math.round(song.volumes[ch] * 100)" autocomplete="off"
               @input="set('settings', `vol${ch}`, (v, s) => { s.volumes[ch] = v / 100; })($event)">
        <output>{{ fmt(song.volumes[ch]) }}</output>
      </div>
      <div class="knob">
        <label for="mx-rows">board rows</label>
        <input id="mx-rows" type="range" min="1" max="25" step="1" :value="song.boardRows" autocomplete="off"
               @input="set('settings', 'rows', (v, s) => { s.boardRows = v; })($event)">
        <output>{{ song.boardRows }}</output>
      </div>
      <p class="hintline">
        The board is cut into as many bands as there are channels, top to bottom; a row's band is
        its mixer channel, and the count beside each fader is how many chips land on it. Every
        channel carries the engine's own 0.75 headroom on top of its fader.
      </p>
    </div>

    <div class="group">
      <h3>echo &amp; reverb</h3>
      <div class="knob">
        <label for="mx-echoTime">echo time</label>
        <input id="mx-echoTime" type="range" min="0" max="80" step="1" :value="Math.round(song.echoTime * 10)" autocomplete="off"
               @input="set('effects', 'echoTime', (v, s) => { s.echoTime = v / 10; })($event)">
        <output>{{ fmt(song.echoTime) }} beats</output>
      </div>
      <div class="knob">
        <label for="mx-echoFb">feedback</label>
        <input id="mx-echoFb" type="range" min="0" max="95" step="1" :value="Math.round(song.echoFeedback * 100)" autocomplete="off"
               @input="set('effects', 'echoFb', (v, s) => { s.echoFeedback = v / 100; })($event)">
        <output>{{ fmt(song.echoFeedback) }}</output>
      </div>
      <div class="knob">
        <label for="mx-echoMix">mix</label>
        <input id="mx-echoMix" type="range" min="0" max="100" step="1" :value="Math.round(song.echoMix * 100)" autocomplete="off"
               @input="set('effects', 'echoMix', (v, s) => { s.echoMix = v / 100; })($event)">
        <output>{{ fmt(song.echoMix) }}</output>
      </div>
      <div class="knob">
        <label for="mx-reverb">reverb</label>
        <input id="mx-reverb" type="range" min="0" max="15" step="1" :value="song.reverb" autocomplete="off"
               @input="set('effects', 'reverb', (v, s) => { s.reverb = v; })($event)">
        <output>{{ song.reverb }}</output>
      </div>
      <p class="hintline">
        The sequencer's own output stage, as the game stores it: the echo's delay is in beats and
        follows the tempo. Each instrument sends its own amount to both, in its chip's settings.
      </p>
    </div>
  </div>
</template>
