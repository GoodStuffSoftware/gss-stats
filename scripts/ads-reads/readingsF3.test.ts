// Migration 0006 (ads_readings.f3): the flight 3 rules block of a daily reading, stored and served.
// Against a REAL SQLite with every migration applied: the column (nullable TEXT, JSON-checked), the
// store round trip (insert -> readReadings), the GET /api/ads/readings shape, rows without the
// field (F2 / retest / pre-0006), and a malformed value that never reaches a card. The F2 /
// retest morning read stores no f3. No network, no credential.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { ReadingF3, ReadingRecord } from '../../src/lib/adsRules'
import { createSqlAdsStore, mapReadingRow, parseReadingF3, readingInsert, readReadings } from '../../src/lib/adsStore'
import { campaignById } from '../../src/lib/campaigns'
import { MIN_COHORT } from '../../src/lib/popupEvents'
import { fixtureDeps, type Fixture } from './cli'
import { runMorningRead } from './read'
import { migrationFiles, openMigratedSqlite, sqliteAdsDb, sqliteD1 } from './sqliteDb'

const here = path.dirname(fileURLToPath(import.meta.url))
// The Pages Function, loaded at run time: a static import would pull @cloudflare/workers-types into
// this Node-typed project (typecheck:scripts), whose Buffer and Response types then clash.
const ENDPOINT = '../../functions/api/ads/readings'
const endpoint = async () => (await import(/* @vite-ignore */ ENDPOINT)) as { onRequestGet: (ctx: unknown) => Promise<Response> }
const APPS = '24358792494'
const RETEST = '24279250691'

const F3: ReadingF3 = {
  v: 1,
  arm: 'apps',
  flightDay: 2,
  readouts: [
    { n: 1, name: 'Placement leak', number: '$0.40 on 1 placement', threshold: 'under $2 on any one', verdict: 'PASS' },
    { n: 2, name: 'CTR', number: '0.21%', threshold: 'at least 0.30%', verdict: 'PROPOSE PAUSE' },
    { n: 5, name: 'Tracking check', number: 'day 2', threshold: null, verdict: 'NOT YET' },
  ],
  proposal: 'PROPOSE PAUSE',
}
const rec = (over: Partial<ReadingRecord> = {}): ReadingRecord => ({
  v: 1,
  id: `daily:${APPS}:2026-10-19T12:05:00.000Z`,
  campaignId: APPS,
  kind: 'daily',
  readAt: '2026-10-19T12:05:00.000Z',
  etDate: '2026-10-19',
  spendThroughEt: '2026-10-18',
  cumulativeSpend: 18.4,
  thresholds: [],
  complete: true,
  rules: null,
  proposal: 'PROPOSE PAUSE',
  decision: null,
  counts: {},
  notes: [],
  ...over,
})
async function seeded(records: ReadingRecord[]) {
  const sqlite = openMigratedSqlite()
  const store = createSqlAdsStore(sqliteAdsDb(sqlite), { dryRun: false, kind: 'sqlite' })
  await store.syncCampaigns([campaignById(APPS)!, campaignById(RETEST)!], 'x')
  await store.appendReadings(records)
  return sqlite
}

describe('migration 0006 (ads_readings.f3)', () => {
  it('is applied in order and adds one nullable TEXT column that only takes JSON', async () => {
    expect(migrationFiles()).toContain('0006_readings_f3.sql')
    const sqlite = await seeded([])
    const col = (sqlite.prepare('PRAGMA table_info(ads_readings)').all() as { name: string; type: string; notnull: number; dflt_value: unknown }[]).find((c) => c.name === 'f3')
    expect(col).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
    const st = readingInsert(rec())
    const bad = [...st.binds]
    bad[bad.length - 1] = '{not json'
    expect(() => sqlite.prepare(st.sql).run(...(bad as (string | number | null)[]))).toThrow(/CHECK/)
  })
  it('an older writer (no f3 in its INSERT) still appends, and the row reads back without f3', async () => {
    const sqlite = await seeded([])
    const st = readingInsert(rec())
    const old = st.sql.replace(', f3)', ')').replace(', ?) ON CONFLICT', ') ON CONFLICT')
    sqlite.prepare(old).run(...(st.binds.slice(0, -1) as (string | number | null)[]))
    const [r] = (await readReadings(sqliteD1(sqlite) as never, APPS))!
    expect(r.id).toBe(rec().id)
    expect('f3' in r).toBe(false)
  })
})

