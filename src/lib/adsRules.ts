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
  authSuccessRow,
  campaignById,
  computeFunnelCounts,
  parseReturnPath,
  RETURN_BUCKETS,
  returnVisitRates,
  type AuthSuccessStatus,
  type CampaignFlight,
  type FunnelStepKey,
  type ReturnBucket,
} from './campaigns'
import { etOffsetHours } from './etTime'

// ── Accounts and campaigns ───────────────────────────────────────────────────────────────
/** Google Ads REST API version the routine speaks. */
export const ADS_API_VERSION = 'v25'
/** The Best Sudoku Ads account (872-653-5246). Queried directly — NEVER through a manager
 * account: no login-customer-id header is ever sent (see scripts/ads-reads/adsApi.ts). */
export const ADS_CUSTOMER_ID = '8726535246'
/** Closed campaigns the routine must never read-for-action or touch. readPlanFor() refuses
 * them outright, so no code path can build a query or a proposal for either. A NEW campaign
 * is never added here (it is registered in CAMPAIGNS + ADS_READ_PLANS instead); this list is
 * only for campaigns that must stay unreadable. */
export const CLOSED_CAMPAIGN_IDS: readonly string[] = ['24215315197', '24234347705']

/** v1.95.3 production WEB go-live (the brief's 2026-09-26 14:25 UTC) — the lower bound for
 * every site-wide new-indicator read. lib/popupEvents.ts TRACKING_ACTIVATION_DATE_ET is the
 * ET calendar day of the same release; this is the instant. */
export const WEB_GO_LIVE_UTC_MS = Date.parse('2026-09-26T14:25:00Z')

// ── Mid-flight instrumentation (owner override of the spec section 14a beacon freeze, 2026-09-26)
// Each instant is set (UTC ms) by the release coordinator once the release is live; null = not
// live yet, and every read behaves exactly as before.
/** When `/auth/success/<provider>/<new|existing|unknown>` went live: v1.95.5, 2026-09-26T19:43:02Z
 * (the same instant as lib/popupEvents.ts GAME_COMPLETE_LIVE_AT). From then on campaign sign-ups
 * are counted EXACTLY from tagged `/new` rows; "at most N" still bounds the unsplit and
 * `unknown` rows (before the release, or from an old client). See campaignSignUps. A plain
 * Date.parse literal, no Intl at module load: the ads-sync Worker imports this module. The ONE
 * definition (v0.6.1 set the same instant). */
export const AUTH_NEW_EXISTING_LIVE_AT: number | null = Date.parse('2026-09-26T19:43:02Z')
/** When the signed-out upsell fix went live. A BEHAVIOUR change, so a funnel SEGMENT
 * BOUNDARY: the $100 read and the post-flight reads report pre-fix and post-fix figures
 * separately (spec section 14a: "two separate short tests"). See splitAtBoundary. */
export const UPSELL_SIGNEDOUT_FIX_AT: number | null = null
/** When promos_public/first50 (the doc the signed-out client gates its first-50 offer on) first
 * existed in prod. Before it, the client showed NO first-50 offer, whatever the promos/first50
 * counter said (ads-session finding, 2026-09-28). REPORT TEXT ONLY: never a kill rule, a
 * threshold, a decision row or a push input. A plain Date.parse literal (Worker bundle, no Intl). */
