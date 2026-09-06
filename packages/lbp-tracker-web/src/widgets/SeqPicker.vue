<script setup lang="ts">
/**
 * The song picker: one searchable control, shared by three pages.
 *
 * ⚠️ **A native `<select>` with a search box beside it was the first attempt and
 * it was wrong.** Two controls for one choice, the box doing nothing until you
 * notice what it is for, and the list still a native popup that cannot show a
 * filter. This is one control: it reads as a field, it opens a panel with the
 * matches in it, and typing filters them.
 *
 * ❗ **The `escape()` this replaced was not decoration.** The old markup was one
 * `innerHTML` string, and only the song's *name* went through an escaper — the
 * detail column, which carries a **filename out of the opened backup**, did not.
 * A zip holding a file named `<img src=x onerror=…>` therefore ran it, and the
 * archive button downloads other people's zips by design. There is no escaper
 * here because there is nothing to escape: `{{ }}` is text.
 */
import { computed, onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import { detail, title, type PickerState, type SeqRow } from './picker-state.ts';

const props = defineProps<{ state: PickerState; onPick: (key: string) => void }>();

const open = ref(false);
const needle = ref('');
/** Which row the arrow keys are on; -1 when nothing is highlighted. */
const cursor = ref(-1);

const host = useTemplateRef<HTMLElement>('host');
const search = useTemplateRef<HTMLInputElement>('search');
const field = useTemplateRef<HTMLButtonElement>('field');
const listEl = useTemplateRef<HTMLElement>('list');

const shown = computed(() => {
  const q = needle.value.trim().toLowerCase();
  return props.state.rows.filter((r) => q === '' || title(r).toLowerCase().includes(q));
});
const current = computed(() => props.state.rows.find((r) => r.key === props.state.chosen));

const show = async () => {
  if (!props.state.rows.length) return;
  open.value = true;
  needle.value = '';
  cursor.value = shown.value.findIndex((r) => r.key === props.state.chosen);
  await Promise.resolve();
  search.value?.focus();
  listEl.value?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
};

/** Choose a row. `quiet` selects without telling the page. */
const pick = (key: string, quiet = false) => {
  open.value = false;
  if (key === props.state.chosen) return;
  props.state.chosen = key;
  if (!quiet) props.onPick(key);
};
defineExpose({ pick });

const onKey = async (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    open.value = false;
    field.value?.focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!shown.value.length) return;
    const step = event.key === 'ArrowDown' ? 1 : shown.value.length - 1;
    cursor.value = (cursor.value + step) % shown.value.length;
    await Promise.resolve();
    listEl.value?.children[cursor.value]?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') {
    const row = shown.value[cursor.value];
    if (cursor.value >= 0 && row) pick(row.key);
  } else {
    return;
  }
  event.preventDefault();
};

// Clicking away closes it. `pointerdown` rather than `click`, so it closes
// before whatever was clicked reacts.
const away = (event: PointerEvent) => {
  if (open.value && !host.value?.contains(event.target as Node)) open.value = false;
};
onMounted(() => document.addEventListener('pointerdown', away));
onUnmounted(() => document.removeEventListener('pointerdown', away));
</script>

<template>
  <div ref="host" class="picker">
    <button
      ref="field"
      type="button"
      class="picker-field"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :disabled="!state.rows.length"
      @click="open ? (open = false) : show()"
    >
      <span class="picker-name">{{ current ? title(current) : 'no level open' }}</span>
      <span class="picker-detail">{{ current ? detail(current) : '' }}</span>
    </button>

    <div class="picker-pop" :hidden="!open">
      <input
        ref="search"
        v-model="needle"
        class="picker-search"
        type="text"
        placeholder="search songs…"
        aria-label="Search songs"
        autocomplete="off"
        @input="cursor = shown.length ? 0 : -1"
        @keydown="onKey"
      >
      <div ref="list" class="picker-list" role="listbox">
        <button
          v-for="(row, i) in shown"
          :key="row.key"
          type="button"
          role="option"
          class="picker-row"
          :class="{ on: row.key === state.chosen, at: i === cursor }"
          :aria-selected="row.key === state.chosen"
          @click="pick(row.key)"
        >
          <span>{{ title(row) }}</span>
          <span class="picker-detail">{{ detail(row) }}</span>
        </button>
      </div>
      <div class="picker-none" :hidden="shown.length > 0">nothing matches</div>
    </div>
  </div>
</template>
