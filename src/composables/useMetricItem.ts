// Shared plumbing between MetricItem.vue (rows/pills/tiles/bars) and MetricTableCell.vue (the
// 'table' layout, where a MetricItem is a column rather than its own labeled row): resolve the
// item's data binding into a useMetrics() request against its scope, and turn the live result
// into an ItemViewModel. Split out so both call sites register their own useMetrics() request
// synchronously in THEIR OWN component's setup() — each v-for'd cell/row is a real component
// instance with its own effect scope, so onScopeDispose cleanup (see useMetrics.ts) applies to
// each one independently.
//
// `item` and `scope` are REACTIVE GETTERS, not plain values (review fix, 2026-09-27): a saved
// card keeps the same MetricItem ids across an edit (CardEditor round-trips through
// validateCard, never regenerating ids for an unchanged item — lib/metrics/editorModel.ts
// freshId is only for a NEW item), so `v-for="... :key="item.id"` reuses the same MetricItem/
// MetricTableCell component instance. Capturing `item`/`scope` BY VALUE at setup — the bug this
// replaces — means that instance's request and label/display formatting are frozen at whatever
// the item looked like on first mount: editing a saved card's label, metric or display never
// reaches either a live ChartCard-rendered card or CardEditor's own preview, however long you
// wait. Reactive getters plus the rebuild below fix it where the staleness actually lives,
// so both call sites get the fix for free.
import { computed, effectScope, onScopeDispose, shallowRef, toValue, watch, type ComputedRef, type EffectScope, type MaybeRefOrGetter } from 'vue'
import { useMetrics } from './useMetrics'
import { buildRequestSpec, type ScopeInstance } from '../lib/metrics/scope'
import { itemViewModel, type ItemViewModel } from '../lib/metrics/render'
import type { MetricItem, MetricsContext, MetricValue } from '../lib/metrics/types'

/** A stable content key for what this item+scope would actually REQUEST (or '' for a `field`
 * binding, which makes no request) — used only to decide whether the underlying fetch needs to
 * be re-planned. An item edit that leaves the request unchanged (a label rewrite, a caption, a
 * gating tweak) must never tear down a perfectly good in-flight/cached request: the view model
 * still updates immediately (it's a plain `computed` over the current item/scope/value), just
 * without a new POST. */
function planKey(item: MetricItem, scope: ScopeInstance): string {
  const spec = buildRequestSpec(item, scope)
  return spec ? JSON.stringify(spec) : ''
}

export function useMetricItemViewModel(
  item: MaybeRefOrGetter<MetricItem>,
  scope: MaybeRefOrGetter<ScopeInstance>,
  context: MaybeRefOrGetter<MetricsContext | undefined>,
  todayEt: string,
): ComputedRef<ItemViewModel> {
  // The live value, swapped in place whenever the request is re-planned — never the ComputedRef
  // useMetrics().request() itself returns (that ref is tied to ONE cache entry; re-planning
  // means pointing at a DIFFERENT entry, which needs a plain ref this function owns).
  const valueRef = shallowRef<MetricValue | undefined>(undefined)
  let requestScope: EffectScope | null = null
  let currentKey: string | null = null

  // Same shape as MetricCard.vue's own buildCardRequests/dayScope: a nested effect scope, torn
  // down and rebuilt whenever the plan changes, so the OLD useMetrics() consumer is released
  // (refCount drops, the entry unqueues and aborts if nothing else wants it — see useMetrics.ts
  // releaseKey) before the NEW one is acquired. Two calls with an unchanged plan key are a no-op:
  // editing something that doesn't affect the request never touches the fetch layer.
  function replan(it: MetricItem, sc: ScopeInstance) {
    const key = planKey(it, sc)
    if (key === currentKey && requestScope) return
    currentKey = key
    requestScope?.stop()
    requestScope = effectScope(true)
    valueRef.value = undefined
    requestScope.run(() => {
      const { request } = useMetrics(context, todayEt)
      const spec = buildRequestSpec(it, sc)
      if (!spec) return // a `field` binding: nothing to fetch, itemViewModel reads the scope directly
      const ref = request(spec)
      watch(ref, (v) => (valueRef.value = v), { immediate: true })
    })
  }

  watch(
    () => [toValue(item), toValue(scope)] as const,
    ([it, sc]) => replan(it, sc),
    { immediate: true, deep: true },
  )
  onScopeDispose(() => requestScope?.stop())

  return computed(() => itemViewModel(toValue(item), valueRef.value, toValue(scope), { todayEt }))
}
