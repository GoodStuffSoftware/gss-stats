// syncAdsData — the ONE code path that pulls Google Ads metrics into gss-stats-ads.
//
// Every caller runs this and nothing else to fetch spend: the morning read and the backstop
// (scripts/ads-reads/morning-read.ts), the post-flight read, the backfill, `npm run ads:sync`,
// and the gss-stats-sync Worker (workers/sync/). Runtime-agnostic: the Ads API arrives as an
// AdsMetricsSource (lib/adsApi.ts, plain fetch) and the database as an AdsSyncStore
// (lib/adsStore.ts createSqlAdsStore over a wrangler-CLI or a D1-binding adapter).
//
// Per campaign it:
//  1. reads the stored day rows;
//  2. works out the missing CLOSED ET days — from the flight's first day (or the first gap)
//     through yesterday — plus the most recent RESTATEMENT_DAYS closed days, which Google still
//     restates, and pulls that one range (daily metrics and placement-day rows);
//  3. zero-fills closed days the API returns nothing for (no rows = no delivery), so the stored
//     days are contiguous and "spend through" is simply the last stored day;
//  4. writes ONLY rows that are new or changed (values, a day that was stored while still open,
//     or a placement pull that had not covered the day yet). A second run in a row therefore
//     writes no metric row at all.
// Then it appends one ads_sync_runs row (not in --dry-run) so freshness is observable.
//
// Open (today's) data is never stored. `includeToday` returns today's partial numbers to the
// caller (the backstop's "served today?" check) without writing them.

import { CAMPAIGNS, type CampaignFlight } from './campaigns'
import { microsToDollars, round2, type SpendDay, type StoredSpend } from './adsRules'
import { mergePlacementDayRows, rowsToStoredSpend, type AdsSyncStore, type PlacementDayRow, type StoredDayRow, type SyncRunRecord, type SyncSource, type SyncStatus } from './adsStore'
import { addEtDays, contiguousThrough, etDateRange, isClosedFetch } from './adsFreshness'
import { etDateFromMs } from './popupEvents'
import { redact, summarizeError } from './adsRedact'

/** Google restates recent days (invalid-click credits, late conversions): re-pull this many. */
export const RESTATEMENT_DAYS = 3
/** A closed campaign is synced through its flight end plus this many days (stray spend). */
export const CLOSED_CAMPAIGN_GRACE_DAYS = 3

export interface AdsMetricsSource {
  daily(campaignId: string, since: string, until: string): Promise<Record<string, SpendDay>>
  placements(campaignId: string, since: string, until: string): Promise<PlacementDayRow[]>
}

export interface SyncOptions {
  /** Default: every configured campaign with a flight start. */
  campaignIds?: readonly string[]
  /** Clock (ms). */
  now: number
  dryRun: boolean
  source: SyncSource
  /** Re-pull every day in the window, not just gaps and the restatement window (the backfill). */
  full?: boolean
  /** Also read today's partial numbers (returned, never stored). */
  includeToday?: boolean
  /** Default true. */
  placements?: boolean
}
export interface SyncDeps {
  /** null when the Ads client could not be built; `adsInitError` says why. */
  ads: AdsMetricsSource | null
  adsInitError?: string | null
  store: AdsSyncStore
}

export interface SyncRange {
  since: string
  until: string
}
export interface CampaignSyncPlan {
  campaignId: string
  /** The campaign's sync window (closed days), or null when it has none yet. */
  window: SyncRange | null
  /** Closed days to fetch and compare (null = nothing to pull). */
  fetch: SyncRange | null
  missingDays: string[]
  missingPlacementDays: string[]
  restatementDays: string[]
  /** Today's partial read, when asked for and the campaign is not closed. */
  today: string | null
}
export interface CampaignSyncResult {
  campaignId: string
  label: string
  window: SyncRange | null
  fetched: SyncRange | null
  /** 'up to date' | 'synced' | 'failed' | … — one short word or phrase for reports. */
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
  campaigns: CampaignSyncResult[]
  daysFetched: number
  daysChanged: number
  placementRowsFetched: number
  placementRowsChanged: number
  /** The ads_campaigns upsert ran (false in --dry-run). */
  campaignsSynced: boolean
  /** The ads_campaigns upsert failed: nothing that references a campaign can be written. */
  campaignSyncError: string | null
  runRecorded: boolean
  error: string | null
}

