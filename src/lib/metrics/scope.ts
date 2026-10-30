// Scope resolution for metric components (ADR 0003 section 1, "Resolution rules"). A
// `RepeatSpec` expands a card, a section, or one item into N instances, each bound to one
// object (a campaign, a pop-up, a before/after window, or a stored reading); a `ScopePath`
// reads a field off that bound object; a `DataBinding`'s `params`/`window` inherit from the
// scope when left unset. Pure functions only — MetricCard.vue and MetricSection.vue call
// these to decide what to render and what to request, so the expansion is unit-testable
// without mounting a component.
import { FEATURES, stepRatioLabel, type FeatureDef, type StepDef } from '../featureHealth'
import { COACH_TIP_ROWS } from '../coachTips'
import { ASK_ORDER_CARD_FEATURES, ASK_ORDER_TAGS } from '../askOrder'
import { CAMPAIGNS, campaignById, campaignStatusOn, flightDayIndex, hasBeaconRows, ORGANIC_ARM_ID, sharesReturnTagWith, type CampaignFlight } from '../campaigns'
import { noteRawText } from '../notes'
import { etDateFromMs, POPUPS, type PopupDef } from '../popupEvents'
import { campaignSegmentMarker, UPSELL_SIGNEDOUT_FIX_AT } from '../adsRules'
import { releaseAwaitingFullDay, releaseSubjectOn } from '../releases'
import { addDays } from '../etTime'
import { etDayText, freshnessLine, STALE_NOTE } from '../adsFreshness'
import { etDateTimeText, signUpsText } from '../adsReadingsFormat'
import { metricWindows, METRICS, rulesOf, type MetricDef, type MetricParam } from './metrics'
import { ratioParamsOf, ratioSupportsOrganic, ratioWindowsOf, RATIOS, type RatioDef } from './ratios'
import { COUNTRY_BUCKETS, DEFAULT_READINGS_LIMIT, MAX_READINGS_LIMIT, READING_COUNT_FIELDS, REPEAT_WINDOWS, type AssetSortField, type CellTone, type CountryBucket, type DataBinding, type DeltaName, type Gating, type Label, type MetricItem, type ParamValue, type ReadingCountPath, type RepeatSpec, type RepeatWindow, type ScopePath, type Section } from './types'

/** The count keys a reading scope carries: the record field behind each ReadingCountPath
 * (types.ts READING_COUNT_FIELDS, the allow-list). Nothing else of a record's counts gets here. */
export type ReadingCountKey = (typeof READING_COUNT_FIELDS)[ReadingCountPath]

/** A stored readings-log row as a card sees it (lib/metrics/readingsScope.ts builds one from a
 * ReadingRecord): an anonymous aggregate with its own read time, the already-formatted rule and
 * proposal text, and ONLY the five whitelisted counts. Never a beacon row, and none of the
 * return / game-start / game-complete / tutorial / tour totals a record also holds. */
export interface ReadingScope {
  /** Which campaign's log the reading belongs to: a readings repeat inside a campaign
   * instance keeps only that campaign's readings (resolveRepeat). */
  campaignId?: string
  readAt: string
  kind: string
  /** The reading's cumulative closed-day spend; null when the read had none. */
  spend: number | null
  rules?: string
  proposal?: string
  /** How the Rules and Proposal cells are coloured (scopeTone): the text itself says the same. */
  tones?: { rules?: CellTone; proposal?: CellTone }
  /** false when a read the record depends on returned no data. */
  complete?: boolean
  counts?: Partial<Record<ReadingCountKey, number | null>>
  /** Whether signUpsAtMost is an exact figure (otherwise an upper bound). */
  signUpsExact?: boolean
}

/** What a campaign's readings load says about it, for the `campaign.freshness` and
 * `campaign.thresholds` fields (lib/metrics/readingsScope.ts builds it from the response). */
export interface CampaignAdsInfo {
  spendThrough: string | null
  lastSync: string | null
  stale: boolean
  /** false when the readings store is absent or unreadable: no freshness line then. */
  storeBound: boolean
  thresholdsFired: { threshold: number; firedAt: string }[] | null
  /** When the data was loaded: the clock the freshness line's "synced 2h ago" counts from. */
  loadedAtMs: number
  /** The campaign has a stored reading, Ads-API spend or an active flight (RepeatSpec.withActivity). */
  hasActivity?: boolean
  /** The newest loaded daily reading that carries an F3 rules block (ads_readings.f3); absent
   * when none does (every non-F3 campaign, and an F3 arm before its first read). */
  f3?: CampaignF3Read
  /** The campaign's ad assets with their totals (the readings load answers them only when asked, `assets=1`); absent otherwise. */
  assets?: AssetScope[]
}
/** One ad asset of a campaign (RepeatSpec.over 'assets'): what it is and its totals over the days the ads store holds, for the sort.
 * Google's own per-asset aggregates; no user-level value. */
export interface AssetScope {
  id: string
  campaignId: string
  /** "Headline: Free daily sudoku": the field type, then the asset's text or, for an image, its name. */
  label: string
  impressions: number
  clicks: number
  conversions: number
}
/** One rule of a stored F3 read, as the report printed it. */
export interface RuleScope {
  n: number
  name: string
  number: string
  threshold: string | null
  verdict: string
}
/** A campaign's newest stored F3 read: its ET read date, flight day, proposal and rules. */
export interface CampaignF3Read {
  etDate: string
  flightDay: number
  proposal: 'PROPOSE PAUSE' | 'CONTINUE' | null
  rules: RuleScope[]
}

