<script setup lang="ts">
// In-place rename: a page or group name turns into this text field (the drawer's rows and group
// headers, the breadcrumb's segments, the page menu's "New group…"). It opens focused with the
// name selected. Enter or leaving the field saves; Esc cancels; an empty name (or an unchanged one)
// changes nothing. A name `validate` refuses (e.g. another group's name) shows its message under
// the field and Enter keeps it open; leaving the field then reverts. Keys typed here stay here, so
// the menu, drawer or page shortcuts around it don't react to them (Tab still moves on).
import { nextTick, onMounted, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    value: string
    label: string
    maxlength?: number
    /** Why a (cleaned) name can't be used, or null. */
    validate?: (name: string) => string | null
    /** Tidy the typed name before it's checked and saved (collapse spaces, trim, cap). */
    clean?: (raw: string) => string
    placeholder?: string
  }>(),
  { maxlength: 80, validate: undefined, clean: (raw: string) => raw.replace(/\s+/g, ' ').trim(), placeholder: undefined },
)
const emit = defineEmits<{ save: [name: string]; cancel: [] }>()

const draft = ref(props.value)
const error = ref<string | null>(null)
const input = ref<HTMLInputElement | null>(null)
let done = false
const errId = `inline-name-err-${Math.random().toString(36).slice(2, 8)}`

onMounted(async () => {
  await nextTick()
  input.value?.focus({ preventScroll: true })
  input.value?.select()
})

/** Enter (`keepOpen`: a refused name stays open with its message) or leaving the field (reverts). */
function commit(keepOpen: boolean) {
  if (done) return
  const name = props.clean(draft.value)
  if (!name || name === props.value) return finish(null)
  const why = props.validate?.(name) ?? null
  if (why) {
    if (keepOpen) {
      error.value = why
      return
    }
    return finish(null)
  }
  finish(name)
}
function finish(name: string | null) {
  done = true
  if (name === null) emit('cancel')
  else emit('save', name)
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Tab') return
  e.stopPropagation()
  if (e.key === 'Enter') {
    e.preventDefault()
    commit(true)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    if (!done) finish(null)
  }
}
function onInput() {
  error.value = null
}
</script>

<template>
  <span class="inline-name">
    <input
      ref="input"
      v-model="draft"
      type="text"
      class="in-input"
      :aria-label="label"
      :maxlength="maxlength"
      :placeholder="placeholder"
      :aria-invalid="!!error"
      :aria-describedby="error ? errId : undefined"
      autocomplete="off"
      spellcheck="false"
      @keydown="onKeydown"
      @input="onInput"
      @blur="commit(false)"
      @click.stop
      @dblclick.stop
    />
    <span v-if="error" :id="errId" class="in-err" role="alert">{{ error }}</span>
  </span>
</template>

<style scoped>
.inline-name {
  position: relative;
  display: inline-flex;
  flex: 1;
  min-width: 0;
}
.in-input {
  width: 100%;
  min-width: 0;
  padding: 3px 6px;
  border: 1px solid rgb(var(--amber));
  border-radius: 6px;
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  font: inherit;
  outline: none;
  box-shadow: 0 0 0 3px rgb(var(--amber) / 0.2);
}
.in-input[aria-invalid='true'] {
  border-color: #bc4749;
  box-shadow: 0 0 0 3px rgb(188 71 73 / 0.18);
}
.in-err {
  position: absolute;
  z-index: 5;
  top: calc(100% + 4px);
  left: 0;
  max-width: 260px;
  padding: 4px 8px;
  border-radius: 6px;
  background: #bc4749;
  color: #fff;
  font: 500 11.5px Inter, system-ui, sans-serif;
  white-space: normal;
  box-shadow: 0 6px 16px rgb(0 0 0 / 0.18);
}
</style>
