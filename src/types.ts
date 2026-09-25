export type ChartType =
  | 'bar'
  | 'hbar'
  | 'line'
  | 'area'
  | 'doughnut'
  | 'pie'
  | 'nestedDoughnut'
  | 'stackedBar'
  | 'map'
  | 'stat'
  | 'table'
  | 'rate' // a single computed percentage (pop-up tap/outcome/eligibility rate) — see lib/popupEvents.ts

export type Metric = 'pageviews' | 'visits'

export type Dataset = 'rum' | 'geo' | 'popup'

export type SiteKey = 'goodstuff.software' | 'goodstuffsoftware.com' | 'bestsudoku.app' | 'all'

// Auto-built site tree from /api/sites — one group per registrable domain, with its
// real subdomains (dev/preview already excluded), carrying both dataset identifiers.
export interface SiteSub {
  host: string // canonical/display host
  hosts: string[] // every RUM requestHost this represents (canonical + folded aliases)
  tag: string | null // primary beacon tag (display)
  tags: string[] // every beacon tag to filter by (canonical + folded aliases)
  rum: number
  geo: number
}
export interface SiteGroup {
  domain: string // registrable domain — the selectable "site"
  rum: number
  geo: number
  subs: SiteSub[]
}
export interface SitesResponse {
  sites: SiteGroup[]
}

export interface Widget {
  id: string
  i: string // grid item id (mirrors id; required by grid-layout-plus)
  title: string
  type: ChartType
  dataset?: Dataset // 'rum' (default), 'geo' (beacon region/city), or 'popup' (pop-up funnels)
  dimension: string // primary group-by ('' for a plain total/stat); for dataset 'popup' + type
  // 'rate', this is instead a lib/popupEvents.ts POPUP_RATE_SPECS `key` (e.g. 'signin-prompt:tap')
  breakdown?: string // optional secondary dimension (stacked / grouped)
  // dataset 'popup' only: which pop-up funnel (lib/popupEvents.ts POPUPS id, e.g.
  // 'signin-prompt') a 'kind'/'reason'/'date'/'outcome' dimension chart is scoped to.
  popup?: string
  // dataset 'popup' only: which funnel stage ('shown'/'accept'/'dismiss') a 'reason' or
  // 'date' dimension chart breaks down / trends. Defaults to 'shown' when unset.
  popupKind?: string
  // Nested doughnut only: further outer-ring dimensions beyond `breakdown`. The full ring
  // list, innermost → outermost, is [dimension, breakdown, ...rings] (see lib/rings.ts) — so
  // an existing 2-ring chart (no `rings`) is unaffected. Order matters: it's the nesting
  // order, outward from the center.
  rings?: string[]
  metric: Metric
  limit: number
  site?: SiteKey // optional per-widget site override ('inherit' = use global)
  host?: string // optional per-widget host override
  excludeSelfReferrals?: boolean
  // Marked by the user as one of this page's default charts. "Restore default charts"
  // keeps the marked charts and drops the rest (falling back to the factory set when
  // nothing is marked). Undefined/false = not a default.
  isDefault?: boolean
  // Full per-chart filter override. When set, this chart ignores the global
  // filter bar and uses these instead. Undefined = follow the global filter.
  filters?: GlobalFilters | null
  // grid geometry (managed by grid-layout-plus)
  x: number
  y: number
  w: number
  h: number
}

// A drill-down constraint: filter every chart on a page to one value of a dimension.
// `key` is a dataset-neutral semantic dimension (device/referrer/region/…) mapped to
// each dataset's native field at query time; geo-only keys simply don't touch RUM.
export interface DrillConstraint {
  key: string
  value: string
  label: string // display label, e.g. "mobile", "California"
}

export interface GlobalFilters {
  // Multi-select site filter. Each token is a domain (whole site) or a full host
  // (one subdomain). Empty = all real sites. Resolved via the /api/sites tree.
  siteSel: string[]
  drill?: DrillConstraint[] // active drill-downs (set when a page is opened from a chart)
  site?: SiteKey // legacy single-site (kept for migration + per-widget overrides)
  host?: string // legacy single-host
  since: string // YYYY-MM-DD
  until: string // YYYY-MM-DD
  // Relative-range token (e.g. "7d", "6h", "2w"). When set, since/until are RECOMPUTED
  // to a fresh now-relative window on every load, so "last 7d" stays "the last 7 days"
  // instead of freezing. Empty string = an absolute (calendar) range; keep since/until.
  rangeRel?: string
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
  // When true, the date range is shared across every page (change it once, it applies
  // everywhere). Site selection and drill-downs stay per-page. Default off.
  syncRange?: boolean
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
    // Pop-up dataset only — see lib/popupEvents.ts TRACKING_ACTIVATION_DATE_ET. `null`
    // means tracking hasn't shipped yet, in which case activationPending is always true.
    activationDate?: string | null
    activationPending?: boolean
  }
  // Pop-up dataset only (widget.type === 'rate'): the single computed rate, or null for
  // a zero denominator (no accepts/outcomes yet) — see lib/popupEvents.ts computeRate.
  rate?: number | null
  // true when `rate` is null because the denominator was nonzero but under MIN_COHORT
  // (see lib/popupEvents.ts gateRate) — render "too few to report", not "—".
  insufficientCohort?: boolean
}

