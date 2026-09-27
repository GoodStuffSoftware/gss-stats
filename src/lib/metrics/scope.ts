// Scope resolution for metric components (ADR 0003 section 1, "Resolution rules"). A
// `RepeatSpec` expands a card, a section, or one item into N instances, each bound to one
// object (a campaign, a pop-up, a before/after window, or a stored reading); a `ScopePath`
// reads a field off that bound object; a `DataBinding`'s `params`/`window` inherit from the
// scope when left unset. Pure functions only — MetricCard.vue and MetricSection.vue call
// these to decide what to render and what to request, so the expansion is unit-testable
// without mounting a component.
import { CAMPAIGNS, campaignById, flightDayIndex, type CampaignFlight } from '../campaigns'
import { etDateFromMs, POPUPS, type PopupDef } from '../popupEvents'
import { campaignSegmentMarker, UPSELL_SIGNEDOUT_FIX_AT } from '../adsRules'
import { latestDatedRelease } from '../releases'
import { metricWindows, METRICS, rulesOf, type MetricDef, type MetricParam } from './metrics'
import { ratioParamsOf, ratioWindowsOf, RATIOS, type RatioDef } from './ratios'
import { COUNTRY_BUCKETS, WINDOW_SIDES, type CountryBucket, type DataBinding, type DeltaName, type Label, type MetricItem, type ParamValue, type RepeatSpec, type ScopePath, type Section, type WindowSide } from './types'

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

/** One object a card, section, item or table column is bound to. A nested repeat's instance
 * keeps the instance it sits in as its `parent` (a country column inside a campaign card), and
 * every lookup (a param, a field, a label variable) walks that chain, nearest first. */
export type ScopeInstance = (
  | { kind: 'root' }
  | { kind: 'campaign'; campaign: CampaignFlight }
  | { kind: 'popup'; popup: PopupDef }
  | { kind: 'window'; window: WindowSide }
  | { kind: 'country'; country: CountryBucket }
  | { kind: 'reading'; reading: ReadingScope }
) & { parent?: ScopeInstance }

export const ROOT_SCOPE: ScopeInstance = { kind: 'root' }

type ScopeOf<K extends ScopeInstance['kind']> = Extract<ScopeInstance, { kind: K }>
/** The nearest instance of this kind in the scope's chain (itself first). */
export function scopeOfKind<K extends ScopeInstance['kind']>(scope: ScopeInstance | undefined, kind: K): ScopeOf<K> | undefined {
  for (let s = scope; s; s = s.parent) if (s.kind === kind) return s as ScopeOf<K>
  return undefined
}
/** The campaign a scope is bound to, directly or through a parent. */
export function campaignOfScope(scope: ScopeInstance | undefined): CampaignFlight | undefined {
  return scopeOfKind(scope, 'campaign')?.campaign
}
/** `inner` nested inside `outer` (a section, item or column repeat inside a card instance). */
export function nestScope(inner: ScopeInstance, outer: ScopeInstance): ScopeInstance {
  return outer.kind === 'root' && !outer.parent ? inner : { ...inner, parent: outer }
}

