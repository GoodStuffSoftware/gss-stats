// Shared, cached fetch of /api/overview for the "Best Sudoku overview" widget cards (see
// components/widgets/OverviewWidgetBody.vue). Before the bespoke-page → widget conversion,
// OverviewPage.vue fetched this once per page mount; now up to 4 separate widgets (kpis /
// timeline / scorecard / releasePanel) can sit on the same page, so this composable keys the
// fetch by since/until and hands every widget the SAME reactive result — one request per
// distinct range, not one per widget.
import { ref, shallowRef, computed, watch, type Ref } from 'vue'
import type { OverviewResponse } from '../types'
import { fetchOverview } from '../api'

interface Entry {
  data: Ref<OverviewResponse | null>
  loading: Ref<boolean>
  error: Ref<string | null>
}

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<void>>()

function getEntry(key: string): Entry {
  let e = cache.get(key)
  if (!e) {
    e = { data: ref(null), loading: ref(true), error: ref(null) }
    cache.set(key, e)
  }
  return e
}

async function ensureLoaded(since: string, until: string, force: boolean): Promise<Entry> {
  const key = `${since}|${until}`
  const e = getEntry(key)
  if (!force && (e.data.value || inflight.has(key))) {
    if (inflight.has(key)) await inflight.get(key)
    return e
  }
  // Delta review fix (2026-09-26): without this, a forced reload (the Refresh button) while
  // a fetch for the SAME key is already in flight (e.g. a filter change kicked one off,
  // then Refresh is clicked before it lands) would start a SECOND concurrent fetch. The
  // second one's `inflight.set(key, p)` below overwrites the first's map entry, so the
  // first fetch's own `finally` deletes an entry that belongs to the second — and whichever
  // response lands LAST wins, which is a race, not necessarily the freshest data. Waiting
  // for any existing in-flight request first (even when forced) means "force" always starts
  // its own fetch only after the previous one has fully settled — never two at once for the
  // same key.
  if (inflight.has(key)) await inflight.get(key)
  const p = (async () => {
    e.loading.value = true
    e.error.value = null
    try {
      e.data.value = await fetchOverview(since, until)
    } catch (err: any) {
      e.error.value = err?.message ?? 'Failed to load'
    } finally {
      e.loading.value = false
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  await p
  return e
}

/** `getSince`/`getUntil` are getters (not plain strings) so this composable reacts when the
 * page's filters change, even though it was constructed once per widget mount. */
export function useOverviewData(getSince: () => string, getUntil: () => string) {
  const key = computed(() => `${getSince()}|${getUntil()}`)
  // shallowRef — NOT ref — so Vue doesn't deep-unwrap the shared Entry's own nested refs
  // (data/loading/error) through this local variable; entry.value stays the exact Entry
  // object, its inner refs intact.
  const entry = shallowRef<Entry>(getEntry(key.value))

  function load(force = false) {
    ensureLoaded(getSince(), getUntil(), force).then((e) => {
      entry.value = e
    })
  }
  watch(key, () => load(false), { immediate: true })

  return {
    data: computed(() => entry.value.data.value),
    loading: computed(() => entry.value.loading.value),
    error: computed(() => entry.value.error.value),
    reload: () => load(true),
  }
}
