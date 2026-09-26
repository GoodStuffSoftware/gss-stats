// The shared sync (src/lib/adsSync.ts syncAdsData) against a REAL SQLite with migrations
// 0001+0002+0003 applied: gap fill (missing middle days), restatements, the no-op rerun, placement
// coverage, closed-campaign windows, --dry-run, today's partial numbers; plus the readings de-dup
// the UNIQUE index and triggers enforce.
import { describe, expect, it } from 'vitest'
import type { SpendDay, ReadingRecord } from '../../src/lib/adsRules'
import { createSqlAdsStore, type PlacementDayRow } from '../../src/lib/adsStore'
import { planCampaignSync, syncAdsData, syncWindow, type AdsMetricsSource } from '../../src/lib/adsSync'
import { campaignById } from '../../src/lib/campaigns'
import { count, migrationFiles, openMigratedSqlite, sqliteAdsDb } from './sqliteDb'

const RETEST = '24279250691'
const CLOSED = '24234347705' // flight 2026-09-09..2026-09-13, status closed
const at = (iso: string) => Date.parse(iso)
// 09:00 ET (EDT = UTC-4) on the given ET date.
const nineEt = (d: string) => at(`${d}T13:00:00Z`)
const day = (usd: number, impressions = 1000, clicks = 10): SpendDay => ({ costMicros: Math.round(usd * 1e6), impressions, clicks })

