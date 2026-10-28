// syncAdsData — the ONE code path that pulls Google Ads metrics into gss-stats-ads.
//
// Every caller runs this and nothing else to fetch spend: the morning read and the backstop
// (scripts/ads-reads/morning-read.ts), the post-flight read, the backfill, `npm run ads:sync`,
// and the gss-stats-sync Worker (workers/sync/). Runtime-agnostic: the Ads API arrives as an
// AdsMetricsSource (lib/adsApi.ts, plain fetch) — built lazily, only when something needs
// pulling — and the database as an AdsSyncStore (lib/adsStore.ts createSqlAdsStore over a
// wrangler-CLI or a D1-binding adapter).
//
// planSync() decides, from ONE read of the stored day rows and one of the recent sync runs,
// what each campaign needs:
//  - every CLOSED ET day of the flight (first day → min(yesterday, flight end)) not yet stored
//    as closed, and every stored day whose placement pull has not covered it;
//  - the most recent RESTATEMENT_DAYS closed days (Google restates them), but only when the
//    campaign's last pull is older than the recheck interval (default 6 h) — so a tick right
//    after another sync is a no-op that never builds the Ads client or refreshes a token;
//  - today's partial numbers when the caller asks (returned, never stored).
// syncAdsData() then pulls at most two ranges per due campaign, NEWEST FIRST: the restatement
// window whole, then any older gap (at most `maxDays` closed days per run across campaigns,
// newest kept; the rest wait for the next run). Each range is checked and written on its own:
//  - a day the API returns nothing for is stored as zero only when Google's range total agrees
//    with the daily rows (a never-stored flight day; or a stored day credited in full, when the
//    total is non-empty). Rows and total disagreeing = a partial response: the range is pulled
//    again in halves (newer first) down to single days, so one bad day never blocks the rest;
//  - an empty response never turns stored spend into zeros (the range fails, 'partial');
//  - a stored placement row with spend left out fails the placement pull in the restatement
//    window; on an older day it is kept as stored and reported as a warning;
//  - writes ONLY rows that are new or changed.
// A run that pulled or read anything appends one ads_sync_runs row (not in --dry-run); a run
// with nothing due writes nothing at all.
//
// Conversions and per-asset results (migration 0007) are NOT part of this sync: they have a
// pass of their own, syncAdsExtras() at the end of this file, run in its own invocation.

import { CAMPAIGNS, campaignById, campaignStatusOn, type CampaignFlight } from './campaigns'
import { channelOf, microsToDollars, round2, type SpendDay, type StoredSpend } from './adsRules'
import {
  ASSET_CATALOG_ROWS_PER_STATEMENT,
  ASSET_ROWS_PER_STATEMENT,
  campaignSyncStatements,
  CONVERSION_ROWS_PER_STATEMENT,
  EXTRAS_RUN_KEY_PREFIX,
  mergeAssetRows,
  mergeConversionRows,
  mergePlacementDayRows,
  QueryBudgetError,
  rowsToStoredSpend,
  type AdsSyncStore,
  type AssetDayRow,
  type ConversionDayRow,
  type PlacementDayRow,
  type StoredDayRow,
  type SyncRunRecord,
  type SyncSource,
  type SyncStatus,
} from './adsStore'
import { CLOSED_AFTER_ET, contiguousThrough, etDateRange, isClosedFetch } from './adsFreshness'
import { addDays, etDateFast, etHourFast, etWallTimeMs } from './etTime'
import { redact, summarizeError } from './adsRedact'
import { maskCustomerId } from './adsApi'

/** Google restates recent days (invalid-click credits, late conversions): re-pull this many. */
export const RESTATEMENT_DAYS = 3
/** A closed campaign's window runs to its flight end plus this many days (stray spend is pulled,
 * never zero-filled). */
export const CLOSED_CAMPAIGN_GRACE_DAYS = 3
/** Re-pull the restatement window at most this often per campaign. */
export const RESTATEMENT_RECHECK_MS = 6 * 3_600_000

export interface AdsMetricsSource {
  daily(campaignId: string, since: string, until: string): Promise<Record<string, SpendDay>>
  placements(campaignId: string, since: string, until: string): Promise<PlacementDayRow[]>
  /** The range's totals in one aggregated row (null = Google returned none). The cross-check
   * before a day the daily query left out is stored as zero (lib/adsApi.ts fetchRangeTotal).
   * Without it the sync only zero-fills never-stored days and never accepts a stored day
   * dropping to zero. */
  rangeTotal?(campaignId: string, since: string, until: string): Promise<SpendDay | null>
}

export interface SyncOptions {
  /** Default: every configured campaign with a flight start. */
  campaignIds?: readonly string[]
  /** Clock (ms). */
  now: number
  dryRun: boolean
  source: SyncSource
  /** Re-pull every day in the window, not just what is due (the backfill, an operator check).
   * NOT resumable under `maxDays` (review I3): a capped full re-pull covers the newest days
   * only, and later runs pull only what is missing. The local CLIs pass no cap; through the
   * Worker, give a `maxDays` (up to 31) that covers the window. */
  full?: boolean
  /** Also read today's partial numbers (returned, never stored). */
  includeToday?: boolean
  /** Default true. */
  placements?: boolean
  /** Most closed days pulled in one run, all campaigns together; the rest wait for later runs.
   * Default: no cap. */
  maxDays?: number
  /** Re-pull the restatement window only when the campaign's last pull is older than this.
   * Default RESTATEMENT_RECHECK_MS; 0 = on every run. */
  restatementRecheckMs?: number
}
export interface SyncDeps {
  /** An Ads source built up front (the local CLIs), or null when it could not be. */
  ads?: AdsMetricsSource | null
  /** Builds the Ads source lazily: called at most once, only when something needs pulling (the
   * Worker: no secret read and no token refresh on a run with nothing due). */
  adsFactory?: () => Promise<AdsMetricsSource>
  adsInitError?: string | null
  store: AdsSyncStore
}

export interface SyncRange {
  since: string
  until: string
}
export interface CampaignSyncPlan {
  campaignId: string
  /** The campaign's pull window (closed days), or null when it has none yet. */
  window: SyncRange | null
  /** Closed-day ranges to pull, NEWEST FIRST: the recent window (the restatement days through
   * the end of the window, whole, so a pull of it re-checks every restatable day) and an older
   * gap. Each is pulled and checked on its own, so a stuck old day cannot hold up the recent
   * one. Empty = nothing due. */
  ranges: SyncRange[]
  /** The span of `ranges` (for reports), or null. */
  fetch: SyncRange | null
  /** The full recent window [restatementDays[0], window.until] when it is part of this run's
   * pull; a pull counts as a restatement re-check only if it covered all of it (review L3). */
  recheck: SyncRange | null
  missingDays: string[]
  missingPlacementDays: string[]
  restatementDays: string[]
  /** Whether the restatement window is due this run (cadence). */
  restatementDue: boolean
  /** Today's partial read, when asked for and the campaign is not closed. */
  today: string | null
  /** The per-run day cap shortened `ranges` (newest days kept); the rest waits for a later run. */
  deferred: boolean
}
export interface CampaignSyncResult {
  campaignId: string
  label: string
  window: SyncRange | null
  /** The span of what was pulled (for reports); `ranges` has each range. */
  fetched: SyncRange | null
  ranges: SyncRange[]
  /** Non-fatal findings, e.g. stored placement rows on an old day that Google no longer returns
   * (kept as stored, not retried). */
  warnings: string[]
  /** 'up to date' | 'synced' | 'no change' | 'deferred' | 'failed' | … */
  outcome: string
  missingDays: number
  daysFetched: number
  daysChanged: number
  changedDates: string[]
  restated: { date: string; before: number; after: number }[]
  placementRowsFetched: number
  placementRowsChanged: number
  placementsOk: boolean | null
  /** The Ads pull (and the store read before it) worked: `spend` holds fresh numbers. */
  fetchOk: boolean
  /** …and every changed day row was stored (or would be, in --dry-run). */
  dailyOk: boolean
  /** The pull reached the end of the window (the restatement window was re-checked). */
  pulled: boolean
  deferred: boolean
  /** Last closed day stored contiguously from the flight start (after this run's writes). */
  spendThrough: string | null
  /** Stored + fetched closed days, for the reads (in --dry-run too). */
  spend: StoredSpend | null
  /** This run's placement rows for the fetched range (merged), for the reads. */
  placements: PlacementDayRow[]
  /** Today's partial numbers when includeToday (never stored). */
  today: SpendDay | null
  error: string | null
}
export interface SyncResult {
  source: SyncSource
  dryRun: boolean
  startedAt: string
  finishedAt: string
  status: SyncStatus
  /** Nothing was due: no Ads call, no write, no run row. */
  nothingDue: boolean
  campaigns: CampaignSyncResult[]
  daysFetched: number
  daysChanged: number
  placementRowsFetched: number
  placementRowsChanged: number
  /** The ads_campaigns upsert ran (false in --dry-run or when nothing was written). */
  campaignsSynced: boolean
  /** The ads_campaigns upsert failed: nothing that references a campaign can be written. */
  campaignSyncError: string | null
  runRecorded: boolean
  error: string | null
}

const ZERO: SpendDay = { costMicros: 0, impressions: 0, clicks: 0 }
const hasDelivery = (d: SpendDay | PlacementDayRow) => d.costMicros > 0 || d.impressions > 0 || d.clicks > 0
const firstOf = (xs: (string | undefined)[]) => xs.filter((x): x is string => !!x).sort()[0]

/** Campaigns the sync covers: every configured campaign with a flight start, or the given ids
 * (an unknown id is an error — never a silent no-op). */
export function syncableCampaigns(ids?: readonly string[]): CampaignFlight[] {
  const all = CAMPAIGNS.filter((c) => c.flightStart != null)
  if (!ids?.length) return all
  const unknown = ids.filter((id) => !all.some((c) => c.id === id))
  if (unknown.length) throw new Error(`not a syncable campaign: ${unknown.join(', ')}`)
  return all.filter((c) => ids.includes(c.id))
}

/** The closed ET days a campaign's data can be pulled for at `todayEt`: flight start through
 * yesterday (a closed campaign: through flight end + CLOSED_CAMPAIGN_GRACE_DAYS). Days after the
 * flight end are pulled (stray spend shows up) but never zero-filled or required. */
export function syncWindow(c: Pick<CampaignFlight, 'flightStart' | 'flightEnd'>, todayEt: string): SyncRange | null {
  if (!c.flightStart) return null
  const yesterday = addDays(todayEt, -1)
  const cap = campaignStatusOn(c, todayEt) === 'closed' ? addDays(c.flightEnd, CLOSED_CAMPAIGN_GRACE_DAYS) : yesterday
  const until = cap < yesterday ? cap : yesterday
  return c.flightStart <= until ? { since: c.flightStart, until } : null
}

