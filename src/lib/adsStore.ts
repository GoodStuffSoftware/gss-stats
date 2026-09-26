// The ads-read store: gss-stats' OWN D1 database `gss-stats-ads` (binding `gss_stats_ads`),
// schema in migrations/gss-stats-ads/, decision in docs/adr/0001-ads-read-store.md.
//
// One module for every SQL statement that touches it, shared by every side:
//  - the local routine (scripts/ads-reads/) runs them through `wrangler d1 execute
//    gss-stats-ads --remote` (scripts/ads-reads/d1Store.ts wranglerAdsDb);
//  - the gss-stats-sync Worker (workers/sync/) runs them through its D1 binding
//    (d1BindingAdsDb below) — the same createSqlAdsStore on a different AdsDb adapter;
//  - the dashboard's Pages Functions run the readers through the binding, FAIL SOFT: a
//    missing binding, a missing table (a fresh local `wrangler pages dev`) or any D1 error
//    reads as "no stored data", so /api/campaigns falls back to lib/campaigns.ts
//    CAMPAIGN_SPEND and the readings panel shows an empty state instead of an error.
//
// Money is integer micros. No statement here is a compound SELECT (D1 caps those at 5 terms),
// none binds more than 100 parameters (D1's per-statement cap), and nothing here ever reads or
// writes the beacon's gss-geo database.

import type { CampaignFlight } from './campaigns'
import { CAMPAIGNS } from './campaigns'
import {
  microsToDollars,
  readingEntryKind,
  round2,
  stripLocalPaths,
  type ReadingKind,
  type ReadingRecord,
  type ResolvedSpend,
  type SpendDay,
  type SpendSummary,
  type StoredSpend,
} from './adsRules'
import { freshnessOf, isClosedFetch, spendThroughFromRows, type AdsFreshness } from './adsFreshness'

export const ADS_DB_NAME = 'gss-stats-ads'
export const ADS_DB_BINDING = 'gss_stats_ads'
/** Stamped on every ads_readings row. Bump when the read/rule logic changes meaning.
 * 1.1.0: spend comes from the shared sync (closed days only); same-day reruns are de-duped. */
export const ROUTINE_VERSION = 'ads-reads/1.1.0'
/** D1 caps a statement at 100 bound parameters; every builder chunks under it. */
export const MAX_BINDS = 100

export interface SqlStatement {
  sql: string
  binds: unknown[]
}

const dollarsToMicros = (usd: number | null | undefined): number | null => (usd == null ? null : Math.round(usd * 1_000_000))
const chunk = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))
const rowsPerStatement = (bindsPerRow: number) => Math.max(1, Math.floor(MAX_BINDS / bindsPerRow))

// ── Write guard (every adapter) ───────────────────────────────────────────────────────────
/** SQL with every quoted literal blanked, so keyword checks never trip on a campaign tag. */
export function stripSqlLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""')
}

const FORBIDDEN_IN_WRITES = /\b(DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|TRUNCATE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|REPLACE)\b/i

/** Writes are single INSERT statements into ads_* tables (upserts use ON CONFLICT ... DO
 * UPDATE / DO NOTHING); no DELETE, DROP, ALTER, bare UPDATE, PRAGMA or comment. Enforced by
 * createSqlAdsStore before any adapter sees the statement. */
export function assertAdsWriteSql(sql: string): void {
  const bare = stripSqlLiterals(sql).trim()
  const m = /^INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(bare)
  if (!m) throw new Error('ads store writes must be INSERT INTO <table>')
  if (!/^ads_[a-z_]+$/.test(m[1])) throw new Error(`ads store writes only ads_* tables, not ${m[1]}`)
  if (bare.includes(';')) throw new Error('ads store writes must be a single statement')
  if (/--|\/\*/.test(bare)) throw new Error('ads store writes must not contain SQL comments')
  const f = FORBIDDEN_IN_WRITES.exec(bare)
  if (f) throw new Error(`ads store writes must not contain ${f[1].toUpperCase()}`)
  // UPDATE only as the upsert clause "ON CONFLICT ... DO UPDATE SET".
  if (/\bUPDATE\b/i.test(bare.replace(/\bDO\s+UPDATE\s+SET\b/gi, ''))) throw new Error('ads store writes must not contain a bare UPDATE')
}

