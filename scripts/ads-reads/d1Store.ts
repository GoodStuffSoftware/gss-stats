// The routine's side of the ads-read store: gss-stats' own D1 database `gss-stats-ads`
// (docs/adr/0001-ads-read-store.md), through `wrangler d1 execute gss-stats-ads --remote`.
// Every statement comes from src/lib/adsStore.ts (shared with the dashboard).
//
// Guards, enforced before wrangler is spawned:
//  - the target is always gss-stats-ads, never the beacon's gss-geo;
//  - writes are single INSERT statements into ads_* tables (upserts use ON CONFLICT ... DO
//    UPDATE / DO NOTHING); no DELETE, DROP, ALTER, bare UPDATE, PRAGMA or comment;
//  - reads are single SELECTs (d1.ts assertReadOnlySql).
// --dry-run: reads happen, every write is skipped and reported as not written.

import { appendReading, consumedThresholds, type ReadingRecord, type ReadingsLog, type SpendDay, type StoredSpend } from '../../src/lib/adsRules'
import type { CampaignFlight } from '../../src/lib/campaigns'
import {
  ADS_DB_NAME,
  campaignSyncStatement,
  DAILY_ROWS_SQL,
  dailyMetricsUpserts,
  mapReadingRow,
  placementDailyUpserts,
  READINGS_SQL,
  readingInsert,
  rowsToStoredSpend,
  THRESHOLD_STATE_SQL,
  thresholdStateInsert,
  type PlacementDayRow,
  type SqlStatement,
} from '../../src/lib/adsStore'
import { BEACON_DB, createD1Select, inlineBinds, parseD1Json, stripSqlLiterals } from './d1'
import { redactedFirstLine } from './redact'
import type { WranglerRunner } from './wrangler'

export interface AdsStore {
  readonly kind: 'd1' | 'memory'
  syncCampaigns(campaigns: readonly CampaignFlight[], syncedAt: string): Promise<boolean>
  getSpend(campaignId: string): Promise<StoredSpend | null>
  /** Upserts the given days only (never re-stamps days that were not re-read). */
  putDailyMetrics(campaignId: string, days: Record<string, SpendDay>, fetchedAt: string): Promise<boolean>
  putPlacements(campaignId: string, rows: readonly PlacementDayRow[], fetchedAt: string): Promise<boolean>
  getConsumedThresholds(campaignId: string): Promise<number[]>
  getReadings(campaignId: string, limit?: number): Promise<ReadingRecord[]>
  /** Appends records; a COMPLETE threshold record also marks its thresholds fired. */
  appendReadings(records: readonly ReadingRecord[]): Promise<boolean>
}

const FORBIDDEN_IN_WRITES = /\b(DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|TRUNCATE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|REPLACE)\b/i

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

export function createD1Store(opts: { run: WranglerRunner; dryRun: boolean; database?: string }): AdsStore {
  const database = opts.database ?? ADS_DB_NAME
  // Allowlist, not a denylist (review L3): the writer can only ever target gss-stats-ads.
  if (database !== ADS_DB_NAME) {
    throw new Error(database === BEACON_DB ? 'the ads store must never target the beacon database (gss-geo)' : `the ads store only targets ${ADS_DB_NAME}, not ${database}`)
  }
  const select = createD1Select(opts.run, database)

  async function write(stmt: SqlStatement): Promise<void> {
    const final = inlineBinds(stmt.sql, stmt.binds)
    assertAdsWriteSql(final)
    const res = await opts.run(['d1', 'execute', database, '--remote', '--json', '--command', final])
    if (res.code !== 0) throw new Error(`wrangler d1 execute ${database} failed (exit ${res.code}): ${redactedFirstLine(res.stderr || res.stdout)}`)
    parseD1Json(res.stdout) // throws when D1 reports the statement as unsuccessful
  }
  async function writeAll(stmts: readonly (SqlStatement | null)[]): Promise<boolean> {
    if (opts.dryRun) return false
    for (const s of stmts) if (s) await write(s)
    return true
  }

  return {
    kind: 'd1',
    syncCampaigns: (campaigns, syncedAt) => writeAll([campaignSyncStatement(campaigns, syncedAt)]),
    async getSpend(campaignId) {
      return rowsToStoredSpend(campaignId, await select<Record<string, unknown>>(DAILY_ROWS_SQL, [campaignId]))
    },
    putDailyMetrics: (campaignId, days, fetchedAt) => writeAll(dailyMetricsUpserts(campaignId, days, fetchedAt)),
    putPlacements: (campaignId, rows, fetchedAt) => writeAll(placementDailyUpserts(campaignId, rows, fetchedAt)),
    async getConsumedThresholds(campaignId) {
      const rows = await select<Record<string, unknown>>(THRESHOLD_STATE_SQL, [campaignId])
      return rows.map((r) => Number(r.threshold_usd)).filter((n) => Number.isFinite(n))
    },
    async getReadings(campaignId, limit = 200) {
      const rows = await select<Record<string, unknown>>(READINGS_SQL, [campaignId, limit])
      return rows.map(mapReadingRow).filter((r): r is ReadingRecord => r !== null)
    },
    appendReadings: (records) => writeAll(records.flatMap((r) => [readingInsert(r), thresholdStateInsert(r)])),
  }
}

/** In-memory store with the same semantics (append-only readings, fire-once thresholds) for
 * tests and --fixture runs. `written` records what a real run would have written. */
export function createMemoryStore(
  seed: { spend?: StoredSpend | null; readings?: ReadingRecord[]; consumed?: number[] } = {},
  dryRun = false,
): AdsStore & { written: { campaigns: number; metricsDays: string[]; placements: number; readings: ReadingRecord[] }; log(): ReadingsLog | null } {
  let spend = seed.spend ?? null
  let log: ReadingsLog | null = seed.readings?.length ? { v: 1, campaignId: seed.readings[0].campaignId, readings: [...seed.readings] } : null
  const consumed = new Set<number>(seed.consumed ?? consumedThresholds(seed.readings ?? []))
  const written = { campaigns: 0, metricsDays: [] as string[], placements: 0, readings: [] as ReadingRecord[] }
  return {
    kind: 'memory',
    written,
    log: () => log,
    async syncCampaigns(c) {
      if (dryRun) return false
      written.campaigns += c.length
      return true
    },
    async getSpend() {
      return spend
    },
    async putDailyMetrics(campaignId, days, fetchedAt) {
      if (dryRun) return false
      spend = { v: 1, campaignId, source: 'google-ads-api', apiVersion: '', customerId: '', fetchedAt, closedThroughEt: spend?.closedThroughEt ?? null, days: { ...(spend?.days ?? {}), ...days } }
      written.metricsDays.push(...Object.keys(days))
      return true
    },
    async putPlacements(_id, rows) {
      if (dryRun) return false
      written.placements += rows.length
      return true
    },
    async getConsumedThresholds() {
      return [...consumed].sort((a, b) => a - b)
    },
    async getReadings() {
      return [...(log?.readings ?? [])].reverse()
    },
    async appendReadings(records) {
      if (dryRun) return false
      for (const r of records) {
        log = appendReading(log, r)
        written.readings.push(r)
        if (r.kind === 'threshold' && r.complete) for (const t of r.thresholds) consumed.add(t)
      }
      return true
    },
  }
}
