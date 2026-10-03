<script setup lang="ts">
// ONE reusable caveat/note renderer — used by the 'note' widget type, by every note under a
// chart (lib/chartNotes.ts: the widget's plain-text caption and the data caveats), by every inline
// caveat a widget body shows, and by App.vue's page-level banners. Give it EITHER `noteId` (looked up in lib/notes.ts's registry) or `text` (custom,
// e.g. a user's own free-text note widget) — never both meaningfully at once, but `text`
// wins if both are somehow set. `vars` interpolates data-driven values into a registry
// note's `{varName}` placeholders (see lib/textLite.ts) — merged over the note's own
// defaults. Rendered via a safe token list (lib/textLite.ts tokenizeAndInterpolate: the
// template is tokenized BEFORE vars are substituted, so a var's own value can never itself
// be interpreted as new bold/link markup — see that function's doc comment), NEVER v-html.
import { computed } from 'vue'
import { getNote, isNoteActive, noteTokens, type NoteSeverity } from '../lib/notes'
import { tokenizeAndInterpolate, type TextToken } from '../lib/textLite'

const props = defineProps<{
  noteId?: string
  text?: string
  severity?: NoteSeverity
  vars?: Record<string, string | number>
}>()

const def = computed(() => (props.noteId ? getNote(props.noteId) : undefined))
const active = computed(() => !props.noteId || isNoteActive(props.noteId))
const tokens = computed<TextToken[]>(() => {
  if (props.text) return tokenizeAndInterpolate(props.text, props.vars)
  if (props.noteId) return noteTokens(props.noteId, props.vars)
  return []
})
const hasContent = computed(() => tokens.value.some((t) => t.value))
const resolvedSeverity = computed<NoteSeverity>(() => props.severity ?? def.value?.severity ?? 'info')
</script>

<template>
  <p v-if="active && hasContent" class="note-block" :class="resolvedSeverity">
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
