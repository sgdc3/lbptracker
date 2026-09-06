<script setup lang="ts">
/**
 * The instrument palette: the game's instruments, by family, with a filter.
 *
 * Clicking one adds it to the board at the cursor; the page decides where
 * exactly. A list of sixty-nine names is a form, which is why this is Vue and
 * the board beside it is not.
 */
import { computed, ref } from 'vue';
import { POPULAR_GUIDS, type InstrumentInfo } from './instruments.ts';

const props = defineProps<{ instruments: InstrumentInfo[] }>();
const emit = defineEmits<{ pick: [guid: number] }>();

const query = ref('');

const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  const shown = props.instruments.filter((i) => !q || i.name.includes(q) || i.family.includes(q));
  const out: { family: string; items: InstrumentInfo[] }[] = [];
  if (!q) {
    const popular = POPULAR_GUIDS
      .map((g) => props.instruments.find((i) => i.guid === g))
      .filter((i): i is InstrumentInfo => i !== undefined);
    if (popular.length) out.push({ family: 'most used', items: popular });
  }
  for (const item of shown) {
    const family = item.family.replace(/_/g, ' ');
    let group = out.find((g) => g.family === family);
    if (!group) {
      group = { family, items: [] };
      out.push(group);
    }
    group.items.push(item);
  }
  return out;
});
</script>

<template>
  <div class="palette">
    <input
      v-model="query"
      type="text"
      class="palette-q"
      placeholder="filter instruments…"
      autocomplete="off"
      aria-label="Filter instruments"
    >
    <div class="palette-list">
      <template v-for="group in groups" :key="group.family">
        <div class="palette-family">{{ group.family }}</div>
        <button
          v-for="item in group.items"
          :key="`${group.family}/${item.guid}`"
          type="button"
          class="palette-row"
          :title="`add ${item.name} at the cursor`"
          @click="emit('pick', item.guid)"
        >
          <span class="palette-swatch" :style="{ background: item.colour }"></span>
          <span>{{ item.name }}</span>
        </button>
      </template>
      <div v-if="!groups.length" class="picker-none">nothing matches</div>
    </div>
  </div>
</template>
