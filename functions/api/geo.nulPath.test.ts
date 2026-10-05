// A stored path containing U+0000 and the counts-only guard, on a REAL SQLite engine (node:sqlite,
// D1's dialect), the same way bindParity.test.ts runs it. isSplitRefusedPath (src/lib/splitGuard.ts)
// refuses any path with a NUL, but SQLite's LIKE reads text only up to its first NUL, so before the
// `instr(path, char(0)) > 0` term a stored `/return<NUL>x` looked like `/return` to every LIKE
// pattern and was counted in the hour, place and device splits. This file proves:
//   1. SQL and JS agree, path by path (the shared predicate refusedPathMatch vs isSplitRefusedPath);
//   2. through the real /api/geo handler, every refused-capable split (each dim in
//      SPLIT_REFUSED_DIMS plain and as a ring, points mode, a refused-field drill) leaves all three
//      NUL rows out, while a total that is allowed to count everything (dateEt) is unchanged;
//   3. /api/metrics' country bucket reads '' on a NUL row, like any refused row;
//   4. the default view (event beacons excluded, popupExcludeClause) drops NUL rows too, so its
//      meta.liveSafe (no refused row can be counted) is true only when that is so.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openHitsDb, insertHits, sqliteD1, pagesContext, postJson } from '../_lib/testing/hitsDb'
import { FIXTURE_NOW } from '../_lib/testing/bskFixture'
import { buildFact } from '../../src/lib/metrics/engine'
import { SPLIT_REFUSED_DIMS, isSplitRefusedPath, refusedPathMatch } from '../../src/lib/splitGuard'
import { popupExcludeClause } from '../../src/lib/popupEvents'

const NUL = '\u0000'
const T = Date.parse('2026-10-01T15:30:00Z')
const range = { since: '2026-09-30', until: '2026-10-02' }

/** The three paths of the finding: a return the LIKE patterns cannot see, a tour skip they can, and
 * a clean page. All three are refused by the JS matcher (any NUL). */
const NUL_PATHS = [`/return${NUL}x`, `/tour/skip${NUL}x`, `/page${NUL}x`]
/** The wider set from the review probes: NUL rows the SQL LIKE patterns see, and ones they do not. */
const NUL_SQL_VISIBLE = [`/tour/skip${NUL}x`, `/tour/exit-at${NUL}`, `/return/${NUL}x`, `/game/start/${NUL}`]
const NUL_SQL_INVISIBLE = [`/return${NUL}x`, `/${NUL}`, `/game/complete${NUL}/x`, `/tour${NUL}/skip`, `/page${NUL}x`]
const CLEAN_REFUSED = ['/return/organic/d1', '/game/complete/normal/easy', '/game/complete-deferred/x', '/game/tutorial-complete/x', '/game/start/normal', '/tour/exit-at/3', '/tour/exit-at', '/tour/skip', '/tour/skip/x', '/RETURN/x', '/Tour/Skip']
const ORDINARY = ['/', '/game', '/game/first-move', '/tour/start', '/tour/complete', '/tour/skipped', '/settings', '/return', '/tour/skip-all']

let db: DatabaseSync
beforeEach(() => {
  db = openHitsDb()
})
afterEach(() => {
  db.close()
  delete (globalThis as any).caches
})

describe('SQL and JS agree on every path (refusedPathMatch vs isSplitRefusedPath)', () => {
  const sqlSays = (path: string): boolean => {
    insertHits(db, [{ ts: T, site: 'bestsudoku-web', path }])
    const id = (db.prepare('SELECT max(id) AS id FROM hits').get() as { id: number }).id
    const r = db.prepare(`SELECT COALESCE(${refusedPathMatch().sql}, 0) AS r FROM hits WHERE id = ?`).get(id) as { r: number }
    return r.r === 1
  }
  const all = [...NUL_PATHS, ...NUL_SQL_VISIBLE, ...NUL_SQL_INVISIBLE, ...CLEAN_REFUSED, ...ORDINARY]

  it('every seeded path gets the same answer from the SQL predicate and the JS matcher', () => {
    for (const p of all) expect(sqlSays(p), JSON.stringify(p)).toBe(isSplitRefusedPath(p))
  })
  it('all three finding paths are refused by both', () => {
    for (const p of NUL_PATHS) {
      expect(isSplitRefusedPath(p), JSON.stringify(p)).toBe(true)
      expect(sqlSays(p), JSON.stringify(p)).toBe(true)
    }
  })
  it('the NUL term is a literal: no bound parameter, and it names char(0)', () => {
    const m = refusedPathMatch()
    expect(m.binds).toEqual([])
    expect(m.sql).toContain('instr(path, char(0)) > 0')
    expect(m.sql).not.toContain('?')
  })
})

