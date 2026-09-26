// The shared sync (src/lib/adsSync.ts syncAdsData) against a REAL SQLite with every migration
// applied: gap fill (missing middle days), restatements and their recheck cadence, the no-op
// rerun, the empty/partial-response guard, the per-run caps, placement coverage, closed-campaign
// windows, --dry-run, today's partial numbers; plus the readings de-dup and threshold state the
// UNIQUE index and triggers enforce, and migration 0004.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SpendDay, ReadingRecord } from '../../src/lib/adsRules'
import { createSqlAdsStore, readFreshness, readSyncAlerts, type PlacementDayRow, type SqlStatement } from '../../src/lib/adsStore'
import { capPlan, planCampaignSync, syncAdsData, syncWindow, type AdsMetricsSource } from '../../src/lib/adsSync'
import { campaignById } from '../../src/lib/campaigns'
import { count, MIGRATIONS_DIR, migrationFiles, openMigratedSqlite, sqliteAdsDb, sqliteD1 } from './sqliteDb'

const RETEST = '24279250691'
const CLOSED = '24234347705' // flight 2026-09-09..2026-09-13, status closed
const at = (iso: string) => Date.parse(iso)
// 09:00 ET (EDT = UTC-4) on the given ET date.
const nineEt = (d: string) => at(`${d}T13:00:00Z`)
const HOUR = 3_600_000
const day = (usd: number, impressions = 1000, clicks = 10): SpendDay => ({ costMicros: Math.round(usd * 1e6), impressions, clicks })

function fakeAds(daily: Record<string, Record<string, SpendDay>>, placements: Record<string, PlacementDayRow[]> = {}) {
  const calls: { kind: 'daily' | 'placements' | 'total'; id: string; since: string; until: string }[] = []
  // total: Google's range total, by default the sum of the daily map (null when it has no row);
  // a test overrides it to model a daily response that does not add up.
  const state = { failPlacements: false, failDaily: false, emptyDaily: false, total: null as null | ((id: string, since: string, until: string) => SpendDay | null) }
  const sumOf = (id: string, since: string, until: string) => {
    const days = Object.entries(daily[id] ?? {}).filter(([d]) => d >= since && d <= until).map(([, v]) => v)
    return days.length ? days.reduce((a, v) => ({ costMicros: a.costMicros + v.costMicros, impressions: a.impressions + v.impressions, clicks: a.clicks + v.clicks }), { costMicros: 0, impressions: 0, clicks: 0 }) : null
  }
  const src: AdsMetricsSource = {
    async rangeTotal(id, since, until) {
      calls.push({ kind: 'total', id, since, until })
      return state.total ? state.total(id, since, until) : sumOf(id, since, until)
    },
    async daily(id, since, until) {
      calls.push({ kind: 'daily', id, since, until })
      if (state.failDaily) throw new Error('Google Ads search failed, HTTP 500: backend error')
      if (state.emptyDaily) return {} // an empty 200
      return Object.fromEntries(Object.entries(daily[id] ?? {}).filter(([d]) => d >= since && d <= until))
    },
    async placements(id, since, until) {
      calls.push({ kind: 'placements', id, since, until })
      if (state.failPlacements) throw new Error('Google Ads search failed, HTTP 503: unavailable')
      return (placements[id] ?? []).filter((p) => p.date >= since && p.date <= until).map((p) => ({ ...p }))
    },
  }
  return { src, calls, state, daily, placements }
}
const sumTruth = (truth: Record<string, SpendDay>, since: string, until: string): SpendDay | null => {
  const days = Object.entries(truth).filter(([d]) => d >= since && d <= until).map(([, v]) => v)
  return days.length ? days.reduce((a, v) => ({ costMicros: a.costMicros + v.costMicros, impressions: a.impressions + v.impressions, clicks: a.clicks + v.clicks }), { costMicros: 0, impressions: 0, clicks: 0 }) : null
}
const pl = (date: string, placement: string, usd: number, approved: boolean | null = true): PlacementDayRow => ({
  date,
  placement,
  displayName: placement,
  type: 'MOBILE_APPLICATION',
  targetUrl: null,
  approved,
  costMicros: Math.round(usd * 1e6),
  impressions: 100,
  clicks: 1,
})

function setup(opts: { maxStatements?: number } = {}) {
  const sqlite = openMigratedSqlite()
  const adapter = sqliteAdsDb(sqlite)
  const store = createSqlAdsStore(adapter, { dryRun: false, kind: 'sqlite', maxStatements: opts.maxStatements })
  return { sqlite, adapter, store }
}
const metricWrites = (w: { sql: string; changes: number }[]) => w.filter((x) => /^INSERT INTO ads_(daily_metrics|placement_daily)/.test(x.sql))
const costOf = (sqlite: ReturnType<typeof openMigratedSqlite>, id: string, date: string) =>
  (sqlite.prepare('SELECT cost_micros FROM ads_daily_metrics WHERE campaign_id = ? AND date = ?').get(id, date) as { cost_micros: number } | undefined)?.cost_micros