/** Store reads are single SELECTs. */
export function assertAdsReadSql(sql: string): void {
  const bare = stripSqlLiterals(sql).trim()
  if (!/^SELECT\b/i.test(bare)) throw new Error('ads store reads must be a SELECT')
  if (bare.includes(';') || /--|\/\*/.test(bare)) throw new Error('ads store reads must be a single statement without comments')
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA)\b/i.test(bare)) throw new Error('ads store reads must not write')
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────
const CAMPAIGN_COLS = ['id', 'name', 'uc_values', 'kind', 'flight_start', 'flight_start_time_et', 'flight_end', 'status', 'daily_budget_micros', 'hard_cap_micros', 'measurement', 'synced_at']

/** Upserts the configured campaigns — lib/campaigns.ts stays the source of truth; the table is
 * a synced copy so stored rows can reference it (FOREIGN KEY) and outlive config edits. The
 * update fires only when a definition actually changed, so an unchanged config is a no-op
 * (synced_at then records the last real change). */
export function campaignSyncStatements(campaigns: readonly CampaignFlight[], syncedAt: string): SqlStatement[] {
  const row = `(${CAMPAIGN_COLS.map(() => '?').join(', ')})`
  const data = CAMPAIGN_COLS.filter((c) => c !== 'id' && c !== 'synced_at')
  const update = CAMPAIGN_COLS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')
  const changed = data.map((c) => `ads_campaigns.${c} IS NOT excluded.${c}`).join(' OR ')
  return chunk(campaigns, rowsPerStatement(CAMPAIGN_COLS.length)).map((part) => ({
    sql: `INSERT INTO ads_campaigns (${CAMPAIGN_COLS.join(', ')}) VALUES ${part.map(() => row).join(', ')} ON CONFLICT (id) DO UPDATE SET ${update} WHERE ${changed}`,
    binds: part.flatMap((c) => [
      c.id,
      c.label,
      JSON.stringify(c.ucValues),
      c.kind,
      c.flightStart,
      c.flightStartTimeEt ?? null,
      c.flightEnd,
      c.status,
      dollarsToMicros(c.dailyBudgetUsd),
      dollarsToMicros(c.hardCapUsd),
      c.measurement === 'spend-only' ? 'spend-only' : 'beacon',
      syncedAt,
    ]),
  }))
}

/** One stored day of campaign metrics (ads_daily_metrics). */
export interface StoredDayRow {
  date: string
  costMicros: number
  impressions: number
  clicks: number
  /** When these metrics were last written; the day is CLOSED when this is a later ET day. */
  fetchedAt: string
  /** When the placement pull covering this day last succeeded (null = still to pull). */
  placementsFetchedAt: string | null
}

/** Upserts exactly the given day rows (the sync decides which rows changed). */
export function dailyRowUpserts(campaignId: string, rows: readonly StoredDayRow[]): SqlStatement[] {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1))
  return chunk(sorted, rowsPerStatement(8)).map((part) => ({
    sql:
      `INSERT INTO ads_daily_metrics (campaign_id, date, cost_micros, impressions, clicks, source, fetched_at, placements_fetched_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')} ` +
      `ON CONFLICT (campaign_id, date) DO UPDATE SET cost_micros = excluded.cost_micros, impressions = excluded.impressions, clicks = excluded.clicks, source = excluded.source, fetched_at = excluded.fetched_at, placements_fetched_at = excluded.placements_fetched_at`,
    binds: part.flatMap((d) => [campaignId, d.date, Math.round(d.costMicros), d.impressions, d.clicks, 'google-ads-api', d.fetchedAt, d.placementsFetchedAt ?? null]),
  }))
}

