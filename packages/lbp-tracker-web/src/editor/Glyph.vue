<script setup lang="ts">
/** The family glyph inline in a template: a canvas swapped whenever the family or the colour changes. */
import { onMounted, useTemplateRef, watch } from 'vue';
import { glyphCanvas } from './glyph.ts';

const props = defineProps<{ family: string; colour: string; icon?: string; size?: number }>();
const host = useTemplateRef<HTMLSpanElement>('host');

const paint = () => {
  const el = host.value;
  if (!el) return;
  el.textContent = '';
  el.append(glyphCanvas({ family: props.family, colour: props.colour, icon: props.icon ?? '' }, props.size ?? 18));
};
onMounted(paint);
watch(() => [props.family, props.colour, props.icon, props.size], paint);
</script>

<template>
  <span ref="host" class="glyph-host"></span>
</template>