const COUNTRY_LABELS: Record<CountryBucket, string> = { US: 'US', CA: 'CA', other: 'Other' }
const WINDOW_LABELS: Record<WindowSide, string> = { before: 'Before', after: 'After', upsellPre: 'pre-fix', upsellPost: 'post-fix' }

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
      if (repeat.tracked) list = list.filter((c) => c.measurement !== 'spend-only')
      if (repeat.flightingToday) list = list.filter((c) => flightDayIndex(c, ctx.todayEt) != null)
      return list.map((campaign) => ({ kind: 'campaign', campaign }))
    }
    case 'countries': {
      const ids = (repeat.ids?.length ? repeat.ids : COUNTRY_BUCKETS) as CountryBucket[]
      return ids.filter((c) => (COUNTRY_BUCKETS as readonly string[]).includes(c)).map((country) => ({ kind: 'country', country }))
    }
    case 'popups': {
      const list = repeat.ids?.length ? repeat.ids.map((id) => POPUPS.find((p) => p.id === id)).filter((p): p is PopupDef => !!p) : POPUPS
      return list.map((popup) => ({ kind: 'popup', popup }))
    }
    case 'windows': {
      const ids = (repeat.ids?.length ? repeat.ids : ['before', 'after']) as WindowSide[]
      return ids.filter((w) => WINDOW_SIDES.includes(w)).map((window) => ({ kind: 'window', window }))
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
  const campaign = campaignOfScope(scope)
  const popup = scopeOfKind(scope, 'popup')?.popup
  const window = scopeOfKind(scope, 'window')?.window
  const country = scopeOfKind(scope, 'country')?.country
  const reading = scopeOfKind(scope, 'reading')?.reading
  switch (path) {
    case 'campaign.id':
      return campaign ? campaign.id : null
    case 'campaign.label':
      return campaign ? campaign.label : null
    case 'campaign.status':
      return campaign ? campaign.status : null
    case 'campaign.statusToday':
      if (!campaign) return null
      return flightDayIndex(campaign, todayEt) != null ? 'flighting today' : campaign.status
    case 'campaign.flight':
      // The dateRange renderer wants both bounds; encode as "start|end" and let it split, so
      // this function's signature stays a single ScopePath -> string | null.
      if (!campaign || campaign.flightStart == null) return null
      return `${campaign.flightStart}|${campaign.flightEnd}`
    case 'campaign.measurabilityNote':
      return campaign ? (campaign.measurabilityNote ?? null) : null
    case 'campaign.upsellFixAt':
      return campaign ? (campaignSegmentMarker(campaign, [], UPSELL_SIGNEDOUT_FIX_AT)?.boundaryLabel ?? null) : null
    case 'campaign.upsellFixFlightDay': {
      const m = campaign ? campaignSegmentMarker(campaign, [], UPSELL_SIGNEDOUT_FIX_AT) : null
      const d = m && campaign ? flightDayIndex(campaign, m.boundaryDate) : null
      return d == null ? null : String(d)
    }
    case 'popup.id':
      return popup ? popup.id : null
    case 'popup.label':
      return popup ? popup.label : null
    case 'window.label':
      return window ? WINDOW_LABELS[window] : null
    case 'country.label':
      return country ? COUNTRY_LABELS[country] : null
    case 'release.label': {
      const r = latestDatedRelease()
      return r ? `${r.version} (${r.dateEt})` : null
    }
    case 'reading.readAt':
      return reading ? reading.readAt : null
    case 'reading.kind':
      return reading ? reading.kind : null
    case 'reading.spend':
      return reading ? String(reading.spend) : null
    case 'reading.rules':
      return reading ? (reading.rules ?? null) : null
    case 'reading.proposal':
      return reading ? (reading.proposal ?? null) : null
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
  const campaign = campaignOfScope(scope)
  if (campaign) {
    vars.campaign = {
      id: campaign.id,
      label: campaign.label,
      status: campaign.status,
      statusToday: scopeField(scope, 'campaign.statusToday', todayEt) ?? campaign.status,
    }
  }
  const popup = scopeOfKind(scope, 'popup')?.popup
  if (popup) vars.popup = { id: popup.id, label: popup.label }
  const window = scopeOfKind(scope, 'window')?.window
  if (window) vars.window = { label: WINDOW_LABELS[window] }
  const country = scopeOfKind(scope, 'country')?.country
  if (country) vars.country = { label: COUNTRY_LABELS[country] }
  const reading = scopeOfKind(scope, 'reading')?.reading
  if (reading) vars.reading = { readAt: reading.readAt, kind: reading.kind }
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
  params: { campaignId?: string; popup?: string; country?: string }
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
  const params: { campaignId?: string; popup?: string; country?: string } = {}
  for (const p of allowedParams) {
    const scopeVal = p === 'campaignId' ? campaignOfScope(scope)?.id : p === 'popup' ? scopeOfKind(scope, 'popup')?.popup.id : scopeOfKind(scope, 'country')?.country
    const v = resolveParamValue(binding.params?.[p], scopeVal)
    if (v !== undefined) params[p] = v
  }
  const windows = isMetric ? metricWindows(def as MetricDef) : ratioWindowsOf(def as RatioDef)
  // `{ scope: 'window' }`: the window of the repeat this item sits in (a before/after column).
  const bw = binding.window
  const window = typeof bw === 'object' && bw !== null ? scopeOfKind(scope, 'window')?.window : ((bw as string | undefined) ?? windows[0])
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
  const sectionScopes = section.repeat ? resolveRepeat(section.repeat, ctx).map((s) => nestScope(s, outerScope)) : [outerScope]
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
      const allScopes = resolveRepeat(item.repeat, ctx).map((s) => nestScope(s, sScope))
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

/** Every (item, scope) pair a section renders, whatever its layout: a 'table' with a row
 * repeat is rows × items; a 'table' with `columns` is items × columns (each cell inside the
 * outer instance); every other layout is flattenSectionItems. MetricCard and MetricCardInstance
 * collect a card's requests and notes from this, so they cannot miss a cell. */
export function sectionCells(section: Section, outerScope: ScopeInstance, ctx: RepeatContext): FlatItem[] {
  if (section.layout !== 'table') return flattenSectionItems(section, outerScope, ctx).filter((fi) => !fi.emptyOf)
  if (section.columns) {
    const cols = resolveRepeat(section.columns, ctx).map((c) => nestScope(c, outerScope))
    return section.items.flatMap((item) => cols.map((scope) => ({ item, scope })))
  }
  return resolveRepeat(section.repeat, ctx).flatMap((row) => section.items.map((item) => ({ item, scope: nestScope(row, outerScope) })))
}

/** The default heading of a table column: the column instance's own name. */
export function columnDefaultLabel(scope: ScopeInstance): Label {
  switch (scope.kind) {
    case 'campaign':
      return { bind: 'campaign.label' }
    case 'popup':
      return { bind: 'popup.label' }
    case 'window':
      return { bind: 'window.label' }
    case 'country':
      return { bind: 'country.label' }
    case 'reading':
      return { bind: 'reading.readAt' }
    default:
      return ''
  }
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
  params?: { campaignId?: string; popup?: string; country?: string }
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
  const campaign = campaignOfScope(scope)
  if (!campaign || 'field' in binding) return false
  const resolved = resolveBinding(binding, scope)
  if (!resolved || resolved.kind === 'field' || !resolved.window) return false
  const window = resolved.window as keyof MetricDef['windows']
  const sides = resolved.kind === 'metric' ? [resolved.def as MetricDef] : [METRICS.get((resolved.def as RatioDef).num), METRICS.get((resolved.def as RatioDef).den)]
  for (const def of sides) {
    if (!def || !def.params.includes('campaignId') || resolved.params.campaignId !== campaign.id) continue
    const fact = def.windows[window]
    // The ads store's reads (spend and its freshness) need no flight date, only a campaign.
    if (campaign.flightStart === null && fact !== 'adsSpend' && fact !== 'adsCoverage' && fact !== 'adsLastSync') return true
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
