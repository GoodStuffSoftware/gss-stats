<script setup lang="ts">
// One CardSpec section: a layout (rows/pills/tiles/bars/table) plus its own optional repeat
// (ADR 0003 section 1). 'table' is structurally different from the other four, so it gets its own
// branch with MetricTableCell instead of MetricItem, in one of two orientations:
//   - a row repeat (`repeat`): items are COLUMNS, repeat instances are ROWS;
//   - a column repeat (`columns`): items are ROWS (their label in the first cell), instances are
//     COLUMNS — a campaign card's funnel steps by country, a release's before and after. A row
//     whose every cell is gated out (a closed flight's unmeasured step) is omitted.
import { computed, effectScope, onScopeDispose, shallowRef, watch, type EffectScope, type Ref } from 'vue'
import { useMetrics } from '../../composables/useMetrics'
import { buildRequestSpec, columnDefaultLabel, flattenSectionItems, nestScope, resolveRepeat, sectionCells, type FlatItem, type RepeatContext, type ScopeInstance } from '../../lib/metrics/scope'
import { itemLabelTokens, itemViewModel, resolveLabelTokens } from '../../lib/metrics/render'
import type { MetricItem as MetricItemSpec, MetricsContext, MetricValue, Section } from '../../lib/metrics/types'
import type { ValueResolver } from '../../lib/textLite'
import MetricItem from './MetricItem.vue'
import MetricLabel from './MetricLabel.vue'
import MetricPlaceholder from './MetricPlaceholder.vue'
import MetricTableCell from './MetricTableCell.vue'

const props = defineProps<{
  section: Section
  outerScope: ScopeInstance
  ctx: RepeatContext
  context?: MetricsContext
  /** What a `{=…}` token in a label fills from (MetricCard): the fixed dates and the card's metric values. */
  values?: ValueResolver
}>()

const defaultFrame = computed<'row' | 'pill' | 'tile' | 'column'>(() => (props.section.layout === 'pills' ? 'pill' : props.section.layout === 'tiles' ? 'tile' : props.section.layout === 'columns' ? 'column' : 'row'))
const scaled = computed(() => props.section.layout === 'bars' || props.section.layout === 'columns')

const titleTokens = computed(() => (props.section.title !== undefined ? resolveLabelTokens(props.section.title, props.outerScope, undefined, props.ctx.todayEt, props.values) : []))

const isColumnTable = computed(() => props.section.layout === 'table' && !!props.section.columns)

// ── rows / pills / tiles / bars, and a column table's cells ────────────────────────────────
// A column table's cells are items × columns (sectionCells), in row-major order, so the value of
// row r, column c is flatItems[r * columns + c].
const flatItems = computed<FlatItem[]>(() => {
  if (props.section.layout === 'table') return sectionCells(props.section, props.outerScope, props.ctx)
  return flattenSectionItems(props.section, props.outerScope, props.ctx)
})

// barMax (a 'bars' section scales every bar to the section's largest value) and anyVisible (a
// section left with no visible item after gating is omitted whole — ADR 0003, "Closed campaigns:
// omit, don't label") both need one value per flattened item, from the SAME shared useMetrics()
// cache every MetricItem uses (content-equal requests dedupe and share one fetch).
//
// Review fix, 2026-09-27 (the same staleness useMetricItem.ts had): `activeRefs` is rebuilt — in
// a fresh nested effectScope, so the OLD useMetrics() consumers are released before the NEW ones
// are acquired (see useMetrics.ts releaseKey) — only when the flattened items' RESOLVED REQUEST
// PLAN actually changes (planKey), so a purely cosmetic edit (a label, a caption) never touches
// the fetch layer.
function planKey(items: readonly FlatItem[]): string {
  return JSON.stringify(items.map((fi) => (fi.emptyOf ? null : (buildRequestSpec(fi.item, fi.scope) ?? null))))
}
const activeRefs = shallowRef<(Readonly<Ref<MetricValue | undefined>> | null)[]>([])
let requestScope: EffectScope | null = null
let currentPlanKey: string | null = null
function rebuildRefs(items: FlatItem[]) {
  const key = planKey(items)
  if (key === currentPlanKey && requestScope) return
  currentPlanKey = key
  requestScope?.stop()
  requestScope = effectScope(true)
  activeRefs.value =
    requestScope.run(() => {
      const { request } = useMetrics(() => props.context, () => props.ctx.todayEt)
      return items.map((fi) => {
        if (fi.emptyOf) return null
        const spec = buildRequestSpec(fi.item, fi.scope)
        return spec ? request(spec) : null
      })
    }) ?? []
}
watch(flatItems, rebuildRefs, { immediate: true })
onScopeDispose(() => requestScope?.stop())

