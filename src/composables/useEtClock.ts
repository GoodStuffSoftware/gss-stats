// The page's wall clock, as a ref that moves: what a "today" value reads so it rolls over at
// midnight ET on a tab nobody touches. MetricCard (its freshness text and its ET day) and the
// metric value tokens in a caption or note (useMetricTokens) both read it, so the two agree on
// which day it is and re-plan together.
//
// One module-level ticker serves every reader. It runs while at least one is alive (15 s, the
// freshness text's own grain) and stops with the last. A tab that slept past midnight has not
// ticked, so on return the clock still says yesterday; moving it there first (useReturnRefresh,
// subscribed BEFORE the caller's own useMetrics) makes the day watcher re-plan before the queued
// return refetch flushes, so only the new day's POST goes out.
import { getCurrentScope, onScopeDispose, ref, type Ref } from 'vue'
import { useReturnRefresh } from './useReturnRefresh'

export const ET_CLOCK_TICK_MS = 15_000

const now = ref(Date.now())
let readers = 0
let ticker: ReturnType<typeof setInterval> | null = null

/** The current time (epoch ms), refreshed every 15 s and on return to the tab. Call during
 * `setup()` or inside an effect scope; the ticker is released with that scope. */
export function useEtClock(): Readonly<Ref<number>> {
  now.value = Date.now()
  if (!getCurrentScope()) return now
  if (readers++ === 0) ticker = setInterval(() => (now.value = Date.now()), ET_CLOCK_TICK_MS)
  useReturnRefresh(() => (now.value = Date.now()))
  onScopeDispose(() => {
    if (--readers === 0 && ticker) {
      clearInterval(ticker)
      ticker = null
    }
  })
  return now
}
