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

async function ensureLoaded(id: string): Promise<Entry> {
  const e = getEntry(id)
  if (e.data.value || inflight.has(id)) {
    if (inflight.has(id)) await inflight.get(id)
    return e
  }
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
 * re-evaluated inside a computed. */
export function useCampaignsData(getIds: () => string[] | undefined) {
  const campaigns = computed<CampaignFlight[]>(() => {
    const ids = getIds()
    return ids && ids.length ? CAMPAIGNS.filter((c) => ids.includes(c.id)) : CAMPAIGNS
  })
  const dataByCampaign = reactive<Record<string, CampaignCompareResponse>>({})
  const loading = ref(true)
  const error = ref<string | null>(null)

  async function load() {
    loading.value = true
    error.value = null
    try {
      await Promise.all(
        campaigns.value.map(async (c) => {
          const e = await ensureLoaded(c.id)
          if (e.data.value) dataByCampaign[c.id] = e.data.value
          watch(e.data, (d) => {
            if (d) dataByCampaign[c.id] = d
          })
        }),
      )
    } catch (err: any) {
      error.value = err?.message ?? 'Failed to load'
    } finally {
      loading.value = false
    }
  }
  watch(
    () => campaigns.value.map((c) => c.id).join(','),
    () => load(),
    { immediate: true },
  )

  return { campaigns, dataByCampaign, loading, error, reload: load }
}
