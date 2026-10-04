// Metric components (ADR 0003): the card config schema (section 1) and the POST /api/metrics
// wire types (section 3). Shared by the client and functions/api/metrics.ts. The registry's own
// definition types (FactDef, MetricDef, RatioDef, InstrumentationRule) live next to their
// registries in facts.ts / metrics.ts / ratios.ts / instrumentation.ts.

export type { Unit } from './units'

// ── Section 1: the config schema ──────────────────────────────────────────────────────────

/** Fields of the object a card instance is bound to. Config or stored records, never a
 * beacon query. */
export type ScopePath =
  | 'campaign.id'
  | 'campaign.label'
  | 'campaign.status'
  | 'campaign.statusToday'
  | 'campaign.flight'
  | 'campaign.measurabilityNote'
  /** The signed-out upsell fix (lib/adsRules.ts UPSELL_SIGNEDOUT_FIX_AT) as an ET minute, and
   * its flight day, when it falls in this campaign's flight (null otherwise, or while unset). */
  | 'campaign.upsellFixAt'
  | 'campaign.upsellFixFlightDay'
  /** The shared-tag note when another flight uses the same tag (its return beacons can't be told
   * apart); null otherwise. */
  | 'campaign.returnTagShared'
  /** The ads store's freshness line for the campaign ("Spend through Sep 27 · synced 2h ago",
   * plus "stale — sync pending" while a closed day is missing). From the readings load. */
  | 'campaign.freshness'
  /** The spend thresholds the campaign has fired, with the time each fired:
   * "$50 · Sep 26, 3:00 PM ET; $100 · …". null when none have. From the readings load. */
  | 'campaign.thresholds'
  | 'popup.id'
  | 'popup.label'
  | 'window.label'
  | 'country.label'
  /** The compared release (lib/releases.ts): "v1.95.3 (2026-09-26)". Config, not a query. */
  | 'release.label'
  | 'reading.readAt'
  | 'reading.kind'
  | 'reading.spend'
  | 'reading.rules'
  | 'reading.proposal'
  /** The five whitelisted count columns of a stored reading (READING_COUNT_FIELDS), each tied to
   * ONE field of the record: no generic `reading.count.<key>` path, so a return, game-start,
   * game-complete, tutorial or tour total can never be reached from a card. */
  | 'reading.count.arrivals'
  | 'reading.count.asks'
  | 'reading.count.accepts'
  | 'reading.count.auth'
  | 'reading.count.signUpsAtMost'
  /** Derived from signUpsAtMost and its exactness: "N (exact)", "at most N", or an em dash. */
  | 'reading.count.signUps'

/** The ScopePaths that read a count off a stored reading, and the record field each one reads
 * (privacy: the counts-only rule, read as rows only. This is the ALLOW-LIST: nothing else of
 * `ReadingRecord.counts` is ever copied into a card's scope, in particular none of the /return,
 * game-start, game-complete, tutorial or tour totals). */
export const READING_COUNT_FIELDS = {
  'reading.count.arrivals': 'taggedArrivals',
  'reading.count.asks': 'asks',
  'reading.count.accepts': 'accepts',
  'reading.count.auth': 'authSuccess',
  'reading.count.signUpsAtMost': 'signUpsAtMost',
} as const
export type ReadingCountPath = keyof typeof READING_COUNT_FIELDS
export const READING_COUNT_PATHS = Object.keys(READING_COUNT_FIELDS) as ReadingCountPath[]
/** Every `reading.count.*` path a card may use: the five above and the derived sign-ups text. */
export function isReadingCountPath(path: string): boolean {
  return Object.hasOwn(READING_COUNT_FIELDS, path) || path === 'reading.count.signUps'
}

/** (a) LABEL: literal text, or a bound object. */
export type Label =
  | string // literal; textLite markup; {campaign.label}-style vars from scope
  | { note: string; vars?: Record<string, ScopePath> } // a lib/notes.ts registry entry
  | { bind: ScopePath } // a field of the bound object, e.g. the campaign's name
  | { metric: true } // the data binding's own registry label

