<script setup lang="ts">
/**
 * A row of checkboxes belonging to one group of the page's spec.
 *
 * The same component serves rows that mean quite different things — the bench's
 * `stage` switches the instrument's own stages **out**, so unticked the stage is
 * bypassed rather than replaced — which is worth saying because the markup is
 * identical and only the spec tells them apart.
 */
import { inject } from 'vue';
import { CONTROLS } from './kit.ts';

const props = defineProps<{ group: string }>();
const controls = inject(CONTROLS)!;
const checks = controls.checksIn(props.group);
</script>

<template>
  <label v-for="check in checks" :key="check.id" class="check" :title="check.title">
    <input
      :id="check.id"
      v-model="controls.checked[check.id]"
      type="checkbox"
      autocomplete="off"
    > {{ check.label }}
  </label>
</template>
