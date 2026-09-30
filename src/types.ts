export type ChartType =
  | 'bar'
  | 'hbar'
  | 'line'
  | 'area'
  | 'doughnut'
  | 'pie'
  | 'nestedDoughnut'
  | 'stackedBar'
  // One dimension on the axis × one as the series (`breakdown`), grouped side by side or
  // stacked (Widget.barMode) — the generic "compare categories by a second category" chart.
  | 'breakdownBar'
  | 'map'
  | 'stat'
  | 'table'
  | 'rate' // a single computed percentage (pop-up tap/outcome/eligibility rate) — see lib/popupEvents.ts
  // A compact table of the VALID pop-up rates only (lib/popupEvents.ts POPUP_RATE_TABLE_KEYS) —
  // a stored type only since layout version 11: the widget renders its card (popup-rates),
  // each with its n/d and "too few to report" gating — pop-up dataset only.
  | 'rateTable'
  | 'note' // a static text tile (caveats/notes carried over from a bespoke page) — no data fetch

export type Metric = 'pageviews' | 'visits'

// 'overview'/'campaigns'/'ads-readings' back the panels that used to be bespoke,
// non-widget pages (OverviewPage.vue / CampaignComparePage.vue) — see Widget.view below.
// 'completions' is an ordinary GENERIC dataset (dimension/breakdown, same pipeline as
// 'geo'/'popup') — NOT bespoke — see functions/api/completions.ts + lib/catalog.ts
// COMPLETIONS_DIMENSIONS.
export type Dataset = 'rum' | 'geo' | 'popup' | 'overview' | 'campaigns' | 'ads-readings' | 'completions'

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
  // type 'breakdownBar' only: bars of one axis value side by side ('grouped', the default) or
  // stacked into one bar ('stacked'). Undefined = grouped.
  barMode?: 'grouped' | 'stacked'
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
  site?: SiteKey // legacy per-widget site value (never applied by a query; see siteSel)
  // Per-chart site selection (the chart editor's "Site override"): same tokens as the page's
  // siteSel (a domain, a host, or a beacon tag). Set = this chart ignores the page's site pick,
  // but still follows every other page filter (dates, drills, toggles). [] = all sites.
  siteSel?: string[]
  host?: string // optional per-widget host override
  excludeSelfReferrals?: boolean
  // dataset 'geo' only: lift the standing exclusion of pop-up/install/return/game-complete/
  // auth-status event-beacon paths (see lib/popupEvents.ts POPUP_EVENT_PREFIXES), so this
  // chart can group/filter on event rows too (e.g. by the new 'pathFamily' dimension).
  // Undefined/false = excluded, same as every chart before this option existed.
  includeEventBeacons?: boolean
  // dataset 'geo' only: also drop known test and household traffic (lib/campaigns.ts
  // EXCLUSIONS), as the campaigns and overview numbers do. Undefined/false = not applied.
  excludeKnownTraffic?: boolean
  // A date-dimension trend chart ('line'/'area'/'bar' with dimension 'date') only: overlay
  // Best Sudoku release markers (see lib/releases.ts) as dashed vertical lines, same visual
  // treatment as the Overview page's timeline. Undefined/false = no overlay.
  markers?: 'releases'
  // A date-dimension line/area chart: also draw go-live markers (the instants a measurement
  // started or changed) and/or shaded campaign-flight bands (lib/timelineOverlay.ts). Every
  // marker and band is listed, with its date and note, under the chart.
  goLiveMarkers?: boolean
  flightBands?: boolean
  // type 'line' with a breakdown: also draw each series' running total as a dashed line on a
  // right-hand axis (the campaigns flight-day chart's cumulative view).
  cumulative?: boolean
  // A beacon (geo) line/area chart on the date axis: draw these series instead of one line. Each
  // series is its own date query narrowed by `filter` (native geo field = value pairs, e.g.
  // keyEvent = 'install'; none = every page view), on the left or right y-axis.
  series?: LineSeries[]
  // Titles for the left / right y-axes of a series line chart (hidden at phone width).
  axisTitles?: { left?: string; right?: string }
  // Marked by the user as one of this page's default charts. "Restore default charts"
  // keeps the marked charts and drops the rest (falling back to the factory set when
  // nothing is marked). Undefined/false = not a default.
  isDefault?: boolean
  // Full per-chart filter override. When set, this chart ignores the global
  // filter bar and uses these instead. Undefined = follow the global filter.
  filters?: GlobalFilters | null
  // dataset 'overview' / 'campaigns': which former bespoke panel this widget is ('kpis' |
  // 'scorecard' | 'releasePanel'; 'funnel' | 'country' | 'cost' | 'returns'). Each is a metric
  // card (`card`, its preset — lib/defaults.ts CARD_PRESET_FOR_PANEL) since layout version 11;
  // the view only names the panel for the layout migrations. The former 'timeline', 'deviceMix',
  // 'hourOfDay' and 'flightDay' panels are standard charts (CONFIG_VERSION 9 and 11).
  // dataset 'ads-readings': the ads-routines worker's own view value(s) (e.g. 'log') — see
  // components/widgets/AdsReadingsWidgetCard.vue.
  view?: string
  // A metric card (ADR 0003): when set, ChartCard renders MetricCard from this reference and
  // ignores dataset/view/dimension/metric. `{ preset }` names a code-reviewed CardSpec
  // (lib/metrics/presets.ts); `{ spec }` is a saved spec. The v10 migration adds
  // `{ preset }` to the Overview's former bespoke 'kpis' and 'scorecard' panels and keeps their
  // dataset/view, so an older build still recognises them. Normalised by normCardRef on load.
  card?: import('./lib/metrics/types').CardRef
  // dataset 'campaigns' / 'ads-readings': which campaign(s) to include. Empty/undefined =
  // all campaigns (CAMPAIGNS in lib/campaigns.ts) — same as the pre-widget bespoke pages.
  campaignIds?: string[]
  // type 'note': the note's body text (custom/free text). `title` is still the widget
  // title as normal. Ignored when `noteId` is set (the registry note wins).
  note?: string
  // type 'note': a lib/notes.ts registry id — the note/text picked from the shared
  // registry (ChartEditor's "pick a note" dropdown) rather than typed by hand. Takes
  // priority over `note` when both are set.
  noteId?: string
  // type 'note' only: render via TextBlock.vue (longer/multi-paragraph prose) instead of
  // NoteBlock.vue (a single short caveat line). Undefined/false = NoteBlock.
  longText?: boolean
  // ANY widget: registry note ids to show as an attached caption under this chart (see
  // lib/notes.ts, components/NoteBlock.vue). Undefined = the dataset's scope defaults
  // (lib/notes.ts defaultNoteIdsForScope); an explicit [] means "no captions", even if the
  // scope has defaults — set once (e.g. by ChartEditor or a default layout), never
  // recomputed out from under a user's choice.
  notes?: string[]
  // grid geometry (managed by grid-layout-plus)
  x: number
  y: number
  w: number
  h: number
}

