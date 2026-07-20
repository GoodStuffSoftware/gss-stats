import type { DashboardConfig, DashboardPage, GlobalFilters, Widget } from '../types'
import { parseDurationMs } from './range'

export function defaultDateRange(): { since: string; until: string } {
  const until = new Date()
  const since = new Date(until.getTime() - 7 * 86_400_000) // rolling last 7 days (ISO datetimes)
  return { since: since.toISOString(), until: until.toISOString() }
}

export function defaultFilters(): GlobalFilters {
  const { since, until } = defaultDateRange()
  return {
    siteSel: [], // all real sites
    since,
    until,
    rangeRel: '7d', // relative by default → stays "last 7 days" across reloads
    excludeSelfReferrals: true,
    excludeOwnVisits: true,
    ownBrowser: 'Opera',
    ownOS: 'Windows',
  }
}

// Map a legacy { site, host } filter to the new siteSel token list.
export function migrateSiteSel(raw: any): string[] {
  if (Array.isArray(raw?.siteSel)) return raw.siteSel.filter((x: any) => typeof x === 'string')
  const host = typeof raw?.host === 'string' ? raw.host : ''
  const site = typeof raw?.site === 'string' ? raw.site : ''
  if (host) return [host] // a specific subdomain was selected
  if (site && site !== 'all') return [site] // the whole site (domain)
  return [] // 'all' or unset
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
    w({ id: 'geo-region', title: 'Visitors by region (beacon)', type: 'hbar', dataset: 'geo', dimension: 'region', metric: 'pageviews', limit: 15, x: 0, y: 27, w: 6, h: 8 }),
    w({ id: 'geo-city', title: 'Top cities (beacon)', type: 'hbar', dataset: 'geo', dimension: 'city', metric: 'pageviews', limit: 15, x: 6, y: 27, w: 6, h: 8 }),
    w({ id: 'geo-visitor', title: 'New vs returning (beacon)', type: 'doughnut', dataset: 'geo', dimension: 'visitor', metric: 'pageviews', limit: 5, x: 0, y: 35, w: 6, h: 8 }),
    w({ id: 'geo-map', title: 'Visitor map (beacon)', type: 'map', dataset: 'geo', dimension: '', metric: 'pageviews', limit: 2000, x: 0, y: 43, w: 12, h: 9 }),
  ]
}

export function defaultPage(): DashboardPage {
  return { id: 'default', name: 'Overview', isDefault: true, filters: defaultFilters(), widgets: defaultWidgets() }
}

// Canonical "Beacon" page — all geo-dataset charts (bot-free region/city/ISP/map).
function gw(p: Omit<Widget, 'i' | 'metric' | 'dataset'>): Widget {
  return { metric: 'pageviews', dataset: 'geo', ...p, i: p.id }
}
export function defaultBeaconWidgets(): Widget[] {
  return [
    gw({ id: 'bcn-views', title: 'Pageviews', type: 'stat', dimension: 'site', limit: 1, x: 0, y: 0, w: 3, h: 3 }),
    gw({ id: 'bcn-visitor', title: 'New vs returning', type: 'doughnut', dimension: 'visitor', limit: 5, x: 0, y: 3, w: 3, h: 6 }),
    gw({ id: 'bcn-trend', title: 'Pageviews over time', type: 'area', dimension: 'date', limit: 90, x: 3, y: 0, w: 9, h: 8 }),
    gw({ id: 'bcn-site', title: 'Pageviews by site', type: 'bar', dimension: 'site', limit: 12, x: 0, y: 9, w: 6, h: 8 }),
    gw({ id: 'bcn-device', title: 'Device split', type: 'doughnut', dimension: 'device', limit: 6, x: 6, y: 8, w: 6, h: 8 }),
    gw({ id: 'bcn-sitedevice', title: 'Site × device', type: 'nestedDoughnut', dimension: 'site', breakdown: 'device', limit: 30, x: 0, y: 50, w: 7, h: 9 }),
    gw({ id: 'bcn-region', title: 'Visitors by region', type: 'hbar', dimension: 'region', limit: 15, x: 0, y: 17, w: 6, h: 8 }),
    gw({ id: 'bcn-city', title: 'Top cities', type: 'hbar', dimension: 'city', limit: 15, x: 6, y: 16, w: 6, h: 8 }),
    gw({ id: 'bcn-country', title: 'By country', type: 'hbar', dimension: 'country', limit: 10, x: 0, y: 25, w: 6, h: 8 }),
    gw({ id: 'bcn-isp', title: 'By ISP / network', type: 'hbar', dimension: 'org', limit: 12, x: 6, y: 24, w: 6, h: 8 }),
    gw({ id: 'bcn-ref', title: 'Top referrers', type: 'hbar', dimension: 'referrer', limit: 10, x: 0, y: 33, w: 6, h: 8 }),
    gw({ id: 'bcn-pages', title: 'Top pages', type: 'hbar', dimension: 'path', limit: 10, x: 6, y: 32, w: 6, h: 8 }),
    gw({ id: 'bcn-map', title: 'Visitor map', type: 'map', dimension: '', limit: 2000, x: 0, y: 41, w: 12, h: 9 }),
  ]
}
export function defaultBeaconPage(): DashboardPage {
  // siteSel [] = all real sites; the multi-select picker narrows it.
  return { id: 'beacon', name: 'Beacon', isDefault: false, filters: defaultFilters(), widgets: defaultBeaconWidgets() }
}