const visibleAt = (i: number): boolean => {
  const fi = flatItems.value[i]
  return !!fi && (!!fi.emptyOf || itemViewModel(fi.item, activeRefs.value[i]?.value, fi.scope, { todayEt: props.ctx.todayEt, values: props.values }).visible)
}

const barMax = computed(() => {
  if (!scaled.value) return 0
  const items = flatItems.value
  const refs = activeRefs.value
  const nums = items.flatMap((fi, i) => {
    if (fi.emptyOf || fi.item.display.as !== 'bar') return []
    const vm = itemViewModel(fi.item, refs[i]?.value, fi.scope, { todayEt: props.ctx.todayEt, values: props.values })
    return [vm.barValue ?? 0]
  })
  return nums.length ? Math.max(0, ...nums) : 0
})

// ── table, row repeat ────────────────────────────────────────────────────────────────────────
const tableRows = computed<ScopeInstance[]>(() => (props.section.layout === 'table' && !isColumnTable.value ? resolveRepeat(props.section.repeat, props.ctx, props.outerScope).map((r) => nestScope(r, props.outerScope)) : []))
/** A row-table column that reads as a number is right-aligned: a number or percent display, or a
 * stored reading's count (the sign-ups cell is text, but still a count). */
const isNumColumn = (it: MetricItemSpec) => it.display.as === 'number' || it.display.as === 'percent' || ('field' in it.data && it.data.field.startsWith('reading.count.'))
const tableHeaderTokens = computed(() => props.section.items.map((it) => itemLabelTokens(it, props.outerScope, props.ctx.todayEt, props.values)))
/** Each column's tooltip (MetricItem.hint) as plain text, or undefined. */
const tableHeaderHints = computed(() => props.section.items.map((it) => (it.hint === undefined ? undefined : resolveLabelTokens(it.hint, props.outerScope, undefined, props.ctx.todayEt, props.values).map((t) => t.value).join('') || undefined)))

// ── table, column repeat ─────────────────────────────────────────────────────────────────────
const tableColumns = computed<ScopeInstance[]>(() => (isColumnTable.value ? resolveRepeat(props.section.columns, props.ctx, props.outerScope).map((c) => nestScope(c, props.outerScope)) : []))
const columnHeaderTokens = computed(() => tableColumns.value.map((c) => resolveLabelTokens(props.section.columnLabel ?? columnDefaultLabel(c), c, undefined, props.ctx.todayEt, props.values)))
const rowsHeaderTokens = computed(() => (props.section.rowsLabel !== undefined ? resolveLabelTokens(props.section.rowsLabel, props.outerScope, undefined, props.ctx.todayEt, props.values) : []))
/** Each item row with its cells; a row whose every cell is gated out is left out. */
const columnRows = computed(() => {
  const n = tableColumns.value.length
  return props.section.items
    .map((item, r) => ({ item, r, labelTokens: itemLabelTokens(item, props.outerScope, props.ctx.todayEt, props.values) }))
    .filter(({ r }) => n === 0 || Array.from({ length: n }, (_, c) => visibleAt(r * n + c)).some(Boolean))
})

// A row table with no rows shows its repeat's `empty` text instead of vanishing (the readings log's
// "No readings yet."): once the data it waits on is in (a campaign's readings load, `ads`).
const tableEmpty = computed(() => {
  const r = props.section.repeat
  if (props.section.layout !== 'table' || isColumnTable.value || !r?.empty || tableRows.value.length) return false
  return props.outerScope.kind !== 'campaign' || !!props.outerScope.ads
})
const tableEmptyLabel = computed(() => (props.section.repeat?.empty ? resolveLabelTokens(props.section.repeat.empty.label, props.outerScope, undefined, props.ctx.todayEt, props.values) : []))
const tableEmptyText = computed(() => (props.section.repeat?.empty ? resolveLabelTokens(props.section.repeat.empty.text, props.outerScope, undefined, props.ctx.todayEt, props.values) : []))

