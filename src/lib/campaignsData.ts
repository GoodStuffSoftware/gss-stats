// Shared, cached fetch of /api/campaigns (per campaign id) for the "Best Sudoku campaigns"
// widget cards (see components/widgets/CampaignsWidgetBody.vue). Before the bespoke-page →
// widget conversion, CampaignComparePage.vue fetched every campaign once per page mount; now
// up to 7 separate widgets (funnel / hourOfDay / country / flightDay / cost / deviceMix /
// returns), each possibly scoped to a subset of campaigns via widget.campaignIds, can sit on
// the same page — this composable keys the fetch by campaign id, so the same campaign is
// never fetched twice regardless of how many widgets reference it.
import { ref, reactive, computed, watch, type Ref } from 'vue'
import type { CampaignCompareResponse } from '../types'
import { fetchCampaignCompare } from '../api'
import { CAMPAIGNS, type CampaignFlight } from './campaigns'

interface Entry {
  data: Ref<CampaignCompareResponse | null>
  loading: Ref<boolean>
  error: Ref<string | null>
}

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<void>>()

function getEntry(id: string): Entry {
  let e = cache.get(id)
  if (!e) {
    e = { data: ref(null), loading: ref(true), error: ref(null) }
    cache.set(id, e)
  }
  return e
}

async function ensureLoaded(id: string, force = false): Promise<Entry> {
  const e = getEntry(id)
  if (!force && (e.data.value || inflight.has(id))) {
    if (inflight.has(id)) await inflight.get(id)
    return e
  }
  if (inflight.has(id)) await inflight.get(id) // don't overlap an in-flight request even when forced
  const p = (async () => {
    e.loading.value = true
    e.error.value = null
    try {
      e.data.value = await fetchCampaignCompare(id)
    } catch (err: any) {
      e.error.value = err?.message ?? 'Failed to load'
    } finally {
      e.loading.value = false
      inflight.delete(id)
    }
  })()
  inflight.set(id, p)
  await p
  return e
}

/** `getIds` is a getter returning widget.campaignIds — empty/undefined means every campaign
 * (CAMPAIGNS), matching the pre-widget bespoke campaigns page's "always all campaigns"
 * behavior. Reacts to campaignIds changing (e.g. via ChartEditor) since the getter is
 * re-evaluated inside a computed.
 *
 * HIGH review fix (2026-09-26): a per-campaign `watch(e.data, …)` used to be created INSIDE
 * `load()`, an async function, after an `await` — by the time that line ran, Vue's active
 * effect scope (set only synchronously during a component's setup()/an `effectScope.run()`
 * callback) had already been torn down, so the watcher was registered in NO scope at all.
 * It was never tied to the calling widget and never stopped on unmount — every mount leaked
 * one watcher per campaign, forever, growing without bound across tab switches. Fixed by
 * moving watcher creation into the callback of a watch(campaigns, …) registered
 * SYNCHRONOUSLY at this function's top level (so it — and everything it creates — belongs
 * to the calling component's effect scope and IS auto-stopped on unmount), and disposing
 * the per-campaign watchers via that same watcher's `onCleanup` whenever the campaign list
 * changes or the component unmounts. */
export function useCampaignsData(getIds: () => string[] | undefined) {
  const campaigns = computed<CampaignFlight[]>(() => {
    const ids = getIds()
    return ids && ids.length ? CAMPAIGNS.filter((c) => ids.includes(c.id)) : CAMPAIGNS
  })
  const dataByCampaign = reactive<Record<string, CampaignCompareResponse>>({})
  const loading = ref(true)
  const error = ref<string | null>(null)

  // Populates the shared MODULE-level cache only (ensureLoaded) plus this composable's own
  // loading/error state — it never writes into `dataByCampaign` itself. Every write to
  // `dataByCampaign` goes through the properly-scoped per-campaign watchers below instead,
  // so scope.stop() (component unmount) reliably cuts off ALL of them, including a fetch
  // that was still in flight at unmount time — a plain `.then()` write here would ignore
  // scope disposal entirely and keep writing into a dead component's data.
  function kickOffFetches(list: CampaignFlight[], force = false) {
    loading.value = true
    error.value = null
    Promise.all(list.map((c) => ensureLoaded(c.id, force)))
      .catch((err: any) => {
        error.value = err?.message ?? 'Failed to load'
      })
      .finally(() => {
        loading.value = false
      })
  }

  watch(
    campaigns,
    (list, _prev, onCleanup) => {
      kickOffFetches(list)
      // One watcher per campaign currently in view — `immediate: true` covers a campaign
      // another widget already fetched/cached, and the callback covers one that resolves
      // later. Registered here, synchronously, inside this outer watcher's own
      // (properly-scoped) callback — never inside an async continuation.
      const stops = list.map((c) =>
        watch(
          getEntry(c.id).data,
          (d) => {
            if (d) dataByCampaign[c.id] = d
          },
          { immediate: true },
        ),
      )
      onCleanup(() => stops.forEach((stop) => stop()))
    },
    { immediate: true },
  )

  function reload() {
    kickOffFetches(campaigns.value, true)
  }

  return { campaigns, dataByCampaign, loading, error, reload }
}
