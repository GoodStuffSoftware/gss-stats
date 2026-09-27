<script setup lang="ts">
// One DataBinding editor (ADR 0003 section 1(b) / section 4 item 5, "Data"): a metric (grouped,
// searchable, unit shown), a ratio (ONLY registered ratios — so an invalid percentage literally
// cannot be built), or a scope field. Params inherited from a repeat show as a chip with an
// override; the window select lists only the binding's own allowed windows.
import { computed, ref, useId } from 'vue'
import {
  CAMPAIGN_ID_OPTIONS,
  dataBindingKind,
  makeData,
  metricDef,
  metricOptions,
  paramIsPinned,
  POPUP_ID_OPTIONS,
  ratioDef,
  ratioOptions,
  scopePathOptions,
  type DataBindingKind,
} from '../../../lib/metrics/editorModel'
import { metricWindows, type MetricParam } from '../../../lib/metrics/metrics'
import { ratioParamsOf, ratioWindowsOf } from '../../../lib/metrics/ratios'
import type { DataBinding, ParamValue, RepeatSpec, ScopePath, WindowName } from '../../../lib/metrics/types'

// Vue casts an absent, optional BOOLEAN prop to `false` (not `undefined`) — the same rule native
// HTML boolean attributes follow — so `allowField`'s "default true" needs `withDefaults`, not an
// inline `?? true` (which would never fire: `false ?? true` is `false`).
const props = withDefaults(defineProps<{ repeatOver?: RepeatSpec['over']; allowField?: boolean; fieldOnly?: boolean }>(), { allowField: true })
const data = defineModel<DataBinding>({ required: true })

const groupId = useId()
const metricSearchId = useId()
const ratioSearchId = useId()
const fieldSelectId = useId()
const windowId = useId()

const kind = computed<DataBindingKind>(() => (props.fieldOnly ? 'field' : dataBindingKind(data.value)))
const scopeOptions = computed(() => scopePathOptions(props.repeatOver))
const fallbackPath = computed<ScopePath>(() => scopeOptions.value[0]?.value ?? 'campaign.label')

function setKind(k: DataBindingKind) {
  data.value = makeData(k, data.value, fallbackPath.value)
}

// ── metric / ratio search ───────────────────────────────────────────────────────────────────
const metricSearch = ref('')
const metricGroups = computed(() => {
  const q = metricSearch.value.trim().toLowerCase()
  const filtered = metricOptions().filter((o) => !q || o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q))
  const byFamily = new Map<string, typeof filtered>()
  for (const m of filtered) byFamily.set(m.family, [...(byFamily.get(m.family) ?? []), m])
  return [...byFamily.entries()]
})
const ratioSearch = ref('')
const ratioChoices = computed(() => {
  const q = ratioSearch.value.trim().toLowerCase()
  return ratioOptions().filter((o) => !q || o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q))
})

const currentMetricId = computed(() => ('metric' in data.value ? data.value.metric : ''))
const currentRatioId = computed(() => ('ratio' in data.value ? data.value.ratio : ''))
function pickMetric(id: string) {
  data.value = { metric: id }
}
function pickRatio(id: string) {
  data.value = { ratio: id }
}

// ── params (campaignId / popup) ─────────────────────────────────────────────────────────────
const allowedParams = computed<MetricParam[]>(() => {
  if (kind.value === 'metric' && 'metric' in data.value) return metricDef(data.value.metric)?.params ?? []
  if (kind.value === 'ratio' && 'ratio' in data.value) {
    const r = ratioDef((data.value as { ratio: string }).ratio)
    return r ? ratioParamsOf(r) : []
  }
  return []
})
const scopeProvides = (p: MetricParam): boolean => (p === 'campaignId' && props.repeatOver === 'campaigns') || (p === 'popup' && props.repeatOver === 'popups')
function paramValue(p: MetricParam): ParamValue | undefined {
  return 'params' in data.value ? data.value.params?.[p] : undefined
}
function setParam(p: MetricParam, v: string | undefined) {
  if (!('metric' in data.value || 'ratio' in data.value)) return
  const params = { ...('params' in data.value ? data.value.params : undefined) }
  if (v === undefined) delete params[p]
  else params[p] = v
  data.value = { ...data.value, params: Object.keys(params).length ? params : undefined } as DataBinding
}
function optionsFor(p: MetricParam) {
  return p === 'campaignId' ? CAMPAIGN_ID_OPTIONS : POPUP_ID_OPTIONS
}

