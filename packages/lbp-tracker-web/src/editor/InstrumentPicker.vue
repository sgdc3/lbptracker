<script setup lang="ts">
/**
 * "Which instrument?" -- the question a new chip asks, as a searchable list.
 *
 * Type to filter, arrows to move, Enter to take the highlighted one, Escape to
 * give up. Mounted inside a `<dialog>` by `instrument-picker.ts`, which is
 * what makes it modal and puts the focus here.
 */
import { computed, onMounted, ref, useTemplateRef, watch } from 'vue';
import type { InstrumentInfo } from './instruments.ts';
import Glyph from './Glyph.vue';

const props = defineProps<{ instruments: InstrumentInfo[]; title: string }>();
const emit = defineEmits<{ pick: [guid: number]; cancel: [] }>();

const query = ref('');
const at = ref(0);
const search = useTemplateRef<HTMLInputElement>('search');
const list = useTemplateRef<HTMLDivElement>('list');

const shown = computed(() => {
  const q = query.value.trim().toLowerCase();
  return props.instruments.filter((i) => !q || i.name.includes(q) || i.family.replace(/_/g, ' ').includes(q));
});

/** The rows with a family heading wherever the family changes. */
const rows = computed(() => {
  const out: ({ kind: 'family'; family: string } | { kind: 'item'; item: InstrumentInfo; index: number })[] = [];
  let last = '';
  shown.value.forEach((item, index) => {
    if (item.family !== last) {
      last = item.family;
      out.push({ kind: 'family', family: item.family.replace(/_/g, ' ') });
    }
    out.push({ kind: 'item', item, index });
  });
  return out;
});

watch(query, () => {
  at.value = 0;
});

const move = (by: number) => {
  if (!shown.value.length) return;
  at.value = (at.value + by + shown.value.length) % shown.value.length;
  list.value?.querySelector<HTMLElement>(`[data-index="${at.value}"]`)?.scrollIntoView({ block: 'nearest' });
};

const take = () => {
  const item = shown.value[at.value];
  if (item) emit('pick', item.guid);
};

const onKey = (event: KeyboardEvent) => {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      move(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      move(-1);
      break;
    case 'Enter':
      event.preventDefault();
      take();
      break;
    case 'Escape':
      event.preventDefault();
      emit('cancel');
      break;
    default:
      break;
  }
};

onMounted(() => search.value?.focus());
</script>

<template>
  <div class="picker-box" @keydown="onKey">
    <p class="picker-title">{{ title }}</p>
    <input
      ref="search"
      v-model="query"
      type="text"
      class="picker-search"
      placeholder="type to search…"
      autocomplete="off"
      aria-label="Search instruments"
    >
    <div ref="list" class="picker-list picker-tall" role="listbox">
      <template v-for="(row, i) in rows" :key="i">
        <div v-if="row.kind === 'family'" class="picker-family">{{ row.family }}</div>
        <button
          v-else
          type="button"
          class="picker-row"
          :class="{ at: row.index === at }"
          :data-index="row.index"
          role="option"
          :aria-selected="row.index === at"
          @mouseenter="at = row.index"
          @click="emit('pick', row.item.guid)"
        >
          <Glyph :family="row.item.family" :colour="row.item.colour" />
          <span>{{ row.item.name }}</span>
        </button>
      </template>
      <div v-if="!shown.length" class="picker-none">nothing matches</div>
    </div>
    <div class="row picker-foot">
      <span class="hintline" style="margin:0"><kbd>↑</kbd><kbd>↓</kbd> move, <kbd>Enter</kbd> picks, <kbd>Esc</kbd> cancels</span>
      <span class="spacer"></span>
      <button type="button" @click="emit('cancel')">cancel</button>
    </div>
  </div>
</template>
