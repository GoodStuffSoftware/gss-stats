// Scope resolution for metric components (ADR 0003 section 1, "Resolution rules"). A
// `RepeatSpec` expands a card, a section, or one item into N instances, each bound to one
// object (a campaign, a pop-up, a before/after window, or a stored reading); a `ScopePath`
// reads a field off that bound object; a `DataBinding`'s `params`/`window` inherit from the
// scope when left unset. Pure functions only — MetricCard.vue and MetricSection.vue call
// these to decide what to render and what to request, so the expansion is unit-testable
// without mounting a component.
import { CAMPAIGNS, campaignById, flightDayIndex, type CampaignFlight } from '../campaigns'
import { etDateFromMs, POPUPS, type PopupDef } from '../popupEvents'
import { metricWindows, METRICS, rulesOf, type MetricDef, type MetricParam } from './metrics'
import { ratioParamsOf, ratioWindowsOf, RATIOS, type RatioDef } from './ratios'
import type { DataBinding, DeltaName, Label, MetricItem, ParamValue, RepeatSpec, ScopePath, Section } from './types'

/** A stored ads-readings-log row (ADR 0003 slice 8 — the fact/type don't exist yet). Kept as
 * a minimal, forward-compatible shape so `RepeatSpec.over: 'readings'` and the `reading.*`
 * ScopePaths have something concrete to bind to today; a real `Reading` type replaces this
 * import when the readings-log preset lands. */
export interface ReadingScope {
  readAt: string
  kind: string
  spend: number
  rules?: string
  proposal?: string
}

export type ScopeInstance =
  | { kind: 'root' }
  | { kind: 'campaign'; campaign: CampaignFlight }
  | { kind: 'popup'; popup: PopupDef }
  | { kind: 'window'; window: 'before' | 'after' }
  | { kind: 'reading'; reading: ReadingScope }

export const ROOT_SCOPE: ScopeInstance = { kind: 'root' }

export interface RepeatContext {
  todayEt: string
  readings?: ReadingScope[]
}

/** The instances a RepeatSpec expands to, in a stable order. `undefined` (no repeat) always
 * yields exactly one root-scoped instance — the "just render this once" case (KPI tiles). */
export function resolveRepeat(repeat: RepeatSpec | undefined, ctx: RepeatContext): ScopeInstance[] {
  if (!repeat) return [ROOT_SCOPE]
  switch (repeat.over) {
    case 'campaigns': {
      let list = repeat.ids?.length ? repeat.ids.map((id) => campaignById(id)).filter((c): c is CampaignFlight => !!c) : CAMPAIGNS
      if (repeat.status?.length) list = list.filter((c) => repeat.status!.includes(c.status))
      if (repeat.flightingToday) list = list.filter((c) => flightDayIndex(c, ctx.todayEt) != null)
      return list.map((campaign) => ({ kind: 'campaign', campaign }))
    }
    case 'popups': {
      const list = repeat.ids?.length ? repeat.ids.map((id) => POPUPS.find((p) => p.id === id)).filter((p): p is PopupDef => !!p) : POPUPS
      return list.map((popup) => ({ kind: 'popup', popup }))
    }
    case 'windows': {
      const ids = (repeat.ids?.length ? repeat.ids : ['before', 'after']) as ('before' | 'after')[]
      return ids.filter((w) => w === 'before' || w === 'after').map((window) => ({ kind: 'window', window }))
    }
    case 'readings':
      return (ctx.readings ?? []).map((reading) => ({ kind: 'reading', reading }))
    default:
      return []
  }
}

/** Today's ET date, once per render pass, from `Date.now()` — a thin seam so tests can pin
 * `nowMs` instead of reaching for the clock, while still using the same DST-safe projection
 * (popupEvents.ts etDateFromMs) as every other ET-date computation in the codebase. */
export function todayEtFrom(nowMs: number): string {
  return etDateFromMs(nowMs)
}

/** One field of the object a scope instance is bound to (Section 1, "Labels"/"field" data
 * kind). `null` means the field has no value for this scope (an unconfirmed flight, a
 * non-campaign scope asked for a campaign field, …) — the caller applies `Gating.whenEmpty`. */
