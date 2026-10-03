// R-1d through the real handlers, on a real SQLite engine: /api/geo (every branch that keeps
// refused rows), /api/completions and the /api/metrics `page` window (facts.ts bskRangePath).
// A sub-day window counts return / start / completion / tutorial / tour-exit rows over whole ET
// days (the shipped 'nearest' snap, src/lib/splitGuard.ts) and every other row over the exact
// window, so three consecutive one-hour windows can never read back per-hour refused counts.
// ET-midnight bounds take the unchanged path: same SQL, binds and cache key as before R-1d.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { onRequestPost as geoPost } from './geo'
import { onRequestPost as completionsPost } from './completions'
import { onRequestPost as metricsPost } from './metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'
import { isSplitRefusedPath, REFUSED_WINDOW_KEY, REFUSED_WINDOW_SNAP } from '../../src/lib/splitGuard'
import { etWallTimeMs } from '../../src/lib/etTime'
import { buildFact } from '../../src/lib/metrics/engine'
import { siteWindowClause } from '../../src/lib/overview'
import { BEST_SUDOKU_SITES } from '../../src/lib/bestSudokuSites'
import type { MetricsResponseBody } from '../../src/lib/metrics/types'
import { METRICS } from '../../src/lib/metrics/metrics'

const Z = (iso: string) => Date.parse(iso)
const iso = (ms: number) => new Date(ms).toISOString()
const DAY = etWallTimeMs('2026-10-01') // 2026-10-01T04:00Z, a 24 h EDT day
const NEXT = etWallTimeMs('2026-10-02')
const SITE = 'bestsudoku-web'
// 10:00-11:00, 11:00-12:00 and 12:00-13:00 ET on 2026-10-01.
const HOURS: [string, string][] = [
  ['2026-10-01T14:00:00.000Z', '2026-10-01T15:00:00.000Z'],
  ['2026-10-01T15:00:00.000Z', '2026-10-01T16:00:00.000Z'],
  ['2026-10-01T16:00:00.000Z', '2026-10-01T17:00:00.000Z'],
]
// Per hour: refused rows of several patterns, completions, and ordinary /game views.
const PER_HOUR = [
  { at: '2026-10-01T14:30:00Z', other: { path: '/game/start/easy', n: 1 }, complete: 8, game: 10 },
  { at: '2026-10-01T15:30:00Z', other: { path: '/return/organic/d1', n: 2 }, complete: 16, game: 20 },
  { at: '2026-10-01T16:30:00Z', other: { path: '/tour/exit-at/3', n: 4 }, complete: 32, game: 40 },
]
const REFUSED_PER_HOUR = PER_HOUR.map((h) => h.other.n + h.complete) // [9, 18, 36]
const REFUSED_DAY = 63
const COMPLETE_DAY = 56

let db: DatabaseSync
let undoCaches: () => void
beforeEach(() => {
  vi.useFakeTimers({ now: Z('2026-10-05T12:00:00Z'), toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
  db = openHitsDb()
  for (const h of PER_HOUR) {
    insertHits(db, [
      { ts: Z(h.at), site: SITE, path: h.other.path, n: h.other.n },
      { ts: Z(h.at), site: SITE, path: '/game/complete/normal/easy', n: h.complete },
      { ts: Z(h.at), site: SITE, path: '/game', n: h.game },
    ])
  }
  // Refused rows on the neighbouring ET days: never counted for a window inside 2026-10-01.
  insertHits(db, [
    { ts: DAY - 60_000, site: SITE, path: '/game/complete/normal/easy', n: 100 },
    { ts: NEXT + 60_000, site: SITE, path: '/game/complete/normal/easy', n: 1000 },
  ])
})
afterEach(() => {
  db.close()
  undoCaches()
  vi.useRealTimers()
})

/** A D1 binding over the fixture that records every statement and its binds. */
function recordingD1() {
  const calls: { sql: string; binds: unknown[] }[] = []
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds })
          return { all: async () => ({ results: db.prepare(sql).all(...(binds as any[])) }) }
        },
      }
    },
  }
  return { d1: d1 as any, calls }
}