export interface PlacementDayRow {
  date: string
  placement: string
  displayName: string | null
  type: string | null
  targetUrl: string | null
  approved: boolean | null
  costMicros: number
  impressions: number
  clicks: number
}
/** group_placement_view can return one row per ad group for the same (date, placement); an
 * upsert of both would keep only the last (review L5). Sums them first — cost, impressions and
 * clicks — keeping the first row's labels; approved is true if either row says so. */
export function mergePlacementDayRows(rows: readonly PlacementDayRow[]): PlacementDayRow[] {
  const byKey = new Map<string, PlacementDayRow>()
  for (const r of rows) {
    if (!r.placement || !r.date) continue
    const k = `${r.date}\u0000${r.placement}`
    const prev = byKey.get(k)
    if (!prev) {
      byKey.set(k, { ...r })
      continue
    }
    prev.costMicros += r.costMicros
    prev.impressions += r.impressions
    prev.clicks += r.clicks
    prev.approved = prev.approved === true || r.approved === true ? true : prev.approved ?? r.approved
  }
  return [...byKey.values()]
}

export function placementDailyUpserts(campaignId: string, rows: readonly PlacementDayRow[], fetchedAt: string): SqlStatement[] {
  const usable = mergePlacementDayRows(rows)
  return chunk(usable, rowsPerStatement(11)).map((part) => ({
    sql:
      `INSERT INTO ads_placement_daily (campaign_id, date, placement, display_name, placement_type, target_url, approved, cost_micros, impressions, clicks, fetched_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')} ` +
      `ON CONFLICT (campaign_id, date, placement) DO UPDATE SET display_name = excluded.display_name, placement_type = excluded.placement_type, target_url = excluded.target_url, approved = excluded.approved, cost_micros = excluded.cost_micros, impressions = excluded.impressions, clicks = excluded.clicks, fetched_at = excluded.fetched_at`,
    binds: part.flatMap((r) => [
      campaignId,
      r.date,
      r.placement,
      r.displayName,
      r.type,
      r.targetUrl,
      r.approved == null ? null : r.approved ? 1 : 0,
      Math.round(r.costMicros),
      r.impressions,
      r.clicks,
      fetchedAt,
    ]),
  }))
}

/** One append (the table is append-only by trigger). `ON CONFLICT DO NOTHING` covers both
 * uniques: a retry of the same reading_key, and a second row for the same (campaign, ET date,
 * entry kind) — migration 0003's de-dup key. */
export function readingInsert(rec: ReadingRecord, routineVersion: string = ROUTINE_VERSION): SqlStatement {
  return {
    sql:
      'INSERT INTO ads_readings (reading_key, campaign_id, kind, stage, read_at, et_date, spend_through_et, cumulative_spend_micros, thresholds, complete, rules, proposal, decision, counts, notes, routine_version, entry_kind) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    binds: [
      rec.id,
      rec.campaignId,
      rec.kind,
      rec.stage ?? null,
      rec.readAt,
      rec.etDate,
      rec.spendThroughEt,
      dollarsToMicros(rec.cumulativeSpend),
      JSON.stringify(rec.thresholds),
      rec.complete ? 1 : 0,
      rec.rules == null ? null : JSON.stringify(rec.rules),
      rec.proposal === 'PROPOSE PAUSE' || rec.proposal === 'CONTINUE' ? rec.proposal : null,
      rec.decision == null ? null : JSON.stringify(rec.decision),
      JSON.stringify(rec.counts),
      JSON.stringify(rec.notes.map(stripLocalPaths)), // no local paths in stored notes (review L10)
      routineVersion,
      rec.entryKind ?? readingEntryKind(rec),
    ],
  }
}

/** Marks thresholds fired — only for a COMPLETE threshold read, pointing at its reading row
 * (found by the de-dup key, so it resolves even if a concurrent run stored that entry). The
 * primary key (campaign_id, threshold_usd) makes a second firing impossible. */