export function scopeField(scope: ScopeInstance, path: ScopePath, todayEt: string = todayEtFrom(Date.now())): string | null {
  switch (path) {
    case 'campaign.id':
      return scope.kind === 'campaign' ? scope.campaign.id : null
    case 'campaign.label':
      return scope.kind === 'campaign' ? scope.campaign.label : null
    case 'campaign.status':
      return scope.kind === 'campaign' ? scope.campaign.status : null
    case 'campaign.statusToday':
      if (scope.kind !== 'campaign') return null
      return flightDayIndex(scope.campaign, todayEt) != null ? 'flighting today' : scope.campaign.status
    case 'campaign.flight':
      // The dateRange renderer wants both bounds; encode as "start|end" and let it split, so
      // this function's signature stays a single ScopePath -> string | null.
      if (scope.kind !== 'campaign' || scope.campaign.flightStart == null) return null
      return `${scope.campaign.flightStart}|${scope.campaign.flightEnd}`
    case 'campaign.measurabilityNote':
      return scope.kind === 'campaign' ? (scope.campaign.measurabilityNote ?? null) : null
    case 'popup.id':
      return scope.kind === 'popup' ? scope.popup.id : null
    case 'popup.label':
      return scope.kind === 'popup' ? scope.popup.label : null
    case 'window.label':
      return scope.kind === 'window' ? (scope.window === 'before' ? 'Before' : 'After') : null
    case 'reading.readAt':
      return scope.kind === 'reading' ? scope.reading.readAt : null
    case 'reading.kind':
      return scope.kind === 'reading' ? scope.reading.kind : null
    case 'reading.spend':
      return scope.kind === 'reading' ? String(scope.reading.spend) : null
    case 'reading.rules':
      return scope.kind === 'reading' ? (scope.reading.rules ?? null) : null
    case 'reading.proposal':
      return scope.kind === 'reading' ? (scope.reading.proposal ?? null) : null
    default:
      return null
  }
}

/** `{campaign.label}`-style vars for tokenizeAndInterpolate, built from a scope — every
 * ScopePath the scope can answer, flattened to `{campaign: {label: ...}, popup: {...}, ...}`
 * so a literal-string Label's `{campaign.label}` placeholders resolve without ever touching
 * scope data that isn't already going through the same safe-text path as everything else. */
export function scopeVars(scope: ScopeInstance, todayEt: string = todayEtFrom(Date.now())): Record<string, Record<string, string>> {
  const vars: Record<string, Record<string, string>> = {}
  if (scope.kind === 'campaign') {
    vars.campaign = {
      id: scope.campaign.id,
      label: scope.campaign.label,
      status: scope.campaign.status,
      statusToday: scopeField(scope, 'campaign.statusToday', todayEt) ?? scope.campaign.status,
    }
  } else if (scope.kind === 'popup') {
    vars.popup = { id: scope.popup.id, label: scope.popup.label }
  } else if (scope.kind === 'window') {
    vars.window = { label: scope.window === 'before' ? 'Before' : 'After' }
  } else if (scope.kind === 'reading') {
    vars.reading = { readAt: scope.reading.readAt, kind: scope.reading.kind }
  }
  return vars
}

function resolveParamValue(pv: ParamValue | undefined, scopeVal: string | undefined): string | undefined {
  // Both "left unset" and an explicit `{ scope: ... }` marker mean "take it from the scope" —
  // an explicit string is the only thing that PINS a param instead (ADR section 1).
  return typeof pv === 'string' ? pv : scopeVal
}

export interface ResolvedBinding {
  kind: 'metric' | 'ratio' | 'field'
  def?: MetricDef | RatioDef
  params: { campaignId?: string; popup?: string }
  window?: string
  fieldValue?: string | null
}

/** Params + default window for a metric/ratio DataBinding against a scope — shared by
 * useMetrics request-building and by validateCard-style checks. Returns `null` for an
 * unknown metric/ratio id (the caller treats that as `status: 'error'`, matching the
 * server's `unknown-id`). */
export function resolveBinding(binding: DataBinding, scope: ScopeInstance): ResolvedBinding | null {
  if ('field' in binding) return { kind: 'field', params: {}, fieldValue: scopeField(scope, binding.field) }
  const isMetric = 'metric' in binding
  const id = isMetric ? binding.metric : binding.ratio
  const def: MetricDef | RatioDef | undefined = isMetric ? METRICS.get(id) : RATIOS.get(id)
  if (!def) return null
  const allowedParams: MetricParam[] = isMetric ? (def as MetricDef).params : ratioParamsOf(def as RatioDef)
  const params: { campaignId?: string; popup?: string } = {}
  for (const p of allowedParams) {
    const scopeVal = p === 'campaignId' ? (scope.kind === 'campaign' ? scope.campaign.id : undefined) : scope.kind === 'popup' ? scope.popup.id : undefined
    const v = resolveParamValue(binding.params?.[p], scopeVal)
    if (v !== undefined) params[p] = v
  }
  const windows = isMetric ? metricWindows(def as MetricDef) : ratioWindowsOf(def as RatioDef)
  const window = (binding.window as string | undefined) ?? windows[0]
  return { kind: isMetric ? 'metric' : 'ratio', def, params, window }
}

/** One (item, scope) pair after every repeat at every level (card → section → item) has been
 * expanded — the flat list MetricSection.vue renders. `emptyOf` carries a section/item's own
 * `repeat.empty` placeholder when that repeat matched nothing, so the caller can render one
 * "no campaign flighting today"-style row instead of silently showing nothing. */
