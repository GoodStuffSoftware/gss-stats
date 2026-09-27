// Orchestration for the CLIs (morning-read.ts, postflight-read.ts). Every data source is
// injected (ReadDeps), so the whole flow runs against a recorded fixture in tests and under
// --fixture, and against the live Ads API / beacon D1 / gss-stats-ads otherwise. The rules
// themselves are the pure functions in src/lib/adsRules.ts; this file only sequences reads,
// decides what fires, and shapes the result that report.ts prints.
//
// Invariants:
//  - PROPOSE only. Nothing here can change a campaign; proposals are strings.
//  - Spend comes ONLY from the shared sync (src/lib/adsSync.ts syncAdsData), the same code the
//    gss-stats-sync Worker and `npm run ads:sync` run: it fills every missing closed day,
//    re-pulls the last few (Google restates them) and writes only what changed, so running it
//    right after another sync is a no-op.
//  - A rule is evaluated only on data that came back (`no-data` otherwise), and a threshold
//    is consumed only by a COMPLETE read, so a failed read is retried next run.
//  - A reading is stored once per (campaign, ET day, entry kind); a same-day rerun appends only
//    when it carries new information, and never re-pushes the same threshold or alert.
//  - --dry-run: every read happens, no store write does.

import {
  buildHealthPairs,
  decideAt100,
  evaluateHealthPairs,
  evaluateKillRules,
  lastSpendDate,
  microsToDollars,
  missingDailyReads,
  newlyCrossedThresholds,
  nextThreshold,
  outcomeRates,
  placementId,
  isPlacementBorderline,
  PLACEMENT_BORDERLINE_NOTE,
  placementOutsideShare,
  playReturnStatus,
  planReadingAppends,
  postflightDueDate,
  readingEntryKind,
  readingId,
  readPlanFor,
  RETEST_AD_GROUP_PLACEMENT_COUNTS,
  round2,
  AUTH_NEW_EXISTING_LIVE_AT,
  campaignSignUps,
  splitAtBoundary,
  type FunnelSegments,
  servingStateOf,
  canProposePause,
  noPauseNote,
  deriveCohortTiers,
  COHORT_TIER_STAGES,
  AUTH_SUCCESS_SPLIT_RECOMMENDATION,
  type CohortTiers,
  spendTotals,
  summarizeReturns,
  summarizeSiteEvents,
  summarizeTaggedRows,
  WEB_GO_LIVE_UTC_MS,
  INSTALL_OUTCOME_GAP_NOTE,
  MEASUREMENT_QUIET_NOTE,
  PLAY_INSTALLS_HOUSEHOLD_NOTE,
  SIGNIN_ELIGIBLE_COUNT_NOTE,
  SIGNUP_PROXY_NOTE,
  UPSELL_KNOWN_BUG_NOTE,
  type AdsReadPlan,
  type DecisionResult,
  type HealthResult,
  type KillRuleEvaluation,
  type OutcomePopup,
  type OutcomeType,
  type PlayReturnStatus,
  type PostflightStage,
  type ReadingRecord,
  type ReturnRow,
  type ReturnSiteStat,
  type ReturnSummary,
  type RuleResult,
  type SiteEventSummary,
  type SpendDay,
  type StoredSpend,
  type TaggedRow,
  type TaggedSummary,
} from '../../src/lib/adsRules'
import type { AdsStore, AppendOutcome, PlacementDayRow } from '../../src/lib/adsStore'
import { ARRIVALS_CAVEAT, costPer, etMidnightUtcMs, etTimeUtcMs, funnelStepRates, type CampaignFlight, type FunnelStepKey } from '../../src/lib/campaigns'
import { etDateFromMs, gateRate, SMALL_SAMPLE_NOTE, type GatedRate, type HourPathCount } from '../../src/lib/popupEvents'
import { addEtDays } from '../../src/lib/overview'
import { splitPlacements, type CampaignStatus, type DeviceRow, type GeoRow, type HourlyRow, type RecommendationRow, type TargetingRow } from '../../src/lib/adsApi'
import { syncAdsData, type AdsMetricsSource, type CampaignSyncResult, type SyncResult } from '../../src/lib/adsSync'
import type { SyncSource } from '../../src/lib/adsStore'
import type { BeaconSource } from './beacon'
import type { FirebaseCounts } from './firebase'
import { redact, summarizeError } from '../../src/lib/adsRedact'

// ── Dependencies ─────────────────────────────────────────────────────────────────────────
/** The Ads API as the reads see it: the metrics the shared sync pulls, plus campaign status.
 * The five diagnostic methods (R2/R3) are OPTIONAL: a fixture or an older AdsSource without
 * them simply reports that diagnostic as unavailable (diagnosticsRead() below), never fails
 * the read they sit alongside. */
export interface AdsSource extends AdsMetricsSource {
  status(campaignId: string): Promise<CampaignStatus>
  hourly?(campaignId: string, since: string, until: string): Promise<HourlyRow[]>
  geo?(campaignId: string, since: string, until: string): Promise<GeoRow[]>
  devices?(campaignId: string, since: string, until: string): Promise<DeviceRow[]>
  targeting?(campaignId: string): Promise<TargetingRow[]>
  recommendations?(campaignId: string): Promise<RecommendationRow[]>
}
export interface FirebaseSource {
  /** cohortTiersAtMs: also read the day-15/30/60 cohort-by-tier COUNTs as of that instant. */
  counts(windowStartMs: number, windowEndMs: number, cohortTiersAtMs?: number | null): Promise<FirebaseCounts>
}
export interface ReadDeps {
  nowMs: number
  /** null when the Ads client could not be built (credentials); `adsInitError` says why. */
  ads: AdsSource | null
  adsInitError?: string | null
  beacon: BeaconSource | null
  beaconInitError?: string | null
  store: AdsStore
  firebase: FirebaseSource | null
  dryRun: boolean
  /** Overrides for the mid-flight instrumentation instants (tests and --fixture); unset = the
   * lib/adsRules.ts constants AUTH_NEW_EXISTING_LIVE_AT / UPSELL_SIGNEDOUT_FIX_AT. */
  boundaries?: { authNewExistingLiveAtMs?: number | null; upsellFixAtMs?: number | null }
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: string }
async function attempt<T>(label: string, fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    return { ok: false, error: `${label}: ${redact(e)}` }
  }
}
const unavailable = <T>(label: string, why: string | null | undefined): Attempt<T> => ({ ok: false, error: `${label}: ${why ?? 'not available'}` })

// ── Shared result shapes ─────────────────────────────────────────────────────────────────
export interface SpendSection {
  ok: boolean
  error: string | null
  throughEt: string | null
  yesterday: { date: string; cost: number; impressions: number; clicks: number } | null
  cumulative: { cost: number; impressions: number; clicks: number; days: number }
  todayPartial: { cost: number; impressions: number; clicks: number } | null
  dailyBudget: number
  hardCap: number
  restated: { date: string; before: number; after: number }[]
  storeWritten: boolean
  storeError: string | null
  /** What the shared sync did for this campaign (src/lib/adsSync.ts). */
  sync: SyncSummary | null
  /** Sync runs (the Worker's) that claimed and never finished in the last 7 days (review I2). */
  syncAlerts?: string[]
}
export interface SyncSummary {
  status: SyncResult['status']
  outcome: string
  fetched: { since: string; until: string } | null
  /** Each range pulled (newest first); `fetched` is their span. */
  ranges?: { since: string; until: string }[]
  /** Non-fatal findings (e.g. an old placement row Google no longer returns, kept as stored). */
  warnings?: string[]
  daysFetched: number
  daysChanged: number
  placementRowsChanged: number
  spendThrough: string | null
  runRecorded: boolean
}
export interface TaggedCounts {
  taggedArrivals: number
  taggedHits: number
  asks: number
  accepts: number
  authSuccess: number
}
export interface FullRead {
  thresholds: number[]
  spendThroughEt: string | null
  cumulativeSpend: number
  complete: boolean
  errors: string[]
  /** Short, secret-free names of the reads that failed (pushes on post-flight runs). */
  failedSources: string[]
  /** The same with a one-line reason each (review L9). */
  failedDetails: { name: string; reason: string }[]
  placements: { campaignCost: number; approvedCost: number; itemizedCost: number; outsideShare: number | null; offList: { name: string; cost: number }[]; stored: boolean } | null
  kill: KillRuleEvaluation
  /** signUpsAtMost is an UPPER bound ("at most N campaign sign-ups"), with both inputs. */
  decision:
    | (DecisionResult & {
        /** The sign-up count the table used: an upper bound unless signUpsExact. */
        signUpsAtMost: number
        signUpsExact: boolean
        /** The "at most" part and the exact /new part once the split is live (else null). */
        signUpsBounded: number | null
        signUpsExactNew: number | null
        taggedAuthSuccess: number
        windowNewAccounts: number | null
        label: string
      })
    | null
  /** Pre-fix / post-fix figures when a behaviour change (the signed-out upsell fix) landed
   * inside this read's window (spec section 14a: two separate short tests). */
  segments: FunnelSegments | null
  tagged: {
    summary: TaggedSummary
    funnelRates: Partial<Record<FunnelStepKey, number | null>>
    // No askRate (review finding, 2026-09-26): asks/taggedArrivals mixes an event-row count
    // against a first-beacon-only count with no shared visitor id — not a real rate. The
    // report prints it as a count pair instead (summary.asks.total / summary.taggedArrivals,
    // both already on TaggedSummary). acceptRate IS a real rate (accepts/asks).
    acceptRate: GatedRate
    costPerArrival: number | null
  } | null
  site: { summary: SiteEventSummary; outcomeRates: Record<OutcomePopup, Record<OutcomeType, GatedRate>> } | null
  returns: ReturnSummary | null
  play: PlayReturnStatus | null
  firebase: FirebaseCounts | null
}
export interface HealthSection {
  evaluated: boolean
  reason: string
  results: HealthResult[] | null
  alerts: number
  /** true when a beacon read the check needed failed (not a gate or a no-ads day). */
  readError?: boolean
}
// ── Diagnostic depth (R2/R3/R5/R8): every field below is a REPORT LINE only — none of it
// feeds a kill rule or an automatic proposal (contract sections 12-13 are frozen). Each
// sub-read is independently best-effort: one failing (a GAQL syntax issue, a missing
// credential, a beacon timeout) is recorded in `errors` and never blocks the others or the
// spend/kill-rule read this section sits alongside.
export interface DiagnosticsSection {
  /** The closed ET day these Ads sub-reads cover (null when there is no closed day yet). */
  spendThroughEt: string | null
  hourly: HourlyRow[] | null
  geo: GeoRow[] | null
  devices: DeviceRow[] | null
  /** null entries: build-spec expected count (RETEST_AD_GROUP_PLACEMENT_COUNTS), for the
   * "placement count matches the build spec" check (R2) — never for an unknown ad group. */
  targeting: (TargetingRow & { expectedPlacements: number | null })[] | null
  recommendations: RecommendationRow[] | null
  /** Beacon-attributed arrivals by country, aggregate counts only (R5). */
  countryCounts: { country: string; count: number }[] | null
  /** R8: a same-day cross-check of Firestore's new-account COUNT for the closed ET day against
   * the beacon's /auth/success/*\/new count for the same day. Both are counts; never joined to
   * an individual. null when --firebase-sa was not given or the cohort code path is blocked. */
  accountCrossCheck: { etDate: string; firestoreNewAccounts: number | null; beaconAuthSuccessNew: number | null; note: string } | null
  errors: string[]
}
export interface Notify {
  push: boolean
  busCopy: boolean
  reason: string
  text: string | null
}
export interface StoreSection {
  kind: string
  dryRun: boolean
  campaignsSynced: boolean
  spendWritten: boolean
  readingsWritten: boolean
  errors: string[]
}
export interface CampaignHeader {
  id: string
  label: string
  ucValues: string[]
  flightStart: string
  flightEnd: string
}

