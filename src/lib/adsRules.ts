// Best Sudoku ads-read routines — the PURE rules shared by scripts/ads-reads/ (the scheduled
// morning and post-flight reads) and the dashboard (stored spend + the readings log on the
// campaigns page). One module so the routine and the dashboard can never disagree: both
// read the same campaign config (lib/campaigns.ts), the same exclusions, the same
// MIN_COHORT gate and the same ET-day logic (lib/popupEvents.ts), and this file adds only
// what the routine needs on top — thresholds, kill rules, the $100 decision table, the
// release-health check and the reading-record shape the store keeps.
//
// SOURCE OF TRUTH for the rules: best-sudoku docs/marketing/google-ads/
// campaign-build-spec-web-retest-2026-09.md sections 11-14 (branch docs/ads-next-campaign).
// This module PROPOSES only. Nothing here (or in scripts/ads-reads/) can change a campaign
// setting: the Ads client is read-only by construction, and every proposal is a string for a
// human to act on.
//
// ANONYMOUS COUNTS ONLY: every input is an aggregate (a GROUP BY count, an Ads metric, a
// Firestore COUNT). Nothing here joins rows to individuals by device, timestamp or location.

import {
  MIN_COHORT,
  classifyPopupPath,
  etDateFromMs,
  gateRate,
  INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS,
  INSTALL_GAP_PATHS,
  installFixMarkerLabel,
  installOutcomeGapNote,
  installOutcomeGapOpen,
  rowIsPostInstallFix,
  POPUP_OUTCOME_TYPES,
  POPUP_PAGE_NOTE,
  type GatedRate,
  type HourPathCount,
} from './popupEvents'
import {
  campaignById,
  computeFunnelCounts,
  parseReturnPath,
  RETURN_BUCKETS,
  returnVisitRates,
  type CampaignFlight,
  type FunnelStepKey,
  type ReturnBucket,
} from './campaigns'

// ── Accounts and campaigns ───────────────────────────────────────────────────────────────
/** Google Ads REST API version the routine speaks. */
export const ADS_API_VERSION = 'v22'
/** The Best Sudoku Ads account (872-653-5246). Queried directly — NEVER through a manager
 * account: no login-customer-id header is ever sent (see scripts/ads-reads/adsApi.ts). */
export const ADS_CUSTOMER_ID = '8726535246'
export const RETEST_CAMPAIGN_ID = '24279250691'
/** Closed campaigns the routine must never read-for-action or touch. readPlanFor() refuses
 * them outright, so no code path can build a query or a proposal for either. */
export const CLOSED_CAMPAIGN_IDS: readonly string[] = ['24215315197', '24234347705']

/** v1.95.3 production WEB go-live (the brief's 2026-09-26 14:25 UTC) — the lower bound for
 * every site-wide new-indicator read. lib/popupEvents.ts TRACKING_ACTIVATION_DATE_ET is the
 * ET calendar day of the same release; this is the instant. */
export const WEB_GO_LIVE_UTC_MS = Date.parse('2026-09-26T14:25:00Z')

// The 17 approved placements (spec section 5): 1 in "Sudoku.com placement", 16 in "Other
// Sudoku placements". Android package ids, matched against the Ads API's placement strings
// (e.g. "mobileapp::2-com.easybrain.sudoku.android") by isApprovedPlacement below.
export const RETEST_APPROVED_PLACEMENTS: readonly string[] = [
  'com.easybrain.sudoku.android',
  'com.brainium.sudoku.free',
  'easy.sudoku.puzzle.solver.free',
  'com.theangrykraken.sudoku',
  'com.mobilityware.Sudoku',
  'com.gamovation.sudoku',
  'com.kraisoft.sudoku',
  'com.mathbrain.sudoku',
  'com.fassor.android.sudoku',
  'easy.killer.sudoku.puzzle.solver.free',
  'sudoku.puzzle.free.game.brain',
  'com.easybrain.killer.sudoku.free',
  'com.kwalee.queenspuzzle',
  'killer.sudoku.free.brain.puzzle',
  'com.microsoft.sudoku',
  'com.soodexlabs.sudoku2',
  'com.newsudoku.number.maze',
]

/** Approved placement lists per campaign, for tagging stored placement rows (backfill and
 * routine). The twin ran the same 17 as the retest (retest spec section 5: "identical to
 * the twin's as-built"); week 1 ran the original 19 — the 17 plus the two later excluded
 * for low CTR (spec section 5, "Excluded, on both ad groups (2 of the original 19)"). */
export const APPROVED_PLACEMENTS_BY_CAMPAIGN: Record<string, readonly string[]> = {
  [RETEST_CAMPAIGN_ID]: RETEST_APPROVED_PLACEMENTS,
  '24234347705': RETEST_APPROVED_PLACEMENTS,
  '24215315197': [...RETEST_APPROVED_PLACEMENTS, 'com.icenta.sudoku.ui', 'com.openmygame.games.android.sudokumaster'],
}

export interface AdsReadPlan {
  campaignId: string
  /** $/day, for pacing lines only (Google may overdeliver a day; never a finding). */
  dailyBudget: number
  /** Kill rule 4: propose pause at or above this cumulative spend. */
  hardCap: number
  /** Cumulative-spend read points (spec section 11). Each fires once. */
  thresholds: readonly number[]
  /** Kill rules 1-3 are armed at or above this cumulative spend. */
  killRulesFrom: number
  /** Kill rule 1: propose pause when MORE than this share of spend is outside the list. */
  placementLeakMaxShare: number
  /** Kill rule 2: propose pause when cumulative CTR is BELOW this. */
  ctrFloor: number
  approvedPlacements: readonly string[]
  /** ET dates the scheduled morning read runs (docs/routines/bsk-retest-morning-read.md) —
   * used to notice a scheduled read that never ran. */
  morningReadFirstEt: string
  morningReadLastEt: string
}

// Budget and cap come from lib/campaigns.ts (the one campaign definition); only the read
// schedule and the kill-rule constants (spec sections 11-12) live here.
const retestFlight = campaignById(RETEST_CAMPAIGN_ID)
export const ADS_READ_PLANS: Record<string, AdsReadPlan> = {
  [RETEST_CAMPAIGN_ID]: {
    campaignId: RETEST_CAMPAIGN_ID,
    dailyBudget: retestFlight?.dailyBudgetUsd ?? 13,
    hardCap: retestFlight?.hardCapUsd ?? 100,
    thresholds: [25, 50, 75, 100],
    killRulesFrom: 50,
    placementLeakMaxShare: 0.1,
    ctrFloor: 0.0015,
    approvedPlacements: RETEST_APPROVED_PLACEMENTS,
    morningReadFirstEt: '2026-09-27',
    morningReadLastEt: '2026-10-03',
  },
}

/** A scheduled morning read that never ran can't report itself, so the next read that does
 * run lists the ET dates with no daily reading since the last one on record (only dates
 * inside the routine's window, up to yesterday). */
export function missingDailyReads(readings: readonly ReadingRecord[], todayEt: string, firstEt: string, lastEt: string): string[] {
  const dailyDates = readings.filter((r) => r.kind === 'daily' && r.etDate < todayEt).map((r) => r.etDate)
  const lastSeen = dailyDates.sort().at(-1) ?? null
  const out: string[] = []
  let d = lastSeen && lastSeen >= firstEt ? addDays(lastSeen, 1) : firstEt
  while (d < todayEt && d <= lastEt) {
    if (!dailyDates.includes(d)) out.push(d)
    d = addDays(d, 1)
  }
  return out
}

