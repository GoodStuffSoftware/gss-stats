// Registered ratios, and the rule that decides which ones may exist (ADR 0003, "the rule this
// ADR encodes"): a PERCENTAGE is allowed only when the numerator and denominator share a unit
// AND the numerator is a declared subset of the denominator; a COST is money over a count and
// never shows as a percent; any other pairing is a PAIR — counts only.
//
// The check runs when this module loads (defineRatios): an invalid registration throws at
// import, so a bad ratio cannot ship. Clients can only name a registered ratio; there is no
// ad-hoc numerator/denominator request. This absorbs lib/campaigns.ts VALID_FUNNEL_RATE_STEPS
// (accept/ask and install/post-fix prompt are the only funnel proportions that pass).

import { METRICS, metricWindows, type MetricDef, type MetricParam } from './metrics'
import type { WindowName } from './types'

export type RatioKind = 'proportion' | 'cost' | 'pair'

export interface RatioDef {
  id: string
  /** Notes-registry label id (always `label.<id>`). */
  label: string
  kind: RatioKind
  num: string
  den: string
  /** proportion only: count the denominator only where the numerator is measured (the install
   * fix: prompts shown before it could never record an "installed" outcome). */
  alignDenominator?: boolean
}

export interface RatioVerdict {
  ok: boolean
  reason: string
}

const NOT_COUNTS: ReadonlySet<string> = new Set(['instant', 'code'])

/** The validity rule (the prototype's), plus: a time or a category is never a side. */
export function ratioVerdict(r: Pick<RatioDef, 'kind' | 'num' | 'den'>, metrics: ReadonlyMap<string, MetricDef> = METRICS): RatioVerdict {
  const n = metrics.get(r.num)
  const d = metrics.get(r.den)
  if (!n || !d) return { ok: false, reason: 'unknown metric' }
  // A time or a category is not a count: no ratio of any kind can use one.
  if (NOT_COUNTS.has(n.unit) || NOT_COUNTS.has(d.unit)) return { ok: false, reason: `unit ${NOT_COUNTS.has(n.unit) ? n.unit : d.unit} is not a count` }
  if (r.kind === 'pair') return { ok: true, reason: 'counts only' }
  if (r.kind === 'cost') return n.unit === 'usd' && d.unit !== 'usd' ? { ok: true, reason: 'money per ' + d.unit } : { ok: false, reason: 'cost needs usd over a count' }
  if (r.kind !== 'proportion') return { ok: false, reason: `unknown kind ${String(r.kind)}` } // a registration from untyped data
  if (n.unit !== d.unit) return { ok: false, reason: `unit ${n.unit} over ${d.unit}` }
  const visited = new Set<string>()
  for (let cur: MetricDef | undefined = n; cur && !visited.has(cur.id); cur = cur.subsetOf ? metrics.get(cur.subsetOf) : undefined) {
    visited.add(cur.id)
    if (cur.subsetOf === d.id) return { ok: true, reason: `${n.unit} subset` }
  }
  return { ok: false, reason: 'same unit but no declared subset' }
}

/** Validates every definition (the rule above, plus: shared windows, `label.<id>` labels,
 * alignDenominator only on a proportion) and returns the registry. Throws on the first
 * invalid one — this runs at module load. */
export function defineRatios(defs: readonly RatioDef[], metrics: ReadonlyMap<string, MetricDef> = METRICS): ReadonlyMap<string, RatioDef> {
  const out = new Map<string, RatioDef>()
  for (const r of defs) {
    if (out.has(r.id) || metrics.has(r.id)) throw new Error(`ratio ${r.id}: duplicate id`)
    if (r.label !== `label.${r.id}`) throw new Error(`ratio ${r.id}: label must be label.${r.id}`)
    const v = ratioVerdict(r, metrics)
    if (!v.ok) throw new Error(`ratio ${r.id} (${r.kind} ${r.num} / ${r.den}) is invalid: ${v.reason}`)
    if (r.alignDenominator && r.kind !== 'proportion') throw new Error(`ratio ${r.id}: alignDenominator is for proportions only`)
    if (!ratioWindowsOf(r, metrics).length) throw new Error(`ratio ${r.id}: numerator and denominator share no window`)
    out.set(r.id, r)
  }
  return out
}

/** The windows both sides accept, in the numerator's order (the first is the default). */
export function ratioWindowsOf(r: Pick<RatioDef, 'num' | 'den'>, metrics: ReadonlyMap<string, MetricDef> = METRICS): WindowName[] {
  return sidesMemo(r, metrics).windows
}
/** The params a ratio accepts: the union of both sides'. */
export function ratioParamsOf(r: Pick<RatioDef, 'num' | 'den'>, metrics: ReadonlyMap<string, MetricDef> = METRICS): MetricParam[] {
  return sidesMemo(r, metrics).params
}
/** Whether a ratio serves the organic baseline arm: only when BOTH sides do, so an organic
 * ratio never divides an organic count by a campaign one (or the reverse). */
