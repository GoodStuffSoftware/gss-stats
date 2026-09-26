<script setup lang="ts">
// type 'note' widget body — a static text tile carrying a caveat that used to be fixed page
// copy on a bespoke page (e.g. the small-sample note, the Android/Play rollout caveat, "no
// outcome tracking yet"). Movable/removable like any other widget; editable via ChartEditor
// (title + body only — no data source).
import type { Widget } from '../../types'
defineProps<{ widget: Widget }>()
</script>

<template>
  <div class="note-body mono">{{ widget.note || '(empty note)' }}</div>
</template>

<style scoped>
.note-body {
  height: 100%;
  display: flex;
  align-items: center;
  font-size: 12px;
  color: rgb(var(--ink-2));
  white-space: pre-wrap;
}
</style>
