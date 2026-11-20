<script setup lang="ts">
// Budget filters: a date-range picker (presets: this month, last month, 3 months, year to date, custom)
// and a person segmented control (All + the people from GET /api/budget/meta).
// Props: from, to (YYYY-MM-DD), person ('all' or a person id), people (from /meta), today (tests only).
// Emits: `range` ({from, to}; only ever a range the server accepts) and `person` (id or 'all').
// Phone: the range select takes the full first row, the person control the second.
import { computed, ref, watch } from 'vue'
import type { IsoDate, Person, PersonFilter } from '../../lib/budget/types'
import { MAX_RANGE_DAYS, RANGE_PRESETS, presetOf, rangeForPreset, rangeValid, todayIso, type RangePreset } from '../../lib/budget/viewState'

const props = defineProps<{ from: IsoDate; to: IsoDate; person: PersonFilter; people: Person[]; today?: IsoDate }>()
const emit = defineEmits<{ range: [r: { from: IsoDate; to: IsoDate }]; person: [p: PersonFilter] }>()

const todayStr = computed(() => props.today ?? todayIso())
const matched = computed(() => presetOf(props.from, props.to, todayStr.value))
// "Custom" stays chosen (and its date inputs stay open) while the user edits, even if the dates happen
// to land on a preset.
const forcedCustom = ref(false)
watch(matched, (m) => {
  if (m !== 'custom') forcedCustom.value = false
})
const selected = computed<RangePreset>(() => (forcedCustom.value ? 'custom' : matched.value))
const customFrom = ref(props.from)
const customTo = ref(props.to)
watch(() => [props.from, props.to], () => {
  customFrom.value = props.from
  customTo.value = props.to
})
const rangeError = ref('')

function onPreset(e: Event) {
  const id = (e.target as HTMLSelectElement).value as RangePreset
  rangeError.value = ''
  if (id === 'custom') {
    forcedCustom.value = true
    return
  }
  forcedCustom.value = false
  const r = rangeForPreset(id, todayStr.value)
  if (r) emit('range', r)
}
function onCustom() {
  if (!rangeValid(customFrom.value, customTo.value)) {
    rangeError.value =
      customFrom.value && customTo.value && customFrom.value > customTo.value
        ? 'The start date is after the end date.'
        : `Pick a range of at most ${MAX_RANGE_DAYS} days.`
    return
  }
  rangeError.value = ''
  if (customFrom.value !== props.from || customTo.value !== props.to) emit('range', { from: customFrom.value, to: customTo.value })
}
</script>

<template>
  <div class="budget-filters" role="group" aria-label="Budget filters">
    <div class="bf-range">
      <label class="bf-label" for="budget-range">Range</label>
      <select id="budget-range" class="bf-select" :value="selected" data-testid="budget-range" @change="onPreset">
        <option v-for="p in RANGE_PRESETS" :key="p.id" :value="p.id">{{ p.label }}</option>
      </select>
      <span v-if="selected === 'custom'" class="bf-custom">
        <input v-model="customFrom" type="date" class="bf-date" aria-label="From date" data-testid="budget-from" @change="onCustom" />
        <span aria-hidden="true">–</span>
        <input v-model="customTo" type="date" class="bf-date" aria-label="To date" data-testid="budget-to" @change="onCustom" />
      </span>
    </div>
    <div class="bf-person" role="radiogroup" aria-label="Person">
      <button
        type="button"
        role="radio"
        class="bf-seg"
        :class="{ on: person === 'all' }"
        :aria-checked="person === 'all'"
        data-testid="budget-person-all"
        @click="emit('person', 'all')"
      >All</button>
      <button
        v-for="p in people"
        :key="p.id"
        type="button"
        role="radio"
        class="bf-seg"
        :class="{ on: person === p.id }"
        :aria-checked="person === p.id"
        :data-testid="`budget-person-${p.id}`"
        @click="emit('person', p.id)"
      >{{ p.label }}</button>
    </div>
    <p v-if="rangeError" class="bf-error" role="alert">{{ rangeError }}</p>
  </div>
</template>

<style scoped>
.budget-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}
.bf-range,
.bf-custom {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.bf-label {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.bf-select,
.bf-date {
  min-height: 36px;
  padding: 4px 8px;
  border: 1px solid rgb(var(--line-2));
  border-radius: 9px;
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  font: inherit;
  font-size: 13px;
}
.bf-person {
  display: inline-flex;
  border: 1px solid rgb(var(--line-2));
  border-radius: 9px;
  overflow: hidden;
}
.bf-seg {
  min-height: 36px;
  padding: 4px 14px;
  border: 0;
  border-left: 1px solid rgb(var(--line-2));
  background: rgb(var(--surface));
  color: rgb(var(--ink));
  font-size: 13px;
}
.bf-seg:first-child {
  border-left: 0;
}
.bf-seg.on {
  background: rgb(var(--amber));
  color: #fff;
}
.bf-seg:focus-visible,
.bf-select:focus-visible,
.bf-date:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: 1px;
}
.bf-error {
  flex-basis: 100%;
  margin: 0;
  font-size: 12px;
  color: #b3261e;
}
@media (max-width: 700px) {
  .bf-range {
    flex-basis: 100%;
  }
  .bf-select {
    flex: 1 1 auto;
    min-height: 44px;
  }
  .bf-label {
    display: none;
  }
  .bf-person {
    flex-basis: 100%;
  }
  .bf-seg {
    flex: 1 1 0;
    min-height: 44px;
  }
}
</style>