/** One object a card, section, item or table column is bound to. A nested repeat's instance
 * keeps the instance it sits in as its `parent` (a country column inside a campaign card), and
 * every lookup (a param, a field, a label variable) walks that chain, nearest first. */
export type ScopeInstance = (
  | { kind: 'root' }
  | { kind: 'campaign'; campaign: CampaignFlight; ads?: CampaignAdsInfo }
  /** The web-only organic baseline arm (lib/campaigns.ts ORGANIC_ARM_ID): a campaigns repeat's
   * extra instance (RepeatSpec.organic). Not a campaign: campaignOfScope never returns it. */
  | { kind: 'organic' }
  | { kind: 'popup'; popup: PopupDef }
  | { kind: 'window'; window: RepeatWindow }
  | { kind: 'country'; country: CountryBucket }
  | { kind: 'reading'; reading: ReadingScope }
  | { kind: 'rule'; rule: RuleScope }
  | { kind: 'asset'; asset: AssetScope }
  /** Feature health: a feature (FEATURES), and one of its steps (a steps repeat inside a features repeat). */
  /** `tag`: an Ask-order tag column (a tags repeat), the tag's name ("Organic"). */
  | { kind: 'feature'; feature: FeatureDef; tag?: string }
  | { kind: 'step'; step: StepDef; feature: FeatureDef }
) & { parent?: ScopeInstance }

export const ROOT_SCOPE: ScopeInstance = { kind: 'root' }

type ScopeOf<K extends ScopeInstance['kind']> = Extract<ScopeInstance, { kind: K }>
/** The nearest instance of this kind in the scope's chain (itself first). */
export function scopeOfKind<K extends ScopeInstance['kind']>(scope: ScopeInstance | undefined, kind: K): ScopeOf<K> | undefined {
  for (let s = scope; s; s = s.parent) if (s.kind === kind) return s as ScopeOf<K>
  return undefined
}
/** The campaign a scope is bound to, directly or through a parent. The nearest arm wins: an
 * organic instance nested inside a campaign's scope stands for the organic arm, not that
 * campaign, so this is undefined for it (as armIdOfScope says). */
export function campaignOfScope(scope: ScopeInstance | undefined): CampaignFlight | undefined {
  for (let s = scope; s; s = s.parent) {
    if (s.kind === 'campaign') return s.campaign
    if (s.kind === 'organic') return undefined
  }
  return undefined
}
/** The `campaignId` a scope's nearest arm stands for: a campaign's id, or ORGANIC_ARM_ID for the
 * organic instance; undefined when neither is in the chain. */
export function armIdOfScope(scope: ScopeInstance | undefined): string | undefined {
  for (let s = scope; s; s = s.parent) {
    if (s.kind === 'asset') return s.asset.campaignId
    if (s.kind === 'campaign') return s.campaign.id
    if (s.kind === 'organic') return ORGANIC_ARM_ID
  }
  return undefined
}
/** Whether a scope's nearest arm is the organic baseline (not a campaign). */
export function isOrganicScope(scope: ScopeInstance | undefined): boolean {
  return armIdOfScope(scope) === ORGANIC_ARM_ID
}
/** `inner` nested inside `outer` (a section, item or column repeat inside a card instance). */
export function nestScope(inner: ScopeInstance, outer: ScopeInstance): ScopeInstance {
  return outer.kind === 'root' && !outer.parent ? inner : { ...inner, parent: outer }
}

const COUNTRY_LABELS: Record<CountryBucket, string> = { US: 'US', CA: 'CA', other: 'Other' }
const WINDOW_LABELS: Record<RepeatWindow, string> = { before: 'Before', after: 'After', upsellPre: 'pre-fix', upsellPost: 'post-fix', latestDay: 'Latest day', previousDay: 'Previous day', page: 'Range' }

export interface RepeatContext {
  todayEt: string
  readings?: ReadingScope[]
  /** The readings load's per-campaign facts, by campaign id: attached to that campaign's
   * instance for `campaign.freshness` / `campaign.thresholds`. */
  ads?: Record<string, CampaignAdsInfo>
}

/** A readings repeat's row limit: its `limit` as a whole number from 1 to MAX_READINGS_LIMIT,
 * DEFAULT_READINGS_LIMIT when unset or not a usable number. */
export function readingsLimit(repeat: Pick<RepeatSpec, 'limit'> | undefined): number {
  const n = repeat?.limit
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_READINGS_LIMIT) : DEFAULT_READINGS_LIMIT
}
type RepeatHolder = { repeat?: RepeatSpec; sections?: { repeat?: RepeatSpec; columns?: RepeatSpec; columnGroups?: RepeatSpec[]; items?: { repeat?: RepeatSpec }[] }[] }
/** Every repeat of a card (the card's, its sections', their columns' and items'). */
export function cardRepeats(spec: RepeatHolder): RepeatSpec[] {
  const out: RepeatSpec[] = []
  if (spec.repeat) out.push(spec.repeat)
  for (const s of spec.sections ?? []) {
    if (s.repeat) out.push(s.repeat)
    if (s.columnGroups) out.push(...s.columnGroups)
    if (s.columns) out.push(s.columns)
    for (const it of s.items ?? []) if (it.repeat) out.push(it.repeat)
  }
  return out
}
/** Whether a card repeats over stored readings anywhere: it then needs the readings load. */
export function repeatsOverReadings(spec: RepeatHolder): boolean {
  return cardRepeats(spec).some((r) => r.over === 'readings')
}
/** Every ScopePath the card names, through an item's `data.field`, a label's `bind` or a note
 * label's `vars` (anywhere in the spec: items, titles, captions, hints, column labels). */
