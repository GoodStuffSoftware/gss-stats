import type { StatsResponse, Widget, GlobalFilters, DashboardConfig } from './types'
import { SITES } from './lib/catalog'

// The beacon tags each hit by its hostname's first label (starrupture.goodstuff.software
// → "starrupture", goodstuff.software → "goodstuff", goodstuffsoftware.com →
// "goodstuffsoftware"). Map the dashboard's Site/Subdomain selection to those tags so
// the geo dataset honors the same filters as RUM. undefined = all sites (no filter).
function beaconSitesFor(widget: Widget, filters: GlobalFilters): string[] | undefined {
  const host = widget.host && widget.host !== ('inherit' as any) ? widget.host : filters.host
  if (host) return [host.split('.')[0]] // a specific subdomain was chosen
  if (!filters.site || filters.site === 'all') return undefined
  const def = SITES.find((s) => s.key === filters.site)
  const hosts = def && def.hosts.length ? def.hosts : [String(filters.site)]
  return hosts.map((h) => h.split('.')[0])
}

/** Fetch one widget's data from the server-side stats Function. */
export async function fetchStats(widget: Widget, filters: GlobalFilters): Promise<StatsResponse> {
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
        sites: beaconSitesFor(widget, filters),
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
    site: widget.site && widget.site !== ('inherit' as any) ? widget.site : filters.site,
    host: widget.host != null ? widget.host : filters.host,
    since: filters.since,
    until: filters.until,
    dimensions,
    metric: widget.metric,
    limit: widget.limit ?? 50,
    excludeSelfReferrals: widget.excludeSelfReferrals ?? filters.excludeSelfReferrals,
    excludeOwnVisits: filters.excludeOwnVisits,
    ownBrowser: filters.ownBrowser,
    ownOS: filters.ownOS,
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
