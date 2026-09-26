// Orchestration for the CLIs (morning-read.ts, postflight-read.ts). Every data source is
// injected (ReadDeps), so the whole flow runs against a recorded fixture in tests and under
// --fixture, and against the live Ads API / beacon D1 / gss-stats-ads otherwise. The rules
// themselves are the pure functions in src/lib/adsRules.ts; this file only sequences reads,
// decides what fires, and shapes the result that report.ts prints.
//
// Invariants:
//  - PROPOSE only. Nothing here can change a campaign; proposals are strings.
//  - A rule is evaluated only on data that came back (`no-data` otherwise), and a threshold
//    is consumed only by a COMPLETE read, so a failed read is retried next run.
//  - --dry-run: every read happens, no store write does.

import {
  ADS_API_VERSION,
  ADS_CUSTOMER_ID,
  buildHealthPairs,
  decideAt100,
  evaluateHealthPairs,
  evaluateKillRules,
  lastSpendDate,
  mergeSpend,
  microsToDollars,
  newlyCrossedThresholds,
  nextThreshold,
  outcomeRates,
  placementOutsideShare,
  playReturnStatus,
  postflightDueDate,
  readingId,
  readPlanFor,
  releaseHealthGate,
  round2,
  signUpsForDecision,
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
import type { PlacementDayRow } from '../../src/lib/adsStore'
import { ARRIVALS_CAVEAT, CAMPAIGNS, costPer, etMidnightUtcMs, etTimeUtcMs, funnelStepRates, type CampaignFlight, type FunnelStepKey } from '../../src/lib/campaigns'
import { etDateFromMs, gateRate, INSTALL_ACCEPT_OUTCOME_FIXED_ET, SMALL_SAMPLE_NOTE, type GatedRate, type HourPathCount } from '../../src/lib/popupEvents'
import { addEtDays } from '../../src/lib/overview'
import { splitPlacements, type CampaignStatus } from './adsApi'
import type { BeaconSource } from './beacon'
import type { AdsStore } from './d1Store'
import type { FirebaseCounts } from './firebase'
import { redact } from './redact'

// ── Dependencies ─────────────────────────────────────────────────────────────────────────
export interface AdsSource {
  status(campaignId: string): Promise<CampaignStatus>
  daily(campaignId: string, since: string, until: string): Promise<Record<string, SpendDay>>
  placements(campaignId: string, since: string, until: string): Promise<PlacementDayRow[]>
}
export interface FirebaseSource {
  counts(windowStartMs: number, windowEndMs: number): Promise<FirebaseCounts>
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
  placements: { campaignCost: number; approvedCost: number; itemizedCost: number; outsideShare: number | null; offList: { name: string; cost: number }[]; stored: boolean } | null
  kill: KillRuleEvaluation
  decision: (DecisionResult & { signUps: number; basis: string }) | null
  tagged: {
    summary: TaggedSummary
    funnelRates: Partial<Record<FunnelStepKey, number | null>>
    askRate: GatedRate
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

/** Upserts every configured campaign so stored rows can reference it (FOREIGN KEY). */
async function syncCampaigns(deps: ReadDeps, readAt: string): Promise<Attempt<boolean>> {
  return attempt('store sync (campaigns)', () => deps.store.syncCampaigns(CAMPAIGNS.filter((c) => c.flightStart != null), readAt))
}

// ── Spend: fetch from the Ads API, upsert into the store ────────────────────────────────
async function fetchSpend(
  deps: ReadDeps,
  plan: AdsReadPlan,
  campaign: CampaignFlight,
  todayEt: string,
  write: boolean,
): Promise<{ section: SpendSection; stored: StoredSpend | null }> {
  const yesterdayEt = addEtDays(todayEt, -1)
  const closedThroughEt = yesterdayEt >= campaign.flightStart! ? yesterdayEt : null
  const base: SpendSection = {
    ok: false,
    error: null,
    throughEt: closedThroughEt,
    yesterday: null,
    cumulative: { cost: 0, impressions: 0, clicks: 0, days: 0 },
    todayPartial: null,
    dailyBudget: plan.dailyBudget,
    hardCap: plan.hardCap,
    restated: [],
    storeWritten: false,
    storeError: null,
  }
  const daily = deps.ads ? await attempt('ads daily', () => deps.ads!.daily(plan.campaignId, campaign.flightStart!, todayEt)) : unavailable<Record<string, SpendDay>>('ads daily', deps.adsInitError)
  if (!daily.ok) return { section: { ...base, error: daily.error }, stored: null }

  const fetchedAt = new Date(deps.nowMs).toISOString()
  const existing = await attempt('store read (spend)', () => deps.store.getSpend(plan.campaignId))
  const incoming: StoredSpend = { v: 1, campaignId: plan.campaignId, source: 'google-ads-api', apiVersion: ADS_API_VERSION, customerId: ADS_CUSTOMER_ID, fetchedAt, closedThroughEt, days: daily.value }
  const { merged, restated } = mergeSpend(existing.ok ? existing.value : null, incoming)
  let storeWritten = false
  let storeError: string | null = existing.ok ? null : existing.error
  if (write) {
    const put = await attempt('store write (daily metrics)', () => deps.store.putDailyMetrics(plan.campaignId, daily.value, fetchedAt))
    if (put.ok) storeWritten = put.value
    else storeError = put.error
  }
  const cum = spendTotals(merged, closedThroughEt ?? addEtDays(campaign.flightStart!, -1))
  return {
    stored: merged,
    section: {
      ...base,
      ok: true,
      yesterday: closedThroughEt ? { date: closedThroughEt, ...(dayDollars(merged.days[closedThroughEt]) ?? { cost: 0, impressions: 0, clicks: 0 }) } : null,
      cumulative: { cost: cum.cost, impressions: cum.impressions, clicks: cum.clicks, days: cum.days },
      todayPartial: dayDollars(merged.days[todayEt]),
      restated: restated.map((r) => ({ date: r.date, before: round2(microsToDollars(r.beforeMicros)), after: round2(microsToDollars(r.afterMicros)) })),
      storeWritten,
      storeError,
    },
  }
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
  tagged: Attempt<TaggedRow[]>
  /** Whether to evaluate the $100 decision table regardless of spend (post-flight). */
  forceDecision: boolean
  readAt: string
}
async function fullRead(deps: ReadDeps, i: FullReadInput): Promise<{ read: FullRead; siteRows: Attempt<HourPathCount[]>; returns: Attempt<ReturnSummary> }> {
  const { plan, campaign } = i
  const errors: string[] = []
  const totals = spendTotals(i.stored, i.spendThroughEt ?? addEtDays(campaign.flightStart!, -1))
  const cumulativeSpend = totals.cost

  const placementRows =
    deps.ads && i.spendThroughEt
      ? await attempt('ads placements', () => deps.ads!.placements(plan.campaignId, campaign.flightStart!, i.spendThroughEt!))
      : unavailable<PlacementDayRow[]>('ads placements', deps.ads ? 'no closed spend day yet' : deps.adsInitError)
  let placementsStored = false
  if (placementRows.ok) {
    const put = await attempt('store write (placements)', () => deps.store.putPlacements(plan.campaignId, placementRows.value, i.readAt))
    if (put.ok) placementsStored = put.value
    else errors.push(put.error)
  }
  const beacon = deps.beacon
  const siteRows = beacon ? await attempt('beacon site events', () => beacon.siteEvents(WEB_GO_LIVE_UTC_MS)) : unavailable<HourPathCount[]>('beacon site events', deps.beaconInitError)
  const returnRaw = beacon ? await attempt('beacon returns', () => beacon.returns(campaign)) : unavailable<ReturnRow[]>('beacon returns', deps.beaconInitError)
  const returnSites = beacon ? await attempt('beacon return sites', () => beacon.returnSites(WEB_GO_LIVE_UTC_MS)) : unavailable<ReturnSiteStat[]>('beacon return sites', deps.beaconInitError)
  const windowEnd = Math.min(deps.nowMs, flightEndExclusiveMs(campaign))
  const fb = deps.firebase ? await attempt('firebase counts', () => deps.firebase!.counts(attributionStartMs(campaign), windowEnd)) : null

  for (const a of [placementRows, i.tagged, siteRows, returnRaw, returnSites]) if (!a.ok) errors.push(a.error)
  if (fb && !fb.ok) errors.push(fb.error)
  if (fb && fb.ok) for (const e of fb.value.errors) errors.push(`firebase: ${e}`)

  let tagged: FullRead['tagged'] = null
  if (i.tagged.ok) {
    const summary = summarizeTaggedRows(i.tagged.value)
    tagged = {
      summary,
      funnelRates: funnelStepRates(summary.funnel),
      askRate: gateRate(summary.asks.total, summary.taggedArrivals),
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
          .map((p) => ({ name: String(p.displayName ?? p.placement), cost: round2(p.costMicros / 1e6) })),
        stored: placementsStored,
      }
    : null

  const kill = evaluateKillRules({
    plan,
    cumulativeSpend,
    delivery: i.stored && i.spendThroughEt ? { impressions: totals.impressions, clicks: totals.clicks } : null,
    placements: split ? { campaignCost: cumulativeSpend, approvedCost: split.approvedCost, itemizedCost: split.itemizedCost } : null,
    beacon: tagged ? { asks: tagged.summary.asks.total, taggedArrivals: tagged.summary.taggedArrivals } : null,
  })

  let decision: FullRead['decision'] = null
  if (tagged && (i.forceDecision || cumulativeSpend >= plan.hardCap)) {
    const windowAccounts = fb && fb.ok ? fb.value.newAccountsInWindow : null
    const signUps = signUpsForDecision(tagged.summary.authSuccess, windowAccounts)
    decision = {
      ...decideAt100({ signUps, asks: tagged.summary.asks.total, accepts: tagged.summary.accepts.total }),
      signUps,
      basis:
        windowAccounts == null
          ? `${tagged.summary.authSuccess} tagged auth successes (new prod accounts in the window not read)`
          : `min(${tagged.summary.authSuccess} tagged auth successes, ${windowAccounts} new prod accounts in the flight window)`,
    }
  }

  const complete = placementRows.ok && i.tagged.ok && siteRows.ok && returnRaw.ok && returnSites.ok && i.stored != null
  return {
    read: { thresholds: i.thresholds, spendThroughEt: i.spendThroughEt, cumulativeSpend, complete, errors, placements: placementView, kill, decision, tagged, site, returns, play, firebase: fb && fb.ok ? fb.value : null },
    siteRows,
    returns: returns ? { ok: true, value: returns } : { ok: false, error: returnRaw.ok ? 'returns unavailable' : returnRaw.error },
  }
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
    signUpsForDecision: r.decision?.signUps ?? null,
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
  const gate = releaseHealthGate(deps.nowMs)
  if (!gate.evaluate) return { evaluated: false, reason: gate.reason, results: null, alerts: 0 }
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
    return { evaluated: false, reason: `not evaluated: ${why.join('; ')}`, results: null, alerts: 0 }
  }
  const maturedBefore = deps.nowMs - opts.parentAgeHours * 3_600_000
  const installFrom = INSTALL_ACCEPT_OUTCOME_FIXED_ET ? etMidnightUtcMs(INSTALL_ACCEPT_OUTCOME_FIXED_ET) : undefined
  const site = summarizeSiteEvents(siteRows.value, maturedBefore, installFrom)
  const arrivalsMatured = tagged.value.filter((r) => r.visitor === 'new' && r.hourStartMs + 2 * 3_600_000 <= deps.nowMs).reduce((a, r) => a + r.count, 0)
  const results = evaluateHealthPairs(buildHealthPairs({ site, taggedArrivalsMatured: arrivalsMatured, returnD0Web: returns.value.web.d0 }), opts.minParent)
  return { evaluated: true, reason: gate.reason, results, alerts: results.filter((r) => r.status === 'alert').length }
}

async function appendReadings(deps: ReadDeps, records: ReadingRecord[]): Promise<{ written: boolean; error: string | null }> {
  if (!records.length) return { written: false, error: null }
  const put = await attempt('store write (readings)', () => deps.store.appendReadings(records))
  return put.ok ? { written: put.value, error: null } : { written: false, error: put.error }
}

// ── morning-read ─────────────────────────────────────────────────────────────────────────
export interface MorningOptions {
  campaignId: string
  /** 'auto' evaluates release health when the ET clock allows; 'skip' never does. */
  releaseHealth: 'auto' | 'skip'
  /** Backstop mode: status + today's spend + release health only (run after 23:00 ET). */
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
  play: PlayReturnStatus | null
  store: StoreSection
  notify: Notify
  errors: string[]
  notes: string[]
}

export function morningPushText(r: MorningResult): string | null {
  if (r.thresholdRead) {
    const t = r.thresholdRead
    const bits = [`BSK retest $${Math.max(...t.thresholds)} read: ${money(t.cumulativeSpend)} spent`]
    const tc = t.tagged?.summary
    if (tc) bits.push(`${tc.taggedArrivals} tagged arrivals, ${tc.asks.total} asks, ${tc.authSuccess} auth successes`)
    if (t.kill.tripped.length) bits.push(`PROPOSE PAUSE (${t.kill.tripped.join(', ')})`)
    else bits.push(t.complete ? 'no kill rule tripped, continue' : 'read incomplete, will retry')
    if (t.decision) bits.push(`decision row: ${t.decision.row}`)
    return bits.join('; ') + '.'
  }
  if (r.hardCapDaily?.status === 'trip') {
    return `BSK retest: ${money(r.spend.cumulative.cost)} spent, at or over the ${money(r.spend.hardCap)} cap, campaign still ${r.status?.status ?? 'ENABLED'}. PROPOSE PAUSE.`
  }
  return null
}

export async function runMorningRead(deps: ReadDeps, opts: MorningOptions): Promise<MorningResult> {
  const { plan, campaign } = readPlanFor(opts.campaignId)
  const readAt = new Date(deps.nowMs).toISOString()
  const todayEt = etDateFromMs(deps.nowMs)
  const yesterdayEt = addEtDays(todayEt, -1)
  const errors: string[] = []

  const sync = opts.healthOnly ? ({ ok: true, value: false } as Attempt<boolean>) : await syncCampaigns(deps, readAt)
  if (!sync.ok) errors.push(sync.error)

  const status = deps.ads ? await attempt('ads status', () => deps.ads!.status(plan.campaignId)) : unavailable<CampaignStatus>('ads status', deps.adsInitError)
  if (!status.ok) errors.push(status.error)

  const { section: spend, stored } = await fetchSpend(deps, plan, campaign, todayEt, !opts.healthOnly && sync.ok)
  if (spend.error) errors.push(spend.error)
  if (spend.storeError) errors.push(spend.storeError)

  const consumedA = await attempt('store read (threshold state)', () => deps.store.getConsumedThresholds(plan.campaignId))
  if (!consumedA.ok) errors.push(consumedA.error)
  // If the state is unreadable, treat nothing as consumed: a duplicate push beats a missed
  // $50 kill-rule read. The report says so.
  const consumed = consumedA.ok ? consumedA.value : []
  const cumulative = spend.cumulative.cost
  const crossedNow = spend.ok && !opts.healthOnly ? newlyCrossedThresholds(cumulative, plan.thresholds, consumed) : []

  const beacon = deps.beacon
  const taggedRows = beacon ? await attempt('beacon tagged', () => beacon.tagged(campaign)) : unavailable<TaggedRow[]>('beacon tagged', deps.beaconInitError)
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
    const fr = await fullRead(deps, { plan, campaign, thresholds: crossedNow, spendThroughEt: spend.throughEt, stored, tagged: taggedRows, forceDecision: false, readAt })
    thresholdRead = fr.read
    cached = { siteRows: fr.siteRows, returns: fr.returns }
    for (const e of fr.read.errors) if (!errors.includes(e)) errors.push(e)
  }

  // Kill rule 4 on EVERY read: at/over the cap with the campaign still enabled. A PAUSED
  // campaign at the cap is the intended state, never a trip.
  let hardCapDaily: RuleResult | null = null
  if (spend.ok && !opts.healthOnly) {
    const enabled = status.ok ? status.value.status === 'ENABLED' : null
    const over = cumulative >= plan.hardCap
    hardCapDaily = {
      id: 'hard-cap',
      label: `cumulative spend at ${money(plan.hardCap)}`,
      limit: plan.hardCap,
      value: cumulative,
      status: over ? (enabled === false ? 'clear' : enabled === null ? 'no-data' : 'trip') : 'not-armed',
      detail: over
        ? enabled === false
          ? `${money(cumulative)} at the cap and the campaign reads ${status.ok ? status.value.status : '?'} (intended state)`
          : enabled === null
            ? `${money(cumulative)} at the cap; campaign status unreadable`
            : `${money(cumulative)} at or over the cap and the campaign still reads ENABLED`
        : `${money(cumulative)} of ${money(plan.hardCap)}`,
    }
  }

  let play = thresholdRead?.play ?? null
  if (!play) {
    const rs = beacon ? await attempt('beacon return sites', () => beacon.returnSites(WEB_GO_LIVE_UTC_MS)) : unavailable<ReturnSiteStat[]>('beacon return sites', deps.beaconInitError)
    if (rs.ok) play = playReturnStatus(rs.value, deps.nowMs)
    else if (!errors.includes(rs.error)) errors.push(rs.error)
  }

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
      notes: [status.ok ? `campaign ${status.value.status}/${status.value.servingStatus}` : 'campaign status unreadable', ...(play ? [play.line] : [])],
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
      notes: thresholdRead.complete ? [] : [`incomplete read, thresholds not consumed: ${thresholdRead.errors.join('; ')}`],
    })
    if (!thresholdRead.complete) notes.push('The threshold read was incomplete, so it does not consume the threshold: the next run retries it.')
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
  const w = sync.ok ? await appendReadings(deps, records) : { written: false, error: records.length ? 'readings not written: campaign sync failed' : null }
  if (w.error) errors.push(w.error)

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
    play,
    store: {
      kind: deps.store.kind,
      dryRun: deps.dryRun,
      campaignsSynced: sync.ok && sync.value,
      spendWritten: spend.storeWritten,
      readingsWritten: w.written,
      errors: [sync.ok ? null : sync.error, spend.storeError, w.error].filter((e): e is string => !!e),
    },
    notify: { push: false, busCopy: false, reason: 'quiet day: no threshold crossed, no kill rule tripped', text: null },
    errors,
    notes: [...notes, ...STANDING_NOTES, ...(thresholdRead ? [INSTALL_OUTCOME_GAP_NOTE] : [])],
  }
  const killTrip = (thresholdRead?.kill.tripped.length ?? 0) > 0 || hardCapDaily?.status === 'trip'
  if (thresholdRead || killTrip) {
    result.notify = {
      push: true,
      busCopy: !!thresholdRead,
      reason: thresholdRead ? `threshold read at $${Math.max(...thresholdRead.thresholds)}${killTrip ? ' with a kill-rule trip' : ''}` : 'kill-rule trip (hard cap, campaign still enabled)',
      text: morningPushText(result),
    }
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
  store: StoreSection
  notify: Notify
  errors: string[]
  notes: string[]
}

