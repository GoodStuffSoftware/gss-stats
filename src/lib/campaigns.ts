// "Best Sudoku campaigns" — comparing three Google Ads campaigns from the beacon's D1
// (`hits`). Companion to lib/popupEvents.ts: funnel-step classification reuses
// classifyPopupPath (signin-prompt / promo-first50 / install) directly, and the "tracking
// not yet active" concept reuses TRACKING_ACTIVATION_DATE_ET (v1.90.0's release date, which
// is also when the on-device return beacon ships — see RETURN_BUCKETS below).
//
// D1 SCHEMA NOTE: the task brief calls the utm columns "us"/"um"/"uc". The ACTUAL `hits`
// columns (confirmed via `PRAGMA table_info(hits)` against production D1, 2026-09-25) are
// `source`, `medium`, `campaign` — this file uses those real column names throughout.
// "uc"/"a campaign's uc values" in comments still means "the tag(s) in the `campaign`
// column that identify this Google Ads campaign," per the brief's own vocabulary.
//
// ATTRIBUTION (hard rule): a row belongs to a campaign ONLY by its own `campaign` column
// value (plus, for the two flights below that share a tag family, its own `ts` — still a
// single-row field, not a cross-row join). Never by matching location/device/time across
// DIFFERENT rows. See campaignAttributionClause — the ONE function that decides row
// membership — so a different method (e.g. a future owner-approved signature match) is a
// single-function swap, not a rewrite of every query in functions/api/campaigns.ts.
//
// D1 COMPOUND-SELECT NOTE: D1 caps a compound SELECT (a chain of UNION/INTERSECT/EXCEPT
// SELECTs) at 5 terms. Nothing here ever builds one — every query below is a single SELECT
// with an ordinary (arbitrarily long) AND/OR WHERE clause, and functions/api/campaigns.ts
// issues one small query per campaign rather than one UNIONed mega-query across all three.

import { classifyPopupPath, computeRate, TRACKING_ACTIVATION_DATE_ET, etDateFromMs } from './popupEvents'

// ET hour-of-day (0-23) for "Arrivals by ET hour of day" — same DST-safe Intl approach as
// popupEvents.ts's etDateFromMs, just formatting the hour instead of the calendar date.
const ET_HOUR_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' })
export function etHourFromMs(ms: number): number {
  return Number(ET_HOUR_FMT.format(new Date(ms)))
}

// ── Campaign registry ────────────────────────────────────────────────────────────────
export interface CampaignFlight {
  id: string // Google Ads campaign id
  label: string
  /** Every `campaign` column value attributed to this flight (see ATTRIBUTION above). */
  ucValues: string[]
  flightStart: string // ET calendar date (YYYY-MM-DD), inclusive
  flightEnd: string // ET calendar date, inclusive
  status: 'closed' | 'active' | 'upcoming'
  /** [startHourEt, endHourExclusiveEt) — descriptive only; charts DON'T filter to this
   * window (a click outside serving hours is still a real click), the hour-of-day chart
   * just shades it for context. Undefined = served all day. */
  servingHoursEt?: [number, number]
  notes: string
}