describe('migrations 0001-0004 in local SQLite', () => {
  it('apply in order and create the sync-run table, the de-dup index and the no-REPLACE triggers', () => {
    expect(migrationFiles()).toEqual(['0001_init.sql', '0002_no_replace.sql', '0003_sync_and_dedup.sql', '0004_sync_claims.sql'])
    const db = openMigratedSqlite()
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')").all() as { name: string }[]).map((r) => r.name)
    for (const n of [
      'ads_sync_runs',
      'ads_sync_runs_by_finish',
      'ads_readings_one_per_entry',
      'ads_readings_no_replace',
      'ads_readings_no_replace_entry',
      'ads_threshold_state_no_replace',
      'ads_sync_runs_no_replace',
      'ads_sync_runs_append_only_update',
      'ads_sync_runs_append_only_delete',
    ])
      expect(names).toContain(n)
    expect(names).not.toContain('ads_sync_runs_0004')
  })
  it('0004 rebuilds ads_sync_runs with every row, id and value intact, and touches no other table', () => {
    const db = openMigratedSqlite('0003_sync_and_dedup.sql')
    const insert = db.prepare(
      'INSERT INTO ads_sync_runs (run_key, source, started_at, finished_at, campaigns, campaigns_ok, days_fetched, days_changed, placement_rows_fetched, placement_rows_changed, status, error, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    insert.run('sync:ads-sync:a', 'ads-sync', '2026-09-26T17:56:10.881Z', '2026-09-26T17:56:21.518Z', '["1","2"]', '["1","2"]', 19, 19, 185, 0, 'ok', null, '{"1":{"fetched":null}}')
    insert.run('sync:ads-sync:b', 'ads-sync', '2026-09-26T17:56:38.072Z', '2026-09-26T17:56:42.579Z', '["1","2"]', '["1","2"]', 0, 0, 0, 0, 'ok', null, '{}')
    insert.run('sync:worker-on-demand:c', 'worker-on-demand', '2026-09-26T18:19:42.772Z', '2026-09-26T18:19:44.293Z', '["1"]', '[]', 3, 0, 5, 0, 'failed', "it's an error", '{}')
    const cols = 'id, run_key, source, started_at, finished_at, campaigns, campaigns_ok, days_fetched, days_changed, placement_rows_fetched, placement_rows_changed, status, error, detail'
    const before = db.prepare(`SELECT ${cols} FROM ads_sync_runs ORDER BY id`).all()
    const others = () => ['ads_campaigns', 'ads_daily_metrics', 'ads_placement_daily', 'ads_readings', 'ads_threshold_state'].map((t) => db.prepare(`SELECT * FROM ${t}`).all())
    const othersBefore = others()
    const schemaBefore = db.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name <> 'ads_sync_runs' ORDER BY name").all()
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, '0004_sync_claims.sql'), 'utf8'))
    expect(db.prepare(`SELECT ${cols} FROM ads_sync_runs ORDER BY id`).all()).toEqual(before)
    expect((db.prepare('SELECT campaigns_pulled AS p FROM ads_sync_runs ORDER BY id').all() as { p: string }[]).map((r) => r.p)).toEqual(['["1","2"]', '[]', '[]'])
    expect(others()).toEqual(othersBefore)
    expect(db.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name <> 'ads_sync_runs' ORDER BY name").all()).toEqual(schemaBefore)
    // the new table keeps the append-only guarantees
    expect(() => db.exec("UPDATE ads_sync_runs SET status = 'ok'")).toThrow(/append-only/)
    expect(() => db.exec('DELETE FROM ads_sync_runs')).toThrow(/append-only/)
    // and AUTOINCREMENT continues after the copied ids
    insert.run('sync:ads-sync:d', 'ads-sync', '2026-09-26T19:00:00.000Z', '2026-09-26T19:00:01.000Z', '[]', '[]', 0, 0, 0, 0, 'ok', null, '{}')
    expect((db.prepare("SELECT id FROM ads_sync_runs WHERE run_key = 'sync:ads-sync:d'").get() as { id: number }).id).toBe(4)
  })
  it('the v0.4/v0.5 writers keep working: inserts without entry_kind or campaigns_pulled still land', async () => {
    const { sqlite, store } = setup()
    await store.syncCampaigns([campaignById(RETEST)!], '2026-09-26T00:00:00Z')
    const legacy = (key: string) =>
      sqlite
        .prepare(
          "INSERT INTO ads_readings (reading_key, campaign_id, kind, stage, read_at, et_date, spend_through_et, cumulative_spend_micros, thresholds, complete, rules, proposal, decision, counts, notes, routine_version) VALUES (?, ?, 'health', NULL, ?, '2026-09-26', NULL, NULL, '[]', 1, NULL, NULL, NULL, '{}', '[]', 'ads-reads/1.0.0') ON CONFLICT (reading_key) DO NOTHING",
        )
        .run(key, RETEST, '2026-09-27T03:15:00Z')
    legacy('health:a')
    legacy('health:b')
    expect(count(sqlite, 'ads_readings')).toBe(2)
    sqlite
      .prepare("INSERT INTO ads_daily_metrics (campaign_id, date, cost_micros, impressions, clicks, source, fetched_at) VALUES (?, '2026-09-26', 1, 1, 0, 'google-ads-api', 'x') ON CONFLICT (campaign_id, date) DO UPDATE SET cost_micros = excluded.cost_micros")
      .run(RETEST)
    expect(count(sqlite, 'ads_daily_metrics', 'placements_fetched_at IS NULL')).toBe(1)
  })
})