export const STANDING_NOTES = [
  `${SMALL_SAMPLE_NOTE} Production has about 14 registered users: every figure here is anecdotal.`,
  `Tagged arrivals: ${ARRIVALS_CAVEAT}`,
  SIGNIN_ELIGIBLE_COUNT_NOTE,
  UPSELL_KNOWN_BUG_NOTE,
  MEASUREMENT_QUIET_NOTE,
  PLAY_INSTALLS_HOUSEHOLD_NOTE,
  SIGNUP_PROXY_NOTE,
]

function header(c: CampaignFlight): CampaignHeader {
  return { id: c.id, label: c.label, ucValues: [...c.ucValues], flightStart: c.flightStart!, flightEnd: c.flightEnd }
}
export function attributionStartMs(c: CampaignFlight): number {
  return c.flightStartTimeEt ? etTimeUtcMs(c.flightStart!, c.flightStartTimeEt) : etMidnightUtcMs(c.flightStart!)
}
function flightEndExclusiveMs(c: CampaignFlight): number {
  return etMidnightUtcMs(addEtDays(c.flightEnd, 1))
}
const dayDollars = (d: SpendDay | undefined) => (d ? { cost: round2(microsToDollars(d.costMicros)), impressions: d.impressions, clicks: d.clicks } : null)
const money = (x: number) => `$${x.toFixed(2)}`

// ── Spend: the shared sync (src/lib/adsSync.ts), then the read's view of it ──────────────
interface SpendRead {
  section: SpendSection
  /** Closed days (synced) plus today's partial day, like the Ads API returns them. */
  stored: StoredSpend | null
  sync: SyncResult
  campaignSync: CampaignSyncResult
}
/** Runs syncAdsData for the read's campaign (every missing closed day, plus the restatement
 * window; only changed rows are written) and today's partial numbers (never stored). The
 * restatement window is re-pulled on EVERY read (review M1): the Worker's 6 h cadence must not
 * let a read decide on a yesterday it pulled hours earlier, before Google's late data landed. */
async function syncSpend(deps: ReadDeps, plan: AdsReadPlan, campaign: CampaignFlight, todayEt: string, source: SyncSource): Promise<SpendRead> {
  const sync = await syncAdsData(
    { ads: deps.ads, adsInitError: deps.adsInitError, store: deps.store },
    { campaignIds: [plan.campaignId], now: deps.nowMs, dryRun: deps.dryRun, source, includeToday: true, restatementRecheckMs: 0 },
  )
  const cs = sync.campaigns[0]
  const summary: SyncSummary = {
    status: sync.status,
    outcome: cs.outcome,
    fetched: cs.fetched,
    ranges: cs.ranges,
    warnings: cs.warnings,
    daysFetched: cs.daysFetched,
    daysChanged: cs.daysChanged,
    placementRowsChanged: cs.placementRowsChanged,
    spendThrough: cs.spendThrough,
    runRecorded: sync.runRecorded,
  }
  const yesterdayEt = addEtDays(todayEt, -1)
  const alerts = await attempt('store read (sync runs)', () => deps.store.getSyncAlerts(deps.nowMs))
  const base: SpendSection = {
    ok: false,
    error: null,
    throughEt: yesterdayEt >= campaign.flightStart! ? yesterdayEt : null,
    yesterday: null,
    cumulative: { cost: 0, impressions: 0, clicks: 0, days: 0 },
    todayPartial: null,
    dailyBudget: plan.dailyBudget,
    hardCap: plan.hardCap,
    restated: [],
    storeWritten: false,
    storeError: null,
    sync: summary,
    syncAlerts: alerts.ok ? alerts.value.map((a) => a.message) : [],
  }
  if (!cs.fetchOk) return { section: { ...base, error: cs.error ?? 'ads daily: failed' }, stored: null, sync, campaignSync: cs }

  const throughEt = cs.spendThrough
  const stored: StoredSpend = {
    ...(cs.spend ?? { v: 1, campaignId: plan.campaignId, source: 'google-ads-api', apiVersion: '', customerId: '', fetchedAt: sync.startedAt, closedThroughEt: null, days: {} }),
  }
  if (cs.today) stored.days = { ...stored.days, [todayEt]: cs.today }
  const cum = spendTotals(stored, throughEt ?? addEtDays(campaign.flightStart!, -1))
  const storeError = sync.campaignSyncError ?? (!cs.dailyOk ? cs.error : null)
  return {
    stored,
    sync,
    campaignSync: cs,
    section: {
      ...base,
      ok: true,
      throughEt,
      yesterday: throughEt ? { date: throughEt, ...(dayDollars(stored.days[throughEt]) ?? { cost: 0, impressions: 0, clicks: 0 }) } : null,
      cumulative: { cost: cum.cost, impressions: cum.impressions, clicks: cum.clicks, days: cum.days },
      todayPartial: dayDollars(cs.today ?? undefined),
      restated: cs.restated,
      storeWritten: !deps.dryRun && !storeError,
      storeError,
    },
  }
}

/** Placement-day rows through `throughEt` for kill rule 1: the stored rows, overlaid with this
 * run's pull (identical once written; the only copy in --dry-run). A failed placement pull makes
 * the rule no-data rather than trusting rows that may be missing the latest days. */
async function placementRowsFor(deps: ReadDeps, campaign: CampaignFlight, cs: CampaignSyncResult | null, throughEt: string | null): Promise<Attempt<PlacementDayRow[]>> {
  if (!throughEt) return unavailable('ads placements', 'no closed spend day yet')
  if (!cs || !cs.fetchOk) return unavailable('ads placements', cs?.error ?? deps.adsInitError)
  if (cs.placementsOk === false) return { ok: false, error: cs.error ?? 'ads placements: failed' }
  const stored = await attempt('store read (placements)', () => deps.store.getPlacementRows(campaign.id, campaign.flightStart!, throughEt))
  if (!stored.ok) return stored
  const pulled = (d: string) => cs.ranges.some((r) => d >= r.since && d <= r.until)
  const rows = cs.ranges.length ? [...stored.value.filter((r) => !pulled(r.date)), ...cs.placements.filter((r) => r.date <= throughEt)] : stored.value
  return { ok: true, value: rows }
}

function taggedCounts(s: TaggedSummary): TaggedCounts {
  return { taggedArrivals: s.taggedArrivals, taggedHits: s.taggedHits, asks: s.asks.total, accepts: s.accepts.total, authSuccess: s.authSuccess }
}

