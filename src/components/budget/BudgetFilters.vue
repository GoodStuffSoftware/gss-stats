<script setup lang="ts">
// Budget filters: a date-range picker (presets: this month, last month, 3 months, year to date, custom), a smart date
// field beside it (type words such as "last 30 days" or "Oct 1 to Nov 15", or open its calendar and pick one date or a
// range; components/ui/SmartDateRange.vue) and a person segmented control (All + the people from GET /api/budget/meta).
// Props: from, to (YYYY-MM-DD), person ('all' or a person id), people (from /meta), today (tests only).
// Emits: `range` ({from, to}; only ever a range the server accepts) and `person` (id or 'all').
// Phone: the range select takes the full first row, the smart date field the next, the person control the last.
import { computed, ref, watch } from 'vue'
import type { IsoDate, Person, PersonFilter } from '../../lib/budget/types'
import { MAX_RANGE_DAYS, RANGE_PRESETS, presetLabel, presetOf, rangeForPreset, rangeMonths, todayIso, type RangePreset } from '../../lib/budget/viewState'
import SmartDateRange from '../ui/SmartDateRange.vue'

const props = defineProps<{ from: IsoDate; to: IsoDate; person: PersonFilter; people: Person[]; today?: IsoDate; rangeHidden?: boolean }>()
const emit = defineEmits<{ range: [r: { from: IsoDate; to: IsoDate }]; person: [p: PersonFilter] }>()

const todayStr = computed(() => props.today ?? todayIso())
const matched = computed(() => presetOf(props.from, props.to, todayStr.value))
// "Custom" stays chosen while the user edits the dates, even if they happen to land on a preset.
const forcedCustom = ref(false)
watch(matched, (m) => {
  if (m !== 'custom') forcedCustom.value = false
})
const selected = computed<RangePreset>(() => (forcedCustom.value ? 'custom' : matched.value))
const smart = ref<InstanceType<typeof SmartDateRange> | null>(null)
// The months the picked range covers, from the same range the queries use (props.from / props.to).
const covers = computed(() => rangeMonths(props.from, props.to, todayStr.value))

function onPreset(e: Event) {
  const id = (e.target as HTMLSelectElement).value as RangePreset
  if (id === 'custom') {
    forcedCustom.value = true
    smart.value?.focus() // the dates to type or pick are right there
    return
  }
  forcedCustom.value = false
  const r = rangeForPreset(id, todayStr.value)
  if (r) emit('range', r)
}
/** Dates typed or picked in the smart field (it has already checked the length). */
function onSmart(r: { from: IsoDate; to: IsoDate }) {
  if (r.from !== props.from || r.to !== props.to) emit('range', r)
}
</script>

<template>
  <div class="budget-filters" role="group" aria-label="Budget filters">
    <div v-if="!rangeHidden" class="bf-range">
      <label class="bf-label" for="budget-range">Range</label>
      <select id="budget-range" class="bf-select" :value="selected" data-testid="budget-range" @change="onPreset">
        <option v-for="p in RANGE_PRESETS" :key="p.id" :value="p.id">{{ presetLabel(p.id, todayStr) }}</option>
      </select>
      <SmartDateRange ref="smart" class="bf-smart" :from="from" :to="to" :today="today" :max-days="MAX_RANGE_DAYS" label="Dates" testid="budget-date" @change="onSmart" />
      <span v-if="covers" class="bf-covers" data-testid="budget-range-months">Covers {{ covers }}</span>
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
  </div>
</template>

<style scoped>
.budget-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}
.bf-range {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.bf-label {
  font-size: 12px;
  color: rgb(var(--ink-3));
}
.bf-select {
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
.bf-select:focus-visible {
  outline: 2px solid rgb(var(--amber));
  outline-offset: 1px;
}
.bf-covers {
  font-size: 12px;
  opacity: 0.75;
  overflow-wrap: anywhere;
}
@media (max-width: 700px) {
  .bf-covers {
    flex-basis: 100%;
  }
  .bf-range {
    flex-basis: 100%;
    min-width: 0; /* its select cannot size it past a very narrow page */
  }
  .bf-smart {
    flex: 1 1 100%;
  }
  .bf-select {
    flex: 1 1 auto;
    min-width: 0; /* a long range name must not push a very narrow page sideways */
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
