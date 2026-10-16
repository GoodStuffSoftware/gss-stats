// Flight 3 Search, Ads side: what Google says about the Search campaign, with nothing from the beacon.
// Per ET day and cumulative: impressions, clicks, average CPC and the three impression-share
// metrics (search impression share, lost to rank, lost to budget); per keyword the same minus
// lost-to-budget (Google refuses that metric on keyword_view, verified against the live API
// 2026-10-16). Then the day-3 readout line (bid-limited / budget-limited / fine) and a raise-or-hold
// proposal for Mike. PROPOSE ONLY: nothing here changes a Google Ads setting.
//
// Impression-share honesty: Google returns the shares as fractions, reports anything under 10% as
// 0.0999 (search impression share) or anything over 90% as 0.9001 (lost shares), and leaves the
// field out (or sends "--") when it has no figure. Those print as "<10%", ">90%" and "n/a"; a
// missing figure is never printed as 0%.
//
// Pure functions of figures: no I/O, no Intl (this sits beside adsRules.ts, which is in the Worker bundle).
import { flightDayOf } from './flight3Rules'

/** Every cut-off of the Search readout, in one place. */
export const SEARCH_READOUT = {
  /** First flight day whose read prints the readout line and the proposal line. */
  fromDay: 3,
  /** Lost to rank at or above this share: the bid is the limit. */
  bidLimitedRankLost: 0.3,
  /** Else lost to budget at or above this share: the daily budget is the limit. */
  budgetLimitedBudgetLost: 0.2,
  /** Proposal: fewer clicks a day than this ... */
  proposeUnderClicksPerDay: 2,
  /** ... AND lost to rank at or above this share ... */
  proposeRankLost: 0.5,
  /** ... proposes raising the 'app' keywords only to this max CPC (dollars) ... */
  proposeRaiseTo: 1.25,
  /** ... otherwise the Search max CPC holds at this (dollars). */
  holdAt: 0.99,
} as const

/** Google's floor and ceiling for the impression-share fields (see the header). */
const IS_FLOOR = 0.1
const LOST_CEILING = 0.9
/** The value a "more than 90%" lost share stands for in a comparison (Google reports 0.9001). */
const ABOVE_90 = 0.9001

/** A share as the API sent it: a fraction, the string "--", or nothing. */
export type RawShare = number | string | null | undefined

export interface SearchMetricsRaw {
  impressions: number
  clicks: number
  costMicros: number
  /** Google's own average CPC in micros; null when it sent none (no clicks). */
  avgCpcMicros: number | null
  impressionShare: RawShare
  rankLost: RawShare
  budgetLost: RawShare
}
export interface SearchDayRaw extends SearchMetricsRaw {
  /** ET date, YYYY-MM-DD. */
  date: string
}
export interface KeywordRaw {
  text: string
  matchType: string
  impressions: number
  clicks: number
  avgCpcMicros: number | null
  impressionShare: RawShare
  rankLost: RawShare
}
/** What the three Search queries returned (src/lib/adsApi.ts fetchSearchDaily, fetchSearchRange, fetchSearchKeywords). */
export interface SearchSideRaw {
  daily: SearchDayRaw[]
  /** Google's own aggregate over the whole range (one row without a date segment); null = no row. */
  cumulative: SearchMetricsRaw | null
  /** null = not read, see keywordsError. */
  keywords: KeywordRaw[] | null
  keywordsError: string | null
}

export type Share = { kind: 'na' } | { kind: 'below10' } | { kind: 'above90' } | { kind: 'value'; v: number }

/** One raw share to an honest Share. `metric` says which sentinel applies: impression share floors
 * at 10%, lost shares cap at 90%. null, undefined, "--", other text and out-of-range numbers are n/a. */
export function parseShare(raw: RawShare, metric: 'impressionShare' | 'lost'): Share {
  let v: number
  if (raw == null) return { kind: 'na' }
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (t === '' || t === '--') return { kind: 'na' }
    v = Number(t)
  } else v = raw
  if (!Number.isFinite(v) || v < 0 || v > 1) return { kind: 'na' }
  if (metric === 'impressionShare' && v < IS_FLOOR) return { kind: 'below10' }
  if (metric === 'lost' && v > LOST_CEILING) return { kind: 'above90' }
  return { kind: 'value', v }
}
/** "<10%", ">90%", "n/a" or a whole percent. */
export function shareText(s: Share): string {
  switch (s.kind) {
    case 'na':
      return 'n/a'
    case 'below10':
      return '<10%'
    case 'above90':
      return '>90%'
    default:
      return `${Math.round(s.v * 100)}%`
  }
}
/** The figure a rule compares: null for n/a (never 0) and for "<10%" (not a lost share). */
export function shareNumber(s: Share): number | null {
  return s.kind === 'value' ? s.v : s.kind === 'above90' ? ABOVE_90 : null
}