const ZERO: SpendDay = { costMicros: 0, impressions: 0, clicks: 0 }
const min = (xs: (string | undefined)[]) => xs.filter((x): x is string => !!x).sort()[0]

/** Campaigns the sync covers: every configured campaign with a flight start, or the given ids
 * (an unknown id is an error — never a silent no-op). */
export function syncableCampaigns(ids?: readonly string[]): CampaignFlight[] {
  const all = CAMPAIGNS.filter((c) => c.flightStart != null)
  if (!ids?.length) return all
  const unknown = ids.filter((id) => !all.some((c) => c.id === id))
  if (unknown.length) throw new Error(`not a syncable campaign: ${unknown.join(', ')}`)
  return all.filter((c) => ids.includes(c.id))
}

/** The closed ET days a campaign's data can cover at `todayEt`: flight start through yesterday
 * (a closed campaign: through flight end + CLOSED_CAMPAIGN_GRACE_DAYS). */
export function syncWindow(c: Pick<CampaignFlight, 'flightStart' | 'flightEnd' | 'status'>, todayEt: string): SyncRange | null {
  if (!c.flightStart) return null
  const yesterday = addEtDays(todayEt, -1)
  const cap = c.status === 'closed' ? addEtDays(c.flightEnd, CLOSED_CAMPAIGN_GRACE_DAYS) : yesterday
  const until = cap < yesterday ? cap : yesterday
  return c.flightStart <= until ? { since: c.flightStart, until } : null
}