// Live `campaign` values seen in production D1 as of 2026-09-25 (read-only query:
// `SELECT campaign, MIN(ts), MAX(ts), COUNT(*) FROM hits WHERE campaign IS NOT NULL AND
// campaign<>'' GROUP BY campaign`):
//   sudoku_tired_of_ads       1194 rows  2026-09-03 .. 2026-09-22
//   beta_v2_tier1en            132 rows  2026-07-30 .. 2026-08-03  (an unrelated earlier
//                                                                    beta — not one of the
//                                                                    3 campaigns; excluded)
//   sudoku_funnel_retest         9 rows  2026-09-23 (a few minutes) — matches campaign 3's
//                                                                     uc; predates its
//                                                                     stated 2026-09-26
//                                                                     start (pre-launch QA)
//   webview_test                 2 rows  2026-09-21               (unrelated; excluded)
//   sudoku_tired_of_ads_test     1 row   2026-09-02               (a QA variant of the
//                                                                    flight-1/2 tag, within
//                                                                    flight 1's ET window)
//
// None of "sudoku_tired_of_ads_play", "tired_of_ads", or "launch_2026" (the brief's
// expected legacy variants) appear anywhere in production D1 — they're kept in ucValues
// below in case they start appearing later (e.g. the Play twin ships), but contribute 0
// rows today.
//
// FLIGHT 1 vs FLIGHT 2 SPLIT: both closed campaigns use the exact same `campaign` value
// (sudoku_tired_of_ads) — they can't be separated by uc, so they're split by date range
// (task brief: "split them by date range and report how"), using daily counts BUCKETED BY
// ET DAY (etDateFromMs — HIGH review finding, 2026-09-25: the first pass used SQLite's
// date(ts/1000,'unixepoch'), which buckets by UTC day; the real first hit is 2026-09-02
// ~22:56 ET, which is already 2026-09-03 UTC, so ~150 tagged hits landed one ET day early
// under UTC bucketing):
//   09-02..09-09 ET: 150,164,165,108,160,151,132,121/day — one clear high-volume week (8d)
//   09-10..09-22 ET: 7,10,4,0,7,1,0,2,2,6,3,0,1/day      — a >10x volume drop, no second burst
// The split is set at that cliff (09-09 / 09-10 ET). INVARIANT (asserted in
// campaigns.test.ts): flight 1's window (1,151 rows) + flight 2's window (43 rows) sums to
// exactly 1,194 — the tag family's full row count — so no tagged row for this family falls
// outside every window. This is still a BEST-EFFORT, low-confidence split: there's no
// visible SECOND burst in the tail that would confirm a genuine second display arm rather
// than late/residual clicks on flight 1's creative — flag this to the owner before
// trusting flight 2's numbers as a distinct campaign.
export const CAMPAIGNS: CampaignFlight[] = [
  {
    id: '24215315197',
    label: 'Display flight 1 — "tired of ads"',
    ucValues: ['sudoku_tired_of_ads', 'sudoku_tired_of_ads_play', 'tired_of_ads', 'launch_2026', 'sudoku_tired_of_ads_test'],
    flightStart: '2026-09-02',
    flightEnd: '2026-09-09',
    status: 'closed',
    notes: 'Shares its `campaign` value with flight 2 below — separated by date range, not by tag. See the module header.',
  },
  {
    id: '24234347705',
    label: 'Display flight 2 — "tired of ads" (second arm)',
    ucValues: ['sudoku_tired_of_ads', 'sudoku_tired_of_ads_play', 'tired_of_ads', 'launch_2026'],
    flightStart: '2026-09-10',
    flightEnd: '2026-09-22', // last observed row as of the 2026-09-25 D1 snapshot
    status: 'closed',
    notes: 'Shares its `campaign` value with flight 1 above — separated by date range, not by tag. Low confidence: see the module header.',
  },
  {
    id: '24279250691',
    label: 'US+CA web retest',
    ucValues: ['sudoku_funnel_retest'],
    flightStart: '2026-09-26',
    flightEnd: '2026-10-02', // 7 serving days
    status: 'upcoming',
    servingHoursEt: [12, 23],
    notes:
      '9 rows already tagged sudoku_funnel_retest on 2026-09-23 (pre-launch QA, 3 days before this window) fall outside flightStart..flightEnd and so are excluded — widen flightStart to include them if that QA traffic should count.',
  },
]

export function campaignById(id: string): CampaignFlight | undefined {
  return CAMPAIGNS.find((c) => c.id === id)
}

/** Week 1 of the retest campaign is directional, per the brief. */
export function isDirectionalDay(campaign: CampaignFlight, etDate: string): boolean {
  if (campaign.id !== '24279250691') return false
  const day = flightDayIndex(campaign, etDate)
  return day != null && day >= 1 && day <= 7
}

/** 1-based flight day (day 1 = flightStart) for aligning multiple flights on one axis
 * ("daily arrivals … aligned by flight day 1..N so the flights overlay"). null if
 * `etDate` falls outside the flight window. */
export function flightDayIndex(campaign: CampaignFlight, etDate: string): number | null {
  if (etDate < campaign.flightStart || etDate > campaign.flightEnd) return null
  const start = Date.parse(campaign.flightStart + 'T00:00:00Z')
  const d = Date.parse(etDate + 'T00:00:00Z')
  return Math.round((d - start) / 86_400_000) + 1
}

// ── ET calendar date <-> UTC ms (inverse of popupEvents.ts etDateFromMs) ────────────────
/** The UTC instant of ET midnight starting the given ET calendar date. DST-safe: tries
 * both possible ET UTC offsets (EST -5h / EDT -4h) and picks whichever one actually lands
 * inside `dateEt` per etDateFromMs, at its very start. */