// ── The full read (threshold crossings and post-flight stages) ───────────────────────────
interface FullReadInput {
  plan: AdsReadPlan
  campaign: CampaignFlight
  thresholds: number[]
  spendThroughEt: string | null
  stored: StoredSpend | null
  /** This run's sync of the campaign (its placement pull feeds kill rule 1). */
  campaignSync: CampaignSyncResult | null
  tagged: Attempt<TaggedRow[]>
  /** Whether to evaluate the $100 decision table regardless of spend (post-flight). */
  forceDecision: boolean
  readAt: string
  /** Campaign status/serving status, for "is there anything to pause?" (null = unreadable). */
  campaignState: { status: string | null; servingStatus: string | null } | null
  /** Day-15/30/60: also read the cohort-by-tier counts as of this instant. */
  cohortTiersAtMs?: number | null
}
async function fullRead(deps: ReadDeps, i: FullReadInput): Promise<{ read: FullRead; siteRows: Attempt<HourPathCount[]>; returns: Attempt<ReturnSummary> }> {
  const { plan, campaign } = i
  const errors: string[] = []
  const totals = spendTotals(i.stored, i.spendThroughEt ?? addEtDays(campaign.flightStart!, -1))
  const cumulativeSpend = totals.cost

  const placementRows = await placementRowsFor(deps, campaign, i.campaignSync, i.spendThroughEt)
  const placementsStored = placementRows.ok && !deps.dryRun && i.campaignSync?.placementsOk !== false
  const beacon = deps.beacon
  const siteRows = beacon ? await attempt('beacon site events', () => beacon.siteEvents(WEB_GO_LIVE_UTC_MS)) : unavailable<HourPathCount[]>('beacon site events', deps.beaconInitError)
  const returnRaw = beacon ? await attempt('beacon returns', () => beacon.returns(campaign)) : unavailable<ReturnRow[]>('beacon returns', deps.beaconInitError)
  const returnSites = beacon ? await attempt('beacon return sites', () => beacon.returnSites(WEB_GO_LIVE_UTC_MS)) : unavailable<ReturnSiteStat[]>('beacon return sites', deps.beaconInitError)
  const windowEnd = Math.min(deps.nowMs, flightEndExclusiveMs(campaign))
  const fb = deps.firebase ? await attempt('firebase counts', () => deps.firebase!.counts(attributionStartMs(campaign), windowEnd, i.cohortTiersAtMs ?? null)) : null

  for (const a of [placementRows, i.tagged, siteRows, returnRaw, returnSites]) if (!a.ok) errors.push(a.error)
  if (fb && !fb.ok) errors.push(fb.error)
  if (fb && fb.ok) for (const e of fb.value.errors) errors.push(`firebase: ${e}`)

  let tagged: FullRead['tagged'] = null
  if (i.tagged.ok) {
    const summary = summarizeTaggedRows(i.tagged.value)
    tagged = {
      summary,
      funnelRates: funnelStepRates(summary.funnel),
      acceptRate: gateRate(summary.accepts.total, summary.asks.total),
      costPerArrival: costPer(cumulativeSpend, summary.taggedArrivals),
    }
  }
  let site: FullRead['site'] = null
  if (siteRows.ok) {
    const summary = summarizeSiteEvents(siteRows.value, deps.nowMs - 24 * 3_600_000)
    const popups: OutcomePopup[] = ['signin-prompt', 'promo-first50', 'upsell', 'install']
    const rates = {} as Record<OutcomePopup, Record<OutcomeType, GatedRate>>
    for (const p of popups) rates[p] = outcomeRates(summary.outcomes, summary.shown, p)
    site = { summary, outcomeRates: rates }
  }
  const returns = returnRaw.ok ? summarizeReturns(returnRaw.value, campaign.ucValues) : null
  const play = returnSites.ok ? playReturnStatus(returnSites.value, deps.nowMs) : null

  // Placement split for kill rule 1 — over the SAME closed range as the campaign total.
  const split = placementRows.ok ? splitPlacements(placementRows.value, i.spendThroughEt) : null
  const placementView: FullRead['placements'] = split
    ? {
        campaignCost: cumulativeSpend,
        approvedCost: round2(split.approvedCost),
        itemizedCost: round2(split.itemizedCost),
        outsideShare:
          cumulativeSpend > 0 || split.itemizedCost > 0
            ? placementOutsideShare({ campaignCost: cumulativeSpend, approvedCost: split.approvedCost, itemizedCost: split.itemizedCost }).share
            : null,
        offList: split.byPlacement
          .filter((p) => p.approved === false && p.costMicros > 0)
          .slice(0, 5)
          .map((p) => ({ name: placementId(p.placement), cost: round2(p.costMicros / 1e6) })), // package id, never the display name (L11)
        stored: placementsStored,
      }
    : null

  const kill = evaluateKillRules({
    plan,
    cumulativeSpend,
    campaignState: i.campaignState,
    delivery: i.stored && i.spendThroughEt ? { impressions: totals.impressions, clicks: totals.clicks } : null,
    placements: split ? { campaignCost: cumulativeSpend, approvedCost: split.approvedCost, itemizedCost: split.itemizedCost } : null,
    beacon: tagged ? { asks: tagged.summary.asks.total, taggedArrivals: tagged.summary.taggedArrivals } : null,
  })

  const authLiveAt = deps.boundaries?.authNewExistingLiveAtMs === undefined ? AUTH_NEW_EXISTING_LIVE_AT : deps.boundaries.authNewExistingLiveAtMs
  const windowAccounts = fb && fb.ok ? fb.value.newAccountsInWindow : null
  let decision: FullRead['decision'] = null
  if (tagged && (i.forceDecision || cumulativeSpend >= plan.hardCap)) {
    const su = campaignSignUps(tagged.summary, windowAccounts, authLiveAt)
    decision = {
      ...decideAt100({ signUpsAtMost: su.count, asks: tagged.summary.asks.total, accepts: tagged.summary.accepts.total, exact: su.exact }),
      signUpsAtMost: su.count,
      signUpsExact: su.exact,
      signUpsBounded: su.bounded,
      signUpsExactNew: su.exactNew,
      taggedAuthSuccess: tagged.summary.authSuccess,
      windowNewAccounts: windowAccounts,
      label: su.label,
    }
  }
  // A behaviour change inside the window splits the read (spec section 14a).
  const segments =
    i.tagged.ok
      ? splitAtBoundary({
          rows: i.tagged.value,
          stored: i.stored,
          throughEt: i.spendThroughEt,
          startMs: attributionStartMs(campaign),
          endMs: windowEnd,
          windowNewAccounts: windowAccounts,
          boundaryMs: deps.boundaries?.upsellFixAtMs,
          authLiveAtMs: authLiveAt,
        })
      : null

  const failedDetails: { name: string; reason: string }[] = []
  if (!placementRows.ok && i.spendThroughEt) failedDetails.push({ name: 'Google Ads placements', reason: summarizeError(placementRows.error) })
  const beaconErr = [i.tagged, siteRows, returnRaw, returnSites].find((a) => !a.ok) as { error: string } | undefined
  if (beaconErr) failedDetails.push({ name: 'beacon', reason: summarizeError(beaconErr.error) })
  // A missing composite index for the day-15/30/60 tier split is a known, graceful degrade
  // ("tier split unavailable: index missing"), not a failed read.
  const fbErr = fb ? (!fb.ok ? fb.error : fb.value.errors.find((e) => !/composite index/.test(e)) ?? null) : null
  if (fbErr) failedDetails.push({ name: 'Firestore counts', reason: summarizeError(fbErr) })
  const failedSources = failedDetails.map((f) => f.name)
  // A Firestore failure on a read that runs the decision table (the $100 read, post-flight)
  // makes it incomplete (review L6): the sign-up bound would silently loosen without it.
  const complete = placementRows.ok && i.tagged.ok && siteRows.ok && returnRaw.ok && returnSites.ok && i.stored != null && !(decision && fbErr)
  return {
    read: { thresholds: i.thresholds, spendThroughEt: i.spendThroughEt, cumulativeSpend, complete, errors, failedSources, failedDetails, placements: placementView, kill, decision, segments, tagged, site, returns, play, firebase: fb && fb.ok ? fb.value : null },
    siteRows,
    returns: returns ? { ok: true, value: returns } : { ok: false, error: returnRaw.ok ? 'returns unavailable' : returnRaw.error },
  }
}

/** Pre-fix / post-fix figures for the stored record (anonymous counts and dollars only). */
function segmentCounts(s: FunnelSegments | null): Record<string, number | null> {
  if (!s) return {}
  const side = (p: 'preFix' | 'postFix', f: FunnelSegments['pre']) => ({
    [`${p}Spend`]: f.spend,
    [`${p}Asks`]: f.asks,
    [`${p}Accepts`]: f.accepts,
    [`${p}AuthSuccess`]: f.authSuccess,
    [`${p}SignUps`]: f.signUps.count,
    [`${p}UpsellShown`]: f.upsell.shown,
    [`${p}UpsellAccept`]: f.upsell.accept,
  })
  return { segmentBoundaryMs: s.boundaryMs, fixDaySpend: s.boundaryDaySpend, ...side('preFix', s.pre), ...side('postFix', s.post) }
}
/** "at most N campaign sign-ups (upper bound)" or "N campaign sign-ups (exact)". */
export function signUpsPhrase(d: { signUpsAtMost: number; signUpsExact?: boolean }): string {
  return d.signUpsExact ? `${d.signUpsAtMost} campaign sign-up${d.signUpsAtMost === 1 ? '' : 's'} (exact)` : `at most ${d.signUpsAtMost} campaign sign-ups (upper bound)`
}

