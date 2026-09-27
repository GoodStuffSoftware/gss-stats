<script setup lang="ts">
// A card's status line: "Updated Xs ago" with a reload control, or — while any value on the
// card failed to load — the error with Retry. Visible text only: MetricCard announces the error
// through its own live region, which exists from mount (a region created together with its
// text is often not announced).
import { noteRawText } from '../../lib/notes'

defineProps<{ hasError: boolean; updatedText: string }>()
const emit = defineEmits<{ reload: [] }>()
const L = { refresh: noteRawText('label.card.refresh'), failed: noteRawText('label.card.loadFailed'), retry: noteRawText('label.card.retry') }
</script>

<template>
  <span class="mc-status">
    <template v-if="hasError"
      ><span class="mc-error">{{ L.failed }}</span> <button type="button" class="mc-retry" @click.stop="emit('reload')">{{ L.retry }}</button></template
    >
    <template v-else>
      <span v-if="updatedText" class="mc-updated">{{ updatedText }}</span>
      <button type="button" class="mc-reload" :title="L.refresh" :aria-label="L.refresh" @click.stop="emit('reload')">↻</button>
    </template>
  </span>
</template>

<style scoped>
.mc-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.mc-updated {
  font-size: 11px;
  color: rgb(var(--ink-3));
  font-family: 'JetBrains Mono', monospace;
}
.mc-error {
  font-size: 11px;
  color: #bc4749;
}
.mc-retry {
  border: 1px solid rgb(var(--line));
  background: transparent;
  color: rgb(var(--ink-2));
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 7px;
  cursor: pointer;
}
.mc-reload {
  border: none;
  background: transparent;
  color: rgb(var(--ink-3));
  font-size: 15px;
  padding: 3px 7px;
  border-radius: 7px;
  cursor: pointer;
}
.mc-reload:hover,
.mc-retry:hover {
  background: rgb(var(--sunken));
  color: rgb(var(--ink));
}
</style>
