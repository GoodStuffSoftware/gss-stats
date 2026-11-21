<script setup lang="ts">
// The ONE category list of the Budget section (ADR 0005: no one-off widgets): a colour dot beside a searchable
// combobox. Every place that lists categories uses this component. It only reports the choice: `change(value)` for
// an option, `add(name)` for `Add category "<name>"` (offered when `allowAdd` is set and the trimmed text matches no
// option, ignoring case); the owner decides what either means and shows the result through `value`/`options`.
//
// Behaviour (WAI-ARIA combobox with list autocomplete, manual selection): the input has role="combobox" and keeps
// focus; the popup is a role="listbox" and the active option is named by aria-activedescendant. Click or tap opens it
// (the current label is selected, so typing replaces it); typing filters it, case-insensitive, matching anywhere in the
// name. Down/Up move (opening the list first), Enter picks the active option, Esc closes and keeps the old value, Tab
// or leaving the field closes without a change. The popup is position: fixed, so no scrolling table clips it, and it
// opens upward when there is more room above. Phone card layout: 44 px tall field and options, 16 px text (no iOS zoom).
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import type { SelectOption } from '../table/EditableTable.vue'
import { CATEGORY_NAME_MAX, categoryNameKey, checkCategoryName } from '../../lib/budget/categoryName'

const props = defineProps<{
  value: string
  options: SelectOption[]
  /** CSS colour of the dot. */
  color: string
  label: string
  disabled?: boolean
  /** Offer `Add category "<text>"` when the text matches no option. */
  allowAdd?: boolean
}>()
const emit = defineEmits<{ change: [value: string]; add: [name: string] }>()

const uid = useId()
const listId = `${uid}-list`
const optId = (i: number) => `${uid}-opt-${i}`

const input = ref<HTMLInputElement | null>(null)
const list = ref<HTMLElement | null>(null)
const open = ref(false)
const typed = ref(false) // the user has typed since opening: the field shows the search text, not the current label
const query = ref('')
const active = ref(-1)
const place = ref<Record<string, string>>({})

const selectedLabel = computed(() => props.options.find((o) => o.value === props.value)?.label ?? '')
const needle = computed(() => query.value.trim().replace(/\s+/g, ' ').toLocaleLowerCase())
const matches = computed(() => (needle.value ? props.options.filter((o) => o.label.toLocaleLowerCase().includes(needle.value)) : props.options))

const trimmed = computed(() => query.value.trim().replace(/ {2,}/g, ' '))
const nameCheck = computed(() => checkCategoryName(trimmed.value))
const tooLong = computed(() => props.allowAdd && trimmed.value.length > CATEGORY_NAME_MAX)
const canAdd = computed(() => {
  if (!props.allowAdd || !trimmed.value || !nameCheck.value.ok) return false
  const key = categoryNameKey(trimmed.value)
  return !props.options.some((o) => categoryNameKey(o.label) === key)
})

interface Item {
  idx: number // position among the choosable items; -1 = a disabled option
  value: string
  label: string
  disabled: boolean
  add: boolean
}
interface Section {
  group: string | null
  items: Item[]
}
/** Matching options (ungrouped first, then each group in order), then the Add choice. */
const sections = computed<Section[]>(() => {
  let n = 0
  const mk = (o: SelectOption): Item => ({ idx: o.disabled ? -1 : n++, value: o.value, label: o.label, disabled: !!o.disabled, add: false })
  const out: Section[] = []
  const loose = matches.value.filter((o) => !o.group)
  if (loose.length) out.push({ group: null, items: loose.map(mk) })
  for (const g of [...new Set(matches.value.filter((o) => o.group).map((o) => o.group as string))]) {
    out.push({ group: g, items: matches.value.filter((o) => o.group === g).map(mk) })
  }
  if (canAdd.value) out.push({ group: null, items: [{ idx: n++, value: '', label: `Add category "${trimmed.value}"`, disabled: false, add: true }] })
  return out
})
const choosable = computed(() => sections.value.flatMap((s) => s.items).filter((i) => i.idx >= 0))
const noMatch = computed(() => choosable.value.length === 0)
const announce = computed(() => {
  if (!open.value) return ''
  const n = choosable.value.length
  return n === 0 ? 'No matching categories' : `${n} ${n === 1 ? 'choice' : 'choices'}`
})

function placePopup() {
  const el = input.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const vv = window.visualViewport
  const top = vv?.offsetTop ?? 0
  const height = vv?.height ?? window.innerHeight
  const below = top + height - r.bottom - 8
  const above = r.top - top - 8
  const up = below < 180 && above > below
  const room = Math.max(120, Math.min(280, up ? above : below))
  const width = Math.max(r.width, 200)
  const left = Math.max(4, Math.min(r.left, window.innerWidth - width - 4))
  place.value = {
    left: `${left}px`,
    width: `${width}px`,
    maxHeight: `${room}px`,
    ...(up ? { bottom: `${window.innerHeight - r.top + 2}px` } : { top: `${r.bottom + 2}px` }),
  }
}
function onOutsideScroll(e: Event) {
  if (list.value && e.target instanceof Node && list.value.contains(e.target)) return
  close()
}
function scrollActive() {
  void nextTick(() => list.value?.querySelector<HTMLElement>(`[id="${optId(active.value)}"]`)?.scrollIntoView?.({ block: 'nearest' }))
}
function openList() {
  if (props.disabled || open.value) return
  open.value = true
  typed.value = false
  query.value = ''
  active.value = Math.max(0, choosable.value.findIndex((i) => i.value === props.value && !i.add))
  placePopup()
  window.addEventListener('scroll', onOutsideScroll, true)
  window.addEventListener('resize', placePopup)
  scrollActive()
}
function close() {
  if (!open.value) return
  open.value = false
  typed.value = false
  query.value = ''
  active.value = -1
  window.removeEventListener('scroll', onOutsideScroll, true)
  window.removeEventListener('resize', placePopup)
}
onBeforeUnmount(close)
watch(() => props.disabled, (d) => d && close())

