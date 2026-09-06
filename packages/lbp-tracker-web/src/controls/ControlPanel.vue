<script setup lang="ts">
/**
 * The page's groups, in the order the spec declares them.
 *
 * `only` narrows it to a few of them, because the live player draws its groups
 * in three separate sections of the page rather than in one grid.
 */
import { computed, inject } from 'vue';
import { CONTROLS } from './kit.ts';
import ControlGroup from './ControlGroup.vue';

const props = defineProps<{ only?: string[]; grid?: string }>();
const controls = inject(CONTROLS)!;
const groups = computed(() =>
  props.only ? controls.groups.filter((g) => props.only!.includes(g.key)) : controls.groups);
</script>

<template>
  <div :class="grid ?? 'params'">
    <ControlGroup v-for="group in groups" :key="group.key" :group="group" />
  </div>
</template>
