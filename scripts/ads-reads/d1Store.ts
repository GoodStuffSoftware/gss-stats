// The routine's side of the ads-read store: gss-stats' own D1 database `gss-stats-ads`
// (docs/adr/0001-ads-read-store.md), through `wrangler d1 execute gss-stats-ads --remote`.
// The store itself is lib/adsStore.ts createSqlAdsStore (shared with the gss-stats-sync
// Worker, which runs it on its D1 binding); this file is only the wrangler-CLI adapter plus the
// in-memory twin used by tests and --fixture runs.
//
// Guards, enforced before wrangler is spawned:
//  - the target is always gss-stats-ads, never the beacon's gss-geo (an allowlist);
//  - writes are single INSERT statements into ads_* tables (lib/adsStore.ts assertAdsWriteSql,
//    checked again here after the binds are inlined);
//  - reads are single SELECTs (d1.ts assertReadOnlySql).
// --dry-run: reads happen, every write is skipped and reported as not written.

import { appendReading, consumedThresholds, readingEntryKind, type ReadingRecord, type ReadingsLog, type StoredSpend } from '../../src/lib/adsRules'
import type { CampaignFlight } from '../../src/lib/campaigns'
import {
  ADS_DB_NAME,
  assertAdsWriteSql,
  createSqlAdsStore,
  mergePlacementDayRows,
  type AdsDb,
  type AdsStore,
  type AppendOutcome,
  type PlacementDayRow,
  type StoredDayRow,
  type SyncRunRecord,
} from '../../src/lib/adsStore'
import { BEACON_DB, createD1Select, inlineBinds, parseD1Response } from './d1'
import { redactedFirstLine } from '../../src/lib/adsRedact'
import { unfinishedSyncAlert, UNFINISHED_SYNC_AFTER_MS, UNFINISHED_SYNC_LOOKBACK_MS } from '../../src/lib/adsFreshness'
import type { WranglerRunner } from './wrangler'

export { assertAdsWriteSql }
export type { AdsStore }

/** `wrangler d1 execute <db> --remote --json --command "<one statement>"`, binds inlined. */
export function wranglerAdsDb(run: WranglerRunner, database: string = ADS_DB_NAME): AdsDb {
  if (database !== ADS_DB_NAME) {
    throw new Error(database === BEACON_DB ? 'the ads store must never target the beacon database (gss-geo)' : `the ads store only targets ${ADS_DB_NAME}, not ${database}`)
  }
  const select = createD1Select(run, database)
  return {
    all: (stmt) => select<Record<string, unknown>>(stmt.sql, stmt.binds),
    async run(stmt) {
      const final = inlineBinds(stmt.sql, stmt.binds)
      assertAdsWriteSql(final)
      const res = await run(['d1', 'execute', database, '--remote', '--json', '--command', final])
      if (res.code !== 0) throw new Error(`wrangler d1 execute ${database} failed (exit ${res.code}): ${redactedFirstLine(res.stderr || res.stdout)}`)
      return { changes: parseD1Response(res.stdout).changes } // throws when D1 reports failure
    },
  }
}

export function createD1Store(opts: { run: WranglerRunner; dryRun: boolean; database?: string }): AdsStore {
  // Allowlist, not a denylist (review L3): the writer can only ever target gss-stats-ads.
  return createSqlAdsStore(wranglerAdsDb(opts.run, opts.database ?? ADS_DB_NAME), { dryRun: opts.dryRun, kind: 'd1' })
}


/** In-memory store with the same semantics (append-only readings de-duped per campaign, ET day
 * and entry kind; fire-once thresholds; upserted metrics) for tests and --fixture runs.
 * `written` records what a real run would have written. */