/** Pure: what to pull for one campaign, given its stored rows and its last pull. */
export function planCampaignSync(
  c: Pick<CampaignFlight, 'id' | 'flightStart' | 'flightEnd' | 'status'>,
  rows: readonly StoredDayRow[],
  todayEt: string,
  opts: { full?: boolean; includeToday?: boolean; placements?: boolean; nowMs?: number; lastPullAt?: string | null; restatementRecheckMs?: number } = {},
): CampaignSyncPlan {
  // Before 03:00 ET yesterday cannot be stored as closed yet (lib/adsFreshness.ts
  // CLOSED_AFTER_ET), so it is not due at all: a flight's hourly cron pulls it once, at 03:05 ET,
  // instead of at 00:05, 01:05, 02:05 and again at 03:05 (final review Low-1). A read at 08:00
  // ET is unaffected.
  const fullWindow = syncWindow(c, todayEt)
  const beforeClose = opts.nowMs != null && etDateFast(opts.nowMs) === todayEt && opts.nowMs < etWallTimeMs(todayEt, CLOSED_AFTER_ET)
  const lastClosed = addDays(todayEt, beforeClose ? -2 : -1)
  const window = fullWindow && fullWindow.until > lastClosed ? (fullWindow.since <= lastClosed ? { since: fullWindow.since, until: lastClosed } : null) : fullWindow
  const today = opts.includeToday && campaignStatusOn(c, todayEt) !== 'closed' && c.flightStart != null && c.flightStart <= todayEt ? todayEt : null
  const none: CampaignSyncPlan = { campaignId: c.id, window, ranges: [], fetch: null, recheck: null, missingDays: [], missingPlacementDays: [], restatementDays: [], restatementDue: false, today, deferred: false }
  if (!window) return none
  const byDate = new Map(rows.map((r) => [r.date, r]))
  const requiredUntil = window.until < c.flightEnd ? window.until : c.flightEnd
  const required = etDateRange(window.since, requiredUntil)
  const missingDays = required.filter((d) => !isClosedFetch(d, byDate.get(d)?.fetchedAt))
  const missingPlacementDays = opts.placements === false ? [] : required.filter((d) => byDate.has(d) && !isClosedFetch(d, byDate.get(d)!.placementsFetchedAt))
  const restateFrom = addDays(todayEt, -RESTATEMENT_DAYS)
  const restatementDays = etDateRange(restateFrom > window.since ? restateFrom : window.since, window.until)
  const recheck = opts.restatementRecheckMs ?? RESTATEMENT_RECHECK_MS
  const last = opts.lastPullAt ? Date.parse(opts.lastPullAt) : NaN
  const restatementDue = restatementDays.length > 0 && (!!opts.full || recheck <= 0 || !Number.isFinite(last) || (opts.nowMs ?? Date.now()) - last >= recheck)
  const recentStart = restatementDays[0] // undefined once the window has ended long ago
  const needed = [...new Set([...missingDays, ...missingPlacementDays])].sort()
  // The recent window is pulled WHOLE whenever any of it is due: the same two queries either
  // way, and then the pull is a real re-check of every restatable day.
  const recentDue = !!recentStart && (restatementDue || needed.some((d) => d >= recentStart))
  const recentRange = recentDue ? { since: recentStart!, until: window.until } : null
  // An older gap is pulled from its first day up to the recent window (or the window end), like
  // one span: days after the flight end in between are pulled too, so after-flight spend shows up.
  const olderUntil = recentStart ? addDays(recentStart, -1) : window.until
  const olderNeeded = needed.filter((d) => !recentStart || d < recentStart)
  const olderSince = opts.full ? window.since : olderNeeded[0]
  const olderRange = olderSince && olderSince <= olderUntil ? { since: olderSince, until: olderUntil } : null
  const ranges = [recentRange, olderRange].filter((r): r is SyncRange => !!r)
  return {
    ...none,
    ranges,
    fetch: ranges.length ? { since: firstOf(ranges.map((r) => r.since))!, until: ranges.map((r) => r.until).sort().at(-1)! } : null,
    recheck: recentRange,
    missingDays,
    missingPlacementDays,
    restatementDays,
    restatementDue,
  }
}

/** The per-run day cap, NEWEST FIRST (review L2): the recent window before any older gap, and
 * within a range its newest days, so an old day that keeps failing never starves newer ones.
 * An older range is cut back to its newest NEEDED day first (the after-flight days past it are
 * never required, so they go first). Returns what is left of the budget. */
export function capPlan(plan: CampaignSyncPlan, budget: number): number {
  const kept: SyncRange[] = []
  const needed = [...plan.missingDays, ...plan.missingPlacementDays]
  for (const r of plan.ranges) {
    const days = etDateRange(r.since, r.until).length
    const take = Math.min(days, Math.max(0, budget))
    budget -= take
    if (take === days) {
      kept.push(r)
      continue
    }
    plan.deferred = true
    if (take === 0) continue
    const recent = !!plan.recheck && r.until === plan.recheck.until
    const lastNeeded = recent ? undefined : needed.filter((d) => d >= r.since && d <= r.until).sort().at(-1)
    const end = lastNeeded ?? r.until
    // Every needed day fits: take them all plus the first after-flight days. Else the newest.
    kept.push(etDateRange(r.since, end).length <= take ? { since: r.since, until: addDays(r.since, take - 1) } : { since: addDays(end, -(take - 1)), until: end })
  }
  plan.ranges = kept
  plan.fetch = kept.length ? { since: firstOf(kept.map((r) => r.since))!, until: kept.map((r) => r.until).sort().at(-1)! } : null
  return budget
}

const sameDay = (a: SpendDay, b: SpendDay) => a.costMicros === b.costMicros && a.impressions === b.impressions && a.clicks === b.clicks
const samePlacement = (a: PlacementDayRow, b: PlacementDayRow) =>
  a.costMicros === b.costMicros &&
  a.impressions === b.impressions &&
  a.clicks === b.clicks &&
  (a.approved ?? null) === (b.approved ?? null) &&
  (a.displayName ?? null) === (b.displayName ?? null) &&
  (a.type ?? null) === (b.type ?? null) &&
  (a.targetUrl ?? null) === (b.targetUrl ?? null)

/** Pure: which placement rows to write, and which stored rows WITH SPEND the fresh pull left out
 * (a failed fetch: the caller writes nothing — never zeros over stored spend). */
export function diffPlacements(stored: readonly PlacementDayRow[], fresh: readonly PlacementDayRow[]): { changed: PlacementDayRow[]; missingStored: PlacementDayRow[] } {
  const merged = mergePlacementDayRows(fresh)
  const key = (r: PlacementDayRow) => `${r.date}\u0000${r.placement}`
  const old = new Map(stored.map((r) => [key(r), r]))
  const changed = merged.filter((r) => {
    const s = old.get(key(r))
    return !s || !samePlacement(s, r)
  })
  const freshKeys = new Set(merged.map(key))
  const missingStored = stored.filter((s) => !freshKeys.has(key(s)) && hasDelivery(s))
  return { changed, missingStored }
}

/** Pure: the day rows to write after a pull, what they change, and which stored days WITH SPEND
 * the response left out (a failed fetch). A day the response leaves out is zero-filled only when
 * it was never stored and lies on or before `flightEnd`. */
export function diffDays(
  stored: readonly StoredDayRow[],
  fresh: Record<string, SpendDay>,
  range: SyncRange,
  nowIso: string,
  placementsCovered: boolean,
  flightEnd: string,
): { rows: StoredDayRow[]; restated: { date: string; beforeMicros: number; afterMicros: number }[]; missingStored: string[]; zeroFilled: string[]; view: Record<string, SpendDay> } {
  const byDate = new Map(stored.map((r) => [r.date, r]))
  const rows: StoredDayRow[] = []
  const restated: { date: string; beforeMicros: number; afterMicros: number }[] = []
  const missingStored: string[] = []
  const zeroFilled: string[] = []
  const view: Record<string, SpendDay> = {}
  for (const d of etDateRange(range.since, range.until)) {
    const s = byDate.get(d)
    let f = fresh[d]
    if (!f) {
      if (!s) {
        if (d > flightEnd) continue // after the flight: nothing to store without a row
        f = ZERO // never stored, inside the flight: no rows = no delivery
        zeroFilled.push(d)
      } else if (hasDelivery(s)) {
        missingStored.push(d)
        continue
      } else f = ZERO // stored zero, still zero
    }
    view[d] = f
    const wasClosed = !!s && isClosedFetch(d, s.fetchedAt)
    const equal = !!s && sameDay(s, f)
    const placementsDone = !!s && isClosedFetch(d, s.placementsFetchedAt)
    if (s && wasClosed && Math.abs(s.costMicros - f.costMicros) >= 10_000) restated.push({ date: d, beforeMicros: s.costMicros, afterMicros: f.costMicros })
    if (s && wasClosed && equal && (placementsDone || !placementsCovered)) continue // nothing new
    rows.push({
      date: d,
      costMicros: f.costMicros,
      impressions: f.impressions,
      clicks: f.clicks,
      fetchedAt: equal && wasClosed ? s!.fetchedAt : nowIso,
      placementsFetchedAt: placementsCovered ? nowIso : (s?.placementsFetchedAt ?? null),
    })
  }
  return { rows, restated, missingStored, zeroFilled, view }
}

const sumDays = (days: Record<string, SpendDay>, range: SyncRange): SpendDay =>
  Object.entries(days)
    .filter(([d]) => d >= range.since && d <= range.until)
    .reduce<SpendDay>((a, [, v]) => ({ costMicros: a.costMicros + v.costMicros, impressions: a.impressions + v.impressions, clicks: a.clicks + v.clicks }), { ...ZERO })
const dollars = (micros: number) => `$${(micros / 1e6).toFixed(2)}`

type Attempt<T> = { ok: true; value: T } | { ok: false; error: string }
async function attempt<T>(label: string, fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    return { ok: false, error: `${label}: ${redact(e)}` }
  }
}

// ── Planning: one read of the stored days, one of the recent runs ────────────────────────
export interface SyncSnapshot {
  todayEt: string
  campaigns: CampaignFlight[]
  rows: Map<string, StoredDayRow[]>
  lastPulls: Map<string, string>
  plans: Map<string, CampaignSyncPlan>
  /** Something needs pulling (or today's numbers were asked for). */
  due: boolean
  /** The store could not be read: nothing can be planned. */
  error: string | null
}