// "Best Sudoku launch" — a beacon page pre-filtered to the Best Sudoku traffic
// (web + app), focused on where visitors come from (referrers + subreddit) and geo.
export function defaultBestSudokuLaunchWidgets(): Widget[] {
  return [
    gw({ id: 'bsk-views', title: 'Pageviews', type: 'stat', dimension: 'site', limit: 10, x: 0, y: 0, w: 3, h: 3 }),
    gw({ id: 'bsk-visitor', title: 'New vs returning', type: 'doughnut', dimension: 'visitor', limit: 5, x: 0, y: 3, w: 3, h: 6 }),
    gw({ id: 'bsk-trend', title: 'Visits over time', type: 'area', dimension: 'date', limit: 90, x: 3, y: 0, w: 9, h: 8 }),
    gw({ id: 'bsk-ref', title: 'Where they come from (referrers)', type: 'hbar', dimension: 'referrer', limit: 12, x: 0, y: 9, w: 6, h: 8 }),
    gw({ id: 'bsk-refpath', title: 'Which subreddit / section', type: 'hbar', dimension: 'refpath', limit: 12, x: 6, y: 8, w: 6, h: 8 }),
    gw({ id: 'bsk-webapp', title: 'Web vs app', type: 'doughnut', dimension: 'site', limit: 5, x: 0, y: 17, w: 3, h: 7 }),
    gw({ id: 'bsk-device', title: 'Device', type: 'doughnut', dimension: 'device', limit: 6, x: 3, y: 17, w: 3, h: 7 }),
    gw({ id: 'bsk-country', title: 'By country', type: 'hbar', dimension: 'country', limit: 10, x: 6, y: 16, w: 6, h: 8 }),
    gw({ id: 'bsk-region', title: 'By region / state', type: 'hbar', dimension: 'region', limit: 12, x: 0, y: 24, w: 6, h: 8 }),
    gw({ id: 'bsk-city', title: 'Top cities', type: 'hbar', dimension: 'city', limit: 12, x: 6, y: 24, w: 6, h: 8 }),
    gw({ id: 'bsk-path', title: 'Top screens / pages', type: 'hbar', dimension: 'path', limit: 12, x: 0, y: 32, w: 6, h: 8 }),
    gw({ id: 'bsk-map', title: 'Visitor map', type: 'map', dimension: '', limit: 2000, x: 0, y: 40, w: 12, h: 9 }),
  ]
}
// The beacon site tags for Best Sudoku traffic. The web build tags itself
// "bestsudoku-web" (plus a small "bestsudoku" bucket from any page that falls back to the
// hostname auto-tag), and the app pings the beacon as "bestsudoku-app".
export const BEST_SUDOKU_SITES = ['bestsudoku-web', 'bestsudoku', 'bestsudoku-app']

export function defaultBestSudokuLaunchPage(): DashboardPage {
  return {
    id: 'bsk-launch',
    name: 'Best Sudoku launch',
    isDefault: false,
    filters: { ...defaultFilters(), siteSel: [...BEST_SUDOKU_SITES] },
    widgets: defaultBestSudokuLaunchWidgets(),
  }
}

export function defaultConfig(): DashboardConfig {
  return {
    version: 4,
    activePageId: 'default',
    pages: [defaultPage(), defaultBeaconPage(), defaultBestSudokuLaunchPage()],
  }
}

// A RUM dimension → its beacon (geo) equivalent, so a Cloudflare-RUM chart can be
// re-pointed at the bot-free beacon dataset without losing what it groups by.
const RUM_TO_GEO_DIM: Record<string, string> = {
  requestHost: 'site',
  requestPath: 'path',
  deviceType: 'device',
  countryName: 'country',
  refererHost: 'referrer',
  userAgentBrowser: 'browser',
  userAgentOS: 'os',
  date: 'date',
}

