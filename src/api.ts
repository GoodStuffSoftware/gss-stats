import type { StatsResponse, Widget, GlobalFilters, DashboardConfig, Dataset, CampaignCompareResponse, OverviewResponse } from './types'
import type { AdsReadingsResponse } from './lib/adsStore'
import type { RefreshResult } from './lib/adsRefresh'
import { resolveSelection } from './sitesStore'
import { nativeField } from './lib/drill'
import { queryDims } from './lib/rings'
import { sessionExpired, checkSessionExpired, isAuthError, isNetworkError } from './session'

// Resolve a page's drill-downs into { field, value } pairs for one dataset. A drill
// on a dimension the dataset lacks (e.g. region on RUM) is simply omitted.
function drillConstraints(filters: GlobalFilters, dataset: Dataset): { field: string; value: string }[] {
  return (filters.drill ?? [])
    .map((d) => {
      const field = nativeField(d.key, dataset)
      return field ? { field, value: d.value } : null
    })
    .filter((c): c is { field: string; value: string } => c !== null)
}

/** A series line chart (Widget.series): one date query per series, each narrowed by its own
 * filter, fetched in parallel (the Function's edge cache keys each one separately). */
export async function fetchSeriesStats(widget: Widget, filters: GlobalFilters): Promise<StatsResponse[]> {
  const base: Widget = { ...widget, series: undefined, breakdown: undefined, rings: undefined }
  return Promise.all((widget.series ?? []).map((s) => fetchStats(base, filters, (s.filter ?? []).filter((f) => f.field && f.value))))
}