export async function planSync(store: AdsSyncStore, opts: SyncOptions): Promise<SyncSnapshot> {
  const todayEt = etDateFast(opts.now)
  const campaigns = syncableCampaigns(opts.campaignIds)
  const snap: SyncSnapshot = { todayEt, campaigns, rows: new Map(), lastPulls: new Map(), plans: new Map(), due: false, error: null }
  const rows = await attempt('store read (daily metrics)', () => store.getAllDailyRows())
  if (!rows.ok) return { ...snap, error: rows.error, due: true }
  const pulls = await attempt('store read (sync runs)', () => store.getLastPulls())
  snap.rows = rows.value
  snap.lastPulls = pulls.ok ? pulls.value : new Map() // unreadable: re-check restatement (safe)
  // Live campaigns first, so a capped run spends its budget where freshness matters.
  const ordered = [...campaigns].sort((a, b) => Number(campaignStatusOn(a, todayEt) === 'closed') - Number(campaignStatusOn(b, todayEt) === 'closed'))
  let budget = opts.maxDays != null && opts.maxDays > 0 ? Math.floor(opts.maxDays) : Infinity
  for (const c of ordered) {
    const plan = planCampaignSync(c, snap.rows.get(c.id) ?? [], todayEt, {
      full: opts.full,
      includeToday: opts.includeToday,
      placements: pullsPlacements(c.id, opts) ? opts.placements : false,
      nowMs: opts.now,
      lastPullAt: snap.lastPulls.get(c.id) ?? null,
      restatementRecheckMs: opts.restatementRecheckMs,
    })
    if (plan.ranges.length && budget !== Infinity) budget = capPlan(plan, budget)
    snap.plans.set(c.id, plan)
    if (plan.fetch || plan.today || plan.deferred) snap.due = true
  }
  return snap
}

/** Whether a sync pulls a campaign's placements: never for a search campaign (it has none;
 * lib/adsRules.ts channelOf), never for a campaign flagged `noPlacements` (an App install
 * campaign; lib/campaigns.ts), and never when the caller turned placements off. Every other
 * campaign, with or without a read plan, pulls as before. A skipped pull is not a missing day:
 * planCampaignSync gets `placements: false`, so missingPlacementDays is empty. */
export const pullsPlacements = (campaignId: string, opts: { placements?: boolean }): boolean =>
  opts.placements !== false && channelOf(campaignId) === 'display' && campaignById(campaignId)?.noPlacements !== true

// ── One campaign ──────────────────────────────────────────────────────────────────────────
const spanOf = (ranges: readonly SyncRange[]): SyncRange | null =>
  ranges.length ? { since: firstOf(ranges.map((r) => r.since))!, until: ranges.map((r) => r.until).sort().at(-1)! } : null
const datesOf = (rows: readonly { date: string }[]) => [...new Set(rows.map((r) => r.date))].sort().join(', ')

async function syncOne(
  deps: SyncDeps,
  getAds: () => Promise<AdsMetricsSource>,
  ensureCampaigns: () => Promise<Attempt<boolean>>,
  c: CampaignFlight,
  snap: SyncSnapshot,
  opts: SyncOptions,
  nowIso: string,
): Promise<CampaignSyncResult> {
  const plan = snap.plans.get(c.id)!
  const stored = snap.rows.get(c.id) ?? []
  const closedStored = stored.filter((r) => isClosedFetch(r.date, r.fetchedAt))
  const res: CampaignSyncResult = {
    campaignId: c.id,
    label: c.label,
    window: plan.window,
    fetched: null,
    ranges: [],
    warnings: [],
    outcome: plan.deferred && !plan.ranges.length ? 'deferred' : 'up to date',
    missingDays: plan.missingDays.length,
    daysFetched: 0,
    daysChanged: 0,
    changedDates: [],
    restated: [],
    placementRowsFetched: 0,
    placementRowsChanged: 0,
    placementsOk: null,
    fetchOk: true,
    dailyOk: true,
    pulled: false,
    deferred: plan.deferred,
    spendThrough: contiguousThrough(c.flightStart, new Set(closedStored.map((r) => r.date)), c.flightEnd),
    spend: rowsToStoredSpend(c.id, closedStored),
    placements: [],
    today: null,
    error: null,
  }
  const fail = (error: string, outcome = 'failed') => Object.assign(res, { fetchOk: false, dailyOk: false, outcome, error })
  if (!plan.ranges.length && !plan.today) return res

  let ads: AdsMetricsSource
  try {
    ads = await getAds()
  } catch (e) {
    return fail(`ads: ${redact(e)}`)
  }
  // Today rides on the newest range's query when they are contiguous; else its own query, first.
  const joinToday = !!(plan.today && plan.ranges[0] && addDays(plan.ranges[0].until, 1) === plan.today)
  if (plan.today && !joinToday) {
    const t = await attempt('ads daily (today)', () => ads.daily(c.id, plan.today!, plan.today!))
    if (!t.ok) return fail(t.error)
    res.today = t.value[plan.today] ?? { ...ZERO }
  }

  // Each range is pulled, checked and written on its own, newest first (review L2): a range
  // that fails leaves the others alone, and nothing of a failed range is written. A range whose
  // rows do not add up is pulled again in halves (newer half first) down to single days, so one
  // bad day never holds back the days around it. An EMPTY daily response (no row in the range)
  // is failed as it is, never halved: that is a broken response, not a bad day (final review
  // Low-2).
  const after = new Map(closedStored.map((r) => [r.date, r]))
  const closedNow = new Set(closedStored.map((r) => r.date))
  const errors: string[] = []
  let attempted = 0
  let failedRanges = 0
  let placementsFailed = false
  let placementsPulled = false
  let writeFailed: string | null = null
  // A range touching the restatement window (a half of it included) is "recent" (final review Info-1).
  const restFirst = plan.restatementDays[0]
  const restLast = plan.restatementDays[plan.restatementDays.length - 1]
  const isRecent = (r: SyncRange) => !!restFirst && r.until >= restFirst && r.since <= restLast
  const queue = [...plan.ranges]
  let first = true
  const split = (r: SyncRange, why: string): boolean => {
    const days = etDateRange(r.since, r.until)
    if (days.length < 2) return false
    const mid = days[Math.floor((days.length - 1) / 2)]
    queue.unshift({ since: addDays(mid, 1), until: r.until }, { since: r.since, until: mid })
    res.warnings.push(`ads daily: ${r.since}..${r.until} ${why}; pulled again in halves to find the day`)
    return true
  }
  const failRange = (error: string) => {
    attempted++
    failedRanges++
    errors.push(error)
  }
  while (queue.length) {
    const range = queue.shift()!
    const withToday = first && joinToday
    first = false
    const a = await attempt('ads daily', () => ads.daily(c.id, range.since, withToday ? plan.today! : range.until))
    if (!a.ok) {
      if (withToday) return fail(a.error) // today was asked for: the read has nothing fresh
      failRange(a.error)
      continue
    }
    const daily = a.value
    if (withToday) res.today = daily[plan.today!] ?? { ...ZERO }

    // A day the daily query left out: zero-filled (never stored) or a stored day that went to
    // zero. Either is accepted only when Google's range total agrees with the daily rows
    // (review L1): a partial response must never store a real day as $0.
    const pre = diffDays(stored, daily, range, nowIso, false, c.flightEnd)
    const zeroOk = new Set<string>()
    if ((pre.zeroFilled.length || pre.missingStored.length) && ads.rangeTotal) {
      const t = await attempt('ads range total', () => ads.rangeTotal!(c.id, range.since, range.until))
      if (!t.ok) {
        failRange(t.error)
        continue
      }
      const sum = sumDays(daily, range)
      const total = t.value ?? ZERO
      if (!sameDay(total, sum)) {
        const why = `add up to ${dollars(sum.costMicros)} (${sum.impressions} impr, ${sum.clicks} clicks) but Google's range total is ${dollars(total.costMicros)} (${total.impressions} impr, ${total.clicks} clicks)`
        const empty = !Object.keys(daily).some((d) => d >= range.since && d <= range.until)
        if (empty) failRange(`ads daily: the response for ${range.since}..${range.until} was empty but Google's range total is ${dollars(total.costMicros)} (${total.impressions} impr, ${total.clicks} clicks); nothing written for these days, treated as a failed fetch`)
        else if (!split(range, `did not add up (the daily rows ${why})`)) failRange(`ads daily: the daily rows for ${range.since}..${range.until} ${why}; nothing written for these days, treated as a failed fetch`)
        continue
      }
      // Both queries agree and the range has rows: the left-out stored days really are zero now.
      if (t.value && hasDelivery(t.value)) for (const d of pre.missingStored) zeroOk.add(d)
    }
    if (pre.missingStored.length > zeroOk.size) {
      // An empty response (or, without a range total to check against, a truncated one): never
      // overwrite stored spend with zeros, and write nothing else from it either.
      failRange(`ads daily: the response left out ${pre.missingStored.length} stored day(s) with spend (${pre.missingStored.join(', ')}); kept the stored values, treated as a failed fetch`)
      continue
    }
    attempted++
    const fresh = zeroOk.size ? { ...daily, ...Object.fromEntries([...zeroOk].map((d) => [d, { ...ZERO }])) } : daily

    // Placements. A day's placements_fetched_at is only set once its rows are stored.
    let placementsCovered = false
    let placementWrites: PlacementDayRow[] = []
    let rangePlacements: PlacementDayRow[] = []
    if (pullsPlacements(c.id, opts)) {
      const pl = await attempt('ads placements', () => ads.placements(c.id, range.since, range.until))
      const old = pl.ok ? await attempt('store read (placements)', () => deps.store.getPlacementRows(c.id, range.since, range.until)) : null
      if (!pl.ok || !old || !old.ok) {
        placementsFailed = true
        errors.push(!pl.ok ? pl.error : old && !old.ok ? old.error : 'placements unavailable')
      } else {
        const merged = mergePlacementDayRows(pl.value)
        const { changed, missingStored } = diffPlacements(old.value, merged)
        // On a day confirmed zero (above), a left-out placement row is zero too.
        const zeroed = missingStored.filter((r) => zeroOk.has(r.date)).map((r) => ({ ...r, costMicros: 0, impressions: 0, clicks: 0 }))
        const missing = missingStored.filter((r) => !zeroOk.has(r.date))
        res.placementRowsFetched += merged.length
        if (missing.length && isRecent(range)) {
          placementsFailed = true
          errors.push(`ads placements: the response left out ${missing.length} stored placement-day row(s) with spend (${datesOf(missing)}); kept the stored rows, treated as a failed fetch`)
        } else {
          // Older than the restatement window: Google dropping a small placement is not a reason
          // to re-pull the range on every run. Kept as stored, and reported.
          if (missing.length) res.warnings.push(`ads placements: Google no longer returns ${missing.length} stored placement-day row(s) with spend (${datesOf(missing)}); kept as stored`)
          placementWrites = [...changed, ...zeroed]
          rangePlacements = [...merged, ...zeroed, ...missing]
          placementsCovered = true
          placementsPulled = true
        }
      }
    }

    let d = diffDays(stored, fresh, range, nowIso, placementsCovered, c.flightEnd)
    if (!opts.dryRun && (placementWrites.length || d.rows.length)) {
      const cs = await ensureCampaigns()
      if (!cs.ok) {
        writeFailed = 'not written: campaign sync failed'
        errors.push(cs.error)
        break // nothing that references a campaign can be written this run
      }
      if (placementWrites.length) {
        const put = await attempt('store write (placements)', () => deps.store.putPlacements(c.id, placementWrites, nowIso))
        if (!put.ok) {
          placementsFailed = true
          placementsCovered = false
          errors.push(put.error)
          // The day rows must not claim placement coverage the store does not have.
          d = diffDays(stored, fresh, range, nowIso, false, c.flightEnd)
          placementWrites = []
        }
      }
      if (d.rows.length) {
        const put = await attempt('store write (daily metrics)', () => deps.store.putDailyRows(c.id, d.rows))
        if (!put.ok) {
          // Not stored: the range does not count as pulled, and the reads keep the stored view.
          writeFailed = 'store write failed'
          errors.push(put.error)
          res.placementRowsChanged += placementWrites.length
          continue
        }
      }
    }
    res.ranges.push(range)
    res.daysFetched += etDateRange(range.since, range.until).length
    res.daysChanged += d.rows.length
    res.changedDates.push(...d.rows.map((r) => r.date))
    res.restated.push(...d.restated.map((r) => ({ date: r.date, before: round2(microsToDollars(r.beforeMicros)), after: round2(microsToDollars(r.afterMicros)) })))
    res.placementRowsChanged += placementWrites.length
    res.placements.push(...rangePlacements)
    // The view the reads use: stored closed days overlaid with this range's pull.
    for (const [day, f] of Object.entries(d.view)) {
      after.set(day, { date: day, ...f, fetchedAt: nowIso, placementsFetchedAt: null })
      if (isClosedFetch(day, nowIso)) closedNow.add(day)
    }
    // Only a pull of the WHOLE recent window re-checks the restatement days (review L3).
    if (plan.recheck && range.since === plan.recheck.since && range.until === plan.recheck.until && (!pullsPlacements(c.id, opts) || placementsCovered)) res.pulled = true
  }

  res.fetched = spanOf(res.ranges)
  res.error = errors[0] ?? null
  res.changedDates.sort()
  if (res.ranges.length) {
    res.spend = rowsToStoredSpend(c.id, [...after.values()])
    res.spendThrough = contiguousThrough(c.flightStart, closedNow, c.flightEnd)
  }
  if (pullsPlacements(c.id, opts) && (placementsPulled || placementsFailed)) res.placementsOk = !placementsFailed
  res.fetchOk = attempted === 0 || failedRanges < attempted
  res.dailyOk = res.fetchOk && failedRanges === 0 && !writeFailed
  const changed = res.daysChanged > 0 || res.placementRowsChanged > 0
  res.outcome = writeFailed
    ? writeFailed
    : !res.fetchOk
      ? 'failed'
      : failedRanges
        ? `synced partly (${failedRanges} of ${attempted} ranges failed)`
        : placementsFailed
          ? 'synced (placements failed)'
          : plan.deferred
            ? 'synced (partly; the rest next run)'
            : changed
              ? 'synced'
              : plan.ranges.length
                ? 'no change'
                : 'up to date'
  return res
}

