<script setup lang="ts">
// The "longer/richer" counterpart to NoteBlock.vue — definitions, "how to read this" captions, section intros. Same safe **bold**/[link](url)
// tokenizer (lib/textLite.ts), split into paragraphs on a blank line; never v-html.
import { computed } from 'vue'
import { getNote, isNoteActive, noteTemplate } from '../lib/notes'
import { tokenizeAndInterpolate, splitParagraphs, type TextToken, type ValueResolver } from '../lib/textLite'

const props = defineProps<{
  noteId?: string
  text?: string
  title?: string
  vars?: Record<string, string | number>
  // Fills `{=…}` value tokens (lib/valueTokens.ts); without it every token shows "—".
  values?: ValueResolver
}>()

const def = computed(() => (props.noteId ? getNote(props.noteId) : undefined))
const active = computed(() => !props.noteId || isNoteActive(props.noteId))
// Split on the RAW template first (pure whitespace splitting — safe regardless of what a
// var's value contains), THEN tokenize + interpolate each paragraph separately (delta
// review, 2026-09-26: the template is tokenized before vars are substituted — see
// lib/textLite.ts tokenizeAndInterpolate — so a var's own value can never become markup).
const rawTemplate = computed(() => props.text ?? (props.noteId ? noteTemplate(props.noteId) : ''))
const mergedVars = computed<Record<string, string | number> | undefined>(() => {
  const defVars = def.value?.vars
  if (!defVars && !props.vars) return undefined
  return { ...(defVars as Record<string, string | number> | undefined), ...props.vars }
})
const paragraphs = computed<TextToken[][]>(() => splitParagraphs(rawTemplate.value).map((p) => tokenizeAndInterpolate(p, mergedVars.value, props.values)))
const hasContent = computed(() => paragraphs.value.some((tokens) => tokens.some((t) => t.value)))
</script>

<template>
  <div v-if="active && hasContent" class="text-block">
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
