// R-4: `npm run ads:play-sync` — Google Play's per-day install totals into ads_play_daily
// (migration 0005). Against real migrated SQLite and a fake Play reader: no network, no credential,
// and never the production database.
import { describe, expect, it } from 'vitest'
import { assertAdsWriteSql, normalizePlayDays, playDailyUpserts, type PlayDayRow } from '../../src/lib/adsStore'
import { HOUSEHOLD_NOTE, RETENTION_NOTE, type PlayInstallDay, type PlayReportsSection } from './play'
import { DEFAULT_PLAY_SYNC_START, runPlaySync } from './playSyncCore'
import { count, migrationFiles, openMigratedSqlite, sqliteAdsDb } from './sqliteDb'

const NOW = Date.parse('2026-10-03T16:00:00Z') // 12:00 ET, 2026-10-03
const day = (date: string, d: number | null, u: number | null, un: number | null, a: number | null): PlayInstallDay => ({ date, deviceInstalls: d, userInstalls: u, deviceUninstalls: un, activeDeviceInstalls: a })
const DAYS = [day('2026-09-26', 5, 4, 1, 50), day('2026-09-27', 3, 3, 2, 52), day('2026-09-28', null, null, null, null)]

function section(over: Partial<PlayReportsSection> = {}): PlayReportsSection {
  return {
    ok: true,
    error: null,
    bucket: 'b',
    installsThrough: '2026-09-28',
    storePerformanceThrough: null,
    installsLagDays: 5,
    storePerformanceLagDays: null,
    installsByDay: DAYS,
    // The reader also returns acquisition splits: the sync must never store them.
    acquisitionByCountry: [{ date: '2026-09-27', dimension: 'US', visitors: 9, acquisitions: 2, conversionRate: 0.2 }] as PlayReportsSection['acquisitionByCountry'],
    acquisitionBySource: [],
    retentionNote: RETENTION_NOTE,
    householdNote: HOUSEHOLD_NOTE,
    checkpoints: [],
    errors: [],
    ...over,
  }
}
function harness(report: PlayReportsSection = section()) {
  const sqlite = openMigratedSqlite()
  const db = sqliteAdsDb(sqlite)
  const calls: { since: string; until: string }[] = []
  const go = (o: { dryRun?: boolean; since?: string; until?: string; report?: PlayReportsSection } = {}) =>
    runPlaySync({
      read: async (r) => {
        calls.push({ since: r.since, until: r.until })
        return o.report ?? report
      },
      db,
      nowMs: NOW,
      dryRun: !!o.dryRun,
      since: o.since,
      until: o.until,
    })
  return { sqlite, db, calls, go }
}
const rows = (sqlite: ReturnType<typeof openMigratedSqlite>) => sqlite.prepare('SELECT * FROM ads_play_daily ORDER BY date').all() as Record<string, unknown>[]

describe('migration 0005 (ads_play_daily)', () => {
  it('is the fifth migration and creates one counts-only table', () => {
    expect(migrationFiles().at(-1)).toBe('0005_play_daily.sql')
    const sqlite = openMigratedSqlite()
    const cols = (sqlite.prepare("PRAGMA table_info('ads_play_daily')").all() as { name: string }[]).map((c) => c.name)
    // No hour, country, source or device column, and no id that could tie a row to a visitor.
    expect(cols).toEqual(['date', 'device_installs', 'user_installs', 'device_uninstalls', 'active_device_installs', 'fetched_at'])
  })
  it('refuses a malformed date and a negative count, and accepts a null count', () => {
    const sqlite = openMigratedSqlite()
    const ins = sqlite.prepare("INSERT INTO ads_play_daily (date, device_installs, fetched_at) VALUES (?, ?, 'x')")
    expect(() => ins.run('26-09-2026', 1)).toThrow()
    expect(() => ins.run('2026-09-26', -1)).toThrow()
    expect(() => ins.run('2026-09-26', null)).not.toThrow()
  })
})