/** Pure: what to pull for one campaign, given its stored rows. */
export function planCampaignSync(
  c: Pick<CampaignFlight, 'id' | 'flightStart' | 'flightEnd' | 'status'>,
  rows: readonly StoredDayRow[],
  todayEt: string,
  opts: { full?: boolean; includeToday?: boolean; placements?: boolean } = {},
): CampaignSyncPlan {
  const window = syncWindow(c, todayEt)
  const today = opts.includeToday && c.status !== 'closed' && c.flightStart != null && c.flightStart <= todayEt ? todayEt : null
  if (!window) return { campaignId: c.id, window, fetch: null, missingDays: [], missingPlacementDays: [], restatementDays: [], today }
  const byDate = new Map(rows.map((r) => [r.date, r]))
  const days = etDateRange(window.since, window.until)
  const missingDays = days.filter((d) => !isClosedFetch(d, byDate.get(d)?.fetchedAt))
  const missingPlacementDays = opts.placements === false ? [] : days.filter((d) => !isClosedFetch(d, byDate.get(d)?.placementsFetchedAt))
  const restateFrom = addEtDays(todayEt, -RESTATEMENT_DAYS)
  const restatementDays = days.filter((d) => d >= restateFrom)
  const since = opts.full ? window.since : min([missingDays[0], missingPlacementDays[0], restatementDays[0]])
  return { campaignId: c.id, window, fetch: since ? { since, until: window.until } : null, missingDays, missingPlacementDays, restatementDays, today }
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

/** Pure: which placement rows to write. A stored row the fresh pull no longer returns (restated
 * away) is written back as zero cost, never deleted (the writer has no DELETE). */
export function diffPlacements(stored: readonly PlacementDayRow[], fresh: readonly PlacementDayRow[]): PlacementDayRow[] {
  const merged = mergePlacementDayRows(fresh)
  const key = (r: PlacementDayRow) => `${r.date}\u0000${r.placement}`
  const old = new Map(stored.map((r) => [key(r), r]))
  const out: PlacementDayRow[] = merged.filter((r) => {
    const s = old.get(key(r))
    return !s || !samePlacement(s, r)
  })
  const freshKeys = new Set(merged.map(key))
  for (const s of stored) {
    if (freshKeys.has(key(s)) || (s.costMicros === 0 && s.impressions === 0 && s.clicks === 0)) continue
    out.push({ ...s, costMicros: 0, impressions: 0, clicks: 0 })
  }
  return out
}

/** Pure: the day rows to write after a pull, and what they change. */
export function diffDays(
  stored: readonly StoredDayRow[],
  fresh: Record<string, SpendDay>,
  range: SyncRange,
  nowIso: string,
  placementsCovered: boolean,
): { rows: StoredDayRow[]; restated: { date: string; beforeMicros: number; afterMicros: number }[] } {
  const byDate = new Map(stored.map((r) => [r.date, r]))
  const rows: StoredDayRow[] = []
  const restated: { date: string; beforeMicros: number; afterMicros: number }[] = []
  for (const d of etDateRange(range.since, range.until)) {
    const f = fresh[d] ?? ZERO
    const s = byDate.get(d)
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
  return { rows, restated }
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: string }
async function attempt<T>(label: string, fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    return { ok: false, error: `${label}: ${redact(e)}` }
  }
}

async function syncOne(deps: SyncDeps, c: CampaignFlight, opts: SyncOptions, todayEt: string, nowIso: string, canWrite: boolean): Promise<CampaignSyncResult> {
  const res: CampaignSyncResult = {
    campaignId: c.id,
    label: c.label,
    window: null,
    fetched: null,
    outcome: 'up to date',
    missingDays: 0,
    daysFetched: 0,
    daysChanged: 0,
    changedDates: [],
    restated: [],
    placementRowsFetched: 0,
    placementRowsChanged: 0,
    placementsOk: null,
    fetchOk: true,
    dailyOk: true,
    spendThrough: null,
    spend: null,
    placements: [],
    today: null,
    error: null,
  }
  const fail = (error: string, outcome = 'failed') => Object.assign(res, { fetchOk: false, dailyOk: false, outcome, error })

  const storedA = await attempt('store read (daily metrics)', () => deps.store.getDailyRows(c.id))
  if (!storedA.ok) return fail(storedA.error)
  const stored = storedA.value
  const plan = planCampaignSync(c, stored, todayEt, opts)
  res.window = plan.window
  res.missingDays = plan.missingDays.length
  const closedSet = () => new Set(stored.filter((r) => isClosedFetch(r.date, r.fetchedAt)).map((r) => r.date))
  res.spendThrough = contiguousThrough(c.flightStart, closedSet())
  res.spend = rowsToStoredSpend(c.id, stored.filter((r) => isClosedFetch(r.date, r.fetchedAt)))
  if (!plan.fetch && !plan.today) return res

  if (!deps.ads) return fail(`ads daily: ${deps.adsInitError ?? 'Google Ads client unavailable'}`)
  const ads = deps.ads
  const dailySince = plan.fetch?.since ?? plan.today!
  const dailyUntil = plan.today ?? plan.fetch!.until
  const dailyA = await attempt('ads daily', () => ads.daily(c.id, dailySince, dailyUntil))
  if (!dailyA.ok) return fail(dailyA.error)
  if (plan.today) res.today = dailyA.value[plan.today] ?? { ...ZERO }
  if (!plan.fetch) return res
  res.fetched = plan.fetch
  const range = plan.fetch
  const freshDays: Record<string, SpendDay> = {}
  for (const d of etDateRange(range.since, range.until)) freshDays[d] = dailyA.value[d] ?? { ...ZERO }
  res.daysFetched = Object.keys(freshDays).length

  // Placements first: a day's placements_fetched_at is only set once its rows are stored.
  let placementsCovered = false
  if (opts.placements !== false) {
    const plA = await attempt('ads placements', () => ads.placements(c.id, range.since, range.until))
    if (!plA.ok) {
      res.placementsOk = false
      res.error = plA.error
    } else {
      const merged = mergePlacementDayRows(plA.value)
      res.placements = merged
      res.placementRowsFetched = merged.length
      const oldA = await attempt('store read (placements)', () => deps.store.getPlacementRows(c.id, range.since, range.until))
      if (!oldA.ok) {
        res.placementsOk = false
        res.error = oldA.error
      } else {
        const changed = diffPlacements(oldA.value, merged)
        res.placementRowsChanged = changed.length
        const put = changed.length && canWrite ? await attempt('store write (placements)', () => deps.store.putPlacements(c.id, changed, nowIso)) : ({ ok: true, value: false } as Attempt<boolean>)
        if (!put.ok) {
          res.placementsOk = false
          res.error = put.error
        } else {
          res.placementsOk = true
          placementsCovered = true
        }
      }
    }
  }

  const { rows, restated } = diffDays(stored, freshDays, range, nowIso, placementsCovered)
  res.daysChanged = rows.length
  res.changedDates = rows.map((r) => r.date)
  res.restated = restated.map((r) => ({ date: r.date, before: round2(microsToDollars(r.beforeMicros)), after: round2(microsToDollars(r.afterMicros)) }))
  let dailyWriteError: string | null = null
  if (rows.length && canWrite) {
    const put = await attempt('store write (daily metrics)', () => deps.store.putDailyRows(c.id, rows))
    if (!put.ok) dailyWriteError = put.error
  }
  // The view the reads use: stored closed days overlaid with this run's pull (every pulled day
  // is closed) — the same in --dry-run, where nothing was written.
  const after = new Map(stored.map((r) => [r.date, r]))
  for (const [d, f] of Object.entries(freshDays)) after.set(d, { date: d, ...f, fetchedAt: nowIso, placementsFetchedAt: null })
  const closedAfter = [...after.values()].filter((r) => isClosedFetch(r.date, r.fetchedAt))
  res.spend = rowsToStoredSpend(c.id, closedAfter)
  res.spendThrough = contiguousThrough(c.flightStart, new Set(closedAfter.map((r) => r.date)))
  if (dailyWriteError) return Object.assign(res, { dailyOk: false, outcome: 'store write failed', error: dailyWriteError })
  res.outcome = res.placementsOk === false ? 'synced (placements failed)' : rows.length || res.placementRowsChanged ? 'synced' : 'no change'
  return res
}

/** The shared sync. Never throws for a data problem: failures are in the result (and its
 * ads_sync_runs row); only a programming error (an unknown campaign id) throws. */
export async function syncAdsData(deps: SyncDeps, opts: SyncOptions): Promise<SyncResult> {
  const t0 = Date.now()
  const startedAt = new Date(opts.now).toISOString()
  const todayEt = etDateFromMs(opts.now)
  const campaigns = syncableCampaigns(opts.campaignIds)
  const result: SyncResult = {
    source: opts.source,
    dryRun: opts.dryRun,
    startedAt,
    finishedAt: startedAt,
    status: 'ok',
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
  // Campaign definitions first: every stored row references ads_campaigns (FOREIGN KEY). An
  // unchanged config writes nothing.
  const sync = await attempt('store sync (campaigns)', () => deps.store.syncCampaigns(syncableCampaigns(), startedAt))
  result.campaignsSynced = sync.ok && sync.value
  result.campaignSyncError = sync.ok ? null : sync.error
  const canWrite = sync.ok && !opts.dryRun
  for (const c of campaigns) {
    const r = await syncOne(deps, c, opts, todayEt, startedAt, canWrite)
    if (!sync.ok && !r.error && (r.daysChanged || r.placementRowsChanged)) Object.assign(r, { dailyOk: false, outcome: 'not written: campaign sync failed', error: sync.error })
    result.campaigns.push(r)
  }
  for (const r of result.campaigns) {
    result.daysFetched += r.daysFetched
    result.daysChanged += r.daysChanged
    result.placementRowsFetched += r.placementRowsFetched
    result.placementRowsChanged += r.placementRowsChanged
  }
  const failed = result.campaigns.filter((r) => !r.dailyOk || r.placementsOk === false)
  result.status = !sync.ok ? 'failed' : !failed.length ? 'ok' : failed.length === result.campaigns.length && failed.every((r) => !r.dailyOk) ? 'failed' : 'partial'
  const firstError = (sync.ok ? null : sync.error) ?? failed.find((r) => r.error)?.error ?? null
  result.error = firstError ? summarizeError(firstError, 300) : null
  // An Ads client that could not be built (credentials) is reported even when nothing needed
  // pulling this time: it is what will fail the next pull.
  if (!deps.ads && result.status === 'ok') {
    result.status = 'partial'
    result.error = summarizeError(`ads: ${deps.adsInitError ?? 'Google Ads client unavailable'}`, 300)
  }
  result.finishedAt = new Date(opts.now + Math.max(0, Date.now() - t0)).toISOString()
  if (!opts.dryRun) {
    const run: SyncRunRecord = {
      runKey: `sync:${opts.source}:${startedAt}:${campaigns.map((c) => c.id).join(',')}`,
      source: opts.source,
      startedAt,
      finishedAt: result.finishedAt,
      campaigns: campaigns.map((c) => c.id),
      campaignsOk: result.campaigns.filter((r) => r.dailyOk).map((r) => r.campaignId),
      daysFetched: result.daysFetched,
      daysChanged: result.daysChanged,
      placementRowsFetched: result.placementRowsFetched,
      placementRowsChanged: result.placementRowsChanged,
      status: result.status,
      error: result.error,
      detail: Object.fromEntries(
        result.campaigns.map((r) => [
          r.campaignId,
          { fetched: r.fetched, days: r.daysFetched, changed: r.daysChanged, placements: r.placementRowsFetched, placementsChanged: r.placementRowsChanged, spendThrough: r.spendThrough, outcome: r.outcome },
        ]),
      ),
    }
    const rec = await attempt('store write (sync run)', () => deps.store.appendSyncRun(run))
    result.runRecorded = rec.ok && rec.value
    if (!rec.ok && !result.error) result.error = summarizeError(rec.error, 300)
  }
  return result
}

// ── The gss-stats-sync Worker's schedule and on-demand guard (workers/sync/) ──────────────
/** Campaigns in a live flight today (ET): from the first flight day through the day after the
 * last one (so the last day is pulled once it has closed). Closed campaigns never count. */
export function liveFlightCampaigns(nowMs: number, campaigns: readonly CampaignFlight[] = CAMPAIGNS): CampaignFlight[] {
  const todayEt = etDateFromMs(nowMs)
  return campaigns.filter((c) => c.flightStart != null && c.status !== 'closed' && todayEt >= c.flightStart && todayEt <= addEtDays(c.flightEnd, 1))
}
/** The ET hour of the daily pass outside a flight: just after midnight, once yesterday closed. */
export const DAILY_SYNC_ET_HOUR = 1
/** The Worker's cron fires every hour (at :05). It syncs on every tick while a flight is live —
 * a closed day is stored within the hour after midnight ET and a failed pass is retried the next
 * hour; the other ticks re-check the restatement window — and once a day (01:xx ET) otherwise.
 * A skipped tick does no I/O at all. */
export function cronShouldSync(nowMs: number, campaigns: readonly CampaignFlight[] = CAMPAIGNS): { run: boolean; reason: string } {
  const live = liveFlightCampaigns(nowMs, campaigns)
  if (live.length) return { run: true, reason: `live flight: ${live.map((c) => c.id).join(', ')}` }
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date(nowMs)))
  return hour === DAILY_SYNC_ET_HOUR ? { run: true, reason: 'daily pass' } : { run: false, reason: `no live flight; the daily pass runs at 0${DAILY_SYNC_ET_HOUR}:xx ET` }
}