describe('syncAdsData: gap fill, restatements, the no-op rerun', () => {
  it('a first sync pulls every closed flight day, zero-fills never-stored days, and records the run', async () => {
    const { sqlite, store } = setup()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4.2), '2026-09-27': day(13.1), '2026-09-29': day(12.9), '2026-09-30': day(3) } })
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-30'), dryRun: false, source: 'ads-sync' })
    expect(r.status).toBe('ok')
    // newest first (review L2): the recent window whole, then the older gap
    expect(ads.calls.filter((c) => c.kind === 'daily')).toEqual([
      { kind: 'daily', id: RETEST, since: '2026-09-27', until: '2026-09-29' },
      { kind: 'daily', id: RETEST, since: '2026-09-26', until: '2026-09-26' },
    ])
    // 09-28 came back empty: zero-filled only after Google's range total agreed (review L1)
    expect(ads.calls.filter((c) => c.kind === 'total')).toEqual([{ kind: 'total', id: RETEST, since: '2026-09-27', until: '2026-09-29' }])
    const rows = sqlite.prepare('SELECT date, cost_micros FROM ads_daily_metrics WHERE campaign_id = ? ORDER BY date').all(RETEST) as { date: string; cost_micros: number }[]
    expect(rows.map((x) => [x.date, x.cost_micros])).toEqual([
      ['2026-09-26', 4_200_000],
      ['2026-09-27', 13_100_000],
      ['2026-09-28', 0], // never stored, no API row = no delivery: stored as zero
      ['2026-09-29', 12_900_000],
    ]) // and never today's open day
    expect(r.campaigns[0]).toMatchObject({ spendThrough: '2026-09-29', daysFetched: 4, daysChanged: 4, pulled: true })
    const run = sqlite.prepare('SELECT source, status, campaigns, campaigns_ok, campaigns_pulled, days_fetched, days_changed FROM ads_sync_runs').get() as Record<string, unknown>
    expect(run).toMatchObject({ source: 'ads-sync', status: 'ok', campaigns: `["${RETEST}"]`, campaigns_ok: `["${RETEST}"]`, campaigns_pulled: `["${RETEST}"]`, days_fetched: 4, days_changed: 4 })
  })

  it('a second run right after is a true no-op: no Google call, no write at all, not even a run row', async () => {
    const { sqlite, adapter, store } = setup()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4.2), '2026-09-27': day(13.1), '2026-09-29': day(12.9) } }, { [RETEST]: [pl('2026-09-27', 'mobileapp::2-com.easybrain.sudoku.android', 13.1)] })
    await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-30'), dryRun: false, source: 'morning-read' })
    const snapshot = () => ({
      daily: sqlite.prepare('SELECT * FROM ads_daily_metrics ORDER BY campaign_id, date').all(),
      placements: sqlite.prepare('SELECT * FROM ads_placement_daily ORDER BY campaign_id, date, placement').all(),
      campaigns: sqlite.prepare('SELECT * FROM ads_campaigns ORDER BY id').all(),
      runs: sqlite.prepare('SELECT * FROM ads_sync_runs ORDER BY id').all(),
    })
    const before = snapshot()
    adapter.writes.length = 0
    ads.calls.length = 0
    let built = 0
    const again = await syncAdsData(
      { adsFactory: async () => (built++, ads.src), store },
      { campaignIds: [RETEST], now: nineEt('2026-09-30') + 60_000, dryRun: false, source: 'worker-cron' },
    )
    expect(again).toMatchObject({ nothingDue: true, status: 'ok', runRecorded: false, daysChanged: 0 })
    expect(built).toBe(0) // the Ads client (secrets + token refresh) is never built
    expect(ads.calls).toEqual([])
    expect(adapter.writes).toEqual([])
    expect(snapshot()).toEqual(before)
  })

  it('the restatement window is re-checked once the last pull is older than the recheck interval, and a re-check that finds nothing writes no metric row', async () => {
    const { adapter, store } = setup()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4.2), '2026-09-27': day(13.1), '2026-09-29': day(12.9) } })
    const t0 = nineEt('2026-09-30')
    await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: t0, dryRun: false, source: 'ads-sync' })
    adapter.writes.length = 0
    const later = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: t0 + 6 * HOUR + 60_000, dryRun: false, source: 'worker-cron' })
    expect(later.campaigns[0].fetched).toEqual({ since: '2026-09-27', until: '2026-09-29' })
    expect(later).toMatchObject({ daysChanged: 0, placementRowsChanged: 0, runRecorded: true })
    expect(metricWrites(adapter.writes)).toEqual([])
  })

  it('missing middle days are fetched (from the first gap), while unchanged stored days are not rewritten', async () => {
    const { sqlite, adapter, store } = setup()
    await store.syncCampaigns([campaignById(RETEST)!], '2026-09-30T00:00:00Z')
    const closedAt = '2026-09-30T13:00:00.000Z'
    await store.putDailyRows(RETEST, [
      { date: '2026-09-26', ...day(4.2), fetchedAt: closedAt, placementsFetchedAt: closedAt },
      { date: '2026-09-27', ...day(13.1), fetchedAt: closedAt, placementsFetchedAt: closedAt },
      // 2026-09-28 missing (a sync that never ran)
      { date: '2026-09-29', ...day(12.9), fetchedAt: closedAt, placementsFetchedAt: closedAt },
    ])
    adapter.writes.length = 0
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4.2), '2026-09-27': day(13.1), '2026-09-28': day(11), '2026-09-29': day(12.9), '2026-09-30': day(13), '2026-10-01': day(12.5), '2026-10-02': day(9) } })
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-10-03'), dryRun: false, source: 'morning-read' })
    expect(r.campaigns[0].fetched).toEqual({ since: '2026-09-28', until: '2026-10-02' })
    expect(r.campaigns[0].changedDates).toEqual(['2026-09-28', '2026-09-30', '2026-10-01', '2026-10-02']) // 09-29 unchanged, not rewritten
    expect(r.campaigns[0].spendThrough).toBe('2026-10-02')
    expect(count(sqlite, 'ads_daily_metrics', 'campaign_id = ?', RETEST)).toBe(7)
    const fetchedAt29 = (sqlite.prepare("SELECT fetched_at FROM ads_daily_metrics WHERE date = '2026-09-29'").get() as { fetched_at: string }).fetched_at
    expect(fetchedAt29).toBe(closedAt)
  })

  it('a restated recent day is overwritten in place (one row) and reported', async () => {
    const { sqlite, store } = setup()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4.2), '2026-09-27': day(13.1), '2026-09-28': day(11), '2026-09-29': day(12.9) } })
    await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-30'), dryRun: false, source: 'ads-sync' })
    ads.daily[RETEST]['2026-09-28'] = day(10.55) // Google credits invalid clicks
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-30') + HOUR, dryRun: false, source: 'worker-cron', restatementRecheckMs: 0 })
    expect(r.campaigns[0].changedDates).toEqual(['2026-09-28'])
    expect(r.campaigns[0].restated).toEqual([{ date: '2026-09-28', before: 11, after: 10.55 }])
    expect(count(sqlite, 'ads_daily_metrics', "campaign_id = ? AND date = '2026-09-28'", RETEST)).toBe(1)
    expect(costOf(sqlite, RETEST, '2026-09-28')).toBe(10_550_000)
  })

  it('a day stored while it was still open (the v0.4.0 routine did that) is re-pulled once, then left alone', async () => {
    const { store } = setup()
    await store.syncCampaigns([campaignById(RETEST)!], 'x')
    await store.putDailyRows(RETEST, [{ date: '2026-09-29', ...day(5), fetchedAt: '2026-09-29T20:00:00.000Z', placementsFetchedAt: null }])
    const plan = planCampaignSync(campaignById(RETEST)!, (await store.getAllDailyRows()).get(RETEST)!, '2026-09-30')
    expect(plan.missingDays).toContain('2026-09-29')
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4.2), '2026-09-29': day(12.9) } })
    const first = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-30'), dryRun: false, source: 'ads-sync' })
    expect(first.campaigns[0].changedDates).toContain('2026-09-29')
    const second = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-30') + 60_000, dryRun: false, source: 'ads-sync' })
    expect(second).toMatchObject({ nothingDue: true, daysChanged: 0 })
  })

  it('a failed placement pull leaves those days uncovered, so the next run pulls them again', async () => {
    const { sqlite, store } = setup()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4.2), '2026-09-27': day(13.1) } }, { [RETEST]: [pl('2026-09-26', 'mobileapp::2-a', 4.2), pl('2026-09-27', 'mobileapp::2-a', 13.1)] })
    ads.state.failPlacements = true
    const first = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-28'), dryRun: false, source: 'ads-sync' })
    expect(first.status).toBe('partial')
    expect(first.error).toMatch(/HTTP 503/)
    expect(first.campaigns[0].pulled).toBe(false)
    expect(count(sqlite, 'ads_daily_metrics', 'placements_fetched_at IS NULL')).toBe(2)
    ads.state.failPlacements = false
    const second = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-28') + 60_000, dryRun: false, source: 'ads-sync' })
    expect(second.status).toBe('ok')
    expect(second.campaigns[0].placementRowsChanged).toBe(2)
    expect(count(sqlite, 'ads_daily_metrics', 'placements_fetched_at IS NULL')).toBe(0)
    const third = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-28') + 120_000, dryRun: false, source: 'ads-sync' })
    expect(third).toMatchObject({ nothingDue: true, daysChanged: 0, placementRowsChanged: 0 })
  })

  it('a closed campaign is zero-filled only through its flight end; spend-through stops there; later runs cost no API call', async () => {
    const { sqlite, store } = setup()
    expect(syncWindow(campaignById(CLOSED)!, '2026-09-30')).toEqual({ since: '2026-09-09', until: '2026-09-16' })
    const ads = fakeAds({ [CLOSED]: { '2026-09-09': day(21.56), '2026-09-10': day(13.52), '2026-09-12': day(14.07), '2026-09-13': day(13.36), '2026-09-15': day(0.4) } })
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [CLOSED], now: nineEt('2026-09-30'), dryRun: false, source: 'backfill' })
    const dates = (sqlite.prepare('SELECT date, cost_micros FROM ads_daily_metrics WHERE campaign_id = ? ORDER BY date').all(CLOSED) as { date: string; cost_micros: number }[]).map((x) => [x.date, x.cost_micros])
    // 09-11 zero-filled (inside the flight); 09-14 and 09-16 NOT zero-filled (after the flight);
    // 09-15's stray spend stored because the API returned it.
    expect(dates).toEqual([
      ['2026-09-09', 21_560_000],
      ['2026-09-10', 13_520_000],
      ['2026-09-11', 0],
      ['2026-09-12', 14_070_000],
      ['2026-09-13', 13_360_000],
      ['2026-09-15', 400_000],
    ])
    expect(r.campaigns[0].spendThrough).toBe('2026-09-13')
    ads.calls.length = 0
    const again = await syncAdsData({ ads: ads.src, store }, { campaignIds: [CLOSED], now: nineEt('2026-10-30'), dryRun: false, source: 'ads-sync' })
    expect(ads.calls).toEqual([])
    expect(again).toMatchObject({ nothingDue: true })
    expect(again.campaigns[0]).toMatchObject({ outcome: 'up to date', spendThrough: '2026-09-13' })
    // the dashboard's freshness agrees
    const f = await readFreshness(sqliteD1(sqlite), nineEt('2026-10-30'), [campaignById(CLOSED)!])
    expect(f.get(CLOSED)).toMatchObject({ spendThrough: '2026-09-13', stale: false })
  })

  it('--dry-run reads and reports what would change, and writes nothing (not even a run row)', async () => {
    const { sqlite, adapter } = setup()
    const dry = createSqlAdsStore(adapter, { dryRun: true, kind: 'sqlite' })
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4.2) } })
    const r = await syncAdsData({ ads: ads.src, store: dry }, { campaignIds: [RETEST], now: nineEt('2026-09-28'), dryRun: true, source: 'ads-sync' })
    expect(r).toMatchObject({ dryRun: true, daysChanged: 2, runRecorded: false })
    expect(adapter.writes).toEqual([])
    expect(count(sqlite, 'ads_daily_metrics')).toBe(0)
    expect(r.campaigns[0].spend!.days['2026-09-26'].costMicros).toBe(4_200_000) // the reads still see the numbers
  })

  it("includeToday returns today's partial numbers without storing them", async () => {
    const { sqlite, store } = setup()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4.2) } })
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: at('2026-09-26T20:00:00Z'), dryRun: false, source: 'backstop', includeToday: true })
    expect(r.campaigns[0].today).toEqual(day(4.2))
    expect(r.campaigns[0].fetched).toBeNull() // nothing closed yet on the first flight day
    expect(count(sqlite, 'ads_daily_metrics')).toBe(0)
  })

  it('an unavailable Ads client fails the run (recorded with a redacted error), writing no metrics', async () => {
    const { sqlite, store } = setup()
    const r = await syncAdsData({ ads: null, adsInitError: 'Bitwarden is missing: google-ads-api-rep-developer-token', store }, { campaignIds: [RETEST], now: nineEt('2026-09-28'), dryRun: false, source: 'worker-cron' })
    expect(r.status).toBe('failed')
    expect(count(sqlite, 'ads_daily_metrics')).toBe(0)
    const run = sqlite.prepare('SELECT status, campaigns_ok, error FROM ads_sync_runs').get() as Record<string, string>
    expect(run.status).toBe('failed')
    expect(run.campaigns_ok).toBe('[]')
    expect(run.error).toMatch(/Bitwarden is missing/)
  })
})

