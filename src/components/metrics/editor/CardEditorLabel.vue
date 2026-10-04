<script setup lang="ts">
// One Label editor (ADR 0003 section 1(a) / section 4 item 5): plain text (with the shared
// "Insert value" menu: the repeat's own ScopePaths, and the fixed dates), a notes-registry entry (searchable,
// plain-text preview), a bound scope field, or "use the metric's own label". Reused for both an
// item's `label` and its `caption` (both are `Label`) — `allowMetricOwn` hides the "metric's own
// name" option for a caption, which has no natural registry counterpart.
import { computed, nextTick, ref, useId } from 'vue'
import InsertPicker, { type InsertGroup } from '../../InsertPicker.vue'
import { VALUE_TOKEN_OPTIONS } from '../../../lib/valueTokens'
import { isKnownNote, labelKind, labelNoteOptions, makeLabel, noteVarNames, scopePathLabel, scopePathOptions, withNoteId, withNoteVar, type LabelKind } from '../../../lib/metrics/editorModel'
import { CARD_LIMITS } from '../../../lib/metrics/validate'
import type { Label, RepeatSpec, ScopePath } from '../../../lib/metrics/types'

const props = withDefaults(
  defineProps<{
    hasData: boolean
    repeatOver?: RepeatSpec['over']
    allowMetricOwn?: boolean
    placeholder?: string
    /** "Label" for an item's own label, "Caption" when reused for `item.caption` — both render
     * through this same component (both are a `Label`), but the heading and every control's
     * accessible name should say which one this is. */
    heading?: string
  }>(),
  { allowMetricOwn: true, placeholder: 'Label text', heading: 'Label' },
)
const label = defineModel<Label | undefined>({ required: true })

const groupId = useId()
const textId = useId()
const noteSearchId = useId()
const noteSelectId = useId()
const bindSelectId = useId()

const scopeOptions = computed(() => scopePathOptions(props.repeatOver))
const fallbackPath = computed<ScopePath>(() => scopeOptions.value[0]?.value ?? 'campaign.label')

const kind = computed<LabelKind>(() => labelKind(label.value))
function setKind(k: LabelKind) {
  if (k === kind.value) return // the active tab: a no-op (an unset caption stays unset)
  label.value = makeLabel(k, label.value, fallbackPath.value)
}

const textValue = computed<string>({
  get: () => (typeof label.value === 'string' ? label.value : ''),
  set: (v) => {
    // Unchanged text — or no text typed into a label that is not set at all (an item with no
    // caption) — writes nothing.
    if (v === textValue.value && (typeof label.value === 'string' || v === '')) return
    label.value = v
  },
})
// ONE "Insert value" control, the one the chart caption has (InsertPicker.vue): the repeat's own
// fields (`{campaign.label}`, as before) and the fixed dates (`{=release.latest|date}`). Chart and
// metric values are not offered: a card label has no chart, and fetches nothing of its own.
const insertGroups = computed<InsertGroup[]>(() => [
  ...(scopeOptions.value.length ? [{ group: 'Fields', options: scopeOptions.value.map((o) => ({ value: `{${o.value}}`, label: `{${o.value}} — ${o.label}` })) }] : []),
  { group: 'Dates', options: VALUE_TOKEN_OPTIONS.filter((o) => o.group === 'Dates').map((o) => ({ value: o.token, label: o.label })) },
])
// A token is appended whole or not at all: one that would take the label past the 200-character
// limit (the input's maxlength stops typing there, not a programmatic append) is refused, and the
// box says so, as the chart caption does. Either way focus goes back to the input with the caret
// at the end, so the author keeps typing and the dialog's Escape and Tab trap keep working (the
// Insert button is disabled once its pick resets).
const textEl = ref<HTMLInputElement | null>(null)
const labelFull = ref(false)
const labelFullTick = ref(0)
function insertText(token: string) {
  const next = `${textValue.value}${token}`
  if (next.length > CARD_LIMITS.stringLength) {
    labelFull.value = true
    labelFullTick.value++
  } else {
    labelFull.value = false
    textValue.value = next
  }
  void nextTick(() => {
    const el = textEl.value
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  })
}

const noteId = computed<string>({
  get: () => (label.value && typeof label.value === 'object' && 'note' in label.value ? label.value.note : ''),
  set: (v) => {
    if (v === noteId.value) return
    label.value = withNoteId(label.value, v)
  },
})
// ── Variables (Label.vars): each `{name}` in the note's template can read a scope field of the
// instance the label sits in (e.g. {campaign} → the campaign's name). Rows: the note's own
// placeholders, plus any var already stored under another name (never hidden, so never lost).
const noteVars = computed<Record<string, ScopePath>>(() => (label.value && typeof label.value === 'object' && 'note' in label.value ? (label.value.vars ?? {}) : {}))
const varRows = computed<string[]>(() => {
  const names = noteId.value ? noteVarNames(noteId.value) : []
  for (const k of Object.keys(noteVars.value)) if (!names.includes(k)) names.push(k)
  return names
})
/** The paths a var may read: the repeat's own fields, plus its current path when that is outside
 * them (a preset's binding stays shown and selected, never blanked by the picker). */
