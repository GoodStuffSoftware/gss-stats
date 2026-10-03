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
import { isSplitRefusedPath, reachableRefusedPatterns, REFUSED_WINDOW_KEY, REFUSED_WINDOW_SNAP, refusedPathMatch, SPLIT_REFUSED_PATH_PATTERNS } from '../../src/lib/splitGuard'
import { etDateSql, etWallTimeMs } from '../../src/lib/etTime'
import { buildFact } from '../../src/lib/metrics/engine'
import { FACTS, type FactId, type FactParams } from '../../src/lib/metrics/facts'
import { excludeInstallGapUnmeasured } from '../../src/lib/popupEvents'
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
    // One Best Sudoku site, so the query can count a refused row and carries the caption flag.
    sites: [SITE, ...Array.from({ length: 49 }, (_, i) => `s${i}`)],
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

// SHOULD-3 (review of #63): /api/geo sets meta.refusedWholeDays (the caption) only when the
// snapped query can count a refused row. The snap itself and its cache-key marker still follow
// the window alone, so the SQL, binds and cache key of every case below are unchanged by it.
describe('the whole-days caption flag needs a refused row the geo query can count', () => {
  const [since, until] = HOURS[1] // 11-12 ET: snaps to the whole of 2026-10-01
  const snapped = (r: Awaited<ReturnType<typeof geo>>) => {
    expect(r.body.error).toBeUndefined()
    expect(r.calls[0].sql).toContain('CASE WHEN (path LIKE')
    expect(decodeURIComponent(r.cacheKey)).toContain(`"refusedWindow":"${REFUSED_WINDOW_KEY}"`)
  }
  const refusedPaths = (rows: any[]) => [...new Set(rows.map((r) => String(r.key.path)).filter(isSplitRefusedPath))].sort()

  it('shown: a Best Sudoku sub-day query with event beacons counts every refused kind', async () => {
    const r = await geo({ since, until, sites: [SITE] })
    snapped(r)
    expect(refusedOf(r.body.rows)).toBe(REFUSED_DAY)
    expect(r.body.meta.refusedWholeDays).toBe(true)
  })

  it('hidden: the default chart (no event beacons) counts no refused row, game starts being event beacons too', async () => {
    const r = await geo({ since, until, includeEventBeacons: false })
    snapped(r)
    expect(refusedPaths(r.body.rows)).toEqual([])
    expect(r.body.meta.refusedWholeDays).toBeUndefined()
  })

  it('shown: an exclusion-lifting event dim counts event rows even without the opt-in', async () => {
    const r = await geo({ dimension: 'gameMode', since, until, includeEventBeacons: false })
    snapped(r)
    expect(r.body.meta.refusedWholeDays).toBe(true)
  })

  // NIT-A (re-review of #63): the site list and a site drill are not narrowing rules any more. A
  // non-Best-Sudoku site that sent a refused-shaped row would be counted over whole days, so the
  // caption errs toward showing like every other filter it cannot reason about.
  it('shown: a site that is not Best Sudoku (the caption errs toward showing)', async () => {
    const r = await geo({ since, until, sites: ['starrupture'] })
    snapped(r)
    expect(r.body.rows).toEqual([])
    expect(r.body.meta.refusedWholeDays).toBe(true)
  })

  it('shown: a site drill that is not Best Sudoku', async () => {
    const r = await geo({ since, until, constraints: [{ field: 'site', value: 'starrupture' }] })
    snapped(r)
    expect(r.body.meta.refusedWholeDays).toBe(true)
  })

  it('hidden: a /home path filter; shown again for a refused path, unless event beacons leave it out', async () => {
    const home = await geo({ since, until, constraints: [{ field: 'path', value: '/home' }] })
    snapped(home)
    expect(home.body.meta.refusedWholeDays).toBeUndefined()
    const ret = await geo({ since, until, constraints: [{ field: 'path', value: '/return/organic/d1' }] })
    expect(refusedOf(ret.body.rows)).toBe(2)
    expect(ret.body.meta.refusedWholeDays).toBe(true)
    const retNoEvents = await geo({ since, until, includeEventBeacons: false, constraints: [{ field: 'path', value: '/return/organic/d1' }] })
    snapped(retNoEvents)
    expect(retNoEvents.body.rows).toEqual([])
    expect(retNoEvents.body.meta.refusedWholeDays).toBeUndefined()
  })

  it('hidden: a pathFamily filter no refused kind belongs to; shown for one it does', async () => {
    const install = await geo({ since, until, constraints: [{ field: 'pathFamily', value: 'install' }] })
    snapped(install)
    expect(install.body.meta.refusedWholeDays).toBeUndefined()
    for (const family of ['return', 'game-complete', 'tour', 'game-start']) {
      const r = await geo({ since, until, constraints: [{ field: 'pathFamily', value: family }] })
      expect(r.body.meta.refusedWholeDays, family).toBe(true)
    }
  })

  it('reachableRefusedPatterns: the static rules', () => {
    const all = { eventRowsExcluded: false, constraints: [] }
    expect(reachableRefusedPatterns(all)).toEqual([...SPLIT_REFUSED_PATH_PATTERNS])
    expect(reachableRefusedPatterns({ ...all, eventRowsExcluded: true })).toEqual([])
    // A site drill is not a narrowing rule: a non-Best-Sudoku site keeps every pattern reachable.
    expect(reachableRefusedPatterns({ ...all, constraints: [{ field: 'site', value: 'starrupture' }] })).toEqual([...SPLIT_REFUSED_PATH_PATTERNS])
    expect(reachableRefusedPatterns({ ...all, constraints: [{ field: 'path', value: '/RETURN/x/d0' }] })).toEqual(['/return/%'])
    expect(reachableRefusedPatterns({ ...all, constraints: [{ field: 'path', value: '(direct)' }] })).toEqual([])
    const family = (value: string) => reachableRefusedPatterns({ ...all, constraints: [{ field: 'pathFamily', value }] })
    expect(family('page')).toEqual([])
    expect(family('game-start')).toEqual(['/game/start/%'])
    expect(family('tour')).toEqual(['/tour/exit-at/%'])
    expect(family('tutorial-complete')).toEqual(['/game/tutorial-complete/%'])
    expect(family('game-complete-deferred')).toEqual(['/game/complete-deferred/%'])
    expect(family('auth-error')).toEqual([])
    // Other filters leave every pattern reachable (erring toward showing the caption).
    expect(reachableRefusedPatterns({ ...all, constraints: [{ field: 'referrer', value: 'x' }] })).toEqual([...SPLIT_REFUSED_PATH_PATTERNS])
  })
})

