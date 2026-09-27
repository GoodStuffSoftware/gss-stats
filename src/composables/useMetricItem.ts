// Shared plumbing between MetricItem.vue (rows/pills/tiles/bars) and MetricTableCell.vue (the
// 'table' layout, where a MetricItem is a column rather than its own labeled row): resolve the
// item's data binding into a useMetrics() request against its scope, and turn the live result
// into an ItemViewModel. Split out so both call sites register their own useMetrics() request
// synchronously in THEIR OWN component's setup() — each v-for'd cell/row is a real component
// instance with its own effect scope, so onScopeDispose cleanup (see useMetrics.ts) applies to
// each one independently.
import { computed, type ComputedRef } from 'vue'
import { useMetrics } from './useMetrics'
import { buildRequestSpec, type ScopeInstance } from '../lib/metrics/scope'
import { itemViewModel, type ItemViewModel } from '../lib/metrics/render'
import type { MetricItem, MetricsContext } from '../lib/metrics/types'

export function useMetricItemViewModel(item: MetricItem, scope: ScopeInstance, context: MetricsContext | undefined, todayEt: string): ComputedRef<ItemViewModel> {
  const { request } = useMetrics(context)
  const spec = buildRequestSpec(item, scope)
  const valueRef = spec ? request(spec) : undefined
  return computed(() => itemViewModel(item, valueRef?.value, scope, { todayEt }))
}