describe('/api/geo: every refused-capable split leaves the NUL rows out', () => {
  const noCache = { match: async () => undefined, put: async () => {} }
  const post = async (body: Record<string, unknown>) => {
    ;(globalThis as any).caches = { default: noCache }
    const { onRequestPost } = await import('./geo')
    const res = await onRequestPost(pagesContext(postJson('/api/geo', { ...body, ...range, limit: 200, includeEventBeacons: true }), { gss_geo: sqliteD1(db) }) as any)
    return { status: res.status, body: (await res.json()) as any }
  }
  const ORDINARY_ROWS = 2
  const seed = () => {
    const base = { site: 'bestsudoku-web', referrer: 'google.com', country: 'US', region: 'Ohio', city: 'Columbus', postal: '43215', continent: 'NA', timezone: 'America/New_York', colo: 'EWR', org: 'Acme ISP', device: 'mobile', browser: 'Chrome', os: 'Android', lang: 'en', screenw: 390, visitor: 'new', lat: '39.9', lon: '-83.0' }
    insertHits(db, [
      { ...base, ts: T, path: '/' },
      { ...base, ts: T + 3_600_000, path: '/' },
      ...NUL_PATHS.map((path, i) => ({ ...base, ts: T + (i + 2) * 3_600_000, path, n: 3 })),
    ])
  }

  it('control: a total that may count everything (dateEt) counts the NUL rows too, so the zeros below are not vacuous', async () => {
    seed()
    const r = await post({ dimension: 'dateEt' })
    expect(r.status).toBe(200)
    expect(r.body.totals.pageviews).toBe(ORDINARY_ROWS + NUL_PATHS.length * 3)
  })

  it('every refused dim, plain and as a ring, counts only the ordinary rows', async () => {
    seed()
    for (const dim of SPLIT_REFUSED_DIMS) {
      for (const dims of [undefined, [dim, 'referrer'], [dim, 'device', 'dateEt']]) {
        const label = `${dim} ${dims ? dims.join('x') : 'plain'}`
        const { status, body } = await post({ dimension: dim, ...(dims ? { dims } : {}) })
        expect(status, label).toBe(200)
        expect(body.totals.pageviews, label).toBe(ORDINARY_ROWS)
      }
    }
  }, 120_000)

  it('points mode (the map) counts only the ordinary rows', async () => {
    seed()
    const { status, body } = await post({ dimension: 'points' })
    expect(status).toBe(200)
    expect(body.totals.pageviews).toBe(ORDINARY_ROWS)
  })

  it('a drill on a refused field counts only the ordinary rows, with the path as the split', async () => {
    seed()
    for (const field of ['country', 'device', 'region']) {
      const value = field === 'country' ? 'US' : field === 'device' ? 'mobile' : 'Ohio'
      const { status, body } = await post({ dimension: 'path', constraints: [{ field, value }] })
      expect(status, field).toBe(200)
      expect(body.totals.pageviews, field).toBe(ORDINARY_ROWS)
    }
  })
})

describe('/api/metrics: a NUL row has no country bucket', () => {
  it('campaignPathVisitor reports cb = "" for the NUL rows and the bucket for an ordinary one', () => {
    const TAG = { site: 'bestsudoku-web', campaign: 'sudoku_tired_of_ads' }
    insertHits(db, [
      { ...TAG, ts: Date.parse('2026-09-03T15:00:00Z'), path: '/game', visitor: 'new', country: 'US', n: 2 },
      ...NUL_PATHS.map((path) => ({ ...TAG, ts: Date.parse('2026-09-03T15:01:00Z'), path, visitor: 'new', country: 'US', n: 2 })),
    ])
    const stmt = buildFact({ id: 'campaignPathVisitor', params: { campaignId: '24215315197' } }, FIXTURE_NOW)
    const rows = db.prepare(stmt.sql).all(...(stmt.binds as (string | number)[])) as { path: string; cb: string; c: number }[]
    const cbOf = (path: string) => [...new Set(rows.filter((r) => r.path === path).map((r) => r.cb))]
    expect(cbOf('/game')).toEqual(['US'])
    for (const p of NUL_PATHS) expect(cbOf(p), JSON.stringify(p)).toEqual([''])
    expect(rows.filter((r) => r.path !== '/game').reduce((a, r) => a + r.c, 0)).toBe(NUL_PATHS.length * 2)
  })
})