/** The shared sync. Never throws for a data problem: failures are in the result (and its
 * ads_sync_runs row); only a programming error (an unknown campaign id) throws. Pass the
 * snapshot from planSync() to avoid reading the store twice. */
export async function syncAdsData(deps: SyncDeps, opts: SyncOptions, snapshot?: SyncSnapshot): Promise<SyncResult> {
  const t0 = Date.now()
  const startedAt = new Date(opts.now).toISOString()
  const snap = snapshot ?? (await planSync(deps.store, opts))
  const result: SyncResult = {
    source: opts.source,
    dryRun: opts.dryRun,
    startedAt,
    finishedAt: startedAt,
    status: 'ok',
    nothingDue: false,
    campaigns: [],
    daysFetched: 0,
    daysChanged: 0,
    placementRowsFetched: 0,
    placementRowsChanged: 0,
    campaignsSynced: false,
    campaignSyncError: null,
    runRecorded: false,
    error: null,
  }
  if (snap.error) {
    result.status = 'failed'
    result.error = summarizeError(snap.error, 300)
    for (const c of snap.campaigns) {
      result.campaigns.push({
        campaignId: c.id, label: c.label, window: null, fetched: null, ranges: [], warnings: [], outcome: 'failed', missingDays: 0, daysFetched: 0, daysChanged: 0, changedDates: [], restated: [],
        placementRowsFetched: 0, placementRowsChanged: 0, placementsOk: null, fetchOk: false, dailyOk: false, pulled: false, deferred: false, spendThrough: null, spend: null, placements: [], today: null, error: snap.error,
      })
    }
  } else if (!snap.due) {
    // Nothing due: no Ads client, no token refresh, no write, no run row.
    result.nothingDue = true
    for (const c of snap.campaigns) {
      const closed = (snap.rows.get(c.id) ?? []).filter((r) => isClosedFetch(r.date, r.fetchedAt))
      result.campaigns.push({
        campaignId: c.id, label: c.label, window: snap.plans.get(c.id)?.window ?? null, fetched: null, ranges: [], warnings: [], outcome: 'up to date', missingDays: 0, daysFetched: 0, daysChanged: 0, changedDates: [], restated: [],
        placementRowsFetched: 0, placementRowsChanged: 0, placementsOk: null, fetchOk: true, dailyOk: true, pulled: false, deferred: false,
        spendThrough: contiguousThrough(c.flightStart, new Set(closed.map((r) => r.date)), c.flightEnd), spend: rowsToStoredSpend(c.id, closed), placements: [], today: null, error: null,
      })
    }
    return result
  } else {
    let adsPromise: Promise<AdsMetricsSource> | null = null
    const getAds = () => {
      if (!adsPromise) {
        adsPromise = deps.ads ? Promise.resolve(deps.ads) : deps.adsFactory ? deps.adsFactory() : Promise.reject(new Error(deps.adsInitError ?? 'Google Ads client unavailable'))
        adsPromise.catch(() => {}) // surfaced per campaign
      }
      return adsPromise
    }
    let campaignsWrite: Promise<Attempt<boolean>> | null = null
    const ensureCampaigns = () => {
      // Campaign definitions first: every stored row references ads_campaigns (FOREIGN KEY). An
      // unchanged config writes nothing; a run that writes nothing never sends it.
      if (!campaignsWrite) campaignsWrite = attempt('store sync (campaigns)', () => deps.store.syncCampaigns(syncableCampaigns(), startedAt))
      return campaignsWrite
    }
    for (const c of snap.campaigns) result.campaigns.push(await syncOne(deps, getAds, ensureCampaigns, c, snap, opts, startedAt))
    if (campaignsWrite) {
      const cw = await (campaignsWrite as Promise<Attempt<boolean>>)
      result.campaignsSynced = cw.ok && cw.value
      result.campaignSyncError = cw.ok ? null : cw.error
    }
    for (const r of result.campaigns) {
      result.daysFetched += r.daysFetched
      result.daysChanged += r.daysChanged
      result.placementRowsFetched += r.placementRowsFetched
      result.placementRowsChanged += r.placementRowsChanged
    }
    const failed = result.campaigns.filter((r) => !r.dailyOk || r.placementsOk === false)
    const deferred = result.campaigns.filter((r) => r.deferred)
    result.status = result.campaignSyncError ? 'failed' : !failed.length ? (deferred.length ? 'partial' : 'ok') : failed.length === result.campaigns.length && failed.every((r) => !r.dailyOk && !r.ranges.length) ? 'failed' : 'partial'
    const firstError = result.campaignSyncError ?? failed.find((r) => r.error)?.error ?? null
    result.error = firstError
      ? summarizeError(firstError, 300)
      : deferred.length
        ? opts.full
          ? `work cap: the full re-pull of ${deferred.map((r) => r.campaignId).join(', ')} covered only the newest ${opts.maxDays} day(s) and is not resumed by later runs (they pull only missing days); rerun with a larger maxDays (up to 31) or locally with npm run ads:backfill`
          : `work cap: ${deferred.map((r) => r.campaignId).join(', ')} continue${deferred.length === 1 ? 's' : ''} next run`
        : null
  }
  result.finishedAt = new Date(opts.now + Math.max(0, Date.now() - t0)).toISOString()
  if (!opts.dryRun) {
    const run: SyncRunRecord = {
      runKey: `sync:${opts.source}:${startedAt}:${snap.campaigns.map((c) => c.id).join(',')}`,
      source: opts.source,
      startedAt,
      finishedAt: result.finishedAt,
      campaigns: snap.campaigns.map((c) => c.id),
      campaignsOk: result.campaigns.filter((r) => r.dailyOk).map((r) => r.campaignId),
      campaignsPulled: result.campaigns.filter((r) => r.pulled).map((r) => r.campaignId),
      daysFetched: result.daysFetched,
      daysChanged: result.daysChanged,
      placementRowsFetched: result.placementRowsFetched,
      placementRowsChanged: result.placementRowsChanged,
      status: result.status,
      error: result.error,
      detail: {
        worker: workerInfo(),
        ...Object.fromEntries(
          result.campaigns.map((r) => [
            r.campaignId,
            { fetched: r.fetched, ranges: r.ranges, days: r.daysFetched, changed: r.daysChanged, placements: r.placementRowsFetched, placementsChanged: r.placementRowsChanged, spendThrough: r.spendThrough, outcome: r.outcome, ...(r.warnings.length ? { warnings: r.warnings } : {}) },
          ]),
        ),
      },
    }
    const rec = await attempt('store write (sync run)', () => deps.store.appendSyncRun(run))
    result.runRecorded = rec.ok && rec.value
    if (!rec.ok && !result.error) result.error = summarizeError(rec.error, 300)
  }
  return result
}