// ── window ───────────────────────────────────────────────────────────────────────────────────
// The registry only ever SERVES these three named windows (metricWindows/ratioWindowsOf both
// return WindowName[]) — DataBinding.window's broader WindowSpec (which also allows the
// `{ scope: 'window' }` marker and reserved names like 'flight') is a wire-shape concession the
// editor never needs to construct itself.
const windowChoices = computed<WindowName[]>(() => {
  if (kind.value === 'metric' && 'metric' in data.value) {
    const def = metricDef(data.value.metric)
    return def ? metricWindows(def) : []
  }
  if (kind.value === 'ratio' && 'ratio' in data.value) {
    const r = ratioDef((data.value as { ratio: string }).ratio)
    return r ? ratioWindowsOf(r) : []
  }
  return []
})
const windowValue = computed<WindowName | ''>({
  get: () => {
    const w = 'window' in data.value ? data.value.window : undefined
    return typeof w === 'string' ? (w as WindowName) : (windowChoices.value[0] ?? '')
  },
  set: (v: WindowName | '') => {
    if (!('metric' in data.value || 'ratio' in data.value)) return
    data.value = { ...data.value, window: v || undefined } as DataBinding
  },
})

// ── field ────────────────────────────────────────────────────────────────────────────────────
const fieldPath = computed<ScopePath>({
  get: () => ('field' in data.value ? data.value.field : fallbackPath.value),
  set: (v) => {
    data.value = { field: v }
  },
})
</script>

<template>
  <div class="field" role="group" :aria-labelledby="groupId">
    <label :id="groupId">Data</label>
    <div v-if="!props.fieldOnly" class="tabs" role="tablist" aria-label="Data kind">
      <button type="button" class="tab" :class="{ active: kind === 'metric' }" @click="setKind('metric')">Metric</button>
      <button type="button" class="tab" :class="{ active: kind === 'ratio' }" @click="setKind('ratio')">Ratio</button>
      <button v-if="props.allowField" type="button" class="tab" :class="{ active: kind === 'field' }" :disabled="!scopeOptions.length" @click="setKind('field')">Field</button>
    </div>
    <p v-else class="hint">A badge always binds a scope field.</p>

    <template v-if="kind === 'metric'">
      <label class="visually-hidden" :for="metricSearchId">Search metrics</label>
      <input :id="metricSearchId" class="search-input" type="text" v-model="metricSearch" placeholder="Search metrics…" />
      <div class="option-list">
        <template v-for="[family, opts] in metricGroups" :key="family">
          <p class="chip" style="margin: 4px 6px">{{ family }}</p>
          <button v-for="o in opts" :key="o.id" type="button" class="option-row" :class="{ selected: o.id === currentMetricId }" @click="pickMetric(o.id)">
            <span>{{ o.label }}</span>
            <span class="option-unit">{{ o.unit }}</span>
          </button>
        </template>
        <p v-if="!metricGroups.length" class="option-empty">No metric matches "{{ metricSearch }}".</p>
      </div>
    </template>

    <template v-else-if="kind === 'ratio'">
      <label class="visually-hidden" :for="ratioSearchId">Search ratios</label>
      <input :id="ratioSearchId" class="search-input" type="text" v-model="ratioSearch" placeholder="Search ratios…" />
      <div class="option-list">
        <button v-for="o in ratioChoices" :key="o.id" type="button" class="option-row" :class="{ selected: o.id === currentRatioId }" @click="pickRatio(o.id)">
          <span>{{ o.label }} <span class="hint">— {{ o.summary }}</span></span>
          <span class="option-unit">{{ o.kind }}</span>
        </button>
        <p v-if="!ratioChoices.length" class="option-empty">No ratio matches "{{ ratioSearch }}".</p>
      </div>
    </template>

    <template v-else-if="kind === 'field'">
      <label class="visually-hidden" :for="fieldSelectId">Field</label>
      <select :id="fieldSelectId" v-model="fieldPath">
        <option v-for="o in scopeOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </template>

    <template v-if="kind !== 'field' && allowedParams.length">
      <div class="row" v-for="p in allowedParams" :key="p">
        <div class="field">
          <label :for="`${groupId}-param-${p}`">{{ p === 'campaignId' ? 'Campaign' : 'Pop-up' }}</label>
          <span v-if="!paramIsPinned(paramValue(p)) && scopeProvides(p)" class="chip">from repeat scope</span>
          <select :id="`${groupId}-param-${p}`" :value="paramValue(p) ?? ''" @change="setParam(p, ($event.target as HTMLSelectElement).value || undefined)">
            <option value="" :disabled="!scopeProvides(p)">{{ scopeProvides(p) ? '(from repeat scope)' : 'Choose…' }}</option>
            <option v-for="o in optionsFor(p)" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
      </div>
    </template>

    <div class="field" v-if="kind !== 'field' && windowChoices.length > 1">
      <label :for="windowId">Window</label>
      <select :id="windowId" v-model="windowValue">
        <option v-for="w in windowChoices" :key="String(w)" :value="w">{{ w }}</option>
      </select>
      <p v-if="windowValue && windowValue !== 'page'" class="hint">Ignores the page's date range.</p>
    </div>
  </div>
</template>

<style scoped src="./editor.css"></style>
