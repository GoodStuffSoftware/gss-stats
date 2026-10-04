// Carry-over completions (retention spec S1) through the real /api/metrics handler on a real SQLite
// engine: whole-ET-day completions that carry no campaign tag, i.e. site-wide minus campaign-tagged.
// Counts only (Mike, 2026-10-03): the rows are completion rows, so the statement groups by ET day
// (plus the path / visitor kind / campaign columns every beacon fact carries) and reads no hour,
// place or device column; the result is whole-day totals with no clock time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { onRequestPost as metricsPost } from './metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'
import { buildFact } from '../../src/lib/metrics/engine'
import { etWallTimeMs } from '../../src/lib/etTime'
import { METRICS } from '../../src/lib/metrics/metrics'
import type { MetricsResponseBody } from '../../src/lib/metrics/types'

const Z = (iso: string) => Date.parse(iso)
const iso = (ms: number) => new Date(ms).toISOString()
const SITE = 'bestsudoku-web'
const DONE = '/game/complete/normal/easy'
// Three whole ET days (EDT): tagged and untagged on the 1st, NO tagged row on the 2nd, ONLY tagged on the 3rd.
// Binds of the two facts the carry-over metric reads (recorded; a change here means the bind budget moved).
const WORST_BINDS = { bskRangePath: 23, bskRangeDaily: 18 } as const
const D1 = '2026-10-01T15:00:00Z'
const D2 = '2026-10-02T15:00:00Z'
const D3 = '2026-10-03T15:00:00Z'
const SINCE = iso(etWallTimeMs('2026-10-01'))
const UNTIL = iso(etWallTimeMs('2026-10-04'))