// ── Conversions and per-asset results: a pass of their own (migration 0007) ──────────────
// syncAdsExtras() pulls two more READ-ONLY queries per campaign (lib/adsApi.ts
// fetchDailyConversions, fetchDailyAssets): conversions per ET day and conversion action, and
// per-asset delivery per ET day. Every syncable campaign gets both, spend-only arms included.
// The window is the flight (flight start through flight end + RESTATEMENT_DAYS, by the registry's
// dates), with the cost sync's close rule and restatement window; days already stored outside
// that window are never pulled again. Each run is planned to its row and D1 statement budget
// BEFORE anything is fetched (planExtrasRun). It runs in its OWN invocation (the Worker's EXTRAS_CRON; npm run
// ads:backfill after the cost backfill), never inside syncAdsData, so it adds no work to a
// cost-sync invocation and cannot fail, delay or stale the cost data:
//  - It never writes a cost row, a claim or a 'running' row. Its state (the closed days each
//    kind has stored, when its restatement window was last re-checked, the last error) is
//    carried forward in the detail of its own ads_sync_runs rows (run_key 'extras:…', every
//    count 0, campaigns_ok and campaigns_pulled '[]'), which every cost-sync reader skips
//    (lib/adsStore.ts EXTRAS_RUN_KEY_PREFIX). A day with no conversions has no row, so the data
//    tables alone cannot say which days were pulled.
//  - Conversions and assets are pulled and written apart: one failing never stops the other,
//    and a failure marks only that kind of that campaign stale (`stale`, in the result and in
//    the run row).
//  - An empty response never wipes stored numbers (the range fails). A conversion action that a
//    day's response leaves out, while it returns other actions for that day, is stored as zero;
//    a day left out entirely keeps its stored rows (a warning). Asset rows are never zero-filled.
//  - Writes ONLY rows that are new or changed (and the upserts are idempotent besides).
// A run with nothing due reads one row (the state) and nothing else: no Ads client, no write,
// no run row.
export type ExtrasKind = 'conversions' | 'assets'
export const EXTRAS_KINDS: readonly ExtrasKind[] = ['conversions', 'assets']

export interface AdsExtrasSource {
  conversions(campaignId: string, since: string, until: string): Promise<ConversionDayRow[]>
  assets(campaignId: string, since: string, until: string): Promise<AssetDayRow[]>
}
/** What the pass carries forward per campaign and kind. */
export interface ExtrasKindState {
  /** Closed ET days pulled and stored, as sorted, merged [since, until] ranges. */
  covered: [string, string][]
  /** When the whole restatement window was last pulled and stored. */
  recheckedAt: string | null
  /** When a pull was last attempted (the order campaigns take turns in under a cap). */
  attemptedAt: string | null
  /** The last attempt worked (null: never attempted). */
  ok: boolean | null
  error: string | null
  /** The most rows one day of this kind has returned (plans later runs); null: none yet. */
  rowsPerDay: number | null
  /** A re-check split over runs (newest days first): the oldest day it has re-pulled so far;
   * null: none in progress. */
  rechecking: string | null
}
export type ExtrasState = Record<string, Partial<Record<ExtrasKind, ExtrasKindState>>>

export interface ExtrasOptions {
  /** Default: every configured campaign with a flight start. */
  campaignIds?: readonly string[]
  now: number
  dryRun: boolean
  source: SyncSource
  /** Re-pull every day in the window (the backfill). */
  full?: boolean
  /** Rows one run plans to fetch, estimated per kind before any fetch (the Worker's CPU). Default: no cap. */
  maxRows?: number
  /** D1 statements one run may send besides its run row (the store's reserve). Default: no cap. */
  statementBudget?: number
  /** Default RESTATEMENT_RECHECK_MS. */
  restatementRecheckMs?: number
}
export interface ExtrasDeps {
  ads?: AdsExtrasSource | null
  /** Built lazily: called at most once, only when something needs pulling. */
  adsFactory?: () => Promise<AdsExtrasSource>
  adsInitError?: string | null
  store: AdsSyncStore
}
export interface ExtrasKindPlan {
  window: SyncRange | null
  /** Closed-day ranges to pull, newest first. Empty = nothing due. */
  ranges: SyncRange[]
  recheck: SyncRange | null
  missingDays: string[]
  restatementDue: boolean
  deferred: boolean
}
export interface ExtrasKindResult {
  /** null: nothing was pulled (not due, or waiting); true: every range pulled was stored. */
  ok: boolean | null
  /** Ranges pulled and stored (or that would be, in --dry-run). */
  ranges: SyncRange[]
  rowsFetched: number
  rowsChanged: number
  /** Due work left for a later run (a cap). */
  deferred: boolean
  /** Last closed flight day stored contiguously from the flight start. */
  through: string | null
  /** Only this kind's data: the last pull failed, or closed flight days are still missing. */
  stale: boolean
  warnings: string[]
  error: string | null
}
export interface ExtrasCampaignResult {
  campaignId: string
  label: string
  conversions: ExtrasKindResult
  assets: ExtrasKindResult
}
export interface ExtrasResult {
  source: SyncSource
  dryRun: boolean
  startedAt: string
  finishedAt: string
  status: SyncStatus
  /** Nothing was due: one state read, no Ads call, no write, no run row. */
  nothingDue: boolean
  campaigns: ExtrasCampaignResult[]
  /** Campaigns with work due that a cap left for the next run. */
  waiting: string[]
  conversionRowsFetched: number
  conversionRowsChanged: number
  assetRowsFetched: number
  assetRowsChanged: number
  campaignSyncError: string | null
  runRecorded: boolean
  error: string | null
}
export interface ExtrasDiff<R> {
  /** Rows to write: new or changed (a conversion action gone from a returned day: zero). */
  changed: R[]
  warnings: string[]
  /** The response cannot be trusted (empty over stored numbers): write nothing from it. */
  error: string | null
}

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
/** Carried-forward ranges kept per campaign and kind (they merge; normally one). */
const MAX_COVERED_RANGES = 50
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isEtDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && addDays(v, 0) === v
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && ISO_TS.test(v) && Number.isFinite(Date.parse(v)) ? v : null)
const inRange = (range: SyncRange) => (r: { date: string }) => r.date >= range.since && r.date <= range.until
const datesIn = (rows: readonly { date: string }[]) => [...new Set(rows.map((r) => r.date))].sort()
export const emptyExtrasKindState = (): ExtrasKindState => ({ covered: [], recheckedAt: null, attemptedAt: null, ok: null, error: null, rowsPerDay: null, rechecking: null })

/** Adds a range to sorted, merged [since, until] ranges (overlapping and adjacent ones join). */
export function addCoveredRange(covered: readonly [string, string][], r: SyncRange): [string, string][] {
  const all = [...covered, [r.since, r.until] as [string, string]].map(([s, u]) => [s, u] as [string, string]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const out: [string, string][] = []
  for (const [s, u] of all) {
    const last = out[out.length - 1]
    if (last && s <= addDays(last[1], 1)) {
      if (u > last[1]) last[1] = u
    } else out.push([s, u])
  }
  return out.slice(-MAX_COVERED_RANGES)
}
/** The covered days inside `window` (bounded by it, whatever the stored ranges say). */
function coveredDaysIn(covered: readonly [string, string][], window: SyncRange | null): Set<string> {
  const out = new Set<string>()
  if (!window) return out
  for (const [s, u] of covered) for (const d of etDateRange(s > window.since ? s : window.since, u < window.until ? u : window.until)) out.add(d)
  return out
}

function parseKindState(v: unknown): ExtrasKindState | null {
  if (!isRecord(v)) return null
  let covered: [string, string][] = []
  if (Array.isArray(v.covered))
    for (const r of v.covered.slice(0, MAX_COVERED_RANGES * 2))
      if (Array.isArray(r) && r.length === 2 && isEtDay(r[0]) && isEtDay(r[1]) && r[0] <= r[1]) covered = addCoveredRange(covered, { since: r[0], until: r[1] })
  return {
    covered,
    recheckedAt: isoOrNull(v.recheckedAt),
    attemptedAt: isoOrNull(v.attemptedAt),
    ok: typeof v.ok === 'boolean' ? v.ok : null,
    error: typeof v.error === 'string' && v.error ? summarizeError(v.error, 200) : null,
    rowsPerDay: typeof v.rowsPerDay === 'number' && Number.isInteger(v.rowsPerDay) && v.rowsPerDay > 0 && v.rowsPerDay <= 100_000 ? v.rowsPerDay : null,
    rechecking: typeof v.rechecking === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.rechecking) ? v.rechecking : null,
  }
}
/** The pass's carried-forward state from its latest run row's detail (`extras`): configured
 * campaigns only, and anything malformed dropped (that kind then starts over; the upserts are
 * idempotent). */
export function parseExtrasState(detail: unknown): ExtrasState {
  const out: ExtrasState = {}
  const extras = isRecord(detail) && isRecord(detail.extras) ? detail.extras : null
  if (!extras) return out
  for (const c of syncableCampaigns()) {
    const v = extras[c.id]
    if (!isRecord(v)) continue
    const entry: Partial<Record<ExtrasKind, ExtrasKindState>> = {}
    for (const k of EXTRAS_KINDS) {
      const s = parseKindState(v[k])
      if (s) entry[k] = s
    }
    out[c.id] = entry
  }
  return out
}
const kindStateOf = (state: ExtrasState, id: string, kind: ExtrasKind): ExtrasKindState => state[id]?.[kind] ?? emptyExtrasKindState()

/** The closed ET days the pass pulls for a campaign: flight start through flight end plus
 * RESTATEMENT_DAYS, never past the last closed day. The registry's DATES decide, not its status
 * (a status can be stale: an ended flight marked active would otherwise be pulled to yesterday). */
export function extrasWindow(c: Pick<CampaignFlight, 'flightStart' | 'flightEnd'>, todayEt: string, nowMs: number): SyncRange | null {
  if (!c.flightStart) return null
  const beforeClose = etDateFast(nowMs) === todayEt && nowMs < etWallTimeMs(todayEt, CLOSED_AFTER_ET)
  const lastClosed = addDays(todayEt, beforeClose ? -2 : -1)
  const end = addDays(c.flightEnd, RESTATEMENT_DAYS)
  const until = end < lastClosed ? end : lastClosed
  return c.flightStart <= until ? { since: c.flightStart, until } : null
}

/** Sorted days as contiguous ranges, oldest first. */
function runsOf(days: readonly string[]): SyncRange[] {
  const out: SyncRange[] = []
  for (const d of days) {
    const last = out[out.length - 1]
    if (last && addDays(last.until, 1) === d) last.until = d
    else out.push({ since: d, until: d })
  }
  return out
}

/** Pure: what one kind of one campaign needs, newest first: the restatement window (the last
 * RESTATEMENT_DAYS closed days of the extras window) when its re-check is due or any of it is
 * missing (a re-check split over runs resumes below the oldest day it has re-pulled), then each
 * run of days not yet covered. A covered day outside the restatement window
 * is never pulled again (a full re-pull, the backfill, takes the whole window). */
