// Proves the merged total+grouped SQL (buildMergedBreakdownSql / buildMergedRingSql, added to
// cut D1 rows_read in half — see the doc comment in geo.ts) gives IDENTICAL numbers to the old
// two-query approach it replaces: a plain `SELECT COUNT(*) FROM hits WHERE <where>` for the
// total, alongside a `SELECT <col>, COUNT(*) FROM hits WHERE <where> GROUP BY <col> ORDER BY
// c DESC LIMIT ?` for the rows. Runs against a REAL SQLite engine (node:sqlite, Node 24+) — the
// same dialect D1 uses (including window function support) — not a hand-rolled JS re-
// implementation of the aggregation logic, and not a mock, so this is testing actual SQL
// semantics, not test-author assumptions about them.
//
// The one place a naive SUM(c) OVER () could silently regress: LIMIT is applied on the OUTER
// query, so the window function must sum every group BEFORE the top-N cut, not after. Several
// scenarios below deliberately set a LIMIT smaller than the number of distinct groups so a
// bug that summed only the returned (post-LIMIT) rows would show up as a wrong total.
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { breakdownColumnExpr, buildMergedBreakdownSql, buildMergedRingSql } from './geo'

let db: DatabaseSync

const COLUMNS = ['ts', 'site', 'region', 'country', 'device', 'browser', 'os', 'referrer', 'campaign'] as const
type Row = Partial<Record<(typeof COLUMNS)[number], string | number>>

function insertRow(row: Row) {
  const cols = COLUMNS.map((c) => (row[c] === undefined ? (c === 'ts' ? Date.now() : '') : row[c]))
  db.prepare(`INSERT INTO hits (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`).run(...(cols as any[]))
}

beforeEach(() => {
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE hits (${COLUMNS.map((c) => `${c} ${c === 'ts' ? 'INTEGER' : 'TEXT'}`).join(', ')})`)
})
afterEach(() => db.close())

// The OLD two-query approach this feature replaces — the ground-truth oracle. Shares the exact
// same whereSql/binds/col/orderBy the production code builds, so this isolates ONLY the change
// under test (one merged statement vs. two), not any of the surrounding query-building logic.
// Rows with an equal count have no defined relative order under a bare `ORDER BY c DESC`
// (production behavior, unchanged by this feature) — the two query SHAPES (direct GROUP BY vs.
// a wrapping subquery) can legitimately return same-count rows in different physical order.
// That's immaterial to correctness (the UI treats top-N by count as a set at each count), so
// comparisons sort by (c DESC, k ASC) for a deterministic diff instead of trusting raw order.
const byCountThenKey = (rows: { k: string; c: number }[]) => [...rows].sort((a, b) => b.c - a.c || a.k.localeCompare(b.k))

function oldTwoQuery(whereSql: string, binds: unknown[], col: string, orderBy: string, limit: number) {
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM hits WHERE ${whereSql}`).get(...(binds as any[])) as any).c as number
  const rows = db
    .prepare(`SELECT ${col} AS k, COUNT(*) AS c FROM hits WHERE ${whereSql} GROUP BY k ORDER BY ${orderBy} LIMIT ?`)
    .all(...(binds as any[]), limit) as any[]
  return { total, rows: byCountThenKey(rows.map((r) => ({ k: String(r.k), c: r.c }))) }
}

function newMergedQuery(col: string, whereSql: string, orderBy: string, binds: unknown[], limit: number) {
  const sql = buildMergedBreakdownSql(col, whereSql, orderBy)
  const rows = db.prepare(sql).all(...(binds as any[]), limit) as any[]
  const total = rows.length ? Number(rows[0].total) : 0
  return { total, rows: byCountThenKey(rows.map((r) => ({ k: String(r.k), c: r.c }))) }
}

function seedVariedRegions(n: number) {
  const regions = ['CA', 'NY', 'TX', 'WA', 'FL', 'OH', 'GA', 'NC', 'MI', 'PA', 'AZ', 'MA']
  for (let i = 0; i < n; i++) {
    insertRow({ ts: 1_700_000_000_000 + i * 1000, site: i % 2 ? 'goodstuff' : 'simpletile', region: regions[i % regions.length], device: i % 3 ? 'mobile' : 'desktop' })
  }
}