/** Metric READS (spend, impressions, clicks, placements) may cover any configured campaign,
 * closed ones included — the owner allowed reading closed campaigns' metrics for the store
 * backfill (2026-09-26). This never permits a rule, a proposal or any change for them. */
export function assertKnownCampaign(campaignId: string): CampaignFlight {
  if (!/^\d+$/.test(campaignId)) throw new Error(`invalid campaign id: ${JSON.stringify(campaignId)}`)
  const campaign = campaignById(campaignId)
  if (!campaign) throw new Error(`campaign ${campaignId} is not in lib/campaigns.ts CAMPAIGNS`)
  return campaign
}

/** The ONLY way the routine resolves a campaign for a READ WITH RULES: refuses closed
 * campaigns, campaigns with no read plan, and ids missing from lib/campaigns.ts CAMPAIGNS. */
export function readPlanFor(campaignId: string): { plan: AdsReadPlan; campaign: CampaignFlight } {
  if (!/^\d+$/.test(campaignId)) throw new Error(`invalid campaign id: ${JSON.stringify(campaignId)}`)
  if (CLOSED_CAMPAIGN_IDS.includes(campaignId)) throw new Error(`campaign ${campaignId} is closed; the routine never reads or touches it`)
  const plan = ADS_READ_PLANS[campaignId]
  const campaign = campaignById(campaignId)
  if (!plan || !campaign) throw new Error(`no ads read plan for campaign ${campaignId}`)
  if (campaign.flightStart == null) throw new Error(`campaign ${campaignId} has no confirmed flightStart`)
  return { plan, campaign }
}

/** Boundary-aware package match: "com.easybrain.sudoku.android" must not match inside
 * "com.easybrain.sudoku.android.beta", and no approved id may match as a substring of an
 * unapproved one. */
export function isApprovedPlacement(placementStrings: readonly (string | null | undefined)[], approved: readonly string[]): boolean {
  const hay = placementStrings.filter((s): s is string => typeof s === 'string' && s.length > 0)
  return approved.some((pkg) => {
    const re = new RegExp(`(^|[^A-Za-z0-9_.])${pkg.replace(/\./g, '\\.')}($|[^A-Za-z0-9_.])`)
    return hay.some((s) => re.test(s))
  })
}

// ── Spend (Google Ads API only, stored per ET day in micros) ─────────────────────────────
export interface SpendDay {
  costMicros: number
  impressions: number
  clicks: number
}
export interface StoredSpend {
  v: 1
  campaignId: string
  source: 'google-ads-api'
  apiVersion: string
  customerId: string
  fetchedAt: string // ISO UTC
  /** Last ET date that was already closed (strictly before the fetch's own ET day) when this
   * was fetched — days after it are partial. null when nothing closed yet. */
  closedThroughEt: string | null
  days: Record<string, SpendDay> // ET date (account time zone) -> metrics
}

export const microsToDollars = (micros: number): number => micros / 1_000_000
export const round2 = (n: number): number => Math.round(n * 100) / 100

export interface SpendRestatement {
  date: string
  beforeMicros: number
  afterMicros: number
}

/** Upserts `incoming`'s days over `existing` (incoming wins per day — Ads back-fills for about
 * two days, so the latest read is always the truth) and reports every CLOSED day whose cost
 * moved by a cent or more, so the report can say "restated" instead of silently overwriting. */
