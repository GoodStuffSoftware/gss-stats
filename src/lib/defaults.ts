import type { DashboardConfig, DashboardPage, GlobalFilters, Widget } from '../types'

export function defaultDateRange(): { since: string; until: string } {
  const until = new Date()
  const since = new Date()
  since.setUTCDate(since.getUTCDate() - 6) // last 7 calendar days inclusive
  return { since: since.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) }
}

export function defaultFilters(): GlobalFilters {
  const { since, until } = defaultDateRange()
  return {
    site: 'goodstuff.software',
    host: '',
    since,
    until,
    excludeSelfReferrals: true,
    excludeOwnVisits: true,
    ownBrowser: 'Opera',
    ownOS: 'Windows',
  }
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
    w({ id: 'site-device', title: 'Site × device', type: 'nestedDoughnut', dimension: 'requestHost', breakdown: 'deviceType', metric: 'pageviews', limit: 30, x: 0, y: 11, w: 6, h: 8 }),
    w({ id: 'referrers', title: 'Top referrers', type: 'hbar', dimension: 'refererHost', metric: 'pageviews', limit: 10, excludeSelfReferrals: true, x: 6, y: 8, w: 6, h: 8 }),
    w({ id: 'country', title: 'By country', type: 'hbar', dimension: 'countryName', metric: 'pageviews', limit: 10, x: 6, y: 16, w: 6, h: 8 }),
    w({ id: 'pages', title: 'Top pages', type: 'hbar', dimension: 'requestPath', metric: 'pageviews', limit: 10, x: 0, y: 19, w: 6, h: 8 }),
    w({ id: 'device', title: 'Device split', type: 'doughnut', dimension: 'deviceType', metric: 'pageviews', limit: 6, x: 6, y: 24, w: 6, h: 8 }),
  ]
}

export function defaultPage(): DashboardPage {
  return { id: 'default', name: 'Overview', isDefault: true, filters: defaultFilters(), widgets: defaultWidgets() }
}

export function defaultConfig(): DashboardConfig {
  return { version: 2, activePageId: 'default', pages: [defaultPage()] }
}

function normWidget(x: any): Widget {
  const base = defaultFilters()
  return {
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
    // Per-chart override: back-fill any filter fields added since it was saved.
    filters: x.filters ? { ...base, ...x.filters } : undefined,
    x: Number(x.x) || 0,
    y: Number(x.y) || 0,
    w: Number(x.w) || 4,
    h: Number(x.h) || 8,
  }
}

function normPage(p: any, i: number): DashboardPage {
  return {
    id: String(p.id ?? cryptoId()),
    name: String(p.name ?? `Page ${i + 1}`),
    isDefault: !!p.isDefault,
    filters: { ...defaultFilters(), ...(p.filters ?? {}) },
    widgets: Array.isArray(p.widgets) ? p.widgets.map(normWidget) : defaultWidgets(),
  }
}

// Normalize a loaded config. Handles v2 (pages), migrates v1 (single page), and
// falls back to factory defaults for anything unrecognized.
export function normalizeConfig(raw: any): DashboardConfig {
  // v2 — already a pages config
  if (raw && typeof raw === 'object' && Array.isArray(raw.pages) && raw.pages.length) {
    const pages = raw.pages.map(normPage)
    if (!pages.some((p: DashboardPage) => p.isDefault)) pages[0].isDefault = true
    const activePageId = pages.some((p: DashboardPage) => p.id === raw.activePageId) ? raw.activePageId : pages[0].id
    return { version: 2, activePageId, pages }
  }
  // v1 — single page; wrap as the default page
  if (raw && typeof raw === 'object' && Array.isArray(raw.widgets)) {
    const page: DashboardPage = {
      id: 'default',
      name: 'Overview',
      isDefault: true,
      filters: { ...defaultFilters(), ...(raw.filters ?? {}) },
      widgets: raw.widgets.map(normWidget),
    }
    return { version: 2, activePageId: 'default', pages: [page] }
  }
  return defaultConfig()
}

export function cryptoId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID().slice(0, 8)
  return 'w' + Math.floor(Math.random() * 1e9).toString(36)
}

// Deep-clone a page with fresh ids (for duplication).
export function clonePage(src: DashboardPage, name: string): DashboardPage {
  const id = cryptoId()
  return {
    id,
    name,
    isDefault: false,
    filters: JSON.parse(JSON.stringify(src.filters)),
    widgets: src.widgets.map((wd) => {
      const wid = cryptoId()
      return { ...JSON.parse(JSON.stringify(wd)), id: wid, i: wid }
    }),
  }
}
