<script setup lang="ts">
/**
 * One labelled slider, drawn from its row of `spec.ts`.
 *
 * ⚠️ **The `<output>` has no id and nothing writes to it.** The old markup gave
 * every fader a matching `<output id="${id}Label">` and `app.ts` filled it by
 * string join, which is how a label could end up describing a different slider.
 * Here the number shown comes from the same `scale` the engine is given.
 */
import { computed } from 'vue';
import { FADERS, type FaderId } from './spec.ts';
import { positions, reset, shown } from './state.ts';

const props = defineProps<{ id: FaderId }>();
const fader = computed(() => FADERS.find((f) => f.id === props.id)!);
</script>

<template>
  <div class="knob">
    <label :for="id">{{ fader.label }}</label>
    <!-- Double-click a fader to put it back where it started. -->
    <input
      :id="id"
      v-model.number="positions[id]"
      type="range"
      :min="fader.min"
      :max="fader.max"
      :step="fader.step ?? 1"
      @dblclick="reset(id)"
    >
    <output>{{ shown(id) }}</output>
  </div>
</template>
