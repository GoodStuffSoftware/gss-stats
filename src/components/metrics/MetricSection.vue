<script setup lang="ts">
// One CardSpec section: a layout (rows/pills/tiles/bars/table) plus its own optional repeat
// (ADR 0003 section 1). 'table' is structurally different from the other four — items are
// COLUMNS and repeat instances are ROWS — so it gets its own branch with MetricTableCell
// instead of MetricItem.
import { computed } from 'vue'
import { useMetrics } from '../../composables/useMetrics'
import { buildRequestSpec, flattenSectionItems, resolveRepeat, type FlatItem, type RepeatContext, type ScopeInstance } from '../../lib/metrics/scope'
import { itemLabelTokens, resolveLabelTokens } from '../../lib/metrics/render'
import type { MetricsContext, Section } from '../../lib/metrics/types'
import MetricItem from './MetricItem.vue'
import MetricLabel from './MetricLabel.vue'
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
const { request: requestForMax } = useMetrics(() => props.context)
const barRefs =
  props.section.layout === 'bars'
    ? flattenSectionItems(props.section, props.outerScope, props.ctx)
        .filter((fi) => !fi.emptyOf && fi.item.display.as === 'bar')
        .map((fi) => {
          const spec = buildRequestSpec(fi.item, fi.scope)
          return spec ? requestForMax(spec) : null
        })
    : []
const barMax = computed(() => {
  const nums = barRefs.map((r) => (r?.value ? (r.value.value ?? r.value.numerator ?? 0) : 0))
  return nums.length ? Math.max(0, ...nums) : 0
})

// ── table ───────────────────────────────────────────────────────────────────────────────────
const tableRows = computed<ScopeInstance[]>(() => (props.section.layout === 'table' ? resolveRepeat(props.section.repeat, props.ctx) : []))
const tableHeaderTokens = computed(() => props.section.items.map((it) => itemLabelTokens(it, props.outerScope, props.ctx.todayEt)))
</script>

<template>
  <div class="metric-section" :class="`layout-${section.layout}`">
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
        <div v-if="fi.emptyOf" class="empty-placeholder">
          <MetricLabel :tokens="resolveLabelTokens(fi.emptyOf.label, fi.scope, undefined, ctx.todayEt)" />
          <span class="empty-text"><MetricLabel :tokens="resolveLabelTokens(fi.emptyOf.text, fi.scope, undefined, ctx.todayEt)" /></span>
        </div>
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
.empty-placeholder {
  font-size: 11.5px;
  color: rgb(var(--ink-3));
}
.empty-text {
  margin-left: 4px;
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