function fullReadCounts(r: FullRead): Record<string, number | null> {
  const t = r.tagged?.summary
  const s = r.site?.summary
  return {
    cumulativeSpend: r.cumulativeSpend,
    taggedArrivals: t?.taggedArrivals ?? null,
    taggedHits: t?.taggedHits ?? null,
    asks: t?.asks.total ?? null,
    accepts: t?.accepts.total ?? null,
    authRedirect: t?.authRedirect ?? null,
    authSuccess: t?.authSuccess ?? null,
    installPromptShown: t?.install.promptShown ?? null,
    installTaps: t?.install.taps ?? null,
    promoShownTagged: t?.promoFirst50.shown ?? null,
    signinEligibleTagged: t ? t.signinEligible.earned + t.signinEligible.capped + t.signinEligible.unearned : null,
    outsideShare: r.placements?.outsideShare ?? null,
    promoShownSite: s?.promoFirst50.shown ?? null,
    upsellShownSite: s?.upsell.shown ?? null,
    installedTagged: t?.install.installed ?? null,
    rawInstallSignalsTagged: t?.install.rawSignals ?? null,
    installedSite: s?.outcomes.install.installed ?? null,
    rawInstallSignalsSite: s?.rawInstallSignals ?? null,
    returnD0Web: r.returns?.web.d0 ?? null,
    returnD1Web: r.returns?.web.d1 ?? null,
    returnD31to60Web: r.returns?.web['d31-60'] ?? null,
    returnD0App: r.returns?.app.d0 ?? null,
    newAccountsInWindow: r.firebase?.newAccountsInWindow ?? null,
    promoClaimsInWindow: r.firebase?.promoClaimsInWindow ?? null,
    first50Claimed: r.firebase?.first50?.claimed ?? null,
    signUpsAtMost: r.decision?.signUpsAtMost ?? null,
    signUpsExact: r.decision ? (r.decision.signUpsExact ? 1 : 0) : null,
    authSuccessNew: t?.authSuccessSplit.new ?? null,
    authSuccessUnknown: t?.authSuccessSplit.unknown ?? null,
    authSuccessExisting: t?.authSuccessSplit.existing ?? null,
    ...segmentCounts(r.segments),
  }
}

// ── Release health ───────────────────────────────────────────────────────────────────────
async function releaseHealth(
  deps: ReadDeps,
  campaign: CampaignFlight,
  tagged: Attempt<TaggedRow[]>,
  cached: { siteRows?: Attempt<HourPathCount[]>; returns?: Attempt<ReturnSummary> },
  opts: { minParent: number; parentAgeHours: number; servedToday: boolean | null; requireServedToday: boolean },
): Promise<HealthSection> {
  // No time-of-day gate (retired 2026-09-27, src/lib/adsRules.ts): parent/child maturity is
  // enforced below by parentAgeHours against event timestamps, not the clock.
  if (opts.requireServedToday && opts.servedToday !== true) {
    return { evaluated: false, reason: opts.servedToday === false ? 'not evaluated: no ads served today' : 'not evaluated: could not tell whether ads served today', results: null, alerts: 0 }
  }
  const beacon = deps.beacon
  const siteRows = cached.siteRows ?? (beacon ? await attempt('beacon site events', () => beacon.siteEvents(WEB_GO_LIVE_UTC_MS)) : unavailable<HourPathCount[]>('beacon', deps.beaconInitError))
  const returns =
    cached.returns ??
    (beacon ? await attempt('beacon returns', async () => summarizeReturns(await beacon.returns(campaign), campaign.ucValues)) : unavailable<ReturnSummary>('beacon', deps.beaconInitError))
  if (!siteRows.ok || !returns.ok || !tagged.ok) {
    const why = [siteRows, returns, tagged].filter((a) => !a.ok).map((a) => (a as { error: string }).error)
    return { evaluated: false, reason: `not evaluated: ${why.join('; ')}`, results: null, alerts: 0, readError: true }
  }
  const maturedBefore = deps.nowMs - opts.parentAgeHours * 3_600_000
  const site = summarizeSiteEvents(siteRows.value, maturedBefore)
  const arrivalsMatured = tagged.value.filter((r) => r.visitor === 'new' && r.hourStartMs + 2 * 3_600_000 <= deps.nowMs).reduce((a, r) => a + r.count, 0)
  const results = evaluateHealthPairs(buildHealthPairs({ site, taggedArrivalsMatured: arrivalsMatured, returnD0Web: returns.value.web.d0 }), opts.minParent)
  return { evaluated: true, reason: 'evaluated', results, alerts: results.filter((r) => r.status === 'alert').length }
}

/** R2/R3/R5/R8: informational-only diagnostic depth for the closed ET day. Every sub-read is
 * independently best-effort (attempt()); a failure is recorded in `errors` and reported, never
 * thrown, and never affects the spend/kill-rule read or `notify`. Skipped entirely in
 * health-only (backstop) mode. */
async function diagnosticsRead(
  deps: ReadDeps,
  campaign: CampaignFlight,
  campaignId: string,
  spendThroughEt: string | null,
  taggedRows: Attempt<TaggedRow[]>,
): Promise<DiagnosticsSection> {
  const errors: string[] = []
  const ads = deps.ads
  const since = spendThroughEt
  const until = spendThroughEt

  const hourly = ads?.hourly && since && until ? await attempt('ads hourly', () => ads.hourly!(campaignId, since, until)) : null
  if (hourly && !hourly.ok) errors.push(hourly.error)
  const geo = ads?.geo && since && until ? await attempt('ads geo', () => ads.geo!(campaignId, since, until)) : null
  if (geo && !geo.ok) errors.push(geo.error)
  const devices = ads?.devices && since && until ? await attempt('ads devices', () => ads.devices!(campaignId, since, until)) : null
  if (devices && !devices.ok) errors.push(devices.error)
  const targeting = ads?.targeting ? await attempt('ads targeting', () => ads.targeting!(campaignId)) : null
  if (targeting && !targeting.ok) errors.push(targeting.error)
  const recommendations = ads?.recommendations ? await attempt('ads recommendations', () => ads.recommendations!(campaignId)) : null
  if (recommendations && !recommendations.ok) errors.push(recommendations.error)

  const beacon = deps.beacon
  const country = beacon?.countryCounts ? await attempt('beacon country', () => beacon.countryCounts!(campaign)) : null
  if (country && !country.ok) errors.push(country.error)

  let accountCrossCheck: DiagnosticsSection['accountCrossCheck'] = null
  if (spendThroughEt && deps.firebase) {
    const dayStart = etMidnightUtcMs(spendThroughEt)
    const dayEnd = etMidnightUtcMs(addEtDays(spendThroughEt, 1))
    const fb = await attempt('firebase day cross-check', () => deps.firebase!.counts(dayStart, dayEnd))
    if (!fb.ok) errors.push(fb.error)
    else {
      const beaconNew = taggedRows.ok ? summarizeTaggedRows(taggedRows.value, { fromMs: dayStart, toMs: dayEnd }).authSuccessSplit.new : null
      accountCrossCheck = {
        etDate: spendThroughEt,
        firestoreNewAccounts: fb.value.newAccountsInWindow,
        beaconAuthSuccessNew: beaconNew,
        note: 'counts only, never joined to an individual; the beacon count is campaign-attributed, the Firestore count is sitewide, so the Firestore count is always >= the beacon count',
      }
    }
  } else if (spendThroughEt && !deps.firebase) {
    errors.push('account cross-check: not read (--firebase-sa not given)')
  }

  return {
    spendThroughEt,
    hourly: hourly?.ok ? hourly.value : null,
    geo: geo?.ok ? geo.value : null,
    devices: devices?.ok ? devices.value : null,
    targeting: targeting?.ok ? targeting.value.map((t) => ({ ...t, expectedPlacements: RETEST_AD_GROUP_PLACEMENT_COUNTS[t.adGroup] ?? null })) : null,
    recommendations: recommendations?.ok ? recommendations.value : null,
    countryCounts: country?.ok ? country.value : null,
    accountCrossCheck,
    errors,
  }
}

export interface DedupSection {
  /** Records not appended: a same-day rerun of the same entry that carries nothing new. */
  skipped: { kind: ReadingRecord['kind']; entryKind: string; reason: string }[]
  /** Set when today's stored readings could not be read (then everything counts as new). */
  checkError: string | null
}
/** Appends the run's records once per (campaign, ET day, entry kind): today's stored readings
 * are read first (lib/adsRules.ts planReadingAppends), and the UNIQUE index backs it up. */
async function appendReadings(
  deps: ReadDeps,
  campaignId: string,
  todayEt: string,
  records: ReadingRecord[],
): Promise<{ written: boolean; error: string | null; dedup: DedupSection; isNew: (id: string) => boolean }> {
  const dedup: DedupSection = { skipped: [], checkError: null }
  if (!records.length) return { written: false, error: null, dedup, isNew: () => false }
  const today = await attempt('store read (today’s readings)', () => deps.store.getReadingsOn(campaignId, todayEt))
  // Unreadable: treat everything as new — a duplicate push beats a missed one; the index still
  // refuses a duplicate row.
  const plan = today.ok ? planReadingAppends(records, today.value) : { append: records.map((r) => ({ ...r, entryKind: readingEntryKind(r) })), skip: [] }
  if (!today.ok) dedup.checkError = today.error
  for (const s of plan.skip) dedup.skipped.push({ kind: s.record.kind, entryKind: s.record.entryKind ?? readingEntryKind(s.record), reason: s.reason })
  let outcome: AppendOutcome = { written: false, inserted: [], ignored: [] }
  let error: string | null = null
  if (plan.append.length) {
    const put = await attempt('store write (readings)', () => deps.store.appendReadings(plan.append))
    if (put.ok) outcome = put.value
    else error = put.error
  }
  // A complete threshold read that is NOT appended again (already stored today) still gets its
  // idempotent threshold-state insert: a state row lost to an earlier partial write is restored
  // now instead of the threshold firing again tomorrow.
  const skippedComplete = plan.skip.map((s) => s.record).filter((r) => r.kind === 'threshold' && r.complete)
  if (skippedComplete.length) {
    const st = await attempt('store write (threshold state)', () => deps.store.ensureThresholdState(skippedComplete))
    if (!st.ok && !error) error = st.error
  }
  for (const id of outcome.ignored) {
    const r = plan.append.find((x) => x.id === id)!
    dedup.skipped.push({ kind: r.kind, entryKind: r.entryKind!, reason: 'already recorded today (stored by a concurrent run)' })
  }
  const appended = new Set(plan.append.map((r) => r.id).filter((id) => !outcome.ignored.includes(id)))
  return { written: outcome.written && !error, error, dedup, isNew: (id) => appended.has(id) }
}