function onClick() {
  if (!open.value) {
    openList()
    input.value?.select()
  }
}
function onInput(e: Event) {
  const text = (e.target as HTMLInputElement).value
  if (!open.value) openList()
  query.value = text
  typed.value = true
  active.value = choosable.value.length ? 0 : -1
  placePopup()
  scrollActive()
}
function move(delta: number) {
  const n = choosable.value.length
  if (!n) return
  active.value = (active.value + delta + n) % n
  scrollActive()
}
function choose(item: Item | undefined) {
  if (!item || item.disabled) return
  if (item.add) {
    const name = trimmed.value
    close()
    emit('add', name)
    return
  }
  const changed = item.value !== props.value
  close()
  if (changed) emit('change', item.value)
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!open.value) openList()
    else move(e.key === 'ArrowDown' ? 1 : -1)
  } else if (e.key === 'Enter') {
    if (open.value) {
      e.preventDefault()
      choose(choosable.value[active.value])
    }
  } else if (e.key === 'Escape') {
    if (open.value) {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  } else if (e.key === 'Tab') {
    close()
  }
}
</script>

<template>
  <span class="cs">
    <span class="cs-dot" :style="{ background: color }" aria-hidden="true" />
    <input
      ref="input"
      class="cs-input"
      type="text"
      role="combobox"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="open ? listId : undefined"
      :aria-activedescendant="open && active >= 0 ? optId(active) : undefined"
      :aria-label="label"
      :disabled="disabled"
      :value="open && typed ? query : selectedLabel"
      @click="onClick"
      @input="onInput"
      @keydown="onKeydown"
      @blur="close"
    />
    <span class="cs-caret" aria-hidden="true">▾</span>
      <div
        v-if="open"
        :id="listId"
        ref="list"
        class="cs-list"
        role="listbox"
        :aria-label="`${label} choices`"
        :style="place"
        @mousedown.prevent
      >
        <template v-for="(s, si) in sections" :key="si">
          <div v-if="s.group" role="group" :aria-label="s.group">
            <div class="cs-group" aria-hidden="true">{{ s.group }}</div>
            <div
              v-for="it in s.items"
              :id="it.idx >= 0 ? optId(it.idx) : undefined"
              :key="it.value"
              class="cs-opt"
              :class="{ on: it.idx === active, sel: it.value === value, off: it.disabled }"
              role="option"
              :aria-selected="it.value === value"
              :aria-disabled="it.disabled || undefined"
              @click="choose(it)"
              @mousemove="it.idx >= 0 && (active = it.idx)"
            >{{ it.label }}</div>
          </div>
          <template v-else>
            <div
              v-for="it in s.items"
              :id="optId(it.idx)"
              :key="it.add ? '__add__' : it.value"
              class="cs-opt"
              :class="{ on: it.idx === active, sel: !it.add && it.value === value, add: it.add }"
              role="option"
              :aria-selected="!it.add && it.value === value"
              @click="choose(it)"
              @mousemove="active = it.idx"
            >{{ it.label }}</div>
          </template>
        </template>
        <div v-if="noMatch" class="cs-empty">{{ tooLong ? `A category name is at most ${CATEGORY_NAME_MAX} characters.` : 'No matching category.' }}</div>
      </div>
    <span class="cs-sr" role="status" aria-live="polite">{{ announce }}</span>
  </span>
</template>

<style scoped>
.cs {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.cs-dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.cs-input {
  flex: 1;
  min-width: 0;
  min-height: 32px;
  font: inherit;
  color: rgb(var(--ink));
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 6px;
  padding: 4px 24px 4px 6px;
  text-overflow: ellipsis;
}
.cs-input:disabled {
  opacity: 0.6;
}
.cs-caret {
  position: absolute;
  right: 8px;
  font-size: 11px;
  color: rgb(var(--ink-3));
  pointer-events: none;
}
.cs-list {
  position: fixed;
  z-index: 1200;
  overflow-y: auto;
  overscroll-behavior: contain;
  box-sizing: border-box;
  padding: 4px;
  background: rgb(var(--surface));
  border: 1px solid rgb(var(--line-2));
  border-radius: 8px;
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.16);
}
.cs-group {
  padding: 6px 8px 2px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: rgb(var(--ink-3));
}
.cs-opt {
  display: flex;
  align-items: center;
  min-height: 36px;
  padding: 4px 8px;
  border-radius: 6px;
  color: rgb(var(--ink));
  cursor: pointer;
}
.cs-opt.on {
  background: rgb(var(--sunken));
}
.cs-opt.sel {
  font-weight: 600;
}
.cs-opt.add {
  font-style: italic;
  border-top: 1px solid rgb(var(--line-2));
  border-radius: 0 0 6px 6px;
}
.cs-opt.off {
  opacity: 0.5;
  cursor: default;
}
.cs-empty {
  padding: 8px;
  font-size: 13px;
  color: rgb(var(--ink-2));
}
.cs-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
/* Phone card layout: full width, 44 px tall, 16 px text (a smaller font makes iOS zoom the page on focus). */
:global(.et-cards) .cs-input {
  min-height: 44px;
  font-size: 16px;
}
:global(.et-cards) .cs-opt {
  min-height: 44px;
  font-size: 16px;
}
</style>