describe('the default view (event beacons excluded) drops NUL rows: popupExcludeClause and meta.liveSafe', () => {
  const noCache = { match: async () => undefined, put: async () => {} }
  const post = async (body: Record<string, unknown>) => {
    ;(globalThis as any).caches = { default: noCache }
    const { onRequestPost } = await import('./geo')
    const res = await onRequestPost(pagesContext(postJson('/api/geo', { ...range, limit: 200, ...body }), { gss_geo: sqliteD1(db) }) as any)
    return { status: res.status, body: (await res.json()) as any }
  }
  const ORDINARY_ROWS = 2
  const seed = () => {
    const base = { site: 'bestsudoku-web', country: 'US', region: 'Ohio', device: 'mobile' }
    insertHits(db, [
      { ...base, ts: T, path: '/' },
      { ...base, ts: T + 3_600_000, path: '/game' },
      ...NUL_PATHS.map((path, i) => ({ ...base, ts: T + (i + 2) * 3_600_000, path, n: 3 })),
    ])
  }

  it('popupExcludeClause keeps NULL, empty and clean paths, drops event and NUL paths: only NUL rows differ from the LIKE-only clause', () => {
    insertHits(db, [{ ts: T, path: '' }, ...['/', '/game', '/return', '/page'].map((path) => ({ ts: T, path }))])
    db.exec(`INSERT INTO hits (ts, path) VALUES (${T}, NULL)`)
    insertHits(db, [...CLEAN_REFUSED, ...NUL_SQL_VISIBLE, ...NUL_SQL_INVISIBLE].map((path) => ({ ts: T, path })))
    const w: string[] = []
    popupExcludeClause(w, [])
    const kept = (terms: string[]) => (db.prepare(`SELECT path FROM hits WHERE ${terms.join(' AND ')} ORDER BY id`).all() as { path: string | null }[]).map((r) => r.path)
    const after = kept(w)
    const before = kept(w.slice(1)) // the clause as it was: the prefix tests alone
    expect(before).not.toContain(null) // a NULL path never matched, before or after
    expect(after).not.toContain(null)
    expect(after).toContain('')
    for (const p of ['/', '/game', '/page']) expect(after, p).toContain(p)
    for (const p of before) expect(after.includes(p), JSON.stringify(p)).toBe(!(p as string).includes(NUL)) // only NUL paths drop
    for (const p of [...NUL_PATHS, ...NUL_SQL_VISIBLE, ...NUL_SQL_INVISIBLE]) expect(after, JSON.stringify(p)).not.toContain(p)
    expect(before.some((p) => (p as string).includes(NUL)), 'the LIKE-only clause let a NUL path through').toBe(true)
    expect(w.join(' ')).not.toContain('?')
  })

  it('default dateEt and path views count the NUL rows 0 and are liveSafe', async () => {
    seed()
    for (const body of [{ dimension: 'dateEt' }, { dimension: 'path' }, { dimension: 'pathFamily' }]) {
      const { status, body: out } = await post(body)
      expect(status, JSON.stringify(body)).toBe(200)
      expect(out.totals.pageviews, JSON.stringify(body)).toBe(ORDINARY_ROWS)
      expect(out.meta.liveSafe, JSON.stringify(body)).toBe(true)
      expect(JSON.stringify(out.rows ?? out), JSON.stringify(body)).not.toContain('\u0000')
    }
  })

  it('liveSafe is true only when no NUL row can be counted: opting into event beacons counts them and turns it off', async () => {
    seed()
    const on = await post({ dimension: 'dateEt', includeEventBeacons: true })
    expect(on.body.totals.pageviews).toBe(ORDINARY_ROWS + NUL_PATHS.length * 3)
    expect('liveSafe' in on.body.meta).toBe(false)
    const off = await post({ dimension: 'dateEt' })
    expect(off.body.meta.liveSafe).toBe(true)
  })

  it('a path drill on a NUL value is never liveSafe, and counts nothing in the default view', async () => {
    seed()
    for (const value of NUL_PATHS) {
      const r = await post({ dimension: 'dateEt', constraints: [{ field: 'path', value }] })
      expect(r.body.totals.pageviews, JSON.stringify(value)).toBe(0)
      expect('liveSafe' in r.body.meta, JSON.stringify(value)).toBe(false)
    }
  })

  it('the clause /api/sites tallies with counts no NUL row', async () => {
    seed()
    const [row] = db.prepare(`SELECT COUNT(*) c FROM hits WHERE site <> '' AND ts >= 0 AND ${(() => { const w: string[] = []; popupExcludeClause(w, []); return w.join(' AND ') })()}`).all() as { c: number }[]
    expect(row.c).toBe(ORDINARY_ROWS)
  })
})