function namedScopePaths(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const x of node) namedScopePaths(x, out)
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'field' || k === 'bind') && typeof v === 'string') out.push(v)
      else if (k === 'vars' && v && typeof v === 'object') out.push(...Object.values(v).filter((x): x is string => typeof x === 'string'))
      else namedScopePaths(v, out)
    }
  }
  return out
}
/** Whether the card reads the ads readings load's per-campaign facts (`campaign.freshness`,
 * `campaign.thresholds`) anywhere. It then needs GET /api/ads/readings even with no readings repeat. */
export function usesAdsInfoFields(spec: unknown): boolean {
  return namedScopePaths(spec).some((p) => p === 'campaign.freshness' || p === 'campaign.thresholds')
}
/** Whether the card repeats over a campaign's ad assets anywhere: it then needs the readings load with the asset list (`assets=1`). */
export function usesAssets(spec: unknown): boolean {
  return cardRepeats(spec as RepeatHolder).some((r) => r.over === 'assets')
}
/** Whether the card reads a stored reading's own fields (`reading.*`) anywhere. */
export function usesReadingFields(spec: unknown): boolean {
  return namedScopePaths(spec).some((p) => p.startsWith('reading.'))
}
/** Whether the card shows a stored F3 read (`campaign.f3*`, `rule.*`, or a repeat over rules).
 * It then needs the readings load, deep enough to reach the newest daily read behind the
 * threshold and health rows of the same days (DEFAULT_READINGS_LIMIT per campaign). */
export function usesF3Read(spec: unknown): boolean {
  if (cardRepeats(spec as RepeatHolder).some((r) => r.over === 'rules')) return true
  return namedScopePaths(spec).some((p) => p.startsWith('campaign.f3') || p.startsWith('rule.'))
}
/** The most readings per campaign any readings repeat of the card asks for (what to request). */
export function readingsLimitOf(spec: RepeatHolder): number {
  const limits = cardRepeats(spec).filter((r) => r.over === 'readings').map(readingsLimit)
  return limits.length ? Math.max(...limits) : DEFAULT_READINGS_LIMIT
}

/** A widget's campaign selection (Widget.campaignIds) applies to a card whose top-level repeat
 * is over campaigns: it narrows that repeat (after its own ids/status/tracked filters). */
export function selectsCampaigns(repeat: RepeatSpec | undefined): boolean {
  return repeat?.over === 'campaigns'
}
/** The card-level instances for a widget's campaign selection: `instances` narrowed to the
 * selected campaigns, in the repeat's own order; unchanged when nothing is selected or the
 * repeat is not over campaigns. The organic baseline is not a campaign the widget can pick, so
 * a repeat that asks for it keeps it, whatever the selection. */
export function narrowToCampaigns(instances: ScopeInstance[], repeat: RepeatSpec | undefined, campaignIds: readonly string[] | undefined): ScopeInstance[] {
  if (!selectsCampaigns(repeat)) return instances
  // No selection: a withActivity repeat keeps only the campaigns with something to show (none
  // until the readings load answers). A selection names the campaigns itself.
  if (!campaignIds?.length) return repeat?.withActivity ? instances.filter((s) => s.kind === 'organic' || (s.kind === 'campaign' && !!s.ads?.hasActivity)) : instances
  return instances.filter((s) => s.kind === 'organic' || (s.kind === 'campaign' && campaignIds.includes(s.campaign.id)))
}

/** The instances a RepeatSpec expands to, in a stable order. `undefined` (no repeat) always
 * yields exactly one root-scoped instance — the "just render this once" case (KPI tiles).
 * `outer` is the instance the repeat sits in (a section inside a campaign card): a readings
 * repeat keeps only the readings of that instance's campaign, so a card repeated over
 * campaigns shows each campaign's own log; with no campaign in scope it is every reading. */