describe('the f3 round trip', () => {
  it('stores the block and reads it back unchanged; a row without one has no f3 key', async () => {
    const plain = rec({ id: `daily:${RETEST}:2026-10-19T12:05:00.000Z`, campaignId: RETEST, proposal: null })
    const sqlite = await seeded([rec({ f3: F3 }), plain])
    expect((sqlite.prepare('SELECT f3 FROM ads_readings ORDER BY id').all() as { f3: string | null }[]).map((r) => r.f3)).toEqual([JSON.stringify(F3), null])
    const [apps] = (await readReadings(sqliteD1(sqlite) as never, APPS))!
    expect(apps.f3).toEqual(F3)
    const [retest] = (await readReadings(sqliteD1(sqlite) as never, RETEST))!
    expect('f3' in retest).toBe(false)
  })
  it('a malformed stored value never reaches a card', () => {
    const row = { reading_key: 'k', campaign_id: APPS, kind: 'daily', read_at: '2026-10-19T12:05:00.000Z', et_date: '2026-10-19', complete: 1, counts: '{}', notes: '[]' }
    expect(mapReadingRow({ ...row, f3: JSON.stringify(F3) })!.f3).toEqual(F3)
    for (const f3 of ['{broken', '[]', '"x"', JSON.stringify({ ...F3, arm: 'display' }), JSON.stringify({ ...F3, readouts: [{ ...F3.readouts[0], verdict: 'MAYBE' }] }), JSON.stringify({ ...F3, readouts: 'x' })])
      expect('f3' in mapReadingRow({ ...row, f3 })!).toBe(false)
    expect(parseReadingF3({ ...F3, proposal: 'SCALE UP' })!.proposal).toBeNull()
  })
})

describe('GET /api/ads/readings', () => {
  it('serves the stored block on the reading, and none on a non-F3 campaign', async () => {
    const sqlite = await seeded([rec({ f3: F3 }), rec({ id: `daily:${RETEST}:x`, campaignId: RETEST, proposal: null })])
    const { onRequestGet } = await endpoint()
    const res = await onRequestGet({ request: new Request(`https://stats.example/api/ads/readings?campaignId=${APPS}&campaignId=${RETEST}&limit=5`), env: { gss_stats_ads: sqliteD1(sqlite) } })
    const body = (await res.json()) as { campaigns: { campaignId: string; readings: Record<string, unknown>[] }[] }
    const by = Object.fromEntries(body.campaigns.map((c) => [c.campaignId, c.readings]))
    expect(by[APPS][0]).toMatchObject({ kind: 'daily', etDate: '2026-10-19', proposal: 'PROPOSE PAUSE', f3: F3 })
    expect(by[RETEST][0]).not.toHaveProperty('f3')
  })
})

describe('the retest (F2-era) morning read', () => {
  it('stores no f3 on any of its readings', async () => {
    const fx = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8')) as Fixture
    const deps = fixtureDeps(fx, false)
    const append = vi.spyOn(deps.store, 'appendReadings')
    await runMorningRead(deps, { campaignId: RETEST, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 })
    const written = append.mock.calls.flatMap((c) => c[0] as ReadingRecord[])
    expect(written.some((r) => r.kind === 'daily')).toBe(true)
    for (const r of written) expect(r).not.toHaveProperty('f3')
  })
})
