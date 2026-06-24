import type { StatsResponse, Widget, GlobalFilters, DashboardConfig } from './types'

/** Fetch one widget's data from the server-side stats Function. */
export async function fetchStats(widget: Widget, filters: GlobalFilters): Promise<StatsResponse> {
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