describe('breakdown: merged query total matches the old two-query total', () => {
  it('matches when LIMIT keeps every group (no truncation)', () => {
    seedVariedRegions(30) // 12 distinct regions, well under a limit of 50
    const col = breakdownColumnExpr('region', '(none)')
    const whereSql = 'ts >= ? AND ts < ?'
    const binds = [1_699_000_000_000, 1_800_000_000_000]
    const oldR = oldTwoQuery(whereSql, binds, col, 'c DESC, k ASC', 50)
    const newR = newMergedQuery(col, whereSql, 'c DESC, k ASC', binds, 50)
    expect(newR.total).toBe(oldR.total)
    expect(newR.total).toBe(30)
    expect(newR.rows).toEqual(oldR.rows)
  })

  it('matches when LIMIT truncates fewer groups than exist — the exact case a naive SUM() OVER() gets wrong', () => {
    seedVariedRegions(120) // 12 distinct regions
    const col = breakdownColumnExpr('region', '(none)')
    const whereSql = 'ts >= ? AND ts < ?'
    const binds = [1_699_000_000_000, 1_800_000_000_000]
    const limit = 3 // far fewer than the 12 distinct region groups
    // 'c DESC, k ASC' tiebreak — all 12 regions are tied at count 10, so WITHOUT a tiebreak
    // which 3 survive LIMIT is unspecified and can legitimately differ between the old
    // two-query plan and the new merged one even though both read the same data.
    const oldR = oldTwoQuery(whereSql, binds, col, 'c DESC, k ASC', limit)
    const newR = newMergedQuery(col, whereSql, 'c DESC, k ASC', binds, limit)
    expect(oldR.rows).toHaveLength(3)
    expect(newR.total).toBe(oldR.total) // total must still be 120, not the sum of only the 3 returned rows
    expect(newR.total).toBe(120)
    expect(newR.rows).toEqual(oldR.rows)
  })

  it('matches with an additional WHERE predicate (site filter) narrowing the scan', () => {
    seedVariedRegions(60)
    const col = breakdownColumnExpr('region', '(none)')
    const whereSql = 'ts >= ? AND ts < ? AND site IN (?)'
    const binds = [1_699_000_000_000, 1_800_000_000_000, 'goodstuff']
    const oldR = oldTwoQuery(whereSql, binds, col, 'c DESC, k ASC', 5)
    const newR = newMergedQuery(col, whereSql, 'c DESC, k ASC', binds, 5)
    expect(newR.total).toBe(oldR.total)
    expect(newR.rows).toEqual(oldR.rows)
  })

  it('matches for a date-ordered series (ASC order, non-count ORDER BY column)', () => {
    for (let d = 0; d < 10; d++) {
      for (let i = 0; i < d + 1; i++) insertRow({ ts: Date.UTC(2026, 8, 1 + d) + i * 1000 })
    }
    const col = breakdownColumnExpr('date', '(none)')
    const whereSql = 'ts >= ? AND ts < ?'
    const binds = [Date.UTC(2026, 8, 1), Date.UTC(2026, 8, 20)]
    const oldR = oldTwoQuery(whereSql, binds, col, 'k ASC', 4) // LIMIT smaller than the 10 distinct days
    const newR = newMergedQuery(col, whereSql, 'k ASC', binds, 4)
    expect(newR.total).toBe(oldR.total)
    expect(newR.total).toBe(55) // 1+2+...+10
    expect(newR.rows).toEqual(oldR.rows)
  })

  it('matches when the WHERE clause matches nothing (zero groups, total 0)', () => {
    seedVariedRegions(10)
    const col = breakdownColumnExpr('region', '(none)')
    const whereSql = 'ts >= ? AND ts < ?'
    const binds = [0, 1] // outside every seeded ts
    const oldR = oldTwoQuery(whereSql, binds, col, 'c DESC', 50)
    const newR = newMergedQuery(col, whereSql, 'c DESC', binds, 50)
    expect(newR.total).toBe(0)
    expect(newR.total).toBe(oldR.total)
    expect(newR.rows).toEqual([])
  })
})

describe('ring (N-dimension breakdown): merged query total matches the old two-query total', () => {
  function oldTwoQueryRing(cols: string[], whereSql: string, binds: unknown[], groupBy: string, limit: number) {
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM hits WHERE ${whereSql}`).get(...(binds as any[])) as any).c as number
    // Same "c DESC, <group cols>" tiebreak buildMergedRingSql now uses — without it, LIMIT can
    // keep a different arbitrary subset of an exact-count tie depending on the query plan.
    const rows = db
      .prepare(`SELECT ${cols.join(', ')}, COUNT(*) AS c FROM hits WHERE ${whereSql} GROUP BY ${groupBy} ORDER BY c DESC, ${groupBy} LIMIT ?`)
      .all(...(binds as any[]), limit) as any[]
    return { total, rows }
  }
  function newMergedRing(cols: string[], whereSql: string, binds: unknown[], groupBy: string, limit: number) {
    const sql = buildMergedRingSql(cols, whereSql, groupBy)
    const rows = db.prepare(sql).all(...(binds as any[]), limit) as any[]
    const total = rows.length ? Number(rows[0].total) : 0
    return { total, rows }
  }

  it('matches for a 2-ring breakdown with LIMIT truncation', () => {
    seedVariedRegions(200) // 12 regions x 2 sites x ~2 devices → well over 20 combinations
    const cols = ['region AS k0', 'device AS k1']
    const whereSql = "ts >= ? AND ts < ? AND region <> '' AND device <> ''"
    const binds = [1_699_000_000_000, 1_800_000_000_000]
    const groupBy = 'k0, k1'
    const oldR = oldTwoQueryRing(cols, whereSql, binds, groupBy, 5)
    const newR = newMergedRing(cols, whereSql, binds, groupBy, 5)
    expect(newR.total).toBe(oldR.total)
    expect(newR.total).toBe(200)
    const sortRing = (rows: any[]) => [...rows].sort((a, b) => b.c - a.c || `${a.k0}|${a.k1}`.localeCompare(`${b.k0}|${b.k1}`))
    expect(sortRing(newR.rows).map((r) => ({ k0: r.k0, k1: r.k1, c: r.c }))).toEqual(sortRing(oldR.rows).map((r) => ({ k0: r.k0, k1: r.k1, c: r.c })))
  })

  it('matches for a 3-ring breakdown', () => {
    seedVariedRegions(150)
    const cols = ['region AS k0', 'device AS k1', 'site AS k2']
    const whereSql = "ts >= ? AND ts < ? AND region <> '' AND device <> '' AND site <> ''"
    const binds = [1_699_000_000_000, 1_800_000_000_000]
    const groupBy = 'k0, k1, k2'
    const oldR = oldTwoQueryRing(cols, whereSql, binds, groupBy, 8)
    const newR = newMergedRing(cols, whereSql, binds, groupBy, 8)
    expect(newR.total).toBe(oldR.total)
    expect(newR.total).toBe(150)
  })
})
