<script setup lang="ts">
/**
 * The one drop zone, shared by the live player, the renderer and the MIDI page.
 *
 * ❗ **This markup was written out three times**, in `live.html`, `render.html`
 * and `midi.html`, and it had already drifted: two pages set
 * `autocomplete="off"` on the file inputs and the third did not, and the third
 * styled the zone through a class where the others used the id. Its CSS was
 * copied three times too. Both now exist once — the rules live in `ui.css`
 * under `.drop`.
 *
 * ⚠️ **The zone takes drops and nothing else.** Making a click anywhere on it
 * open the file picker looked convenient and was a bug: pressing "open a
 * folder" opened BOTH pickers, because `input.click()` dispatches a click on the
 * input that bubbles straight back up to the zone, where it is indistinguishable
 * from a click on the background. Two buttons, one job each, and the drag stays
 * for a file or a folder.
 *
 * ❗ **The archive is the third button and it lives here** rather than beside
 * each page's own wiring. Three pages open levels; the last time two of them
 * grew their own copy of something this small it cost a day.
 */
import { ref, useTemplateRef } from 'vue';

const emit = defineEmits<{ files: [files: File[]]; drop: [transfer: DataTransfer] }>();

const title = ref('Open a level, or a whole backup');
const hint = ref('Drop a level, a backup folder or a zip here — or use the buttons.');
const busy = ref(false);
const loaded = ref(false);
const over = ref(false);

const fileInput = useTemplateRef<HTMLInputElement>('fileInput');
const folderInput = useTemplateRef<HTMLInputElement>('folderInput');
const archiveButton = useTemplateRef<HTMLButtonElement>('archiveButton');
const archiveHost = useTemplateRef<HTMLDivElement>('archiveHost');

/**
 * ❗ **The input is cleared after every pick**, which is not tidiness: without
 * it, choosing the *same* file again fires no `change` at all, and re-reading a
 * level you have just re-exported from the game silently does nothing. Only
 * `render-app.ts` used to do this, so the other two pages had the bug.
 */
const take = (input: HTMLInputElement | null) => {
  if (!input?.files) return;
  const files = [...input.files];
  input.value = '';
  if (files.length) emit('files', files);
};

const onDrop = (event: DragEvent) => {
  over.value = false;
  if (event.dataTransfer) emit('drop', event.dataTransfer);
};

/**
 * ⚠️ **Setters, not the refs themselves.** `defineExpose` unwraps a ref on the
 * way out, so a caller writing `ui.busy.value = true` gets
 * `Cannot create property 'value' on boolean 'false'` — and only at the moment
 * the zone is first used, which on this page is after a level has been read.
 */
defineExpose({
  say: (nextTitle: string, nextHint?: string) => {
    title.value = nextTitle;
    if (nextHint !== undefined) hint.value = nextHint;
  },
  setBusy: (on: boolean) => {
    busy.value = on;
  },
  setLoaded: (on: boolean) => {
    loaded.value = on;
  },
  archiveButton,
  archiveHost,
});
</script>

<template>
  <div
    class="drop"
    :class="{ busy, loaded, over }"
    @dragenter.prevent="over = true"
    @dragover.prevent="over = true"
    @dragleave.prevent="over = false"
    @drop.prevent="onDrop"
  >
    <strong>{{ title }}</strong>
    <span>{{ hint }}</span>
    <input ref="fileInput" type="file" autocomplete="off" @change="take(fileInput)">
    <!--
      Dropping a folder works on its own; this is for the browsers and
      situations where the drop is not offered. `webkitdirectory` is the only
      widely supported way to pick one.
    -->
    <input
      ref="folderInput"
      type="file"
      webkitdirectory
      autocomplete="off"
      @change="take(folderInput)"
    >
    <div class="row" style="margin-top:.6rem; justify-content:center; gap:.5rem">
      <button type="button" class="ghost" @click="fileInput?.click()">open a file…</button>
      <button type="button" class="ghost" @click="folderInput?.click()">open a folder…</button>
      <button ref="archiveButton" type="button" class="ghost">from the online archive…</button>
    </div>
  </div>
  <!-- Filled by `archive-panel.ts` the first time the button is pressed. -->
  <div ref="archiveHost"></div>
</template>