export function planExtrasKind(
  c: Pick<CampaignFlight, 'id' | 'flightStart' | 'flightEnd'>,
  state: ExtrasKindState,
  todayEt: string,
  opts: { nowMs: number; full?: boolean; restatementRecheckMs?: number },
): ExtrasKindPlan {
  const window = extrasWindow(c, todayEt, opts.nowMs)
  if (!window) return { window: null, ranges: [], recheck: null, missingDays: [], restatementDue: false, deferred: false }
  const covered = coveredDaysIn(state.covered, window)
  const days = etDateRange(window.since, window.until)
  const missingDays = days.filter((d) => !covered.has(d))
  const restateFrom = addDays(todayEt, -RESTATEMENT_DAYS)
  const recentSince = restateFrom > window.since ? restateFrom : window.since
  const recent = recentSince <= window.until ? { since: recentSince, until: window.until } : null
  const recheckMs = opts.restatementRecheckMs ?? RESTATEMENT_RECHECK_MS
  const last = state.recheckedAt ? Date.parse(state.recheckedAt) : NaN
  const restatementDue = !!recent && (!!opts.full || recheckMs <= 0 || !Number.isFinite(last) || opts.nowMs - last >= recheckMs)
  const prog = state.rechecking
  const resume = !!recent && restatementDue && !opts.full && !!prog && prog > recent.since && prog <= recent.until && !missingDays.some((d) => d >= prog)
  const recheck = recent && (restatementDue || missingDays.some((d) => d >= recent.since)) ? (resume ? { since: recent.since, until: addDays(prog!, -1) } : recent) : null
  const older = (opts.full ? days : missingDays).filter((d) => !recent || d < recent.since)
  const ranges = [...(recheck ? [recheck] : []), ...runsOf(older).reverse()]
  return { window, ranges, recheck, missingDays, restatementDue, deferred: false }
}

/** Rows a day of each kind is planned at until that kind has returned rows (then the most rows
 * one day has returned, ExtrasKindState.rowsPerDay). */
export const EXTRAS_DEFAULT_ROWS_PER_DAY: Readonly<Record<ExtrasKind, number>> = { conversions: 6, assets: 30 }

/** What pulling `days` days of one kind is planned at: rows fetched, and D1 write statements with
 * every row assumed changed (the asset catalog: at most two days' worth of distinct assets). */
export function extrasCost(kind: ExtrasKind, days: number, rowsPerDay: number): { rows: number; statements: number } {
  const rows = days * rowsPerDay
  const statements =
    kind === 'conversions'
      ? Math.ceil(rows / CONVERSION_ROWS_PER_STATEMENT)
      : Math.ceil(rows / ASSET_ROWS_PER_STATEMENT) + Math.ceil(Math.min(rows, 2 * rowsPerDay) / ASSET_CATALOG_ROWS_PER_STATEMENT)
  return { rows, statements }
}

/** Pure: cuts the due plans, campaigns in `due` order, to one run's budget BEFORE anything is
 * fetched, so a run never pulls a campaign or kind it cannot write: `rows` (the Worker's CPU) and
 * `statements` (D1 reads and writes still free). Per kind: one stored read, then each range newest
 * first, each cut to its newest days that fit (a cut re-check stays due and resumes next run).
 * The run's first campaign takes one day of a kind that would otherwise take nothing, even past
 * `rows` (`statements` always holds), so a campaign denser than the row budget still moves. Sets the plans' ranges and `deferred`; returns who runs
 * and who waits. */
export function planExtrasRun(
  due: readonly CampaignFlight[],
  plans: Map<string, Record<ExtrasKind, ExtrasKindPlan>>,
  rowsPerDay: (campaignId: string, kind: ExtrasKind) => number,
  budget: { rows: number; statements: number },
): { toRun: CampaignFlight[]; waiting: string[] } {
  let rowsLeft = budget.rows
  let statementsLeft = budget.statements
  const toRun: CampaignFlight[] = []
  const waiting: string[] = []
  for (const c of due) {
    const head = toRun.length === 0
    let took = false
    for (const k of EXTRAS_KINDS) {
      const p = plans.get(c.id)![k]
      if (!p.ranges.length) continue
      const perDay = rowsPerDay(c.id, k)
      const kept: SyncRange[] = []
      for (const r of p.ranges) {
        const len = etDateRange(r.since, r.until).length
        const read = kept.length ? 0 : 1
        const fits = (n: number, soft: boolean) => {
          const e = extrasCost(k, n, perDay)
          return (soft || e.rows <= rowsLeft) && e.statements + read <= statementsLeft
        }
        let n = len
        while (n > 0 && !fits(n, false)) n--
        if (!n && head && !kept.length && fits(1, true)) n = 1
        if (n < len) p.deferred = true
        if (!n) continue
        const e = extrasCost(k, n, perDay)
        rowsLeft -= e.rows
        statementsLeft -= e.statements + read
        kept.push(n === len ? r : { since: addDays(r.until, -(n - 1)), until: r.until })
      }
      p.ranges = kept
      if (kept.length) took = true
    }
    if (took) toRun.push(c)
    else waiting.push(c.id)
  }
  return { toRun, waiting }
}

/** Where one kind stands: stored through which day, and whether only its data is stale. */
function extrasStanding(c: CampaignFlight, st: ExtrasKindState, plan: ExtrasKindPlan): { through: string | null; stale: boolean } {
  const through = contiguousThrough(c.flightStart, coveredDaysIn(st.covered, plan.window), c.flightEnd)
  const requiredUntil = plan.window ? (plan.window.until < c.flightEnd ? plan.window.until : c.flightEnd) : null
  return { through, stale: st.ok === false || (requiredUntil != null && (through == null || through < requiredUntil)) }
}

/** Pure: the conversion rows to write after pulling `range`. */
export function diffConversions(stored: readonly ConversionDayRow[], fresh: readonly ConversionDayRow[], range: SyncRange): ExtrasDiff<ConversionDayRow> {
  const merged = mergeConversionRows(fresh).filter(inRange(range))
  const old = stored.filter(inRange(range))
  const has = (r: ConversionDayRow) => r.conversions > 0 || r.allConversions > 0
  const key = (r: ConversionDayRow) => `${r.date}\u0000${r.conversionActionId}`
  const withData = old.filter(has)
  if (!merged.length && withData.length)
    return { changed: [], warnings: [], error: `ads conversions: the response for ${range.since}..${range.until} was empty but ${withData.length} stored row(s) have conversions (${datesIn(withData).join(', ')}); kept the stored values, treated as a failed fetch` }
  const byKey = new Map(old.map((r) => [key(r), r]))
  const changed = merged.filter((r) => {
    const s = byKey.get(key(r))
    return !s || s.conversions !== r.conversions || s.allConversions !== r.allConversions || (r.conversionActionName != null && r.conversionActionName !== s.conversionActionName)
  })
  const freshKeys = new Set(merged.map(key))
  const freshDays = new Set(merged.map((r) => r.date))
  const kept: ConversionDayRow[] = []
  for (const s of withData) {
    if (freshKeys.has(key(s))) continue
    // The day came back with other actions: this one has none now. A day left out entirely may
    // be a short response: kept as stored.
    if (freshDays.has(s.date)) changed.push({ ...s, conversionActionName: null, conversions: 0, allConversions: 0 })
    else kept.push(s)
  }
  const warnings = kept.length ? [`ads conversions: Google returned no rows for ${datesIn(kept).join(', ')}, which had stored conversions; kept as stored`] : []
  return { changed, warnings, error: null }
}

/** Pure: the asset rows to write after pulling `range`. Never zero-fills a stored row. */
export function diffAssets(stored: readonly AssetDayRow[], fresh: readonly AssetDayRow[], range: SyncRange): ExtrasDiff<AssetDayRow> {
  const merged = mergeAssetRows(fresh).filter(inRange(range))
  const old = stored.filter(inRange(range))
  const has = (r: AssetDayRow) => r.impressions > 0 || r.clicks > 0 || r.conversions > 0
  const key = (r: AssetDayRow) => [r.date, r.adGroupId, r.adId, r.assetId, r.fieldType].join('\u0000')
  const withData = old.filter(has)
  if (!merged.length && withData.length)
    return { changed: [], warnings: [], error: `ads assets: the response for ${range.since}..${range.until} was empty but ${withData.length} stored row(s) have delivery (${datesIn(withData).join(', ')}); kept the stored values, treated as a failed fetch` }
  const byKey = new Map(old.map((r) => [key(r), r]))
  const changed = merged.filter((r) => {
    const s = byKey.get(key(r))
    return !s || s.impressions !== r.impressions || s.clicks !== r.clicks || s.conversions !== r.conversions || (s.performanceLabel == null && r.performanceLabel != null)
  })
  const freshKeys = new Set(merged.map(key))
  const kept = withData.filter((s) => !freshKeys.has(key(s)))
  const warnings = kept.length ? [`ads assets: Google no longer returns ${kept.length} stored asset row(s) with delivery (${datesIn(kept).join(', ')}); kept as stored`] : []
  return { changed, warnings, error: null }
}

type Step<T> = { ok: true; value: T } | { ok: false; error: string; budget: boolean }
/** attempt(), plus: was it the D1 statement cap (QueryBudgetError: stop, it is not a failure)? */
async function step<T>(label: string, fn: () => Promise<T>): Promise<Step<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    return { ok: false, error: `${label}: ${maskCustomerId(redact(e))}`, budget: e instanceof QueryBudgetError }
  }
}

interface ExtrasKindOps<R> {
  read(store: AdsSyncStore, campaignId: string, since: string, until: string): Promise<R[]>
  fetch(ads: AdsExtrasSource, campaignId: string, since: string, until: string): Promise<R[]>
  diff(stored: readonly R[], fresh: readonly R[], range: SyncRange): ExtrasDiff<R>
  write(store: AdsSyncStore, campaignId: string, rows: readonly R[], fetchedAt: string): Promise<boolean>
}
const CONVERSION_OPS: ExtrasKindOps<ConversionDayRow> = {
  read: (s, id, since, until) => s.getConversionRows!(id, since, until),
  fetch: (ads, id, since, until) => ads.conversions(id, since, until),
  diff: diffConversions,
  write: (s, id, rows, at) => s.putConversions!(id, rows, at),
}
const ASSET_OPS: ExtrasKindOps<AssetDayRow> = {
  read: (s, id, since, until) => s.getAssetRows!(id, since, until),
  fetch: (ads, id, since, until) => ads.assets(id, since, until),
  diff: diffAssets,
  write: (s, id, rows, at) => s.putAssets!(id, rows, at),
}
interface ExtrasRun {
  store: AdsSyncStore
  dryRun: boolean
  getAds: () => Promise<AdsExtrasSource>
  ensureCampaigns: () => Promise<Step<boolean>>
  /** The D1 statement cap was reached: nothing more this run. */
  budgetHit: boolean
}

/** One kind of one campaign: one stored read over the plan's span, then each range (newest
 * first) pulled, checked and written on its own. A range counts as covered only once stored. */
