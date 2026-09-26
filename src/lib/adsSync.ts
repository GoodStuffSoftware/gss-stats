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

import { CAMPAIGNS, type CampaignFlight } from './campaigns'
import { microsToDollars, round2, type SpendDay, type StoredSpend } from './adsRules'
import { mergePlacementDayRows, rowsToStoredSpend, type AdsSyncStore, type PlacementDayRow, type StoredDayRow, type SyncRunRecord, type SyncSource, type SyncStatus } from './adsStore'
import { contiguousThrough, etDateRange, isClosedFetch } from './adsFreshness'
import { addDays, etDateFast, etHourFast } from './etTime'
import { redact, summarizeError } from './adsRedact'

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
  /** Re-pull every day in the window, not just what is due (the backfill, an operator check). */
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
export function syncWindow(c: Pick<CampaignFlight, 'flightStart' | 'flightEnd' | 'status'>, todayEt: string): SyncRange | null {
  if (!c.flightStart) return null
  const yesterday = addDays(todayEt, -1)
  const cap = c.status === 'closed' ? addDays(c.flightEnd, CLOSED_CAMPAIGN_GRACE_DAYS) : yesterday
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
  const window = syncWindow(c, todayEt)
  const today = opts.includeToday && c.status !== 'closed' && c.flightStart != null && c.flightStart <= todayEt ? todayEt : null
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
  const ordered = [...campaigns].sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed'))
  let budget = opts.maxDays != null && opts.maxDays > 0 ? Math.floor(opts.maxDays) : Infinity
  for (const c of ordered) {
    const plan = planCampaignSync(c, snap.rows.get(c.id) ?? [], todayEt, {
      full: opts.full,
      includeToday: opts.includeToday,
      placements: opts.placements,
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
  // bad day never holds back the days around it; an empty response is not split (that is a
  // broken response, not a bad day).
  const after = new Map(closedStored.map((r) => [r.date, r]))
  const closedNow = new Set(closedStored.map((r) => r.date))
  const errors: string[] = []
  let attempted = 0
  let failedRanges = 0
  let placementsFailed = false
  let placementsPulled = false
  let writeFailed: string | null = null
  const isRecent = (r: SyncRange) => !!plan.recheck && r.until === plan.recheck.until
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
        if (!split(range, `did not add up (the daily rows ${why})`)) failRange(`ads daily: the daily rows for ${range.since}..${range.until} ${why}; nothing written for these days, treated as a failed fetch`)
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
    if (opts.placements !== false) {
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
    if (plan.recheck && range.since === plan.recheck.since && range.until === plan.recheck.until && (opts.placements === false || placementsCovered)) res.pulled = true
  }

  res.fetched = spanOf(res.ranges)
  res.error = errors[0] ?? null
  res.changedDates.sort()
  if (res.ranges.length) {
    res.spend = rowsToStoredSpend(c.id, [...after.values()])
    res.spendThrough = contiguousThrough(c.flightStart, closedNow, c.flightEnd)
  }
  if (opts.placements !== false && (placementsPulled || placementsFailed)) res.placementsOk = !placementsFailed
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
        ? `work cap: ${deferred.map((r) => r.campaignId).join(', ')} continue${deferred.length === 1 ? 's' : ''} next run`
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

// ── Build identity: catches a Worker running an older campaigns.ts ────────────────────────
let buildSha: string | null = null
/** The deploying commit, set by the Worker from its GIT_SHA var (npm run ads:worker-deploy). */
export function setBuildSha(sha: string | null | undefined): void {
  buildSha = sha && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null
}
/** FNV-1a of the campaign definitions the sync uses, over every field it writes to ads_campaigns
 * (review I1): the dashboard compares it with its own and flags a Worker built from other ones. */
export function campaignsConfigHash(campaigns: readonly CampaignFlight[] = CAMPAIGNS): string {
  const s = JSON.stringify(
    campaigns.map((c) => [c.id, c.label, c.kind, c.flightStart, c.flightStartTimeEt ?? null, c.flightEnd, c.status, c.ucValues, c.dailyBudgetUsd ?? null, c.hardCapUsd ?? null, c.measurement ?? null]),
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
 * last one (so the last day is pulled once it has closed). Closed campaigns never count. */
export function liveFlightCampaigns(nowMs: number, campaigns: readonly CampaignFlight[] = CAMPAIGNS): CampaignFlight[] {
  const todayEt = etDateFast(nowMs)
  return campaigns.filter((c) => c.flightStart != null && c.status !== 'closed' && todayEt >= c.flightStart && todayEt <= addDays(c.flightEnd, 1))
}
/** The ET hour of the daily pass outside a flight: just after midnight, once yesterday closed. */
export const DAILY_SYNC_ET_HOUR = 1
/** The Worker's cron fires every hour (at :05). While a flight is live every tick checks what
 * is due (a new closed day right after midnight ET, a retry after a failure, the restatement
 * window every RESTATEMENT_RECHECK_MS); outside a flight only the 01:xx ET tick does. A skipped
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