function fakeAds(daily: Record<string, Record<string, SpendDay>>, placements: Record<string, PlacementDayRow[]> = {}) {
  const calls: { kind: 'daily' | 'placements'; id: string; since: string; until: string }[] = []
  const state = { failPlacements: false, failDaily: false }
  const src: AdsMetricsSource = {
    async daily(id, since, until) {
      calls.push({ kind: 'daily', id, since, until })
      if (state.failDaily) throw new Error('Google Ads search failed, HTTP 500: backend error')
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

function setup() {
  const sqlite = openMigratedSqlite()
  const adapter = sqliteAdsDb(sqlite)
  const store = createSqlAdsStore(adapter, { dryRun: false, kind: 'sqlite' })
  return { sqlite, adapter, store }
}
const metricWrites = (w: { sql: string; changes: number }[]) => w.filter((x) => /^INSERT INTO ads_(daily_metrics|placement_daily)/.test(x.sql))

describe('migrations 0001 + 0002 + 0003 in local SQLite', () => {
  it('apply in order and create the sync-run table, the de-dup index and the no-REPLACE triggers', () => {
    expect(migrationFiles()).toEqual(['0001_init.sql', '0002_no_replace.sql', '0003_sync_and_dedup.sql'])
    const db = openMigratedSqlite()
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')").all() as { name: string }[]).map((r) => r.name)
    for (const n of ['ads_sync_runs', 'ads_readings_one_per_entry', 'ads_readings_no_replace_entry', 'ads_sync_runs_no_replace', 'ads_sync_runs_append_only_update']) expect(names).toContain(n)
  })
  it('0003 keeps the v0.4.0 writers working: an insert without entry_kind still lands (NULLs never collide)', () => {
    const { sqlite, store } = setup()
    return store.syncCampaigns([campaignById(RETEST)!], '2026-09-26T00:00:00Z').then(() => {
      const legacy = (key: string) =>
        sqlite
          .prepare(
            "INSERT INTO ads_readings (reading_key, campaign_id, kind, stage, read_at, et_date, spend_through_et, cumulative_spend_micros, thresholds, complete, rules, proposal, decision, counts, notes, routine_version) VALUES (?, ?, 'health', NULL, ?, '2026-09-26', NULL, NULL, '[]', 1, NULL, NULL, NULL, '{}', '[]', 'ads-reads/1.0.0') ON CONFLICT (reading_key) DO NOTHING",
          )
          .run(key, RETEST, '2026-09-27T03:15:00Z')
      legacy('health:a')
      legacy('health:b')
      expect(count(sqlite, 'ads_readings')).toBe(2)
      // and the v0.4.0 daily upsert (no placements_fetched_at) too
      sqlite
        .prepare("INSERT INTO ads_daily_metrics (campaign_id, date, cost_micros, impressions, clicks, source, fetched_at) VALUES (?, '2026-09-26', 1, 1, 0, 'google-ads-api', 'x') ON CONFLICT (campaign_id, date) DO UPDATE SET cost_micros = excluded.cost_micros")
        .run(RETEST)
      expect(count(sqlite, 'ads_daily_metrics', 'placements_fetched_at IS NULL')).toBe(1)
    })
  })
})

describe('syncAdsData: gap fill, restatements, the no-op rerun', () => {
  it('a first sync pulls every closed flight day, zero-fills the days the API omits, and records the run', async () => {
    const { sqlite, store } = setup()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4.2), '2026-09-27': day(13.1), '2026-09-29': day(12.9), '2026-09-30': day(3) } })
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-30'), dryRun: false, source: 'ads-sync' })
    expect(r.status).toBe('ok')
    expect(ads.calls.filter((c) => c.kind === 'daily')).toEqual([{ kind: 'daily', id: RETEST, since: '2026-09-26', until: '2026-09-29' }])
    const rows = sqlite.prepare('SELECT date, cost_micros FROM ads_daily_metrics WHERE campaign_id = ? ORDER BY date').all(RETEST) as { date: string; cost_micros: number }[]
    expect(rows.map((x) => [x.date, x.cost_micros])).toEqual([
      ['2026-09-26', 4_200_000],
      ['2026-09-27', 13_100_000],
      ['2026-09-28', 0], // no API row = no delivery: stored as zero, so the stored days are contiguous
      ['2026-09-29', 12_900_000],
    ]) // and never today's open day
    expect(r.campaigns[0]).toMatchObject({ spendThrough: '2026-09-29', daysFetched: 4, daysChanged: 4 })
    expect(count(sqlite, 'ads_sync_runs')).toBe(1)
    const run = sqlite.prepare('SELECT source, status, campaigns, campaigns_ok, days_fetched, days_changed FROM ads_sync_runs').get() as Record<string, unknown>
    expect(run).toMatchObject({ source: 'ads-sync', status: 'ok', campaigns: `["${RETEST}"]`, campaigns_ok: `["${RETEST}"]`, days_fetched: 4, days_changed: 4 })
  })

  it('running it twice in a row changes nothing the second time and never duplicates a row', async () => {
    const { sqlite, adapter, store } = setup()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4.2), '2026-09-27': day(13.1), '2026-09-29': day(12.9) } }, { [RETEST]: [pl('2026-09-27', 'mobileapp::2-com.easybrain.sudoku.android', 13.1)] })
    await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-30'), dryRun: false, source: 'morning-read' })
    const snapshot = () => ({
      daily: sqlite.prepare('SELECT * FROM ads_daily_metrics ORDER BY campaign_id, date').all(),
      placements: sqlite.prepare('SELECT * FROM ads_placement_daily ORDER BY campaign_id, date, placement').all(),
      campaigns: sqlite.prepare('SELECT * FROM ads_campaigns ORDER BY id').all(),
    })
    const before = snapshot()
    adapter.writes.length = 0
    const again = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-30') + 60_000, dryRun: false, source: 'worker-cron' })
    expect(again).toMatchObject({ status: 'ok', daysChanged: 0, placementRowsChanged: 0 })
    expect(again.campaigns[0].outcome).toBe('no change')
    expect(again.campaigns[0].fetched).toEqual({ since: '2026-09-27', until: '2026-09-29' }) // the restatement window, re-checked
    expect(metricWrites(adapter.writes)).toEqual([]) // no metric statement at all
    expect(adapter.writes.filter((w) => w.changes > 0).map((w) => w.sql.slice(0, 30))).toEqual(['INSERT INTO ads_sync_runs (run']) // only its own run row
    expect(snapshot()).toEqual(before)
    expect(count(sqlite, 'ads_sync_runs')).toBe(2)
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

  it('a restated recent day is re-pulled, overwritten in place (one row), and reported', async () => {
    const { sqlite, store } = setup()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4.2), '2026-09-27': day(13.1), '2026-09-28': day(11), '2026-09-29': day(12.9) } })
    await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-30'), dryRun: false, source: 'ads-sync' })
    ads.daily[RETEST]['2026-09-28'] = day(10.55) // Google credits invalid clicks
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-30') + 3_600_000, dryRun: false, source: 'worker-cron' })
    expect(r.campaigns[0].changedDates).toEqual(['2026-09-28'])
    expect(r.campaigns[0].restated).toEqual([{ date: '2026-09-28', before: 11, after: 10.55 }])
    expect(count(sqlite, 'ads_daily_metrics', "campaign_id = ? AND date = '2026-09-28'", RETEST)).toBe(1)
    expect((sqlite.prepare("SELECT cost_micros FROM ads_daily_metrics WHERE date = '2026-09-28'").get() as { cost_micros: number }).cost_micros).toBe(10_550_000)
  })

  it('a day stored while it was still open (the v0.4.0 routine did that) is re-pulled once, then left alone', async () => {
    const { store } = setup()
    await store.syncCampaigns([campaignById(RETEST)!], 'x')
    await store.putDailyRows(RETEST, [{ date: '2026-09-29', ...day(5), fetchedAt: '2026-09-29T20:00:00.000Z', placementsFetchedAt: null }])
    const plan = planCampaignSync(campaignById(RETEST)!, await store.getDailyRows(RETEST), '2026-09-30')
    expect(plan.missingDays).toContain('2026-09-29')
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4.2), '2026-09-29': day(12.9) } })
    const first = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-30'), dryRun: false, source: 'ads-sync' })
    expect(first.campaigns[0].changedDates).toContain('2026-09-29')
    const second = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-30') + 60_000, dryRun: false, source: 'ads-sync' })
    expect(second.daysChanged).toBe(0)
  })

  it('a failed placement pull leaves those days marked uncovered, so the next run pulls them again', async () => {
    const { sqlite, store } = setup()
    const ads = fakeAds({ [RETEST]: { '2026-09-26': day(4.2), '2026-09-27': day(13.1) } }, { [RETEST]: [pl('2026-09-26', 'mobileapp::2-a', 4.2), pl('2026-09-27', 'mobileapp::2-a', 13.1)] })
    ads.state.failPlacements = true
    const first = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-28'), dryRun: false, source: 'ads-sync' })
    expect(first.status).toBe('partial')
    expect(first.error).toMatch(/HTTP 503/)
    expect(count(sqlite, 'ads_daily_metrics', 'placements_fetched_at IS NULL')).toBe(2)
    ads.state.failPlacements = false
    const second = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-28') + 60_000, dryRun: false, source: 'ads-sync' })
    expect(second.status).toBe('ok')
    expect(second.campaigns[0].placementRowsChanged).toBe(2)
    expect(count(sqlite, 'ads_daily_metrics', 'placements_fetched_at IS NULL')).toBe(0)
    const third = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-28') + 120_000, dryRun: false, source: 'ads-sync' })
    expect(third).toMatchObject({ daysChanged: 0, placementRowsChanged: 0 })
  })

  it('a placement restated away is written back as zero cost (the writer never deletes)', async () => {
    const { sqlite, store } = setup()
    const ads = fakeAds({ [RETEST]: { '2026-09-27': day(13.1) } }, { [RETEST]: [pl('2026-09-27', 'mobileapp::2-a', 10), pl('2026-09-27', 'mobileapp::2-b', 3.1, false)] })
    await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-28'), dryRun: false, source: 'ads-sync' })
    ads.placements[RETEST] = [pl('2026-09-27', 'mobileapp::2-a', 10)]
    const r = await syncAdsData({ ads: ads.src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-28') + 60_000, dryRun: false, source: 'ads-sync' })
    expect(r.campaigns[0].placementRowsChanged).toBe(1)
    expect((sqlite.prepare("SELECT cost_micros FROM ads_placement_daily WHERE placement = 'mobileapp::2-b'").get() as { cost_micros: number }).cost_micros).toBe(0)
    expect(count(sqlite, 'ads_placement_daily')).toBe(2)
  })

  it('a closed campaign is synced through flight end + 3 days, once; after that it costs no API call', async () => {
    const { sqlite, store } = setup()
    expect(syncWindow(campaignById(CLOSED)!, '2026-09-30')).toEqual({ since: '2026-09-09', until: '2026-09-16' })
    const ads = fakeAds({ [CLOSED]: { '2026-09-09': day(21.56), '2026-09-10': day(13.52), '2026-09-11': day(12.66), '2026-09-12': day(14.07), '2026-09-13': day(13.36) } })
    await syncAdsData({ ads: ads.src, store }, { campaignIds: [CLOSED], now: nineEt('2026-09-30'), dryRun: false, source: 'backfill' })
    expect(count(sqlite, 'ads_daily_metrics', 'campaign_id = ?', CLOSED)).toBe(8)
    ads.calls.length = 0
    const again = await syncAdsData({ ads: ads.src, store }, { campaignIds: [CLOSED], now: nineEt('2026-09-30') + 60_000, dryRun: false, source: 'ads-sync' })
    expect(ads.calls).toEqual([])
    expect(again.campaigns[0]).toMatchObject({ outcome: 'up to date', spendThrough: '2026-09-16' })
  })

  it('--dry-run reads and reports what would change, and writes nothing (not even a run row)', async () => {
    const { sqlite, adapter, store: _s } = setup()
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
    // new information (a pause proposal) is a different entry kind and is appended
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
    expect((sqlite.prepare('SELECT reading_key, routine_version FROM ads_readings').all() as Record<string, string>[]).map((r) => r.reading_key)).toEqual([rec().id])
    expect(() => sqlite.exec("UPDATE ads_readings SET complete = 0")).toThrow(/append-only/)
    expect(() => sqlite.exec('DELETE FROM ads_readings')).toThrow(/append-only/)
  })
  it('threshold state stays once-only and points at its reading', async () => {
    const { sqlite, store } = setup()
    await store.syncCampaigns([campaignById(RETEST)!], 'x')
    const th = rec({ id: 'threshold:1', kind: 'threshold', thresholds: [50], proposal: 'CONTINUE' })
    await store.appendReadings([th])
    await store.appendReadings([rec({ id: 'threshold:2', kind: 'threshold', thresholds: [50], proposal: 'CONTINUE', etDate: '2026-10-01', readAt: '2026-10-01T12:05:00.000Z' })])
    expect(count(sqlite, 'ads_threshold_state')).toBe(1)
    const s = sqlite.prepare('SELECT t.threshold_usd, r.reading_key FROM ads_threshold_state t JOIN ads_readings r ON r.id = t.reading_id').get() as Record<string, unknown>
    expect(s).toEqual({ threshold_usd: 50, reading_key: 'threshold:1' })
    expect(await store.getConsumedThresholds(RETEST)).toEqual([50])
  })
  it('sync runs are append-only too', async () => {
    const { sqlite, store } = setup()
    await syncAdsData({ ads: fakeAds({}).src, store }, { campaignIds: [RETEST], now: nineEt('2026-09-28'), dryRun: false, source: 'ads-sync' })
    expect(() => sqlite.exec("UPDATE ads_sync_runs SET status = 'ok'")).toThrow(/append-only/)
    expect(() => sqlite.exec('DELETE FROM ads_sync_runs')).toThrow(/append-only/)
  })
})