async function pullExtrasKind<R extends { date: string }>(
  kind: ExtrasKind,
  ops: ExtrasKindOps<R>,
  c: CampaignFlight,
  plan: ExtrasKindPlan,
  prev: ExtrasKindState,
  run: ExtrasRun,
  startedAt: string,
): Promise<{ result: ExtrasKindResult; state: ExtrasKindState }> {
  const state: ExtrasKindState = { ...prev, covered: prev.covered.map(([s, u]) => [s, u]) }
  const result: ExtrasKindResult = { ok: null, ranges: [], rowsFetched: 0, rowsChanged: 0, deferred: plan.deferred, through: null, stale: false, warnings: [], error: null }
  const finish = () => {
    Object.assign(result, extrasStanding(c, state, plan))
    return { result, state }
  }
  if (!plan.ranges.length) return finish()
  if (run.budgetHit) {
    result.deferred = true
    return finish()
  }
  const errors: string[] = []
  let rechecked = false
  const stop = () => {
    run.budgetHit = true
    result.deferred = true
  }
  const ads = await step('ads', run.getAds)
  if (!ads.ok) errors.push(ads.error)
  else {
    const span = spanOf(plan.ranges)!
    const old = await step(`store read (${kind})`, () => ops.read(run.store, c.id, span.since, span.until))
    if (!old.ok) {
      if (old.budget) stop()
      else errors.push(old.error)
    } else
      for (const range of plan.ranges) {
        if (run.budgetHit) {
          result.deferred = true
          break
        }
        const fetched = await step(`ads ${kind}`, () => ops.fetch(ads.value, c.id, range.since, range.until))
        if (!fetched.ok) {
          errors.push(fetched.error)
          continue
        }
        result.rowsFetched += fetched.value.length
        const perDay = new Map<string, number>()
        for (const r of fetched.value) perDay.set(r.date, (perDay.get(r.date) ?? 0) + 1)
        const peak = Math.max(0, ...perDay.values())
        if (peak > 0) state.rowsPerDay = Math.max(state.rowsPerDay ?? 0, peak)
        const d = ops.diff(old.value, fetched.value, range)
        if (d.error) {
          errors.push(d.error)
          continue
        }
        result.warnings.push(...d.warnings)
        if (d.changed.length && !run.dryRun) {
          const cs = await run.ensureCampaigns()
          if (!cs.ok) {
            if (cs.budget) stop()
            else errors.push(cs.error) // nothing that references a campaign can be written
            break
          }
          const put = await step(`store write (${kind})`, () => ops.write(run.store, c.id, d.changed, startedAt))
          if (!put.ok) {
            if (put.budget) {
              stop()
              break
            }
            errors.push(put.error)
            continue
          }
        }
        result.ranges.push(range)
        result.rowsChanged += d.changed.length
        state.covered = addCoveredRange(state.covered, range)
        // the re-check (its newest days when cut): done once its oldest day is in, else resumes
        if (plan.recheck && range.until === plan.recheck.until && range.since >= plan.recheck.since) {
          if (range.since === plan.recheck.since) rechecked = true
          else state.rechecking = range.since
        }
      }
  }
  result.ok = errors.length ? false : result.ranges.length ? true : null
  result.error = errors[0] ? summarizeError(errors[0], 300) : null
  if (result.ok !== null) {
    state.attemptedAt = startedAt
    state.ok = result.ok
    state.error = result.ok ? null : summarizeError(errors[0], 200)
  }
  if (rechecked) {
    state.recheckedAt = startedAt
    state.rechecking = null
  }
  return finish()
}

/** The conversions-and-assets pass. Never throws for a data problem (failures are in the result
 * and its run row); only an unknown campaign id throws. */
export async function syncAdsExtras(deps: ExtrasDeps, opts: ExtrasOptions): Promise<ExtrasResult> {
  const t0 = Date.now()
  const startedAt = new Date(opts.now).toISOString()
  const todayEt = etDateFast(opts.now)
  const campaigns = syncableCampaigns(opts.campaignIds)
  const { store } = deps
  const result: ExtrasResult = {
    source: opts.source,
    dryRun: opts.dryRun,
    startedAt,
    finishedAt: startedAt,
    status: 'ok',
    nothingDue: false,
    campaigns: [],
    waiting: [],
    conversionRowsFetched: 0,
    conversionRowsChanged: 0,
    assetRowsFetched: 0,
    assetRowsChanged: 0,
    campaignSyncError: null,
    runRecorded: false,
    error: null,
  }
  const finished = () => new Date(opts.now + Math.max(0, Date.now() - t0)).toISOString()
  const failAll = (error: string): ExtrasResult => {
    const e = summarizeError(error, 300)
    const failed = (): ExtrasKindResult => ({ ok: false, ranges: [], rowsFetched: 0, rowsChanged: 0, deferred: false, through: null, stale: true, warnings: [], error: e })
    return { ...result, status: 'failed', error: e, finishedAt: finished(), campaigns: campaigns.map((c) => ({ campaignId: c.id, label: c.label, conversions: failed(), assets: failed() })) }
  }
  if (!store.getConversionRows || !store.putConversions || !store.getAssetRows || !store.putAssets || !store.getLastExtrasRun) return failAll('store: no conversions and assets tables in this store')
  // The state is unreadable: stop, and write no run row (it would drop the state carried forward).
  const last = await step('store read (extras state)', () => store.getLastExtrasRun!())
  if (!last.ok) return failAll(last.error)
  const state = parseExtrasState(last.value?.detail)

  const plans = new Map<string, Record<ExtrasKind, ExtrasKindPlan>>()
  const planOpts = { nowMs: opts.now, full: opts.full, restatementRecheckMs: opts.restatementRecheckMs }
  for (const c of campaigns)
    plans.set(c.id, { conversions: planExtrasKind(c, kindStateOf(state, c.id, 'conversions'), todayEt, planOpts), assets: planExtrasKind(c, kindStateOf(state, c.id, 'assets'), todayEt, planOpts) })
  const dueKinds = (id: string) => EXTRAS_KINDS.filter((k) => plans.get(id)![k].ranges.length > 0)
  // Least recently attempted first (never attempted before all), then in flight before ended (the
  // registry's dates: a status can be stale), then config order: a campaign that keeps failing
  // never holds the others back.
  const turn = (id: string) => dueKinds(id).map((k) => kindStateOf(state, id, k).attemptedAt ?? '').sort()[0] ?? ''
  const order = new Map(campaigns.map((c, i) => [c.id, i]))
  const ended = (c: CampaignFlight) => Number(c.flightEnd < addDays(todayEt, -1))
  const due = campaigns
    .filter((c) => dueKinds(c.id).length > 0)
    .sort((a, b) => (turn(a.id) !== turn(b.id) ? (turn(a.id) < turn(b.id) ? -1 : 1) : ended(a) - ended(b) || order.get(a.id)! - order.get(b.id)!))
  const budgetOf = (v: number | undefined) => (v != null && v > 0 ? Math.floor(v) : Infinity)
  // The state read is spent; the campaign definitions go first once anything is written.
  const statements = budgetOf(opts.statementBudget) - 1 - (opts.dryRun ? 0 : campaignSyncStatements(syncableCampaigns(), startedAt).length)
  const rowsPerDay = (id: string, k: ExtrasKind) => kindStateOf(state, id, k).rowsPerDay ?? EXTRAS_DEFAULT_ROWS_PER_DAY[k]
  const planned = planExtrasRun(due, plans, rowsPerDay, { rows: budgetOf(opts.maxRows), statements })
  const toRun = planned.toRun
  result.waiting = planned.waiting
  const waiting = new Set(result.waiting)
  const standing = (c: CampaignFlight, k: ExtrasKind): ExtrasKindResult => {
    const st = kindStateOf(state, c.id, k)
    const p = plans.get(c.id)![k]
    return { ok: null, ranges: [], rowsFetched: 0, rowsChanged: 0, deferred: p.deferred || (waiting.has(c.id) && p.ranges.length > 0), ...extrasStanding(c, st, p), warnings: [], error: st.ok === false ? st.error : null }
  }
  if (!toRun.length) {
    // Nothing due; or (a budget too small for even one day) nothing that fits: that waits.
    result.nothingDue = !due.length
    if (due.length) {
      result.status = 'partial'
      result.error = `work cap: ${result.waiting.join(', ')} continue next run`
    }
    result.campaigns = campaigns.map((c) => ({ campaignId: c.id, label: c.label, conversions: standing(c, 'conversions'), assets: standing(c, 'assets') }))
    result.finishedAt = finished()
    return result
  }

  let adsPromise: Promise<AdsExtrasSource> | null = null
  const getAds = () => {
    if (!adsPromise) {
      adsPromise = deps.ads ? Promise.resolve(deps.ads) : deps.adsFactory ? deps.adsFactory() : Promise.reject(new Error(deps.adsInitError ?? 'Google Ads client unavailable'))
      adsPromise.catch(() => {}) // surfaced per campaign and kind
    }
    return adsPromise
  }
  // Campaign definitions first (FOREIGN KEY), once, and only by a run that writes a row.
  let campaignsWrite: Promise<Step<boolean>> | null = null
  const ensureCampaigns = () => (campaignsWrite ??= step('store sync (campaigns)', () => store.syncCampaigns(syncableCampaigns(), startedAt)))
  const run: ExtrasRun = { store, dryRun: opts.dryRun, getAds, ensureCampaigns, budgetHit: false }
  const ran = new Map<string, ExtrasCampaignResult>()
  for (const c of toRun) {
    const p = plans.get(c.id)!
    const conv = await pullExtrasKind('conversions', CONVERSION_OPS, c, p.conversions, kindStateOf(state, c.id, 'conversions'), run, startedAt)
    const asst = await pullExtrasKind('assets', ASSET_OPS, c, p.assets, kindStateOf(state, c.id, 'assets'), run, startedAt)
    state[c.id] = { conversions: conv.state, assets: asst.state }
    ran.set(c.id, { campaignId: c.id, label: c.label, conversions: conv.result, assets: asst.result })
  }
  result.campaigns = campaigns.map((c) => ran.get(c.id) ?? { campaignId: c.id, label: c.label, conversions: standing(c, 'conversions'), assets: standing(c, 'assets') })
  for (const r of ran.values()) {
    result.conversionRowsFetched += r.conversions.rowsFetched
    result.conversionRowsChanged += r.conversions.rowsChanged
    result.assetRowsFetched += r.assets.rowsFetched
    result.assetRowsChanged += r.assets.rowsChanged
  }
  if (campaignsWrite) {
    const cw = await (campaignsWrite as Promise<Step<boolean>>)
    result.campaignSyncError = cw.ok || cw.budget ? null : cw.error
  }
  const kinds = [...ran.values()].flatMap((r) => [r.conversions, r.assets])
  const failed = kinds.filter((k) => k.ok === false)
  const deferred = result.campaigns.filter((r) => r.conversions.deferred || r.assets.deferred).map((r) => r.campaignId)
  const attempted = kinds.filter((k) => k.ok !== null)
  result.status = result.campaignSyncError || (failed.length && failed.length === attempted.length && kinds.every((k) => !k.ranges.length)) ? 'failed' : failed.length || deferred.length ? 'partial' : 'ok'
  const firstError = result.campaignSyncError ?? failed.find((k) => k.error)?.error ?? null
  result.error = firstError ? summarizeError(firstError, 300) : deferred.length ? `work cap: ${deferred.join(', ')} continue${deferred.length === 1 ? 's' : ''} next run` : null
  result.finishedAt = finished()
  if (!opts.dryRun) {
    const brief = (k: ExtrasKindResult) => ({ ranges: k.ranges, rows: k.rowsFetched, changed: k.rowsChanged, ok: k.ok, through: k.through, stale: k.stale, ...(k.deferred ? { deferred: true } : {}), ...(k.warnings.length ? { warnings: k.warnings } : {}) })
    const ids = toRun.map((c) => c.id)
    const rec = await step('store write (extras run)', () =>
      store.appendSyncRun({
        runKey: `${EXTRAS_RUN_KEY_PREFIX}${opts.source}:${startedAt}:${ids.join(',')}`,
        source: opts.source,
        startedAt,
        finishedAt: result.finishedAt,
        campaigns: ids,
        campaignsOk: [],
        campaignsPulled: [],
        daysFetched: 0,
        daysChanged: 0,
        placementRowsFetched: 0,
        placementRowsChanged: 0,
        status: result.status,
        error: result.error,
        detail: {
          worker: workerInfo(),
          extras: state,
          run: Object.fromEntries([...ran.values()].map((r) => [r.campaignId, { conversions: brief(r.conversions), assets: brief(r.assets) }])),
          ...(result.waiting.length ? { waiting: result.waiting } : {}),
        },
      }),
    )
    result.runRecorded = rec.ok && rec.value
    if (!rec.ok && !result.error) result.error = summarizeError(rec.error, 300)
  }
  return result
}

