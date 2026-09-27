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
  | 'popup.id'
  | 'popup.label'
  | 'window.label'
  | 'country.label'
  /** The latest dated release (lib/releases.ts): "v1.95.3 (2026-09-26)". Config, not a query. */
  | 'release.label'
  | 'reading.readAt'
  | 'reading.kind'
  | 'reading.spend'
  | 'reading.rules'
  | 'reading.proposal'

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
/** The latest dated release's before/after windows: the same number of days on each side of its
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

/** (c) DISPLAY. */
export type Display =
  | { as: 'number'; deltas?: DeltaName[] }
  | { as: 'currency' }
  | { as: 'percent'; decimals?: 0 | 1 | 2 } // always followed by "(n/d)"
  | { as: 'counts' } // "1,111 game-screen views · 353 arrivals"
  | { as: 'dateRange'; days?: boolean }
  | { as: 'datetime' }
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
}

export interface RepeatSpec {
  over: 'campaigns' | 'popups' | 'windows' | 'readings' | 'countries'
  ids?: string[] // campaigns, popups, countries (COUNTRY_BUCKETS); windows: WINDOW_SIDES
  status?: ('closed' | 'active' | 'upcoming')[]
  /** Campaigns only: beacon-tracked ones (not `measurement: 'spend-only'`). */
  tracked?: boolean
  flightingToday?: boolean
  empty?: { label: Label; text: Label } // shown once when the repeat yields nothing
}

export interface MetricItem {
  id: string // stable within the card: keys, reorder, edits
  label: Label
  data: DataBinding
  display: Display
  gating?: Gating
  caption?: Label // rendered through NoteBlock under the value
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

export interface MetricValue {
  status: MetricStatus
  value?: number | null
  numerator?: number
  denominator?: number
  deltas?: { yesterday?: MetricDelta; avg7?: MetricDelta }
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