let db: DatabaseSync
let undoCaches: () => void
beforeEach(() => {
  vi.useFakeTimers({ now: Z('2026-10-05T12:00:00Z'), toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
  db = openHitsDb()
  insertHits(db, [
    { ts: Z(D1), site: SITE, path: DONE, campaign: '', n: 5 },
    { ts: Z(D1), site: SITE, path: DONE, campaign: 'ad-a', n: 3 },
    { ts: Z(D1), site: SITE, path: DONE, campaign: 'ad-b', n: 2 },
    { ts: Z(D2), site: SITE, path: DONE, campaign: '', n: 4 },
    { ts: Z(D3), site: SITE, path: DONE, campaign: 'ad-a', n: 2 },
    // Not completions, and another site: never counted by either metric.
    { ts: Z(D1), site: SITE, path: '/game', campaign: '', n: 50 },
    { ts: Z(D1), site: 'other-site', path: DONE, campaign: '', n: 70 },
  ])
})
afterEach(() => {
  db.close()
  undoCaches()
  vi.useRealTimers()
})

async function read(series = true) {
  const waited: Promise<unknown>[] = []
  const requests = [
    { key: 'site', metric: 'bsk.completions', window: 'page', ...(series ? { series: 'daily' } : {}) },
    { key: 'carry', metric: 'bsk.carryOverCompletions', window: 'page', ...(series ? { series: 'daily' } : {}) },
  ]
  const res = await metricsPost(pagesContext(postJson('/api/metrics', { v: 1, context: { since: SINCE, until: UNTIL }, requests }), { gss_geo: sqliteD1(db) }, waited) as any)
  await Promise.all(waited)
  if (res.status !== 200) throw new Error(await res.text())
  return ((await res.json()) as MetricsResponseBody).results
}
const day = (r: any, d: string) => r.series.find((p: { day: string }) => p.day === d).value as number

describe('carry-over completions = site-wide minus campaign-tagged, per whole ET day', () => {
  it('subtracts the tagged rows from the site-wide completions on every day', async () => {
    const r = await read()
    expect(r.site.value).toBe(16)
    expect(r.carry.value).toBe(9) // 5 + 4 + 0
    expect(r.site.series).toEqual([
      { day: '2026-10-01', value: 10 },
      { day: '2026-10-02', value: 4 },
      { day: '2026-10-03', value: 2 },
    ])
    expect(r.carry.series).toEqual([
      { day: '2026-10-01', value: 5 },
      { day: '2026-10-02', value: 4 },
      { day: '2026-10-03', value: 0 },
    ])
  })

  it('a day with zero tagged rows carries over the whole site-wide count', async () => {
    const r = await read()
    expect(day(r.carry, '2026-10-02')).toBe(day(r.site, '2026-10-02'))
  })

  it('never goes negative: it is a count of rows, not a difference, and a tagged-only day reads 0', async () => {
    const r = await read()
    for (const p of r.carry.series!) {
      expect(p.value).toBeGreaterThanOrEqual(0)
      expect(p.value).toBeLessThanOrEqual(day(r.site, p.day))
    }
    expect(day(r.carry, '2026-10-03')).toBe(0)
  })

  it('any non-empty campaign tag is tagged (the shipped anyTag definition), registered or not', async () => {
    insertHits(db, [{ ts: Z(D2), site: SITE, path: DONE, campaign: 'not-a-registered-campaign', n: 6 }])
    const r = await read()
    expect(day(r.site, '2026-10-02')).toBe(10)
    expect(day(r.carry, '2026-10-02')).toBe(4)
  })

  it('reads the same total without a series request', async () => {
    expect((await read(false)).carry.value).toBe(9)
  })
})

describe('carry-over completions SQL: ET-day totals only, no split, no extra binds', () => {
  const FORBIDDEN = /\b(hour|country|region|city|colo|org|device|browser|os|lang|screenw|refpath|source|medium|id)\b/i
  const stmts = () => [
    buildFact({ id: 'bskRangeDaily', params: { since: SINCE, until: UNTIL } }, Date.now()),
    buildFact({ id: 'bskRangeDaily', params: { since: '2026-10-01T14:00:00.000Z', until: '2026-10-01T15:00:00.000Z' } }, Date.now()),
  ]

  it('the daily statement groups by ET day (with path, visitor kind and campaign), never by hour, place or device', () => {
    for (const s of stmts()) {
      expect(s.sql).toMatch(/GROUP BY dt, path, v, campaign$/)
      expect(s.sql).toMatch(/^SELECT .* AS dt, path, visitor AS v, campaign, COUNT\(\*\) AS c FROM hits WHERE /)
      const select = s.sql.slice(0, s.sql.indexOf(' FROM hits'))
      expect(select).not.toMatch(FORBIDDEN)
      expect(s.sql.slice(s.sql.indexOf('GROUP BY'))).not.toMatch(FORBIDDEN)
    }
  })

  it('the returned rows carry only dt, path, v, campaign and c: no id and no raw timestamp', () => {
    for (const s of stmts()) {
      const rows = db.prepare(s.sql).all(...(s.binds as any[])) as Record<string, unknown>[]
      for (const r of rows) expect(Object.keys(r).sort()).toEqual(['c', 'campaign', 'dt', 'path', 'v'])
    }
  })

  it('adds no SQL of its own: it reads the same facts as bsk.completions, so no bind per campaign and none new', () => {
    const own = METRICS.get('bsk.carryOverCompletions')!
    const base = METRICS.get('bsk.completions')!
    expect(own.windows).toEqual(base.windows)
    expect(own.params).toEqual(base.params)
    // Worst case with every filter set: one fact, its binds fixed by the (constant) refused-pattern list
    // and the site list, never by the campaign list. Well under D1's 100-bind limit.
    for (const id of ['bskRangePath', 'bskRangeDaily'] as const) {
      const sub = buildFact({ id, params: { since: '2026-10-01T14:00:00.000Z', until: '2026-10-01T15:00:00.000Z' } }, Date.now())
      const whole = buildFact({ id, params: { since: SINCE, until: UNTIL } }, Date.now())
      expect(Math.max(sub.binds.length, whole.binds.length)).toBeLessThan(100)
      expect(whole.binds.length).toBe(WORST_BINDS[id])
    }
  })
})