/** Fetch one widget's data from the server-side stats Function. */
export async function fetchStats(widget: Widget, filters: GlobalFilters, extraConstraints: { field: string; value: string }[] = []): Promise<StatsResponse> {
  // Resolve the site selection into concrete RUM hosts + beacon tags. Empty = all
  // real sites; dev/preview hosts are never in the list, so they never count.
  // A chart's own site override (Widget.siteSel) replaces the page's site pick; nothing else.
  const { hosts, tags } = resolveSelection(widget.siteSel ?? filters.siteSel)

  // Pop-up funnel dataset → /api/popups (same D1 `hits` table as the beacon, but
  // classified as sign-in/upsell/install events rather than page views).
  if (widget.dataset === 'popup') {
    const res = await fetch('/api/popups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // A rate tile asks for one rate; a rate table asks for every valid rate ('rates').
        dimension: widget.type === 'rate' ? 'rate' : widget.type === 'rateTable' ? 'rates' : widget.dimension || 'kind',
        rateKey: widget.type === 'rate' ? widget.dimension : undefined,
        popup: widget.popup,
        kind: widget.popupKind,
        since: filters.since,
        until: filters.until,
        limit: widget.limit ?? 50,
        sites: tags,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`popups ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  }

  // Completions dataset → /api/completions (D1-backed; mode × difficulty breakdown of
  // /game/complete/<mode>/<difficulty>). Generic dimension/breakdown pipeline, same as
  // 'geo'/'popup' — see functions/api/completions.ts + lib/catalog.ts COMPLETIONS_DIMENSIONS.
  if (widget.dataset === 'completions') {
    const res = await fetch('/api/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dimension: widget.dimension || 'mode',
        breakdown: widget.breakdown || undefined,
        since: filters.since,
        until: filters.until,
        limit: widget.limit ?? 50,
        sites: tags,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`completions ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  }

  // Geo beacon dataset → /api/geo (D1-backed, already bot-free).
  if (widget.dataset === 'geo') {
    // The full nested-doughnut ring list (dimension, breakdown, then any further
    // widget.rings — see lib/rings.ts). Sent as `dims` only when there are 2+ rings; older
    // single-dim / 2-dim requests keep using `dimension`/`breakdown` alone, unchanged.
    const rings = queryDims(widget)
    const res = await fetch('/api/geo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dimension: widget.type === 'map' ? 'points' : widget.dimension || 'region',
        breakdown: widget.breakdown || undefined,
        dims: rings.length >= 2 ? rings : undefined,
        since: filters.since,
        until: filters.until,
        limit: widget.type === 'map' ? 2000 : widget.limit ?? 50,
        sites: tags,
        // The page's drill-downs, plus (for one series of a series line chart) that series'
        // own filter — native geo fields, validated server-side against GEO_DIMS like any drill.
        constraints: [...drillConstraints(filters, 'geo'), ...extraConstraints],
        // "Hide my visits" / "hide self-referrals" apply to the beacon dataset too — same
        // resolution as the RUM branch below (widget-level override falls back to the global
        // filter) — so the two datasets agree instead of only RUM honoring these toggles.
        excludeSelfReferrals: widget.excludeSelfReferrals ?? filters.excludeSelfReferrals,
        excludeOwnVisits: filters.excludeOwnVisits,
        ownBrowser: filters.ownBrowser,
        ownOS: filters.ownOS,
        // Per-chart override, falling back to the page-level filter — same resolution as
        // excludeSelfReferrals above. The page-level value is normally unset (every existing
        // chart keeps excluding pop-up/install/return/game-complete/auth-status rows by
        // default); App.vue's openFilteredPage sets it when a drill lands on an event-family
        // pathFamily value, so every widget on that page — not just the one that was
        // drilled — can actually show the event rows it just filtered down to.
        includeEventBeacons: widget.includeEventBeacons === true || filters.includeEventBeacons === true,
        excludeKnownTraffic: widget.excludeKnownTraffic === true,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`geo ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  }

  // RUM: group by every effective ring dim (1 for a plain chart, 2+ for a nested doughnut).
  const dimensions = queryDims(widget)

  const body = {
    site: 'all', // all site tags; the requestHost allow-list below does the filtering
    hosts,
    since: filters.since,
    until: filters.until,
    dimensions,
    metric: widget.metric,
    limit: widget.limit ?? 50,
    excludeSelfReferrals: widget.excludeSelfReferrals ?? filters.excludeSelfReferrals,
    excludeOwnVisits: filters.excludeOwnVisits,
    ownBrowser: filters.ownBrowser,
    ownOS: filters.ownOS,
    constraints: drillConstraints(filters, 'rum'),
  }

  const res = await fetch('/api/stats', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`stats ${res.status}: ${text.slice(0, 200)}`)
  }
  return res.json()
}

// Expired-session handling for fetches that don't go through a ChartCard. fetchStats
// (every grid chart, pop-up charts included) throws "<name> 401: …" and ChartCard.load()
// runs the probe; the bespoke overview and campaign pages and the ads readings log call
// their fetchers directly, so those get the same handling here. A 401 from the auth gate, or a network-level
// failure (an expired Cloudflare Access session while Access is still in front), runs
// the confirming probe that raises the re-sign-in banner. The error is rethrown so the
// page still shows it.
async function withSessionCheck<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (isNetworkError(e) || isAuthError(e)) await checkSessionExpired()
    throw e
  }
}

/** Fetch one campaign's comparison data (funnel, hour-of-day, country, daily, device mix,
 * return visits — see lib/campaigns.ts + functions/api/campaigns.ts). */
export function fetchCampaignCompare(campaignId: string): Promise<CampaignCompareResponse> {
  return withSessionCheck(async () => {
    const res = await fetch('/api/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`campaigns ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  })
}

/** Fetch the "Best Sudoku overview" page's data (today-at-a-glance KPIs, timeline,
 * campaign scorecard, release panel — see lib/overview.ts + functions/api/overview.ts).
 * `since`/`until` scope ONLY the timeline (the page's "existing range control"). */
export function fetchOverview(since?: string, until?: string): Promise<OverviewResponse> {
  return withSessionCheck(async () => {
    const res = await fetch('/api/overview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ since, until }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`overview ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  })
}

/** Fetch the ads-read routine's readings log + stored spend (GET /api/ads/readings — see
 * lib/adsStore.ts + functions/api/ads/readings.ts). `query` is the URL-encoded
 * campaignId/limit query string AdsReadingsWidgetCard builds. */
export function fetchAdsReadings(query: string): Promise<AdsReadingsResponse> {
  return withSessionCheck(async () => {
    const res = await fetch(`/api/ads/readings?${query}`)
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`readings ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  })
}

/** "Refresh data" on the ads widgets (POST /api/ads/refresh — src/lib/adsRefresh.ts): syncs
 * stale Ads data through the gss-stats-sync Worker, rate-limited server-side. */
export function refreshAdsData(campaignIds: readonly string[]): Promise<RefreshResult> {
  return withSessionCheck(async () => {
    const res = await fetch('/api/ads/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignIds }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`refresh ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  })
}

/** Load the durable dashboard config from KV (null = use defaults). */
export async function loadConfig(): Promise<DashboardConfig | null> {
  try {
    const res = await fetch('/api/config')
    if (!res.ok) {
      if (res.status === 401) sessionExpired.value = true
      return null
    }
    const data = (await res.json()) as any
    // Accept any real stored config: v2/v3 have a `pages` array, legacy v1 has `widgets`.
    // (The old check only looked for `widgets`, so every v2/v3 config was discarded on
    // load and the dashboard silently reverted to defaults — losing all saved state.)
    return data && (Array.isArray(data.pages) || Array.isArray(data.widgets)) ? data : null
  } catch {
    return null
  }
}

/** Persist the dashboard config to KV. */
export async function saveConfig(cfg: DashboardConfig): Promise<boolean> {
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    })
    return res.ok
  } catch {
    return false
  }
}
