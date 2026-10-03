<script setup lang="ts">
// One Display editor (ADR 0003 section 1(c) / section 4 item 5, "Display"): only the displays
// compatible with the chosen data's unit are offered (validate.ts's DISPLAYS_FOR, via
// editorModel's displayOptionsFor) — a percent can never be offered for a pair. Percent always
// shows "(n/d)"; there is no toggle to hide it (ADR: "no toggle to hide it"). Sparkline (ADR
// 0005 slice 2) is offered for a count or money metric in the page or campaign attribution window,
// and listed but disabled, with the reason as its tooltip, anywhere it cannot draw a daily series.
import { computed, useId } from 'vue'
import { dataKindOf, displayAsLabel, displayOptionsFor, makeDisplay, metricDef } from '../../../lib/metrics/editorModel'
import type { DataBinding, Display, DisplayAs } from '../../../lib/metrics/types'

const props = defineProps<{ binding: DataBinding }>()
const display = defineModel<Display>({ required: true })

const groupId = useId()
const decimalsId = useId()

const options = computed(() => displayOptionsFor(props.binding))
const kind = computed(() => dataKindOf(props.binding))

function pick(as: DisplayAs) {
  display.value = makeDisplay(as, display.value)
}

// Deltas are offered only where the server accepts them (validate.ts checkRequest): a count
// metric over the 'todaySoFar' window.
const bindingWindow = computed(() => ('window' in props.binding ? String(props.binding.window ?? '') : ''));
const isCountMetric = computed(() => kind.value === 'count' && 'metric' in props.binding && !!metricDef(props.binding.metric))
const defaultWindowIsToday = computed(() => {
  if (!('metric' in props.binding)) return false
  const def = metricDef(props.binding.metric)
  return !!def && Object.keys(def.windows)[0] === 'todaySoFar'
})
const deltasEligible = computed(() => isCountMetric.value && (bindingWindow.value === 'todaySoFar' || (!bindingWindow.value && defaultWindowIsToday.value)))

const deltas = computed<('yesterday' | 'avg7')[]>({
  get: () => (display.value.as === 'number' ? (display.value.deltas ?? []) : []),
  set: (v) => {
    if (display.value.as !== 'number') return
    display.value = { as: 'number', ...(v.length ? { deltas: v } : {}) }
  },
})
function toggleDelta(name: 'yesterday' | 'avg7', checked: boolean) {
  const set = new Set(deltas.value)
  if (checked) set.add(name)
  else set.delete(name)
  deltas.value = (['yesterday', 'avg7'] as const).filter((d) => set.has(d))
}

const DECIMALS_OPTIONS = [0, 1, 2, 3, 4] as const // validate.ts accepts 0-4; render.ts clamps to it
const decimals = computed<(typeof DECIMALS_OPTIONS)[number]>({
  get: () => (display.value.as === 'percent' ? (display.value.decimals ?? 1) : 1),
  set: (v) => {
    if (display.value.as === 'percent') display.value = { as: 'percent', decimals: v }
  },
})
const dateRangeDays = computed<boolean>({
  get: () => display.value.as === 'dateRange' && !!display.value.days,
  set: (v) => {
    if (display.value.as === 'dateRange') display.value = v ? { as: 'dateRange', days: true } : { as: 'dateRange' }
  },
})
</script>

<template>
  <div class="field" role="group" :aria-labelledby="groupId">
    <label :id="groupId">Display</label>
    <p v-if="!options.length" class="hint">Pick a metric, ratio or field first.</p>
    <div v-else class="tabs" role="radiogroup" aria-label="Display type">
      <button
        v-for="o in options"
        :key="o.as"
        type="button"
        class="tab"
        role="radio"
        :aria-checked="display.as === o.as"
        :class="{ active: display.as === o.as }"
        :disabled="o.disabled"
        :title="o.hint ?? ''"
        @click="pick(o.as)"
      >
        {{ displayAsLabel(o.as) }}{{ o.disabled ? ' (unavailable)' : '' }}
      </button>
    </div>

    <template v-if="display.as === 'number'">
      <div class="field check" v-if="deltasEligible">
        <label><input type="checkbox" :checked="deltas.includes('yesterday')" @change="toggleDelta('yesterday', ($event.target as HTMLInputElement).checked)" /> vs yesterday</label>
        <label><input type="checkbox" :checked="deltas.includes('avg7')" @change="toggleDelta('avg7', ($event.target as HTMLInputElement).checked)" /> vs 7-day average</label>
      </div>
      <p v-else class="hint">Deltas need a count metric over "today so far".</p>
    </template>

    <template v-else-if="display.as === 'percent'">
      <div class="field">
        <label :for="decimalsId">Decimals</label>
        <select :id="decimalsId" v-model.number="decimals">
          <option v-for="n in DECIMALS_OPTIONS" :key="n" :value="n">{{ n }}</option>
        </select>
      </div>
      <p class="hint">Always shows the counts, e.g. "12.1% (4/33)" — no toggle to hide them.</p>
    </template>

    <template v-else-if="display.as === 'dateRange'">
      <div class="field check">
        <label><input type="checkbox" v-model="dateRangeDays" /> Show day count, e.g. "(8d)"</label>
      </div>
    </template>

    <template v-else-if="display.as === 'sparkline'">
      <p class="hint">Draws the metric's count (or spend) for each Eastern day in the range, next to its number. A day it was not measured is a gap in the line, not a zero.</p>
    </template>

    <template v-else-if="display.as === 'counts'">
      <p class="hint">Shows both raw counts, e.g. "1,111 views · 353 arrivals" — never a percentage.</p>
    </template>
  </div>
</template>

<style scoped src="./editor.css"></style>