/** At most one on-demand sync per this interval (the dashboard's "Refresh data"). */
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
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    daysFetched: r.daysFetched,
    daysChanged: r.daysChanged,
    placementRowsFetched: r.placementRowsFetched,
    placementRowsChanged: r.placementRowsChanged,
    runRecorded: r.runRecorded,
    error: r.error,
    campaigns: r.campaigns.map((c) => ({ campaignId: c.campaignId, outcome: c.outcome, fetched: c.fetched, daysChanged: c.daysChanged, placementRowsChanged: c.placementRowsChanged, spendThrough: c.spendThrough })),
  }
}

/** One line per campaign, for CLI reports. */
export function syncSummaryLines(r: SyncResult): string[] {
  const lines = [
    `Sync (${r.source})${r.dryRun ? ' [DRY RUN: nothing written]' : ''}: ${r.status}; ${r.daysFetched} day(s) fetched, ${r.daysChanged} ${r.dryRun ? 'would change' : 'changed'}; ${r.placementRowsFetched} placement row(s) fetched, ${r.placementRowsChanged} ${r.dryRun ? 'would change' : 'changed'}${r.dryRun ? '' : `; run ${r.runRecorded ? 'recorded' : 'NOT recorded'}`}`,
  ]
  for (const c of r.campaigns) {
    lines.push(
      `  ${c.campaignId} ${c.label}: ${c.outcome}${c.fetched ? ` (${c.fetched.since}..${c.fetched.until})` : ''}; spend through ${c.spendThrough ?? '—'}${c.missingDays ? `; ${c.missingDays} day(s) were missing` : ''}${c.restated.length ? `; restated ${c.restated.map((x) => `${x.date} $${x.before.toFixed(2)}→$${x.after.toFixed(2)}`).join(', ')}` : ''}${c.error ? `; error: ${c.error}` : ''}`,
    )
  }
  return lines
}
