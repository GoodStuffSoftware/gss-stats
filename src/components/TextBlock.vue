<script setup lang="ts">
// The "longer/richer" counterpart to NoteBlock.vue (owner requirement, 2026-09-26) —
// definitions, "how to read this" captions, section intros. Same safe **bold**/[link](url)
// tokenizer (lib/textLite.ts), split into paragraphs on a blank line; never v-html.
import { computed } from 'vue'
import { isNoteActive, noteRawText } from '../lib/notes'
import { parseTextLite, interpolate, splitParagraphs } from '../lib/textLite'

const props = defineProps<{
  noteId?: string
  text?: string
  title?: string
  vars?: Record<string, string | number>
}>()

const active = computed(() => !props.noteId || isNoteActive(props.noteId))
const rawText = computed(() => {
  if (props.text) return interpolate(props.text, props.vars)
  if (props.noteId) return noteRawText(props.noteId, props.vars)
  return ''
})
const paragraphs = computed(() => splitParagraphs(rawText.value).map((p) => parseTextLite(p)))
</script>

<template>
  <div v-if="active && rawText" class="text-block">
    <div v-if="title" class="text-block-title">{{ title }}</div>
    <p v-for="(tokens, pi) in paragraphs" :key="pi">
      <template v-for="(t, i) in tokens" :key="i">
        <strong v-if="t.type === 'bold'">{{ t.value }}</strong>
        <a v-else-if="t.type === 'link'" :href="t.href" target="_blank" rel="noopener noreferrer">{{ t.value }}</a>
        <template v-else>{{ t.value }}</template>
      </template>
    </p>
  </div>
</template>

<style scoped>
.text-block {
  font-size: 12.5px;
  color: rgb(var(--ink-2));
  line-height: 1.5;
}
.text-block-title {
  font-weight: 600;
  font-size: 13px;
  color: rgb(var(--ink));
  margin-bottom: 4px;
}
.text-block p {
  margin: 0 0 8px;
}
.text-block p:last-child {
  margin-bottom: 0;
}
.text-block strong {
  font-weight: 600;
  color: rgb(var(--ink));
}
.text-block a {
  color: rgb(var(--amber-hover));
  text-decoration: underline;
}
.text-block code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11.5px;
}
</style>
