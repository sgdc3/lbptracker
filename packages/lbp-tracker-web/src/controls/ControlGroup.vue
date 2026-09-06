<script setup lang="ts">
/**
 * One panel of faders, greyed out while its override is off.
 *
 * ❗ **The grey is not decoration.** Unticked, the group's sliders do nothing —
 * the note falls through to the instrument's own measured parameters — so it
 * has to be obvious at a glance whether what you hear is the game's or yours.
 */
import { computed } from 'vue';
import { checksIn, fadersIn, type Group } from './spec.ts';
import { checked } from './state.ts';
import Fader from './Fader.vue';

const props = defineProps<{ group: Group }>();

const faders = computed(() => fadersIn(props.group.key));
/** The group's own checks, minus the one that gates it — that one lives in the heading. */
const checks = computed(() => checksIn(props.group.key).filter((c) => c.id !== props.group.override));
const off = computed(() => !!props.group.override && !checked[props.group.override]);
</script>

<template>
  <div class="group" :class="{ off }">
    <h3>
      {{ group.title }}
      <label v-if="group.override" class="check">
        <input :id="group.override" v-model="checked[group.override]" type="checkbox"> override
      </label>
    </h3>

    <Fader v-for="fader in faders" :key="fader.id" :id="fader.id" />

    <div v-if="checks.length" class="row" style="margin-top:.55rem">
      <label v-for="check in checks" :key="check.id" class="check" :title="check.title">
        <input :id="check.id" v-model="checked[check.id]" type="checkbox"> {{ check.label }}
      </label>
    </div>

    <p v-if="group.note" class="hintline">{{ group.note }}</p>
  </div>
</template>