/** One line of a multi-series line chart (Widget.series). */
export interface LineSeries {
  label: string
  filter?: { field: string; value: string }[]
  axis?: 'left' | 'right'
  style?: 'solid' | 'dashed' | 'dotted'
  color?: number // index into lib/charts.ts PALETTE; default = the series' position
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
  // Page-level fallback for widget.includeEventBeacons (see Widget) — a geo chart with no
  // per-widget override inherits this. Set automatically when opening a filtered page from a
  // drill into an event-family pathFamily value (see lib/drill.ts drillNeedsEventBeacons,
  // App.vue openFilteredPage): without it, every OTHER widget on that page would apply the
  // standing event-beacon exclusion together with the new pathFamily constraint, which can
  // never match a row, and would render silently empty instead of showing the drilled-into
  // data. Undefined/false = excluded, same as before this field existed.
  includeEventBeacons?: boolean
}

// A single dashboard page: its own global filters + its own widgets (each of which
// may carry a per-chart filter override). Pages are fully independent.
export interface DashboardPage {
  id: string
  name: string
  isDefault: boolean // the default page (★ Overview) — not deletable; always restorable; shown pinned first
  // Navigation group (layout version 13): "All sites", "Best Sudoku", "Mine", … — a plain string,
  // so a new product is a new group with no code change. Group order is the order groups first
  // appear in `pages`; pages within a group keep their array order. The default page keeps its
  // group in data but is shown pinned first, outside the groups.
  group: string
  // Drill pages only: the ROOT page this one was drilled from (a drill from a drill page nests
  // under the same root). Shown nested under that page; deleted together with it.
  parentId?: string
  // A lib/icons.ts registry key (e.g. "megaphone") someone picked. Unset = resolved
  // automatically (inherited from the parent for a drill page, else from the page's charts).
  icon?: string
  filters: GlobalFilters
  widgets: Widget[]
}

/** Optional per-group overrides (layout version 13): a pinned badge colour (a palette slot
 * "g0"…"g6" or a hex colour) and/or a logo image URL replacing the lettered monogram. */
export interface GroupMeta {
  color?: string
  logo?: string
}

export interface DashboardConfig {
  version: number
  // The page a first-time viewer lands on. Since layout version 13 the page each viewer is on
  // lives in their own browser (lib/viewerPrefs.ts), not here: switching pages never writes the
  // shared config.
  activePageId: string
  pages: DashboardPage[]
  // When true, the date range is shared across every page (change it once, it applies
  // everywhere). Site selection and drill-downs stay per-page. Default off.
  syncRange?: boolean
  groupMeta?: Record<string, GroupMeta>
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
  // The raw counts behind `rate` — see lib/popupEvents.ts GatedRate. Shown next to every
  // rate tile (numerator/denominator) regardless of insufficientCohort, so a viewer always
  // sees the sample size a percentage came from.
  numerator?: number
  denominator?: number
  // Pop-up dataset only: a data caveat that travels with the response (e.g. the known
  // install-outcome gap, lib/popupEvents.ts INSTALL_ACCEPT_OUTCOME_FIXED_ET), rendered under
  // the chart so saved widgets with older titles still show it.
  note?: string
}

// (The bespoke "Best Sudoku campaigns" and "Best Sudoku overview" response shapes — /api/campaigns
// and /api/overview — and the pop-up rate table's rows retired with those panels in layout
// version 11: every one of them is a metric card or a standard chart now.)