async function call(handler: (ctx: any) => Response | Promise<Response>, body: Record<string, unknown>) {
  const { d1, calls } = recordingD1()
  const keys: string[] = []
  const cache = { match: async (r: Request) => (keys.push(r.url), undefined), put: async () => {} }
  ;(globalThis as any).caches = { default: cache }
  const res = await handler({ request: { json: async () => body }, env: { gss_geo: d1 }, waitUntil: () => {} })
  return { body: (await res.json()) as any, calls, cacheKey: keys[0] }
}
const geo = (body: Record<string, unknown>) => call(geoPost, { dimension: 'path', includeEventBeacons: true, ...body })
const completions = (body: Record<string, unknown>) => call(completionsPost, body)
const refusedOf = (rows: any[]) => rows.filter((r) => isSplitRefusedPath(String(r.key.path))).reduce((a, r) => a + r.pageviews, 0)
const gameOf = (rows: any[]) => rows.filter((r) => r.key.path === '/game').reduce((a, r) => a + r.pageviews, 0)

async function metrics(since: string, until: string) {
  const waited: Promise<unknown>[] = []
  const requests = [
    { key: 'completions', metric: 'bsk.completions', window: 'page' },
    { key: 'game_views', metric: 'bsk.gameViews', window: 'page' },
    { key: 'pageviews', metric: 'bsk.pageviews', window: 'page' },
  ]
  const res = await metricsPost(pagesContext(postJson('/api/metrics', { v: 1, context: { since, until }, requests }), { gss_geo: sqliteD1(db) }, waited) as any)
  await Promise.all(waited)
  if (res.status !== 200) throw new Error(await res.text())
  return ((await res.json()) as MetricsResponseBody).results
}

describe('the 3 x 1 h probe: consecutive hour windows never read back per-hour refused counts', () => {
  it('/api/geo: refused rows 0 / whole day / 0 under nearest; /game views stay exact per hour', async () => {
    const refused: number[] = []
    for (const [since, until] of HOURS) {
      const { body } = await geo({ since, until })
      refused.push(refusedOf(body.rows))
      expect(body.meta.refusedWholeDays).toBe(true)
    }
    expect(refused).not.toEqual(REFUSED_PER_HOUR)
    // 10-11 ET snaps to an empty window, 11-12 ET ties at noon to the whole day, 12-13 ET is empty.
    expect(refused).toEqual([0, REFUSED_DAY, 0])
    for (let i = 0; i < 3; i++) expect(gameOf((await geo({ since: HOURS[i][0], until: HOURS[i][1] })).body.rows)).toBe(PER_HOUR[i].game)
  })

  it('/api/geo ring branch: the same snap', async () => {
    const out: number[] = []
    for (const [since, until] of HOURS) {
      const { body } = await geo({ dimension: 'path', breakdown: 'dateEt', dims: ['path', 'dateEt'], since, until })
      out.push(body.rows.filter((r: any) => isSplitRefusedPath(String(r.key.path))).reduce((a: number, r: any) => a + r.pageviews, 0))
      expect(body.meta.refusedWholeDays).toBe(true)
    }
    expect(out).toEqual([0, REFUSED_DAY, 0])
  })

  it('/api/completions: 0 / whole day / 0', async () => {
    const totals: number[] = []
    for (const [since, until] of HOURS) {
      const { body } = await completions({ since, until })
      totals.push(body.totals.pageviews)
      expect(body.meta.refusedWholeDays).toBe(true)
    }
    expect(totals).not.toEqual(PER_HOUR.map((h) => h.complete))
    expect(totals).toEqual([0, COMPLETE_DAY, 0])
  })

  it('/api/metrics page window: completions 0 / whole day / 0, game views exact, with the note', async () => {
    const got = []
    for (const [since, until] of HOURS) got.push(await metrics(since, until))
    expect(got.map((r) => r.completions.value)).toEqual([0, COMPLETE_DAY, 0])
    expect(got.map((r) => r.game_views.value)).toEqual(PER_HOUR.map((h) => h.game))
    for (const r of got) {
      expect(r.completions.noteIds).toContain('refused-whole-days')
      expect(r.pageviews.noteIds).toContain('refused-whole-days') // counts /game/start/ rows
      expect(r.game_views.noteIds ?? []).not.toContain('refused-whole-days') // can't count a refused row
    }
  })
})

// MUST-1 (review of #63): the note follows MetricDef.countsRefused, never a sampled path. The
// old one-sample-per-pattern check left it off tutorial replays, the three tour-exit steps and
// d1+ returns, all of which count refused rows; this list is the whole answer for today's registry.
const REFUSED_NOTE_METRICS = [
  'bsk.pageviews', // !isEventPath: counts /game/start/ rows
  'bsk.taggedArrivals', // no path test: any first-ever beacon, refused ones included
  'bsk.completions',
  'bsk.tutorialFirstRun',
  'bsk.tutorialReplay',
  'bsk.tourExitPreamble',
  'bsk.tourExitHub',
  'bsk.tourExitSection',
  'bsk.returnsD1plus',
].sort()

