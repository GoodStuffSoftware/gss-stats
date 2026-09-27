<script setup lang="ts">
// One CardSpec section: a layout (rows/pills/tiles/bars/table) plus its own optional repeat
// (ADR 0003 section 1). 'table' is structurally different from the other four — items are
// COLUMNS and repeat instances are ROWS — so it gets its own branch with MetricTableCell
// instead of MetricItem.
import { computed } from 'vue'
import { useMetrics } from '../../composables/useMetrics'
import { buildRequestSpec, flattenSectionItems, resolveRepeat, type FlatItem, type RepeatContext, type ScopeInstance } from '../../lib/metrics/scope'
import { itemLabelTokens, itemViewModel, resolveLabelTokens } from '../../lib/metrics/render'
import type { MetricsContext, Section } from '../../lib/metrics/types'
import MetricItem from './MetricItem.vue'
import MetricLabel from './MetricLabel.vue'
import MetricPlaceholder from './MetricPlaceholder.vue'
import MetricTableCell from './MetricTableCell.vue'

const props = defineProps<{
  section: Section
  outerScope: ScopeInstance
  ctx: RepeatContext
  context?: MetricsContext
}>()

const defaultFrame = computed<'row' | 'pill' | 'tile'>(() => (props.section.layout === 'pills' ? 'pill' : props.section.layout === 'tiles' ? 'tile' : 'row'))

const titleTokens = computed(() => (props.section.title !== undefined ? resolveLabelTokens(props.section.title, props.outerScope, undefined, props.ctx.todayEt) : []))

// ── rows / pills / tiles / bars ────────────────────────────────────────────────────────────
const flatItems = computed<FlatItem[]>(() => (props.section.layout === 'table' ? [] : flattenSectionItems(props.section, props.outerScope, props.ctx)))

// A 'bars' section scales every bar to the section's largest value. Acquired once, at setup,
// via the SAME shared useMetrics() cache each MetricItem uses (content-equal requests dedupe
// and share one fetch) — never inside a computed getter, since request() has side effects
// (refcounting + onScopeDispose registration) that must run exactly once.
const { request: requestShared } = useMetrics(() => props.context, () => props.ctx.todayEt)
const setupItems = props.section.layout === 'table' ? [] : flattenSectionItems(props.section, props.outerScope, props.ctx)
const setupRefs = setupItems.map((fi) => {
  const spec = fi.emptyOf ? null : buildRequestSpec(fi.item, fi.scope)
  return spec ? requestShared(spec) : null
})
const barMax = computed(() => {
  if (props.section.layout !== 'bars') return 0
  const nums = setupItems.flatMap((fi, i) => (fi.emptyOf || fi.item.display.as !== 'bar' ? [] : [setupRefs[i]?.value ? (setupRefs[i]!.value!.value ?? setupRefs[i]!.value!.numerator ?? 0) : 0]))
  return nums.length ? Math.max(0, ...nums) : 0
})

// A section left with no visible item after gating (every item omitted: a closed campaign's
// unmeasured steps, whenEmpty 'omit', …) is omitted whole, title included (ADR 0003, "Closed
// campaigns: omit, don't label"). The same view model MetricItem renders decides visibility,
// over the same shared values; a placeholder or a still-loading item counts as visible.
const anyVisible = computed(() => {
  if (props.section.layout === 'table') return true
  return setupItems.some((fi, i) => !!fi.emptyOf || itemViewModel(fi.item, setupRefs[i]?.value, fi.scope, { todayEt: props.ctx.todayEt }).visible)
})

// ── table ───────────────────────────────────────────────────────────────────────────────────
const tableRows = computed<ScopeInstance[]>(() => (props.section.layout === 'table' ? resolveRepeat(props.section.repeat, props.ctx) : []))
const tableHeaderTokens = computed(() => props.section.items.map((it) => itemLabelTokens(it, props.outerScope, props.ctx.todayEt)))
</script>

<template>
  <div v-if="anyVisible" class="metric-section" :class="`layout-${section.layout}`">
    <p v-if="titleTokens.length" class="section-title"><MetricLabel :tokens="titleTokens" /></p>

    <table v-if="section.layout === 'table'" class="metric-table">
      <thead>
        <tr>
          <th v-for="(tokens, i) in tableHeaderTokens" :key="i"><MetricLabel :tokens="tokens" /></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(rowScope, ri) in tableRows" :key="ri">
          <td v-for="item in section.items" :key="item.id">
            <MetricTableCell :item="item" :scope="rowScope" :today-et="ctx.todayEt" :context="context" />
          </td>
        </tr>
      </tbody>
    </table>

    <div v-else class="items-wrap">
      <template v-for="(fi, i) in flatItems" :key="`${fi.item.id}-${i}`">
        <MetricPlaceholder
          v-if="fi.emptyOf"
          :label-tokens="resolveLabelTokens(fi.emptyOf.label, fi.scope, undefined, ctx.todayEt)"
          :text-tokens="resolveLabelTokens(fi.emptyOf.text, fi.scope, undefined, ctx.todayEt)"
          :frame="fi.item.frame ?? defaultFrame"
        />
        <MetricItem v-else :item="fi.item" :scope="fi.scope" :frame="fi.item.frame ?? defaultFrame" :today-et="ctx.todayEt" :context="context" :bar-max="section.layout === 'bars' ? barMax : undefined" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.section-title {
  font-weight: 600;
  font-size: 12.5px;
  margin: 0 0 6px;
  color: rgb(var(--ink-2));
}
.layout-tiles .items-wrap {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
/* Pills after rows sit 8px below them, as the old scorecard's chip row did (rows end with 3px). */
.metric-section + .metric-section.layout-pills {
  margin-top: 5px;
}
.layout-pills .items-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.layout-rows .items-wrap,
.layout-bars .items-wrap {
  display: flex;
  flex-direction: column;
}
.metric-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}
.metric-table th {
  text-align: left;
  font-size: 10.5px;
  color: rgb(var(--ink-3));
  font-weight: 600;
  padding: 3px 8px 3px 0;
  border-bottom: 1px solid rgb(var(--line));
}
.metric-table td {
  padding: 3px 8px 3px 0;
  border-bottom: 1px solid rgb(var(--line));
}
</style>