export function resolveRepeat(repeat: RepeatSpec | undefined, ctx: RepeatContext, outer?: ScopeInstance): ScopeInstance[] {
  if (!repeat) return [ROOT_SCOPE]
  switch (repeat.over) {
    case 'campaigns': {
      let list = repeat.ids?.length ? repeat.ids.map((id) => campaignById(id)).filter((c): c is CampaignFlight => !!c) : CAMPAIGNS
      if (repeat.status?.length) list = list.filter((c) => repeat.status!.includes(campaignStatusOn(c, ctx.todayEt)))
      // Deliberately not hasBeaconRows: a tagged spend-only arm (Flight 4) still has no funnel/country/returns card of its own.
      if (repeat.tracked) list = list.filter((c) => c.measurement !== 'spend-only')
      if (repeat.flightingToday) list = list.filter((c) => flightDayIndex(c, ctx.todayEt) != null)
      const out: ScopeInstance[] = list.map((campaign) => (ctx.ads?.[campaign.id] ? { kind: 'campaign', campaign, ads: ctx.ads[campaign.id] } : { kind: 'campaign', campaign }))
      // The organic baseline comes last, after every campaign (RepeatSpec.organic).
      if (repeat.organic) out.push({ kind: 'organic' })
      return out
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
      const ids = (repeat.ids?.length ? repeat.ids : ['before', 'after']) as RepeatWindow[]
      return ids.filter((w) => REPEAT_WINDOWS.includes(w)).map((window) => ({ kind: 'window', window }))
    }
    case 'readings': {
      const arm = armIdOfScope(outer)
      const all = ctx.readings ?? []
      const mine = arm === undefined ? all : all.filter((r) => r.campaignId === arm)
      return mine.slice(0, readingsLimit(repeat)).map((reading) => ({ kind: 'reading', reading }))
    }
    case 'rules':
      // Only inside a campaign: that campaign's newest stored F3 read, rule 1 first.
      return (campaignInstanceOf(outer)?.ads?.f3?.rules ?? []).map((rule) => ({ kind: 'rule', rule }))
    case 'assets': {
      // The enclosing campaign's assets, else the repeat's own pinned campaign; most of the chosen total first (impressions unless sortBy), then the top N.
      const campaignId = campaignInstanceOf(outer)?.campaign.id ?? repeat.campaignId
      const all = (campaignId ? ctx.ads?.[campaignId]?.assets : undefined) ?? []
      const picked = repeat.ids?.length ? all.filter((a) => repeat.ids!.includes(a.id)) : all
      return sortAssets(picked, repeat.sortBy).slice(0, readingsLimit(repeat)).map((asset) => ({ kind: 'asset', asset }))
    }
    case 'tips': {
      // Coach tips (editor-tools T3): one per tip, as a feature (lib/coachTips.ts COACH_TIP_ROWS, the tour total left out).
      const list = repeat.ids?.length ? COACH_TIP_ROWS.filter((f) => repeat.ids!.includes(f.id)) : COACH_TIP_ROWS
      return list.map((feature) => ({ kind: 'feature', feature }))
    }
    case 'features': {
      // Pinned ids may also name the Ask-order groups (lib/askOrder.ts ASK_ORDER_CARD_FEATURES), in
      // config order; unpinned it is Feature health's own FEATURES.
      const list = repeat.ids?.length ? [...FEATURES, ...ASK_ORDER_CARD_FEATURES].filter((f) => repeat.ids!.includes(f.id)) : FEATURES
      return list.map((feature) => ({ kind: 'feature', feature }))
    }
    case 'tags': {
      // Only inside an Ask-order group (a features repeat over ao-<group>): its organic and tagged rows, each as the
      // feature ao-<group>-<tag> (lib/askOrder.ts ASK_ORDER_CARD_FEATURES).
      const group = scopeOfKind(outer, 'feature')?.feature
      if (!group) return []
      const tags = repeat.ids?.length ? ASK_ORDER_TAGS.filter((t) => repeat.ids!.includes(t.id)) : ASK_ORDER_TAGS
      return tags.flatMap((t) => {
        const feature = ASK_ORDER_CARD_FEATURES.find((f) => f.id === `${group.id}-${t.id}`)
        return feature ? [{ kind: 'feature' as const, feature, tag: t.label }] : []
      })
    }
    case 'steps': {
      // Only inside a features repeat: that feature's steps, in config order.
      const feature = scopeOfKind(outer, 'feature')?.feature
      if (!feature) return []
      const steps = repeat.ids?.length ? feature.steps.filter((s) => repeat.ids!.includes(s.id)) : feature.steps
      return steps.map((step) => ({ kind: 'step', step, feature }))
    }
    default:
      return []
  }
}

