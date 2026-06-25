export type ChartType =
  | 'bar'
  | 'hbar'
  | 'line'
  | 'area'
  | 'doughnut'
  | 'pie'
  | 'nestedDoughnut'
  | 'stackedBar'
  | 'stat'
  | 'table'

export type Metric = 'pageviews' | 'visits'

export type SiteKey = 'goodstuff.software' | 'goodstuffsoftware.com' | 'bestsudoku.app' | 'all'

export interface Widget {
  id: string
  i: string // grid item id (mirrors id; required by grid-layout-plus)
  title: string
  type: ChartType
  dimension: string // primary group-by ('' for a plain total/stat)
  breakdown?: string // optional secondary dimension (stacked / grouped)
  metric: Metric
  limit: number
  site?: SiteKey // optional per-widget site override ('inherit' = use global)
  host?: string // optional per-widget host override
  excludeSelfReferrals?: boolean
  // Full per-chart filter override. When set, this chart ignores the global
  // filter bar and uses these instead. Undefined = follow the global filter.
  filters?: GlobalFilters | null
  // grid geometry (managed by grid-layout-plus)
  x: number
  y: number
  w: number
  h: number
}

export interface GlobalFilters {
  site: SiteKey
  host: string // '' = all hosts within the site
  since: string // YYYY-MM-DD
  until: string // YYYY-MM-DD
  excludeSelfReferrals: boolean
  // "Hide my own visits" — drops the owner's browser+OS combination server-side.
  excludeOwnVisits: boolean
  ownBrowser: string
  ownOS: string
}

// A single dashboard page: its own global filters + its own widgets (each of which
// may carry a per-chart filter override). Pages are fully independent.
export interface DashboardPage {
  id: string
  name: string
  isDefault: boolean // the default page — not deletable; always restorable
  filters: GlobalFilters
  widgets: Widget[]
}

export interface DashboardConfig {
  version: number
  activePageId: string
  pages: DashboardPage[]
}

export interface StatsRow {
  key: Record<string, string>
  pageviews: number
  visits: number
}

export interface StatsResponse {
  rows: StatsRow[]
  totals: { pageviews: number; visits: number }
  meta: {
    site: SiteKey
    host: string | null
    since: string
    until: string
    dimensions: string[]
    metric: Metric
  }
}
