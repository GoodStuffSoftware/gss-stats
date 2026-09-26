<script setup lang="ts">
// ONE reusable caveat/note renderer (owner requirement, 2026-09-26) — used by the 'note'
// widget type, by every inline caveat a widget body shows, and by App.vue's page-level
// banners. Give it EITHER `noteId` (looked up in lib/notes.ts's registry) or `text` (custom,
// e.g. a user's own free-text note widget) — never both meaningfully at once, but `text`
// wins if both are somehow set. `vars` interpolates data-driven values into a registry
// note's `{varName}` placeholders (see lib/textLite.ts) — merged over the note's own
// defaults. Rendered via parseTextLite's token list, NEVER v-html — a link/bold marker in
// the source text can't inject markup.
import { computed } from 'vue'
import { getNote, isNoteActive, noteRawText, type NoteSeverity } from '../lib/notes'
import { parseTextLite, interpolate } from '../lib/textLite'

const props = defineProps<{
  noteId?: string
  text?: string
  severity?: NoteSeverity
  vars?: Record<string, string | number>
}>()

const def = computed(() => (props.noteId ? getNote(props.noteId) : undefined))
const active = computed(() => !props.noteId || isNoteActive(props.noteId))
const rawText = computed(() => {
  if (props.text) return interpolate(props.text, props.vars)
  if (props.noteId) return noteRawText(props.noteId, props.vars)
  return ''
})
const tokens = computed(() => parseTextLite(rawText.value))
const resolvedSeverity = computed<NoteSeverity>(() => props.severity ?? def.value?.severity ?? 'info')
</script>

<template>
  <p v-if="active && rawText" class="note-block" :class="resolvedSeverity">
    <template v-for="(t, i) in tokens" :key="i">
      <strong v-if="t.type === 'bold'">{{ t.value }}</strong>
      <a v-else-if="t.type === 'link'" :href="t.href" target="_blank" rel="noopener noreferrer">{{ t.value }}</a>
      <template v-else>{{ t.value }}</template>
    </template>
  </p>
</template>

<style scoped>
.note-block {
  font-size: 11.5px;
  color: rgb(var(--ink-3));
  margin: 0;
}
.note-block.caveat {
  color: rgb(var(--ink-3));
}
.note-block.warning {
  color: #bc4749;
}
.note-block.info {
  color: rgb(var(--ink-2));
}
.note-block strong {
  font-weight: 600;
  color: rgb(var(--ink-2));
}
.note-block a {
  color: rgb(var(--amber-hover));
  text-decoration: underline;
}
</style>