export function mergeSpend(existing: StoredSpend | null, incoming: StoredSpend): { merged: StoredSpend; restated: SpendRestatement[] } {
  if (existing && existing.campaignId !== incoming.campaignId) throw new Error('mergeSpend: campaign id mismatch')
  const days: Record<string, SpendDay> = { ...(existing?.days ?? {}) }
  const restated: SpendRestatement[] = []
  for (const [date, day] of Object.entries(incoming.days)) {
    const before = days[date]
    const wasClosed = existing?.closedThroughEt != null && date <= existing.closedThroughEt
    if (before && wasClosed && Math.abs(before.costMicros - day.costMicros) >= 10_000) {
      restated.push({ date, beforeMicros: before.costMicros, afterMicros: day.costMicros })
    }
    days[date] = { costMicros: day.costMicros, impressions: day.impressions, clicks: day.clicks }
  }
  const sorted = Object.fromEntries(Object.entries(days).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return {
    merged: { ...incoming, days: sorted, closedThroughEt: incoming.closedThroughEt ?? existing?.closedThroughEt ?? null },
    restated: restated.sort((a, b) => (a.date < b.date ? -1 : 1)),
  }
}

export interface SpendTotals {
  costMicros: number
  cost: number // dollars, rounded to cents
  impressions: number
  clicks: number
  days: number
  firstDate: string | null
  lastDate: string | null
}
/** Sums stored days, optionally only through `throughEt` inclusive (closed days only). */
export function spendTotals(stored: StoredSpend | null, throughEt?: string | null): SpendTotals {
  let costMicros = 0
  let impressions = 0
  let clicks = 0
  const dates: string[] = []
  for (const [date, d] of Object.entries(stored?.days ?? {})) {
    if (throughEt != null && date > throughEt) continue
    costMicros += d.costMicros
    impressions += d.impressions
    clicks += d.clicks
    dates.push(date)
  }
  dates.sort()
  return {
    costMicros,
    cost: round2(microsToDollars(costMicros)),
    impressions,
    clicks,
    days: dates.length,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
  }
}

// ── Backfill check: API spend vs the hand-entered config ─────────────────────────────────
export interface SpendComparison {
  campaignId: string
  apiTotal: number // dollars
  configTotal: number | null // CAMPAIGN_SPEND
  configDailySum: number | null // sum of CAMPAIGN_DAILY_SPEND lines
  totalDiff: number | null // apiTotal - configTotal
  dayDiffs: { date: string; api: number | null; config: number | null; diff: number }[]
  /** Days the API reports spend on outside [flightStart, flightEnd]. */
  outsideFlight: { date: string; api: number }[]
}
/** Compares a backfill's API days with lib/campaigns.ts CAMPAIGN_DAILY_SPEND / CAMPAIGN_SPEND.
 * A day differs when the two disagree by half a cent or more. */
export function compareSpendToConfig(
  campaign: CampaignFlight,
  apiDays: Record<string, SpendDay>,
  configDaily: Record<string, number> | undefined,
  configTotal: number | null,
): SpendComparison {
  const dates = new Set([...Object.keys(apiDays), ...Object.keys(configDaily ?? {})])
  const dayDiffs: SpendComparison['dayDiffs'] = []
  for (const date of [...dates].sort()) {
    const api = apiDays[date] ? round2(microsToDollars(apiDays[date].costMicros)) : null
    const cfg = configDaily?.[date] ?? null
    if (cfg == null && (api ?? 0) === 0) continue
    const diff = round2((api ?? 0) - (cfg ?? 0))
    if (Math.abs(diff) >= 0.005 || (configDaily && cfg == null)) dayDiffs.push({ date, api, config: cfg, diff })
  }
  const apiTotal = round2(microsToDollars(Object.values(apiDays).reduce((a, d) => a + d.costMicros, 0)))
  const dailyVals = Object.values(configDaily ?? {})
  return {
    campaignId: campaign.id,
    apiTotal,
    configTotal,
    configDailySum: dailyVals.length ? round2(dailyVals.reduce((a, b) => a + b, 0)) : null,
    totalDiff: configTotal == null ? null : round2(apiTotal - configTotal),
    dayDiffs,
    outsideFlight: Object.entries(apiDays)
      .filter(([d, v]) => v.costMicros > 0 && ((campaign.flightStart != null && d < campaign.flightStart) || d > campaign.flightEnd))
      .map(([date, v]) => ({ date, api: round2(microsToDollars(v.costMicros)) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
  }
}

/** Last ET date with any spend (the "spend end" the wrap-up read is timed from). */
export function lastSpendDate(stored: StoredSpend | null): string | null {
  const dates = Object.entries(stored?.days ?? {})
    .filter(([, d]) => d.costMicros > 0)
    .map(([date]) => date)
    .sort()
  return dates[dates.length - 1] ?? null
}

// ── Dashboard: stored spend beats hand-entered config ────────────────────────────────────
/** One campaign's stored Google Ads totals, as the dashboard reads them from gss-stats-ads
 * (lib/adsStore.ts readSpendSummaries). */
export interface SpendSummary {
  campaignId: string
  costMicros: number
  impressions: number
  clicks: number
  days: number
  firstDate: string | null
  lastDate: string | null
  fetchedAt: string | null // latest fetch among the rows
}
export interface ResolvedSpend {
  spend: number | null
  source: 'google-ads-api' | 'config' | 'none'
  fetchedAt: string | null
  lastDate: string | null
}
/** /api/campaigns and /api/overview use this: the store's Google Ads API spend when it holds
 * at least one day for the campaign, else lib/campaigns.ts CAMPAIGN_SPEND, else nothing ("—"
 * in the UI, never a fabricated cost). */
export function resolveCampaignSpend(stored: SpendSummary | null, configSpend: number | null): ResolvedSpend {
  if (stored && stored.days > 0) {
    return { spend: round2(microsToDollars(stored.costMicros)), source: 'google-ads-api', fetchedAt: stored.fetchedAt, lastDate: stored.lastDate }
  }
  if (configSpend != null) return { spend: configSpend, source: 'config', fetchedAt: null, lastDate: null }
  return { spend: null, source: 'none', fetchedAt: null, lastDate: null }
}

// ── Thresholds (each fires once; state lives in the readings log) ───────────────────────
export function crossedThresholds(cumulative: number, thresholds: readonly number[]): number[] {
  return thresholds.filter((t) => cumulative >= t)
}
/** Thresholds a COMPLETE threshold read has already consumed. An incomplete read (Ads or
 * beacon returned no data) is logged but does not consume, so the next run retries it. */
export function consumedThresholds(readings: readonly ReadingRecord[]): number[] {
  const out = new Set<number>()
  for (const r of readings) if (r.kind === 'threshold' && r.complete) for (const t of r.thresholds) out.add(t)
  return [...out].sort((a, b) => a - b)
}
export function newlyCrossedThresholds(cumulative: number, thresholds: readonly number[], consumed: readonly number[]): number[] {
  return crossedThresholds(cumulative, thresholds).filter((t) => !consumed.includes(t))
}
export function nextThreshold(cumulative: number, thresholds: readonly number[]): number | null {
  return thresholds.find((t) => cumulative < t) ?? null
}

// ── Tagged (campaign-attributed) beacon rows → the funnel and the new indicators ─────────
/** The spec's corrected sign-in ask (section 11): both prefixes, since the first-50 offer
 * REPLACES the sign-in dialog when it fires — never both. */
export const ASK_PATHS = ['/signin-prompt/placement', '/signin-prompt/streak', '/promo-first50/shown'] as const
export const ACCEPT_PATHS = ['/signin-prompt/accept', '/promo-first50/accept'] as const
/** /popup-outcome/<popup> families, by lib/popupEvents.ts's internal id ('install' is the
 * wire name 'install-prompt'). */
export const OUTCOME_POPUPS = ['signin-prompt', 'promo-first50', 'upsell', 'install'] as const
export type OutcomePopup = (typeof OUTCOME_POPUPS)[number]
export type OutcomeType = (typeof POPUP_OUTCOME_TYPES)[number]
export type OutcomeCounts = Record<OutcomePopup, Record<OutcomeType, number>>

function emptyOutcomes(): OutcomeCounts {
  const o = {} as OutcomeCounts
  for (const p of OUTCOME_POPUPS) o[p] = Object.fromEntries(POPUP_OUTCOME_TYPES.map((t) => [t, 0])) as Record<OutcomeType, number>
  return o
}

export interface TaggedRow {
  hourStartMs: number
  path: string
  visitor: string
  count: number
}
export interface TaggedSummary {
  /** Every tagged row — NOT arrivals (the tag rides every beacon for its 30-min TTL). */
  taggedHits: number
  /** visitor='new' tagged rows — a floor (lib/campaigns.ts ARRIVALS_CAVEAT). */
  taggedArrivals: number
  funnel: Record<FunnelStepKey, number>
  asks: { total: number; byPath: Record<string, number>; otherShownReasons: number }
  accepts: { total: number; byPath: Record<string, number> }
  /** Read separately, never summed — the two dialogs dismiss differently (spec section 11). */
  dismisses: { signinPrompt: number; promoFirst50: number }
  authRedirect: number
  authSuccess: number
  /** installed = /popup-outcome/install-prompt/installed (at most once per showing) — THE
   * install metric; rawSignals = raw /install/<outcome> beacons, which can double-count. */
  install: { promptShown: number; taps: number; installed: number; rawSignals: number }
  promoFirst50: { shown: number; accept: number; dismiss: number }
  upsell: { shown: number; accept: number; dismiss: number }
  signinEligible: { earned: number; capped: number; unearned: number }
  popupOutcomes: OutcomeCounts
}

/** Aggregates tagged rows (already attribution-filtered and exclusion-filtered in SQL).
 * `fromMs`/`toMs` narrow to hour buckets in [fromMs, toMs) — e.g. one ET day. */
export function summarizeTaggedRows(rows: readonly TaggedRow[], opts: { fromMs?: number; toMs?: number } = {}): TaggedSummary {
  const inWindow = rows.filter((r) => (opts.fromMs == null || r.hourStartMs >= opts.fromMs) && (opts.toMs == null || r.hourStartMs < opts.toMs))
  const s: TaggedSummary = {
    taggedHits: 0,
    taggedArrivals: 0,
    funnel: computeFunnelCounts([], 0),
    asks: { total: 0, byPath: Object.fromEntries(ASK_PATHS.map((p) => [p, 0])), otherShownReasons: 0 },
    accepts: { total: 0, byPath: Object.fromEntries(ACCEPT_PATHS.map((p) => [p, 0])) },
    dismisses: { signinPrompt: 0, promoFirst50: 0 },
    authRedirect: 0,
    authSuccess: 0,
    install: { promptShown: 0, taps: 0, installed: 0, rawSignals: 0 },
    promoFirst50: { shown: 0, accept: 0, dismiss: 0 },
    upsell: { shown: 0, accept: 0, dismiss: 0 },
    signinEligible: { earned: 0, capped: 0, unearned: 0 },
    popupOutcomes: emptyOutcomes(),
  }
  for (const r of inWindow) {
    s.taggedHits += r.count
    if (r.visitor === 'new') s.taggedArrivals += r.count
    if ((ASK_PATHS as readonly string[]).includes(r.path)) {
      s.asks.total += r.count
      s.asks.byPath[r.path] += r.count
    }
    if ((ACCEPT_PATHS as readonly string[]).includes(r.path)) {
      s.accepts.total += r.count
      s.accepts.byPath[r.path] += r.count
    }
    if (r.path.startsWith('/auth/redirect/')) s.authRedirect += r.count
    if (r.path.startsWith('/auth/success/')) s.authSuccess += r.count
    const ev = classifyPopupPath(r.path)
    if (!ev) continue
    if (ev.family === 'signin-prompt' && ev.kind === 'shown' && !(ASK_PATHS as readonly string[]).includes(r.path)) s.asks.otherShownReasons += r.count
    if (ev.family === 'signin-prompt' && ev.kind === 'dismiss') s.dismisses.signinPrompt += r.count
    if (ev.family === 'promo-first50') {
      if (ev.kind === 'shown' || ev.kind === 'accept' || ev.kind === 'dismiss') s.promoFirst50[ev.kind] += r.count
      if (ev.kind === 'dismiss') s.dismisses.promoFirst50 += r.count
    }
    if (ev.family === 'upsell' && (ev.kind === 'shown' || ev.kind === 'accept' || ev.kind === 'dismiss')) s.upsell[ev.kind] += r.count
    if (ev.family === 'install') {
      if (ev.kind === 'shown') s.install.promptShown += r.count
      if (ev.kind === 'accept') s.install.taps += r.count
      if (ev.kind === 'outcome') s.install.rawSignals += r.count
    }
    if (ev.family === 'signin-eligible' && (ev.kind === 'earned' || ev.kind === 'capped' || ev.kind === 'unearned')) s.signinEligible[ev.kind] += r.count
    if (ev.family.startsWith('popup-outcome:')) {
      const popup = ev.family.slice('popup-outcome:'.length) as OutcomePopup
      if ((OUTCOME_POPUPS as readonly string[]).includes(popup)) s.popupOutcomes[popup][ev.kind as OutcomeType] += r.count
    }
  }
  s.funnel = computeFunnelCounts(
    inWindow.map((r) => ({ path: r.path, count: r.count })),
    s.taggedArrivals,
  )
  // THE install metric = the deduplicated popup outcome (same as the funnel's install step).
  s.install.installed = s.popupOutcomes.install.installed
  return s
}

// ── Site-wide new indicators (bestsudoku-web, since go-live; NOT campaign-attributed) ────
export interface SiteEventSummary {
  /** Popup shown counts since go-live. */
  shown: Record<OutcomePopup, number>
  /** Shown counts whose hour bucket ENDED at or before `maturedBeforeMs` — the parent side of
   * a missing-child check, so an outcome window has had time to open. */
  shownMatured: Record<OutcomePopup, number>
  outcomes: OutcomeCounts
  /** Raw /install/pwa-installed | standalone-detected | play-detected — can double-count one
   * install; secondary to outcomes.install.installed. */
  rawInstallSignals: number
  signinEligible: { earned: number; capped: number; unearned: number }
  promoFirst50: { shown: number; accept: number; dismiss: number }
  upsell: { shown: number; accept: number; dismiss: number }
  /** /install/pwa-accept taps on or after the install fix (all / hour ended before
   * `maturedBeforeMs`) — the parent of the install health pair. */
  installAcceptPostFix: number
  installAcceptPostFixMatured: number
}

/** Pre-fix rows of the install-gap paths (lib/popupEvents.ts INSTALL_GAP_PATHS) are dropped
 * here — unmeasured, never a count, a rate or an alert. A row's side of the fix comes from its
 * row-exact `postInstallFix` flag when the query split on it (scripts/ads-reads/beacon.ts
 * siteEventsQuery does), else from its hour bucket (post-fix only if the bucket starts at or
 * after the fix). */
export function summarizeSiteEvents(
  rows: readonly HourPathCount[],
  maturedBeforeMs: number,
  fixedAtMs: number | null = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS,
): SiteEventSummary {
  const zero = () => Object.fromEntries(OUTCOME_POPUPS.map((p) => [p, 0])) as Record<OutcomePopup, number>
  const s: SiteEventSummary = {
    shown: zero(),
    shownMatured: zero(),
    outcomes: emptyOutcomes(),
    rawInstallSignals: 0,
    signinEligible: { earned: 0, capped: 0, unearned: 0 },
    promoFirst50: { shown: 0, accept: 0, dismiss: 0 },
    upsell: { shown: 0, accept: 0, dismiss: 0 },
    installAcceptPostFix: 0,
    installAcceptPostFixMatured: 0,
  }
  for (const r of rows) {
    const ev = classifyPopupPath(r.path)
    if (!ev) continue
    const postFix = rowIsPostInstallFix(r, fixedAtMs)
    if ((INSTALL_GAP_PATHS as readonly string[]).includes(r.path) && !postFix) continue // unmeasured
    const matured = r.hourStartMs + 3_600_000 <= maturedBeforeMs
    if (ev.kind === 'shown' && (OUTCOME_POPUPS as readonly string[]).includes(ev.family)) {
      const fam = ev.family as OutcomePopup
      s.shown[fam] += r.count
      if (matured) s.shownMatured[fam] += r.count
    }
    if (r.path === INSTALL_PWA_ACCEPT_PATH && postFix) {
      s.installAcceptPostFix += r.count
      if (matured) s.installAcceptPostFixMatured += r.count
    }
    if (ev.family === 'install' && ev.kind === 'outcome') s.rawInstallSignals += r.count
    if (ev.family === 'signin-eligible' && (ev.kind === 'earned' || ev.kind === 'capped' || ev.kind === 'unearned')) s.signinEligible[ev.kind] += r.count
    if (ev.family === 'promo-first50' && (ev.kind === 'shown' || ev.kind === 'accept' || ev.kind === 'dismiss')) s.promoFirst50[ev.kind] += r.count
    if (ev.family === 'upsell' && (ev.kind === 'shown' || ev.kind === 'accept' || ev.kind === 'dismiss')) s.upsell[ev.kind] += r.count
    if (ev.family.startsWith('popup-outcome:')) {
      const popup = ev.family.slice('popup-outcome:'.length) as OutcomePopup
      if ((OUTCOME_POPUPS as readonly string[]).includes(popup)) s.outcomes[popup][ev.kind as OutcomeType] += r.count
    }
  }
  return s
}

/** Sum of every outcome type for one popup. */
export function outcomeTotal(o: OutcomeCounts, popup: OutcomePopup): number {
  return POPUP_OUTCOME_TYPES.reduce((a, t) => a + o[popup][t], 0)
}

/** Every outcome rate for one popup, MIN_COHORT-gated with its counts attached. */
export function outcomeRates(o: OutcomeCounts, shown: Record<OutcomePopup, number>, popup: OutcomePopup): Record<OutcomeType, GatedRate> {
  return Object.fromEntries(POPUP_OUTCOME_TYPES.map((t) => [t, gateRate(o[popup][t], shown[popup])])) as Record<OutcomeType, GatedRate>
}

// ── /return/<uc>/<bucket> (attributed by the path's own uc) ──────────────────────────────
export interface ReturnRow {
  site: string
  path: string
  count: number
}
export type ReturnCounts = Record<ReturnBucket, number>
export interface ReturnSummary {
  web: ReturnCounts
  app: ReturnCounts
  webRates: Record<Exclude<ReturnBucket, 'd0'>, number | null>
  appRates: Record<Exclude<ReturnBucket, 'd0'>, number | null>
}
const emptyReturns = (): ReturnCounts => Object.fromEntries(RETURN_BUCKETS.map((b) => [b, 0])) as ReturnCounts
export function summarizeReturns(rows: readonly ReturnRow[], ucValues: readonly string[]): ReturnSummary {
  const web = emptyReturns()
  const app = emptyReturns()
  for (const r of rows) {
    const ev = parseReturnPath(r.path)
    if (!ev || !ucValues.includes(ev.uc)) continue
    if (r.site === 'bestsudoku-web') web[ev.bucket] += r.count
    else if (r.site === 'bestsudoku-app') app[ev.bucket] += r.count
  }
  return { web, app, webRates: returnVisitRates(web), appRates: returnVisitRates(app) }
}

// ── Play: "not yet seen" until the first bestsudoku-app /return/ row ─────────────────────
export interface ReturnSiteStat {
  site: string
  count: number
  firstMs: number | null
  lastMs: number | null
}
export interface PlayReturnStatus {
  appSeen: boolean
  appCount: number
  appFirstSeenEt: string | null
  webCount: number
  webLastSeenEt: string | null
  /** A web /return/ row within the last 48 h — the pipeline works, the app just hasn't landed. */
  webContinuing: boolean
  line: string
}
const ET_HOUR_LABEL = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
})
/** "YYYY-MM-DD HH:00 ET" — hour precision is plenty for a first-seen marker. */
export function etHourLabel(ms: number): string {
  const p = Object.fromEntries(ET_HOUR_LABEL.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day} ${p.hour}:00 ET`
}
/** No expected Play date is encoded anywhere (coordinator addendum, 2026-09-26): the app is
 * "not yet seen" until its first /return/ row, then "first seen <when>". */
export function playReturnStatus(stats: readonly ReturnSiteStat[], nowMs: number): PlayReturnStatus {
  const app = stats.find((s) => s.site === 'bestsudoku-app')
  const web = stats.find((s) => s.site === 'bestsudoku-web')
  const appSeen = !!app && app.count > 0 && app.firstMs != null
  const webLast = web && web.count > 0 ? web.lastMs : null
  const webContinuing = webLast != null && nowMs - webLast <= 48 * 3_600_000
  const appFirstSeenEt = appSeen ? etHourLabel(app!.firstMs!) : null
  const webLastSeenEt = webLast != null ? etHourLabel(webLast) : null
  const line = appSeen
    ? `Play: first bestsudoku-app /return/ row seen ${appFirstSeenEt} (${app!.count} app rows since go-live).`
    : webContinuing
      ? `Play: not yet seen. Web /return/ rows are continuing (last ${webLastSeenEt}), so the pipeline works and the app build simply hasn't landed.`
      : `Play: not yet seen. Web /return/ rows ${webLastSeenEt ? `last seen ${webLastSeenEt}` : 'not seen either'}.`
  return { appSeen, appCount: app?.count ?? 0, appFirstSeenEt, webCount: web?.count ?? 0, webLastSeenEt, webContinuing, line }
}

// ── Release health: missing child of a non-zero parent (coordinator addendum) ────────────
export const HEALTH_QUIET_WINDOW_ET: readonly [number, number] = [1, 12] // [start, end) ET hours
const ET_HOUR_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' })
export function etHourOf(ms: number): number {
  return Number(ET_HOUR_FMT.format(new Date(ms))) % 24
}
/** Never evaluated between 01:00 and 12:00 ET. */
export function releaseHealthGate(nowMs: number): { evaluate: boolean; reason: string } {
  const h = etHourOf(nowMs)
  const [start, end] = HEALTH_QUIET_WINDOW_ET
  if (h >= start && h < end) return { evaluate: false, reason: `not evaluated: ${String(h).padStart(2, '0')}:xx ET is inside the 01:00-12:00 ET quiet window` }
  return { evaluate: true, reason: `evaluated at ${String(h).padStart(2, '0')}:xx ET` }
}

export interface HealthPair {
  id: string
  parentLabel: string
  parent: number
  childLabel: string
  children: number
  /** A documented reason the child can legitimately stay at zero — reported, never alerted. */
  knownGap?: string
}
export type HealthStatus = 'alert' | 'watch' | 'ok' | 'parent-zero' | 'known-gap'
export interface HealthResult extends HealthPair {
  status: HealthStatus
}
/** parent 0 → never alert; any child → ok; a documented gap → known-gap; a parent under
 * MIN_COHORT → watch (too few to call a zero child a fault); otherwise → alert. */
export function evaluateHealthPairs(pairs: readonly HealthPair[], minParent: number = MIN_COHORT): HealthResult[] {
  return pairs.map((p) => {
    let status: HealthStatus
    if (p.parent <= 0) status = 'parent-zero'
    else if (p.children > 0) status = 'ok'
    else if (p.knownGap) status = 'known-gap'
    else if (p.parent < minParent) status = 'watch'
    else status = 'alert'
    return { ...p, status }
  })
}

/** The install tap the install health pair is keyed to (the coordinator, 2026-09-26: the
 * parent is the ACCEPT, not "shown"). */
export const INSTALL_PWA_ACCEPT_PATH = '/install/pwa-accept'

/** The install-outcome gap, fixed in Best Sudoku v1.95.4 (lib/popupEvents.ts
 * INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS): before the fix, prompt-driven installs emitted no
 * /install/pwa-installed and no /popup-outcome/install-prompt/installed; those rows stay
 * unmeasured. /install/pwa-accept (the tap) was always accurate. A Play install has no
 * web-side outcome until /install/play-detected on a later visit. */
export function installOutcomeGapReportNote(fixedAtMs: number | null = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS): string {
  const status =
    fixedAtMs === null
      ? installOutcomeGapNote(null, null)
      : `${installFixMarkerLabel(fixedAtMs)} (Best Sudoku v1.95.4); install counts before it are unmeasured, after it they come from /popup-outcome/install-prompt/installed`
  return `Install outcomes: ${status}. The install tap (/install/pwa-accept) is accurate; a Play install has no web-side outcome until a later play-detected visit.`
}
export const INSTALL_OUTCOME_GAP_NOTE = installOutcomeGapReportNote()
export const UPSELL_KNOWN_BUG_NOTE =
  'Upsell near-zero for signed-out traffic is a KNOWN BUG (useUpsellPrompt returns early when uid is null), not broken instrumentation. A later non-zero is not a campaign win until someone checks whether that bug was fixed in between.'
export const SIGNIN_ELIGIBLE_COUNT_NOTE =
  'signin-eligible is a COUNT of asks, never a denominator: redirect-leg sign-in failures are not captured, so eligible → signed-in is not a computable ratio.'
export const PLAY_INSTALLS_HOUSEHOLD_NOTE = "Play install counts include Mike's household installs."
/** The same sentence the pop-ups page shows (lib/popupEvents.ts POPUP_PAGE_NOTE, corrected
 * 2026-09-26 against best-sudoku's measurementQuiet.ts) — one wording, two surfaces. */
export const MEASUREMENT_QUIET_NOTE = POPUP_PAGE_NOTE
/** Verified against best-sudoku origin/main (2026-09-26): reportAuthSuccess
 * (src/services/observability/authSignals.ts) carries no new/existing flag and useAuth.ts
 * calls it from BOTH signInWithEmail and createAccountWithEmail, so a tagged auth success can
 * be a returning sign-in; and new accounts in the window are SITEWIDE. Each input over-counts
 * campaign sign-ups, so their minimum is an UPPER bound — "at most N". */
export const SIGNUP_PROXY_NOTE =
  'Sign-ups are an UPPER bound, "at most N campaign sign-ups" = min(tagged auth successes, new prod accounts sitewide in the flight window): /auth/success also fires for returning sign-ins and the account count is not campaign-attributed. Counts only, never matched to anyone.'
/** Post-flight recommendation (a beacon change, so only after the 2026-10-02 freeze). */
export const AUTH_SUCCESS_SPLIT_RECOMMENDATION =
  'Recommendation: add /auth/success/<provider>/new|existing via additionalUserInfo.isNewUser (frozen until 10-02), so a campaign sign-up can be counted instead of bounded.'

export interface HealthInputs {
  site: SiteEventSummary
  /** Tagged arrivals whose hour ended at least an hour ago (d0 fires on the landing load). */
  taggedArrivalsMatured: number
  returnD0Web: number
  /** lib/popupEvents.ts INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS — null = the gap is still open
   * (then the install pair is a known gap and never alerts). Omitted = the configured value. */
  installFixedAtMs?: number | null
}
export function buildHealthPairs(i: HealthInputs): HealthPair[] {
  const outcomes = (p: OutcomePopup) => outcomeTotal(i.site.outcomes, p)
  return [
    {
      id: 'tagged-arrival→return-d0',
      parentLabel: 'tagged arrivals (web)',
      parent: i.taggedArrivalsMatured,
      childLabel: '/return/<uc>/d0 (web)',
      children: i.returnD0Web,
    },
    {
      id: 'signin-prompt→outcomes',
      parentLabel: 'sign-in prompt shown (≥24h old)',
      parent: i.site.shownMatured['signin-prompt'],
      childLabel: '/popup-outcome/signin-prompt/*',
      children: outcomes('signin-prompt'),
    },
    {
      id: 'promo-first50→outcomes',
      parentLabel: 'first-50 promo shown (≥24h old)',
      parent: i.site.shownMatured['promo-first50'],
      childLabel: '/popup-outcome/promo-first50/*',
      children: outcomes('promo-first50'),
    },
    {
      id: 'upsell→outcomes',
      parentLabel: 'upsell shown (≥24h old)',
      parent: i.site.shownMatured.upsell,
      childLabel: '/popup-outcome/upsell/*',
      children: outcomes('upsell'),
    },
    {
      // Since the v1.95.4 fix this is an ordinary pair (release coordinator, 2026-09-26: a
      // continued zero must be RAISED — no real device install has been observed yet). The
      // parent is the ACCEPT tap (/install/pwa-accept) on or after the fix, at least the
      // outcome-window age old; the child is the deduplicated installed outcome, post-fix only.
      id: 'install-accept→installed',
      parentLabel: 'install-prompt accepts (/install/pwa-accept, after the fix, ≥24h old)',
      parent: i.site.installAcceptPostFixMatured,
      childLabel: '/popup-outcome/install-prompt/installed (after the fix)',
      children: i.site.outcomes.install.installed,
      ...(installOutcomeGapOpen(i.installFixedAtMs === undefined ? INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS : i.installFixedAtMs)
        ? { knownGap: installOutcomeGapReportNote(null) }
        : {}),
    },
  ]
}

// ── Kill rules (spec section 12) — evaluated only on data that came back ────────────────
export type RuleId = 'placement-leak' | 'ctr' | 'funnel-reach' | 'hard-cap'
export type RuleStatus = 'trip' | 'clear' | 'not-armed' | 'no-data'
export interface RuleResult {
  id: RuleId
  label: string
  status: RuleStatus
  value: number | null
  limit: number
  detail: string
}
// ── Is there anything to pause? ──────────────────────────────────────────────────────────
// After its end date a campaign keeps status ENABLED while serving_status becomes ENDED. A
// pause is only ever proposed for a campaign that is actually serving (or whose state could
// not be read, where silence would cost money); an ended, paused or otherwise non-serving
// campaign is reported as such instead.
export type ServingState = 'serving' | 'ended' | 'paused' | 'not-serving' | 'unknown'
export function servingStateOf(s: { status: string | null; servingStatus: string | null } | null | undefined): ServingState {
  if (!s || !s.status) return 'unknown'
  if (s.status === 'PAUSED' || s.status === 'REMOVED') return 'paused'
  if (s.servingStatus === 'ENDED') return 'ended'
  if (s.status === 'ENABLED' && s.servingStatus === 'SERVING') return 'serving'
  if (s.status === 'ENABLED' && !s.servingStatus) return 'unknown'
  return 'not-serving'
}
export function canProposePause(state: ServingState): boolean {
  return state === 'serving' || state === 'unknown'
}
/** Prefix of the reading note recorded instead of a pause proposal (the store's proposal
 * column only holds PROPOSE PAUSE / CONTINUE). */
export const NO_PAUSE_NOTE_PREFIX = 'no pause proposed: campaign '
export function noPauseNote(state: ServingState, s?: { status: string | null; servingStatus: string | null } | null): string {
  return `${NO_PAUSE_NOTE_PREFIX}${state === 'ended' ? 'ended' : state === 'paused' ? 'paused' : 'not serving'} (${s?.status ?? '?'}/${s?.servingStatus ?? '?'})`
}
/** What the readings panel shows in the Proposal column. */
export function proposalLabel(r: { proposal: string | null; notes: readonly string[] }): string {
  if (r.proposal) return r.proposal
  const n = r.notes.find((x) => x.startsWith(NO_PAUSE_NOTE_PREFIX))
  return n ? n.slice('no pause proposed: '.length) : '—'
}

export interface KillRuleInput {
  plan: AdsReadPlan
  /** Closed-day cumulative spend in dollars. */
  cumulativeSpend: number
  /** Campaign status + serving status; omitted/null = unreadable (pause may still be proposed). */
  campaignState?: { status: string | null; servingStatus: string | null } | null
  /** Cumulative impressions/clicks — null when the Ads daily read failed. */
  delivery: { impressions: number; clicks: number } | null
  /** Placement cost split — null when the placement read failed. */
  placements: { campaignCost: number; approvedCost: number; itemizedCost: number } | null
  /** Tagged beacon counts — null when the beacon read failed. */
  beacon: { asks: number; taggedArrivals: number } | null
}
export interface KillRuleEvaluation {
  rules: RuleResult[]
  tripped: RuleId[]
  /** null = rules tripped but the campaign is not serving, so there is nothing to pause
   * (see servingState and noPauseNote). */
  proposal: 'PROPOSE PAUSE' | 'CONTINUE' | null
  servingState: ServingState
}
/** Share of spend outside the approved placements, robust to Google's placement view summing
 * slightly ABOVE the campaign total (measured 2026-09-26: $125.37 itemized vs $124.47 for
 * week 1, $76.25 vs $75.17 for the twin). off-list = itemized − approved; un-itemized =
 * campaign − itemized when positive; the denominator is the larger of the two totals, so
 * neither side's rounding invents a leak or hides a big one.
 *
 * KNOWN EDGE (review, 2026-09-26): because the denominator is the LARGER total, a leak just
 * over the line can read just under it. With itemized ~1% above the campaign total, a true
 * 10.05% leak reads ~9.95%, and anything up to roughly 10-11% can land within a point of the
 * 10% threshold on either side. The report always prints the share with both totals, so a
 * reading of 9-11% deserves a human look even when the rule says "clear". */
export function placementOutsideShare(p: { campaignCost: number; approvedCost: number; itemizedCost: number }): { share: number; offList: number; unitemized: number } {
  const offList = Math.max(0, p.itemizedCost - p.approvedCost)
  const unitemized = Math.max(0, p.campaignCost - p.itemizedCost)
  const denom = Math.max(p.campaignCost, p.itemizedCost)
  return { share: denom > 0 ? (offList + unitemized) / denom : 0, offList, unitemized }
}

const pctStr = (x: number, dp = 2) => `${(x * 100).toFixed(dp)}%`
const usd = (x: number) => `$${x.toFixed(2)}`

export function evaluateKillRules(i: KillRuleInput): KillRuleEvaluation {
  const { plan } = i
  const armed = i.cumulativeSpend >= plan.killRulesFrom
  const rules: RuleResult[] = []

  // 1. Placement leak — share of spend NOT on the 17 approved placements. Un-itemized spend
  // (campaign total minus every itemized placement) counts as outside: it is not
  // attributable to an approved placement yet. Reported separately, because Google often
  // itemizes it later.
  {
    const base = { id: 'placement-leak' as const, label: `>${pctStr(plan.placementLeakMaxShare, 0)} of spend outside the ${plan.approvedPlacements.length} approved placements`, limit: plan.placementLeakMaxShare }
    if (!armed) rules.push({ ...base, status: 'not-armed', value: null, detail: `armed at ${usd(plan.killRulesFrom)}` })
    else if (!i.placements || !(i.placements.campaignCost > 0)) rules.push({ ...base, status: 'no-data', value: null, detail: 'placement read returned no data' })
    else {
      const { campaignCost, itemizedCost } = i.placements
      const { share, offList: itemizedOutside, unitemized } = placementOutsideShare(i.placements)
      const trip = share > plan.placementLeakMaxShare
      const caveat = trip && unitemized > itemizedOutside ? ' Most of it is un-itemized; Google often itemizes it to approved placements within ~2 days, so confirm before pausing.' : ''
      rules.push({
        ...base,
        status: trip ? 'trip' : 'clear',
        value: share,
        detail: `${pctStr(share)} outside (${usd(itemizedOutside)} itemized off-list + ${usd(unitemized)} un-itemized; campaign ${usd(campaignCost)}, itemized ${usd(itemizedCost)}).${caveat}`,
      })
    }
  }

  // 2. CTR under the floor.
  {
    const base = { id: 'ctr' as const, label: `CTR under ${pctStr(plan.ctrFloor)}`, limit: plan.ctrFloor }
    if (!armed) rules.push({ ...base, status: 'not-armed', value: null, detail: `armed at ${usd(plan.killRulesFrom)}` })
    else if (!i.delivery || i.delivery.impressions < MIN_COHORT) rules.push({ ...base, status: 'no-data', value: null, detail: 'no impressions returned' })
    else {
      const ctr = i.delivery.clicks / i.delivery.impressions
      rules.push({
        ...base,
        status: ctr < plan.ctrFloor ? 'trip' : 'clear',
        value: ctr,
        detail: `${pctStr(ctr)} (${i.delivery.clicks} clicks / ${i.delivery.impressions} impressions)`,
      })
    }
  }

  // 3. Funnel reach — zero sign-in asks from tagged arrivals.
  {
    const base = { id: 'funnel-reach' as const, label: 'zero sign-in asks from tagged arrivals', limit: 0 }
    if (!armed) rules.push({ ...base, status: 'not-armed', value: null, detail: `armed at ${usd(plan.killRulesFrom)}` })
    else if (!i.beacon) rules.push({ ...base, status: 'no-data', value: null, detail: 'beacon read returned no data' })
    else {
      const zeroArrivals = i.beacon.taggedArrivals === 0 ? ' Zero tagged arrivals too: check the landing URL and tagging.' : ''
      rules.push({
        ...base,
        status: i.beacon.asks === 0 ? 'trip' : 'clear',
        value: i.beacon.asks,
        detail: `${i.beacon.asks} asks from ${i.beacon.taggedArrivals} tagged arrivals.${zeroArrivals}`,
      })
    }
  }

  // 4. Hard cap — regardless of results.
  {
    const base = { id: 'hard-cap' as const, label: `cumulative spend at ${usd(plan.hardCap)}`, limit: plan.hardCap }
    rules.push(
      i.cumulativeSpend >= plan.hardCap
        ? { ...base, status: 'trip', value: i.cumulativeSpend, detail: `${usd(i.cumulativeSpend)} reached the ${usd(plan.hardCap)} hard cap` }
        : { ...base, status: 'not-armed', value: i.cumulativeSpend, detail: `${usd(i.cumulativeSpend)} of ${usd(plan.hardCap)}` },
    )
  }

  const tripped = rules.filter((r) => r.status === 'trip').map((r) => r.id)
  const servingState = servingStateOf(i.campaignState)
  const proposal = !tripped.length ? 'CONTINUE' : canProposePause(servingState) ? 'PROPOSE PAUSE' : null
  return { rules, tripped, proposal, servingState }
}

// ── Decision table at the $100 read (spec section 13) ───────────────────────────────────
export type DecisionRow = 'two-plus' | 'one' | 'zero-declined' | 'zero-rarely-shown' | 'zero-accepted-not-completed'
export interface DecisionInput {
  /** An UPPER bound on campaign sign-ups — see signUpsAtMost. */
  signUpsAtMost: number
  asks: number
  accepts: number
}
export interface DecisionResult {
  row: DecisionRow
  reading: string
  next: string
}
/** "Rarely shown" = fewer asks than MIN_COHORT — the same floor every rate uses. The sign-up
 * figure is an upper bound, so the 2+ and 1 rows can only say "at most"; a bound of 0 is a
 * real zero. */
export function decideAt100(i: DecisionInput): DecisionResult {
  if (i.signUpsAtMost >= 2) {
    return {
      row: 'two-plus',
      reading: `At most ${i.signUpsAtMost} campaign sign-ups: an upper bound (tagged auth successes include returning sign-ins; new accounts are sitewide), so the spec's 2-or-more row may or may not be met. Mike decides.`,
      next: 'If Mike judges the bound real: compute cost per sign-up, hold on scaling until the day-15+ follow-up reports, and run O3 (Search) at the same cap against the same funnel. Do not scale display on this read.',
    }
  }
  if (i.signUpsAtMost === 1) {
    return {
      row: 'one',
      reading: 'At most 1 campaign sign-up (an upper bound: 0 or 1). Inconclusive at this base.',
      next: "Hold. Do not scale; carry the funnel reads and any sign-up's day-15+ outcome into the next decision.",
    }
  }
  if (i.asks < MIN_COHORT) {
    return {
      row: 'zero-rarely-shown',
      reading: `The trigger sits too deep for a paid arrival to reach (${i.asks} asks).`,
      next: 'Stop paid acquisition. The next move is a product change to when the prompt fires, not a channel.',
    }
  }
  if (i.accepts === 0) {
    return {
      row: 'zero-declined',
      reading: `Paid display arrivals see the offer and decline it (${i.asks} asks, 0 accepted).`,
      next: 'Stop display acquisition. O3 (Search) becomes the next test, since it isolates intent.',
    }
  }
  return {
    row: 'zero-accepted-not-completed',
    reading: `Not a pre-registered row: ${i.accepts} of ${i.asks} asks accepted but no sign-up completed. The redirect leg is not captured, so the loss point is unknown.`,
    next: 'No pre-registered next step. Report to Mike; decide nothing on this read alone.',
  }
}
/** "At most N campaign sign-ups" — an UPPER bound, never a verified count: a tagged auth
 * success can be a returning sign-in, and new accounts in the window are sitewide, so each
 * input over-counts and their minimum is still only an upper bound (see SIGNUP_PROXY_NOTE).
 * When the window count is unavailable, the tagged count stands alone (a looser bound). */
export function signUpsAtMost(taggedAuthSuccess: number, windowNewAccounts: number | null): number {
  return windowNewAccounts == null ? taggedAuthSuccess : Math.min(taggedAuthSuccess, windowNewAccounts)
}
export function signUpsAtMostLabel(atMost: number, taggedAuthSuccess: number, windowNewAccounts: number | null): string {
  return `at most ${atMost} campaign sign-up${atMost === 1 ? '' : 's'} (tagged auth successes ${taggedAuthSuccess}; new prod accounts sitewide in the window ${windowNewAccounts ?? 'not read'})`
}

// ── Day-15/30/60 cohort: accounts created in the flight window, by tier and promo ───────
/** Raw Firestore COUNTs over users created inside the flight window (scripts/ads-reads/
 * firebase.ts cohortTierQueries). Sitewide, NOT campaign-attributed. */
export interface CohortTierCounts {
  total: number
  /** access_expires_at in the future, or 'lifetime'. */
  paid: number
  /** access_expires_at a past ISO date (explicitly expired — beats the trial window). */
  accessPast: number
  /** trial_ends_at a past ISO date. */
  trialPast: number
  trialPastAndPaid: number
  trialPastAndAccessPast: number
  /** promo_first50_granted_at set. */
  promoSet: number
}
export interface CohortTiers {
  label: 'sitewide, not campaign-attributed'
  total: number
  paid: number
  trialActive: number
  expired: number
  promoSet: number
  promoUnset: number
  rates: { paid: GatedRate; trialActive: GatedRate; expired: GatedRate; promoSet: GatedRate }
  /** false when the counts don't add up (e.g. unparseable field values); report counts only. */
  consistent: boolean
}
/** Mirrors best-sudoku useAccess.tier (admin aside): paid/lifetime > explicitly expired >
 * trial (future or unset trial_ends_at) > expired. expired = accessPast ∪ (trialPast ∖ paid);
 * paid and accessPast are disjoint (one field, one value). */
export function deriveCohortTiers(c: CohortTierCounts): CohortTiers {
  const expired = c.accessPast + c.trialPast - c.trialPastAndPaid - c.trialPastAndAccessPast
  const trialActive = c.total - c.paid - expired
  const promoUnset = c.total - c.promoSet
  const consistent = [expired, trialActive, promoUnset, c.paid].every((x) => x >= 0) && c.paid + expired <= c.total
  return {
    label: 'sitewide, not campaign-attributed',
    total: c.total,
    paid: c.paid,
    trialActive: Math.max(0, trialActive),
    expired: Math.max(0, expired),
    promoSet: c.promoSet,
    promoUnset: Math.max(0, promoUnset),
    rates: {
      paid: gateRate(c.paid, c.total),
      trialActive: gateRate(Math.max(0, trialActive), c.total),
      expired: gateRate(Math.max(0, expired), c.total),
      promoSet: gateRate(c.promoSet, c.total),
    },
    consistent,
  }
}
/** Stages that read the cohort breakdown. */
export const COHORT_TIER_STAGES: readonly PostflightStage[] = ['day15', 'day30', 'day60']

// ── Readings log (kept in the store; also the threshold state) ──────────────────────────
export type ReadingKind = 'daily' | 'threshold' | 'postflight' | 'health'
export interface ReadingRecord {
  v: 1
  id: string
  campaignId: string
  kind: ReadingKind
  /** For postflight: 'wrapup' | 'day15' | 'day30' | 'day60' | 'december'. */
  stage?: string
  readAt: string // ISO UTC
  etDate: string // ET date of the read itself
  spendThroughEt: string | null
  cumulativeSpend: number | null
  thresholds: number[]
  /** true only when every read the record depends on returned data. */
  complete: boolean
  rules: RuleResult[] | null
  proposal: string | null
  decision: DecisionResult | null
  /** Key counts — anonymous aggregates only. null = not read. */
  counts: Record<string, number | null>
  notes: string[]
}
export interface ReadingsLog {
  v: 1
  campaignId: string
  readings: ReadingRecord[]
}
/** APPEND-ONLY, like the ads_readings table (whose triggers forbid UPDATE/DELETE): a re-run
 * adds a row, it never replaces one. A retried insert of the SAME id is a no-op. Sorted by
 * readAt. The in-memory twin of what lib/adsStore.ts writes. */
export function appendReading(log: ReadingsLog | null, rec: ReadingRecord): ReadingsLog {
  if (log && log.campaignId !== rec.campaignId) throw new Error('appendReading: campaign id mismatch')
  const existing = log?.readings ?? []
  if (existing.some((r) => r.id === rec.id)) return { v: 1, campaignId: rec.campaignId, readings: [...existing] }
  const readings = [...existing, rec].sort((a, b) => (a.readAt < b.readAt ? -1 : a.readAt > b.readAt ? 1 : 0))
  return { v: 1, campaignId: rec.campaignId, readings }
}

/** The ads_readings.reading_key: unique per campaign, kind, stage and read instant. */
export function readingId(kind: ReadingKind, readAt: string, stage?: string, campaignId?: string): string {
  return [kind, campaignId, stage, readAt].filter(Boolean).join(':')
}

// ── Post-flight schedule ─────────────────────────────────────────────────────────────────
export type PostflightStage = 'wrapup' | 'day15' | 'day30' | 'day60' | 'december'
export const POSTFLIGHT_STAGES: readonly PostflightStage[] = ['wrapup', 'day15', 'day30', 'day60', 'december']
function addDays(dateEt: string, days: number): string {
  const d = new Date(dateEt + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
/** ET date each stage is due. wrap-up = spend end + 7; day 15/30/60 are counted from the
 * flight's LAST serving day so every sign-up in it has reached that day; december = the
 * later of day 60 + 2 and 2026-12-01, when every d31-60 return window has closed. */
export function postflightDueDate(stage: PostflightStage, spendEndEt: string, flightEndEt: string): string {
  const last = spendEndEt > flightEndEt ? spendEndEt : flightEndEt
  switch (stage) {
    case 'wrapup':
      return addDays(spendEndEt, 7)
    case 'day15':
      return addDays(last, 15)
    case 'day30':
      return addDays(last, 30)
    case 'day60':
      return addDays(last, 60)
    case 'december': {
      const d = addDays(last, 62)
      return d > '2026-12-01' ? d : '2026-12-01'
    }
  }
}

// ── Formatting helpers shared by the report and the dashboard panel ─────────────────────
export function formatGated(g: GatedRate): string {
  const counts = `${g.numerator}/${g.denominator}`
  if (g.value == null) return g.insufficientCohort ? `too few (${counts})` : `— (${counts})`
  return `${(g.value * 100).toFixed(1)}% (${counts})`
}

export function etDateOf(ms: number): string {
  return etDateFromMs(ms)
}