export function thresholdStateInsert(rec: ReadingRecord): SqlStatement | null {
  if (rec.kind !== 'threshold' || !rec.complete || !rec.thresholds.length) return null
  const ek = rec.entryKind ?? readingEntryKind(rec)
  return {
    sql:
      `INSERT INTO ads_threshold_state (campaign_id, threshold_usd, fired_at, reading_id) VALUES ${rec.thresholds
        .map(() => '(?, ?, ?, (SELECT id FROM ads_readings WHERE campaign_id = ? AND et_date = ? AND entry_kind = ?))')
        .join(', ')} ON CONFLICT (campaign_id, threshold_usd) DO NOTHING`,
    binds: rec.thresholds.flatMap((t) => [rec.campaignId, Math.round(t), rec.readAt, rec.campaignId, rec.etDate, ek]),
  }
}

// ── Sync runs (ads_sync_runs, migration 0003) ─────────────────────────────────────────────
export const SYNC_SOURCES = ['ads-sync', 'morning-read', 'backstop', 'postflight-read', 'backfill', 'worker-cron', 'worker-on-demand'] as const
export type SyncSource = (typeof SYNC_SOURCES)[number]
export type SyncStatus = 'ok' | 'partial' | 'failed'
export interface SyncRunRecord {
  runKey: string
  source: SyncSource
  startedAt: string
  finishedAt: string
  /** Campaign ids the run was asked to sync. */
  campaigns: string[]
  /** The ones whose daily metrics synced (lastSync is read from here). */
  campaignsOk: string[]
  daysFetched: number
  daysChanged: number
  placementRowsFetched: number
  placementRowsChanged: number
  status: SyncStatus
  /** Redacted, one line, no local paths. */
  error: string | null
  /** Per-campaign ranges and counts (anonymous). */
  detail: Record<string, unknown>
}
export function syncRunInsert(r: SyncRunRecord): SqlStatement {
  return {
    sql:
      'INSERT INTO ads_sync_runs (run_key, source, started_at, finished_at, campaigns, campaigns_ok, days_fetched, days_changed, placement_rows_fetched, placement_rows_changed, status, error, detail) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    binds: [
      r.runKey,
      r.source,
      r.startedAt,
      r.finishedAt < r.startedAt ? r.startedAt : r.finishedAt,
      JSON.stringify(r.campaigns),
      JSON.stringify(r.campaignsOk),
      r.daysFetched,
      r.daysChanged,
      r.placementRowsFetched,
      r.placementRowsChanged,
      r.status,
      r.error == null ? null : stripLocalPaths(r.error).slice(0, 500),
      JSON.stringify(r.detail),
    ],
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────
export const SPEND_SUMMARY_SQL =
  'SELECT campaign_id, SUM(cost_micros) AS cost_micros, SUM(impressions) AS impressions, SUM(clicks) AS clicks, COUNT(*) AS days, MIN(date) AS first_date, MAX(date) AS last_date, MAX(fetched_at) AS fetched_at FROM ads_daily_metrics GROUP BY campaign_id'
export const DAILY_ROWS_SQL = 'SELECT date, cost_micros, impressions, clicks, fetched_at, placements_fetched_at FROM ads_daily_metrics WHERE campaign_id = ? ORDER BY date'
export const PLACEMENT_ROWS_SQL =
  'SELECT date, placement, display_name, placement_type, target_url, approved, cost_micros, impressions, clicks FROM ads_placement_daily WHERE campaign_id = ? AND date >= ? AND date <= ? ORDER BY date, placement'
export const THRESHOLD_STATE_SQL = 'SELECT threshold_usd, fired_at FROM ads_threshold_state WHERE campaign_id = ? ORDER BY threshold_usd'
const READING_COLS = 'reading_key, campaign_id, kind, stage, read_at, et_date, spend_through_et, cumulative_spend_micros, thresholds, complete, rules, proposal, decision, counts, notes, routine_version, entry_kind'
export const READINGS_SQL = `SELECT ${READING_COLS} FROM ads_readings WHERE campaign_id = ? ORDER BY read_at DESC, id DESC LIMIT ?`
export const READINGS_ON_DAY_SQL = `SELECT ${READING_COLS} FROM ads_readings WHERE campaign_id = ? AND et_date = ? ORDER BY id`
/** Coverage rows for spendThrough (every campaign; a few hundred rows at most). */
export const COVERAGE_ROWS_SQL = 'SELECT campaign_id, date, fetched_at FROM ads_daily_metrics ORDER BY campaign_id, date'
/** Latest successful sync per campaign. */
export const LAST_SYNC_SQL = 'SELECT j.value AS campaign_id, MAX(r.finished_at) AS last_sync FROM ads_sync_runs AS r, json_each(r.campaigns_ok) AS j GROUP BY j.value'
/** When the latest sync run (any source) finished — the on-demand rate limit. */
export const LAST_RUN_SQL = 'SELECT MAX(finished_at) AS last FROM ads_sync_runs'
export const RECENT_SYNC_RUNS_SQL =
  'SELECT run_key, source, started_at, finished_at, campaigns, campaigns_ok, days_fetched, days_changed, placement_rows_fetched, placement_rows_changed, status, error FROM ads_sync_runs ORDER BY id DESC LIMIT ?'

const num = (x: unknown): number => (typeof x === 'number' ? x : Number(x) || 0)
const str = (x: unknown): string | null => (x == null ? null : String(x))

export function mapSpendSummary(row: Record<string, unknown>): SpendSummary {
  return {
    campaignId: String(row.campaign_id ?? ''),
    costMicros: num(row.cost_micros),
    impressions: num(row.impressions),
    clicks: num(row.clicks),
    days: num(row.days),
    firstDate: str(row.first_date),
    lastDate: str(row.last_date),
    fetchedAt: str(row.fetched_at),
  }
}

export function mapDailyRow(r: Record<string, unknown>): StoredDayRow {
  return {
    date: String(r.date),
    costMicros: num(r.cost_micros),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    fetchedAt: String(r.fetched_at ?? ''),
    placementsFetchedAt: str(r.placements_fetched_at),
  }
}

export function mapPlacementRow(r: Record<string, unknown>): PlacementDayRow {
  return {
    date: String(r.date),
    placement: String(r.placement),
    displayName: str(r.display_name),
    type: str(r.placement_type),
    targetUrl: str(r.target_url),
    approved: r.approved == null ? null : num(r.approved) === 1,
    costMicros: num(r.cost_micros),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
  }
}

/** Stored day rows as the in-memory StoredSpend the reads use. closedThroughEt is the last day
 * that was already closed when it was written, so restatement detection only compares closed
 * days. Accepts raw rows (snake_case) or StoredDayRows. */
export function rowsToStoredSpend(campaignId: string, rows: readonly (StoredDayRow | Record<string, unknown>)[]): StoredSpend | null {
  if (!rows.length) return null
  const days: Record<string, SpendDay> = {}
  let closedThroughEt: string | null = null
  let fetchedAt = ''
  for (const raw of rows) {
    const r = 'costMicros' in raw ? (raw as StoredDayRow) : mapDailyRow(raw as Record<string, unknown>)
    days[r.date] = { costMicros: r.costMicros, impressions: r.impressions, clicks: r.clicks }
    if (r.fetchedAt > fetchedAt) fetchedAt = r.fetchedAt
    if (isClosedFetch(r.date, r.fetchedAt) && (closedThroughEt == null || r.date > closedThroughEt)) closedThroughEt = r.date
  }
  return { v: 1, campaignId, source: 'google-ads-api', apiVersion: '', customerId: '', fetchedAt, closedThroughEt, days }
}

function parseJson<T>(x: unknown, fallback: T): T {
  if (typeof x !== 'string') return fallback
  try {
    return JSON.parse(x) as T
  } catch {
    return fallback
  }
}
const KINDS: readonly ReadingKind[] = ['daily', 'threshold', 'postflight', 'health']

export function mapReadingRow(row: Record<string, unknown>): ReadingRecord | null {
  const kind = String(row.kind ?? '') as ReadingKind
  if (!KINDS.includes(kind) || typeof row.read_at !== 'string') return null
  const micros = row.cumulative_spend_micros
  const rec: ReadingRecord = {
    v: 1,
    id: String(row.reading_key ?? ''),
    campaignId: String(row.campaign_id ?? ''),
    kind,
    ...(row.stage != null ? { stage: String(row.stage) } : {}),
    readAt: row.read_at,
    etDate: String(row.et_date ?? ''),
    spendThroughEt: str(row.spend_through_et),
    cumulativeSpend: micros == null ? null : round2(microsToDollars(num(micros))),
    thresholds: parseJson<number[]>(row.thresholds, []),
    complete: num(row.complete) === 1,
    rules: parseJson(row.rules, null),
    proposal: str(row.proposal),
    decision: parseJson(row.decision, null),
    counts: parseJson<Record<string, number | null>>(row.counts, {}),
    notes: parseJson<string[]>(row.notes, []),
  }
  // Rows from before migration 0003 carry no entry_kind: derive the same key from the fields.
  rec.entryKind = typeof row.entry_kind === 'string' && row.entry_kind ? row.entry_kind : readingEntryKind(rec)
  return rec
}

// ── The store over any D1-shaped database ─────────────────────────────────────────────────
/** The only database surface the store needs. Adapters: scripts/ads-reads/d1Store.ts
 * wranglerAdsDb (the local CLIs), d1BindingAdsDb below (a Worker or Pages Function), and a
 * node:sqlite one in the tests (migrations 0001-0003 applied for real). */
export interface AdsDb {
  all(stmt: SqlStatement): Promise<Record<string, unknown>[]>
  /** changes: rows the statement changed, or null when the adapter cannot tell. */
  run(stmt: SqlStatement): Promise<{ changes: number | null }>
}

/** A Cloudflare D1 binding (D1Database satisfies this structurally). */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results?: unknown[] }>
      run(): Promise<{ meta?: { changes?: number } }>
    }
  }
}
export function d1BindingAdsDb(db: D1Like): AdsDb {
  return {
    async all(stmt) {
      const res = await db.prepare(stmt.sql).bind(...stmt.binds).all()
      return (res.results ?? []) as Record<string, unknown>[]
    },
    async run(stmt) {
      const res = await db.prepare(stmt.sql).bind(...stmt.binds).run()
      return { changes: typeof res.meta?.changes === 'number' ? res.meta.changes : null }
    },
  }
}