/** (b) DATA: a registry id plus params. Never SQL, never an endpoint path. */
export type ParamValue = string | { scope: 'campaignId' | 'popup' | 'country' }
export interface Params {
  campaignId?: ParamValue
  popup?: ParamValue
  /** A country bucket (COUNTRY_BUCKETS): optional wherever a metric declares it. */
  country?: ParamValue
}
/** The country buckets the campaign funnel splits by (lib/campaigns.ts countryBucket). */
export const COUNTRY_BUCKETS = ['US', 'CA', 'other'] as const
export type CountryBucket = (typeof COUNTRY_BUCKETS)[number]
/** The windows a card may ask for. `{ scope: 'window' }` takes the window from a repeat over
 * windows (RepeatSpec.over 'windows'). 'flight' and 'allTime' are reserved. */
export type WindowSpec = 'page' | 'attribution' | 'flight' | 'todaySoFar' | 'allTime' | ReleaseSide | UpsellSide | { scope: 'window' }
/** The compared release's before/after windows: the same number of days on each side of its
 * ET date, bounded by the first Best Sudoku hit (lib/overview.ts releaseComparisonWindows). */
export type ReleaseSide = 'before' | 'after'
/** A campaign's attribution window split at the signed-out upsell fix (a funnel segment
 * boundary, lib/adsRules.ts UPSELL_SIGNEDOUT_FIX_AT). */
export type UpsellSide = 'upsellPre' | 'upsellPost'
export type WindowSide = ReleaseSide | UpsellSide
export const WINDOW_SIDES: readonly WindowSide[] = ['before', 'after', 'upsellPre', 'upsellPost']
/** The windows the registry can compute (lib/metrics/metrics.ts MetricDef.windows). */
export type WindowName = 'attribution' | 'todaySoFar' | 'page' | ReleaseSide | UpsellSide
export type DeltaName = 'yesterday' | 'avg7'

export type DataBinding =
  | { metric: string; params?: Params; window?: WindowSpec }
  | { ratio: string; params?: Params; window?: WindowSpec }
  | { field: ScopePath }

/** A table cell's colour, supplied by the scope field it reads (scope.ts scopeTone): never data of
 * its own, only how an already-shown value is drawn. The readings log's Rules and Proposal cells
 * use it: 'trip' red and bold, 'watch' amber and bold, 'clear' the plain ink, 'muted' the dim ink. */
export type CellTone = 'trip' | 'watch' | 'clear' | 'muted'

/** (c) DISPLAY. */
export type Display =
  | { as: 'number'; deltas?: DeltaName[] }
  | { as: 'currency' }
  | { as: 'percent'; decimals?: 0 | 1 | 2 | 3 | 4 } // always followed by "(n/d)"
  | { as: 'counts' } // "1,111 game-screen views · 353 arrivals"
  | { as: 'dateRange'; days?: boolean }
  | { as: 'datetime' }
  /** An ISO instant as Eastern time, "Sep 26, 3:00 PM ET" (a stored reading's read time). */
  | { as: 'datetime-et' }
  | { as: 'badge'; tones?: Record<string, 'neutral' | 'live' | 'warn'> }
  | { as: 'bar' } // a bar scaled to the section's largest value: a count, or a rate with its (n/d)
  | { as: 'date' } // a day (a 'time' metric): "Sep 26"
  | { as: 'ago' } // an instant (a 'time' metric), relative: "3h ago"
  | { as: 'status' } // the label note the value carries (e.g. where a spend figure came from), not the number
  | { as: 'sparkline'; series: 'daily' }
  | { as: 'text' }
export type DisplayAs = Display['as']

export interface Gating {
  minCohort?: number // may only RAISE the MIN_COHORT floor
  whenUnmeasured?: 'auto' | 'omit' | 'label' // auto = omit for a closed campaign, label otherwise
  whenEmpty?: 'dash' | 'omit' | { note: string } // a field or series with no value
  /** 'omit': a measured count of exactly 0 is left out (a campaign with no return beacons yet). */
  whenZero?: 'omit'
  /** A campaign flight that has not begun: no start date yet, or its attribution window opens
   * later. By default the first is omitted (a scorecard shows only what a flight can have) and the
   * second reads "not started". 'label': "not started" in both cases (the item stays, so an
   * upcoming flight's card shows its funnel); 'zero': a measured 0, for a count that cannot have
   * happened yet (an upcoming flight's arrivals). */
  whenNotStarted?: 'label' | 'zero'
}