describe('an empty or partial Ads response never turns stored spend into zeros (review M, 2026-09-26)', () => {
  async function stored69() {
    const s = setup()
    await s.store.syncCampaigns([campaignById(RETEST)!], 'x')
    const closedAt = '2026-09-29T13:00:00.000Z'
    await s.store.putDailyRows(RETEST, [
      { date: '2026-09-26', ...day(4), fetchedAt: closedAt, placementsFetchedAt: closedAt },
      { date: '2026-09-27', ...day(69), fetchedAt: closedAt, placementsFetchedAt: closedAt },
      { date: '2026-09-28', ...day(0, 0, 0), fetchedAt: closedAt, placementsFetchedAt: closedAt },
    ])
    await s.store.putPlacements(RETEST, [pl('2026-09-27', 'mobileapp::2-a', 60), pl('2026-09-27', 'mobileapp::2-b', 9, false)], closedAt)
    s.adapter.writes.length = 0
    return s
  }
  it("the reviewer's probe: $69 stored, an empty 200 response → spend stays $69, the run is not 'ok', nothing is written", async () => {
    const { sqlite, adapter, store } = await stored69()
    const ads = fakeAds({})
    ads.state.emptyDaily = true
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-29') + HOUR, dryRun: false, source: 'worker-on-demand', restatementRecheckMs: 0 })
    expect(r.status).not.toBe('ok')
    expect(r.campaigns[0]).toMatchObject({ fetchOk: false, dailyOk: false })
    expect(r.error).toMatch(/left out 2 stored day\(s\) with spend \(2026-09-26, 2026-09-27\)/)
    expect(costOf(sqlite, RETEST, '2026-09-27')).toBe(69_000_000)
    expect(metricWrites(adapter.writes)).toEqual([])
    const run = sqlite.prepare("SELECT status, campaigns_ok FROM ads_sync_runs WHERE status <> 'running'").get() as Record<string, string>
    expect(run).toEqual({ status: 'failed', campaigns_ok: '[]' })
  })
  it('without a range total to check against, a partial response writes nothing for that campaign', async () => {
    const { sqlite, adapter, store } = await stored69()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4), '2026-09-28': day(2) } }) // 09-27 missing
    const noTotal: AdsMetricsSource = { daily: ads.src.daily, placements: ads.src.placements }
    const r = await syncAdsData({ ads: noTotal, store }, { campaignIds: [RETEST], now: nineEt('2026-09-29') + HOUR, dryRun: false, source: 'ads-sync', restatementRecheckMs: 0 })
    expect(r.campaigns[0].fetchOk).toBe(false)
    expect(costOf(sqlite, RETEST, '2026-09-27')).toBe(69_000_000)
    expect(costOf(sqlite, RETEST, '2026-09-28')).toBe(0) // not updated either: the whole response is suspect
    expect(metricWrites(adapter.writes)).toEqual([])
  })
  it('a partial response that does not add up is re-pulled in halves: the day it left out is kept, the days around it (each checked) are written', async () => {
    const { sqlite, store } = await stored69()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4), '2026-09-28': day(2) } }) // 09-27 left out
    const truth = { '2026-09-26': day(4), '2026-09-27': day(69), '2026-09-28': day(2) }
    ads.state.total = (_id, since, until) => sumTruth(truth, since, until) // Google's total still has the $69
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-29') + HOUR, dryRun: false, source: 'ads-sync', restatementRecheckMs: 0 })
    expect(r.status).toBe('partial')
    expect(r.campaigns[0]).toMatchObject({ fetchOk: true, dailyOk: false, pulled: false })
    expect(r.error).toMatch(/daily rows for 2026-09-27\.\.2026-09-27 add up to \$0\.00 .* range total is \$69\.00/)
    expect(costOf(sqlite, RETEST, '2026-09-27')).toBe(69_000_000) // kept
    expect(costOf(sqlite, RETEST, '2026-09-28')).toBe(2_000_000) // its own pull added up
    expect(r.campaigns[0].warnings.join(' ')).toMatch(/pulled again in halves/)
  })
  it('a stored day Google credited in full (the range total agrees) is restated to zero, placements with it', async () => {
    const { sqlite, store } = await stored69()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4) } }) // Google's total agrees: 09-27 is $0 now (09-28 was $0 already)
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-29') + HOUR, dryRun: false, source: 'ads-sync', restatementRecheckMs: 0 })
    expect(r.status).toBe('ok')
    expect(r.campaigns[0].restated).toEqual([{ date: '2026-09-27', before: 69, after: 0 }])
    expect(costOf(sqlite, RETEST, '2026-09-27')).toBe(0)
    expect((sqlite.prepare("SELECT SUM(cost_micros) AS c FROM ads_placement_daily WHERE date = '2026-09-27'").get() as { c: number }).c).toBe(0)
  })
  it('a stored ZERO day missing from the response is consistent (still zero), not a failure', async () => {
    const { store } = await stored69()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4), '2026-09-27': day(69) } }, { [RETEST]: [pl('2026-09-27', 'mobileapp::2-a', 60), pl('2026-09-27', 'mobileapp::2-b', 9, false)] })
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-29') + HOUR, dryRun: false, source: 'ads-sync', restatementRecheckMs: 0 })
    expect(r).toMatchObject({ status: 'ok', daysChanged: 0, placementRowsChanged: 0 })
  })
  it('a stored placement row with spend missing from the response is a failed placement fetch: kept, not zeroed', async () => {
    const { sqlite, store } = await stored69()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4), '2026-09-27': day(69) } }, { [RETEST]: [pl('2026-09-27', 'mobileapp::2-a', 60)] })
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-29') + HOUR, dryRun: false, source: 'ads-sync', restatementRecheckMs: 0 })
    expect(r.status).toBe('partial')
    expect(r.campaigns[0]).toMatchObject({ placementsOk: false, pulled: false })
    expect(r.error).toMatch(/left out 1 stored placement-day row\(s\) with spend/)
    expect((sqlite.prepare("SELECT cost_micros FROM ads_placement_daily WHERE placement = 'mobileapp::2-b'").get() as { cost_micros: number }).cost_micros).toBe(9_000_000)
  })
})

