// "Best Sudoku campaigns" — comparing three Google Ads campaigns from the beacon's D1
// (`hits`). Companion to lib/popupEvents.ts: funnel-step classification reuses
// classifyPopupPath (signin-prompt / promo-first50 / install) directly, and the "tracking
// not yet active" concept reuses TRACKING_ACTIVATION_DATE_ET (v1.95.3's release date, which
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

import { classifyPopupPath, computeRate, TRACKING_ACTIVATION_DATE_ET, NEW_BEACONS_LIVE_AT_ET, etDateFromMs, sqlLit, sqlInt } from './popupEvents'

// ET hour-of-day (0-23) for "Arrivals by ET hour of day" — same DST-safe Intl approach as
// popupEvents.ts's etDateFromMs, just formatting the hour instead of the calendar date.
// FINAL LIST rule (Best Sudoku team, 2026-09-25): hourOfDayEt (functions/api/campaigns.ts)
// is built ONLY from tagged-arrival rows, never from /signin-eligible — that beacon is
// deferred ≥30 min after the finish, so its own row time is not the finish time and would
// skew any hour-of-day bucketing. See lib/popupEvents.ts SIGNIN_ELIGIBLE_CAVEAT.
// Formatters are built on first use, not at module load (lib/popupEvents.ts etDateFromMs says
// why); same options, same output.
let etHourFmt: Intl.DateTimeFormat | null = null
export function etHourFromMs(ms: number): number {
  etHourFmt ??= new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' })
  return Number(etHourFmt.format(new Date(ms)))
}

// ── Campaign registry ────────────────────────────────────────────────────────────────
export interface CampaignFlight {
  id: string // Google Ads campaign id
  label: string
  /** Every `campaign` column value attributed to this flight (see ATTRIBUTION above). */
  ucValues: string[]
  /** ET calendar date (YYYY-MM-DD) attribution starts from — `ts >= ET midnight of this
   * date`. Deliberately NO upper bound: once a row carries this campaign's uc, it belongs
   * here forever (see campaignAttributionClause) — this is what lets the Android-launch
   * flight capture its post-flightEnd returner trickle without a second, date-split
   * "flight 2" entry (corrected 2026-09-25 from Google Ads API data; see module header).
   * `null` = flight start not yet confirmed — attribute NOTHING until it's set (used by the
   * retest campaign below so its pre-launch QA rows don't count). */
  flightStart: string | null
  /** Optional local ET time-of-day (HH:MM, 24h) the ad schedule actually starts at on
   * `flightStart` — when set, campaignAttributionClause's lower `ts` bound is `flightStart`
   * at THIS time (DST-safe, via etTimeUtcMs), not ET midnight. Use this when ads start
   * mid-day (e.g. the retest's noon-ET schedule) so same-day pre-schedule rows (validation
   * traffic, QA) don't count as real attribution. Undefined = bound at ET midnight, same as
   * before. */
  flightStartTimeEt?: string
  /** ET calendar date, inclusive — serving-window END, for DISPLAY and flight-day-alignment
   * only (flightDayIndex, the "daily arrivals by flight day" chart, servingHoursEt shading).
   * NOT used to bound attribution — see flightStart above. */
  flightEnd: string
  status: 'closed' | 'active' | 'upcoming'
  /** [startHourEt, endHourExclusiveEt) — descriptive only; charts DON'T filter to this
   * window (a click outside serving hours is still a real click), the hour-of-day chart
   * just shades it for context. Undefined = served all day. */
  servingHoursEt?: [number, number]
  /** Set when this campaign's ads bypass the beacon entirely (e.g. straight to a Play Store
   * listing, no web page in between) — spend is real but the funnel/arrivals numbers will
   * structurally read zero until something else starts tagging rows for its uc(s). The uc
   * stays in `ucValues` regardless, so real rows count automatically the moment they exist —
   * no code change needed here when that happens. */
  measurement?: 'spend-only'
  /** Shown next to the funnel/arrivals numbers when `measurement === 'spend-only'`. */
  measurabilityNote?: string
  /** Where the ad sends people: a web page (beacon-measurable) or straight to the Play
   * listing. Synced into the gss-stats-ads `ads_campaigns` table (lib/adsStore.ts). */
  kind: 'web' | 'play-direct'
  /** Google Ads daily budget in USD, as built (for pacing lines only). */
  dailyBudgetUsd?: number
  /** Cumulative-spend hard stop in USD, when the build spec set one. */
  hardCapUsd?: number
  notes: string
}