export interface SearchMetricsView {
  impressions: number
  clicks: number
  costMicros: number
  /** Dollars; null under 1 click. */
  avgCpc: number | null
  impressionShare: Share
  rankLost: Share
  budgetLost: Share
}
export function viewMetrics(m: SearchMetricsRaw): SearchMetricsView {
  return {
    impressions: m.impressions,
    clicks: m.clicks,
    costMicros: m.costMicros,
    avgCpc: m.clicks > 0 ? m.costMicros / m.clicks / 1e6 : null,
    impressionShare: parseShare(m.impressionShare, 'impressionShare'),
    rankLost: parseShare(m.rankLost, 'lost'),
    budgetLost: parseShare(m.budgetLost, 'lost'),
  }
}
const ZERO: SearchMetricsRaw = { impressions: 0, clicks: 0, costMicros: 0, avgCpcMicros: null, impressionShare: null, rankLost: null, budgetLost: null }

export type SearchLabel = 'bid-limited' | 'budget-limited' | 'fine' | 'n/a'
/** bid-limited when lost to rank is at the cut-off or over; else budget-limited when lost to budget
 * is; else fine. A figure the answer needs and Google did not send gives n/a, never a guess. */
export function searchLabel(rankLost: Share, budgetLost: Share): SearchLabel {
  const r = shareNumber(rankLost)
  const b = shareNumber(budgetLost)
  if (r != null && r >= SEARCH_READOUT.bidLimitedRankLost) return 'bid-limited'
  if (r == null || b == null) return 'n/a'
  return b >= SEARCH_READOUT.budgetLimitedBudgetLost ? 'budget-limited' : 'fine'
}

export type SearchProposal = 'PROPOSE' | 'HOLD' | 'HOLD (rank-lost n/a)'
/** PROPOSE when Search averages under 2 clicks a day AND lost to rank is 50% or more; HOLD otherwise
 * (and HOLD with a note when lost to rank is n/a, since the second test cannot be made). */
export function searchProposal(clicksPerDay: number, rankLost: Share): SearchProposal {
  const r = shareNumber(rankLost)
  if (r == null) return 'HOLD (rank-lost n/a)'
  return clicksPerDay < SEARCH_READOUT.proposeUnderClicksPerDay && r >= SEARCH_READOUT.proposeRankLost ? 'PROPOSE' : 'HOLD'
}
const usd = (x: number) => `$${x.toFixed(2)}`
export const SEARCH_PROPOSE_LINE = `PROPOSE: raise the 'app' keywords only to ${usd(SEARCH_READOUT.proposeRaiseTo)} max CPC (Mike decides)`
export const SEARCH_HOLD_LINE = `HOLD ${usd(SEARCH_READOUT.holdAt)}`

export interface SearchAdsSideInput {
  /** Day 1 = the arm's flightStart (ET); 0 or less before it. */
  flightDay: number
  flightStartEt: string
  /** Last closed ET day to read, already capped at the flight end; null / before the start = none yet. */
  throughEt: string | null
  raw: SearchSideRaw | null
  /** Why the Ads read failed (raw is then null). */
  error: string | null
}
export interface SearchAdsSideBlock {
  flightDay: number
  flightStartEt: string
  throughEt: string | null
  /** Closed flight days read (zero-click days included). */
  closedDays: number
  state: 'ok' | 'no-closed-day' | 'not-read'
  error: string | null
  days: { date: string; m: SearchMetricsView }[]
  cumulative: SearchMetricsView | null
  keywords: { text: string; matchType: string; impressions: number; clicks: number; avgCpc: number | null; impressionShare: Share; rankLost: Share }[] | null
  keywordsError: string | null
  /** Null before flight day 3 (NOT YET) or when the figures were not read. */
  readout: { clicksPerDay: number; avgCpc: number | null; rankLost: Share; budgetLost: Share; label: SearchLabel; proposal: SearchProposal } | null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const addDays = (d: string, k: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10)

export function buildSearchAdsSide(i: SearchAdsSideInput): SearchAdsSideBlock {
  const base = { flightDay: i.flightDay, flightStartEt: i.flightStartEt, throughEt: i.throughEt }
  const closedDays = i.throughEt && i.throughEt >= i.flightStartEt ? flightDayOf(i.flightStartEt, i.throughEt) : 0
  const empty = { days: [], cumulative: null, keywords: null, keywordsError: null, readout: null }
  if (closedDays === 0) return { ...base, closedDays, state: 'no-closed-day', error: null, ...empty }
  if (!i.raw) return { ...base, closedDays, state: 'not-read', error: i.error ?? 'not read', ...empty }

  const byDate = new Map(i.raw.daily.filter((d) => DATE_RE.test(d.date)).map((d) => [d.date, d]))
  const days: SearchAdsSideBlock['days'] = []
  for (let k = 0; k < closedDays; k++) {
    const date = addDays(i.flightStartEt, k)
    days.push({ date, m: viewMetrics(byDate.get(date) ?? ZERO) })
  }
  const cumulative = viewMetrics(i.raw.cumulative ?? ZERO)
  const keywords = i.raw.keywords
    ? i.raw.keywords
        .map((k) => ({
          text: k.text,
          matchType: k.matchType,
          impressions: k.impressions,
          clicks: k.clicks,
          avgCpc: k.avgCpcMicros != null ? k.avgCpcMicros / 1e6 : null,
          impressionShare: parseShare(k.impressionShare, 'impressionShare'),
          rankLost: parseShare(k.rankLost, 'lost'),
        }))
        .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.text.localeCompare(b.text))
    : null
  let readout: SearchAdsSideBlock['readout'] = null
  if (i.flightDay >= SEARCH_READOUT.fromDay) {
    const clicksPerDay = cumulative.clicks / closedDays
    readout = {
      clicksPerDay,
      avgCpc: cumulative.avgCpc,
      rankLost: cumulative.rankLost,
      budgetLost: cumulative.budgetLost,
      label: searchLabel(cumulative.rankLost, cumulative.budgetLost),
      proposal: searchProposal(clicksPerDay, cumulative.rankLost),
    }
  }
  return { ...base, closedDays, state: 'ok', error: null, days, cumulative, keywords, keywordsError: i.raw.keywordsError, readout }
}

