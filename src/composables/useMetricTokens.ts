// Fills `{=metric:<id>@<window>}` value tokens (lib/metricValueTokens.ts has the grammar and the
// pure half; lib/valueTokens.ts the table of every token's path). Every caption or note on a page
// goes through useMetrics, so N tokens across N widgets are ONE batched POST /api/metrics per
// page context, identical (metric, window, context) requests share one cache entry, and a card
// that already loaded the same value shares it too — nothing is fetched twice, and a token
// sends no more than a card does (see metricRequestSpec).
//
// Lazy on purpose: most widgets carry no metric token, so useMetrics (a return-refresh
// subscription and a context watcher) is only created, inside the component's own effect scope,
// the first time one appears. A token typed later (the editor changes the widget's text) joins
// the same instance.
import { computed, getCurrentScope, shallowRef, toValue, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue'
import type { MetricsContext, MetricValue } from '../lib/metrics/types'
import { todayEtFrom } from '../lib/metrics/scope'
import { metricRefsIn, metricRequestSpec, metricTokenValue, type MetricTokenRef } from '../lib/metricValueTokens'
import type { TokenValues } from '../lib/valueTokens'
import { useEtClock } from './useEtClock'
import { useMetrics, type UseMetrics } from './useMetrics'

/** The `metric:` values for every addressable token in `texts`, keyed by path, for the page
 * context `context`. Call during `setup()`. A path whose value is not (yet) known is present with
 * a null value, so it renders the placeholder; a malformed or unknown path is absent (also the
 * placeholder). */
export function useMetricTokenValues(
  texts: MaybeRefOrGetter<readonly (string | undefined | null)[]>,
  context: MaybeRefOrGetter<MetricsContext | undefined>,
): ComputedRef<TokenValues> {
  const scope = getCurrentScope()
  let metrics: UseMetrics | null = null
  const held = shallowRef(new Map<string, { ref: MetricTokenRef; value: Readonly<Ref<MetricValue | undefined>> }>())

  watch(
    () => metricRefsIn(toValue(texts)).map((r) => r.path).join('\n'),
    () => {
      const refs = metricRefsIn(toValue(texts))
      if (!refs.length || !scope?.active) return
      // Requests are made once per path and kept until the component goes (useMetrics releases
      // them on scope dispose): the set of addressable paths is small and bounded.
      // The day key follows the shared ET clock (the one MetricCard reads), so a "today so far"
      // token left open across ET midnight re-plans to the new day and refetches, instead of
      // keeping yesterday's entry alive under its own refcount.
      metrics ??=
        scope.run(() => {
          const clock = useEtClock()
          return useMetrics(context, () => todayEtFrom(clock.value))
        }) ?? null
      if (!metrics) return
      let next: Map<string, { ref: MetricTokenRef; value: Readonly<Ref<MetricValue | undefined>> }> | null = null
      for (const ref of refs) {
        if (held.value.has(ref.path)) continue
        next ??= new Map(held.value)
        next.set(ref.path, { ref, value: metrics.request(metricRequestSpec(ref)) })
      }
      if (next) held.value = next
    },
    { immediate: true, flush: 'sync' },
  )

  return computed(() => {
    const wanted = new Set(metricRefsIn(toValue(texts)).map((r) => r.path))
    const out: TokenValues = {}
    for (const [path, h] of held.value) if (wanted.has(path)) out[path] = metricTokenValue(h.ref, h.value.value)
    return out
  })
}