describe('the refused-whole-days note on every bskRangePath metric', () => {
  const pageMetrics = [...METRICS.values()].filter((d) => d.windows.page === 'bskRangePath' && d.params.length === 0)
  it('a sub-day page window notes exactly the metrics that can count a refused row', async () => {
    // After every go-live these metrics carry (tour tracking 2026-10-03T17:03:40Z), so none is unmeasured.
    const requests = pageMetrics.map((d) => ({ key: d.id.toLowerCase(), metric: d.id, window: 'page' }))
    const waited: Promise<unknown>[] = []
    const res = await metricsPost(pagesContext(postJson('/api/metrics', { v: 1, context: { since: '2026-10-04T14:00:00.000Z', until: '2026-10-04T15:00:00.000Z' }, requests }), { gss_geo: sqliteD1(db) }, waited) as any)
    await Promise.all(waited)
    expect(res.status, await res.clone().text()).toBe(200)
    const results = ((await res.json()) as MetricsResponseBody).results
    const noted: string[] = []
    for (const r of requests) {
      const v = results[r.key]
      expect(['ok', 'partial'], `${r.metric}: ${v.status} ${v.reason ?? ''}`).toContain(v.status)
      if ((v.noteIds ?? []).includes('refused-whole-days')) noted.push(r.metric)
    }
    expect(noted.sort()).toEqual(REFUSED_NOTE_METRICS)
  })
  it('no note on an ET-midnight page window', async () => {
    const requests = pageMetrics.map((d) => ({ key: d.id.toLowerCase(), metric: d.id, window: 'page' }))
    const waited: Promise<unknown>[] = []
    const res = await metricsPost(pagesContext(postJson('/api/metrics', { v: 1, context: { since: iso(etWallTimeMs('2026-10-04')), until: iso(etWallTimeMs('2026-10-05')) }, requests }), { gss_geo: sqliteD1(db) }, waited) as any)
    await Promise.all(waited)
    const results = ((await res.json()) as MetricsResponseBody).results
    for (const r of requests) expect(results[r.key].noteIds ?? [], r.metric).not.toContain('refused-whole-days')
  })
})

describe('every window inside one ET day returns the whole-day refused count or zero', () => {
  // Half-hour grid over 2026-10-01 ET, skipping the whole day itself.
  const windows: [number, number][] = []
  for (let a = 0; a < 48; a += 3) for (let b = a + 2; b <= 48; b += 5) if (!(a === 0 && b === 48)) windows.push([DAY + a * 1_800_000, DAY + b * 1_800_000])
  it('/api/geo and /api/completions', async () => {
    for (const [s, u] of windows) {
      const g = await geo({ since: iso(s), until: iso(u) })
      expect([0, REFUSED_DAY], `${iso(s)} ${iso(u)}`).toContain(refusedOf(g.body.rows))
      const c = await completions({ since: iso(s), until: iso(u) })
      expect([0, COMPLETE_DAY], `${iso(s)} ${iso(u)}`).toContain(c.body.totals.pageviews)
    }
  })
})