describe('per-run caps: finish over later runs', () => {
  it('maxDays pulls the NEWEST days first (review L2) and leaves the older gap for the next run', async () => {
    const { sqlite, store } = setup()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4), '2026-09-27': day(13), '2026-09-28': day(12), '2026-09-29': day(11), '2026-09-30': day(10) } })
    const first = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-10-01'), dryRun: false, source: 'worker-cron', maxDays: 3 })
    expect(first).toMatchObject({ status: 'partial' })
    expect(first.error).toMatch(/^work cap: 24279250691 continues next run$/)
    // the recent window whole (so it counts as the restatement re-check); 09-26..09-27 wait
    expect(first.campaigns[0]).toMatchObject({ fetched: { since: '2026-09-28', until: '2026-09-30' }, deferred: true, pulled: true, spendThrough: null })
    const second = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-10-01') + 60_000, dryRun: false, source: 'worker-cron', maxDays: 3 })
    expect(second).toMatchObject({ status: 'ok' })
    // the older gap; the recent window was re-checked a minute ago, so it is not due
    expect(second.campaigns[0]).toMatchObject({ fetched: { since: '2026-09-26', until: '2026-09-27' }, pulled: false, spendThrough: '2026-09-30' })
    expect(count(sqlite, 'ads_daily_metrics')).toBe(5)
  })
  it('I3: a capped full re-pull says it covered only the newest days and is not resumed', async () => {
    const { store } = setup()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4), '2026-09-27': day(13), '2026-09-28': day(12), '2026-09-29': day(11), '2026-09-30': day(10) } })
    await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-10-01'), dryRun: false, source: 'ads-sync' })
    const full = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-10-01') + HOUR, dryRun: false, source: 'worker-on-demand', full: true, maxDays: 2 })
    expect(full.campaigns[0]).toMatchObject({ fetched: { since: '2026-09-29', until: '2026-09-30' }, deferred: true })
    expect(full.error).toMatch(/full re-pull of 24279250691 covered only the newest 2 day\(s\) and is not resumed/)
    const uncapped = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-10-01') + 2 * HOUR, dryRun: false, source: 'ads-sync', full: true })
    expect(uncapped).toMatchObject({ status: 'ok', daysFetched: 5, error: null })
  })
  it('the D1 statement cap stops a big run cleanly (the run row is still recorded) and the next runs finish the job', async () => {
    const { sqlite, adapter } = setup()
    const rows = Array.from({ length: 80 }, (_, i) => pl('2026-09-27', `mobileapp::2-app${i}`, 0.5))
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4), '2026-09-27': day(20) } }, { [RETEST]: rows })
    let runs = 0
    let last
    do {
      // One store per invocation, as in the Worker: the cap is per run.
      const store = createSqlAdsStore(adapter, { dryRun: false, maxStatements: 10 })
      last = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-28') + runs * 60_000, dryRun: false, source: 'worker-cron' })
      runs++
      expect(last.runRecorded).toBe(true)
      expect(store.statementsUsed()).toBeLessThanOrEqual(10)
      if (last.status !== 'ok') expect(last.error).toMatch(/query budget reached/)
    } while (last.status !== 'ok' && runs < 10)
    expect(last.status).toBe('ok')
    expect(runs).toBeGreaterThan(1)
    expect(count(sqlite, 'ads_placement_daily')).toBe(80)
    expect(count(sqlite, 'ads_daily_metrics', 'placements_fetched_at IS NOT NULL')).toBe(2)
  })
})

