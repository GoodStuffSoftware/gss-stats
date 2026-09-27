<script setup lang="ts">
// A generic inline renderer for a token list (lib/textLite.ts TextToken[]) — the metric
// components' equivalent of NoteBlock.vue, but inline (<span>, no severity color) since a
// MetricItem's label and caption sit next to a value, not on their own line. Never v-html:
// the tokens are already the safe, parsed output of lib/metrics/render.ts's label/caption
// resolution (resolveLabelTokens / valueCaptionTokens), which itself only ever calls through
// lib/textLite.ts's tokenizeAndInterpolate or lib/notes.ts's noteTokens.
import type { TextToken } from '../../lib/textLite'

defineProps<{ tokens: TextToken[] }>()
</script>

<template>
  <span class="metric-label">
    <template v-for="(t, i) in tokens" :key="i">
      <strong v-if="t.type === 'bold'">{{ t.value }}</strong>
      <a v-else-if="t.type === 'link'" :href="t.href" target="_blank" rel="noopener noreferrer">{{ t.value }}</a>
      <template v-else>{{ t.value }}</template>
    </template>
  </span>
</template>

<style scoped>
.metric-label strong {
  font-weight: 600;
}
.metric-label a {
  color: rgb(var(--amber-hover));
  text-decoration: underline;
}
</style>
