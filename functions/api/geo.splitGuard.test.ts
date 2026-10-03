// The counts-only split guard (src/lib/splitGuard.ts) through the real onRequestPost handler,
// on a REAL SQLite engine (node:sqlite, the dialect D1 speaks), the same way
// geo.derivedDims.test.ts runs it. Each trigger (points mode, a refused single dim, a refused
// ring dim, a drill on a refused field) must drop return / game-start / completion / tutorial-
// completion / tour-exit rows and nothing else; a query with no trigger must count exactly what it counted before.
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
]
// Ordinary rows that share a prefix or neighbour the refused ones — none may be dropped.
const ORDINARY = [
  '/', '/game', '/game/first-move', '/game/abandon/26-50', '/game/complete', '/game/completely-new',
  '/game/tutorial-complete', '/returns', '/return', '/game/start', '/game/started', '/tour/start',
  '/tour/exit-at', '/tour/complete', '/settings',
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
const guardedSql = (sql: string) => sql.includes('NOT (path LIKE ?')

describe('splitGuard module', () => {
  it('refuses exactly the hour / place / device dims, all of which are real geo dims', () => {
    expect([...SPLIT_REFUSED_DIMS].sort()).toEqual(
      ['hourEt', 'country', 'region', 'city', 'postal', 'continent', 'timezone', 'colo', 'org', 'device', 'browser', 'os', 'lang', 'screenw', 'screenwBucket', 'visitor'].sort(),
    )
    for (const d of SPLIT_REFUSED_DIMS) expect(GEO_DIMS.has(d)).toBe(true)
    for (const d of ['date', 'dateEt', 'flightDay', 'site', 'path', 'pathFamily', 'campaign', 'referrer', 'keyEvent', 'arrival', 'gameMode']) {
      expect(SPLIT_REFUSED_DIMS.has(d)).toBe(false)
    }
  })

  it('names the six refused path families', () => {
    expect(SPLIT_REFUSED_PATH_PATTERNS).toEqual([
      '/return/%',
      '/game/complete/%',
      '/game/complete-deferred/%',
      '/game/tutorial-complete/%',
      '/game/start/%',
      '/tour/exit-at/%',
    ])
  })

  it('binds every pattern; none is interpolated into the SQL', () => {
    const w: string[] = []
    const b: unknown[] = []
    refusedPathExcludeClause(w, b)
    expect(w).toEqual(['NOT (path LIKE ? OR path LIKE ? OR path LIKE ? OR path LIKE ? OR path LIKE ? OR path LIKE ?)'])
    expect(b).toEqual([...SPLIT_REFUSED_PATH_PATTERNS])
    for (const p of SPLIT_REFUSED_PATH_PATTERNS) expect(w[0]).not.toContain(p)
  })

  it('splitRefused: points mode or any refused field', () => {
    expect(splitRefused({ points: true, fields: [] })).toBe(true)
    expect(splitRefused({ points: false, fields: ['path', 'region'] })).toBe(true)
    expect(splitRefused({ points: false, fields: ['path', 'dateEt'] })).toBe(false)
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
    const paths = [...REFUSED, ...ORDINARY, '/RETURN/x/d0', '/Game/Complete/normal/easy', '/game/tutorial-complete/', '/game/tutorial-completex', '/GAME/START/x', '/Tour/Exit-At/2', '/tour/exit-atx']
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
    // Default: event beacons excluded, so return/completion rows are already out of a page-view
    // chart. Refused rows the event classifier does not (yet) list — tutorial completions, game
    // starts, tour exits — still reach the unguarded path chart, so they are the only rows the
    // guard removes here; every other row counts the same.
    const region = await post({ dimension: 'region', limit: 100, ...range })
    const path = await post({ dimension: 'path', limit: 100, ...range })
    expect(guardedSql(region.calls[0].sql)).toBe(true)
    expect(guardedSql(path.calls[0].sql)).toBe(false)
    const refusedRows = path.body.rows.filter((r: any) => isSplitRefusedPath(r.key.path))
    expect(refusedRows.length).toBeGreaterThan(0)
    expect(region.body.totals.pageviews).toBe(path.body.totals.pageviews - sum(refusedRows))
  })

  it('a guarded query gets its own cache key; patterns travel as binds', async () => {
    const { body, calls, cacheKey } = await post({ dimension: 'hourEt', includeEventBeacons: true, limit: 100, ...range })
    expect(cacheKey).toContain('splitGuard')
    expect(decodeURIComponent(cacheKey)).toContain('/game/tutorial-complete/%') // keyed on the list itself
    expect(body.meta.splitGuard).toBe(true)
    const plain = await post({ dimension: 'path', limit: 100, ...range })
    expect(plain.body.meta.splitGuard).toBeUndefined()
    for (const p of SPLIT_REFUSED_PATH_PATTERNS) {
      expect(calls[0].binds).toContain(p)
      expect(calls[0].sql).not.toContain(p)
    }
  })
})
