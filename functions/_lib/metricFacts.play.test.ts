// R-4: the Play tiles' metrics through planBatch -> fetchFacts (real SQLite, the real migration
// 0005 table) -> deriveBatch, including the "not yet active" path (a missing table, a missing
// binding) that must read as empty, never as an error.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { deriveBatch, planBatch } from '../../src/lib/metrics/engine'
import { validateMetricsRequest } from '../../src/lib/metrics/validate'
import { etDateFromMs } from '../../src/lib/popupEvents'
import { fetchFacts } from './metricFacts'
import { insertHits, memoryCache, openHitsDb, sqliteD1 } from './testing/hitsDb'

const NOW = Date.parse('2026-10-03T16:00:00Z')
type Ctx = { since: string; until: string }
const IDS = ['play.deviceInstalls', 'play.deviceUninstalls', 'play.activeDeviceInstalls', 'play.dataThrough'] as const

// The table as migration 0005 creates it, minus its CHECKs (scripts/ads-reads/play-sync.test.ts
// applies the real migration file and covers those; this file's tsconfig has no node:fs).
function openMigratedSqlite(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE ads_play_daily (date TEXT PRIMARY KEY, device_installs INTEGER, user_installs INTEGER, device_uninstalls INTEGER, active_device_installs INTEGER, fetched_at TEXT NOT NULL)')
  return db
}

function seeded(): DatabaseSync {
  const db = openMigratedSqlite()
  const ins = db.prepare('INSERT INTO ads_play_daily (date, device_installs, user_installs, device_uninstalls, active_device_installs, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
  ins.run('2026-09-26', 5, 4, 1, 50, '2026-10-03T12:00:00Z')
  ins.run('2026-09-27', 3, 3, 2, 52, '2026-10-03T12:00:00Z')
  ins.run('2026-09-28', null, null, null, null, '2026-10-03T12:00:00Z') // a day Play had no figures for
  ins.run('2026-09-29', 7, 6, 0, 55, '2026-10-03T12:00:00Z')
  return db
}

// A D1 whose every statement fails the way a real outage does (not a missing table).
const throwingD1 = (message: string) => ({ prepare: () => ({ bind: () => ({ all: async () => { throw new Error(message) } }) }) }) as unknown as D1Database

async function run(ads: DatabaseSync | undefined | 'broken' | D1Database, ctx: Ctx, cache = memoryCache()) {
  const hits = openHitsDb()
  insertHits(hits, [])
  const requests = IDS.map((id) => ({ key: id.toLowerCase(), metric: id, window: 'page' }))
  const batch = validateMetricsRequest(JSON.stringify({ v: 1, context: { ...ctx, sites: ['bestsudoku-web'] }, requests }))
  if (!batch.ok) throw new Error(batch.error)
  expect(batch.requests.filter((r) => !r.ok)).toEqual([])
  const adsD1 = ads === undefined ? undefined : ads === 'broken' ? sqliteD1(new DatabaseSync(':memory:')) : ads instanceof DatabaseSync ? sqliteD1(ads) : ads
  const env = { context: batch.context, nowMs: NOW, todayEt: etDateFromMs(NOW), hasAdsDb: !!adsD1 }
  const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env)
  const fetched = await fetchFacts(plan, { gss_geo: sqliteD1(hits), gss_stats_ads: adsD1 }, { nowMs: NOW, fresh: false, cache, waitUntil: () => {} })
  return { out: deriveBatch(batch.requests, { ...env, facts: fetched.facts }), plan }
}

describe('the Play tiles over stored Play days', () => {
  it('sums installs and uninstalls over the range, takes the last day of the stock, and reports the newest stored day', async () => {
    const { out } = await run(seeded(), { since: '2026-09-26', until: '2026-09-29' })
    expect(out['play.deviceinstalls']).toMatchObject({ status: 'ok', value: 15 })
    expect(out['play.deviceuninstalls']).toMatchObject({ status: 'ok', value: 3 })
    // the 09-28 day has no figure, so the stock is the last day WITH one (09-29), not a sum
    expect(out['play.activedeviceinstalls']).toMatchObject({ status: 'ok', value: 55 })
    expect(out['play.datathrough']).toMatchObject({ status: 'ok', value: Date.parse('2026-09-29T04:00:00Z') })
  })
  it('follows the date range: days outside it do not count, but data-through is not range-limited', async () => {
    const { out } = await run(seeded(), { since: '2026-09-26', until: '2026-09-27' })
    expect(out['play.deviceinstalls']).toMatchObject({ value: 8 })
    expect(out['play.activedeviceinstalls']).toMatchObject({ value: 52 })
    expect(out['play.datathrough']).toMatchObject({ value: Date.parse('2026-09-29T04:00:00Z') })
  })
  it('a range with no stored day, or only unreported days, has no figure (null), never a zero', async () => {
    const early = (await run(seeded(), { since: '2026-09-01', until: '2026-09-20' })).out
    const nullDay = (await run(seeded(), { since: '2026-09-28', until: '2026-09-28' })).out
    for (const out of [early, nullDay]) {
      expect(out['play.deviceinstalls']).toMatchObject({ status: 'no-data', value: null })
      expect(out['play.activedeviceinstalls']).toMatchObject({ value: null })
    }
  })
  it('reads the ads store only: one statement per distinct fact, none on the beacon database', async () => {
    const { plan } = await run(seeded(), { since: '2026-09-26', until: '2026-09-29' })
    expect(plan.facts.map((f) => f.id)).toEqual(['adsPlayDaily'])
    expect(plan.statements).toBe(1)
  })
})

describe('the Play tiles before the first sync (not yet active)', () => {
  const none = { status: 'no-data', value: null }
  it('a migrated but empty table is no figure', async () => {
    const { out } = await run(openMigratedSqlite(), { since: '2026-09-26', until: '2026-09-29' })
    for (const id of IDS) expect(out[id.toLowerCase()], id).toMatchObject(none)
  })
  it('a missing table (migration 0005 not applied yet) reads as empty, never an error', async () => {
    const { out } = await run('broken', { since: '2026-09-26', until: '2026-09-29' })
    for (const id of IDS) expect(out[id.toLowerCase()], id).toMatchObject(none)
  })
  it('any other read error is a per-metric error, not "no figures yet", and is not cached', async () => {
    const cache = memoryCache()
    const { out } = await run(throwingD1('D1_ERROR: network connection lost'), { since: '2026-09-26', until: '2026-09-29' }, cache)
    for (const id of IDS) {
      expect(out[id.toLowerCase()], id).toMatchObject({ status: 'error' })
      expect(out[id.toLowerCase()], id).not.toMatchObject({ status: 'no-data' })
    }
    expect(cache.keys()).toEqual([])
  })
  it('no ads binding at all reads as empty and costs no statement', async () => {
    const { out, plan } = await run(undefined, { since: '2026-09-26', until: '2026-09-29' })
    for (const id of IDS) expect(out[id.toLowerCase()], id).toMatchObject(none)
    expect(plan.statements).toBe(0)
  })
})
