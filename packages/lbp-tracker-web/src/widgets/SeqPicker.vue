<script setup lang="ts">
/**
 * The song picker: a search box over the list of songs, inside the open dialog.
 *
 * ⚠️ **A native `<select>` with a search box beside it was the first attempt and
 * it was wrong.** Two controls for one choice, the box doing nothing until you
 * notice what it is for, and the list still a native popup that cannot show a
 * filter. The second was one field opening a floating panel, which fought the
 * dialog it lives in: a list taller than the box made the dialog scroll and
 * clipped it. So the list is simply there, in the dialog, and typing filters it.
 *
 * ❗ **The `escape()` this replaced was not decoration.** The old markup was one
 * `innerHTML` string, and only the song's *name* went through an escaper; the
 * detail column, which carries a **filename out of the opened backup**, did not.
 * A zip holding a file named `<img src=x onerror=…>` therefore ran it, and the
 * archive button downloads other people's zips by design. There is no escaper
 * here because there is nothing to escape: `{{ }}` is text.
 */
import { computed, ref, useTemplateRef, watch } from 'vue';
import { detail, title, type PickerState, type SeqRow } from './picker-state.ts';

const props = defineProps<{
  state: PickerState;
  onPick: (key: string) => void;
  /** Save the chosen song as a file; the button appears only when this is given. */
  onSave?: (key: string) => void;
}>();

const needle = ref('');
/** Which row the arrow keys are on; -1 when nothing is highlighted. */
const cursor = ref(-1);

const listEl = useTemplateRef<HTMLElement>('list');

const shown = computed(() => {
  const q = needle.value.trim().toLowerCase();
  return props.state.rows.filter((r) => q === '' || title(r).toLowerCase().includes(q));
});
const current = computed(() => props.state.rows.find((r) => r.key === props.state.chosen));

// A new level: the search starts empty and the chosen row is in view.
watch(() => props.state.rows, async () => {
  needle.value = '';
  cursor.value = -1;
  await Promise.resolve();
  listEl.value?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
});

/** Choose a row. `quiet` selects without telling the page. */
const pick = (key: string, quiet = false) => {
  if (key === props.state.chosen) return;
  props.state.chosen = key;
  if (!quiet) props.onPick(key);
};
defineExpose({ pick });

const onKey = async (event: KeyboardEvent) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!shown.value.length) return;
    const step = event.key === 'ArrowDown' ? 1 : shown.value.length - 1;
    cursor.value = (cursor.value + step) % shown.value.length;
    await Promise.resolve();
    listEl.value?.children[cursor.value]?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter') {
    const row: SeqRow | undefined = shown.value[cursor.value] ?? (shown.value.length === 1 ? shown.value[0] : undefined);
    if (row) pick(row.key);
  } else {
    return;
  }
  event.preventDefault();
};
</script>

<template>
  <div v-if="state.rows.length" class="picker">
    <div class="row">
      <input
        v-model="needle"
        class="picker-search"
        type="text"
        placeholder="search the songs…"
        aria-label="Search songs"
        autocomplete="off"
        @input="cursor = shown.length ? 0 : -1"
        @keydown="onKey"
      >
      <button
        v-if="onSave"
        type="button"
        class="picker-save"
        title="Save the chosen song as a song file"
        :disabled="!current"
        @click="current && onSave(current.key)"
      >save as a song file</button>
    </div>
    <div ref="list" class="picker-list picker-tall" role="listbox">
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
</template>