export interface AppendOutcome {
  /** false in --dry-run (nothing was sent). */
  written: boolean
  /** reading ids the database actually stored. */
  inserted: string[]
  /** reading ids the database ignored (same key already stored, e.g. a concurrent run). */
  ignored: string[]
}

/** What the shared sync (lib/adsSync.ts) needs — all a future Worker has to provide. */
export interface AdsSyncStore {
  readonly kind: string
  readonly dryRun: boolean
  syncCampaigns(campaigns: readonly CampaignFlight[], syncedAt: string): Promise<boolean>
  getDailyRows(campaignId: string): Promise<StoredDayRow[]>
  /** Upserts exactly these rows (the sync writes only rows that changed). */
  putDailyRows(campaignId: string, rows: readonly StoredDayRow[]): Promise<boolean>
  getPlacementRows(campaignId: string, since: string, until: string): Promise<PlacementDayRow[]>
  putPlacements(campaignId: string, rows: readonly PlacementDayRow[], fetchedAt: string): Promise<boolean>
  appendSyncRun(run: SyncRunRecord): Promise<boolean>
}
/** Everything the reads use on top of the sync. */
export interface AdsStore extends AdsSyncStore {
  getConsumedThresholds(campaignId: string): Promise<number[]>
  getReadings(campaignId: string, limit?: number): Promise<ReadingRecord[]>
  /** The readings already stored for one campaign and ET day (the de-dup check). */
  getReadingsOn(campaignId: string, etDate: string): Promise<ReadingRecord[]>
  /** Appends records; a COMPLETE threshold record also marks its thresholds fired. */
  appendReadings(records: readonly ReadingRecord[]): Promise<AppendOutcome>
}