// Re-point one widget at the beacon (geo) dataset. Geo charts are count-based (the metric
// is ignored) and single-dimension except nested/stacked/table; a stat groups by 'site' so
// its total reflects the whole selection, and a map has no dimension.
export function beaconizeWidget(wd: Widget): Widget {
  const mapDim = (d: string | undefined): string => (d ? (RUM_TO_GEO_DIM[d] ?? d) : '')
  const next: Widget = { ...wd, dataset: 'geo', metric: 'pageviews' }
  if (wd.type === 'map') {
    next.dimension = ''
    next.breakdown = undefined
  } else if (wd.type === 'stat') {
    next.dimension = 'site'
    next.breakdown = undefined
    next.limit = Math.max(Number(wd.limit) || 0, 10)
  } else {
    next.dimension = mapDim(wd.dimension) || 'region'
    next.breakdown =
      wd.type === 'nestedDoughnut' || wd.type === 'stackedBar' || wd.type === 'table'
        ? wd.breakdown
          ? mapDim(wd.breakdown)
          : undefined
        : undefined
  }
  return next
}

// The launch page, whether it's the auto-added one (id 'bsk-launch') or one the user
// built by duplicating another page and renaming it.
export function isBestSudokuLaunchPage(p: DashboardPage): boolean {
  return p.id === 'bsk-launch' || p.name.trim().toLowerCase() === 'best sudoku launch'
}

// Normalize a filter object, migrating legacy { site, host } → siteSel tokens.
function normFilters(raw: any): GlobalFilters {
  const base = defaultFilters()
  const merged = { ...base, ...(raw ?? {}), siteSel: migrateSiteSel(raw ?? {}), site: undefined, host: undefined }
  // Relative ranges are stored as a token and recomputed to a fresh now-relative window on
  // load, so "last 7d" always means the last 7 days (not a frozen window). An empty
  // rangeRel means an absolute (calendar) range — keep the stored since/until as-is.
  const rel = typeof merged.rangeRel === 'string' ? merged.rangeRel : ''
  const ms = rel ? parseDurationMs(rel) : null
  if (ms && ms > 0) {
    const until = new Date()
    merged.since = new Date(until.getTime() - ms).toISOString()
    merged.until = until.toISOString()
  }
  return merged
}

function normWidget(x: any): Widget {
  return {
    id: String(x.id ?? cryptoId()),
    i: String(x.id ?? x.i ?? cryptoId()),
    title: String(x.title ?? 'Untitled'),
    type: x.type ?? 'bar',
    dataset: x.dataset === 'geo' ? 'geo' : undefined,
    dimension: x.dimension ?? '',
    breakdown: x.breakdown || undefined,
    metric: x.metric === 'visits' ? 'visits' : 'pageviews',
    limit: Number(x.limit) || 50,
    site: x.site,
    host: x.host,
    excludeSelfReferrals: x.excludeSelfReferrals,
    // Per-chart override: back-fill any filter fields added since it was saved.
    filters: x.filters ? normFilters(x.filters) : undefined,
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
    filters: normFilters(p.filters),
    widgets: Array.isArray(p.widgets) ? p.widgets.map(normWidget) : defaultWidgets(),
  }
}

// Normalize a loaded config. Handles v2 (pages), migrates v1 (single page), and
// falls back to factory defaults for anything unrecognized.
export function normalizeConfig(raw: any): DashboardConfig {
  // v2/v3 — already a pages config
  if (raw && typeof raw === 'object' && Array.isArray(raw.pages) && raw.pages.length) {
    const pages = raw.pages.map(normPage)
    if (!pages.some((p: DashboardPage) => p.isDefault)) pages[0].isDefault = true
    // v3 migration: add the "Best Sudoku launch" page ONCE. Gated on version, so if it's
    // later deleted it won't keep coming back.
    if ((Number(raw.version) || 0) < 3 && !pages.some((p: DashboardPage) => p.id === 'bsk-launch')) {
      pages.push(defaultBestSudokuLaunchPage())
    }
    // v4 migration: make the "Best Sudoku launch" page fully beacon-backed. It was often
    // built by duplicating the RUM "Overview" page, so half its charts queried Cloudflare
    // RUM — which has next to no Best Sudoku data (the site is behind Access; the beacon is
    // the real source) — and rendered empty. Re-point every chart at the beacon and filter
    // to the Best Sudoku beacon tags. Runs once (version-gated), so later edits survive.
    if ((Number(raw.version) || 0) < 4) {
      for (const p of pages) {
        if (!isBestSudokuLaunchPage(p)) continue
        p.widgets = p.widgets.map(beaconizeWidget)
        p.filters.siteSel = [...BEST_SUDOKU_SITES]
      }
    }
    const activePageId = pages.some((p: DashboardPage) => p.id === raw.activePageId) ? raw.activePageId : pages[0].id
    return { version: 4, activePageId, pages, syncRange: !!raw.syncRange }
  }
  // v1 — single page; wrap as the default page
  if (raw && typeof raw === 'object' && Array.isArray(raw.widgets)) {
    const page: DashboardPage = {
      id: 'default',
      name: 'Overview',
      isDefault: true,
      filters: normFilters(raw.filters),
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