// ── morning-read ─────────────────────────────────────────────────────────────────────────
export interface MorningOptions {
  campaignId: string
  /** 'auto' evaluates release health unconditionally (no time-of-day gate since 2026-09-27); 'skip' never does. */
  releaseHealth: 'auto' | 'skip'
  /** Manual/diagnostic mode retained from the retired 23:15 ET backstop entry: status + today's
   * spend + release health only. No longer scheduled (folded into the single daily read). */
  healthOnly: boolean
  healthMinParent: number
  healthParentAgeHours: number
}
export interface MorningResult {
  tool: 'morning-read'
  version: 1
  mode: 'morning' | 'health-only'
  dryRun: boolean
  readAt: string
  etDate: string
  campaign: CampaignHeader
  status: CampaignStatus | null
  statusError: string | null
  spend: SpendSection
  thresholds: { crossedNow: number[]; consumedBefore: number[]; next: number | null; stateError: string | null }
  tagged: { ok: boolean; error: string | null; cumulative: TaggedCounts | null; yesterday: TaggedCounts | null }
  thresholdRead: FullRead | null
  hardCapDaily: RuleResult | null
  releaseHealth: HealthSection
  diagnostics: DiagnosticsSection
  play: PlayReturnStatus | null
  store: StoreSection
  /** Short names of the reads that failed this run — any entry pushes. */
  failures: string[]
  /** "<name> (<one-line reason>)" for each failure: redacted, no local paths (review L9). */
  failureDetails: string[]
  /** ET dates inside the routine window with no daily reading since the last one on record
   * (a scheduled run that never started can't report itself; the next one does). */
  missedReads: string[]
  /** Same-day reruns of an entry that carry nothing new: not stored, not pushed again. */
  dedup: DedupSection
  notify: Notify
  errors: string[]
  notes: string[]
}

/** True when this run's record of that kind repeated one already stored today. */
export function repeatedToday(r: { dedup?: DedupSection }, kind: ReadingRecord['kind']): boolean {
  return (r.dedup?.skipped ?? []).some((s) => s.kind === kind)
}

/** The push text for a morning or backstop run, or null for a quiet run. Built only from
 * counts, rule ids and short read names — never an error message, so nothing secret-shaped
 * can reach a notification. A threshold read, a cap trip or an alert already recorded (and so
 * already pushed) today is not pushed again; a failed read still is. */
export function morningPushText(r: MorningResult): string | null {
  const missed = r.missedReads.length ? ` Previous scheduled read missing: ${r.missedReads.join(', ')}.` : ''
  const failed = r.failureDetails.length ? ` Read problems: ${r.failureDetails.join('; ')}.` : ''
  if (r.thresholdRead && !repeatedToday(r, 'threshold')) {
    const t = r.thresholdRead
    const bits = [`BSK retest $${Math.max(...t.thresholds)} read: ${money(t.cumulativeSpend)} spent`]
    const tc = t.tagged?.summary
    if (tc) bits.push(`${tc.taggedArrivals} tagged arrivals, ${tc.asks.total} asks, ${tc.authSuccess} auth successes`)
    if (t.kill.tripped.length && t.kill.proposal === 'PROPOSE PAUSE') bits.push(`PROPOSE PAUSE (${t.kill.tripped.join(', ')})`)
    else if (t.kill.tripped.length) bits.push(`rules tripped (${t.kill.tripped.join(', ')}) but campaign ${t.kill.servingState}, no pause proposed`)
    else bits.push(t.complete ? 'no kill rule tripped, continue' : 'read incomplete, will retry')
    if (t.decision) bits.push(`${signUpsPhrase(t.decision)}, row ${t.decision.row}`)
    if (t.segments) bits.push(`split at the upsell fix: pre-fix ${t.segments.pre.asks} asks/${t.segments.pre.signUps.count} sign-ups, post-fix ${t.segments.post.asks} asks/${t.segments.post.signUps.count} sign-ups`)
    const share = t.placements?.outsideShare
    const borderline = isPlacementBorderline(share) ? ` Placement share ${((share ?? 0) * 100).toFixed(1)}% is ${PLACEMENT_BORDERLINE_NOTE}.` : ''
    return bits.join('; ') + '.' + borderline + failed + missed
  }
  if (r.hardCapDaily?.status === 'trip' && !repeatedToday(r, 'daily')) {
    return `BSK retest: ${money(r.spend.cumulative.cost)} spent, at or over the ${money(r.spend.hardCap)} cap, campaign still ${r.status?.status ?? 'ENABLED'}. PROPOSE PAUSE.${failed}${missed}`
  }
  const alerts = r.mode === 'health-only' && !repeatedToday(r, 'health') ? (r.releaseHealth.results ?? []).filter((h) => h.status === 'alert') : []
  if (alerts.length) {
    return `BSK retest release-health ALERT: ${alerts.map((h) => `${h.parentLabel} ${h.parent}, ${h.childLabel} 0`).join('; ')}.${failed}`
  }
  if (r.failures.length) {
    return `BSK retest ${r.mode === 'health-only' ? 'release-health backstop' : 'morning read'} FAILED: ${r.failureDetails.join('; ')}. Thresholds and the $${r.spend.hardCap} cap were not fully checked.${missed}`
  }
  return null
}

/** Short, secret-free names of the reads that failed. Gate skips (quiet window, a day with
 * no ads served) and --dry-run's skipped writes are not failures. */
export function morningFailures(i: {
  healthOnly: boolean
  dryRun: boolean
  /** Each is the read's error text, or null when it worked. */
  statusError: string | null
  spendError: string | null
  taggedError: string | null
  thresholdStateError: string | null
  storeErrors: readonly string[]
  healthReadError: string | null
  /** A threshold read's own failed sources (review L6), already summarized. */
  thresholdReadFailures?: readonly { name: string; reason: string }[]
}): { names: string[]; details: string[] } {
  const found: { name: string; reason: string }[] = []
  const add = (name: string, err: string | null | undefined) => {
    if (err && !found.some((f) => f.name === name)) found.push({ name, reason: summarizeError(err) })
  }
  add(i.spendError && /^store /.test(i.spendError) ? 'store read' : 'Google Ads spend', i.spendError)
  add('campaign status', i.statusError)
  if (!i.healthOnly) add('beacon', i.taggedError)
  if (i.healthOnly) add('beacon', i.healthReadError)
  if (!i.healthOnly) add('threshold state', i.thresholdStateError)
  if (!i.dryRun && i.storeErrors.length) add('store write', i.storeErrors[0])
  for (const f of i.thresholdReadFailures ?? []) if (!found.some((x) => x.name === f.name)) found.push(f)
  return { names: found.map((f) => f.name), details: found.map((f) => `${f.name} (${f.reason})`) }
}