/** The one SQL store, over any AdsDb. Every write passes assertAdsWriteSql; --dry-run sends
 * no write at all (reads still happen). */
export function createSqlAdsStore(db: AdsDb, opts: { dryRun: boolean; kind?: string }): AdsStore {
  const select = async (sql: string, binds: unknown[]) => {
    assertAdsReadSql(sql)
    return db.all({ sql, binds })
  }
  const exec = async (s: SqlStatement) => {
    assertAdsWriteSql(s.sql)
    return db.run(s)
  }
  async function writeAll(stmts: readonly (SqlStatement | null)[]): Promise<boolean> {
    if (opts.dryRun) return false
    for (const s of stmts) if (s) await exec(s)
    return true
  }
  const readings = async (sql: string, binds: unknown[]) => (await select(sql, binds)).map(mapReadingRow).filter((r): r is ReadingRecord => r !== null)
  return {
    kind: opts.kind ?? 'd1',
    dryRun: opts.dryRun,
    syncCampaigns: (campaigns, syncedAt) => writeAll(campaignSyncStatements(campaigns, syncedAt)),
    getDailyRows: async (campaignId) => (await select(DAILY_ROWS_SQL, [campaignId])).map(mapDailyRow),
    putDailyRows: (campaignId, rows) => writeAll(dailyRowUpserts(campaignId, rows)),
    getPlacementRows: async (campaignId, since, until) => (await select(PLACEMENT_ROWS_SQL, [campaignId, since, until])).map(mapPlacementRow),
    putPlacements: (campaignId, rows, fetchedAt) => writeAll(placementDailyUpserts(campaignId, rows, fetchedAt)),
    appendSyncRun: (run) => writeAll([syncRunInsert(run)]),
    async getConsumedThresholds(campaignId) {
      const rows = await select(THRESHOLD_STATE_SQL, [campaignId])
      return rows.map((r) => Number(r.threshold_usd)).filter((n) => Number.isFinite(n))
    },
    getReadings: (campaignId, limit = 200) => readings(READINGS_SQL, [campaignId, Math.max(1, Math.min(500, Math.floor(limit)))]),
    getReadingsOn: (campaignId, etDate) => readings(READINGS_ON_DAY_SQL, [campaignId, etDate]),
    async appendReadings(records) {
      const out: AppendOutcome = { written: !opts.dryRun, inserted: [], ignored: [] }
      if (opts.dryRun) return out
      for (const rec of records) {
        const withKey = { ...rec, entryKind: rec.entryKind ?? readingEntryKind(rec) }
        const res = await exec(readingInsert(withKey))
        if (res.changes === 0) {
          out.ignored.push(rec.id)
          continue
        }
        out.inserted.push(rec.id)
        const th = thresholdStateInsert(withKey)
        if (th) await exec(th)
      }
      return out
    },
  }
}

