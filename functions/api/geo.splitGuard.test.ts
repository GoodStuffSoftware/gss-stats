// The counts-only split guard (src/lib/splitGuard.ts) through the real onRequestPost handler,
// on a REAL SQLite engine (node:sqlite, the dialect D1 speaks), the same way
// geo.derivedDims.test.ts runs it. Each trigger (points mode, a refused single dim, a refused
// ring dim, a drill on a refused field) must drop return / game-start / completion / tutorial-
// completion / tour-skip / tour-exit rows and nothing else; a query with no trigger must count exactly what it counted before.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { onRequestPost, GEO_DIMS } from './geo'
import type { CacheLike } from '../_lib/edgeCache'
import { SPLIT_REFUSED_DIMS, SPLIT_REFUSED_PATH_PATTERNS, refusedPathExcludeClause, splitRefused, isSplitRefusedPath } from '../../src/lib/splitGuard'

const noopCache: CacheLike = { match: async () => undefined, put: async () => {} }

let db: DatabaseSync
beforeEach(() => {
  ;(globalThis as any).caches = { default: noopCache }
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE hits (
    ts INTEGER, site TEXT DEFAULT '', path TEXT DEFAULT '', referrer TEXT DEFAULT '', country TEXT DEFAULT '',
    region TEXT DEFAULT '', city TEXT DEFAULT '', postal TEXT DEFAULT '', continent TEXT DEFAULT '',
    timezone TEXT DEFAULT '', lat TEXT DEFAULT '', lon TEXT DEFAULT '', colo TEXT DEFAULT '', org TEXT DEFAULT '',
    device TEXT DEFAULT '', browser TEXT DEFAULT '', os TEXT DEFAULT '', lang TEXT DEFAULT '',
    screenw INTEGER DEFAULT 0, visitor TEXT DEFAULT 'new', refpath TEXT DEFAULT '', source TEXT DEFAULT '',
    medium TEXT DEFAULT '', campaign TEXT DEFAULT ''
  )`)
})
afterEach(() => {
  db.close()
  delete (globalThis as any).caches
})

function fakeD1() {
  const calls: { sql: string; binds: unknown[] }[] = []
  const gss_geo = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds })
          return { all: async () => ({ results: db.prepare(sql).all(...(binds as any[])) }) }
        },
      }
    },
  }
  return { gss_geo: gss_geo as any, calls }
}
async function post(body: Record<string, unknown>) {
  const { gss_geo, calls } = fakeD1()
  const keys: string[] = []
  ;(globalThis as any).caches = { default: { match: async (r: Request) => (keys.push(r.url), undefined), put: async () => {} } }
  const ctx = { request: { json: async () => body }, env: { gss_geo }, waitUntil: () => {} } as any
  const res = await onRequestPost(ctx)
  return { body: (await res.json()) as any, calls, cacheKey: keys[0] }
}

const T = Date.parse('2026-10-01T15:30:00Z')
const range = { since: '2026-09-30', until: '2026-10-02' }

// Refused rows: every shape the patterns must catch.
const REFUSED = [
  '/return/sudoku_tired_of_ads/d0',
  '/return/sudoku_tired_of_ads/d2-7',
  '/return/organic/d1',
  '/game/complete/normal/easy',
  '/game/complete/daily/hard',
  '/game/complete-deferred/normal/medium',
  '/game/tutorial-complete/first-run',
  '/game/tutorial-complete/replay',
  '/game/start/easy',
  '/game/start/daily/hard',
  '/tour/exit-at/3',
  '/tour/exit-at/skip',
  '/tour/skip',
  '/tour/skip/later',
]
// Ordinary rows that share a prefix or neighbour the refused ones — none may be dropped.
const ORDINARY = [
  '/', '/game', '/game/first-move', '/game/abandon/26-50', '/game/complete', '/game/completely-new',
  '/game/tutorial-complete', '/returns', '/return', '/game/start', '/game/started', '/tour/start',
  '/tour/exit-at', '/tour/complete', '/tour/skipped', '/tour/skip-all', '/settings',
  '/signin-prompt/placement', '/install/prompt/android',
]

function seed() {
  const ins = db.prepare(
    'INSERT INTO hits (ts, site, path, country, region, city, lat, lon, device, browser, os, screenw, visitor, campaign) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  for (const path of [...REFUSED, ...ORDINARY]) {
    for (let i = 0; i < 2; i++) ins.run(T + i, 'bestsudoku-web', path, 'US', 'Ohio', 'Columbus', '39.9', '-83.0', 'mobile', 'Chrome', 'Android', 390, 'new', 'sudoku_tired_of_ads')
  }
}
const N_REFUSED = REFUSED.length * 2
const N_ORDINARY = ORDINARY.length * 2
const sum = (rows: any[]) => rows.reduce((a: number, r: any) => a + r.pageviews, 0)
const guardedSql = (sql: string) => sql.includes("NOT (path LIKE '/return/%'")

describe('splitGuard module', () => {
  it('refuses exactly the hour / place / device dims (the UTC date too), all real geo dims', () => {
    expect([...SPLIT_REFUSED_DIMS].sort()).toEqual(
      ['hourEt', 'date', 'country', 'region', 'city', 'postal', 'continent', 'timezone', 'colo', 'org', 'device', 'browser', 'os', 'lang', 'screenw', 'screenwBucket', 'visitor'].sort(),
    )
    for (const d of SPLIT_REFUSED_DIMS) expect(GEO_DIMS.has(d)).toBe(true)
    for (const d of ['dateEt', 'flightDay', 'site', 'path', 'pathFamily', 'campaign', 'referrer', 'keyEvent', 'arrival', 'gameMode']) {
      expect(SPLIT_REFUSED_DIMS.has(d)).toBe(false)
    }
  })

  it('names the refused path families', () => {
    expect(SPLIT_REFUSED_PATH_PATTERNS).toEqual([
      '/return/%',
      '/game/complete/%',
      '/game/complete-deferred/%',
      '/game/tutorial-complete/%',
      '/game/start/%',
      '/tour/exit-at/%',
      '/tour/skip',
      '/tour/skip/%',
    ])
  })

  it('inlines every pattern as an SQL literal and binds nothing (exact SQL pinned)', () => {
    const w: string[] = []
    const b: unknown[] = []
    refusedPathExcludeClause(w, b)
    expect(w).toEqual([
      "NOT (path LIKE '/return/%' OR path LIKE '/game/complete/%' OR " +
        "path LIKE '/game/complete-deferred/%' OR path LIKE '/game/tutorial-complete/%' OR " +
        "path LIKE '/game/start/%' OR path LIKE '/tour/exit-at/%' OR path LIKE '/tour/skip' OR " +
        "path LIKE '/tour/skip/%')",
    ])
    expect(b).toEqual([])
  })

  it('splitRefused: points mode or any refused field', () => {
    expect(splitRefused({ points: true, fields: [] })).toBe(true)
    expect(splitRefused({ points: false, fields: ['path', 'region'] })).toBe(true)
    expect(splitRefused({ points: false, fields: ['path', 'dateEt'] })).toBe(false)
    expect(splitRefused({ points: false, fields: ['path', 'date'] })).toBe(true)
  })

  it('in SQL, matches every refused row and no ordinary row', () => {
    seed()
    const w: string[] = []
    const b: unknown[] = []
    refusedPathExcludeClause(w, b)
    const kept = (db.prepare(`SELECT DISTINCT path FROM hits WHERE ${w[0]} ORDER BY path`).all(...(b as any[])) as any[]).map((r) => r.path)
    expect(kept).toEqual([...ORDINARY].sort())
  })

  it('isSplitRefusedPath agrees with the SQL LIKE row for row, case folding included', () => {
    const paths = [...REFUSED, ...ORDINARY, '/RETURN/x/d0', '/Game/Complete/normal/easy', '/game/tutorial-complete/', '/game/tutorial-completex', '/GAME/START/x', '/Tour/Exit-At/2', '/tour/exit-atx', '/TOUR/SKIP', '/Tour/Skip/x', '/tour/skip/', '/tour/skipx', '/tour/skip ']
    const ins = db.prepare('INSERT INTO hits (ts, path) VALUES (?, ?)')
    paths.forEach((p, i) => ins.run(i, p))
    const w: string[] = []
    const b: unknown[] = []
    refusedPathExcludeClause(w, b)
    const sqlRefused = (db.prepare(`SELECT path, NOT ${w[0].slice(4)} AS kept FROM hits ORDER BY ts`).all(...(b as any[])) as any[]).map((r) => r.kept === 0)
    expect(paths.map(isSplitRefusedPath)).toEqual(sqlRefused)
  })
})

describe('onRequestPost applies the guard on every trigger, in every branch', () => {
  beforeEach(seed)

  it('points mode (map) drops refused rows, keeps the rest', async () => {
    const { body, calls } = await post({ dimension: 'points', includeEventBeacons: true, limit: 100, ...range })
    expect(guardedSql(calls[0].sql)).toBe(true)
    expect(sum(body.rows)).toBe(N_ORDINARY)
  })

  it('a refused single dim (hourEt, region, device) drops refused rows even with event beacons on', async () => {
    for (const dimension of ['hourEt', 'region', 'device', 'screenwBucket', 'visitor']) {
      const { body, calls } = await post({ dimension, includeEventBeacons: true, limit: 100, ...range })
      expect(guardedSql(calls[0].sql), dimension).toBe(true)
      expect(body.totals.pageviews, dimension).toBe(N_ORDINARY)
    }
  })

  it('a ring with any refused dim drops refused rows; the ring order does not matter', async () => {
    for (const dims of [['path', 'region'], ['region', 'path'], ['pathFamily', 'device', 'site']]) {
      const { body, calls } = await post({ dimension: dims[0], dims, includeEventBeacons: true, limit: 100, ...range })
      expect(calls[0].sql).toContain('k1') // really ran the ring branch
      expect(guardedSql(calls[0].sql), dims.join('x')).toBe(true)
      expect(body.totals.pageviews, dims.join('x')).toBe(N_ORDINARY)
      expect(body.rows.some((r: any) => String(r.key.path ?? '').startsWith('/return/'))).toBe(false)
    }
  })

  it('a drill on a refused field drops refused rows from a non-refused chart', async () => {
    const { body, calls } = await post({ dimension: 'path', constraints: [{ field: 'region', value: 'Ohio' }], includeEventBeacons: true, limit: 100, ...range })
    expect(guardedSql(calls[0].sql)).toBe(true)
    const paths = body.rows.map((r: any) => r.key.path)
    for (const p of REFUSED) expect(paths).not.toContain(p)
    expect(body.totals.pageviews).toBe(N_ORDINARY)
  })

  it('an event dim (gameMode) drilled by device: completion rows are refused, so it is empty', async () => {
    const { body, calls } = await post({ dimension: 'gameMode', constraints: [{ field: 'device', value: 'mobile' }], limit: 100, ...range })
    expect(guardedSql(calls[0].sql)).toBe(true)
    expect(body.totals.pageviews).toBe(0)
  })

  it('no trigger: refused rows still count, and the SQL is unchanged (path, dateEt, gameMode, a site drill)', async () => {
    const byPath = await post({ dimension: 'path', includeEventBeacons: true, limit: 100, ...range })
    expect(guardedSql(byPath.calls[0].sql)).toBe(false)
    expect(byPath.body.totals.pageviews).toBe(N_REFUSED + N_ORDINARY)
    expect(byPath.cacheKey).not.toContain('splitGuard')

    const byDay = await post({ dimension: 'dateEt', includeEventBeacons: true, limit: 100, ...range })
    expect(guardedSql(byDay.calls[0].sql)).toBe(false)
    expect(sum(byDay.body.rows)).toBe(N_REFUSED + N_ORDINARY)

    const byMode = await post({ dimension: 'gameMode', limit: 100, ...range })
    expect(guardedSql(byMode.calls[0].sql)).toBe(false)
    expect(byMode.body.totals.pageviews).toBe(4) // complete/normal + complete/daily, 2 rows each (gameMode never reads deferred rows)

    // A drill on a non-refused field (site) is no trigger either.
    const drilled = await post({ dimension: 'path', constraints: [{ field: 'site', value: 'bestsudoku-web' }], includeEventBeacons: true, limit: 100, ...range })
    expect(guardedSql(drilled.calls[0].sql)).toBe(false)
    expect(drilled.body.totals.pageviews).toBe(N_REFUSED + N_ORDINARY)
  })

  it('non-refused rows count the same with and without the guard (default event-beacon setting)', async () => {
    // Default: event beacons excluded, so the rows on the event list are already out of a
    // page-view chart. Every refused path is on that list today, but the guard must not depend
    // on it: it removes only refused rows, so the region total is the path total minus whatever
    // refused rows the path chart still shows (possibly none).
    const region = await post({ dimension: 'region', limit: 100, ...range })
    const path = await post({ dimension: 'path', limit: 100, ...range })
    expect(guardedSql(region.calls[0].sql)).toBe(true)
    expect(guardedSql(path.calls[0].sql)).toBe(false)
    const refusedRows = path.body.rows.filter((r: any) => isSplitRefusedPath(r.key.path))
    expect(region.body.totals.pageviews).toBe(path.body.totals.pageviews - sum(refusedRows))
  })

  it('non-refused rows count the same with and without the guard (event beacons included)', async () => {
    // With event beacons included every refused row reaches the unguarded path chart, so the
    // guard visibly removes them, and only them.
    const region = await post({ dimension: 'region', includeEventBeacons: true, limit: 100, ...range })
    const path = await post({ dimension: 'path', includeEventBeacons: true, limit: 100, ...range })
    expect(guardedSql(region.calls[0].sql)).toBe(true)
    expect(guardedSql(path.calls[0].sql)).toBe(false)
    const refusedRows = path.body.rows.filter((r: any) => isSplitRefusedPath(r.key.path))
    expect(refusedRows.length).toBeGreaterThan(0)
    expect(sum(refusedRows)).toBe(N_REFUSED)
    expect(region.body.totals.pageviews).toBe(path.body.totals.pageviews - sum(refusedRows))
  })

  it('the UTC date dimension is refused (an hour-of-day split by differencing); dateEt is not', async () => {
    const byUtcDay = await post({ dimension: 'date', includeEventBeacons: true, limit: 100, ...range })
    expect(guardedSql(byUtcDay.calls[0].sql)).toBe(true)
    expect(byUtcDay.body.meta.splitGuard).toBe(true)
    expect(sum(byUtcDay.body.rows)).toBe(N_ORDINARY)

    // A date-primary dims query runs the single-dim branch on `date` (date dims never join a
    // ring), and is guarded the same way.
    const dims = await post({ dimension: 'date', dims: ['date', 'path'], includeEventBeacons: true, limit: 100, ...range })
    expect(guardedSql(dims.calls[0].sql)).toBe(true)
    expect(dims.body.meta.splitGuard).toBe(true)
    expect(sum(dims.body.rows)).toBe(N_ORDINARY)

    const byEtDay = await post({ dimension: 'dateEt', dims: ['dateEt', 'path'], includeEventBeacons: true, limit: 100, ...range })
    expect(guardedSql(byEtDay.calls[0].sql)).toBe(false)
    expect(byEtDay.body.meta.splitGuard).toBeUndefined()
    expect(sum(byEtDay.body.rows)).toBe(N_REFUSED + N_ORDINARY)
  })

  it('tour skips (/tour/skip) are refused by every hour, place and device split', async () => {
    // Seeded: 2 rows each of '/tour/skip' and '/tour/skip/later' (both in REFUSED) plus the
    // '/tour/skipped' and '/tour/skip-all' look-alikes (ORDINARY, kept).
    const skipRows = (rows: any[]) => rows.filter((r: any) => /^\/tour\/skip(\/|$)/i.test(String(r.key?.path ?? '')))
    for (const dimension of ['hourEt', 'date', 'country', 'region', 'city', 'device', 'browser', 'os', 'screenwBucket']) {
      const { body, calls } = await post({ dimension, includeEventBeacons: true, limit: 100, ...range })
      expect(guardedSql(calls[0].sql), dimension).toBe(true)
      expect(calls[0].sql, dimension).toContain("path LIKE '/tour/skip'")
      expect(body.totals.pageviews, dimension).toBe(N_ORDINARY)
    }
    // A path chart drilled by place: the skip rows are out of the paths it lists.
    const drilled = await post({ dimension: 'path', constraints: [{ field: 'country', value: 'US' }], includeEventBeacons: true, limit: 100, ...range })
    expect(skipRows(drilled.body.rows)).toEqual([])
    expect(drilled.body.rows.map((r: any) => r.key.path)).toContain('/tour/skipped')
    // The map (points mode) carries no tour-skip row either.
    const points = await post({ dimension: 'points', includeEventBeacons: true, limit: 100, ...range })
    expect(sum(points.body.rows)).toBe(N_ORDINARY)
  })

  it('tour skips still count as totals: per ET day, per web/app site, and by path', async () => {
    // Add skips on the app site too, so the web/app total is a real two-sided one.
    const ins = db.prepare('INSERT INTO hits (ts, site, path, country, device, visitor) VALUES (?, ?, ?, ?, ?, ?)')
    for (let i = 0; i < 3; i++) ins.run(T + 10 + i, 'bestsudoku-app', '/tour/skip', 'CA', 'tablet', 'new')
    const skipsOf = (rows: any[], pick: (r: any) => unknown, want: unknown) =>
      sum(rows.filter((r: any) => pick(r) === want))

    const bySite = await post({ dimension: 'path', dims: ['path', 'site'], includeEventBeacons: true, limit: 200, ...range })
    expect(guardedSql(bySite.calls[0].sql)).toBe(false)
    const siteSkips = bySite.body.rows.filter((r: any) => r.key.path === '/tour/skip')
    expect(skipsOf(siteSkips, (r) => r.key.site, 'bestsudoku-web')).toBe(2)
    expect(skipsOf(siteSkips, (r) => r.key.site, 'bestsudoku-app')).toBe(3)

    // A per-ET-day chart drilled to the one path (a date dimension never joins a ring).
    const byDay = await post({ dimension: 'dateEt', constraints: [{ field: 'path', value: '/tour/skip' }], includeEventBeacons: true, limit: 200, ...range })
    expect(guardedSql(byDay.calls[0].sql)).toBe(false)
    expect(sum(byDay.body.rows)).toBe(5)

    const byPath = await post({ dimension: 'path', includeEventBeacons: true, limit: 200, ...range })
    expect(guardedSql(byPath.calls[0].sql)).toBe(false)
    expect(sum(byPath.body.rows.filter((r: any) => r.key.path === '/tour/skip'))).toBe(5)
    expect(byPath.body.totals.pageviews).toBe(N_REFUSED + N_ORDINARY + 3)

    // The same rows through a refused split: gone, web and app alike.
    const byDevice = await post({ dimension: 'device', includeEventBeacons: true, limit: 200, ...range })
    expect(guardedSql(byDevice.calls[0].sql)).toBe(true)
    expect(byDevice.body.totals.pageviews).toBe(N_ORDINARY)
  })

  it('the guard binds nothing: a maxed-out guarded request binds exactly what its unguarded twin does, under the 100-bind cap', async () => {
    // 50 sites + 16 path filters + both hides is the heaviest input the handler accepts (the
    // 81 / 91 / 96 / 97 pins in geo.derivedDims.test.ts are the same shapes). The refused ring
    // dim `device` is a trigger; `campaign` is not, so the pair differs only by the guard.
    const maxed = {
      sites: Array.from({ length: 50 }, (_, i) => `s${i}`),
      constraints: Array.from({ length: 16 }, (_, i) => ({ field: 'path', value: `/p${i}` })),
      excludeOwnVisits: true,
      ownBrowser: 'Opera',
      ownOS: 'Windows',
      excludeKnownTraffic: true,
      includeEventBeacons: true,
      limit: 100,
      ...range,
    }
    const guarded = await post({ ...maxed, dimension: 'referrer', dims: ['referrer', 'device'] })
    const plain = await post({ ...maxed, dimension: 'referrer', dims: ['referrer', 'campaign'] })
    expect(guarded.body.error).toBeUndefined()
    expect(plain.body.error).toBeUndefined()
    expect(guardedSql(guarded.calls[0].sql)).toBe(true)
    expect(guardedSql(plain.calls[0].sql)).toBe(false)
    expect(guarded.calls[0].binds.length).toBe(plain.calls[0].binds.length)
    expect(guarded.calls[0].binds.length).toBeLessThan(100)
    // Every placeholder in the guarded statement is one of its binds: no pattern hides in a `?`.
    expect(guarded.calls[0].sql.match(/\?/g)?.length ?? 0).toBe(guarded.calls[0].binds.length)
    for (const p of SPLIT_REFUSED_PATH_PATTERNS) expect(guarded.calls[0].binds).not.toContain(p)
  })

  it('a guarded query gets its own cache key; patterns travel as SQL literals, not binds', async () => {
    const { body, calls, cacheKey } = await post({ dimension: 'hourEt', includeEventBeacons: true, limit: 100, ...range })
    expect(cacheKey).toContain('splitGuard')
    expect(decodeURIComponent(cacheKey)).toContain('/game/tutorial-complete/%') // keyed on the list itself
    expect(body.meta.splitGuard).toBe(true)
    const plain = await post({ dimension: 'path', limit: 100, ...range })
    expect(plain.body.meta.splitGuard).toBeUndefined()
    for (const p of SPLIT_REFUSED_PATH_PATTERNS) {
      expect(calls[0].sql).toContain(`path LIKE '${p}'`)
      expect(calls[0].binds).not.toContain(p)
    }
  })
})