export async function runMorningRead(deps: ReadDeps, opts: MorningOptions): Promise<MorningResult> {
  const { plan, campaign } = readPlanFor(opts.campaignId)
  const readAt = new Date(deps.nowMs).toISOString()
  const todayEt = etDateFromMs(deps.nowMs)
  const yesterdayEt = addEtDays(todayEt, -1)
  const errors: string[] = []

  const status = deps.ads ? await attempt('ads status', () => deps.ads!.status(plan.campaignId)) : unavailable<CampaignStatus>('ads status', deps.adsInitError)
  if (!status.ok) errors.push(status.error)

  // The shared sync first (morning read and backstop alike): fills every missing closed day,
  // re-pulls the restatement window, writes only changes. A no-op right after another sync.
  const { section: spend, stored, sync, campaignSync } = await syncSpend(deps, plan, campaign, todayEt, opts.healthOnly ? 'backstop' : 'morning-read')
  if (spend.error) errors.push(spend.error)
  if (spend.storeError) errors.push(spend.storeError)
  if (campaignSync.fetchOk && campaignSync.placementsOk === false && campaignSync.error && !errors.includes(campaignSync.error)) errors.push(campaignSync.error)

  // Consumed = the threshold-state rows PLUS any complete threshold reading (a state row lost to
  // a partial write must never make a threshold fire twice).
  const ledgerA = await attempt('store read (threshold state)', () => deps.store.getThresholdLedger(plan.campaignId))
  const consumedA: Attempt<number[]> = ledgerA.ok ? { ok: true, value: [...new Set([...ledgerA.value.state, ...ledgerA.value.fromReadings])].sort((a, b) => a - b) } : ledgerA
  if (!consumedA.ok) errors.push(consumedA.error)
  const unrecordedState = ledgerA.ok ? ledgerA.value.fromReadings.filter((t) => !ledgerA.value.state.includes(t)) : []
  // If the state is unreadable, treat nothing as consumed: a duplicate push beats a missed
  // $50 kill-rule read. The report says so.
  const consumed = consumedA.ok ? consumedA.value : []
  const cumulative = spend.cumulative.cost
  const crossedNow = spend.ok && !opts.healthOnly ? newlyCrossedThresholds(cumulative, plan.thresholds, consumed) : []

  // Scheduled reads that never ran (read BEFORE this run appends its own line).
  let missedReads: string[] = []
  if (!opts.healthOnly) {
    const recent = await attempt('store read (readings)', () => deps.store.getReadings(plan.campaignId, 60))
    if (recent.ok) {
      missedReads = missingDailyReads(recent.value, todayEt, plan.morningReadFirstEt, plan.morningReadLastEt)
      // Heal: a complete threshold reading whose state row is missing (a partial write) gets it
      // back. The ledger already counts it as consumed, so it cannot fire twice meanwhile.
      const toHeal = recent.value.filter((r) => r.kind === 'threshold' && r.complete && r.thresholds.some((t) => unrecordedState.includes(t)))
      if (toHeal.length && !deps.dryRun) {
        const heal = await attempt('store write (threshold state)', () => deps.store.ensureThresholdState(toHeal))
        if (!heal.ok) errors.push(heal.error)
      }
    } else errors.push(recent.error)
  }

  const beacon = deps.beacon
  const taggedRows = beacon ? await attempt('beacon tagged', () => beacon.tagged(campaign, deps.boundaries?.upsellFixAtMs)) : unavailable<TaggedRow[]>('beacon tagged', deps.beaconInitError)
  if (!taggedRows.ok) errors.push(taggedRows.error)
  const yStart = etMidnightUtcMs(yesterdayEt)
  const yEnd = etMidnightUtcMs(todayEt)
  const tagged = {
    ok: taggedRows.ok,
    error: taggedRows.ok ? null : taggedRows.error,
    cumulative: taggedRows.ok ? taggedCounts(summarizeTaggedRows(taggedRows.value)) : null,
    yesterday: taggedRows.ok ? taggedCounts(summarizeTaggedRows(taggedRows.value, { fromMs: yStart, toMs: yEnd })) : null,
  }

  let thresholdRead: FullRead | null = null
  let cached: { siteRows?: Attempt<HourPathCount[]>; returns?: Attempt<ReturnSummary> } = {}
  if (crossedNow.length) {
    const fr = await fullRead(deps, {
      plan,
      campaign,
      thresholds: crossedNow,
      spendThroughEt: spend.throughEt,
      stored,
      campaignSync,
      tagged: taggedRows,
      forceDecision: false,
      readAt,
      campaignState: status.ok ? status.value : null,
    })
    thresholdRead = fr.read
    cached = { siteRows: fr.siteRows, returns: fr.returns }
    for (const e of fr.read.errors) if (!errors.includes(e)) errors.push(e)
  }

  // Kill rule 4 on EVERY read: at/over the cap with the campaign still SERVING. A paused or
  // ended campaign (after the end date status stays ENABLED while serving_status is ENDED) at
  // the cap is the intended state: reported as such, never a pause proposal.
  let hardCapDaily: RuleResult | null = null
  if (spend.ok && !opts.healthOnly) {
    const state = status.ok ? servingStateOf(status.value) : 'unknown'
    const statusText = status.ok ? `${status.value.status}/${status.value.servingStatus}` : 'unreadable'
    const over = cumulative >= plan.hardCap
    hardCapDaily = {
      id: 'hard-cap',
      label: `cumulative spend at ${money(plan.hardCap)}`,
      limit: plan.hardCap,
      value: cumulative,
      status: !over ? 'not-armed' : !status.ok ? 'no-data' : state === 'serving' ? 'trip' : 'clear',
      detail: !over
        ? `${money(cumulative)} of ${money(plan.hardCap)}`
        : !status.ok
          ? `${money(cumulative)} at the cap; campaign status unreadable`
          : state === 'serving'
            ? `${money(cumulative)} at or over the cap and the campaign is still serving (${statusText})`
            : `${money(cumulative)} at the cap; campaign ${state === 'ended' ? 'ended' : state === 'paused' ? 'paused' : 'not serving'} (${statusText}), nothing to pause`,
    }
  }
  const campaignServing = status.ok ? servingStateOf(status.value) : 'unknown'

  let play = thresholdRead?.play ?? null
  if (!play) {
    const rs = beacon ? await attempt('beacon return sites', () => beacon.returnSites(WEB_GO_LIVE_UTC_MS)) : unavailable<ReturnSiteStat[]>('beacon return sites', deps.beaconInitError)
    if (rs.ok) play = playReturnStatus(rs.value, deps.nowMs)
    else if (!errors.includes(rs.error)) errors.push(rs.error)
  }

  const diagnostics: DiagnosticsSection = opts.healthOnly
    ? { spendThroughEt: null, hourly: null, geo: null, devices: null, targeting: null, recommendations: null, countryCounts: null, accountCrossCheck: null, errors: [] }
    : await diagnosticsRead(deps, campaign, plan.campaignId, spend.throughEt, taggedRows)

  const servedToday = spend.ok ? (spend.todayPartial?.cost ?? 0) > 0 : null
  const health: HealthSection =
    opts.releaseHealth === 'skip'
      ? { evaluated: false, reason: 'not evaluated: --release-health skip', results: null, alerts: 0 }
      : await releaseHealth(deps, campaign, taggedRows, cached, {
          minParent: opts.healthMinParent,
          parentAgeHours: opts.healthParentAgeHours,
          servedToday,
          requireServedToday: opts.healthOnly,
        })

  const records: ReadingRecord[] = []
  const notes: string[] = []
  if (!opts.healthOnly) {
    records.push({
      v: 1,
      id: readingId('daily', readAt, undefined, plan.campaignId),
      campaignId: plan.campaignId,
      kind: 'daily',
      readAt,
      etDate: todayEt,
      spendThroughEt: spend.throughEt,
      cumulativeSpend: spend.ok ? cumulative : null,
      thresholds: [],
      complete: spend.ok && taggedRows.ok,
      rules: hardCapDaily ? [hardCapDaily] : null,
      proposal: hardCapDaily?.status === 'trip' ? 'PROPOSE PAUSE' : null,
      decision: null,
      counts: {
        yesterdaySpend: spend.yesterday?.cost ?? null,
        yesterdayClicks: spend.yesterday?.clicks ?? null,
        yesterdayImpressions: spend.yesterday?.impressions ?? null,
        cumulativeClicks: spend.ok ? spend.cumulative.clicks : null,
        cumulativeImpressions: spend.ok ? spend.cumulative.impressions : null,
        taggedArrivals: tagged.cumulative?.taggedArrivals ?? null,
        taggedHits: tagged.cumulative?.taggedHits ?? null,
        asks: tagged.cumulative?.asks ?? null,
        accepts: tagged.cumulative?.accepts ?? null,
        authSuccess: tagged.cumulative?.authSuccess ?? null,
        taggedArrivalsYesterday: tagged.yesterday?.taggedArrivals ?? null,
        asksYesterday: tagged.yesterday?.asks ?? null,
      },
      notes: [
        status.ok ? `campaign ${status.value.status}/${status.value.servingStatus}` : 'campaign status unreadable',
        ...(play ? [play.line] : []),
        ...(missedReads.length ? [`previous scheduled read missing: ${missedReads.join(', ')}`] : []),
      ],
    })
  }
  if (thresholdRead) {
    records.push({
      v: 1,
      id: readingId('threshold', readAt, undefined, plan.campaignId),
      campaignId: plan.campaignId,
      kind: 'threshold',
      readAt,
      etDate: todayEt,
      spendThroughEt: thresholdRead.spendThroughEt,
      cumulativeSpend: thresholdRead.cumulativeSpend,
      thresholds: thresholdRead.thresholds,
      complete: thresholdRead.complete,
      rules: thresholdRead.kill.rules,
      proposal: thresholdRead.kill.proposal,
      decision: thresholdRead.decision,
      counts: fullReadCounts(thresholdRead),
      notes: [
        ...(thresholdRead.kill.tripped.length && thresholdRead.kill.proposal === null ? [noPauseNote(thresholdRead.kill.servingState, status.ok ? status.value : null)] : []),
        ...(thresholdRead.complete ? [] : [`incomplete read, thresholds not consumed: ${thresholdRead.errors.join('; ')}`]),
      ],
    })
    if (!thresholdRead.complete) notes.push('The threshold read was incomplete, so it does not consume the threshold: the next run retries it.')
  }
  if (hardCapDaily && hardCapDaily.status === 'clear' && records[0]?.kind === 'daily' && !canProposePause(campaignServing)) {
    records[0].notes.unshift(noPauseNote(campaignServing, status.ok ? status.value : null))
  }
  if (opts.healthOnly && health.evaluated) {
    records.push({
      v: 1,
      id: readingId('health', readAt, undefined, plan.campaignId),
      campaignId: plan.campaignId,
      kind: 'health',
      readAt,
      etDate: todayEt,
      spendThroughEt: spend.throughEt,
      cumulativeSpend: spend.ok ? cumulative : null,
      thresholds: [],
      complete: true,
      rules: null,
      proposal: null,
      decision: null,
      counts: Object.fromEntries((health.results ?? []).flatMap((h) => [[`${h.id}:parent`, h.parent], [`${h.id}:children`, h.children]])),
      notes: (health.results ?? []).filter((h) => h.status === 'alert').map((h) => `ALERT ${h.id}: ${h.parentLabel} ${h.parent}, ${h.childLabel} 0`),
    })
  }
  if (!consumedA.ok && crossedNow.length) notes.push('Threshold state was unreadable, so every crossed threshold was treated as new (a duplicate push is possible).')
  if (missedReads.length) notes.unshift(`Previous scheduled read missing: ${missedReads.join(', ')} (no daily reading on record for those ET dates).`)
  const campaignSyncError = sync.campaignSyncError
  if (campaignSyncError && !errors.includes(campaignSyncError)) errors.push(campaignSyncError)
  const w = !campaignSyncError
    ? await appendReadings(deps, plan.campaignId, todayEt, records)
    : { written: false, error: records.length ? 'readings not written: campaign sync failed' : null, dedup: { skipped: [], checkError: null } as DedupSection, isNew: () => true }
  if (w.error) errors.push(w.error)
  if (w.dedup.checkError) errors.push(w.dedup.checkError)
  if (w.dedup.skipped.length) notes.unshift(`Already recorded today, not stored or pushed again: ${w.dedup.skipped.map((s) => s.entryKind).join(', ')}.`)
  const storeErrors = [campaignSyncError, spend.storeError, w.error].filter((e): e is string => !!e)

  const failed = morningFailures({
    healthOnly: opts.healthOnly,
    dryRun: deps.dryRun,
    statusError: status.ok ? null : status.error,
    spendError: spend.ok ? null : spend.error,
    taggedError: taggedRows.ok ? null : taggedRows.error,
    thresholdStateError: consumedA.ok ? null : consumedA.error,
    storeErrors,
    healthReadError: health.readError ? health.reason : null,
    thresholdReadFailures: thresholdRead?.failedDetails,
  })
  const result: MorningResult = {
    tool: 'morning-read',
    version: 1,
    mode: opts.healthOnly ? 'health-only' : 'morning',
    dryRun: deps.dryRun,
    readAt,
    etDate: todayEt,
    campaign: header(campaign),
    status: status.ok ? status.value : null,
    statusError: status.ok ? null : status.error,
    spend,
    thresholds: { crossedNow, consumedBefore: consumed, next: nextThreshold(cumulative, plan.thresholds), stateError: consumedA.ok ? null : consumedA.error },
    tagged,
    thresholdRead,
    hardCapDaily,
    releaseHealth: health,
    diagnostics,
    play,
    store: {
      kind: deps.store.kind,
      dryRun: deps.dryRun,
      campaignsSynced: sync.campaignsSynced,
      spendWritten: spend.storeWritten,
      readingsWritten: w.written,
      errors: storeErrors,
    },
    failures: failed.names,
    failureDetails: failed.details,
    missedReads,
    dedup: w.dedup,
    notify: { push: false, busCopy: false, reason: opts.healthOnly ? 'no release-health alert' : 'quiet day: no threshold crossed, no kill rule tripped', text: null },
    errors,
    notes: [...notes, ...STANDING_NOTES, ...(thresholdRead ? [INSTALL_OUTCOME_GAP_NOTE] : [])],
  }
  // Push on: a threshold read, a kill-rule trip, a failed read (money is at stake, silence is
  // worse than one extra ping), or — backstop only — a real release-health ALERT (parent at or
  // above MIN_COHORT, outcome window elapsed, child zero). A "watch" never pushes.
  // A pause proposal, not a bare rule trip: a tripped rule on an ended campaign proposes nothing.
  // A same-day rerun whose record repeats one already stored (and so already pushed) does not
  // push that threshold, trip or alert again; a failed read always pushes.
  const newThreshold = !!thresholdRead && !repeatedToday(result, 'threshold')
  const newCapTrip = hardCapDaily?.status === 'trip' && !repeatedToday(result, 'daily')
  const killTrip = (newThreshold && thresholdRead?.kill.proposal === 'PROPOSE PAUSE') || newCapTrip
  const healthAlert = opts.healthOnly && health.alerts > 0 && !repeatedToday(result, 'health')
  const reasons: string[] = []
  if (newThreshold) reasons.push(`threshold read at $${Math.max(...thresholdRead!.thresholds)}`)
  if (killTrip) reasons.push(newThreshold ? 'kill-rule trip' : 'kill-rule trip (hard cap, campaign still enabled)')
  if (healthAlert) reasons.push(`release-health alert (${health.alerts})`)
  if (result.failures.length) reasons.push(`failed read: ${result.failures.join(', ')}`)
  if (reasons.length) {
    result.notify = { push: true, busCopy: newThreshold, reason: reasons.join('; '), text: morningPushText(result) }
  } else if (w.dedup.skipped.length) {
    result.notify.reason = `already recorded and pushed today (${w.dedup.skipped.map((s) => s.entryKind).join(', ')}); not pushed again`
  }
  return result
}

