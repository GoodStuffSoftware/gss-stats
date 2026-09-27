<script setup lang="ts">
// One CardSpec section: a layout (rows/pills/tiles/bars/table) plus its own optional repeat
// (ADR 0003 section 1). 'table' is structurally different from the other four — items are
// COLUMNS and repeat instances are ROWS — so it gets its own branch with MetricTableCell
// instead of MetricItem.
import { computed, effectScope, onScopeDispose, shallowRef, watch, type EffectScope, type Ref } from 'vue'
import { useMetrics } from '../../composables/useMetrics'
import { buildRequestSpec, flattenSectionItems, resolveRepeat, type FlatItem, type RepeatContext, type ScopeInstance } from '../../lib/metrics/scope'
import { itemLabelTokens, itemViewModel, resolveLabelTokens } from '../../lib/metrics/render'
import type { MetricsContext, MetricValue, Section } from '../../lib/metrics/types'
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

// barMax (a 'bars' section scales every bar to the section's largest value) and anyVisible (a
// section left with no visible item after gating is omitted whole — ADR 0003, "Closed campaigns:
// omit, don't label") both need one value per flattened item, from the SAME shared useMetrics()
// cache every MetricItem uses (content-equal requests dedupe and share one fetch).
//
// Review fix, 2026-09-27 (the same staleness useMetricItem.ts had): these used to be acquired
// ONCE at setup from a snapshot of flattenSectionItems() taken then and never again — editing a
// 'bars' card's items, or a section's item list, left the bar scale or the show/hide decision
// reading stale data forever, because the snapshot (and the refs pointing at it) never updated
// when `flatItems` did. Fixed the same way: `activeRefs` is rebuilt — in a fresh nested
// effectScope, so the OLD useMetrics() consumers are released before the NEW ones are acquired
// (see useMetrics.ts releaseKey) — only when the flattened items' RESOLVED REQUEST PLAN actually
// changes (planKey), so a purely cosmetic edit (a label, a caption) never touches the fetch
// layer. `barMax`/`anyVisible` then read `flatItems.value` and `activeRefs.value` directly, both
// reactive, so they follow a live edit instead of freezing at first mount.
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

const barMax = computed(() => {
  if (props.section.layout !== 'bars') return 0
  const items = flatItems.value
  const refs = activeRefs.value
  const nums = items.flatMap((fi, i) => (fi.emptyOf || fi.item.display.as !== 'bar' ? [] : [refs[i]?.value ? (refs[i]!.value!.value ?? refs[i]!.value!.numerator ?? 0) : 0]))
  return nums.length ? Math.max(0, ...nums) : 0
})

const anyVisible = computed(() => {
  if (props.section.layout === 'table') return true
  const items = flatItems.value
  const refs = activeRefs.value
  return items.some((fi, i) => !!fi.emptyOf || itemViewModel(fi.item, refs[i]?.value, fi.scope, { todayEt: props.ctx.todayEt }).visible)
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