describe('review L1-L3 (2026-09-26): never a false $0, no starving, a re-check only when whole', () => {
  it('L1: a never-stored day a partial response left out is never saved as $0; the next good pull stores it', async () => {
    const { sqlite, store } = setup()
    const truth = { '2026-09-26': day(4), '2026-09-27': day(13), '2026-09-28': day(11) }
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4), '2026-09-27': day(13) } }) // 09-28 left out
    ads.state.total = (_id, since, until) => sumTruth(truth, since, until)
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-29'), dryRun: false, source: 'worker-cron' })
    expect(r.status).toBe('partial')
    expect(r.error).toMatch(/2026-09-28\.\.2026-09-28 add up to \$0\.00 .* range total is \$11\.00/)
    expect(costOf(sqlite, RETEST, '2026-09-28')).toBeUndefined() // no false $0 day
    expect(costOf(sqlite, RETEST, '2026-09-27')).toBe(13_000_000)
    expect(r.campaigns[0]).toMatchObject({ pulled: false, spendThrough: '2026-09-27' })
    ads.daily[RETEST]['2026-09-28'] = day(11)
    const again = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-29') + HOUR, dryRun: false, source: 'worker-cron' })
    expect(again.status).toBe('ok')
    expect(costOf(sqlite, RETEST, '2026-09-28')).toBe(11_000_000)
    expect(again.campaigns[0]).toMatchObject({ pulled: true, spendThrough: '2026-09-28' })
  })
  it('L2: a stuck old day never starves the days after it, under the Worker cap too', async () => {
    const { sqlite, store } = setup()
    await store.syncCampaigns([campaignById(RETEST)!], 'x')
    // 09-26 was stored while still open; Google's daily rows now leave it out, its total does not
    await store.putDailyRows(RETEST, [{ date: '2026-09-26', ...day(4), fetchedAt: '2026-09-26T20:00:00.000Z', placementsFetchedAt: null }])
    const daily = { '2026-09-27': day(13), '2026-09-28': day(12), '2026-09-29': day(11), '2026-09-30': day(10), '2026-10-01': day(9), '2026-10-02': day(8) }
    const ads = fakeAds({ [RETEST]: { ...daily } })
    ads.state.total = (_id, since, until) => sumTruth({ ...daily, '2026-09-26': day(4) }, since, until)
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-10-03'), dryRun: false, source: 'worker-cron', maxDays: 7 })
    expect(r.status).toBe('partial')
    expect(r.error).toMatch(/2026-09-26\.\.2026-09-26/)
    for (const [d, v] of Object.entries(daily)) expect(costOf(sqlite, RETEST, d)).toBe(v.costMicros)
    expect(costOf(sqlite, RETEST, '2026-09-26')).toBe(4_000_000) // kept as stored
    expect(r.campaigns[0]).toMatchObject({ pulled: true, fetchOk: true, dailyOk: false })
    // the recent window was pulled first, before the older gap
    expect(ads.calls.find((c) => c.kind === 'daily')).toMatchObject({ since: '2026-09-30', until: '2026-10-02' })
  })
  it('L2: under a cap the newest needed days go first, and after-flight days past them go last', async () => {
    const { store } = setup()
    const rows = await store.getAllDailyRows()
    // retest flight ends 10-02; on 10-12 the window runs to 10-11
    const plan = planCampaignSync(campaignById(RETEST)!, rows.get(RETEST) ?? [], '2026-10-12')
    expect(plan.ranges).toEqual([
      { since: '2026-10-09', until: '2026-10-11' },
      { since: '2026-09-26', until: '2026-10-08' },
    ])
    capPlan(plan, 5)
    // 3 recent days, then the 2 newest NEEDED days (flight days), not after-flight days
    expect(plan.ranges).toEqual([
      { since: '2026-10-09', until: '2026-10-11' },
      { since: '2026-10-01', until: '2026-10-02' },
    ])
    expect(plan.deferred).toBe(true)
  })
  it('L3: a capped pull of the recent window is not a restatement re-check (nothing marked pulled)', async () => {
    const { sqlite, store } = setup()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4), '2026-09-27': day(13), '2026-09-28': day(12), '2026-09-29': day(11), '2026-09-30': day(10) } })
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-10-01'), dryRun: false, source: 'worker-cron', maxDays: 2 })
    expect(r.campaigns[0]).toMatchObject({ fetched: { since: '2026-09-29', until: '2026-09-30' }, pulled: false, deferred: true })
    expect((sqlite.prepare("SELECT campaigns_pulled AS p FROM ads_sync_runs WHERE status <> 'running'").get() as { p: string }).p).toBe('[]')
    // so the next run still owes the whole recent window
    const next = planCampaignSync(campaignById(RETEST)!, (await store.getAllDailyRows()).get(RETEST)!, '2026-10-01', { nowMs: nineEt('2026-10-01') + 60_000, lastPullAt: null })
    expect(next.recheck).toEqual({ since: '2026-09-28', until: '2026-09-30' })
  })
})