// ── postflight-read ──────────────────────────────────────────────────────────────────────
export interface PostflightOptions {
  campaignId: string
  stage: PostflightStage
  force: boolean
}
export interface PostflightResult {
  tool: 'postflight-read'
  version: 1
  dryRun: boolean
  readAt: string
  etDate: string
  stage: PostflightStage
  campaign: CampaignHeader
  status: CampaignStatus | null
  statusError: string | null
  spend: SpendSection
  spendEndEt: string | null
  dueEt: string | null
  due: boolean
  read: FullRead | null
  /** Promo vs non-promo, anonymous: beacon outcome counts by dialog, plus Firestore window
   * counts when read. */
  promoSplit: {
    beacon: { promo: Record<OutcomeType, number>; nonPromo: Record<OutcomeType, number>; promoShown: number; nonPromoShown: number } | null
    accounts: { newInWindow: number | null; promoClaimsInWindow: number | null; nonPromoInWindow: number | null } | null
  }
  postFlightSpend: RuleResult | null
  /** The $100 cap, re-checked post-flight (a pause only for a campaign still serving). */
  hardCap: RuleResult | null
  /** Day-15/30/60 only: accounts created in the flight window by access tier and promo
   * marker — Firestore COUNTs, SITEWIDE, not campaign-attributed. null = not read. */
  cohort: CohortTiers | null
  /** Why the cohort is missing on a stage that wants it (e.g. a composite index). */
  cohortNote: string | null
  /** Post-flight recommendations (proposals only; beacon changes wait for the freeze to end). */
  recommendations: string[]
  store: StoreSection
  /** Short, secret-free names of the reads that failed. */
  failures: string[]
  /** "<name> (<one-line reason>)" for each failure (review L9). */
  failureDetails: string[]
  /** A same-day rerun of a stage already recorded: not stored, not pushed or copied again. */
  dedup: DedupSection
  notify: Notify
  errors: string[]
  notes: string[]
}

