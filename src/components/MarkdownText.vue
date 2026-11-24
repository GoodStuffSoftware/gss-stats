<script setup lang="ts">
// Renders a budget note's markdown (lib/noteMarkdown.ts) through template bindings only: the tokenizer
// returns plain data, so there is no v-html and no HTML string (ADR 0003); raw HTML in a note shows as
// text. `inline` flattens paragraphs, line breaks and lists into one run of spans for a clamped cell.
import { computed } from 'vue'
import { parseNoteMarkdown, type NoteBlock, type NoteInline } from '../lib/noteMarkdown'

const props = defineProps<{ text: string; inline?: boolean }>()

const blocks = computed<NoteBlock[]>(() => parseNoteMarkdown(props.text ?? ''))

// Inline mode: every line and list item in one flat token list, joined by a space (list items keep a
// bullet or number so the structure stays readable).
const flat = computed<NoteInline[]>(() => {
  const out: NoteInline[] = []
  const sep = () => {
    if (out.length) out.push({ type: 'text', value: ' ' })
  }
  for (const b of blocks.value) {
    if (b.type === 'p') {
      for (const line of b.lines) {
        sep()
        out.push(...line)
      }
    } else {
      b.items.forEach((item, n) => {
        sep()
        out.push({ type: 'text', value: b.type === 'ul' ? '• ' : `${n + 1}. ` }, ...item)
      })
    }
  }
  return out
})
</script>

<template>
  <span v-if="inline" class="md md-inline">
    <template v-for="(t, i) in flat" :key="i">
      <strong v-if="t.type === 'bold'">{{ t.value }}</strong>
      <em v-else-if="t.type === 'italic'">{{ t.value }}</em>
      <code v-else-if="t.type === 'code'">{{ t.value }}</code>
      <a v-else-if="t.type === 'link'" :href="t.href" target="_blank" rel="noopener noreferrer">{{ t.value }}</a>
      <template v-else>{{ t.value }}</template>
    </template>
  </span>
  <div v-else class="md">
    <template v-for="(b, n) in blocks" :key="n">
      <p v-if="b.type === 'p'">
        <template v-for="(line, l) in b.lines" :key="l">
          <br v-if="l > 0" />
          <template v-for="(t, i) in line" :key="i">
            <strong v-if="t.type === 'bold'">{{ t.value }}</strong>
            <em v-else-if="t.type === 'italic'">{{ t.value }}</em>
            <code v-else-if="t.type === 'code'">{{ t.value }}</code>
            <a v-else-if="t.type === 'link'" :href="t.href" target="_blank" rel="noopener noreferrer">{{ t.value }}</a>
            <template v-else>{{ t.value }}</template>
          </template>
        </template>
      </p>
      <component :is="b.type" v-else>
        <li v-for="(item, k) in b.items" :key="k">
          <template v-for="(t, i) in item" :key="i">
            <strong v-if="t.type === 'bold'">{{ t.value }}</strong>
            <em v-else-if="t.type === 'italic'">{{ t.value }}</em>
            <code v-else-if="t.type === 'code'">{{ t.value }}</code>
            <a v-else-if="t.type === 'link'" :href="t.href" target="_blank" rel="noopener noreferrer">{{ t.value }}</a>
            <template v-else>{{ t.value }}</template>
          </template>
        </li>
      </component>
    </template>
  </div>
</template>

<style scoped>
.md p,
.md ul,
.md ol {
  margin: 0;
}
.md p + p,
.md p + ul,
.md p + ol,
.md ul + p,
.md ol + p {
  margin-top: 0.4em;
}
.md ul,
.md ol {
  padding-left: 1.3em;
}
.md code {
  font-family: ui-monospace, 'Cascadia Mono', Menlo, monospace;
  font-size: 0.92em;
  padding: 0 0.25em;
  border-radius: 3px;
  background: rgb(var(--ink-3) / 0.12);
}
.md a {
  color: rgb(var(--amber-hover));
  text-decoration: underline;
}
</style>