describe('the atomic sync claim (migration 0004)', () => {
  it('of two concurrent claims exactly one wins; a claim blocks for the window only', async () => {
    const { sqlite, store } = setup()
    const now = nineEt('2026-09-28')
    const both = await Promise.all([store.claimSync('worker-on-demand', now, 600_000), store.claimSync('worker-on-demand', now + 5, 600_000)])
    expect(both.filter(Boolean)).toHaveLength(1)
    expect(await store.claimSync('worker-cron', now + 9 * 60_000, 600_000)).toBe(false)
    expect(await store.claimSync('worker-cron', now + 11 * 60_000, 600_000)).toBe(true)
    expect(count(sqlite, 'ads_sync_runs', "status = 'running'")).toBe(2)
  })
})

describe('killed sync runs are surfaced (review I2)', () => {
  it("a claim with no finished run 15 min later is an alert; a finished one, a younger one or a week-old one is not", async () => {
    const { sqlite, store } = setup()
    const t = at('2026-09-29T04:05:00Z') // 00:05 ET
    expect(await store.claimSync('worker-cron', t, 600_000)).toBe(true)
    const d1 = sqliteD1(sqlite)
    expect(await readSyncAlerts(d1, t + 14 * 60_000)).toEqual([]) // may still be running
    const alerts = await readSyncAlerts(d1, t + 16 * 60_000)
    expect(alerts).toEqual([{ source: 'worker-cron', startedAt: '2026-09-29T04:05:00.000Z', message: expect.stringMatching(/^The worker-cron sync started Sep 29 00:05 ET never finished \(killed mid-run/) }])
    expect(await store.getSyncAlerts(t + 16 * 60_000)).toEqual(alerts)
    expect(await readSyncAlerts(d1, t + 8 * 86_400_000)).toEqual([]) // older than the 7-day lookback
    // a claim that finished (same source and start) is not an alert
    const t2 = t + 3 * 3_600_000
    expect(await store.claimSync('worker-on-demand', t2, 600_000)).toBe(true)
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4), '2026-09-27': day(13), '2026-09-28': day(12) } })
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: t2, dryRun: false, source: 'worker-on-demand' })
    expect(r.runRecorded).toBe(true)
    expect((await readSyncAlerts(d1, t2 + 20 * 60_000)).map((a) => a.source)).toEqual(['worker-cron'])
    expect(await readSyncAlerts(undefined, t2)).toEqual([]) // no binding: fail soft
  })
})

