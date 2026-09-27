<script setup lang="ts">
// One Label editor (ADR 0003 section 1(a) / section 4 item 5): plain text (with an "insert
// variable" menu limited to the repeat's own ScopePaths), a notes-registry entry (searchable,
// plain-text preview), a bound scope field, or "use the metric's own label". Reused for both an
// item's `label` and its `caption` (both are `Label`) — `allowMetricOwn` hides the "metric's own
// name" option for a caption, which has no natural registry counterpart.
import { computed, ref, useId } from 'vue'
import { isKnownNote, labelKind, makeLabel, noteLabelOptions, scopePathOptions, type LabelKind } from '../../../lib/metrics/editorModel'
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
const insertVarId = useId()
const noteSearchId = useId()
const noteSelectId = useId()
const bindSelectId = useId()

const scopeOptions = computed(() => scopePathOptions(props.repeatOver))
const fallbackPath = computed<ScopePath>(() => scopeOptions.value[0]?.value ?? 'campaign.label')

const kind = computed<LabelKind>(() => labelKind(label.value))
function setKind(k: LabelKind) {
  label.value = makeLabel(k, label.value, fallbackPath.value)
}

const textValue = computed<string>({
  get: () => (typeof label.value === 'string' ? label.value : ''),
  set: (v) => {
    label.value = v
  },
})
function insertVar(path: ScopePath) {
  textValue.value = `${textValue.value}{${path}}`
}

const noteId = computed<string>({
  get: () => (label.value && typeof label.value === 'object' && 'note' in label.value ? label.value.note : ''),
  set: (v) => {
    label.value = { note: v }
  },
})
const noteSearch = ref('')
const noteChoices = computed(() => {
  const q = noteSearch.value.trim().toLowerCase()
  const all = noteLabelOptions()
  return q ? all.filter((o) => o.preview.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : all
})
const noteInvalid = computed(() => !!noteId.value && !isKnownNote(noteId.value))

const bindPath = computed<ScopePath>({
  get: () => (label.value && typeof label.value === 'object' && 'bind' in label.value ? label.value.bind : fallbackPath.value),
  set: (v) => {
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
      <input :id="textId" type="text" v-model="textValue" :placeholder="placeholder" />
      <div class="field" v-if="scopeOptions.length">
        <label class="visually-hidden" :for="insertVarId">Insert a variable into the {{ heading.toLowerCase() }}</label>
        <select :id="insertVarId" @change="insertVar(($event.target as HTMLSelectElement).value as ScopePath); ($event.target as HTMLSelectElement).value = ''">
          <option value="" disabled selected>+ Insert variable…</option>
          <option v-for="o in scopeOptions" :key="o.value" :value="o.value">{{ '{' + o.value + '}' }} — {{ o.label }}</option>
        </select>
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
      <p v-if="noteInvalid" class="hint">Unknown note id "{{ noteId }}".</p>
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
