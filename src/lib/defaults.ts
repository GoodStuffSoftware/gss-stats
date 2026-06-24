import type { DashboardConfig, Widget } from '../types'

export function defaultDateRange(): { since: string; until: string } {
  const until = new Date()
  const since = new Date()
  since.setUTCDate(since.getUTCDate() - 6) // last 7 calendar days inclusive
  return { since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) }
}

function w(p: Omit<Widget, 'i'>): Widget {
  return { ...p, i: p.id }
}

// The default "basic charts available out of the box" — a sensible analytics
// starting layout. Users can move/resize/add/remove from here.
export function defaultWidgets(): Widget[] {
  return [
    w({ id: 'kpi-views', title: 'Pageviews', type: 'stat', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3 }),
    w({ id: 'kpi-visits', title: 'Visits', type: 'stat', dimension: '', metric: 'visits', limit: 1, x: 3, y: 0, w: 3, h: 3 }),
    w({ id: 'trend', title: 'Pageviews over time', type: 'area', dimension: 'date', metric: 'pageviews', limit: 90, x: 6, y: 0, w: 6, h: 8 }),
    w({ id: 'by-host', title: 'Pageviews by site', type: 'bar', dimension: 'requestHost', metric: 'pageviews', limit: 12, x: 0, y: 3, w: 6, h: 8 }),
    w({ id: 'site-device', title: 'Site × device', type: 'stackedBar', dimension: 'requestHost', breakdown: 'deviceType', metric: 'pageviews', limit: 12, x: 0, y: 11, w: 6, h: 8 }),
    w({ id: 'referrers', title: 'Top referrers', type: 'hbar', dimension: 'refererHost', metric: 'pageviews', limit: 10, excludeSelfReferrals: true, x: 6, y: 8, w: 6, h: 8 }),
    w({ id: 'country', title: 'By country', type: 'hbar', dimension: 'countryName', metric: 'pageviews', limit: 10, x: 6, y: 16, w: 6, h: 8 }),
    w({ id: 'pages', title: 'Top pages', type: 'hbar', dimension: 'requestPath', metric: 'pageviews', limit: 10, x: 0, y: 19, w: 6, h: 8 }),
    w({ id: 'device', title: 'Device split', type: 'doughnut', dimension: 'deviceType', metric: 'pageviews', limit: 6, x: 6, y: 24, w: 6, h: 8 }),
  ]
}

export function defaultConfig(): DashboardConfig {
  const { since, until } = defaultDateRange()
  return {
    version: 1,
    filters: { site: 'goodstuff.software', host: '', since, until, excludeSelfReferrals: true },
    widgets: defaultWidgets(),
  }
}

// Migrate a loaded config into a known-good shape (fill new fields, re-derive `i`).
export function normalizeConfig(raw: any): DashboardConfig {
  const base = defaultConfig()
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.widgets)) return base
  const widgets: Widget[] = raw.widgets.map((x: any) => ({
    id: String(x.id ?? cryptoId()),
    i: String(x.id ?? x.i ?? cryptoId()),
    title: String(x.title ?? 'Untitled'),
    type: x.type ?? 'bar',
    dimension: x.dimension ?? '',
    breakdown: x.breakdown || undefined,
    metric: x.metric === 'visits' ? 'visits' : 'pageviews',
    limit: Number(x.limit) || 50,
    site: x.site,
    host: x.host,
    excludeSelfReferrals: x.excludeSelfReferrals,
    x: Number(x.x) || 0,
    y: Number(x.y) || 0,
    w: Number(x.w) || 4,
    h: Number(x.h) || 8,
  }))
  return {
    version: raw.version ?? 1,
    filters: { ...base.filters, ...(raw.filters ?? {}) },
    widgets,
  }
}

export function cryptoId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID().slice(0, 8)
  return 'w' + Math.floor(Math.random() * 1e9).toString(36)
}