describe('readings de-dup and append-only, enforced by the database', () => {
  const rec = (over: Partial<ReadingRecord> = {}): ReadingRecord => ({
    v: 1,
    id: `daily:${RETEST}:2026-09-30T12:05:00.000Z`,
    campaignId: RETEST,
    kind: 'daily',
    readAt: '2026-09-30T12:05:00.000Z',
    etDate: '2026-09-30',
    spendThroughEt: '2026-09-29',
    cumulativeSpend: 50.1,
    thresholds: [],
    complete: true,
    rules: null,
    proposal: null,
    decision: null,
    counts: {},
    notes: [],
    ...over,
  })
  it('a second row for the same (campaign, ET day, entry kind) is ignored; the first is untouched', async () => {
    const { sqlite, store } = setup()
    await store.syncCampaigns([campaignById(RETEST)!], 'x')
    expect(await store.appendReadings([rec()])).toMatchObject({ inserted: [rec().id], ignored: [] })
    const rerun = rec({ id: `daily:${RETEST}:2026-09-30T14:00:00.000Z`, readAt: '2026-09-30T14:00:00.000Z', cumulativeSpend: 99 })
    expect(await store.appendReadings([rerun])).toMatchObject({ inserted: [], ignored: [rerun.id] })
    expect(count(sqlite, 'ads_readings')).toBe(1)
    expect((sqlite.prepare('SELECT cumulative_spend_micros AS m FROM ads_readings').get() as { m: number }).m).toBe(50_100_000)
    expect(await store.appendReadings([rec({ id: 'daily:x', readAt: '2026-09-30T15:00:00.000Z', proposal: 'PROPOSE PAUSE' })])).toMatchObject({ inserted: ['daily:x'] })
    expect((sqlite.prepare('SELECT entry_kind FROM ads_readings ORDER BY id').all() as { entry_kind: string }[]).map((r) => r.entry_kind)).toEqual(['morning', 'morning+pause'])
  })
  it('INSERT OR REPLACE cannot rewrite a stored reading through the new key (0003 trigger), nor UPDATE/DELETE it', async () => {
    const { sqlite, store } = setup()
    await store.syncCampaigns([campaignById(RETEST)!], 'x')
    await store.appendReadings([rec()])
    sqlite
      .prepare(
        "INSERT OR REPLACE INTO ads_readings (reading_key, campaign_id, kind, read_at, et_date, complete, routine_version, entry_kind) VALUES ('other-key', ?, 'daily', 'z', '2026-09-30', 0, 'evil', 'morning')",
      )
      .run(RETEST)
    expect((sqlite.prepare('SELECT reading_key FROM ads_readings').all() as Record<string, string>[]).map((r) => r.reading_key)).toEqual([rec().id])
    expect(() => sqlite.exec('UPDATE ads_readings SET complete = 0')).toThrow(/append-only/)
    expect(() => sqlite.exec('DELETE FROM ads_readings')).toThrow(/append-only/)
  })
  it('threshold state stays once-only and points at its reading', async () => {
    const { sqlite, store } = setup()
    await store.syncCampaigns([campaignById(RETEST)!], 'x')
    await store.appendReadings([rec({ id: 'threshold:1', kind: 'threshold', thresholds: [50], proposal: 'CONTINUE' })])
    await store.appendReadings([rec({ id: 'threshold:2', kind: 'threshold', thresholds: [50], proposal: 'CONTINUE', etDate: '2026-10-01', readAt: '2026-10-01T12:05:00.000Z' })])
    expect(count(sqlite, 'ads_threshold_state')).toBe(1)
    const s = sqlite.prepare('SELECT t.threshold_usd, r.reading_key FROM ads_threshold_state t JOIN ads_readings r ON r.id = t.reading_id').get() as Record<string, unknown>
    expect(s).toEqual({ threshold_usd: 50, reading_key: 'threshold:1' })
    expect(await store.getConsumedThresholds(RETEST)).toEqual([50])
  })
  it('a lost threshold-state write: the reading already exists → a rerun restores the state; the threshold never counts as unfired', async () => {
    const sqlite = openMigratedSqlite()
    const base = sqliteAdsDb(sqlite)
    let failState = true
    const flaky = {
      all: base.all,
      async run(stmt: SqlStatement) {
        if (failState && /^INSERT INTO ads_threshold_state/.test(stmt.sql)) throw new Error('network: the D1 call timed out')
        return base.run(stmt)
      },
    }
    const store = createSqlAdsStore(flaky, { dryRun: false })
    await store.syncCampaigns([campaignById(RETEST)!], 'x')
    const th = rec({ id: 'threshold:1', kind: 'threshold', thresholds: [50], proposal: 'CONTINUE' })
    await expect(store.appendReadings([th])).rejects.toThrow(/timed out/)
    expect(count(sqlite, 'ads_readings')).toBe(1) // the reading landed
    expect(count(sqlite, 'ads_threshold_state')).toBe(0) // its state did not
    // Consumed already (from the complete reading), so it cannot fire again meanwhile.
    expect(await store.getConsumedThresholds(RETEST)).toEqual([50])
    expect(await store.getThresholdLedger(RETEST)).toEqual({ state: [], fromReadings: [50] })
    failState = false
    // The same record again (a rerun): the reading is ignored, the state insert still runs.
    expect(await store.appendReadings([th])).toMatchObject({ inserted: [], ignored: ['threshold:1'] })
    expect(count(sqlite, 'ads_threshold_state')).toBe(1)
    expect(await store.getThresholdLedger(RETEST)).toEqual({ state: [50], fromReadings: [50] })
  })
  it('sync runs are append-only too', async () => {
    const { sqlite, store } = setup()
    await syncAdsData({ ads: fakeAds({}).src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-28'), dryRun: false, source: 'ads-sync' })
    expect(() => sqlite.exec("UPDATE ads_sync_runs SET status = 'ok'")).toThrow(/append-only/)
    expect(() => sqlite.exec('DELETE FROM ads_sync_runs')).toThrow(/append-only/)
  })
})