export interface FlatItem {
  item: MetricItem
  scope: ScopeInstance
  emptyOf?: { label: Label; text: Label }
}

export function flattenSectionItems(section: Section, outerScope: ScopeInstance, ctx: RepeatContext): FlatItem[] {
  const sectionScopes = section.repeat ? resolveRepeat(section.repeat, ctx) : [outerScope]
  if (section.repeat && !sectionScopes.length) {
    return section.repeat.empty ? [{ item: emptyPlaceholderItem(section.items[0]?.id ?? 'empty'), scope: outerScope, emptyOf: section.repeat.empty }] : []
  }
  const out: FlatItem[] = []
  for (const sScope of sectionScopes) {
    for (const item of section.items) {
      if (!item.repeat) {
        out.push({ item, scope: sScope })
        continue
      }
      const allScopes = resolveRepeat(item.repeat, ctx)
      // Instances the campaign's own config rules out (a spend-only campaign) are dropped here, so
      // a repeat left with only those shows its empty placeholder — saying why — instead of
      // silently losing the tile.
      const itemScopes = allScopes.filter((s) => !unmeasuredByConfig(item.data, s))
      if (!itemScopes.length) {
        if (item.repeat.empty) {
          const untracked = allScopes.length > 0 && item.repeat.over === 'campaigns' && !!item.repeat.flightingToday
          out.push({ item, scope: sScope, emptyOf: untracked ? { label: item.repeat.empty.label, text: { note: 'no-tracked-campaign-flighting' } } : item.repeat.empty })
        }
        continue
      }
      for (const iScope of itemScopes) out.push({ item, scope: iScope })
    }
  }
  return out
}

function emptyPlaceholderItem(id: string): MetricItem {
  return { id: `${id}-empty`, label: '', data: { field: 'campaign.label' }, display: { as: 'text' } }
}

// ── useMetrics request-building (ADR 0003 section 3 wire shape, minus `key` — the composable
// derives that itself from the canonical request so identical requests from different cards
// dedupe automatically) ─────────────────────────────────────────────────────────────────────
export interface MetricRequestSpec {
  metric?: string
  ratio?: string
  params?: { campaignId?: string; popup?: string }
  window?: string
  deltas?: DeltaName[]
  minCohort?: number
}

/** True when the campaign's own config already rules the binding out — the same two checks
 * the server makes before any query (lib/metrics/engine.ts sideStatic): a campaign whose
 * flight has no start date yet reads nothing but spend, and a spend-only campaign
 * (`measurement: 'spend-only'`) never has beacon data. Such an item is omitted whatever the
 * campaign's status, and never requested, so a card shows no "…" for it and never labels it
 * "not yet tracking" (it never will be tracked). */
export function unmeasuredByConfig(binding: DataBinding, scope: ScopeInstance): boolean {
  if (scope.kind !== 'campaign' || 'field' in binding) return false
  const resolved = resolveBinding(binding, scope)
  if (!resolved || resolved.kind === 'field' || !resolved.window) return false
  const campaign = scope.campaign
  const window = resolved.window as keyof MetricDef['windows']
  const sides = resolved.kind === 'metric' ? [resolved.def as MetricDef] : [METRICS.get((resolved.def as RatioDef).num), METRICS.get((resolved.def as RatioDef).den)]
  for (const def of sides) {
    if (!def || !def.params.includes('campaignId') || resolved.params.campaignId !== campaign.id) continue
    const fact = def.windows[window]
    if (campaign.flightStart === null && fact !== 'adsSpend') return true
    const rules = rulesOf(def, { params: resolved.params, campaign, window: window as never })
    if (campaign.measurement === 'spend-only' && rules.some((r) => r.kind === 'beaconMeasurable')) return true
  }
  return false
}

/** The request a MetricItem's data binding resolves to against a scope, or `null` for a
 * `field` binding (no network round trip) or an unknown metric/ratio id (the caller treats
 * that the same as the server's `unknown-id`, i.e. an `error` status). */
export function buildRequestSpec(item: MetricItem, scope: ScopeInstance): MetricRequestSpec | null {
  const resolved = resolveBinding(item.data, scope)
  if (!resolved || resolved.kind === 'field') return null
  if (unmeasuredByConfig(item.data, scope)) return null // never asked: the answer is known
  const spec: MetricRequestSpec = {}
  if (resolved.kind === 'metric') spec.metric = (item.data as { metric: string }).metric
  else spec.ratio = (item.data as { ratio: string }).ratio
  if (Object.keys(resolved.params).length) spec.params = resolved.params
  if (resolved.window) spec.window = resolved.window
  if (item.display.as === 'number' && item.display.deltas?.length) spec.deltas = item.display.deltas
  if (item.gating?.minCohort != null) spec.minCohort = item.gating.minCohort
  return spec
}