export function createMemoryStore(
  seed: { spend?: StoredSpend | null; readings?: ReadingRecord[]; consumed?: number[]; dailyRows?: Record<string, StoredDayRow[]> } = {},
  dryRun = false,
): AdsStore & {
  written: { campaigns: number; metricsDays: string[]; placements: number; readings: ReadingRecord[]; syncRuns: SyncRunRecord[] }
  log(): ReadingsLog | null
  dailyRows(campaignId: string): StoredDayRow[]
} {
  const days = new Map<string, Map<string, StoredDayRow>>()
  const rowsOf = (id: string) => {
    if (!days.has(id)) days.set(id, new Map())
    return days.get(id)!
  }
  if (seed.spend) {
    const m = rowsOf(seed.spend.campaignId)
    for (const [date, d] of Object.entries(seed.spend.days)) m.set(date, { date, ...d, fetchedAt: seed.spend.fetchedAt, placementsFetchedAt: null })
  }
  for (const [id, rows] of Object.entries(seed.dailyRows ?? {})) for (const r of rows) rowsOf(id).set(r.date, { ...r })
  const placements = new Map<string, Map<string, PlacementDayRow>>()
  let log: ReadingsLog | null = seed.readings?.length ? { v: 1, campaignId: seed.readings[0].campaignId, readings: seed.readings.map((r) => ({ ...r, entryKind: r.entryKind ?? readingEntryKind(r) })) } : null
  const consumed = new Set<number>(seed.consumed ?? consumedThresholds(seed.readings ?? []))
  const written = { campaigns: 0, metricsDays: [] as string[], placements: 0, readings: [] as ReadingRecord[], syncRuns: [] as SyncRunRecord[] }
  const claims: { source: string; atMs: number }[] = []
  return {
    kind: 'memory',
    dryRun,
    written,
    log: () => log,
    dailyRows: (id) => [...rowsOf(id).values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    async syncCampaigns(c: readonly CampaignFlight[]) {
      if (dryRun) return false
      written.campaigns += c.length
      return true
    },
    async getAllDailyRows() {
      return new Map([...days.entries()].map(([id, m]) => [id, [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((r) => ({ ...r }))]))
    },
    async getLastPulls() {
      const out = new Map<string, string>()
      for (const r of [...written.syncRuns].sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1))) for (const id of r.campaignsPulled ?? []) if (!out.has(id)) out.set(id, r.finishedAt)
      return out
    },
    async claimSync(source, nowMs, windowMs) {
      if (dryRun) return true
      const lastFinished = Math.max(...written.syncRuns.map((r) => Date.parse(r.finishedAt)), ...claims.map((c) => c.atMs), -Infinity)
      if (lastFinished > nowMs - windowMs) return false
      claims.push({ source, atMs: nowMs })
      return true
    },
    async ensureThresholdState(records) {
      if (dryRun) return false
      for (const r of records) if (r.kind === 'threshold' && r.complete) for (const t of r.thresholds) consumed.add(t)
      return true
    },
    async putDailyRows(id, rows) {
      if (dryRun) return false
      for (const r of rows) rowsOf(id).set(r.date, { ...r })
      written.metricsDays.push(...rows.map((r) => r.date))
      return true
    },
    async getPlacementRows(id, since, until) {
      return [...(placements.get(id)?.values() ?? [])].filter((r) => r.date >= since && r.date <= until).map((r) => ({ ...r }))
    },
    async putPlacements(id, rows) {
      if (dryRun) return false
      if (!placements.has(id)) placements.set(id, new Map())
      const m = placements.get(id)!
      const merged = mergePlacementDayRows(rows)
      for (const r of merged) m.set(`${r.date}\u0000${r.placement}`, { ...r })
      written.placements += merged.length
      return true
    },
    async appendSyncRun(run) {
      if (dryRun) return false
      if (!written.syncRuns.some((r) => r.runKey === run.runKey)) written.syncRuns.push(run)
      return true
    },
    async getConsumedThresholds() {
      return [...new Set([...consumed, ...consumedThresholds(log?.readings ?? [])])].sort((a, b) => a - b)
    },
    async getThresholdLedger() {
      return { state: [...consumed].sort((a, b) => a - b), fromReadings: consumedThresholds(log?.readings ?? []) }
    },
    async getReadings(_id, limit = 200) {
      return [...(log?.readings ?? [])].reverse().slice(0, limit)
    },
    async getSyncAlerts(nowMs) {
      return claims
        .filter((c) => c.atMs <= nowMs - UNFINISHED_SYNC_AFTER_MS && c.atMs >= nowMs - UNFINISHED_SYNC_LOOKBACK_MS)
        .filter((c) => !written.syncRuns.some((r) => r.source === c.source && Date.parse(r.startedAt) === c.atMs))
        .sort((a, b) => b.atMs - a.atMs)
        .slice(0, 5)
        .map((c) => unfinishedSyncAlert(c.source, new Date(c.atMs).toISOString()))
    },
    async getReadingsOn(id, etDate) {
      return (log?.readings ?? []).filter((r) => r.campaignId === id && r.etDate === etDate)
    },
    async appendReadings(records): Promise<AppendOutcome> {
      const out: AppendOutcome = { written: !dryRun, inserted: [], ignored: [] }
      if (dryRun) return out
      for (const r of records) {
        const before = log?.readings.length ?? 0
        log = appendReading(log, r)
        if ((log?.readings.length ?? 0) === before) out.ignored.push(r.id)
        else {
          out.inserted.push(r.id)
          written.readings.push({ ...r, entryKind: r.entryKind ?? readingEntryKind(r) })
        }
        if (r.kind === 'threshold' && r.complete) for (const t of r.thresholds) consumed.add(t) // idempotent, like the SQL store
      }
      return out
    },
  }
}