export async function runPostflightRead(deps: ReadDeps, opts: PostflightOptions): Promise<PostflightResult> {
  const { plan, campaign } = readPlanFor(opts.campaignId)
  const readAt = new Date(deps.nowMs).toISOString()
  const todayEt = etDateFromMs(deps.nowMs)
  const errors: string[] = []

  const sync = await syncCampaigns(deps, readAt)
  if (!sync.ok) errors.push(sync.error)
  const status = deps.ads ? await attempt('ads status', () => deps.ads!.status(plan.campaignId)) : unavailable<CampaignStatus>('ads status', deps.adsInitError)
  if (!status.ok) errors.push(status.error)
  const { section: spend, stored } = await fetchSpend(deps, plan, campaign, todayEt, sync.ok)
  if (spend.error) errors.push(spend.error)
  if (spend.storeError) errors.push(spend.storeError)

  const spendEndEt = stored ? lastSpendDate(stored) : null
  const dueEt = postflightDueDate(opts.stage, spendEndEt ?? campaign.flightEnd, campaign.flightEnd)
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
    store: {
      kind: deps.store.kind,
      dryRun: deps.dryRun,
      campaignsSynced: sync.ok && sync.value,
      spendWritten: spend.storeWritten,
      readingsWritten: false,
      errors: [sync.ok ? null : sync.error, spend.storeError].filter((e): e is string => !!e),
    },
    notify: { push: false, busCopy: false, reason: '', text: null },
    errors,
    notes: [...STANDING_NOTES],
  }
  if (!due && !opts.force) {
    base.notify.reason = `not due until ${dueEt} ET; nothing recorded`
    return base
  }

  const beacon = deps.beacon
  const taggedRows = beacon ? await attempt('beacon tagged', () => beacon.tagged(campaign)) : unavailable<TaggedRow[]>('beacon tagged', deps.beaconInitError)
  const { read } = await fullRead(deps, { plan, campaign, thresholds: [], spendThroughEt: spend.throughEt, stored, tagged: taggedRows, forceDecision: true, readAt })
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

  // Post-flight kill check: any spend after the flight's last day with the campaign enabled.
  if (stored && spend.ok) {
    const after = Object.entries(stored.days).filter(([d, v]) => d > campaign.flightEnd && v.costMicros > 0)
    const afterCost = round2(after.reduce((a, [, v]) => a + microsToDollars(v.costMicros), 0))
    const enabled = status.ok ? status.value.status === 'ENABLED' : null
    base.postFlightSpend = {
      id: 'hard-cap',
      label: 'no spend after the flight',
      limit: 0,
      value: afterCost,
      status: afterCost > 0 && enabled !== false ? 'trip' : 'clear',
      detail: afterCost > 0 ? `${money(afterCost)} spent after ${campaign.flightEnd}; campaign reads ${status.ok ? status.value.status : 'unreadable'}` : `no spend after ${campaign.flightEnd}`,
    }
  }

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
    rules: base.postFlightSpend ? [base.postFlightSpend] : null,
    proposal: base.postFlightSpend?.status === 'trip' ? 'PROPOSE PAUSE' : null,
    decision: read.decision,
    counts: {
      ...fullReadCounts(read),
      promoOutcomesSignedIn: base.promoSplit.beacon?.promo['signed-in'] ?? null,
      promoOutcomesStillPlaying: base.promoSplit.beacon?.promo['still-playing'] ?? null,
      nonPromoOutcomesSignedIn: base.promoSplit.beacon?.nonPromo['signed-in'] ?? null,
      nonPromoOutcomesStillPlaying: base.promoSplit.beacon?.nonPromo['still-playing'] ?? null,
      nonPromoAccountsInWindow: base.promoSplit.accounts?.nonPromoInWindow ?? null,
    },
    notes: read.complete ? [] : [`incomplete: ${read.errors.join('; ')}`],
  }
  const w = sync.ok ? await appendReadings(deps, [rec]) : { written: false, error: 'readings not written: campaign sync failed' }
  if (w.error) {
    errors.push(w.error)
    base.store.errors.push(w.error)
  }
  base.store.readingsWritten = w.written

  const trip = base.postFlightSpend?.status === 'trip'
  base.notify = {
    push: true,
    busCopy: true,
    reason: `post-flight ${opts.stage} read (a scheduled spec read)${trip ? ' with spend after the flight' : ''}`,
    text: `BSK retest ${opts.stage} read: ${money(spend.cumulative.cost)} total, ${read.tagged?.summary.taggedArrivals ?? '?'} tagged arrivals, ${read.decision ? `sign-ups ${read.decision.signUps}, row ${read.decision.row}` : 'no decision'}${trip ? `; PROPOSE PAUSE (spend after ${campaign.flightEnd})` : ''}.`,
  }
  base.notes.push(INSTALL_OUTCOME_GAP_NOTE)
  return base
}