/** The JSON-safe summary the Worker logs: counts, ranges and standing only, no fetched rows. */
export function extrasResultSummary(r: ExtrasResult) {
  const k = (x: ExtrasKindResult) => ({ ok: x.ok, ranges: x.ranges, rowsFetched: x.rowsFetched, rowsChanged: x.rowsChanged, through: x.through, stale: x.stale, deferred: x.deferred, error: x.error, warnings: x.warnings })
  return {
    source: r.source,
    status: r.status,
    nothingDue: r.nothingDue,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    conversionRowsFetched: r.conversionRowsFetched,
    conversionRowsChanged: r.conversionRowsChanged,
    assetRowsFetched: r.assetRowsFetched,
    assetRowsChanged: r.assetRowsChanged,
    waiting: r.waiting,
    runRecorded: r.runRecorded,
    error: r.error,
    campaigns: r.campaigns.map((c) => ({ campaignId: c.campaignId, conversions: k(c.conversions), assets: k(c.assets) })),
  }
}

/** One line per campaign, for CLI reports. */
export function extrasSummaryLines(r: ExtrasResult): string[] {
  const verb = r.dryRun ? 'would change' : 'changed'
  const head = r.nothingDue
    ? `Conversions and assets (${r.source}): nothing due; no Google call, nothing written`
    : `Conversions and assets (${r.source})${r.dryRun ? ' [DRY RUN: nothing written]' : ''}: ${r.status}; conversions ${r.conversionRowsFetched} row(s) fetched, ${r.conversionRowsChanged} ${verb}; assets ${r.assetRowsFetched} row(s) fetched, ${r.assetRowsChanged} ${verb}${r.dryRun ? '' : `; run ${r.runRecorded ? 'recorded' : 'NOT recorded'}`}${r.error ? `; ${r.error}` : ''}`
  const kind = (x: ExtrasKindResult) =>
    `${x.ok === null ? (x.deferred ? 'waiting' : 'up to date') : x.ok ? (x.rowsChanged ? 'synced' : 'no change') : 'failed'}${x.ranges.length ? ` (${x.ranges.map((y) => `${y.since}..${y.until}`).join(', ')})` : ''}, through ${x.through ?? '—'}${x.stale ? ' [stale]' : ''}${x.error ? `, error: ${x.error}` : ''}${x.warnings.length ? `, warning: ${x.warnings.join('; ')}` : ''}`
  return [head, ...r.campaigns.map((c) => `  ${c.campaignId} ${c.label}: conversions ${kind(c.conversions)}; assets ${kind(c.assets)}`)]
}

// ── Build identity: catches a Worker running an older campaigns.ts ────────────────────────
let buildSha: string | null = null
/** The deploying commit, set by the Worker from its GIT_SHA var (npm run ads:worker-deploy). */
export function setBuildSha(sha: string | null | undefined): void {
  buildSha = sha && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null
}
/** FNV-1a of the campaign definitions the sync uses, over every field it writes to ads_campaigns
 * (review I1): the dashboard compares it with its own and flags a Worker built from other ones.
 * A non-display campaign's channel (channelOf) is appended to its tuple, since it decides
 * whether the sync pulls placements, and so is `noPlacements`; a display-only config hashes exactly as before. */
export function campaignsConfigHash(campaigns: readonly CampaignFlight[] = CAMPAIGNS): string {
  const s = JSON.stringify(
    campaigns.map((c) => {
      const t: unknown[] = [c.id, c.label, c.kind, c.flightStart, c.flightStartTimeEt ?? null, c.flightEnd, c.ucValues, c.dailyBudgetUsd ?? null, c.hardCapUsd ?? null, c.measurement ?? null]
      const channel = channelOf(c.id)
      if (channel !== 'display') t.push(channel)
      if (c.noPlacements) t.push('noPlacements')
      return t
    }),
  )
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
export function workerInfo(): { gitSha: string | null; campaignsHash: string } {
  return { gitSha: buildSha, campaignsHash: campaignsConfigHash() }
}

// ── The gss-stats-sync Worker's schedule and on-demand guard (workers/sync/) ──────────────
/** Campaigns in a live flight today (ET): from the first flight day through the day after the
 * last one (so the last day is pulled once it has closed); a flight past that day never counts. */
export function liveFlightCampaigns(nowMs: number, campaigns: readonly CampaignFlight[] = CAMPAIGNS): CampaignFlight[] {
  const todayEt = etDateFast(nowMs)
  return campaigns.filter((c) => c.flightStart != null && todayEt >= c.flightStart && todayEt <= addDays(c.flightEnd, 1))
}
/** The ET hour of the daily pass outside a flight: 03:xx, once yesterday counts as closed
 * (lib/adsFreshness.ts CLOSED_AFTER_ET). */
export const DAILY_SYNC_ET_HOUR = 3
/** The Worker's cron fires every hour (at :05). While a flight is live every tick checks what
 * is due (yesterday once, at 03:05 ET when it has closed; a retry after a failure; the
 * restatement window every RESTATEMENT_RECHECK_MS); outside a flight only the 03:xx ET tick
 * does. A skipped
 * tick, and a tick with nothing due, never reads a secret or calls Google. */
export function cronShouldSync(nowMs: number, campaigns: readonly CampaignFlight[] = CAMPAIGNS): { run: boolean; reason: string } {
  const live = liveFlightCampaigns(nowMs, campaigns)
  if (live.length) return { run: true, reason: `live flight: ${live.map((c) => c.id).join(', ')}` }
  return etHourFast(nowMs) === DAILY_SYNC_ET_HOUR ? { run: true, reason: 'daily pass' } : { run: false, reason: `no live flight; the daily pass runs at 0${DAILY_SYNC_ET_HOUR}:xx ET` }
}

/** At most one sync (on demand or cron) per this interval; enforced atomically by the claim. */
export const ON_DEMAND_MIN_INTERVAL_MS = 10 * 60_000
export function rateLimit(lastFinishedAt: string | null, nowMs: number, minIntervalMs: number = ON_DEMAND_MIN_INTERVAL_MS): { limited: boolean; retryAfterSec: number } {
  const last = lastFinishedAt ? Date.parse(lastFinishedAt) : NaN
  if (!Number.isFinite(last)) return { limited: false, retryAfterSec: 0 }
  const wait = last + minIntervalMs - nowMs
  return wait > 0 ? { limited: true, retryAfterSec: Math.ceil(wait / 1000) } : { limited: false, retryAfterSec: 0 }
}

/** The JSON-safe summary a Worker returns or logs: counts and ranges only, no fetched rows. */
export function syncResultSummary(r: SyncResult) {
  return {
    source: r.source,
    status: r.status,
    nothingDue: r.nothingDue,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    daysFetched: r.daysFetched,
    daysChanged: r.daysChanged,
    placementRowsFetched: r.placementRowsFetched,
    placementRowsChanged: r.placementRowsChanged,
    runRecorded: r.runRecorded,
    error: r.error,
    campaigns: r.campaigns.map((c) => ({ campaignId: c.campaignId, outcome: c.outcome, fetched: c.fetched, ranges: c.ranges, daysChanged: c.daysChanged, placementRowsChanged: c.placementRowsChanged, spendThrough: c.spendThrough, warnings: c.warnings })),
  }
}

/** One line per campaign, for CLI reports. */
export function syncSummaryLines(r: SyncResult): string[] {
  if (r.nothingDue) return [`Sync (${r.source}): nothing due — every closed day is stored and the restatement window was re-checked within ${RESTATEMENT_RECHECK_MS / 3_600_000} h; no Google call, nothing written`, ...r.campaigns.map((c) => `  ${c.campaignId} ${c.label}: up to date; spend through ${c.spendThrough ?? '—'}`)]
  const lines = [
    `Sync (${r.source})${r.dryRun ? ' [DRY RUN: nothing written]' : ''}: ${r.status}; ${r.daysFetched} day(s) fetched, ${r.daysChanged} ${r.dryRun ? 'would change' : 'changed'}; ${r.placementRowsFetched} placement row(s) fetched, ${r.placementRowsChanged} ${r.dryRun ? 'would change' : 'changed'}${r.dryRun ? '' : `; run ${r.runRecorded ? 'recorded' : 'NOT recorded'}`}`,
  ]
  for (const c of r.campaigns) {
    lines.push(
      `  ${c.campaignId} ${c.label}: ${c.outcome}${c.ranges.length ? ` (${c.ranges.map((x) => `${x.since}..${x.until}`).join(', ')})` : ''}; spend through ${c.spendThrough ?? '—'}${c.missingDays ? `; ${c.missingDays} day(s) were missing` : ''}${c.restated.length ? `; restated ${c.restated.map((x) => `${x.date} $${x.before.toFixed(2)}→$${x.after.toFixed(2)}`).join(', ')}` : ''}${c.error ? `; error: ${c.error}` : ''}${c.warnings.length ? `; warning: ${c.warnings.join('; ')}` : ''}`,
    )
  }
  return lines
}
