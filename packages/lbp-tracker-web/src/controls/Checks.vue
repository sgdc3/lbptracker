<script setup lang="ts">
/**
 * A row of checkboxes belonging to one group of `spec.ts`.
 *
 * Two rows use it and they mean different things, which is worth saying because
 * the markup is identical. `stage` switches the instrument's own stages **out**
 * — unticked, the stage is bypassed rather than replaced, which is how the bench
 * answers "what does the ladder filter actually add" — while `mpe` is only about
 * which MPE dimensions the page listens to.
 */
import { checksIn } from './spec.ts';
import { checked } from './state.ts';

const props = defineProps<{ group: string }>();
const checks = checksIn(props.group);
</script>

<template>
  <label v-for="check in checks" :key="check.id" class="check" :title="check.title">
    <input :id="check.id" v-model="checked[check.id]" type="checkbox"> {{ check.label }}
  </label>
</template>