export function ratioSupportsOrganic(r: Pick<RatioDef, 'num' | 'den'>, metrics: ReadonlyMap<string, MetricDef> = METRICS): boolean {
  return !!metrics.get(r.num)?.organic && !!metrics.get(r.den)?.organic
}
// Both are read for every request that names a ratio, so they are computed once per pair.
const pairMemo = new WeakMap<ReadonlyMap<string, MetricDef>, Map<string, { windows: WindowName[]; params: MetricParam[] }>>()
function sidesMemo(r: Pick<RatioDef, 'num' | 'den'>, metrics: ReadonlyMap<string, MetricDef>): { windows: WindowName[]; params: MetricParam[] } {
  let byPair = pairMemo.get(metrics)
  if (!byPair) pairMemo.set(metrics, (byPair = new Map()))
  const key = `${r.num}\u0000${r.den}`
  let v = byPair.get(key)
  if (!v) {
    const n = metrics.get(r.num)
    const d = metrics.get(r.den)
    const dw = d ? new Set(metricWindows(d)) : new Set<WindowName>()
    v = {
      windows: n && d ? metricWindows(n).filter((w) => dw.has(w)) : [],
      params: [...new Set([...(n?.params ?? []), ...(d?.params ?? [])])],
    }
    byPair.set(key, v)
  }
  return v
}

const ratio = (id: string, kind: RatioKind, num: string, den: string, extra: Partial<RatioDef> = {}): RatioDef => ({ id, label: `label.${id}`, kind, num, den, ...extra })

export const RATIO_DEFS: RatioDef[] = [
  // Campaign proportions: the three the rate audit found valid, plus the return buckets.
  ratio('campaign.acceptPerAsk', 'proportion', 'campaign.accepts', 'campaign.asks'),
  ratio('campaign.signedInPerAsk', 'proportion', 'campaign.signedInAfterAsk', 'campaign.asks'),
  ratio('campaign.installPerPrompt', 'proportion', 'campaign.installs', 'campaign.installPrompts', { alignDenominator: true }),
  ratio('campaign.returnD1PerD0', 'proportion', 'campaign.returnD1', 'campaign.returnD0'),
  ratio('campaign.returnD2to7PerD0', 'proportion', 'campaign.returnD2to7', 'campaign.returnD0'),
  ratio('campaign.returnD8to14PerD0', 'proportion', 'campaign.returnD8to14', 'campaign.returnD0'),
  ratio('campaign.returnD15to30PerD0', 'proportion', 'campaign.returnD15to30', 'campaign.returnD0'),
  ratio('campaign.returnD31to60PerD0', 'proportion', 'campaign.returnD31to60', 'campaign.returnD0'),
  // Costs: money over a count. Arrivals are a floor (ARRIVALS_CAVEAT), so cost per arrival is a ceiling.
  ratio('campaign.costPerArrival', 'cost', 'campaign.spend', 'campaign.taggedArrivals'),
  ratio('campaign.costPerSignin', 'cost', 'campaign.spend', 'campaign.authSuccess'),
  // Pairs: counts only — "1,111 game-screen views · 353 arrivals", never 314.7%.
  ratio('campaign.gameViewsVsArrivals', 'pair', 'campaign.gameViews', 'campaign.taggedArrivals'),
  ratio('campaign.taggedHitsVsArrivals', 'pair', 'campaign.taggedHits', 'campaign.taggedArrivals'),
  // Site-wide and pop-up proportions.
  ratio('bsk.popupTapRate', 'proportion', 'bsk.popupAccepts', 'bsk.popupShown'),
  ratio('popup.tapRate', 'proportion', 'popup.accepts', 'popup.shown'),
  ratio('popup.signedInRate', 'proportion', 'popup.outcomeSignedIn', 'popup.shown'),
  ratio('popup.installedRate', 'proportion', 'popup.outcomeInstalled', 'popup.shown', { alignDenominator: true }),
  ratio('popup.returnedRate', 'proportion', 'popup.outcomeReturned', 'popup.shown'),
  ratio('popup.stillPlayingRate', 'proportion', 'popup.outcomeStillPlaying', 'popup.shown'),
  ratio('popup.eligibility', 'proportion', 'popup.eligibleEarned', 'popup.eligibleFinishes'),
]

export const RATIOS: ReadonlyMap<string, RatioDef> = defineRatios(RATIO_DEFS)