// The daily twins main brought in with ADR 0005 slice 2 (sparkline series). bskRangeDaily reads
// bskRangePath's caller-picked range, so it snaps refused rows the same way: a sub-day range
// counts them over whole ET days, and an ET-midnight range builds main's statement unchanged.
// popupRangeDaily, like its scalar popupRangePath, leaves refused rows out altogether.
describe('the daily twins follow the same rule', () => {
  /** main's bskRangeDaily statement (before the twin took the snap). */
  const mainBskRangeDaily = (startMs: number, endMs: number) => {
    const clause = siteWindowClause(BEST_SUDOKU_SITES, startMs, endMs)
    return { sql: `SELECT ${etDateSql()} AS dt, path, visitor AS v, campaign, COUNT(*) AS c FROM hits WHERE ${clause.sql} GROUP BY dt, path, v, campaign`, binds: clause.binds }
  }
  const run = (id: FactId, params: FactParams) => {
    const stmt = buildFact({ id, params }, Date.now())
    const rows = db.prepare(stmt.sql).all(...(stmt.binds as any[])) as { dt: string; path: string; c: number }[]
    return { stmt, rows }
  }
  const refusedRows = <R extends { path: string }>(rows: R[]) => rows.filter((r) => isSplitRefusedPath(r.path))
  const sum = (rows: { c: number }[]) => rows.reduce((a, r) => a + Number(r.c), 0)

  async function metricSeries(since: string, until: string) {
    const waited: Promise<unknown>[] = []
    const requests = [
      { key: 'completions', metric: 'bsk.completions', window: 'page', series: 'daily' },
      { key: 'game_views', metric: 'bsk.gameViews', window: 'page', series: 'daily' },
    ]
    const res = await metricsPost(pagesContext(postJson('/api/metrics', { v: 1, context: { since, until }, requests }), { gss_geo: sqliteD1(db) }, waited) as any)
    await Promise.all(waited)
    if (res.status !== 200) throw new Error(await res.text())
    return ((await res.json()) as MetricsResponseBody).results
  }

  it('bskRangeDaily, 3 x 1 h: refused rows 0 / whole day / 0 on the ET day; /game exact per hour', () => {
    const got = HOURS.map(([since, until]) => run('bskRangeDaily', { since, until }))
    expect(got.map((g) => sum(refusedRows(g.rows)))).not.toEqual(REFUSED_PER_HOUR)
    expect(got.map((g) => sum(refusedRows(g.rows)))).toEqual([0, REFUSED_DAY, 0])
    for (const g of got) for (const r of refusedRows(g.rows)) expect(r.dt).toBe('2026-10-01')
    expect(got.map((g) => sum(g.rows.filter((r) => r.path === '/game')))).toEqual(PER_HOUR.map((h) => h.game))
    // nearest: 10-11 ET snaps to an empty refused window (NOT match), 11-12 ET to the whole day (CASE).
    const m = refusedPathMatch().sql
    expect(got.map((g) => g.stmt.sql.includes(`CASE WHEN ${m}`))).toEqual([false, true, false])
    expect(got.map((g) => g.stmt.sql.includes(`NOT ${m}`))).toEqual([true, false, true])
  })

  it('bskRangeDaily: every window inside one ET day reads the whole-day refused count or zero', () => {
    for (let a = 0; a < 48; a += 3) {
      for (let b = a + 2; b <= 48; b += 5) {
        if (a === 0 && b === 48) continue
        const [s, u] = [iso(DAY + a * 1_800_000), iso(DAY + b * 1_800_000)]
        expect([0, REFUSED_DAY], `${s} ${u}`).toContain(sum(refusedRows(run('bskRangeDaily', { since: s, until: u }).rows)))
      }
    }
  })

  it('bskRangeDaily: an ET-midnight range builds the statement and binds main built, and they bind', () => {
    for (const p of [{ since: iso(DAY), until: iso(NEXT) }, { since: '2026-10-01', until: '2026-10-01' }]) {
      const { stmt, rows } = run('bskRangeDaily', p)
      expect(stmt).toEqual({ db: 'gss_geo', ...mainBskRangeDaily(DAY, NEXT) })
      expect(sum(refusedRows(rows))).toBe(REFUSED_DAY)
    }
  })

  it('/api/metrics series: the sparkline day matches its tile, with the note', async () => {
    const got = []
    for (const [since, until] of HOURS) got.push(await metricSeries(since, until))
    expect(got.map((r) => r.completions.series)).toEqual([0, COMPLETE_DAY, 0].map((value) => [{ day: '2026-10-01', value }]))
    expect(got.map((r) => r.completions.value)).toEqual([0, COMPLETE_DAY, 0])
    expect(got.map((r) => r.game_views.series)).toEqual(PER_HOUR.map((h) => [{ day: '2026-10-01', value: h.game }]))
    for (const r of got) {
      expect(r.completions.noteIds).toContain('refused-whole-days')
      expect(r.game_views.noteIds ?? []).not.toContain('refused-whole-days')
    }
    const aligned = await metricSeries(iso(DAY), iso(NEXT))
    expect(aligned.completions.series).toEqual([{ day: '2026-10-01', value: COMPLETE_DAY }])
    expect(aligned.completions.noteIds ?? []).not.toContain('refused-whole-days')
  })

  it('popupRangeDaily: no refused row on any range, pop-up rows exact, and the exclusion adds no bind', () => {
    insertHits(db, [{ ts: Z('2026-10-01T15:30:00Z'), site: SITE, path: '/signin-prompt/shown', n: 3 }])
    const sites = [SITE]
    const gap: unknown[] = []
    excludeInstallGapUnmeasured([], gap)
    for (const [since, until] of [...HOURS, [iso(DAY), iso(NEXT)]]) {
      const { stmt, rows } = run('popupRangeDaily', { since, until, sites })
      expect(stmt.sql).toContain(`NOT ${refusedPathMatch().sql}`)
      expect(refusedRows(rows)).toEqual([])
      expect(stmt.binds).toEqual([Date.parse(since), Date.parse(until), ...sites, ...gap])
    }
    expect(sum(run('popupRangeDaily', { since: HOURS[1][0], until: HOURS[1][1], sites }).rows)).toBe(3)
    expect(sum(run('popupRangeDaily', { since: HOURS[0][0], until: HOURS[0][1], sites }).rows)).toBe(0)
  })

  it('every fact over a caller-picked range snaps refused rows or leaves them out', () => {
    const ranged = (Object.keys(FACTS) as FactId[]).filter((id) => FACTS[id].honors.includes('range'))
    expect(ranged.sort()).toEqual(['bskRangeDaily', 'bskRangePath', 'popupRangeDaily', 'popupRangePath'])
    const m = refusedPathMatch().sql
    for (const id of ranged) {
      const sql = buildFact({ id, params: { since: HOURS[1][0], until: HOURS[1][1], sites: [] } }, Date.now()).sql
      expect(sql.includes(`CASE WHEN ${m}`) || sql.includes(`NOT ${m}`), id).toBe(true)
    }
  })

  it('bind ceiling: the snap adds no bind to either twin; the worst ranged metrics statement stays under 100', () => {
    const sub = { since: HOURS[1][0], until: HOURS[1][1] }
    const whole = { since: iso(DAY), until: iso(NEXT) }
    const b = (id: FactId, p: FactParams) => buildFact({ id, params: p }, Date.now()).binds.length
    expect(b('bskRangeDaily', sub)).toBe(b('bskRangeDaily', whole))
    expect(b('bskRangeDaily', sub)).toBe(mainBskRangeDaily(DAY, NEXT).binds.length)
    // The heaviest daily twin: 50 sites (MAX_SITES) and both hides.
    const heavy = { sites: Array.from({ length: 50 }, (_, i) => `s${String(i).padStart(2, '0')}`), ownBrowser: 'Opera', ownOS: 'Windows' }
    expect(b('popupRangeDaily', { ...sub, ...heavy })).toBe(b('popupRangeDaily', { ...whole, ...heavy }))
    const ranged = (Object.keys(FACTS) as FactId[]).filter((id) => FACTS[id].honors.includes('range'))
    const worst = Math.max(...ranged.map((id) => b(id, { ...sub, ...heavy })))
    expect(worst).toBeLessThan(100)
    expect(worst).toBe(58) // measured: popupRangePath (popupRangeDaily 57, bskRangePath 23, bskRangeDaily 18)
    expect(b('popupRangeDaily', { ...sub, ...heavy })).toBe(57) // measured: 2 + 50 sites + 2 hides + 3 install-gap
  })
})
