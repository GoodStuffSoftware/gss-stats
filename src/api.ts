import type { StatsResponse, Widget, GlobalFilters, DashboardConfig, Dataset } from './types'
import { resolveSelection } from './sitesStore'
import { nativeField } from './lib/drill'

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

  // Geo beacon dataset → /api/geo (D1-backed, already bot-free, single dimension).
  if (widget.dataset === 'geo') {
    const res = await fetch('/api/geo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dimension: widget.type === 'map' ? 'points' : widget.dimension || 'region',
        breakdown: widget.breakdown || undefined,
        since: filters.since,
        until: filters.until,
        limit: widget.type === 'map' ? 2000 : widget.limit ?? 50,
        sites: tags,
        constraints: drillConstraints(filters, 'geo'),
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`geo ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
  }

  const dimensions = widget.dimension
    ? widget.breakdown
      ? [widget.dimension, widget.breakdown]
      : [widget.dimension]
    : []

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
    if (!res.ok) return null
    const data = await res.json()
    return data && data.widgets ? data : null
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