// ── GET /api/ads/readings — shape shared by the Function and AdsReadingsWidgetCard.vue ────
export interface AdsReadingsCampaign extends AdsFreshness {
  campaignId: string
  label: string
  status: string
  spend: ResolvedSpend
  thresholdsFired: { threshold: number; firedAt: string }[] | null
  /** Newest first. Anonymous aggregates only (counts, rule results, proposals). */
  readings: ReadingRecord[]
}
export interface AdsReadingsResponse {
  /** false when the gss_stats_ads binding is absent (e.g. plain `vite` dev). */
  storeBound: boolean
  /** false when bound but unreadable (e.g. local D1 without the migration applied). */
  storeReadable: boolean
  campaigns: AdsReadingsCampaign[]
  generatedAt: string
}

/** `?campaignId=a&campaignId=b` and/or `?campaignIds=a,b`; unknown ids are dropped; none (or
 * none known) means every campaign — the widget's "empty = all campaigns" rule. */
export function parseCampaignIdsParam(params: URLSearchParams, known: readonly string[]): string[] {
  const asked = [...params.getAll('campaignId'), ...params.getAll('campaignIds').flatMap((v) => v.split(','))].map((s) => s.trim()).filter(Boolean)
  const valid = [...new Set(asked)].filter((id) => known.includes(id))
  return valid.length ? valid : [...known]
}