export async function runPostflightRead(deps: ReadDeps, opts: PostflightOptions): Promise<PostflightResult> {
  const { plan, campaign } = readPlanFor(opts.campaignId)
  const readAt = new Date(deps.nowMs).toISOString()
  const todayEt = etDateFromMs(deps.nowMs)
  const errors: string[] = []

  const status = deps.ads ? await attempt('ads status', () => deps.ads!.status(plan.campaignId)) : unavailable<CampaignStatus>('ads status', deps.adsInitError)
  if (!status.ok) errors.push(status.error)
  // The shared sync first; `stored` also carries today's partial day for the after-flight check.
  const { section: spend, stored, sync, campaignSync } = await syncSpend(deps, plan, campaign, todayEt, 'postflight-read')
  if (spend.error) errors.push(spend.error)
  if (spend.storeError) errors.push(spend.storeError)
  if (sync.campaignSyncError && !errors.includes(sync.campaignSyncError)) errors.push(sync.campaignSyncError)

  const spendEndEt = stored ? lastSpendDate(stored) : null
  const dueEt = postflightDueDate(opts.stage, campaign.flightEnd)
  const due = todayEt >= dueEt
  const base: PostflightResult = {
    tool: 'postflight-read',
    version: 1,
    dryRun: deps.dryRun,
    readAt,
    etDate: todayEt,
    stage: opts.stage,
    campaign: header(campaign),
    status: status.ok ? status.value : null,
    statusError: status.ok ? null : status.error,
    spend,
    spendEndEt,
    dueEt,
    due,
    read: null,
    promoSplit: { beacon: null, accounts: null },
    postFlightSpend: null,
    hardCap: null,
    cohort: null,
    cohortNote: null,
    recommendations: [],
    failures: [],
    failureDetails: [],
    dedup: { skipped: [], checkError: null },
    store: {
      kind: deps.store.kind,
      dryRun: deps.dryRun,
      campaignsSynced: sync.campaignsSynced,
      spendWritten: spend.storeWritten,
      readingsWritten: false,
      errors: [sync.campaignSyncError, spend.storeError].filter((e): e is string => !!e),
    },
    notify: { push: false, busCopy: false, reason: '', text: null },
    errors,
    notes: [...STANDING_NOTES],
  }
  const addFailure = (name: string, err: string | null | undefined) => {
    if (!err || base.failures.includes(name)) return
    base.failures.push(name)
    base.failureDetails.push(`${name} (${summarizeError(err)})`)
  }
  addFailure(!spend.ok && /^store /.test(spend.error ?? '') ? 'store read' : 'Google Ads spend', spend.ok ? null : spend.error)
  addFailure('campaign status', status.ok ? null : status.error)

  // The after-flight spend and cap checks run FIRST, on every post-flight run, due or not
  // (review M1): continued spend must never be silenced by a stage that is not due yet.
  if (stored && spend.ok) {
    const after = Object.entries(stored.days).filter(([d, v]) => d > campaign.flightEnd && v.costMicros > 0)
    const afterCost = round2(after.reduce((a, [, v]) => a + microsToDollars(v.costMicros), 0))
    // Only a campaign that is still serving (or unreadable) gets a pause proposal; after the
    // end date it reads ENABLED/ENDED and there is nothing to pause.
    const state = status.ok ? servingStateOf(status.value) : 'unknown'
    const statusText = status.ok ? `${status.value.status}/${status.value.servingStatus}` : 'unreadable'
    const notServing = `${state === 'ended' ? 'ended' : state === 'paused' ? 'paused' : 'not serving'} (${statusText}), nothing to pause`
    base.postFlightSpend = {
      id: 'hard-cap',
      label: 'no spend after the flight',
      limit: 0,
      value: afterCost,
      status: afterCost > 0 && canProposePause(state) ? 'trip' : 'clear',
      detail:
        afterCost > 0
          ? `${money(afterCost)} spent after ${campaign.flightEnd}; campaign ${canProposePause(state) ? `reads ${statusText}` : notServing}`
          : `no spend after ${campaign.flightEnd}`,
    }
    const cum = spend.cumulative.cost
    base.hardCap = {
      id: 'hard-cap',
      label: `cumulative spend at ${money(plan.hardCap)}`,
      limit: plan.hardCap,
      value: cum,
      status: cum < plan.hardCap ? 'not-armed' : canProposePause(state) ? 'trip' : 'clear',
      detail:
        cum < plan.hardCap
          ? `${money(cum)} of ${money(plan.hardCap)}`
          : canProposePause(state)
            ? `${money(cum)} at or over the cap and the campaign reads ${statusText}`
            : `${money(cum)} at the cap; campaign ${notServing}`,
    }
  }
  const spendTrip = base.postFlightSpend?.status === 'trip' || base.hardCap?.status === 'trip'
  const spendTripText = () =>
    `BSK retest after the flight: ${[base.postFlightSpend?.status === 'trip' ? base.postFlightSpend.detail : null, base.hardCap?.status === 'trip' ? base.hardCap.detail : null].filter(Boolean).join('; ')}. PROPOSE PAUSE.`

  if (!due && !opts.force) {
    base.notify.reason = `not due until ${dueEt} ET; nothing recorded`
    // A spend trip or a failed read still pushes (the stage itself waits for its date).
    if (spendTrip) {
      base.notify = { push: true, busCopy: false, reason: `after-flight spend or cap trip (stage not due until ${dueEt})`, text: spendTripText() }
    } else if (base.failures.length) {
      base.notify = { push: true, busCopy: false, reason: `failed read: ${base.failures.join(', ')}`, text: `BSK retest ${opts.stage} read FAILED: ${base.failureDetails.join('; ')}.` }
    }
    return base
  }

  const beacon = deps.beacon
  const taggedRows = beacon ? await attempt('beacon tagged', () => beacon.tagged(campaign, deps.boundaries?.upsellFixAtMs)) : unavailable<TaggedRow[]>('beacon tagged', deps.beaconInitError)
  const wantsCohort = COHORT_TIER_STAGES.includes(opts.stage)
  const { read } = await fullRead(deps, {
    plan,
    campaign,
    thresholds: [],
    spendThroughEt: spend.throughEt,
    stored,
    campaignSync,
    tagged: taggedRows,
    forceDecision: true,
    readAt,
    campaignState: status.ok ? status.value : null,
    cohortTiersAtMs: wantsCohort ? deps.nowMs : null,
  })
  for (const e of read.errors) if (!errors.includes(e)) errors.push(e)
  base.read = read

  if (read.site) {
    const o = read.site.summary.outcomes
    base.promoSplit.beacon = {
      promo: { ...o['promo-first50'] },
      nonPromo: { ...o['signin-prompt'] },
      promoShown: read.site.summary.shown['promo-first50'],
      nonPromoShown: read.site.summary.shown['signin-prompt'],
    }
  }
  if (read.firebase) {
    const n = read.firebase.newAccountsInWindow
    const p = read.firebase.promoClaimsInWindow
    base.promoSplit.accounts = { newInWindow: n, promoClaimsInWindow: p, nonPromoInWindow: n != null && p != null ? Math.max(0, n - p) : null }
  }
  if (wantsCohort) {
    if (read.firebase?.cohortTiers) base.cohort = deriveCohortTiers(read.firebase.cohortTiers)
    else {
      // Degrade gracefully: the plain window count (Accounts line) still stands.
      const err = read.firebase?.errors.find((e) => e.startsWith('cohort ')) ?? null
      base.cohortNote = !deps.firebase
        ? 'tier split not read (no --firebase-sa)'
        : err && /composite index/.test(err)
          ? 'tier split unavailable: index missing'
          : `tier split unavailable${err ? `: ${err}` : ''}`
    }
  }
  // Moot once /auth/success/<provider>/new|existing is live.
  const authLiveAt = deps.boundaries?.authNewExistingLiveAtMs === undefined ? AUTH_NEW_EXISTING_LIVE_AT : deps.boundaries.authNewExistingLiveAtMs
  if (authLiveAt == null) base.recommendations.push(AUTH_SUCCESS_SPLIT_RECOMMENDATION)

  const rec: ReadingRecord = {
    v: 1,
    id: readingId('postflight', readAt, opts.stage, plan.campaignId),
    campaignId: plan.campaignId,
    kind: 'postflight',
    stage: opts.stage,
    readAt,
    etDate: todayEt,
    spendThroughEt: spend.throughEt,
    cumulativeSpend: spend.ok ? spend.cumulative.cost : null,
    thresholds: [],
    complete: read.complete,
    rules: [base.postFlightSpend, base.hardCap].filter((x): x is RuleResult => !!x),
    proposal: spendTrip ? 'PROPOSE PAUSE' : null,
    decision: read.decision,
    counts: {
      ...fullReadCounts(read),
      promoOutcomesSignedIn: base.promoSplit.beacon?.promo['signed-in'] ?? null,
      promoOutcomesStillPlaying: base.promoSplit.beacon?.promo['still-playing'] ?? null,
      nonPromoOutcomesSignedIn: base.promoSplit.beacon?.nonPromo['signed-in'] ?? null,
      nonPromoOutcomesStillPlaying: base.promoSplit.beacon?.nonPromo['still-playing'] ?? null,
      nonPromoAccountsInWindow: base.promoSplit.accounts?.nonPromoInWindow ?? null,
    },
    notes: [...(read.complete ? [] : [`incomplete: ${read.errors.join('; ')}`]), ...base.recommendations],
  }
  if (base.cohort) {
    Object.assign(rec.counts, {
      cohortTotal: base.cohort.total,
      cohortPaid: base.cohort.paid,
      cohortTrialActive: base.cohort.trialActive,
      cohortExpired: base.cohort.expired,
      cohortPromoSet: base.cohort.promoSet,
      cohortPromoUnset: base.cohort.promoUnset,
    })
  }
  const w = !sync.campaignSyncError
    ? await appendReadings(deps, plan.campaignId, todayEt, [rec])
    : { written: false, error: 'readings not written: campaign sync failed', dedup: { skipped: [], checkError: null } as DedupSection, isNew: () => true }
  if (w.error) {
    errors.push(w.error)
    base.store.errors.push(w.error)
  }
  if (w.dedup.checkError) errors.push(w.dedup.checkError)
  base.dedup = w.dedup
  base.store.readingsWritten = w.written

  const trip = spendTrip
  for (const f of read.failedDetails) {
    if (base.failures.includes(f.name)) continue
    base.failures.push(f.name)
    base.failureDetails.push(`${f.name} (${f.reason})`)
  }
  if (!base.store.dryRun && base.store.errors.length) addFailure('store write', base.store.errors[0])
  const failed = base.failureDetails.length ? ` Read problems: ${base.failureDetails.join('; ')}.` : ''
  if (!w.isNew(rec.id)) {
    // A same-day rerun of a stage already recorded (and pushed): nothing new to send, unless a
    // read failed.
    const already = `post-flight ${opts.stage} already recorded and pushed today (${w.dedup.skipped.map((s) => s.entryKind).join(', ')})`
    base.notes.unshift(`${already}; this rerun was not stored.`)
    base.notify = base.failures.length
      ? { push: true, busCopy: false, reason: `${already}; failed read: ${base.failures.join(', ')}`, text: `BSK retest ${opts.stage} read FAILED: ${base.failureDetails.join('; ')}.` }
      : { push: false, busCopy: false, reason: `${already}; not pushed again`, text: null }
    base.notes.push(INSTALL_OUTCOME_GAP_NOTE)
    return base
  }
  base.notify = {
    push: true,
    busCopy: true,
    reason: `post-flight ${opts.stage} read (a scheduled spec read)${trip ? ' with spend after the flight' : ''}${base.failures.length ? `; failed read: ${base.failures.join(', ')}` : ''}`,
    text: `BSK retest ${opts.stage} read: ${money(spend.cumulative.cost)} total, ${read.tagged?.summary.taggedArrivals ?? '?'} tagged arrivals, ${read.decision ? `${signUpsPhrase(read.decision)}, row ${read.decision.row}` : 'no decision'}${read.segments ? '; split at the upsell fix (see report)' : ''}${trip ? `; PROPOSE PAUSE (${base.postFlightSpend?.status === 'trip' ? `spend after ${campaign.flightEnd}` : 'at the cap'})` : ''}.${failed}`,
  }
  base.notes.push(INSTALL_OUTCOME_GAP_NOTE)
  return base
}