/** RepeatSpec.limit for a readings repeat: the default and the cap (the readings endpoint's own). */
export const DEFAULT_READINGS_LIMIT = 30
export const MAX_READINGS_LIMIT = 500

export interface RepeatSpec {
  over: 'campaigns' | 'popups' | 'windows' | 'readings' | 'countries'
  ids?: string[] // campaigns, popups, countries (COUNTRY_BUCKETS); windows: WINDOW_SIDES
  status?: ('closed' | 'active' | 'upcoming')[]
  /** Campaigns only: beacon-tracked ones (not `measurement: 'spend-only'`). */
  tracked?: boolean
  /** Campaigns only: append the web-only organic baseline arm (lib/campaigns.ts ORGANIC_ARM_ID)
   * after the campaigns. Not a campaign, so the ids/status/tracked/flightingToday filters never
   * drop it; bindings that don't serve it are left out of its instance (scope.ts configRuling). */
  organic?: boolean
  flightingToday?: boolean
  /** Campaigns only: keep the campaigns the ads readings load says have something to show — a
   * stored reading, Ads-API spend, or an active flight — unless the widget selected campaigns
   * itself (narrowToCampaigns). What the ads readings log shows; none until the load answers. */
  withActivity?: boolean
  /** Readings only: at most this many (newest first; per campaign when nested in a campaign
   * repeat). A whole number, DEFAULT_READINGS_LIMIT when unset, MAX_READINGS_LIMIT at most. */
  limit?: number
  empty?: { label: Label; text: Label } // shown once when the repeat yields nothing
}

export interface MetricItem {
  id: string // stable within the card: keys, reorder, edits
  label: Label
  data: DataBinding
  display: Display
  gating?: Gating
  caption?: Label // rendered through NoteBlock under the value
  /** A table column's tooltip: shown as the title of the item's header cell (a 'table' section
   * only; other layouts ignore it). Plain text, never markup. */
  hint?: Label
  /** How the caption and the value's own notes (install-fix, counted-from, caveats) show:
   * 'inline' (default) as a line under the value; 'compact' behind a small notes toggle next
   * to the label, collapsed by default, so the card keeps its compact look. */
  captionMode?: 'inline' | 'compact'
  frame?: 'row' | 'pill' | 'tile' | 'column' // overrides the section layout for this item
  repeat?: RepeatSpec // expands in place, e.g. one tile per flighting campaign
}

export interface Section {
  /** 'bars': one horizontal bar per row; 'columns': bars side by side, read left to right as a
   * curve (a value over its bar, the label under it); 'table': items are columns, repeat
   * instances are rows (or the other way round with `columns`). */
  layout: 'rows' | 'pills' | 'tiles' | 'bars' | 'columns' | 'table'
  title?: Label
  repeat?: RepeatSpec
  /** 'table' only: the other orientation — items are ROWS (their label in the first cell) and
   * these repeat instances are the COLUMNS (headed by `columnLabel`, default the instance's own
   * name). Each cell's scope is the column instance inside the card's instance, so a campaign
   * card can split its funnel steps by country. */
  columns?: RepeatSpec
  columnLabel?: Label
  /** With `columns`: the heading over the item-label column (e.g. "Step"). */
  rowsLabel?: Label
  items: MetricItem[]
}

/** A control a card can host (CardSpec.actions): a code-reviewed component, never markup. */
export type CardAction = 'ads-refresh'
/** Registry-backed notices a card shows above its body, from its own data load: 'ads-readings'
 * is the readings store's warnings (unbound / unreadable), the small-numbers note and the
 * sync alerts, in that order. */
export type CardNotices = 'ads-readings'