function varOptions(name: string): { value: ScopePath; label: string }[] {
  const cur = noteVars.value[name]
  const opts = scopeOptions.value
  return cur && !opts.some((o) => o.value === cur) ? [...opts, { value: cur, label: scopePathLabel(cur) }] : opts
}
function setVar(name: string, path: ScopePath | '') {
  if ((noteVars.value[name] ?? '') === path) return
  label.value = withNoteVar(label.value, name, path)
}
const noteSearch = ref('')
const noteChoices = computed(() => {
  const q = noteSearch.value.trim().toLowerCase()
  // Label entries too (a preset's step names and titles), and always the current pick.
  const all = labelNoteOptions(noteId.value || undefined)
  return q ? all.filter((o) => o.preview.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : all
})
const noteInvalid = computed(() => !!noteId.value && !isKnownNote(noteId.value))

const bindPath = computed<ScopePath>({
  get: () => (label.value && typeof label.value === 'object' && 'bind' in label.value ? label.value.bind : fallbackPath.value),
  set: (v) => {
    if (v === bindPath.value && label.value && typeof label.value === 'object' && 'bind' in label.value) return
    label.value = { bind: v }
  },
})
</script>

<template>
  <div class="field" role="group" :aria-labelledby="groupId">
    <label :id="groupId">{{ heading }}</label>
    <div class="tabs" role="tablist" :aria-label="`${heading} kind`">
      <button type="button" class="tab" :class="{ active: kind === 'text' }" @click="setKind('text')">Text</button>
      <button v-if="allowMetricOwn" type="button" class="tab" :class="{ active: kind === 'metric' }" :disabled="!hasData" @click="setKind('metric')" :title="hasData ? '' : 'Pick a metric or ratio first'">
        Metric's own
      </button>
      <button type="button" class="tab" :class="{ active: kind === 'note' }" @click="setKind('note')">Note</button>
      <button type="button" class="tab" :class="{ active: kind === 'bind' }" :disabled="!scopeOptions.length" @click="setKind('bind')" :title="scopeOptions.length ? '' : 'Only available inside a repeat'">
        Bound field
      </button>
    </div>

    <template v-if="kind === 'text'">
      <label class="visually-hidden" :for="textId">{{ heading }} text</label>
      <input :id="textId" ref="textEl" type="text" v-model="textValue" :placeholder="placeholder" :maxlength="CARD_LIMITS.stringLength" @input="labelFull = false" />
      <div class="field">
        <InsertPicker :label="`Insert a value into the ${heading.toLowerCase()}`" placeholder="Insert value ▾" select-class="insert-value" :groups="insertGroups" @insert="insertText" />
        <span class="hint label-full" aria-live="polite"><span v-if="labelFull" :key="labelFullTick">{{ heading }} is full</span></span>
      </div>
    </template>

    <template v-else-if="kind === 'metric'">
      <p class="hint">Uses the data binding's own registry name.</p>
    </template>

    <template v-else-if="kind === 'note'">
      <label class="visually-hidden" :for="noteSearchId">Search notes</label>
      <input :id="noteSearchId" class="search-input" type="text" v-model="noteSearch" placeholder="Search notes…" />
      <label class="visually-hidden" :for="noteSelectId">Choose a note</label>
      <select :id="noteSelectId" v-model="noteId" :class="{ invalid: noteInvalid }">
        <option value="" disabled>Choose a note…</option>
        <option v-for="o in noteChoices" :key="o.value" :value="o.value">{{ o.preview }}</option>
      </select>
      <p v-if="noteInvalid" class="hint">This version doesn't know the note "{{ noteId }}", so it shows nothing. It stays saved unless you pick another.</p>
      <div v-if="varRows.length" class="field" role="group" :aria-labelledby="`${groupId}-vars`">
        <label :id="`${groupId}-vars`">Variables <span class="hint">— fill the note's {placeholders} from the repeat</span></label>
        <div v-for="name in varRows" :key="name" class="row">
          <div class="field">
            <label :for="`${groupId}-var-${name}`">{{ '{' + name + '}' }}</label>
            <select :id="`${groupId}-var-${name}`" :value="noteVars[name] ?? ''" @change="setVar(name, ($event.target as HTMLSelectElement).value as ScopePath | '')">
              <option value="">(the note's default)</option>
              <option v-for="o in varOptions(name)" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
          </div>
        </div>
      </div>
    </template>

    <template v-else-if="kind === 'bind'">
      <label class="visually-hidden" :for="bindSelectId">Bound field</label>
      <select :id="bindSelectId" v-model="bindPath">
        <option v-for="o in scopeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </template>
  </div>
</template>

<style scoped src="./editor.css"></style>
