import type { StatsResponse, Widget, GlobalFilters, DashboardConfig, Dataset } from './types'
import { resolveSelection } from './sitesStore'
import { nativeField } from './lib/drill'
import { queryDims } from './lib/rings'
import { sessionExpired } from './session'

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

/** Fetch one widget's data from the server-side stats Function. */
export async function fetchStats(widget: Widget, filters: GlobalFilters): Promise<StatsResponse> {
  // Resolve the site selection into concrete RUM hosts + beacon tags. Empty = all
  // real sites; dev/preview hosts are never in the list, so they never count.
  const { hosts, tags } = resolveSelection(filters.siteSel)

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
        constraints: drillConstraints(filters, 'geo'),
        // "Hide my visits" / "hide self-referrals" apply to the beacon dataset too — same
        // resolution as the RUM branch below (widget-level override falls back to the global
        // filter) — so the two datasets agree instead of only RUM honoring these toggles.
        excludeSelfReferrals: widget.excludeSelfReferrals ?? filters.excludeSelfReferrals,
        excludeOwnVisits: filters.excludeOwnVisits,
        ownBrowser: filters.ownBrowser,
        ownOS: filters.ownOS,
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