/** The container: a Card (one instance) or, with `repeat`, a StatList of N identical instances. */
export interface CardSpec {
  v: 1
  repeat?: RepeatSpec
  title?: Label
  badge?: { data: DataBinding; display: Extract<Display, { as: 'badge' }> }
  sections: Section[]
  captions?: string[] // note ids under the whole card
  link?: 'campaigns-page' // click-through; replaces the scorecard's emit('open-campaigns')
  minWidth?: number // grid minimum per instance (230 px today)
  /** Controls in the card's status row: 'ads-refresh' syncs the campaigns' Google Ads spend now
   * (the ads refresh flow) and reloads the card. */
  actions?: CardAction[]
  /** Notices above the body (see CardNotices). Needs the ads readings load, so a card that
   * sets it loads GET /api/ads/readings like one that repeats over readings. */
  notices?: CardNotices
  /** "Updated Xs ago" (the card's latest successful load) with a reload control: top-right in
   * the card's header (`true` or 'header', where the old KPI panel had it) or in a footer. */
  showUpdated?: boolean | 'header' | 'footer'
}

/** What a Widget stores. A preset is a code-reviewed CardSpec in lib/metrics/presets.ts.
 * `from`, on a customized spec: the preset id CardEditor copied it from, so "Reset to preset"
 * (and "Customized from …") name the RIGHT preset instead of an arbitrary default — see
 * lib/metrics/validate.ts normCardRef, which keeps it only when it still resolves to a real
 * preset (ADR 0003 slice 6 review fix, 2026-09-27). Never trust it un-normalized: a `{ spec }`
 * read straight from storage may carry a stale or fabricated `from`. */
export type CardRef = { preset: string } | { spec: CardSpec; from?: string }

// ── Section 3: POST /api/metrics ──────────────────────────────────────────────────────────

/** Page filters a fact may honour (FactDef.honors). Validated by lib/metrics/validate.ts. */
export interface MetricsContext {
  since?: string
  until?: string
  sites?: string[]
  excludeOwnVisits?: boolean
  ownBrowser?: string
  ownOS?: string
}

export interface MetricRequest {
  key: string
  metric?: string
  ratio?: string
  params?: { campaignId?: string; popup?: string; country?: string }
  window?: string
  deltas?: DeltaName[]
  /** 'daily': also return the metric's per-ET-day points (MetricValue.series). A count or a
   * stored-spend amount only, in a ranged window (lib/metrics/series.ts seriesTwin). */
  series?: 'daily'
  /** May only RAISE MIN_COHORT for a proportion or cost (Gating.minCohort); the server clamps. */
  minCohort?: number
}

export interface MetricsRequestBody {
  v: 1
  context?: MetricsContext
  fresh?: boolean
  requests: MetricRequest[]
}

export type MetricStatus = 'ok' | 'too-few' | 'no-data' | 'unmeasured' | 'partial' | 'error'

/** A comparison. Both numbers are always finite (JSON has no Infinity/NaN); `deltaPct` is absent
 * when there is no percentage (the comparison value is zero). */
export interface MetricDelta {
  delta: number
  deltaPct?: number
}

/** One ET day's value: `day` is YYYY-MM-DD (ET), `value` a count (or dollars for spend). */
export interface SeriesPoint {
  day: string
  value: number
}

export interface MetricValue {
  status: MetricStatus
  value?: number | null
  /** Per-ET-day points, oldest first, for a `series: 'daily'` request (lib/metrics/series.ts):
   * at most 92, and a day that was not measured has NO point (a gap, never a zero). */
  series?: SeriesPoint[]
  numerator?: number
  denominator?: number
  /** Same-clock-time comparisons for a today-so-far count: only on a metric that never counts a
   * refused row (MetricDef.countsRefused: false). */
  deltas?: { yesterday?: MetricDelta; avg7?: MetricDelta }
  /** Whole-ET-day context for a today-so-far count that can count a refused row (instead of
   * `deltas`, never with them): `yesterday` is yesterday's full ET-day total and `avg7` the daily
   * average over the 7 full ET days before today (their sum / 7). Each is present only when the
   * request asked for that delta name and the comparison gate allows it (deltasAllowed). */
  wholeDays?: { yesterday?: number; avg7?: number }
  measuredFrom?: number // epoch ms, when partial
  provisional?: boolean // lagged numerator still arriving
  noteIds?: string[] // registry ids only, never text
  reason?: string // machine code: 'spend-only' | 'not-live' | 'not-seen-in-flight' | 'unknown-id' | ...
}

export interface MetricsResponseBody {
  v: 1
  generatedAt: string
  results: Record<string, MetricValue>
  meta: { facts: number; cacheHits: number; statements: number }
}