/** Most keyword lines printed; the rest are counted. */
const KEYWORD_LINES = 10
const n = (x: number) => String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const clicksText = (x: number) => `${n(x)} click${x === 1 ? '' : 's'}`
const cpcText = (x: number | null) => (x == null ? 'n/a' : usd(x))

function metricsText(m: SearchMetricsView): string {
  return `${n(m.impressions)} impr, ${clicksText(m.clicks)}, avg CPC ${cpcText(m.avgCpc)}, impression share ${shareText(m.impressionShare)}, lost to rank ${shareText(m.rankLost)}, lost to budget ${shareText(m.budgetLost)}`
}

/** The Search Ads-side block as report lines: the per-day table, the cumulative line, the keyword
 * lines, then the readout and proposal lines (or NOT YET before flight day 3). */
export function searchAdsSideLines(b: SearchAdsSideBlock): string[] {
  const out: string[] = []
  const readoutNotYet = `Search: NOT YET (flight day ${Math.max(b.flightDay, 0)}; the readout starts on flight day ${SEARCH_READOUT.fromDay})`
  if (b.state === 'no-closed-day') {
    out.push(`Search Ads side (Google Ads only): no closed flight day yet (the first, ${b.flightStartEt}, closes at the end of that ET day)`)
    out.push(b.flightDay >= SEARCH_READOUT.fromDay ? 'Search: n/a (no closed flight day read)' : readoutNotYet)
    return out
  }
  if (b.state === 'not-read') {
    out.push(`Search Ads side (Google Ads only): NOT READ (${b.error})`)
    out.push(b.flightDay >= SEARCH_READOUT.fromDay ? 'Search: n/a (the Ads read failed)' : readoutNotYet)
    return out
  }
  out.push(
    `Search Ads side (Google Ads only, nothing from the beacon; closed ET days ${b.flightStartEt}..${b.throughEt}; "n/a" = Google sent no figure, "<10%" = below its 10% floor for impression share, ">90%" = above its 90% cap for a lost share):`,
  )
  for (const d of b.days) out.push(`  ${d.date}: ${metricsText(d.m)}`)
  out.push(`  cumulative (Google's own aggregate for the range): ${metricsText(b.cumulative!)}`)
  if (b.keywords) {
    const live = b.keywords.filter((k) => k.impressions > 0 || k.clicks > 0)
    const idle = b.keywords.length - live.length
    out.push(`  by keyword (keyword_view, cumulative; lost to budget is not available per keyword):`)
    for (const k of live.slice(0, KEYWORD_LINES)) {
      out.push(`    "${k.text}" [${k.matchType}]: ${clicksText(k.clicks)}, ${n(k.impressions)} impr, avg CPC ${cpcText(k.avgCpc)}, impression share ${shareText(k.impressionShare)}, lost to rank ${shareText(k.rankLost)}`)
    }
    const more = live.length - KEYWORD_LINES
    if (more > 0 || idle > 0) out.push(`    (${more > 0 ? `${more} more with impressions` : ''}${more > 0 && idle > 0 ? '; ' : ''}${idle > 0 ? `${idle} with no impressions` : ''} not listed)`)
    if (!b.keywords.length) out.push('    (no keywords returned)')
  } else out.push(`  by keyword: NOT READ (${b.keywordsError ?? 'unknown'})`)
  const r = b.readout
  if (!r) out.push(readoutNotYet)
  else {
    out.push(`Search: ${r.clicksPerDay.toFixed(1)} clicks/day, avg CPC ${cpcText(r.avgCpc)}, lost to rank ${shareText(r.rankLost)} → ${r.label}`)
    out.push(r.proposal === 'PROPOSE' ? SEARCH_PROPOSE_LINE : r.proposal === 'HOLD' ? SEARCH_HOLD_LINE : `${SEARCH_HOLD_LINE} (lost to rank is n/a, so no raise can be proposed)`)
  }
  return out
}