/** Assets highest total first (impressions unless `by`); ties keep their label order, so the order never flips between loads. */
export function sortAssets(assets: readonly AssetScope[], by: AssetSortField = 'impressions'): AssetScope[] {
  return [...assets].sort((a, b) => b[by] - a[by] || (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Today's ET date, once per render pass, from `Date.now()` — a thin seam so tests can pin
 * `nowMs` instead of reaching for the clock, while still using the same DST-safe projection
 * (popupEvents.ts etDateFromMs) as every other ET-date computation in the codebase. */
export function todayEtFrom(nowMs: number): string {
  return etDateFromMs(nowMs)
}

/** The colour a table cell reading `path` takes from its scope instance, or null for none: the
 * per-cell tone hook (types.ts CellTone). Only a stored reading's Rules and Proposal carry one
 * today; it styles a value that is already shown and exposes nothing of its own. */
export function scopeTone(scope: ScopeInstance, path: ScopePath): CellTone | null {
  // An F3 verdict: PROPOSE PAUSE red, WATCH amber, PASS plain, NOT YET / NO DATA / n/a dim; GO..STOP (rule 9's
  // D+7 verdict) plain. The proposal: PROPOSE PAUSE red.
  if (path === 'rule.verdict') {
    const v = scopeOfKind(scope, 'rule')?.rule.verdict
    return v == null ? null : v === 'PROPOSE PAUSE' ? 'trip' : v === 'WATCH' ? 'watch' : v === 'NOT YET' || v === 'NO DATA' || v === 'n/a' ? 'muted' : 'clear'
  }
  if (path === 'campaign.f3Proposal') return campaignInstanceOf(scope)?.ads?.f3?.proposal === 'PROPOSE PAUSE' ? 'trip' : null
  const tones = scopeOfKind(scope, 'reading')?.reading?.tones
  if (!tones) return null
  if (path === 'reading.rules') return tones.rules ?? null
  if (path === 'reading.proposal') return tones.proposal ?? null
  return null
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
  // The organic arm answers only its id and label; every other campaign field is null for it.
  const organic = !campaign && isOrganicScope(scope)
  switch (path) {
    case 'campaign.id':
      return campaign ? campaign.id : organic ? ORGANIC_ARM_ID : null
    case 'campaign.label':
      return campaign ? campaign.label : organic ? noteRawText('label.arm.organic') : null
    case 'campaign.status':
      return campaign ? campaignStatusOn(campaign, todayEt) : null
    case 'campaign.statusToday':
      if (!campaign) return null
      return flightDayIndex(campaign, todayEt) != null ? 'flighting today' : campaignStatusOn(campaign, todayEt)
    case 'campaign.flight':
      // The dateRange renderer wants both bounds; encode as "start|end" and let it split, so
      // this function's signature stays a single ScopePath -> string | null.
      if (!campaign || campaign.flightStart == null) return null
      return `${campaign.flightStart}|${campaign.flightEnd}`
    case 'campaign.measurabilityNote':
      return campaign ? (campaign.measurabilityNote ?? null) : null
    case 'campaign.taggedNote':
      return campaign?.tagged?.note ?? null
    case 'campaign.upsellFixAt':
      return campaign ? (campaignSegmentMarker(campaign, [], UPSELL_SIGNEDOUT_FIX_AT)?.boundaryLabel ?? null) : null
    case 'campaign.upsellFixFlightDay': {
      const m = campaign ? campaignSegmentMarker(campaign, [], UPSELL_SIGNEDOUT_FIX_AT) : null
      const d = m && campaign ? flightDayIndex(campaign, m.boundaryDate) : null
      return d == null ? null : String(d)
    }
    case 'campaign.returnTagShared':
      return campaign && sharesReturnTagWith(campaign) ? noteRawText('return-shared-tag') : null
    case 'campaign.freshness': {
      const ads = campaignInstanceOf(scope)?.ads
      if (!ads || !ads.storeBound) return null
      return `${freshnessLine(ads, ads.loadedAtMs)}${ads.stale ? ` · ${STALE_NOTE}` : ''}`
    }
    case 'campaign.thresholds': {
      const fired = campaignInstanceOf(scope)?.ads?.thresholdsFired
      return fired?.length ? fired.map((t) => `$${t.threshold} · ${etDateTimeText(t.firedAt)}`).join('; ') : null
    }
    case 'campaign.f3Read': {
      const f3 = campaignInstanceOf(scope)?.ads?.f3
      return f3 ? `${etDayText(f3.etDate)} · flight day ${f3.flightDay}` : null
    }
    case 'campaign.f3Proposal': {
      const f3 = campaignInstanceOf(scope)?.ads?.f3
      if (!f3) return null
      return f3.proposal ?? noteRawText('f3-proposal-not-serving')
    }
    case 'rule.name': {
      const r = scopeOfKind(scope, 'rule')?.rule
      return r ? `${r.n} · ${r.name}` : null
    }
    case 'rule.number':
      return scopeOfKind(scope, 'rule')?.rule.number ?? null
    case 'rule.threshold':
      return scopeOfKind(scope, 'rule')?.rule.threshold ?? null
    case 'rule.verdict':
      return scopeOfKind(scope, 'rule')?.rule.verdict ?? null
    case 'asset.label':
      return scopeOfKind(scope, 'asset')?.asset.label ?? null
    case 'feature.id':
      return scopeOfKind(scope, 'feature')?.feature.id ?? null
    case 'feature.label':
      return scopeOfKind(scope, 'feature')?.feature.label ?? null
    case 'feature.tag':
      return scopeOfKind(scope, 'feature')?.tag ?? null
    case 'feature.caption':
      return scopeOfKind(scope, 'feature')?.feature.caption ?? null
    case 'step.label':
      return scopeOfKind(scope, 'step')?.step.label ?? null
    case 'step.ratioLabel': {
      const s = scopeOfKind(scope, 'step')
      return s ? stepRatioLabel(s.feature, s.step) : null
    }
    case 'popup.id':
      return popup ? popup.id : null
    case 'popup.label':
      return popup ? popup.label : null
    case 'window.label':
      return window ? WINDOW_LABELS[window] : null
    case 'window.dated': {
      if (!window) return null
      const back = window === 'latestDay' ? -1 : window === 'previousDay' ? -2 : 0
      if (!back) return WINDOW_LABELS[window]
      const day = new Date(`${addDays(todayEt, back)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
      return `${WINDOW_LABELS[window]} (${day})`
    }
    case 'country.label':
      return country ? COUNTRY_LABELS[country] : null
    case 'release.label': {
      const r = releaseSubjectOn(todayEt)
      const waiting = releaseAwaitingFullDay(todayEt)
      if (!r) return waiting ? `${waiting.version} needs a full day` : null
      return waiting ? `${r.version} (${r.dateEt}); ${waiting.version} needs a full day` : `${r.version} (${r.dateEt})`
    }
    case 'reading.readAt':
      return reading ? reading.readAt : null
    case 'reading.kind':
      return reading ? reading.kind : null
    case 'reading.spend':
      return reading && reading.spend != null ? String(reading.spend) : null
    case 'reading.rules':
      return reading ? (reading.rules ?? null) : null
    case 'reading.proposal':
      return reading ? (reading.proposal ?? null) : null
    // The five whitelisted counts (types.ts READING_COUNT_FIELDS): the key is read off the path
    // through the allow-list, never off user text, so no other count of a record is reachable.
    case 'reading.count.arrivals':
    case 'reading.count.asks':
    case 'reading.count.accepts':
    case 'reading.count.auth':
    case 'reading.count.signUpsAtMost': {
      const n = reading?.counts?.[READING_COUNT_FIELDS[path]]
      return n == null ? null : String(n)
    }
    case 'reading.count.signUps':
      return reading ? signUpsText(reading.counts?.signUpsAtMost, !!reading.signUpsExact) : null
    default:
      return null
  }
}

/** The nearest campaign instance in a scope's chain (not the organic arm, as campaignOfScope). */
function campaignInstanceOf(scope: ScopeInstance | undefined): ScopeOf<'campaign'> | undefined {
  for (let s = scope; s; s = s.parent) {
    if (s.kind === 'campaign') return s
    if (s.kind === 'organic') return undefined
  }
  return undefined
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
      status: campaignStatusOn(campaign, todayEt),
      statusToday: scopeField(scope, 'campaign.statusToday', todayEt) ?? campaignStatusOn(campaign, todayEt),
    }
  } else if (isOrganicScope(scope)) {
    vars.campaign = { id: ORGANIC_ARM_ID, label: noteRawText('label.arm.organic') }
  }
  const popup = scopeOfKind(scope, 'popup')?.popup
  if (popup) vars.popup = { id: popup.id, label: popup.label }
  const window = scopeOfKind(scope, 'window')?.window
  if (window) vars.window = { label: WINDOW_LABELS[window] }
  const country = scopeOfKind(scope, 'country')?.country
  if (country) vars.country = { label: COUNTRY_LABELS[country] }
  const asset = scopeOfKind(scope, 'asset')?.asset
  if (asset) vars.asset = { label: asset.label }
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
  params: { campaignId?: string; popup?: string; country?: string; assetId?: string; feature?: string; step?: string }
  window?: string
  fieldValue?: string | null
}

/** Params + default window for a metric/ratio DataBinding against a scope — shared by
 * useMetrics request-building and by validateCard-style checks. Returns `null` for an
 * unknown metric/ratio id (the caller treats that as `status: 'error'`, matching the
 * server's `unknown-id`). */
export function resolveBinding(binding: DataBinding, scope: ScopeInstance, todayEt?: string): ResolvedBinding | null {
  // `todayEt` only matters to a date-dependent field (campaign.statusToday); absent, scopeField uses the real clock.
  if ('field' in binding) return { kind: 'field', params: {}, fieldValue: scopeField(scope, binding.field, todayEt) }
  const isMetric = 'metric' in binding
  const id = isMetric ? binding.metric : binding.ratio
  const def: MetricDef | RatioDef | undefined = isMetric ? METRICS.get(id) : RATIOS.get(id)
  if (!def) return null
  const allowedParams: MetricParam[] = isMetric ? (def as MetricDef).params : ratioParamsOf(def as RatioDef)
  const params: { campaignId?: string; popup?: string; country?: string; assetId?: string; feature?: string; step?: string } = {}
  for (const p of allowedParams) {
    const scopeVal = p === 'campaignId' ? armIdOfScope(scope) : p === 'popup' ? scopeOfKind(scope, 'popup')?.popup.id : p === 'assetId' ? scopeOfKind(scope, 'asset')?.asset.id : p === 'feature' ? scopeOfKind(scope, 'feature')?.feature.id : p === 'step' ? scopeOfKind(scope, 'step')?.step.id : scopeOfKind(scope, 'country')?.country
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
  /** Which of the section repeat's instances the item belongs to (0 without a section repeat): a panels section draws one panel each. */
  instance?: number
}

export function flattenSectionItems(section: Section, outerScope: ScopeInstance, ctx: RepeatContext): FlatItem[] {
  const sectionScopes = section.repeat ? resolveRepeat(section.repeat, ctx, outerScope).map((s) => nestScope(s, outerScope)) : [outerScope]
  if (section.repeat && !sectionScopes.length) {
    return section.repeat.empty ? [{ item: emptyPlaceholderItem(section.items[0]?.id ?? 'empty'), scope: outerScope, emptyOf: section.repeat.empty }] : []
  }
  const out: FlatItem[] = []
  for (const [instance, sScope] of sectionScopes.entries()) {
    for (const item of section.items) {
      if (!item.repeat) {
        out.push({ item, scope: sScope, instance })
        continue
      }
      const allScopes = resolveRepeat(item.repeat, ctx, sScope).map((s) => nestScope(s, sScope))
      // Instances the campaign's own config rules out (a spend-only campaign) are dropped here, so
      // a repeat left with only those shows its empty placeholder — saying why — instead of
      // silently losing the tile.
      const itemScopes = allScopes.filter((s) => !unmeasuredByConfig(item.data, s, item.gating, ctx.todayEt))
      if (!itemScopes.length) {
        if (item.repeat.empty) {
          // Only campaign instances say "a campaign is flighting"; the organic baseline never does.
          const untracked = allScopes.some((s) => s.kind === 'campaign') && item.repeat.over === 'campaigns' && !!item.repeat.flightingToday
          out.push({ item, scope: sScope, instance, emptyOf: untracked ? { label: item.repeat.empty.label, text: { note: 'no-tracked-campaign-flighting' } } : item.repeat.empty })
        }
        continue
      }
      for (const iScope of itemScopes) out.push({ item, scope: iScope, instance })
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
    const cols = columnTableColumns(section, outerScope, ctx).columns
    return section.items.flatMap((item) => cols.map((scope) => ({ item, scope })))
  }
  return tableRows(section, outerScope, ctx).flatMap((row) => section.items.flatMap((item) => (item.perGroup && !row.first ? [] : windowParts(item).map((part) => ({ item: part, scope: row.scope })))))
}

/** One row of a row table: its scope and, with `rowGroups`, where it sits in its group. A table
 * without groups is one row per repeat instance, each its own group of one. */
export interface TableRow {
  scope: ScopeInstance
  /** The group's first row: its `perGroup` cells are drawn here, spanning `span` rows. */
  first: boolean
  /** The group's last row: the rule between groups is drawn under it. */
  last: boolean
  span: number
}
export function tableRows(section: Section, outerScope: ScopeInstance, ctx: RepeatContext): TableRow[] {
  const groups = resolveRepeat(section.repeat, ctx, outerScope).map((g) => nestScope(g, outerScope))
  if (!section.rowGroups) return groups.map((scope) => ({ scope, first: true, last: true, span: 1 }))
  const inner = section.rowGroups
  return groups.flatMap((g) => {
    const rows = resolveRepeat(inner, ctx, g).map((r) => nestScope(r, g))
    return rows.map((scope, i) => ({ scope, first: i === 0, last: i === rows.length - 1, span: rows.length }))
  })
}

/** The items a table cell shows: with `windows`, one per window (the binding's window replaced,
 * in order, for the cell to join); otherwise the item itself. A field binding has no window. */
export function windowParts(item: MetricItem): MetricItem[] {
  if (!item.windows?.length || 'field' in item.data) return [item]
  const rest: MetricItem = { ...item }
  delete rest.windows
  delete rest.after
  return item.windows.map((window) => ({ ...rest, id: `${item.id}@${window}`, data: { ...item.data, window } as DataBinding }))
}

/** The item's `gating.onlyWith` field is empty in this scope: the cell is blank, never requested. */
export function lacksRequiredField(item: MetricItem, scope: ScopeInstance, todayEt?: string): boolean {
  const path = item.gating?.onlyWith
  return !!path && !scopeField(scope, path, todayEt)
}

/** A column table's columns, left to right, and its column groups (Section.columnGroups), one heading row per
 * level, outermost first, each group with the number of columns under it; without groups, `groups` is empty. Each
 * column's scope is the column inside its groups inside the outer instance; a group with no columns is left out. */
export function columnTableColumns(section: Pick<Section, 'columns' | 'columnGroups'>, outerScope: ScopeInstance, ctx: RepeatContext): { columns: ScopeInstance[]; groups: { scope: ScopeInstance; span: number }[][] } {
  if (!section.columns) return { columns: [], groups: [] }
  const levels = section.columnGroups ?? []
  const groups: { scope: ScopeInstance; span: number }[][] = levels.map(() => [])
  const walk = (level: number, scope: ScopeInstance): ScopeInstance[] => {
    if (level === levels.length) return resolveRepeat(section.columns, ctx, scope).map((c) => nestScope(c, scope))
    const out: ScopeInstance[] = []
    for (const g of resolveRepeat(levels[level], ctx, scope)) {
      const gScope = nestScope(g, scope)
      const at = groups[level].length
      groups[level].push({ scope: gScope, span: 0 })
      const cols = walk(level + 1, gScope)
      if (!cols.length) {
        groups[level].splice(at, 1)
        continue
      }
      groups[level][at].span = cols.length
      out.push(...cols)
    }
    return out
  }
  return { columns: walk(0, outerScope), groups }
}

/** The default heading of a column group: as a column's, but a single-day window carries its date ("Latest day (Oct 28)"). */
export function columnGroupDefaultLabel(scope: ScopeInstance): Label {
  return scope.kind === 'window' ? { bind: 'window.dated' } : columnDefaultLabel(scope)
}

/** The default heading of a table column: the column instance's own name. */
export function columnDefaultLabel(scope: ScopeInstance): Label {
  switch (scope.kind) {
    case 'campaign':
    case 'organic':
      return { bind: 'campaign.label' }
    case 'popup':
      return { bind: 'popup.label' }
    case 'window':
      return { bind: 'window.label' }
    case 'country':
      return { bind: 'country.label' }
    case 'reading':
      return { bind: 'reading.readAt' }
    case 'rule':
      return { bind: 'rule.name' }
    case 'asset':
      return { bind: 'asset.label' }
    case 'feature':
      return scope.tag !== undefined ? { bind: 'feature.tag' } : { bind: 'feature.label' }
    case 'step':
      return { bind: 'step.label' }
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
  params?: { campaignId?: string; popup?: string; country?: string; assetId?: string; feature?: string; step?: string }
  window?: string
  deltas?: DeltaName[]
  /** 'daily': also return the metric's per-ET-day series (a sparkline display). */
  series?: 'daily'
  minCohort?: number
}

/** True when the campaign's own config already rules the binding out — the same two checks
 * the server makes before any query (lib/metrics/engine.ts sideStatic): a campaign whose
 * flight has no start date yet reads nothing but spend, and a spend-only campaign
 * (`measurement: 'spend-only'`) never has beacon data. Such an item is omitted whatever the
 * campaign's status, and never requested, so a card shows no "…" for it and never labels it
 * "not yet tracking" (it never will be tracked). */
export function unmeasuredByConfig(binding: DataBinding, scope: ScopeInstance, gating?: Gating, todayEt?: string): boolean {
  const ruling = configRuling(binding, scope, todayEt)
  if (gating?.needsInstallAction && !campaignOfScope(scope)?.installActionId) return true
  if (gating?.forSpendOnly && campaignOfScope(scope)?.measurement !== 'spend-only') return true
  if (gating?.notForInstallAction && campaignOfScope(scope)?.installActionId) return true
  // A flight with no start date keeps an item whose gating says how to show "not started".
  return ruling === 'spend-only' || ruling === 'organic-unsupported' || ruling === 'no-install-action' || (ruling === 'flight-pending' && !gating?.whenNotStarted)
}
/** Why the campaign's own config rules a binding out, or null: 'flight-pending' (no start date
 * yet: nothing but spend can be read), 'spend-only' (never any beacon data), or
 * 'no-install-action' (Google-reported installs asked of a campaign with no installActionId), or
 * 'organic-unsupported' (the organic arm asked of a binding that doesn't serve it: only the
 * return metrics, and ratios whose both sides are return metrics, do — the server refuses the
 * rest). Such a binding is never requested (buildRequestSpec); unmeasuredByConfig says whether
 * its item is omitted. A `field` binding never gets a ruling, so a date-dependent field (the
 * release-awaiting `release.label`) always renders from `todayEt`, organic scope or not. */
export function configRuling(binding: DataBinding, scope: ScopeInstance, todayEt?: string): 'flight-pending' | 'spend-only' | 'organic-unsupported' | 'no-install-action' | null {
  if ('field' in binding) return null
  if (isOrganicScope(scope)) {
    const resolved = resolveBinding(binding, scope, todayEt)
    if (!resolved || resolved.kind === 'field' || resolved.params.campaignId !== ORGANIC_ARM_ID) return null
    const ok = resolved.kind === 'metric' ? !!(resolved.def as MetricDef).organic : ratioSupportsOrganic(resolved.def as RatioDef)
    return ok ? null : 'organic-unsupported'
  }
  const campaign = campaignOfScope(scope)
  if (!campaign) return null
  const resolved = resolveBinding(binding, scope, todayEt)
  if (!resolved || resolved.kind === 'field' || !resolved.window) return null
  const window = resolved.window as keyof MetricDef['windows']
  const sides = resolved.kind === 'metric' ? [resolved.def as MetricDef] : [METRICS.get((resolved.def as RatioDef).num), METRICS.get((resolved.def as RatioDef).den)]
  for (const def of sides) {
    if (!def || !def.params.includes('campaignId') || resolved.params.campaignId !== campaign.id) continue
    // Google-reported installs exist only for a campaign that names an install action: no action, nothing to ask.
    if (def.id === 'campaign.adsInstalls' && !campaign.installActionId) return 'no-install-action'
    const fact = def.windows[window]
    const rules = rulesOf(def, { params: resolved.params, campaign, window: window as never })
    if (!hasBeaconRows(campaign) && rules.some((r) => r.kind === 'beaconMeasurable')) return 'spend-only'
    // The ads store's reads (spend and its freshness) need no flight date, only a campaign.
    if (campaign.flightStart === null && fact !== 'adsSpend' && fact !== 'adsCoverage' && fact !== 'adsLastSync' && fact !== 'adsInstallsDaily' && fact !== 'adsAssetDaily') return 'flight-pending'
  }
  return null
}

/** The request a MetricItem's data binding resolves to against a scope, or `null` for a
 * `field` binding (no network round trip) or an unknown metric/ratio id (the caller treats
 * that the same as the server's `unknown-id`, i.e. an `error` status). */
export function buildRequestSpec(item: MetricItem, scope: ScopeInstance, todayEt?: string): MetricRequestSpec | null {
  const resolved = resolveBinding(item.data, scope, todayEt)
  if (!resolved || resolved.kind === 'field') return null
  if (configRuling(item.data, scope, todayEt)) return null // never asked: the answer is known
  if (lacksRequiredField(item, scope, todayEt)) return null // a blank cell asks nothing
  if (item.gating?.needsInstallAction && !campaignOfScope(scope)?.installActionId) return null // an Ads-only row of a campaign with no Ads link
  if (item.gating?.forSpendOnly && campaignOfScope(scope)?.measurement !== 'spend-only') return null // an Ads-only row of a campaign that has site numbers
  if (item.gating?.notForInstallAction && campaignOfScope(scope)?.installActionId) return null // a site row beside Google's own install count
  const spec: MetricRequestSpec = {}
  if (resolved.kind === 'metric') spec.metric = (item.data as { metric: string }).metric
  else spec.ratio = (item.data as { ratio: string }).ratio
  if (Object.keys(resolved.params).length) spec.params = resolved.params
  if (resolved.window) spec.window = resolved.window
  if (item.display.as === 'number' && item.display.deltas?.length) spec.deltas = item.display.deltas
  if (item.display.as === 'sparkline') spec.series = 'daily'
  if (item.gating?.minCohort != null) spec.minCohort = item.gating.minCohort
  return spec
}
