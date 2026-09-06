<script setup lang="ts">
/** Every group in `spec.ts`, in the order it is declared there. */
import { GROUPS } from './spec.ts';
import ControlGroup from './ControlGroup.vue';

// GROUPS holds the panel's groups only. `bench`, `stage` and `mpe` are
// placement keys on faders and checks drawn elsewhere on the page, and they
// deliberately have no group heading here.
</script>

<template>
  <div class="params">
    <ControlGroup v-for="group in GROUPS" :key="group.key" :group="group" />
  </div>
</template>