// CORRECTED CAMPAIGN DEFINITIONS (Google Ads API via the ads session, 2026-09-25) — replaces
// the earlier "split by date range" pass (see git history for the prior version of this
// comment). The earlier pass treated both closed campaigns as sharing one `campaign` tag and
// split them at a volume cliff; the real Google Ads data says otherwise: they're two
// DIFFERENT campaigns with two different delivery mechanisms, one of which never touches the
// beacon at all —
//
//   24215315197 "Android launch": served 2026-09-02..09-09 ET, $124.47 total. ALL
//     sudoku_tired_of_ads rows belong to this campaign, including the post-09-10 trickle
//     (returners visiting again after the campaign stopped) — there is no second flight to
//     split it from. See flightStart's doc comment: attribution has no upper bound.
//   24234347705 "Play-direct": served 2026-09-09..09-13 ET (stopped early; configured to run
//     through 09-16), $75.17 total. Its ads go straight to the Play Store listing (uc
//     sudoku_tired_of_ads_play, read from the Play Install Referrer) — there is no
//     intermediate web page, so NO beacon rows exist for it today. Spend-only until a Play
//     Install Referrer reader ships in bestsudoku-app; see `measurement` below.
//   24279250691 "US+CA web retest": uc sudoku_funnel_retest. Now serving 2026-09-26..10-02
//     ET, ad schedule starting 12:00 ET (ads session, 2026-09-26; $13/day budget, $100 hard
//     stop). The 9 rows already tagged with this uc on 2026-09-23, plus anything tagged
//     before 2026-09-26 12:00 ET, are pre-launch validation/QA, not real traffic — excluded
//     via flightStartTimeEt. See flightStart's/flightStartTimeEt's doc comments.
//
// Live `campaign` values seen in production D1 as of 2026-09-25 (read-only query:
// `SELECT campaign, MIN(ts), MAX(ts), COUNT(*) FROM hits WHERE campaign IS NOT NULL AND
// campaign<>'' GROUP BY campaign`):
//   sudoku_tired_of_ads       1194 rows  2026-09-03 .. 2026-09-22  (all → Android launch)
//   beta_v2_tier1en            132 rows  2026-07-30 .. 2026-08-03  (an unrelated earlier
//                                                                    beta — not one of the
//                                                                    3 campaigns; excluded)
//   sudoku_funnel_retest         9 rows  2026-09-23 (a few minutes) — matches campaign 3's
//                                                                     uc; pre-launch QA, see
//                                                                     above
//   webview_test                 2 rows  2026-09-21               (unrelated; excluded)
//   sudoku_tired_of_ads_test     1 row   2026-09-02               (a QA variant of the
//                                                                    Android-launch tag —
//                                                                    NOT in its ucValues,
//                                                                    same reasoning as the
//                                                                    retest's excluded QA
//                                                                    rows: test traffic, not
//                                                                    real campaign
//                                                                    performance)
//
// "sudoku_tired_of_ads_play" (Play-direct's uc) appears nowhere in production D1 today — by
// design, see above. "tired_of_ads"/"launch_2026" (earlier legacy variant guesses) also
// appear nowhere; kept in Android launch's ucValues in case they surface later, 0 rows today.
// VERIFIED live 2026-09-25: `campaign='sudoku_tired_of_ads' AND ts >= <flightStart ET
// midnight>` (no upper bound) → exactly 1,194 tagged hits, 353 tagged arrivals (visitor=
// 'new') — matches the task brief's numbers exactly; the QA variant is excluded on purpose.
export const CAMPAIGNS: CampaignFlight[] = [
  {
    id: '24215315197',
    label: 'Android launch — "tired of ads"',
    ucValues: ['sudoku_tired_of_ads', 'tired_of_ads', 'launch_2026'],
    flightStart: '2026-09-02',
    flightEnd: '2026-09-09',
    status: 'closed',
    kind: 'web',
    dailyBudgetUsd: 14.29, // best-sudoku web-retest build spec section 7 ("the week-1 campaign's ($14.29)")
    hardCapUsd: 100, // same spec: "Mike pauses the campaign at $100 ... exactly as the week-1 build required"
    notes:
      'Served 2026-09-02..09-09 ET, $124.47 total. Every row tagged with this uc family belongs here, including the post-09-10 trickle — see flightStart\'s doc comment (no upper bound on attribution). Excludes sudoku_tired_of_ads_test (1 row, 2026-09-02) — QA traffic, not real ad performance.',
  },
  {
    id: '24234347705',
    label: 'Play-direct — "tired of ads"',
    ucValues: ['sudoku_tired_of_ads_play'],
    flightStart: '2026-09-09',
    flightEnd: '2026-09-13', // stopped early; configured to run through 2026-09-16
    status: 'closed',
    kind: 'play-direct',
    dailyBudgetUsd: 14.29, // best-sudoku web-retest build spec section 7 ("the twin's ($14.29)"); no hard cap on record
    measurement: 'spend-only',
    measurabilityNote: 'Play-direct: not measurable in beacon (no Install Referrer reader)',
    notes:
      'Ads go straight to the Play Store listing (uc sudoku_tired_of_ads_play, read from the Play Install Referrer) — no D1 beacon rows exist for this uc today. $75.17 total spend, stopped early at 09-13 (configured end was 09-16). The uc stays in ucValues so rows count automatically the moment bestsudoku-app ships a Play Install Referrer reader — no code change needed here when that happens.',
  },
  {
    id: '24279250691',
    label: 'US+CA web retest',
    ucValues: ['sudoku_funnel_retest'],
    flightStart: '2026-09-26', // confirmed — now serving (ads session, 2026-09-26)
    flightStartTimeEt: '12:00', // the ad schedule's actual start — see campaignAttributionClause
    flightEnd: '2026-10-02', // 7 serving days
    status: 'active',
    kind: 'web',
    dailyBudgetUsd: 13,
    hardCapUsd: 100,
    servingHoursEt: [12, 23],
    notes:
      'Now serving as of 2026-09-26. Budget: $13/day, $100 hard stop (ads session, 2026-09-26) — see CAMPAIGN_DAILY_SPEND\'s entry for this id, left empty (and CAMPAIGN_SPEND left null) until real daily spend numbers arrive from the Google Ads API; both stay configurable per-day, same as the other two campaigns. The 9 rows tagged sudoku_funnel_retest on 2026-09-23, plus anything tagged before 2026-09-26 12:00 ET, are pre-launch validation/QA, not real traffic — excluded via flightStartTimeEt (the schedule\'s real noon-ET start), not just the calendar date.',
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
  if (campaign.flightStart == null) return null // pending flight — no anchor to count days from
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

// ET calendar date + local clock time, minute precision — used by etTimeUtcMs's round-trip
// check below (etMidnightUtcMs's own check is midnight-specific; this generalizes it).
let etDateTimeFmt: Intl.DateTimeFormat | null = null
/** "YYYY-MM-DDTHH:MM" in ET (exported for the formatter-equivalence test). */
export function etDateTimeFromMs(ms: number): string {
  etDateTimeFmt ??= new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = Object.fromEntries(etDateTimeFmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

/** DST-safe: the UTC instant denoted by ET calendar date `dateEt` (YYYY-MM-DD) at local ET
 * clock time `timeEt` (HH:MM, 24h) — the general form of etMidnightUtcMs above (which is
 * just `etTimeUtcMs(dateEt, '00:00')` in spirit, kept as its own function for its stronger
 * exact-boundary check). Tries both possible ET UTC offsets (EST -5h / EDT -4h) and picks
 * whichever one round-trips back to `${dateEt}T${timeEt}` when reformatted in
 * America/New_York. Used for CampaignFlight.flightStartTimeEt — e.g. an ad schedule that
 * starts mid-day rather than at ET midnight. */
export function etTimeUtcMs(dateEt: string, timeEt: string): number {
  for (const offsetHours of [5, 4]) {
    const candidate = Date.parse(`${dateEt}T${timeEt}:00Z`) + offsetHours * 3_600_000
    if (etDateTimeFromMs(candidate) === `${dateEt}T${timeEt}`) return candidate
  }
  return Date.parse(`${dateEt}T${timeEt}:00Z`) // unreachable for a valid date/time; safe fallback
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
/** No upper bound, ever — a row tagged with this campaign's uc belongs to it however late it
 * arrives (see flightStart's doc comment on CampaignFlight). `flightStart === null` means
 * "not yet confirmed": attribute nothing (`1 = 0`) rather than guess, so pre-launch QA rows
 * (e.g. the retest campaign's 9 rows) never count until a real date is set. The lower `ts`
 * bound is ET midnight of `flightStart` UNLESS `flightStartTimeEt` is set, in which case
 * it's `flightStart` at that local ET time instead (DST-safe, via etTimeUtcMs) — e.g. the
 * retest's ad schedule starts at noon ET, so same-day pre-schedule rows don't count. */
export function campaignAttributionClause(campaign: CampaignFlight): { sql: string; binds: unknown[] } {
  const ucPlaceholders = campaign.ucValues.map(() => '?').join(', ')
  const w = [`campaign IN (${ucPlaceholders})`]
  const binds: unknown[] = [...campaign.ucValues]
  if (campaign.flightStart === null) {
    w.push('1 = 0')
  } else {
    w.push('ts >= ?')
    binds.push(
      campaign.flightStartTimeEt
        ? etTimeUtcMs(campaign.flightStart, campaign.flightStartTimeEt)
        : etMidnightUtcMs(campaign.flightStart),
    )
  }
  return { sql: w.join(' AND '), binds }
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

// ── Derived dimension campaignFlight (functions/api/geo.ts) ────────────────────────────
// Which campaign FLIGHT a row belongs to, decided by the SAME campaignAttributionClause and
// EXCLUSIONS functions/api/campaigns.ts applies (not the raw `campaign` utm column, which also
// carries unrelated betas, QA variants and pre-launch validation rows). Value = the Google Ads
// campaign id (lib/charts.ts formatKey shows its label); '' → `emptyLabel` for every row no
// flight claims. Built by inlining those functions' own bound parameters as checked literals
// (see lib/popupEvents.ts sqlLit): the clauses stay the ONE definition of attribution, and the
// expression stays well inside D1's bound-parameter cap when a chart evaluates it twice.
function inlineBinds(sql: string, binds: unknown[]): string {
  let i = 0
  const out = sql.replace(/\?/g, () => {
    const v = binds[i++]
    if (typeof v === 'number') return String(sqlInt(v))
    if (typeof v === 'string') return sqlLit(v)
    throw new Error(`cannot inline bind ${String(v)}`)
  })
  if (i !== binds.length) throw new Error('bind count mismatch')
  return out
}
export function campaignFlightSqlCase(emptyLabel: string): string {
  const ew: string[] = []
  const eb: unknown[] = []
  applyExclusions(ew, eb)
  const excluded = `NOT (${inlineBinds(ew.join(' AND '), eb)})`
  const whens = CAMPAIGNS.map((c) => {
    const attr = campaignAttributionClause(c)
    return `WHEN ${inlineBinds(attr.sql, attr.binds)} THEN ${sqlLit(c.id)}`
  })
  return `CASE WHEN ${excluded} THEN ${sqlLit(emptyLabel)} ${whens.join(' ')} ELSE ${sqlLit(emptyLabel)} END`
}
/** Bound prefilter for a campaignFlight query: rows carrying any flight's uc value. */
export function campaignFlightPrefilter(w: string[], b: unknown[]): void {
  const ucs = [...new Set(CAMPAIGNS.flatMap((c) => c.ucValues))]
  w.push(`campaign IN (${ucs.map(() => '?').join(', ')})`)
  b.push(...ucs)
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
  // Range-specific install-fix caveats travel with the data instead (functions/api/campaigns.ts
  // funnel.installNote, from lib/popupEvents.ts installOutcomeGapNote).
  install: 'Install',
}

// Steps with NO matching path anywhere in production D1 as of 2026-09-25 (confirmed by
// scanning every distinct path on site='bestsudoku-web', tagged or not — see task report).
// STALE as a blanket claim since v1.95.5 (2026-09-26T19:43:02Z) added `/game/complete/...`
// — classifyFunnelPath below DOES now return 'completed' for those rows — but this set is
// kept as the FALLBACK "not instrumented" default for callers that don't do a per-window
// "did this path exist yet" check (functions/api/overview.ts's scorecard; see
// gameCompleteNotInstrumented below for the per-flight version functions/api/campaigns.ts's
// own seenSteps query already computes empirically and correctly with no further change).
export const FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED = new Set<FunnelStepKey>(['completed'])

/** A campaign flight predates the game-complete beacon entirely when it's already over
 * before NEW_BEACONS_LIVE_AT_ET (v1.95.5) — same shape as returnBeaconNotInstrumented
 * below, reusing lib/popupEvents.ts's NEW_BEACONS_LIVE_AT_ET rather than a second constant.
 * Callers that can't do functions/api/campaigns.ts's per-flight "did this path exist
 * site-wide during the window" query (e.g. the overview scorecard) use this instead of the
 * permanent FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED default once a flight's window reaches
 * the live instant. */
export function gameCompleteNotInstrumented(campaign: CampaignFlight): boolean {
  return campaign.flightEnd < NEW_BEACONS_LIVE_AT_ET
}

/** The overview scorecard's per-row notInstrumented set (functions/api/overview.ts): the
 * full per-flight "did this path exist site-wide during the window" check for a CLOSED
 * campaign (`closedNotInstrumented` — computed server-side via a D1 query, functions/_lib/
 * campaignInstrumentation.ts, so it can't live in this pure module), or just the
 * gameCompleteNotInstrumented gate for an active/upcoming one. Exported so the actual
 * contract driving the scorecard UI — "a campaign's 'completed' chip shows its real count,
 * not a stale label, once its flight reaches GAME_COMPLETE_LIVE_AT" — is unit-testable
 * without a database (bug fix, 2026-09-26: the scorecard template used to check the
 * PERMANENT FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED constant directly instead of this
 * per-row result, so an active campaign's real completed-game count never showed). */
export function scorecardNotInstrumentedSteps(campaign: CampaignFlight, closedNotInstrumented: readonly FunnelStepKey[]): Set<FunnelStepKey> {
  if (campaign.status === 'closed') return new Set(closedNotInstrumented)
  return gameCompleteNotInstrumented(campaign) ? new Set(FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED) : new Set()
}

// CONFIG HOOK (deferred, disabled by default, superseded by the real /game/complete/ beacon
// below as of v1.95.5 — kept only in case product ever wants a SIGNED-OUT proxy for
// pre-v1.95.5 history): '/signin-eligible/*' fires only after a game plays out — a possible
// proxy for "completed" before the real beacon existed (not a real completion signal, just
// correlated timing). null = disabled (current state).
export const COMPLETED_PROXY_PATH_PREFIX: string | null = null
/** Shown instead of "Completed a game" wherever COMPLETED_PROXY_PATH_PREFIX is enabled. */
export const COMPLETED_PROXY_LABEL = 'signed-out completions (proxy, deferred)'

/** "played a game" — found live: `/game` is the dominant tagged path (1111/1194 rows for
 * flight 1/2's uc) — the ad appears to land users directly into gameplay rather than a
 * separate marketing page, so "arrival" and "played" are close for this data. */
const PLAYED_PATH = '/game'
/** "completed a game" — v1.95.5 (live 2026-09-26T19:43:02Z, see lib/popupEvents.ts
 * GAME_COMPLETE_LIVE_AT): `/game/complete/<normal|daily>/<easy|medium|hard|expert|
 * unknown>`, one row per distinct completed game record (replays of the same puzzle
 * aren't recounted — that dedup happens app-side, before the beacon fires). Matched by
 * PREFIX, not the strict segment shape, same convention as every other family here — an
 * unrecognized mode/difficulty still counts as a completion, it just isn't broken out.
 * WITH the trailing slash — see lib/popupEvents.ts POPUP_EVENT_PREFIXES for why
 * `/game/complete/` (not `/game` or `/game/complete`) is the exact anchor that keeps this
 * from ever matching the `/game` page-view path itself. */
const GAME_COMPLETE_PREFIX = '/game/complete/'
// Any two non-slash segments after the prefix — same "don't overfit the exact enum" stance
// as GAME_COMPLETE_PREFIX's own doc comment (an unrecognized mode/difficulty still counts as
// a completion via the prefix match above; this just also buckets it, under its raw string,
// rather than requiring it match the known easy/medium/hard/expert/unknown set exactly).
const GAME_COMPLETE_SEGMENTS_RE = /^\/game\/complete\/([^/]+)\/([^/]+)$/
export const GAME_COMPLETE_MODES = ['normal', 'daily'] as const
export const GAME_COMPLETE_DIFFICULTIES = ['easy', 'medium', 'hard', 'expert', 'unknown'] as const
/** Parses `/game/complete/<mode>/<difficulty>` into its two segments — for the completions
 * BREAKDOWN widget (mode × difficulty; functions/api/completions.ts), a different job from
 * classifyFunnelPath's aggregate "completed" count above (prefix match only, no shape
 * check — see GAME_COMPLETE_PREFIX's doc comment for why). A path with the right prefix but
 * not exactly two more segments (or a corrupted beacon) returns null; the caller buckets
 * that under its own "(other)" label rather than dropping it, so the breakdown's total never
 * silently disagrees with the funnel's prefix-matched "completed" count. */
export function parseGameCompletePath(path: string): { mode: string; difficulty: string } | null {
  const m = GAME_COMPLETE_SEGMENTS_RE.exec(path)
  return m ? { mode: m[1], difficulty: m[2] } : null
}

// ── Derived dimensions gameMode / gameDifficulty (functions/api/geo.ts) ────────────────
// The two segments of /game/complete/<mode>/<difficulty>, as generic geo dimensions — the SQL
// twin of parseGameCompletePath, with the same "(other)" bucket functions/api/completions.ts
// uses for a right-prefix-wrong-shape row, and no value ('' → `emptyLabel`) for every row
// that isn't a completion at all. Values come from the row itself; the SQL here contains only
// this module's constants (see lib/popupEvents.ts sqlLit for why they're literals).
export const GAME_OTHER_BUCKET = '(other)'
export function gameDimSqlCase(dim: 'gameMode' | 'gameDifficulty', emptyLabel: string): string {
  const P = GAME_COMPLETE_PREFIX
  const rest = `substr(path, ${sqlInt(P.length + 1)})`
  const slash = `instr(${rest}, '/')`
  const tail = `substr(${rest}, ${slash} + 1)`
  // Exactly two non-empty, slash-free segments: a slash that isn't first, something after it,
  // and no further slash in what follows.
  const wellFormed = `(${slash} > 1 AND length(${tail}) > 0 AND instr(${tail}, '/') = 0)`
  const value = dim === 'gameMode' ? `substr(${rest}, 1, ${slash} - 1)` : tail
  return `CASE WHEN substr(path, 1, ${sqlInt(P.length)}) <> ${sqlLit(P)} THEN ${sqlLit(emptyLabel)} WHEN ${wellFormed} THEN ${value} ELSE ${sqlLit(GAME_OTHER_BUCKET)} END`
}
/** Bound prefilter for a gameMode/gameDifficulty query: completion rows only. */
export function gameDimPrefilter(w: string[], b: unknown[]): void {
  w.push('path LIKE ?')
  b.push(`${GAME_COMPLETE_PREFIX}%`)
}
/** JS reading of the gameMode / gameDifficulty dimension ('' = not a completion). */
export function gameDimOf(dim: 'gameMode' | 'gameDifficulty', path: string): string {
  if (!path.startsWith(GAME_COMPLETE_PREFIX)) return ''
  const parsed = parseGameCompletePath(path)
  if (!parsed) return GAME_OTHER_BUCKET
  return dim === 'gameMode' ? parsed.mode : parsed.difficulty
}
/** "auth success" — NOT part of lib/popupEvents.ts's POPUP_EVENT_PREFIXES (an ordinary page
 * path there), so classified here directly. ONE matcher for the whole codebase.
 *
 * Every sign-in sends the BASE row `/auth/success/<provider>` exactly once; the provider is
 * exactly `google` or `email`. From v1.95.5 (live 2026-09-26T19:43:02Z, lib/adsRules.ts
 * AUTH_NEW_EXISTING_LIVE_AT) it ALSO sends `/auth/success/<provider>/<new|existing|unknown>`,
 * alongside the base row for the SAME sign-in, never instead of it. So a sign-in is counted from
 * the base row only (an exact match), and the new/existing split only from the three-segment
 * rows; a prefix match would count each new-client sign-in twice. */
export const AUTH_SUCCESS_PROVIDERS = ['google', 'email'] as const
export const AUTH_SUCCESS_STATUSES = ['new', 'existing', 'unknown'] as const
export type AuthSuccessStatus = (typeof AUTH_SUCCESS_STATUSES)[number]
/** The base rows, one per sign-in (= AUTH_SUCCESS_PROVIDERS under /auth/success/). */
export const AUTH_SUCCESS_PATHS = ['/auth/success/google', '/auth/success/email'] as const
const AUTH_STATUS_RE = /^\/auth\/success\/(google|email)\/(new|existing|unknown)$/
/** A sign-in (the base row), never its status row: every auth-success count uses this
 * (functions/api/overview.ts, lib/adsRules.ts summarizeTaggedRows, classifyFunnelPath). */
export function isAuthSuccessBase(path: string): boolean {
  return (AUTH_SUCCESS_PATHS as readonly string[]).includes(path)
}
/** v0.6.1's name for the same matcher (kept so both call sites read the same function). */
export const isAuthSuccessPath = isAuthSuccessBase
/** 'base' for `/auth/success/<google|email>` (one per sign-in), the status for the suffixed row
 * that rides alongside it, null for anything else (other providers or shapes included). */
export function authSuccessRow(path: string): 'base' | AuthSuccessStatus | null {
  if (isAuthSuccessBase(path)) return 'base'
  const m = AUTH_STATUS_RE.exec(path)
  return m ? (m[2] as AuthSuccessStatus) : null
}

/** Classifies ONE path into at most one funnel step (mutually exclusive path families,
 * same design as popupEvents.ts's classifyPopupPath — reused here for the shared
 * families). `null` = not part of the funnel — including EVERY row (arrivals is never
 * derived from path; see computeFunnelCounts' `taggedArrivals` parameter). Excludes
 * `/install/platforms/*` automatically — classifyPopupPath gives those kind
 * 'platformList', a bucket this function never maps to a step. */
export function classifyFunnelPath(path: string): FunnelStepKey | null {
  if (path === PLAYED_PATH) return 'played'
  if (path.startsWith(GAME_COMPLETE_PREFIX)) return 'completed'
  if (COMPLETED_PROXY_PATH_PREFIX && path.startsWith(COMPLETED_PROXY_PATH_PREFIX)) return 'completed' // disabled by default — see the hook above
  if (isAuthSuccessBase(path)) return 'authSuccess' // the status row that rides alongside is not a second sign-in
  const ev = classifyPopupPath(path)
  if (!ev) return null
  if ((ev.family === 'signin-prompt' || ev.family === 'promo-first50') && ev.kind === 'shown') return 'ask'
  if ((ev.family === 'signin-prompt' || ev.family === 'promo-first50') && ev.kind === 'accept') return 'accept'
  if (ev.family === 'install' && ev.kind === 'shown') return 'installPrompt' // /install/prompt/{android,ios,desktop}
  // INSTALL = /popup-outcome/install-prompt/installed (coordinator, 2026-09-26): the popup
  // outcome counts AT MOST ONCE per showing, while the raw /install/<outcome> beacons can
  // double-count one install (a cross-tab race can fire pwa-installed AND
  // standalone-detected). The raw signals are a secondary figure — isRawInstallSignal below —
  // never this step. Rows before the install fix (INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS) are
  // unmeasured: the queries drop them (excludeInstallGapUnmeasured) before they get here.
  if (isInstallPromptInstalled(path)) return 'install'
  return null
}

/** THE install count everywhere (campaign funnel, overview tile/timeline, ads routine):
 * /popup-outcome/install-prompt/installed, at most once per showing. */
export function isInstallPromptInstalled(path: string): boolean {
  const ev = classifyPopupPath(path)
  return !!ev && ev.family === 'popup-outcome:install' && ev.kind === 'installed'
}

/** Raw /install/pwa-installed | standalone-detected | play-detected — "raw install signals
 * (can double-count)", shown only as a secondary line next to the deduplicated install step. */
export function isRawInstallSignal(path: string): boolean {
  const ev = classifyPopupPath(path)
  return !!ev && ev.family === 'install' && ev.kind === 'outcome'
}
export const RAW_INSTALL_SIGNALS_LABEL = 'raw install signals (can double-count)'

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

// Audit finding (2026-09-26): most of the funnel's "step / previous step" pairs mix units
// that were never comparable in the first place — the numerator counts EVENT rows (e.g. every
// `/game` page-view hit within a tagged session) while the denominator counts arrivals or
// other rows, with no per-visitor id anywhere in `hits` to join them on. That produced numbers
// like "Played a game: 314.7% (1111/353)" — not a real conversion rate, just two unrelated
// counts divided. Only two step-over-step ratios in FUNNEL_STEP_ORDER are actually valid:
//  - accept/ask — the SAME popup shown to the SAME session, tap-through is a real percentage.
//  - install/installPrompt — real, but ONLY once installPrompt is restricted to prompts shown
//    AT OR AFTER the install-outcome-gap fix (INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS,
//    popupEvents.ts): a prompt shown before the fix could never have its "installed" outcome
//    recorded at all (see that constant's own doc comment), so counting it in the denominator
//    would understate the rate for a reason that has nothing to do with real tap-through.
//    funnelStepRates takes this pre-computed post-fix count as a separate argument rather than
//    deriving it from `counts` (which has no time dimension) — see functions/api/campaigns.ts
//    and functions/api/overview.ts for how callers compute it from their own hour-bucketed rows.
// Every other step (played, completed, ask, authSuccess, installPrompt) is a plain COUNT ONLY
// now — funnelStepRates doesn't populate a rate for it at all (not even null), and the widget
// bodies (CampaignsWidgetBody.vue / OverviewWidgetBody.vue) render no percent line for it.
export const VALID_FUNNEL_RATE_STEPS = new Set<FunnelStepKey>(['accept', 'install'])

/** Real conversion rates ONLY (see VALID_FUNNEL_RATE_STEPS above) — `accept` (accept/ask) and
 * `install` (install / post-fix installPrompt, via `installPromptPostFixCount`). null (never a
 * real 0/NaN) when the denominator is 0/insufficient, OR when either step is not instrumented
 * for this flight. Every other FUNNEL_STEP_ORDER key is simply absent from the result — a
 * plain count, not a rate. */
export function funnelStepRates(
  counts: Record<FunnelStepKey, number>,
  notInstrumented: ReadonlySet<FunnelStepKey> = FUNNEL_STEPS_GLOBALLY_NOT_INSTRUMENTED,
  installPromptPostFixCount?: number | null,
): Partial<Record<FunnelStepKey, number | null>> {
  const rates: Partial<Record<FunnelStepKey, number | null>> = {}
  for (let i = 1; i < FUNNEL_STEP_ORDER.length; i++) {
    const key = FUNNEL_STEP_ORDER[i]
    if (!VALID_FUNNEL_RATE_STEPS.has(key)) continue
    if (key === 'install') {
      rates.install =
        notInstrumented.has('install') || notInstrumented.has('installPrompt') || installPromptPostFixCount == null
          ? null
          : computeRate(counts.install, installPromptPostFixCount)
      continue
    }
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

// ── Spend (Google Ads API via the ads session, 2026-09-25) — cost-per-arrival/auth-success
// show "—" for any campaign still null here ─────────────────────────────────────────────
/** Daily spend in USD by ET calendar date, as reported by Google Ads — kept for audit/
 * provenance alongside the totals below. Android launch's daily lines sum to $124.46, one
 * cent under Google Ads' own reported total of $124.47 (their own rounding, not ours);
 * Play-direct's daily lines sum exactly to $75.17. */
export const CAMPAIGN_DAILY_SPEND: Record<string, Record<string, number>> = {
  '24215315197': {
    '2026-09-02': 22.92,
    '2026-09-03': 15.52,
    '2026-09-04': 15.66,
    '2026-09-05': 14.32,
    '2026-09-06': 13.97,
    '2026-09-07': 13.56,
    '2026-09-08': 13.9,
    '2026-09-09': 14.61,
  },
  '24234347705': {
    '2026-09-09': 21.56,
    '2026-09-10': 13.52,
    '2026-09-11': 12.66,
    '2026-09-12': 14.07,
    '2026-09-13': 13.36,
  },
  '24279250691': {}, // serving as of 2026-09-26 ($13/day budget, $100 hard stop) — left empty until real daily spend numbers arrive from the Google Ads API
}
export const CAMPAIGN_SPEND: Record<string, number | null> = {
  '24215315197': 124.47, // Google Ads' own reported total — see CAMPAIGN_DAILY_SPEND's doc comment
  '24234347705': 75.17,
  '24279250691': null,
}
/** spend / count, or null (never NaN/Infinity/a fabricated cost) when spend is unset or
 * count is 0. */
export function costPer(spend: number | null, count: number): number | null {
  if (spend == null) return null
  return computeRate(spend, count)
}

// ── On-device return beacon (v1.95.3; see popupEvents.ts POPUP_EVENT_PREFIXES '/return')
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
 * TRACKING_ACTIVATION_DATE_ET (v1.95.3's release) — see the task brief: "flights before
 * v1.95.3 show 'not instrumented'". Reuses the SAME activation date as lib/popupEvents.ts
 * (v1.95.3 ships both features at once) rather than a second constant. Also true, always,
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
