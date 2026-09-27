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
  | 'popup.id'
  | 'popup.label'
  | 'window.label'
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
export type ParamValue = string | { scope: 'campaignId' | 'popup' }
export interface Params {
  campaignId?: ParamValue
  popup?: ParamValue
}
/** The windows a card may ask for. The registry serves 'attribution', 'todaySoFar' and 'page'
 * today; the others are reserved for later slices (flight, release before/after). */
export type WindowSpec = 'page' | 'attribution' | 'flight' | 'todaySoFar' | 'allTime' | 'before' | 'after' | { scope: 'window' }
/** The windows the registry can compute (lib/metrics/metrics.ts MetricDef.windows). */
export type WindowName = 'attribution' | 'todaySoFar' | 'page'
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
  | { as: 'bar' } // funnel bar, scaled to the section's largest count
  | { as: 'sparkline'; series: 'daily' }
  | { as: 'text' }
export type DisplayAs = Display['as']

export interface Gating {
  minCohort?: number // may only RAISE the MIN_COHORT floor
  whenUnmeasured?: 'auto' | 'omit' | 'label' // auto = omit for a closed campaign, label otherwise
  whenEmpty?: 'dash' | 'omit' | { note: string } // a field or series with no value
}

export interface RepeatSpec {
  over: 'campaigns' | 'popups' | 'windows' | 'readings'
  ids?: string[] // campaigns or popups; for windows: 'before' | 'after'
  status?: ('closed' | 'active' | 'upcoming')[]
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
  frame?: 'row' | 'pill' | 'tile' // overrides the section layout for this item
  repeat?: RepeatSpec // expands in place, e.g. one tile per flighting campaign
}

export interface Section {
  layout: 'rows' | 'pills' | 'tiles' | 'bars' | 'table' // 'table': items are columns, repeat instances are rows
  title?: Label
  repeat?: RepeatSpec
  items: MetricItem[]
}

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
}

/** What a Widget stores. A preset is a code-reviewed CardSpec in lib/metrics/presets.ts. */
export type CardRef = { preset: string } | { spec: CardSpec }

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
  params?: { campaignId?: string; popup?: string }
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