// ── Dashboard readers (Pages Functions binding) — fail soft ───────────────────────────────
/** The only D1 surface these readers use (D1Database satisfies it; tests pass a stub). */
export interface D1Reader {
  prepare(sql: string): { bind(...values: unknown[]): { all(): Promise<{ results?: unknown[] }> } }
}

async function allRows(db: D1Reader, sql: string, binds: unknown[]): Promise<Record<string, unknown>[]> {
  const res = await db.prepare(sql).bind(...binds).all()
  return (res.results ?? []) as Record<string, unknown>[]
}

/** Every campaign's stored totals, keyed by id — null when the store is absent or unreadable. */
export async function readSpendSummaries(db: D1Reader | undefined | null): Promise<Map<string, SpendSummary> | null> {
  if (!db) return null
  try {
    const rows = await allRows(db, SPEND_SUMMARY_SQL, [])
    return new Map(rows.map((r) => mapSpendSummary(r)).map((s) => [s.campaignId, s]))
  } catch {
    return null
  }
}

export async function readReadings(db: D1Reader | undefined | null, campaignId: string, limit = 100): Promise<ReadingRecord[] | null> {
  if (!db) return null
  try {
    const rows = await allRows(db, READINGS_SQL, [campaignId, Math.max(1, Math.min(500, Math.floor(limit)))])
    return rows.map(mapReadingRow).filter((r): r is ReadingRecord => r !== null)
  } catch {
    return null
  }
}

export async function readThresholdState(db: D1Reader | undefined | null, campaignId: string): Promise<{ threshold: number; firedAt: string }[] | null> {
  if (!db) return null
  try {
    const rows = await allRows(db, THRESHOLD_STATE_SQL, [campaignId])
    return rows.map((r) => ({ threshold: num(r.threshold_usd), firedAt: String(r.fired_at ?? '') }))
  } catch {
    return null
  }
}

/** Finish time of the latest sync run of any source; null when none (or unreadable). */
export async function readLastSyncRun(db: D1Reader | undefined | null): Promise<string | null> {
  if (!db) return null
  try {
    const rows = await allRows(db, LAST_RUN_SQL, [])
    return str(rows[0]?.last)
  } catch {
    return null
  }
}

/** spendThrough / lastSync / stale for every configured campaign. Fail soft: an unreadable
 * store yields "nothing stored" (and stale only for a campaign that should have data by now);
 * a missing ads_sync_runs table (before migration 0003) yields lastSync null. */
export async function readFreshness(db: D1Reader | undefined | null, nowMs: number, campaigns: readonly CampaignFlight[] = CAMPAIGNS): Promise<Map<string, AdsFreshness>> {
  let coverage: Record<string, unknown>[] = []
  let syncs: Record<string, unknown>[] = []
  if (db) {
    try {
      coverage = await allRows(db, COVERAGE_ROWS_SQL, [])
    } catch {
      coverage = []
    }
    try {
      syncs = await allRows(db, LAST_SYNC_SQL, [])
    } catch {
      syncs = []
    }
  }
  const lastSync = new Map(syncs.map((r) => [String(r.campaign_id), str(r.last_sync)]))
  const out = new Map<string, AdsFreshness>()
  for (const c of campaigns) {
    const rows = coverage.filter((r) => String(r.campaign_id) === c.id).map((r) => ({ date: String(r.date), fetchedAt: str(r.fetched_at) }))
    out.set(c.id, freshnessOf(c, spendThroughFromRows(c.flightStart, rows), lastSync.get(c.id) ?? null, nowMs))
  }
  return out
}