describe('ET-midnight bounds take the unchanged path', () => {
  const since = iso(DAY)
  const until = iso(NEXT)

  it('/api/geo: no snap term, the request binds, no new cache-key field, no caption flag', async () => {
    const aligned = await geo({ since, until })
    expect(refusedOf(aligned.body.rows)).toBe(REFUSED_DAY)
    expect(aligned.body.meta.refusedWholeDays).toBeUndefined()
    expect(aligned.cacheKey).not.toContain('refusedWindow')
    expect(aligned.calls[0].sql).not.toContain('CASE WHEN (path LIKE')
    expect(aligned.calls[0].sql).not.toContain('NOT (path LIKE')
    expect(aligned.calls[0].binds.slice(0, 2)).toEqual([DAY, NEXT])
    // A sub-day request differs from it only by the snap term and the outer pair.
    const sub = await geo({ since: iso(DAY + 3_600_000), until: iso(NEXT - 3_600_000) })
    expect(decodeURIComponent(sub.cacheKey)).toContain(`"refusedWindow":"${REFUSED_WINDOW_KEY}"`)
    const term = / AND \(CASE WHEN \(path LIKE [^]*? END\)/
    expect(sub.calls[0].sql).toMatch(term)
    expect(sub.calls[0].sql.replace(term, '')).toBe(aligned.calls[0].sql)
    expect(sub.calls[0].binds).toEqual(aligned.calls[0].binds) // outer pair = the whole day here
  })

  it('/api/geo: bare dates are UTC days, so they snap (nearest: to the same-date ET days)', async () => {
    const { body, cacheKey } = await geo({ since: '2026-10-01', until: '2026-10-01' })
    expect(body.meta.refusedWholeDays).toBe(true)
    expect(cacheKey).toContain(REFUSED_WINDOW_SNAP)
    expect(refusedOf(body.rows)).toBe(REFUSED_DAY)
  })

  it('/api/completions: the pre-R-1d statement, binds and key', async () => {
    const r = await completions({ since, until })
    expect(r.body.totals.pageviews).toBe(COMPLETE_DAY)
    expect(r.body.meta.refusedWholeDays).toBeUndefined()
    expect(r.calls[0]).toEqual({ sql: "SELECT path, COUNT(*) AS c FROM hits WHERE ts >= ? AND ts < ? AND path LIKE '/game/complete/%' GROUP BY path", binds: [DAY, NEXT] })
    expect(r.cacheKey).not.toContain('refusedWindow')
    const sub = await completions({ since: iso(DAY + 1), until })
    expect(decodeURIComponent(sub.cacheKey)).toContain(`"refusedWindow":"${REFUSED_WINDOW_KEY}"`)
  })

  it('bskRangePath: the pre-R-1d WHERE, for ET-midnight datetimes and bare ET dates', () => {
    const clause = siteWindowClause(BEST_SUDOKU_SITES, DAY, NEXT)
    for (const p of [{ since, until }, { since: '2026-10-01', until: '2026-10-01' }]) {
      const stmt = buildFact({ id: 'bskRangePath', params: p }, Date.now())
      expect(stmt.sql.endsWith(`WHERE ${clause.sql} GROUP BY s, path, visitor, campaign`)).toBe(true)
      expect(stmt.binds.slice(-clause.binds.length)).toEqual(clause.binds)
      expect(stmt.sql).not.toContain('CASE WHEN (path LIKE')
    }
  })

  it('/api/metrics page window: whole-day values and no note', async () => {
    const r = await metrics(since, until)
    expect(r.completions.value).toBe(COMPLETE_DAY)
    expect(r.game_views.value).toBe(70)
    expect(r.completions.noteIds ?? []).not.toContain('refused-whole-days')
  })
})

describe('bind ceiling', () => {
  // The heaviest shape that keeps refused rows (so the snap applies): a five-dim ring with no
  // refused dim, 16 campaignFlight filters, 50 sites and both hides, on a sub-day window. The
  // R-1b worst cases (81 / 91 / 96 / 97, geo.derivedDims.test.ts) all carry a device dim, so the
  // split guard drops refused rows there and the snap never runs.
  const shape = {
    dimension: 'referrer',
    breakdown: 'campaignFlight',
    dims: ['referrer', 'campaignFlight', 'gameMode', 'popupFamily', 'flightDay'],
    constraints: Array.from({ length: 16 }, (_, i) => ({ field: 'campaignFlight', value: `flight-${i}` })),
    sites: Array.from({ length: 50 }, (_, i) => `s${i}`),
    excludeOwnVisits: true,
    ownBrowser: 'Opera',
    ownOS: 'Windows',
    excludeKnownTraffic: true,
    includeEventBeacons: false,
  }
  it('the snap adds no binds: the worst snapped shape binds exactly what its aligned twin does, under 100', async () => {
    const sub = await geo({ ...shape, since: HOURS[1][0], until: HOURS[1][1] })
    const aligned = await geo({ ...shape, since: iso(DAY), until: iso(NEXT) })
    expect(sub.body.error).toBeUndefined()
    expect(sub.body.meta.refusedWholeDays).toBe(true)
    expect(sub.calls).toHaveLength(1)
    expect(sub.calls[0].sql).toContain('CASE WHEN (path LIKE')
    expect(sub.calls[0].binds.length).toBe(aligned.calls[0].binds.length)
    expect(sub.calls[0].binds.length).toBeLessThan(100)
    expect(sub.calls[0].binds.length).toBe(97) // measured
  })
})