// ── "Best Sudoku campaigns" (Part B) — a dedicated response shape (not the generic
// Widget/StatsResponse model above): see functions/api/campaigns.ts + lib/campaigns.ts. ──
export interface CampaignFunnelCounts {
  arrivals: number
  played: number
  completed: number
  ask: number
  accept: number
  authSuccess: number
  installPrompt: number
  install: number
}
export interface CampaignCompareResponse {
  campaign: {
    id: string
    label: string
    status: string
    flightStart: string | null
    flightEnd: string
    ucValues: string[]
    notes: string
    measurement: 'spend-only' | null
    measurabilityNote: string | null
  }
  funnel: {
    counts: CampaignFunnelCounts
    rates: Partial<Record<keyof CampaignFunnelCounts, number | null>>
    // Steps this FLIGHT can't show a rate for — its path never appeared anywhere in D1
    // during the flight window (or, for 'completed', anywhere at all) — see
    // lib/campaigns.ts FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED.
    notInstrumented: (keyof CampaignFunnelCounts)[]
    // Show wherever `counts.arrivals` is displayed — see lib/campaigns.ts ARRIVALS_CAVEAT.
    arrivalsCaveat: string
  }
  // EVERY row carrying this campaign's tag (the tag rides each beacon for its 30-min TTL) —
  // NOT the same as arrivals (`funnel.counts.arrivals`, visitor='new' only). Label it
  // "tagged hits" if shown at all — see the DEFINITION FIX comment in
  // functions/api/campaigns.ts / lib/campaigns.ts.
  taggedHits: number
  funnelByCountry: Record<'US' | 'CA' | 'other', CampaignFunnelCounts>
  hourOfDayEt: number[] // length 24, index = ET hour, value = arrivals
  daily: { date: string; day: number; arrivals: number }[] // sorted by date; `day` = flightDayIndex
  deviceMix: {
    os: Record<string, number>
    browser: Record<string, number>
    screen: Record<string, number> // bucketed — see lib/campaigns.ts screenWidthBucket
  }
  returnVisits: {
    counts: Record<string, number>
    rates: Record<string, number | null>
    notInstrumented: boolean
    sharedWithCampaignId: string | null
  }
  costPerArrival: number | null
  costPerAuthSuccess: number | null
  spend: number | null
  meta: { generatedAt: string }
}

// ── "Best Sudoku overview" (Part C) — see functions/api/overview.ts + lib/overview.ts. ──
export interface OverviewDelta {
  delta: number
  deltaPct: number | null
}
export interface OverviewKpiTile {
  key: string
  label: string
  today: number | null
  vsYesterday?: OverviewDelta | null
  vsAvg7?: OverviewDelta | null
  notYetTracking?: boolean
  noCampaignFlighting?: boolean
  campaignId?: string
  isRate?: boolean
  // Rate tiles only — the rate's own denominator, so the UI can tell "too few to report"
  // (MIN_COHORT) apart from plain "—" (no data at all) for a null `today`.
  denominator?: number
}
export interface OverviewDailyPoint {
  date: string
  pageviews: number
  taggedArrivals: number
  authSuccess: number
  install: number
}
export interface OverviewCampaignFlightMeta {
  id: string
  label: string
  flightStart: string | null
  flightEnd: string
  status: string
}
export interface OverviewScorecardRow {
  id: string
  label: string
  status: string
  flightStart: string | null
  flightEnd: string
  flightDays: number | null // null while flightStart is unconfirmed — see lib/campaigns.ts CAMPAIGNS
  flightingToday: boolean
  taggedArrivals: number
  funnelRates: Partial<Record<keyof CampaignFunnelCounts, number | null>>
  funnelCounts: CampaignFunnelCounts // pairs with funnelRates — see OverviewKpiTile.denominator
  authSuccess: number
  install: number
  returnRateD2to7: number | null
  returnD0: number // pairs with returnRateD2to7
  costPerArrival: number | null
}
export interface OverviewReleaseWindowSummary {
  pageviews: number
  taggedArrivals: number
  authSuccess: number
  install: number
}
export interface OverviewReleasePanel {
  release: { version: string; dateEt: string; note: string }
  days: number
  before: OverviewReleaseWindowSummary
  after: OverviewReleaseWindowSummary
  note: string
}
export interface OverviewResponse {
  generatedAt: string
  todayEt: string
  kpis: OverviewKpiTile[]
  timeline: {
    daily: OverviewDailyPoint[]
    campaignFlights: OverviewCampaignFlightMeta[]
    releaseMarkers: { version: string; dateEt: string; note: string }[]
    trackingActivationDate: string | null
    since: string
    until: string
  }
  scorecard: OverviewScorecardRow[]
  releasePanel: OverviewReleasePanel | null
}