describe('the write path', () => {
  it('passes the ads write guard (a single INSERT ... ON CONFLICT DO UPDATE)', () => {
    for (const s of playDailyUpserts(normalizePlayDays(DAYS), 'now')) expect(() => assertAdsWriteSql(s.sql)).not.toThrow()
  })
  it('chunks to stay under the bind limit', () => {
    const many: PlayDayRow[] = Array.from({ length: 40 }, (_, i) => ({
      date: new Date(Date.UTC(2026, 8, 26 + i)).toISOString().slice(0, 10),
      deviceInstalls: i,
      userInstalls: i,
      deviceUninstalls: 0,
      activeDeviceInstalls: 1,
    }))
    const stmts = playDailyUpserts(many, 'now')
    expect(stmts.length).toBeGreaterThan(1)
    for (const s of stmts) expect(s.binds.length).toBeLessThanOrEqual(100)
  })
  it('keeps well-formed dates only, the last row of a repeated date, and nulls a negative or non-finite count', () => {
    const out = normalizePlayDays([
      { date: '2026-09-27', deviceInstalls: 1, userInstalls: 1, deviceUninstalls: 0, activeDeviceInstalls: 1 },
      { date: '2026-09-26', deviceInstalls: -3, userInstalls: Number.NaN, deviceUninstalls: 2, activeDeviceInstalls: null },
      { date: '2026-09-27', deviceInstalls: 9, userInstalls: 9, deviceUninstalls: 9, activeDeviceInstalls: 9 },
      { date: 'garbage', deviceInstalls: 1, userInstalls: 1, deviceUninstalls: 1, activeDeviceInstalls: 1 },
    ])
    expect(out).toEqual([
      { date: '2026-09-26', deviceInstalls: null, userInstalls: null, deviceUninstalls: 2, activeDeviceInstalls: null },
      { date: '2026-09-27', deviceInstalls: 9, userInstalls: 9, deviceUninstalls: 9, activeDeviceInstalls: 9 },
    ])
  })
})

describe('runPlaySync', () => {
  it('defaults to the Play tracking go-live (2026-09-26) and today in ET', async () => {
    const h = harness()
    await h.go()
    expect(DEFAULT_PLAY_SYNC_START).toBe('2026-09-26')
    expect(h.calls).toEqual([{ since: '2026-09-26', until: '2026-10-03' }])
  })
  it('writes one row per Play day, null counts kept null, and only into ads_play_daily', async () => {
    const h = harness()
    const r = await h.go()
    expect(r).toMatchObject({ ok: true, dryRun: false, days: 3, written: 3, statements: 1, installsThrough: '2026-09-28' })
    expect(rows(h.sqlite).map((x) => [x.date, x.device_installs, x.user_installs, x.device_uninstalls, x.active_device_installs])).toEqual([
      ['2026-09-26', 5, 4, 1, 50],
      ['2026-09-27', 3, 3, 2, 52],
      ['2026-09-28', null, null, null, null],
    ])
    for (const w of h.db.writes) expect(w.sql).toMatch(/^INSERT INTO ads_play_daily /)
  })
  it('is idempotent: a re-run leaves the same rows, and a re-posted day overwrites in place', async () => {
    const h = harness()
    await h.go()
    await h.go()
    expect(count(h.sqlite, 'ads_play_daily')).toBe(3)
    await h.go({ report: section({ installsByDay: [day('2026-09-27', 4, 4, 2, 53)] }) })
    expect(count(h.sqlite, 'ads_play_daily')).toBe(3)
    expect(rows(h.sqlite).find((x) => x.date === '2026-09-27')).toMatchObject({ device_installs: 4, active_device_installs: 53 })
  })
  it('--dry-run reads Play but writes nothing, and says how much it would write', async () => {
    const h = harness()
    const r = await h.go({ dryRun: true })
    expect(r).toMatchObject({ ok: true, dryRun: true, days: 3, written: 0, statements: 1 })
    expect(h.db.writes).toEqual([])
    expect(count(h.sqlite, 'ads_play_daily')).toBe(0)
    expect(r.lines.join('\n')).toMatch(/DRY RUN, nothing written/)
  })
  it('an unreadable Play report fails with nothing written', async () => {
    const h = harness()
    const r = await h.go({ report: section({ ok: false, error: 'service-account file unreadable', installsByDay: null }) })
    expect(r).toMatchObject({ ok: false, written: 0, error: 'service-account file unreadable' })
    expect(h.db.writes).toEqual([])
  })
  it('a failed installs month file is a failure (partial), but a store_performance failure is only a warning', async () => {
    const partial = harness()
    const r1 = await partial.go({ report: section({ errors: ['installs overview (installs_x_202609_overview.csv): HTTP 500'] }) })
    expect(r1.ok).toBe(false)
    expect(r1.written).toBe(3) // the days that were read are still written
    const warn = harness()
    const r2 = await warn.go({ report: section({ errors: ['store_performance (x.csv): HTTP 500'] }) })
    expect(r2.ok).toBe(true)
    expect(r2.lines.join('\n')).toMatch(/warning: store_performance/)
  })
  it('rejects a bad range before reading anything', async () => {
    const h = harness()
    expect((await h.go({ since: '2026-10-05', until: '2026-10-01' })).ok).toBe(false)
    expect((await h.go({ since: 'yesterday' })).ok).toBe(false)
    expect(h.calls).toEqual([])
  })
  it('prints the household and no-retention caveats with every run', async () => {
    const h = harness()
    const text = (await h.go({ dryRun: true })).lines.join('\n')
    expect(text).toContain(HOUSEHOLD_NOTE)
    expect(text).toContain(RETENTION_NOTE)
  })
})