export function etMidnightUtcMs(dateEt: string): number {
  for (const offsetHours of [5, 4]) {
    const candidate = Date.parse(`${dateEt}T00:00:00Z`) + offsetHours * 3_600_000
    if (etDateFromMs(candidate) === dateEt && etDateFromMs(candidate - 1) !== dateEt) return candidate
  }
  return Date.parse(`${dateEt}T00:00:00Z`) // unreachable for a valid YYYY-MM-DD; safe fallback
}
function nextEtDate(dateEt: string): string {
  const d = new Date(dateEt + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
/** [startMs, endMsExclusive) covering every UTC ms whose ET calendar day falls in
 * [flightStart, flightEnd] inclusive. */
export function etFlightRangeMs(flightStart: string, flightEnd: string): [number, number] {
  return [etMidnightUtcMs(flightStart), etMidnightUtcMs(nextEtDate(flightEnd))]
}

// ── Attribution (the ONE function deciding row membership — see module header) ─────────
export function campaignAttributionClause(campaign: CampaignFlight): { sql: string; binds: unknown[] } {
  const [startMs, endMs] = etFlightRangeMs(campaign.flightStart, campaign.flightEnd)
  const ucPlaceholders = campaign.ucValues.map(() => '?').join(', ')
  return {
    sql: `campaign IN (${ucPlaceholders}) AND ts >= ? AND ts < ?`,
    binds: [...campaign.ucValues, startMs, endMs],
  }
}

// ── Exclusions (row filters — single-row predicates, never a cross-row join) ───────────
export interface ExclusionRule {
  label: string
  clause(w: string[], b: unknown[]): void
}
export const EXCLUSIONS: ExclusionRule[] = [
  {
    label: 'lifecycle email',
    clause(w, b) {
      w.push(`NOT (medium = ? OR campaign LIKE ?)`)
      b.push('lifecycle', 'email_%')
    },
  },
  {
    label: 'deckhand verification traffic',
    clause(w, b) {
      w.push(`NOT (region = ? AND city = ? AND org = ? AND device = ? AND os = ? AND browser = ? AND screenw = ?)`)
      b.push('Virginia', 'Reston', 'Verizon Business', 'desktop', 'Windows', 'Chrome', 1280)
    },
  },
  {
    label: "Mike's household",
    clause(w, b) {
      w.push(`NOT (region = ? AND screenw IN (412, 444, 852))`)
      b.push('North Carolina')
    },
  },
]
export function applyExclusions(w: string[], b: unknown[]): void {
  for (const rule of EXCLUSIONS) rule.clause(w, b)
}

// ── Funnel steps ─────────────────────────────────────────────────────────────────────
export type FunnelStepKey = 'arrivals' | 'played' | 'completed' | 'ask' | 'accept' | 'authSuccess' | 'installPrompt' | 'install'

export const FUNNEL_STEP_ORDER: FunnelStepKey[] = ['arrivals', 'played', 'completed', 'ask', 'accept', 'authSuccess', 'installPrompt', 'install']

export const FUNNEL_STEP_LABELS: Record<FunnelStepKey, string> = {
  arrivals: 'Arrivals',
  played: 'Played a game',
  completed: 'Completed a game',
  ask: 'Sign-in ask',
  accept: 'Accept',
  authSuccess: 'Auth success',
  installPrompt: 'Install prompt',
  install: 'Install',
}

// Steps with NO matching path anywhere in production D1 (confirmed 2026-09-25 by scanning
// every distinct path on site='bestsudoku-web', tagged or not — see task report). Always
// "not instrumented" everywhere, never a real 0 — classifyFunnelPath below can never
// return 'completed' for this reason (nothing to match).
export const FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED = new Set<FunnelStepKey>(['completed'])

/** "played a game" — found live: `/game` is the dominant tagged path (1111/1194 rows for
 * flight 1/2's uc) — the ad appears to land users directly into gameplay rather than a
 * separate marketing page, so "arrival" and "played" are close for this data. */
const PLAYED_PATH = '/game'
/** "auth success" — `/auth/success/<provider>`; NOT part of lib/popupEvents.ts's
 * POPUP_EVENT_PREFIXES (an ordinary page path there), so classified here directly. */
const AUTH_SUCCESS_PREFIX = '/auth/success/'

/** Classifies ONE path into at most one funnel step (mutually exclusive path families,
 * same design as popupEvents.ts's classifyPopupPath — reused here for the shared
 * families). `null` = not part of the funnel — including EVERY row (arrivals is never
 * derived from path; see computeFunnelCounts' `taggedArrivals` parameter). Excludes
 * `/install/platforms/*` automatically — classifyPopupPath gives those kind
 * 'platformList', a bucket this function never maps to a step. */
export function classifyFunnelPath(path: string): FunnelStepKey | null {
  if (path === PLAYED_PATH) return 'played'
  if (path.startsWith(AUTH_SUCCESS_PREFIX)) return 'authSuccess'
  const ev = classifyPopupPath(path)
  if (!ev) return null
  if ((ev.family === 'signin-prompt' || ev.family === 'promo-first50') && ev.kind === 'shown') return 'ask'
  if ((ev.family === 'signin-prompt' || ev.family === 'promo-first50') && ev.kind === 'accept') return 'accept'
  if (ev.family === 'install' && ev.kind === 'shown') return 'installPrompt' // /install/prompt/{android,ios,desktop}
  if (ev.family === 'install' && ev.kind === 'outcome') return 'install' // pwa-installed/standalone-detected/play-detected
  return null
}

export interface FunnelPathCount {
  path: string
  count: number
}

// DEFINITION FIX (2026-09-25, verified against production D1 — `visitor` really does take
// exactly 'new'/'returning'; sudoku_tired_of_ads has 1,194 TAGGED HITS but only 353 TAGGED
// ARRIVALS): a row carrying a campaign tag is a "tagged hit" — the tag rides every beacon
// for its 30-minute TTL, so one ad click produces many tagged rows. A "tagged arrival" is
// specifically the device's first-ever beacon: `visitor = 'new'` AND campaign-attributed.
// Use taggedArrivals for the funnel's `arrivals` step, cost-per-arrival, and the
// hour-of-day/flight-day charts — never the raw tagged-hit count (label THAT separately,
// as "tagged hits", if it's shown at all — see ARRIVALS_CAVEAT below).
export const ARRIVALS_CAVEAT =
  'Floor — devices that used the app before clicking an ad count as returning and are excluded.'

/** `arrivals` = `taggedArrivals` (visitor='new' rows only — see the DEFINITION FIX above),
 * passed in separately since it needs a `visitor` filter, not a path classification.
 * Every OTHER step still sums ALL tagged rows (any visitor) whose path classifies into
 * it — funnel events within a tagged session aren't restricted to the arriving device's
 * very first beacon. */
export function computeFunnelCounts(rows: FunnelPathCount[], taggedArrivals: number): Record<FunnelStepKey, number> {
  const counts = Object.fromEntries(FUNNEL_STEP_ORDER.map((k) => [k, 0])) as Record<FunnelStepKey, number>
  counts.arrivals = taggedArrivals
  for (const r of rows) {
    const step = classifyFunnelPath(r.path)
    if (step) counts[step] += r.count
  }
  return counts
}

/** Step-over-previous-step conversion rate, null (never a real 0/NaN) when the previous
 * step's count is 0, OR when either step is not instrumented for this flight. */
export function funnelStepRates(
  counts: Record<FunnelStepKey, number>,
  notInstrumented: ReadonlySet<FunnelStepKey> = FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED,
): Partial<Record<FunnelStepKey, number | null>> {
  const rates: Partial<Record<FunnelStepKey, number | null>> = {}
  for (let i = 1; i < FUNNEL_STEP_ORDER.length; i++) {
    const key = FUNNEL_STEP_ORDER[i]
    const prevKey = FUNNEL_STEP_ORDER[i - 1]
    rates[key] = notInstrumented.has(key) || notInstrumented.has(prevKey) ? null : computeRate(counts[key], counts[prevKey])
  }
  return rates
}

// ── Country bucketing ("US, CA, other") ─────────────────────────────────────────────────
export type CountryBucket = 'US' | 'CA' | 'other'
export function countryBucket(country: string): CountryBucket {
  return country === 'US' || country === 'CA' ? country : 'other'
}

// ── Device mix buckets (screen width) ───────────────────────────────────────────────────
export type ScreenBucket = 'small (<480)' | 'medium (480-1024)' | 'large (>1024)'
export function screenWidthBucket(w: number): ScreenBucket {
  if (!w || w < 480) return 'small (<480)'
  if (w <= 1024) return 'medium (480-1024)'
  return 'large (>1024)'
}

// ── Spend (empty until filled in — cost-per-arrival/auth-success show "—" until then) ──
export const CAMPAIGN_SPEND: Record<string, number | null> = {
  '24215315197': null,
  '24234347705': null,
  '24279250691': null,
}
/** spend / count, or null (never NaN/Infinity/a fabricated cost) when spend is unset or
 * count is 0. */
export function costPer(spend: number | null, count: number): number | null {
  if (spend == null) return null
  return computeRate(spend, count)
}

// ── On-device return beacon (v1.90.0; see popupEvents.ts POPUP_EVENT_PREFIXES '/return')
// `/return/<uc>/d0` is the denominator (first tagged load); d1/d2-7/d8-14/d15-30/d31-60
// are "came back within that window," counted at most once per bucket per the app's own
// on-device logic (this module just parses/sums what the beacon already deduped) ──────
export const RETURN_BUCKETS = ['d0', 'd1', 'd2-7', 'd8-14', 'd15-30', 'd31-60'] as const
export type ReturnBucket = (typeof RETURN_BUCKETS)[number]

export interface ReturnEvent {
  uc: string
  bucket: ReturnBucket
}
const RETURN_BUCKET_SET = new Set<string>(RETURN_BUCKETS)
/** Parses `/return/<uc>/<bucket>` — uc comes from the PATH itself (these beacons fire from
 * later, UNTAGGED sessions; the `campaign` D1 column is typically empty by then — see the
 * module header's D1-compound-select note and the coordinator's "no-joins" framing: this
 * reads one row's own path, it never correlates across rows). */
// Review finding (2026-09-25): validate the path-embedded campaign tag's shape, not just
// "any non-slash characters" — a malformed/adversarial path segment must never flow
// through as if it were a real uc.
const RETURN_UC_RE = /^[a-z][a-z0-9_]{0,39}$/
export function parseReturnPath(path: string): ReturnEvent | null {
  const m = /^\/return\/([^/]+)\/([^/]+)$/.exec(path)
  if (!m) return null
  const [, uc, bucket] = m
  if (!RETURN_UC_RE.test(uc) || !RETURN_BUCKET_SET.has(bucket)) return null
  return { uc, bucket: bucket as ReturnBucket }
}

/** rate per bucket = bucket count / d0 count; null ("—") for a zero d0, exactly like every
 * other rate in this codebase (see popupEvents.ts computeRate). */
export function returnVisitRates(counts: Record<ReturnBucket, number>): Record<Exclude<ReturnBucket, 'd0'>, number | null> {
  const d0 = counts.d0
  return {
    d1: computeRate(counts.d1, d0),
    'd2-7': computeRate(counts['d2-7'], d0),
    'd8-14': computeRate(counts['d8-14'], d0),
    'd15-30': computeRate(counts['d15-30'], d0),
    'd31-60': computeRate(counts['d31-60'], d0),
  }
}

/** A flight predates the return beacon entirely when it's already over before
 * TRACKING_ACTIVATION_DATE_ET (v1.90.0's release) — see the task brief: "flights before
 * v1.90.0 show 'not instrumented'". Reuses the SAME activation date as lib/popupEvents.ts
 * (v1.90.0 ships both features at once) rather than a second constant. Also true, always,
 * while that date is still unset — there's no live data yet for ANY flight. */
export function returnBeaconNotInstrumented(campaign: CampaignFlight): boolean {
  if (TRACKING_ACTIVATION_DATE_ET === null) return true
  return campaign.flightEnd < TRACKING_ACTIVATION_DATE_ET
}

/** Two campaigns that share every one of their ucValues can't be told apart by a
 * path-embedded uc either (see parseReturnPath) — flights 1 & 2 above are exactly this
 * case. Used to caption the return-visit chart "shared with <other flight>" instead of
 * presenting two identical-looking numbers as if they were independently measured. */
export function sharesReturnTagWith(campaign: CampaignFlight): CampaignFlight | null {
  for (const other of CAMPAIGNS) {
    if (other.id === campaign.id) continue
    if (campaign.ucValues.some((u) => other.ucValues.includes(u))) return other
  }
  return null
}