export const PROMOS_PUBLIC_FIRST50_LIVE_AT: number = Date.parse('2026-09-28T20:11:29Z')
/** "HH:MM:SS ET MM-DD" by etTime arithmetic (never Intl; built on call, not at load). */
export function etSecondLabelShort(ms: number): string {
  const et = new Date(ms + etOffsetHours(ms) * 3_600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(et.getUTCHours())}:${pad(et.getUTCMinutes())}:${pad(et.getUTCSeconds())} ET ${pad(et.getUTCMonth() + 1)}-${pad(et.getUTCDate())}`
}
/** The note appended wherever a full read prints the promo-ask count ($50+ reads, post-flight). */
export function promoArmAbsentNote(liveAtMs: number = PROMOS_PUBLIC_FIRST50_LIVE_AT): string {
  return `promo arm absent until ${etSecondLabelShort(liveAtMs)} (promos_public/first50 did not exist)`
}

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

/** Approved placement lists for the CLOSED campaigns that have no read plan, for tagging stored
 * placement rows (backfill). The twin ran the same 17 as the retest (retest spec section 5:
 * "identical to the twin's as-built"); week 1 ran the original 19 — the 17 plus the two later
 * excluded for low CTR (spec section 5, "Excluded, on both ad groups (2 of the original 19)").
 * A campaign WITH a read plan carries its list on the plan (approvedPlacements): read it
 * through approvedPlacementsFor(), never this map directly. */
export const APPROVED_PLACEMENTS_BY_CAMPAIGN: Record<string, readonly string[]> = {
  '24234347705': RETEST_APPROVED_PLACEMENTS,
  '24215315197': [...RETEST_APPROVED_PLACEMENTS, 'com.icenta.sudoku.ui', 'com.openmygame.games.android.sudokumaster'],
}
/** The approved placement list for a campaign: its read plan's list when it has a plan, else
 * the closed-campaign record above, else null (none on record). */
export function approvedPlacementsFor(campaignId: string): readonly string[] | null {
  return ADS_READ_PLANS[campaignId]?.approvedPlacements ?? APPROVED_PLACEMENTS_BY_CAMPAIGN[campaignId] ?? null
}

/** Build-spec section 5/6 expected ad-group placement counts (the retest campaign carries the
 * twin's structure over exactly: campaign-build-spec-web-retest-2026-09.md sections 5-6). Used
 * only to VERIFY the live `targeting` diagnostic read (scripts/ads-reads/read.ts) against the
 * build spec — an informational report line, never a kill rule (contract sections 12-13 are
 * frozen; see docs/routines/bsk-retest-morning-read.md). */
export const RETEST_AD_GROUP_PLACEMENT_COUNTS: Record<string, number> = {
  'Sudoku.com placement': 1,
  'Other Sudoku placements': 16,
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
  /** Short campaign name that leads this campaign's push/bus text and report header
   * ("<label> morning read ..."). Unique across the registry, so two campaigns read the same
   * morning never produce indistinguishable notifications. The retest keeps "BSK retest". */
  reportLabel: string
  /** Directory slug of this campaign's audit trail: docs/marketing/google-ads/<slug>/data/<ET
   * date>.json. Unique across the registry, so two campaigns read on the same ET date never
   * write the same file. The retest keeps "retest". */
  auditSlug: string
  /** Build-spec expected placement count per ad group, to VERIFY the live `targeting`
   * diagnostic (informational only, never a rule). Omit when the build has no such spec. */
  adGroupPlacementCounts?: Readonly<Record<string, number>>
  /** ET dates the scheduled morning read runs (docs/routines/bsk-retest-morning-read.md) —
   * used to notice a scheduled read that never ran. */
  morningReadFirstEt: string
  morningReadLastEt: string
}

// Budget and cap come from lib/campaigns.ts (the one campaign definition); only the read
// schedule and the kill-rule constants (spec sections 11-12) live here.
type ReadPlanSettings = Omit<AdsReadPlan, 'campaignId' | 'dailyBudget' | 'hardCap'>
/** A read plan for a campaign registered in lib/campaigns.ts CAMPAIGNS. The budget and the
 * hard cap are taken from that entry and must exist there: a plan with no hard cap would
 * silently arm no kill rule 4. */
export function buildReadPlan(campaignId: string, settings: ReadPlanSettings): AdsReadPlan {
  const flight = campaignById(campaignId)
  if (!flight) throw new Error(`campaign ${campaignId} is not in lib/campaigns.ts CAMPAIGNS`)
  if (flight.dailyBudgetUsd == null || flight.hardCapUsd == null) throw new Error(`campaign ${campaignId} needs dailyBudgetUsd and hardCapUsd in lib/campaigns.ts CAMPAIGNS before it can have a read plan`)
  return { campaignId, dailyBudget: flight.dailyBudgetUsd, hardCap: flight.hardCapUsd, ...settings }
}
/** Kept for external callers, e.g. the scheduled-task helper ~/.claude/scheduled-tasks/bsk-retest-morning-read/release-switchover.ts (line 76: `rules.readPlanFor(rules.RETEST_CAMPAIGN_ID)`); new code must take the campaign from the registry or `--campaign`. */
export const RETEST_CAMPAIGN_ID = '24279250691'
/** THE read-plan registry: one entry per campaign the routine reads (with rules). To start
 * reading a new campaign add its CAMPAIGNS entry and a plan here — see README "Adding a new
 * campaign". Several plans may be live at once; nothing assumes a single current campaign. */
export const ADS_READ_PLANS: Record<string, AdsReadPlan> = {
  '24279250691': buildReadPlan('24279250691', {
    thresholds: [25, 50, 75, 100],
    killRulesFrom: 50,
    placementLeakMaxShare: 0.1,
    ctrFloor: 0.0015,
    approvedPlacements: RETEST_APPROVED_PLACEMENTS,
    reportLabel: 'BSK retest',
    auditSlug: 'retest',
    adGroupPlacementCounts: RETEST_AD_GROUP_PLACEMENT_COUNTS,
    morningReadFirstEt: '2026-09-27',
    morningReadLastEt: '2026-10-03',
  }),
}

/** The read plan for a campaign id, or a throw that lists every registered id. Used for labels
 * and the report page, which only ever see campaigns that already passed readPlanFor. */
export function planOrThrow(campaignId: string, plans: Readonly<Record<string, AdsReadPlan>> = ADS_READ_PLANS): AdsReadPlan {
  const plan = plans[campaignId]
  if (!plan) throw new Error(`no ads read plan for campaign ${campaignId} (registered read plans: ${Object.keys(plans).join(', ') || 'none'})`)
  return plan
}
/** Where a campaign's report header and push text start (its plan's reportLabel). */
export const reportLabelFor = (campaignId: string): string => planOrThrow(campaignId).reportLabel
/** A campaign's audit file for an ET date (its plan's auditSlug). */
export const auditPathFor = (campaignId: string, etDate: string): string => `docs/marketing/google-ads/${planOrThrow(campaignId).auditSlug}/data/${etDate}.json`

/** Which campaign a read means when the CLI gets no --campaign: derived from the registry,
 * never a constant, and never a guess. One rule for the morning read and every post-flight
 * stage: the default is the ONLY registered plan, counting closed campaigns too. No date rule
 * is safe: a morning window or a post-flight due day says nothing about which campaign an
 * unpinned task was written for (a late or forced rerun, or an old task run after the next
 * campaign's window opens, would silently read the wrong campaign). A "not closed" filter is
 * no better: it would hand an old campaign's last post-flight stage (the retest's is in
 * December) to the next campaign the day the old one is marked closed. With two or more plans
 * registered, or none, the read must say which one: every error lists the registered ids and
 * says to pass --campaign. `_todayEt` is unused by the rule; it keeps one call shape for both
 * kinds. */
export function defaultReadCampaignId(
  kind: 'morning' | 'postflight',
  _todayEt: string,
  stage?: PostflightStage,
  plans: Readonly<Record<string, AdsReadPlan>> = ADS_READ_PLANS,
): string {
  const registered = Object.values(plans)
  const listing = registered.map((p) => `${p.campaignId} (morning reads ${p.morningReadFirstEt}..${p.morningReadLastEt})`).join(', ') || 'none registered'
  const refuse = (why: string): never => {
    throw new Error(`${why}; pass --campaign <id> (registered read plans: ${listing})`)
  }
  if (kind === 'postflight' && !stage) throw new Error('a post-flight default needs a stage')
  if (registered.length === 1) return registered[0].campaignId
  const what = kind === 'morning' ? 'the morning read' : `the ${stage} read`
  return refuse(registered.length ? `${registered.length} campaigns have read plans, so ${what} cannot tell which one is meant` : 'no campaign has a read plan')
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
/** The campaign spend metric (lib/metrics/metrics.ts) and /api/ads/readings use this: the
 * store's Google Ads API spend when it holds
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
export const ASK_PATHS = ['/signin-prompt/placement', '/signin-prompt/streak', '/signin-prompt/tutorial', '/promo-first50/shown'] as const
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

/** `/auth/success/<provider>` → 'base' (THE sign-in, one per sign-in); the row that rides
 * alongside it from the new/existing release, `/auth/success/<provider>/<new|existing|unknown>`,
 * → its status; anything else → null. The same exact shapes as lib/campaigns.ts
 * classifyFunnelPath and authSuccessRow (which this wraps): a prefix match would count
 * a new-client sign-in twice. */
export type AuthSuccessKind = 'base' | AuthSuccessStatus
export const authSuccessKind = (path: string): AuthSuccessKind | null => authSuccessRow(path)

export interface TaggedRow {
  hourStartMs: number
  path: string
  visitor: string
  count: number
  /** Row-exact side of the signed-out upsell fix (SQL `ts >= UPSELL_SIGNEDOUT_FIX_AT`, like the
   * install fix's `pf`); absent (recorded fixtures) = decided by the row's hour bucket. */
  postUpsellFix?: boolean
}
/** Which side of a segment boundary a tagged row is on: the SQL flag when the query carried
 * one (exact at the instant), else its hour bucket (the bucket containing the instant is
 * post-fix). */
export function isPostBoundary(r: TaggedRow, boundaryMs: number): boolean {
  return r.postUpsellFix ?? r.hourStartMs >= Math.floor(boundaryMs / 3_600_000) * 3_600_000
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
  /** Sign-ins: the base `/auth/success/<provider>` rows only (one per sign-in). */
  authSuccess: number
  /** The status rows that ride alongside (three-segment `/auth/success/<provider>/<status>`),
   * plus `unsplit` = sign-ins with no status row (before the release, or an old client) =
   * max(0, authSuccess − new − existing − unknown). */
  authSuccessSplit: Record<AuthSuccessStatus | 'unsplit', number>
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
    authSuccessSplit: { new: 0, existing: 0, unknown: 0, unsplit: 0 },
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
    // The base row only counts a sign-in (lib/campaigns.ts authSuccessRow, the one auth-success
    // matcher): v1.95.5 sends the new/existing row ALONGSIDE the base row for the same sign-in,
    // so it only feeds the split; counting it too would double every sign-in from go-live on.
    const auth = authSuccessRow(r.path)
    if (auth === 'base') s.authSuccess += r.count
    else if (auth) s.authSuccessSplit[auth] += r.count
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
  const sp = s.authSuccessSplit
  sp.unsplit = Math.max(0, s.authSuccess - sp.new - sp.existing - sp.unknown)
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

/** Site-wide asks SHOWN — the same shown-ask set as ASK_PATHS (sign-in placement / streak /
 * tutorial and the first-50 promo that replaces the dialog), exact paths — in hour buckets
 * overlapping [fromMs, toMs): the untagged cross-check for kill rule 3, since the campaign tag
 * only rides beacons for 30 minutes. `paths` narrows the set (siteTutorialAsksShown). */
export function siteSigninShown(rows: readonly HourPathCount[], fromMs: number, toMs: number, paths: readonly string[] = ASK_PATHS): number {
  const fromHour = Math.floor(fromMs / 3_600_000) * 3_600_000
  let n = 0
  for (const r of rows) {
    if (r.hourStartMs < fromHour || r.hourStartMs >= toMs) continue
    if (paths.includes(r.path)) n += r.count
  }
  return n
}
/** The app's first-session ask beacon. Until it has a row site-wide, first-session asks are
 * unobservable and rule 3 may downgrade to WATCH; once it has one, rule 3 reads tagged asks only. */
export const FIRST_SESSION_ASK_PATH = '/signin-prompt/tutorial'
export function siteTutorialAsksShown(rows: readonly HourPathCount[], fromMs: number, toMs: number): number {
  return siteSigninShown(rows, fromMs, toMs, [FIRST_SESSION_ASK_PATH])
}

// ── First-session funnel (informational only; never a kill rule) ─────────────────────────
// Where ad arrivals drop between opening /game and finishing a puzzle. Tagged counts (the
// campaign tag, as summarizeTaggedRows reads it) with site-wide web counts over the same
// window alongside. A beacon FAMILY (paths that ship in one app release) with no rows at all,
// site-wide or tagged, is "not yet tracked" (the release is not live), never a 0% step; once
// any path in the family has a row, a sibling with none is a real 0. Every figure is a row count: there is
// no visitor id to join steps on, so a "vs parent" ratio is rows over rows, not a per-visitor
// conversion rate, and it is MIN_COHORT-gated like every other rate.
export const FIRST_SESSION_STEPS = ['arrivals', 'gameView', 'tourStart', 'tourComplete', 'tourSkip', 'firstMove', 'gameComplete'] as const
export type FirstSessionStep = (typeof FIRST_SESSION_STEPS)[number]
export const FIRST_SESSION_STEP_LABELS: Record<FirstSessionStep, string> = {
  arrivals: 'arrivals (d0 devices)',
  gameView: 'game views',
  tourStart: 'tour start',
  tourComplete: 'tour complete',
  tourSkip: 'tour skip',
  firstMove: 'first move',
  gameComplete: 'game complete',
}
/** Each step's parent for the row ratio; an untracked parent falls back to its own parent.
 * Nothing divides by game views (or divides game views by arrivals): /game rows are page views
 * (several per visit) against once-per-event beacons, the mixed-unit ratio lib/campaigns.ts
 * VALID_FUNNEL_RATE_STEPS rules out. So tour start and first move carry no ratio. */
export const FIRST_SESSION_PARENT: Record<FirstSessionStep, FirstSessionStep | null> = {
  arrivals: null,
  gameView: null,
  tourStart: null,
  tourComplete: 'tourStart',
  tourSkip: 'tourStart',
  firstMove: null,
  gameComplete: 'firstMove',
}
/** Steps whose beacons ship in one app release with the abandon buckets: tracked together. */
export const FIRST_SESSION_RELEASE_STEPS = ['tourStart', 'tourComplete', 'tourSkip', 'firstMove'] as const satisfies readonly FirstSessionStep[]
export const ABANDON_BUCKETS = ['0', '1-25', '26-50', '51-75', '76-99'] as const
export type AbandonBucket = (typeof ABANDON_BUCKETS)[number]
export const WELCOME_EVENTS = ['shown', 'daily', 'leaderboard', 'dismiss'] as const
export type WelcomeEvent = (typeof WELCOME_EVENTS)[number]

const TOUR_PATHS: Partial<Record<FirstSessionStep, string>> = { tourStart: '/tour/start', tourComplete: '/tour/complete', tourSkip: '/tour/skip', firstMove: '/game/first-move' }
const ABANDON_PREFIX = '/game/abandon/'
const WELCOME_PREFIX = '/welcome-signed-in/'

/** The first-session bucket a path counts in, or null. Exact paths only (a trailing slash or
 * an unknown abandon bucket / welcome action is not guessed at). */
export type FirstSessionBucket =
  | { kind: 'step'; step: Exclude<FirstSessionStep, 'arrivals'> }
  | { kind: 'abandon'; bucket: AbandonBucket }
  | { kind: 'welcome'; event: WelcomeEvent }
  | { kind: 'ask'; tutorial: boolean }
  | { kind: 'arrival'; uc: string }
export function firstSessionBucket(path: string): FirstSessionBucket | null {
  if (path === '/game') return { kind: 'step', step: 'gameView' }
  // Arrivals: /return/<uc>/d0, sent once per device on its first tagged visit (best-sudoku
  // src/services/campaignReturns.ts) — devices, not page rows. Attributed by the path's own uc.
  const ret = parseReturnPath(path)
  if (ret) return ret.bucket === 'd0' ? { kind: 'arrival', uc: ret.uc } : null
  if (path.startsWith('/game/complete/')) return { kind: 'step', step: 'gameComplete' } // lib/campaigns.ts classifyFunnelPath's 'completed'
  for (const [step, p] of Object.entries(TOUR_PATHS)) if (path === p) return { kind: 'step', step: step as Exclude<FirstSessionStep, 'arrivals'> }
  if (path.startsWith(ABANDON_PREFIX)) {
    const b = path.slice(ABANDON_PREFIX.length)
    return (ABANDON_BUCKETS as readonly string[]).includes(b) ? { kind: 'abandon', bucket: b as AbandonBucket } : null
  }
  if (path.startsWith(WELCOME_PREFIX)) {
    const e = path.slice(WELCOME_PREFIX.length)
    return (WELCOME_EVENTS as readonly string[]).includes(e) ? { kind: 'welcome', event: e as WelcomeEvent } : null
  }
  if ((ASK_PATHS as readonly string[]).includes(path)) return { kind: 'ask', tutorial: path === '/signin-prompt/tutorial' }
  return null
}

/** Raw first-session tallies, one side (tagged or site-wide). */
export interface FirstSessionTally {
  steps: Record<FirstSessionStep, number>
  abandon: Record<AbandonBucket, number>
  welcome: Record<WelcomeEvent, number>
  asks: number
  asksTutorial: number
  /** true when the tagged arrivals (d0) read failed: arrivals is unknown, not 0. */
  arrivalsUnread?: boolean
}
/** One site-wide web row of the first-session read (scripts/ads-reads/beacon.ts
 * siteFirstSessionQuery): a first-session path with its row count. */
export interface FirstSessionRowSite {
  path: string
  count: number
}
/** Tagged arrivals: /return/<uc>/d0 rows for the campaign's own tags (scripts/ads-reads/beacon.ts
 * returnArrivalsQuery), with the campaign's uc values to re-check each path against. */
export interface FirstSessionArrivals {
  rows: readonly { path: string; count: number }[]
  ucValues: readonly string[]
}
export function emptyFirstSessionTally(): FirstSessionTally {
  const zero = <K extends string>(ks: readonly K[]) => Object.fromEntries(ks.map((k) => [k, 0])) as Record<K, number>
  return { steps: zero(FIRST_SESSION_STEPS), abandon: zero(ABANDON_BUCKETS), welcome: zero(WELCOME_EVENTS), asks: 0, asksTutorial: 0 }
}
function tally(t: FirstSessionTally, path: string, count: number): void {
  const b = firstSessionBucket(path)
  if (!b) return
  if (b.kind === 'step') t.steps[b.step] += count
  else if (b.kind === 'abandon') t.abandon[b.bucket] += count
  else if (b.kind === 'welcome') t.welcome[b.event] += count
  else if (b.kind === 'arrival') t.steps.arrivals += count
  else {
    t.asks += count
    if (b.tutorial) t.asksTutorial += count
  }
}
/** Tagged side: every step from the campaign-tagged rows; arrivals = /return/<uc>/d0 rows for
 * the campaign's uc values (one per device; a d0 row can land in a later, untagged page load,
 * so it is attributed by the path's uc, never by the row's tag). `arrivals` null = not read. */
export function tallyTaggedFirstSession(rows: readonly TaggedRow[], arrivals: FirstSessionArrivals | null): FirstSessionTally {
  const t = emptyFirstSessionTally()
  for (const r of rows) if (firstSessionBucket(r.path)?.kind !== 'arrival') tally(t, r.path, r.count)
  if (!arrivals) t.arrivalsUnread = true
  else
    for (const r of arrivals.rows) {
      const b = firstSessionBucket(r.path)
      if (b?.kind === 'arrival' && arrivals.ucValues.includes(b.uc)) t.steps.arrivals += r.count
    }
  return t
}
/** Site-wide side: arrivals = every /return/<any uc>/d0 row on the web site in the window. */
export function tallySiteFirstSession(rows: readonly FirstSessionRowSite[]): FirstSessionTally {
  const t = emptyFirstSessionTally()
  for (const r of rows) tally(t, r.path, r.count)
  return t
}

/** One figure: the tagged count (null = not read; only arrivals can be), the site-wide count
 * beside it (null = site-wide not read), and whether the path is tracked at all (null =
 * unknown, the site-wide read is missing). */
export interface FirstSessionFigure {
  tagged: number | null
  site: number | null
  tracked: boolean | null
}
export interface FirstSessionStepFigure extends FirstSessionFigure {
  /** The step's tagged rows over its nearest tracked ancestor's (rows over rows, gated);
   * null for the first step or an untracked step. */
  vsParent: (GatedRate & { parent: FirstSessionStep }) | null
}
export interface FirstSessionFunnel {
  steps: Record<FirstSessionStep, FirstSessionStepFigure>
  abandon: Record<AbandonBucket, FirstSessionFigure>
  welcome: Record<WelcomeEvent, FirstSessionFigure>
  asks: FirstSessionFigure
  asksTutorial: FirstSessionFigure
  /** Whether the site-wide side was read (false: every `site` is null, `tracked` unknown). */
  siteRead: boolean
}
// Tracked once either side has a row: a tagged row proves the release is live even if the
// site-wide read (web only) has none. Families then widen it (trackFamily).
const figure = (tagged: number | null, site: number | null): FirstSessionFigure => ({ tagged, site, tracked: (tagged ?? 0) > 0 || (site ?? 0) > 0 ? true : site == null ? null : false })
/** A family ships in one release: once any member is tracked, every member is (a missing
 * sibling is a real 0, not an instrumentation gap). */
function trackFamily(members: FirstSessionFigure[]): void {
  if (members.some((m) => m.tracked === true)) for (const m of members) m.tracked = true
}

/** Pairs the tagged tally with the site-wide one. `site` null = the site-wide read failed.
 * Families: the tour / first-move / abandon release; the welcome-signed-in card; and the
 * tutorial ask (its own beacon). */
export function buildFirstSessionFunnel(tagged: FirstSessionTally, site: FirstSessionTally | null): FirstSessionFunnel {
  const steps = {} as Record<FirstSessionStep, FirstSessionStepFigure>
  for (const k of FIRST_SESSION_STEPS) steps[k] = { ...figure(k === 'arrivals' && tagged.arrivalsUnread ? null : tagged.steps[k], site ? site.steps[k] : null), vsParent: null }
  const map = <K extends string>(ks: readonly K[], t: Record<K, number>, s: Record<K, number> | null) =>
    Object.fromEntries(ks.map((k) => [k, figure(t[k], s ? s[k] : null)])) as Record<K, FirstSessionFigure>
  const abandon = map(ABANDON_BUCKETS, tagged.abandon, site?.abandon ?? null)
  const welcome = map(WELCOME_EVENTS, tagged.welcome, site?.welcome ?? null)
  trackFamily([...FIRST_SESSION_RELEASE_STEPS.map((k) => steps[k]), ...ABANDON_BUCKETS.map((b) => abandon[b])])
  trackFamily(WELCOME_EVENTS.map((e) => welcome[e]))
  // An unknown `tracked` (no site-wide read) still gets a ratio: only a known-untracked step is skipped.
  const usable = (k: FirstSessionStep) => steps[k].tracked !== false
  for (const k of FIRST_SESSION_STEPS) {
    if (!usable(k)) continue
    let p = FIRST_SESSION_PARENT[k]
    while (p && !usable(p)) p = FIRST_SESSION_PARENT[p]
    if (p) steps[k].vsParent = { ...gateRate(tagged.steps[k], tagged.steps[p]), parent: p } // arrivals (the only nullable) is never in a ratio
  }
  return {
    steps,
    abandon,
    welcome,
    asks: figure(tagged.asks, site ? site.asks : null),
    asksTutorial: figure(tagged.asksTutorial, site ? site.asksTutorial : null),
    siteRead: site != null,
  }
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
// Formatters are built on first use, not at module load (lib/popupEvents.ts etDateFromMs says
// why); same options, same output.
let etHourLabelFmt: Intl.DateTimeFormat | null = null
/** "YYYY-MM-DD HH:00 ET" — hour precision is plenty for a first-seen marker. */
export function etHourLabel(ms: number): string {
  etHourLabelFmt ??= new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  })
  const p = Object.fromEntries(etHourLabelFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
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
// RETIRED 2026-09-27 (coordinator decision: fold the 23:15 ET backstop into a single daily
// morning read): this module used to export HEALTH_QUIET_WINDOW_ET ([1, 12), ET hours) and
// releaseHealthGate(), which refused to evaluate release health at all between 01:00 and
// 12:00 ET so an 08:00 morning run would defer to a separate 23:15 ET backstop entry. With
// only one daily run left, that clock gate does not protect data quality — parent/child
// maturity is already enforced independently by the parentAgeHours cutoff in releaseHealth()
// (scripts/ads-reads/read.ts), which keys off event timestamps, not the clock the run happens
// to execute at — it would just silently suppress release health forever at whatever single
// hour the run is scheduled for. The run time itself moved once (08:00 -> 06:00) during this
// same change; a clock-based gate would need re-tuning every time it moves again, and a miss
// would be a silent, permanent loss of release-health alerting during a live $100-capped
// flight. Removed rather than re-tuned. etHourOf() stays: a general ET utility, still
// exercised by src/lib/lazyFormatters.test.ts and available for reporting.
let etHourOfFmt: Intl.DateTimeFormat | null = null
export function etHourOf(ms: number): number {
  etHourOfFmt ??= new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' })
  return Number(etHourOfFmt.format(new Date(ms))) % 24
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
/** CORRECTED 2026-09-26 (verified against best-sudoku source and confirmed by the release
 * coordinator): the earlier "useUpsellPrompt returns early when uid is null is a KNOWN BUG"
 * note was WRONG. A signed-out visitor is never walled by design — the trial clock only
 * starts once someone plays a game while signed in (best-sudoku functions/src/trial-tracking.ts
 * onCreateGame; locally stored games upload after sign-in via recordsPushUp.ts). The planned
 * "fix" was CANCELLED, not deferred. Do not resurrect the bug framing. */
export const UPSELL_SIGNEDOUT_EXPECTED_NOTE =
  'Upsell near-zero for signed-out campaign traffic is EXPECTED BY DESIGN, not broken instrumentation: signed-out visitors are never shown the paywall, and the trial starts only once a player signs in and plays a game. Upsell counts only become meaningful for signed-in players.'
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
const AUTH_NEW_EXISTING_LIVE_AT_LABEL = AUTH_NEW_EXISTING_LIVE_AT == null ? null : etMinuteLabel(AUTH_NEW_EXISTING_LIVE_AT)
export const SIGNUP_PROXY_NOTE =
  AUTH_NEW_EXISTING_LIVE_AT_LABEL == null
    ? 'Sign-ups are an UPPER bound, "at most N campaign sign-ups" = min(tagged auth successes, new prod accounts sitewide in the flight window): /auth/success also fires for returning sign-ins and the account count is not campaign-attributed. Counts only, never matched to anyone.'
    : `Sign-ups before ${AUTH_NEW_EXISTING_LIVE_AT_LABEL} are an UPPER bound, "at most N campaign sign-ups" = min(tagged auth successes, new prod accounts sitewide in the flight window): /auth/success also fires for returning sign-ins and the account count is not campaign-attributed. From ${AUTH_NEW_EXISTING_LIVE_AT_LABEL} on, tagged /auth/success/<provider>/new rows count sign-ups EXACTLY, capped at the window's new accounts; a report spanning both sides shows an "at most X + exactly Y" split. Counts only, never matched to anyone.`
/** Post-flight recommendation (a beacon change, so only after the 2026-10-02 freeze). v1.95.5
 * shipped the beacon early (AUTH_NEW_EXISTING_LIVE_AT), so the post-flight read adds this only
 * while AUTH_NEW_EXISTING_LIVE_AT is null, and sign-ups are counted exactly from the live
 * instant on (campaignSignUps). */
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
      // Real beacons send /popup-outcome/first50-offer/* (lib/popupEvents.ts
      // POPUP_OUTCOME_NAME_TO_FAMILY — 'promo-first50' is only a tolerated alias); both
      // names land in `outcomes('promo-first50')` below.
      childLabel: '/popup-outcome/first50-offer/* (or /promo-first50/*)',
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
export type RuleStatus = 'trip' | 'watch' | 'clear' | 'not-armed' | 'no-data'
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
  /** Tagged beacon counts — null when the beacon read failed. `siteSigninShown` = site-wide
   * (untagged) asks shown in the same window (siteSigninShown); null/absent = the site read
   * failed. `siteTutorialAsks` = site-wide FIRST_SESSION_ASK_PATH rows (siteTutorialAsksShown);
   * > 0 means first-session asks are observable, so rule 3 reads tagged asks only. */
  beacon: { asks: number; taggedArrivals: number; siteSigninShown?: number | null; siteTutorialAsks?: number | null } | null
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
export function placementOutsideShare(p: { campaignCost: number; approvedCost: number; itemizedCost: number }): {
  share: number
  offList: number
  unitemized: number
  outsideMicros: number
  denomMicros: number
} {
  // Integer micros throughout (review L1): no floating-point residue can turn an exact 10.0%
  // into 10.000000001% and trip the rule.
  const m = (usd: number) => Math.round(usd * 1_000_000)
  const offListMicros = Math.max(0, m(p.itemizedCost) - m(p.approvedCost))
  const unitemizedMicros = Math.max(0, m(p.campaignCost) - m(p.itemizedCost))
  const denomMicros = Math.max(m(p.campaignCost), m(p.itemizedCost))
  const outsideMicros = offListMicros + unitemizedMicros
  return {
    share: denomMicros > 0 ? outsideMicros / denomMicros : 0,
    offList: offListMicros / 1_000_000,
    unitemized: unitemizedMicros / 1_000_000,
    outsideMicros,
    denomMicros,
  }
}
/** MORE than `maxShare` outside, decided in integers (parts per million) — exactly at the line
 * does not trip. */
export function placementShareOver(outsideMicros: number, denomMicros: number, maxShare: number): boolean {
  return denomMicros > 0 && outsideMicros * 1_000_000 > denomMicros * Math.round(maxShare * 1_000_000)
}
/** The 9-11% band around the 10% line (review L2): given the denominator edge above, a share
 * in it deserves a look at the placement view whatever the rule says. */
export const PLACEMENT_BORDERLINE_BAND: readonly [number, number] = [0.09, 0.11]
export function isPlacementBorderline(share: number | null | undefined): boolean {
  return share != null && share >= PLACEMENT_BORDERLINE_BAND[0] && share <= PLACEMENT_BORDERLINE_BAND[1]
}
export const PLACEMENT_BORDERLINE_NOTE = 'borderline, check the placement view'

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
      const { share, offList: itemizedOutside, unitemized, outsideMicros, denomMicros } = placementOutsideShare(i.placements)
      const trip = placementShareOver(outsideMicros, denomMicros, plan.placementLeakMaxShare)
      const caveat = trip && unitemized > itemizedOutside ? ' Most of it is un-itemized; Google often itemizes it to approved placements within ~2 days, so confirm before pausing.' : ''
      const borderline = isPlacementBorderline(share) ? ` BORDERLINE (9-11%): ${PLACEMENT_BORDERLINE_NOTE}.` : ''
      rules.push({
        ...base,
        status: trip ? 'trip' : 'clear',
        value: share,
        detail: `${pctStr(share)} outside (${usd(itemizedOutside)} itemized off-list + ${usd(unitemized)} un-itemized; campaign ${usd(campaignCost)}, itemized ${usd(itemizedCost)}).${caveat}${borderline}`,
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

  // 3. Funnel reach — zero sign-in asks from tagged arrivals. The tag rides beacons for only
  // 30 minutes and the streak prompt fires in later sessions, so while first-session asks are
  // unobservable (FIRST_SESSION_ASK_PATH has no row site-wide), zero tagged asks from tagged
  // arrivals with asks still showing site-wide is WATCH, not TRIP. The downgrade expires by
  // itself: once the tutorial ask has a row site-wide, a working first session produces tagged
  // asks directly, so rule 3 reads tagged asks only. Zero tagged arrivals is always TRIP.
  {
    const base = { id: 'funnel-reach' as const, label: 'zero sign-in asks from tagged arrivals', limit: 0 }
    if (!armed) rules.push({ ...base, status: 'not-armed', value: null, detail: `armed at ${usd(plan.killRulesFrom)}` })
    else if (!i.beacon) rules.push({ ...base, status: 'no-data', value: null, detail: 'beacon read returned no data' })
    else {
      const zeroArrivals = i.beacon.taggedArrivals === 0 ? ' Zero tagged arrivals too: check the landing URL and tagging.' : ''
      const site = i.beacon.siteSigninShown ?? null
      const tutorial = i.beacon.siteTutorialAsks ?? null
      const taggedOnly = tutorial != null && tutorial > 0
      const mode = taggedOnly
        ? ` Mode: tagged asks only (${FIRST_SESSION_ASK_PATH} shown ${tutorial} times site-wide, so first-session asks are observable).`
        : ` Mode: site-wide fallback (${FIRST_SESSION_ASK_PATH} ${tutorial == null ? 'not read' : 'has no rows'} site-wide, so first-session asks are not yet observable).`
      const watch = !taggedOnly && i.beacon.asks === 0 && i.beacon.taggedArrivals > 0 && site != null && site > 0
      const siteLine = ` Site-wide asks shown: ${site ?? 'unavailable'}.${watch ? ' Tagged attribution expires 30 min after the ad click, so later-session prompts are not counted as tagged asks.' : ''}`
      rules.push({
        ...base,
        status: i.beacon.asks > 0 ? 'clear' : watch ? 'watch' : 'trip',
        value: i.beacon.asks,
        detail: `${i.beacon.asks} asks from ${i.beacon.taggedArrivals} tagged arrivals.${siteLine}${mode}${zeroArrivals}`,
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
  /** Campaign sign-ups: an UPPER bound (signUpsAtMost) unless `exact` (campaignSignUps). */
  signUpsAtMost: number
  asks: number
  accepts: number
  /** true when the count is exact (every sign-up came from a tagged /auth/success/…/new row). */
  exact?: boolean
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
  if (i.exact && i.signUpsAtMost >= 2) {
    return {
      row: 'two-plus',
      reading: `${i.signUpsAtMost} campaign sign-ups (exact: tagged /auth/success/<provider>/new): the funnel converts paid display traffic at roughly 1% or better.`,
      next: 'Compute cost per sign-up. Hold on scaling until the day-15+ follow-up reports. Run O3 (Search) at the same cap against the same funnel to compare intent. Do not scale display until a sign-up shows a trial-to-purchase path measured at day 15 or later.',
    }
  }
  if (i.exact && i.signUpsAtMost === 1) {
    return {
      row: 'one',
      reading: '1 campaign sign-up (exact). Inconclusive at this base.',
      next: "Hold. Do not scale; carry the funnel reads and that sign-up's day-15+ outcome into the next decision.",
    }
  }
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

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
/** "YYYY-MM-DD HH:MM ET". Plain ET arithmetic (lib/etTime.ts), not Intl: it runs at module
 * load (SIGNUP_PROXY_NOTE), and this module is in the gss-stats-sync Worker's bundle, whose cold
 * start must build no Intl formatter (docs/adr/0001-ads-read-store.md; workerNoIntlAtLoad.test.ts).
 * Byte-identical to the former en-CA { year, month, day: '2-digit', hour, minute: '2-digit',
 * hourCycle: 'h23' } parts (lazyFormatters.test.ts compares them). */
export function etMinuteLabel(ms: number): string {
  const et = new Date(ms + etOffsetHours(ms) * 3_600_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${et.getUTCFullYear()}-${pad(et.getUTCMonth() + 1)}-${pad(et.getUTCDate())} ${pad(et.getUTCHours())}:${pad(et.getUTCMinutes())} ET`
}

export interface SignUpCount {
  /** What the decision table uses: exact when `exact`, else an upper bound. */
  count: number
  exact: boolean
  /** The "at most" part over the sign-ins that may be new (no status row, or status
   * `unknown`): min(maybeNew, max(0, windowNew − exactNew)); null when the split is not live. */
  bounded: number | null
  /** Sign-ups from tagged /auth/success/<provider>/new rows, capped at the window's new
   * accounts (null before the split). */
  exactNew: number | null
  /** The /new rows exceeded the window's new accounts (a repeated beacon): capped, so the
   * count is an upper bound, not exact. */
  newCapped: boolean
  label: string
}
/** Campaign sign-ups. Sign-ins are the BASE rows `/auth/success/<provider>` (one per sign-in);
 * from the new/existing release a status row `/auth/success/<provider>/<new|existing|unknown>`
 * rides ALONGSIDE each one (never instead), so it is never added to the sign-in count.
 *
 * Until AUTH_NEW_EXISTING_LIVE_AT is set: "at most N" = min(sign-ins, windowNew). Once it is:
 *
 *   exactNew = min(/new rows, windowNew)
 *   maybeNew = (sign-ins with no status row: before the release or an old client) + /unknown rows
 *   count    = min(maybeNew, max(0, windowNew − exactNew)) + exactNew
 *
 * — `/existing` rows (returning sign-ins) never count; `unknown` (isNewUser unavailable) may be
 * new, so it joins the "at most" part, which can only use the new accounts the exact rows have
 * not already claimed. The /new count cannot be de-duplicated per person (the beacon stores
 * anonymous hourly counts and nothing is ever joined to an individual), so a repeated /new
 * beacon is bounded by the window's new accounts instead; the count is "exact" only when every
 * sign-in has a new/existing answer and no cap applied. */
export function campaignSignUps(
  s: Pick<TaggedSummary, 'authSuccess' | 'authSuccessSplit'>,
  windowNewAccounts: number | null,
  liveAtMs: number | null = AUTH_NEW_EXISTING_LIVE_AT,
): SignUpCount {
  if (liveAtMs == null) {
    const n = signUpsAtMost(s.authSuccess, windowNewAccounts)
    return { count: n, exact: false, bounded: n, exactNew: null, newCapped: false, label: signUpsAtMostLabel(n, s.authSuccess, windowNewAccounts) }
  }
  const sp = s.authSuccessSplit
  const noStatus = Math.max(0, s.authSuccess - sp.new - sp.existing - sp.unknown)
  const maybeNew = noStatus + sp.unknown
  const rawNew = sp.new
  const exactNew = windowNewAccounts == null ? rawNew : Math.min(rawNew, windowNewAccounts)
  const newCapped = exactNew < rawNew
  const room = windowNewAccounts == null ? maybeNew : Math.max(0, windowNewAccounts - exactNew)
  const bounded = Math.min(maybeNew, room)
  const count = bounded + exactNew
  const since = etMinuteLabel(liveAtMs)
  const w = windowNewAccounts ?? 'not read'
  if (maybeNew === 0 && !newCapped) {
    return { count, exact: true, bounded: 0, exactNew, newCapped, label: `${plural(count, 'campaign sign-up')} (exact: tagged /auth/success/<provider>/new since ${since})` }
  }
  if (maybeNew === 0) {
    return { count, exact: false, bounded: 0, exactNew, newCapped, label: `at most ${plural(count, 'campaign sign-up')} (tagged /auth/success/<provider>/new rows ${rawNew}, capped at the ${w} new prod accounts sitewide in the window)` }
  }
  return {
    count,
    exact: false,
    bounded,
    exactNew,
    newCapped,
    label: `at most ${plural(count, 'campaign sign-up')}: at most ${bounded} of the ${plural(maybeNew, 'sign-in')} that may be new (${noStatus} without a new/existing answer — before ${since} or an old client — and ${sp.unknown} unknown; new prod accounts sitewide in the window ${w}, less the ${exactNew} counted as new) + ${newCapped ? `at most ${exactNew}` : `exactly ${exactNew}`} new (tagged /auth/success/<provider>/new${newCapped ? `, ${rawNew} rows capped at the window's new accounts` : ''})`,
  }
}

// ── Funnel segments: a behaviour change mid-flight splits the read (spec section 14a) ─────
export interface SegmentFigures {
  /** Tagged rows in hour buckets [fromMs, toMs). */
  fromMs: number
  toMs: number
  /** Closed-day spend strictly on this side of the boundary day (the boundary day itself is
   * reported apart: Ads spend is per ET day and cannot be split at an instant). */
  spend: number
  spendDays: number
  taggedArrivals: number
  asks: number
  accepts: number
  authSuccess: number
  signUps: SignUpCount
  upsell: { shown: number; accept: number; dismiss: number }
}
export interface FunnelSegments {
  boundaryMs: number
  boundaryLabel: string
  /** ET date the boundary falls on; its spend straddles the two segments. */
  boundaryDay: string
  boundaryDaySpend: number | null
  pre: SegmentFigures
  post: SegmentFigures
  note: string
}
export const SEGMENT_NOTE =
  'A behaviour change shipped mid-flight (the signed-out upsell fix), so per spec section 14a the flight reads as two separate short tests: compare each segment on its own, never the totals. Beacon rows are split at the exact instant of the fix; the fix day\'s spend is shown apart because Ads spend is per ET day.'

/** For the funnel card's upsell segment and the flight-day chart's day label (lib/metrics
 * scope.ts and instrumentation.ts, lib/charts.ts): where the upsell-fix boundary falls
 * in a campaign's flight, and the tagged upsell shown/accept/dismiss on each side (split at the
 * instant by the query's flag — isPostBoundary). null when unset or outside the flight. */
export interface CampaignSegmentMarker {
  boundaryMs: number
  boundaryLabel: string
  boundaryDate: string
  upsell: { pre: { shown: number; accept: number; dismiss: number }; post: { shown: number; accept: number; dismiss: number } }
}
export function campaignSegmentMarker(
  c: Pick<CampaignFlight, 'flightStart' | 'flightEnd'>,
  rows: readonly TaggedRow[],
  boundaryMs: number | null = UPSELL_SIGNEDOUT_FIX_AT,
): CampaignSegmentMarker | null {
  if (boundaryMs == null || !c.flightStart) return null
  const date = etDateFromMs(boundaryMs)
  if (date < c.flightStart || date > c.flightEnd) return null
  return {
    boundaryMs,
    boundaryLabel: etMinuteLabel(boundaryMs),
    boundaryDate: date,
    upsell: {
      pre: { ...summarizeTaggedRows(rows.filter((r) => !isPostBoundary(r, boundaryMs))).upsell },
      post: { ...summarizeTaggedRows(rows.filter((r) => isPostBoundary(r, boundaryMs))).upsell },
    },
  }
}

/** Splits a read at a boundary instant: tagged rows at the exact instant (the query's
 * postUpsellFix flag; a row without one falls back to its hour bucket), closed-day spend by ET
 * day (the boundary day apart). null when the boundary is unset or outside [startMs, endMs). */
export function splitAtBoundary(i: {
  rows: readonly TaggedRow[]
  stored: StoredSpend | null
  throughEt: string | null
  startMs: number
  endMs: number
  windowNewAccounts: number | null
  boundaryMs?: number | null
  authLiveAtMs?: number | null
}): FunnelSegments | null {
  const b = i.boundaryMs === undefined ? UPSELL_SIGNEDOUT_FIX_AT : i.boundaryMs
  if (b == null || b <= i.startMs || b >= i.endMs) return null
  const boundaryDay = etDateFromMs(b)
  const days = Object.entries(i.stored?.days ?? {}).filter(([d]) => i.throughEt != null && d <= i.throughEt)
  const spendOf = (pred: (d: string) => boolean) => {
    const sel = days.filter(([d]) => pred(d))
    return { spend: round2(microsToDollars(sel.reduce((a, [, v]) => a + v.costMicros, 0))), spendDays: sel.length }
  }
  const figures = (fromMs: number, toMs: number, side: 'pre' | 'post'): SegmentFigures => {
    // The rows are already window-filtered (SQL attribution clause): split only at the boundary.
    const s = summarizeTaggedRows(i.rows.filter((r) => isPostBoundary(r, b) === (side === 'post')))
    return {
      fromMs,
      toMs,
      ...spendOf((d) => (side === 'pre' ? d < boundaryDay : d > boundaryDay)),
      taggedArrivals: s.taggedArrivals,
      asks: s.asks.total,
      accepts: s.accepts.total,
      authSuccess: s.authSuccess,
      signUps: campaignSignUps(s, i.windowNewAccounts, i.authLiveAtMs === undefined ? AUTH_NEW_EXISTING_LIVE_AT : i.authLiveAtMs),
      upsell: { ...s.upsell },
    }
  }
  const dayRow = days.find(([d]) => d === boundaryDay)
  return {
    boundaryMs: b,
    boundaryLabel: etMinuteLabel(b),
    boundaryDay,
    boundaryDaySpend: dayRow ? round2(microsToDollars(dayRow[1].costMicros)) : null,
    pre: figures(i.startMs, b, 'pre'),
    post: figures(b, i.endMs, 'post'),
    note: SEGMENT_NOTE,
  }
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
  /** The de-dup key within (campaign, etDate) — readingEntryKind(). Derived when absent (rows
   * written before migration 0003). */
  entryKind?: string
}
export interface ReadingsLog {
  v: 1
  campaignId: string
  readings: ReadingRecord[]
}

// ── Readings de-dup (migration 0003: UNIQUE (campaign_id, et_date, entry_kind)) ──────────
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
const ALERT_NOTE_RE = /^ALERT ([^:]+):/

/** What a reading IS, for de-dup within one campaign and ET day: the entry (`morning`,
 * `backstop`, `threshold-50`, `postflight-wrapup`) plus the facts that make a same-day rerun
 * worth a second row: `+incomplete`, `+pause` (a pause proposal), `+alert-<pair>` (a
 * release-health alert). Deterministic from the stored fields, so rows written before the
 * column existed get the same key. */
export function readingEntryKind(rec: Pick<ReadingRecord, 'kind' | 'stage' | 'thresholds' | 'complete' | 'proposal' | 'notes'>): string {
  const base =
    rec.kind === 'daily'
      ? 'morning'
      : rec.kind === 'health'
        ? 'backstop'
        : rec.kind === 'threshold'
          ? `threshold-${[...rec.thresholds].sort((a, b) => a - b).map((t) => Math.round(t)).join('-') || 'none'}`
          : `postflight-${slug(rec.stage ?? '') || 'unknown'}`
  const q: string[] = []
  if (!rec.complete) q.push('incomplete')
  if (rec.proposal === 'PROPOSE PAUSE') q.push('pause')
  if (rec.kind === 'health') {
    const alerts = [...new Set(rec.notes.map((n) => ALERT_NOTE_RE.exec(n)?.[1]).filter((x): x is string => !!x).map(slug))].sort()
    for (const a of alerts) q.push(`alert-${a}`)
  }
  return [base, ...q].join('+').slice(0, 160)
}
export const entryBase = (entryKind: string): string => entryKind.split('+')[0]
const entryComplete = (entryKind: string): boolean => !entryKind.split('+').includes('incomplete')

export interface ReadingAppendPlan {
  append: ReadingRecord[]
  /** Same-day reruns that carry nothing new: not written, and never pushed again. */
  skip: { record: ReadingRecord; reason: string }[]
}
/** Decides which records a run may append, given the rows already stored for the same
 * campaign and ET day. A record is skipped when (a) the same entry kind is already stored (the
 * UNIQUE index would ignore it anyway), or (b) it is incomplete and a complete read of the same
 * entry is already stored (a failed rerun adds nothing). Anything else — a first read, a
 * complete retry of an incomplete one, a newly proposed pause, a new alert — is appended. */
export function planReadingAppends(records: readonly ReadingRecord[], storedToday: readonly ReadingRecord[]): ReadingAppendPlan {
  const plan: ReadingAppendPlan = { append: [], skip: [] }
  const seen = new Map<string, string[]>() // "<campaign>|<etDate>" -> entry kinds
  const kindsFor = (r: ReadingRecord) => {
    const k = `${r.campaignId}|${r.etDate}`
    if (!seen.has(k)) seen.set(k, storedToday.filter((s) => s.campaignId === r.campaignId && s.etDate === r.etDate).map((s) => s.entryKind ?? readingEntryKind(s)))
    return seen.get(k)!
  }
  for (const r of records) {
    const ek = r.entryKind ?? readingEntryKind(r)
    const kinds = kindsFor(r)
    if (kinds.includes(ek)) plan.skip.push({ record: r, reason: `already recorded today (${ek})` })
    else if (!entryComplete(ek) && kinds.some((k) => entryBase(k) === entryBase(ek) && entryComplete(k))) plan.skip.push({ record: r, reason: `a complete ${entryBase(ek)} read is already recorded today` })
    else {
      plan.append.push({ ...r, entryKind: ek })
      kinds.push(ek)
    }
  }
  return plan
}

/** APPEND-ONLY, like the ads_readings table (whose triggers forbid UPDATE/DELETE): a re-run
 * adds a row, it never replaces one. A retried insert of the SAME id — or a second row for the
 * same (etDate, entry kind), which the UNIQUE index ignores — is a no-op. Sorted by readAt.
 * The in-memory twin of what lib/adsStore.ts writes. */
export function appendReading(log: ReadingsLog | null, rec: ReadingRecord): ReadingsLog {
  if (log && log.campaignId !== rec.campaignId) throw new Error('appendReading: campaign id mismatch')
  const existing = log?.readings ?? []
  const ek = rec.entryKind ?? readingEntryKind(rec)
  if (existing.some((r) => r.id === rec.id || (r.etDate === rec.etDate && (r.entryKind ?? readingEntryKind(r)) === ek))) return { v: 1, campaignId: rec.campaignId, readings: [...existing] }
  const readings = [...existing, { ...rec, entryKind: ek }].sort((a, b) => (a.readAt < b.readAt ? -1 : a.readAt > b.readAt ? 1 : 0))
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
/** ET date each stage is due, keyed to the FLIGHT END date (review M1, 2026-09-26): keying to
 * the last spend date let continued spend push the wrap-up away indefinitely. wrap-up =
 * flight end + 7; day 15/30/60 = flight end + N, so every sign-up in the flight has reached
 * that day; december = the later of flight end + 62 and 2026-12-01, when every d31-60 return
 * window has closed. Spend after the flight is caught by the after-flight check instead,
 * which runs before the due check. */
export function postflightDueDate(stage: PostflightStage, flightEndEt: string): string {
  const last = flightEndEt
  switch (stage) {
    case 'wrapup':
      return addDays(last, 7)
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

// ── Text hygiene for stored notes and outgoing copies ────────────────────────────────────
/** Local filesystem paths never belong in a stored note, a push or a bus copy (review L10):
 * Windows (C:\… or C:/…), Git Bash (/c/…) and home-rooted POSIX paths become "<path>". */
export function stripLocalPaths(s: string): string {
  return s
    .replace(/\b[A-Za-z]:[\\/][^\s'"`,;)]*/g, '<path>')
    .replace(/(^|[\s('"`=])\/(?:[a-z]\/|Users\/|home\/|tmp\/|var\/|private\/)[^\s'"`,;)]*/g, '$1<path>')
}
/** A placement's machine id for outgoing copies (review L11): the app package for a mobile-app
 * placement ("mobileapp::2-com.example.app" → "com.example.app"), else the placement string,
 * reduced to identifier characters. Display names are advertiser-controlled text and never go
 * into a push or a bus copy. */
export function placementId(placement: string | null | undefined): string {
  const raw = String(placement ?? '')
  const m = /^mobileapp::\d+-(.+)$/.exec(raw)
  return (m ? m[1] : raw).replace(/[^A-Za-z0-9._:/-]/g, '').slice(0, 80) || '(unknown placement)'
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