const anyVisible = computed(() => {
  if (isColumnTable.value) return columnRows.value.length > 0
  // A row table is shown while any of its data cells is (a field column, such as a row's own
  // name, never keeps it on its own): a gated-out segment table disappears whole.
  // A table with NO data column at all (a readings log: every column is a field of the row) is
  // shown while any of its cells is: its rows, not a gated metric, are what it is.
  if (props.section.layout === 'table') {
    const fieldsOnly = props.section.items.every((it) => 'field' in it.data)
    return flatItems.value.some((fi, i) => (fieldsOnly || !('field' in fi.item.data)) && visibleAt(i))
  }
  return flatItems.value.some((_, i) => visibleAt(i))
})
</script>

<template>
  <div v-if="anyVisible || tableEmpty" class="metric-section" :class="`layout-${section.layout}`">
    <p v-if="titleTokens.length" class="section-title"><MetricLabel :tokens="titleTokens" /></p>

    <div v-if="isColumnTable" class="metric-table-wrap">
      <table class="metric-table columns">
        <thead>
          <tr>
            <th><MetricLabel :tokens="rowsHeaderTokens" /></th>
            <th v-for="(tokens, i) in columnHeaderTokens" :key="i" class="num"><MetricLabel :tokens="tokens" /></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in columnRows" :key="row.item.id">
            <th scope="row" class="row-label"><MetricLabel :tokens="row.labelTokens" /></th>
            <td v-for="(col, ci) in tableColumns" :key="ci" class="num">
              <MetricTableCell :item="row.item" :scope="col" :today-et="ctx.todayEt" :context="context" :values="values" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-else-if="tableEmpty" class="metric-table-empty">
      <MetricLabel :tokens="tableEmptyLabel" />
      <MetricLabel :tokens="tableEmptyText" />
    </p>

    <!-- Wrapped like the column table: a wide table scrolls inside its card instead of being clipped. -->
    <div v-else-if="section.layout === 'table'" class="metric-table-wrap">
      <table class="metric-table">
        <thead>
          <tr>
            <th v-for="(tokens, i) in tableHeaderTokens" :key="i" :class="{ num: isNumColumn(section.items[i]) }" :title="tableHeaderHints[i]"><MetricLabel :tokens="tokens" /></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(rowScope, ri) in tableRows" :key="ri" :class="{ incomplete: rowScope.kind === 'reading' && rowScope.reading.complete === false }">
            <td v-for="item in section.items" :key="item.id" :class="{ num: isNumColumn(item) }">
              <MetricTableCell :item="item" :scope="rowScope" :today-et="ctx.todayEt" :context="context" :values="values" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="items-wrap">
      <template v-for="(fi, i) in flatItems" :key="`${fi.item.id}-${i}`">
        <MetricPlaceholder
          v-if="fi.emptyOf"
          :label-tokens="resolveLabelTokens(fi.emptyOf.label, fi.scope, undefined, ctx.todayEt, values)"
          :text-tokens="resolveLabelTokens(fi.emptyOf.text, fi.scope, undefined, ctx.todayEt, values)"
          :frame="fi.item.frame ?? defaultFrame"
        />
        <MetricItem v-else :item="fi.item" :scope="fi.scope" :frame="fi.item.frame ?? defaultFrame" :today-et="ctx.todayEt" :context="context" :values="values" :bar-max="scaled ? barMax : undefined" />
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
.metric-section + .metric-section {
  margin-top: 8px;
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
/* Bars side by side, in item order: a curve read left to right. */
.layout-columns .items-wrap {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: 6px;
  min-height: 150px;
}
/* A wide table scrolls inside its card on a phone instead of widening the page. */
.metric-table-wrap {
  overflow-x: auto;
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
.metric-table-empty {
  margin: 0;
  font-size: 11.5px;
  color: rgb(var(--ink-3));
}
/* A stored reading whose inputs were missing (its Kind also says so) is drawn dimmer. */
.metric-table tr.incomplete td {
  opacity: 0.7;
}
.metric-table th.num,
.metric-table td.num {
  text-align: right;
}
.metric-table.columns th.row-label {
  font-size: 11.5px;
  font-weight: 400;
  color: rgb(var(--ink-2));
}
</style>
