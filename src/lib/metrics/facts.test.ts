// Facts are the only SQL the registry runs. Every statement must be an anonymous aggregate
// (ADR 0003 section 3, rule 6): COUNT/SUM/MIN/MAX with GROUP BY (or a bare MIN/MAX), no JOIN,
// no `id`, and no raw `ts` — only values derived from a minute/hour bucket start (a segment or a
// KPI day index) and the boolean install-fix split. Each is also run against a real SQLite
// (node:sqlite, D1's dialect) and snapshotted, so any change to a statement is a reviewed diff.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { COUNTRY_BUCKET_SQL, FACTS, factKey, flightPathsSeenStatement, kpiDayWindows, rangeMs, type FactId, type FactParams } from './facts'
import { buildFact, factCuts } from './engine'
import { CAMPAIGNS, campaignAttributionClause, campaignById, etMidnightUtcMs } from '../campaigns'
import * as campaigns from '../campaigns'
import { SPEND_SUMMARY_SQL } from '../adsStore'

const NOW = Date.parse('2026-09-26T21:00:00Z')
const SAMPLE_PARAMS: Record<FactId, FactParams[]> = {
  campaignPathVisitor: CAMPAIGNS.map((c) => ({ campaignId: c.id })),
  campaignReturns: CAMPAIGNS.map((c) => ({ campaignId: c.id })),
  flightPathsSeen: CAMPAIGNS.filter((c) => c.flightStart).map((c) => ({ campaignId: c.id })),
  bskKpiDays: [{ todayEt: '2026-09-26' }],
  bskRangePath: [{ since: '2026-09-20', until: '2026-09-26' }],
  popupRangePath: [
    { since: '2026-09-20', until: '2026-09-26', sites: [] },
    { since: '2026-09-20T00:00:00Z', until: '2026-09-26T12:00:00Z', sites: ['bestsudoku', 'bestsudoku-web'] },
  ],
  bskFirstHit: [{}],
  bskReleaseSides: [{ releaseDateEt: '2026-09-26', days: 2 }],
  adsSpend: [{}],
  adsCoverage: [{}],
  adsLastSync: [{}],
}
const ALL = (Object.keys(FACTS) as FactId[]).flatMap((id) => SAMPLE_PARAMS[id].map((p) => ({ id, p, stmt: buildFact({ id, params: p }, NOW) })))

/** The SELECT list, split on top-level commas. */
function selectItems(sql: string): string[] {
  const m = /^SELECT (.*?) FROM /s.exec(sql)
  if (!m) throw new Error('not a SELECT: ' + sql)
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of m[1]) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out.map((s) => s.replace(/\s+AS\s+[a-z_]+$/i, ''))
}
const AGGREGATE = /^(COUNT|SUM|MIN|MAX)\((\*|[a-z_]+)\)$/i
/** A CASE over `ts` bands only (a segment or a KPI day index): once every `ts >= ?` / `ts < ?`
 * comparison is removed, nothing but CASE syntax and integers may remain — the value selected is
 * a small integer, never the timestamp or any other column. */
function isBandCase(item: string): boolean {
  if (!/^CASE .* END$/s.test(item)) return false
  const rest = item.replace(/\bts (>=|<) \?/g, 'B')
  return /^(CASE|WHEN|THEN|ELSE|END|AND|B|-?\d+|\s)+$/.test(rest)
}

describe('every fact is an anonymous aggregate', () => {
  // The ads store's facts read gss-stats' own records (spend, sync runs), never a beacon row.
  it.each(ALL.filter((x) => x.stmt.db === 'gss_stats_ads').map((x) => [x.id, x] as const))('%s reads only the ads store', (_name, { stmt }) => {
    expect(stmt.sql).not.toMatch(/\bhits\b/)
    expect(stmt.sql).toMatch(/\bFROM (ads_daily_metrics|ads_sync_runs)\b/)
  })
  it.each(ALL.filter((x) => x.stmt.db === 'gss_geo').map((x) => [`${x.id} ${JSON.stringify(x.p)}`, x] as const))('%s', (_name, { stmt }) => {
    const sql = stmt.sql
    expect(sql).not.toMatch(/\bJOIN\b/i)
    expect(sql).not.toMatch(/\bUNION\b/i)
    expect(sql).not.toMatch(/\bid\b/) // never the row id (campaign_id is a stored-spend column)
    expect(sql.match(/\bSELECT\b/gi)?.length).toBe(1) // no subquery
    const items = selectItems(sql)
    const grouped = /\bGROUP BY\b/i.test(sql)
    expect(items.some((i) => AGGREGATE.test(i))).toBe(true)
    if (!grouped) expect(items.every((i) => /^(MIN|MAX)\(/i.test(i))).toBe(true)
    for (const item of items) {
      if (AGGREGATE.test(item)) continue
      if (isBandCase(item)) continue // a segment or day index, never a raw ts
      if (item === '(ts >= ?)' || item === '0') continue // a boolean split (install fix, upsell fix, release side) or no segments
      if (item === COUNTRY_BUCKET_SQL) continue // US / CA / other, literal outputs only
      expect(item, `select item "${item}"`).toMatch(/^[a-z_]+$/)
      expect(['ts', 'id']).not.toContain(item)
    }
  })

  it('binds are only numbers and strings (validated values, never SQL)', () => {
    for (const { stmt } of ALL) for (const b of stmt.binds) expect(['number', 'string']).toContain(typeof b)
  })
  it('the band-CASE check refuses a raw ts, any other column and any other expression inside a CASE', () => {
    expect(isBandCase('CASE WHEN ts >= ? AND ts < ? THEN 0 WHEN ts >= ? THEN 1 ELSE -1 END')).toBe(true)
    expect(isBandCase('CASE WHEN ts >= ? THEN ts ELSE 0 END')).toBe(false)
    expect(isBandCase('CASE WHEN ts >= ? THEN id ELSE 0 END')).toBe(false)
    expect(isBandCase('CASE WHEN ts >= ? THEN path ELSE 0 END')).toBe(false)
    expect(isBandCase('CASE WHEN ts % 7 >= ? THEN 1 ELSE 0 END')).toBe(false)
    expect(isBandCase('ts')).toBe(false)
  })
  it('D1 allows 100 bound values per statement; every fact stays well under', () => {
    for (const { stmt } of ALL) expect(stmt.binds.length).toBeLessThanOrEqual(60)
  })
})

describe('SQL segments and KPI days are the rule the engine used to apply per row', () => {
  // Rows around every cut and day boundary; the statement's d/s must equal the JS rule on the
  // row's minute bucket start: d = the KPI day window it falls in, s = how many cuts it reached.
  it('bskKpiDays', () => {
    const db = new DatabaseSync(':memory:')
    db.exec("CREATE TABLE hits (id INTEGER PRIMARY KEY, ts INTEGER, site TEXT DEFAULT 'bestsudoku-web', path TEXT DEFAULT '/', referrer TEXT DEFAULT '', region TEXT DEFAULT '', city TEXT DEFAULT '', org TEXT DEFAULT '', device TEXT DEFAULT '', browser TEXT DEFAULT '', os TEXT DEFAULT '', screenw INTEGER DEFAULT 0, visitor TEXT DEFAULT 'new', medium TEXT DEFAULT '', campaign TEXT DEFAULT '')")
    const cuts = factCuts('bskKpiDays')
    expect(cuts.length).toBeGreaterThan(0)
    const windows = kpiDayWindows('2026-09-26', NOW)
    const probes = new Set<number>()
    for (const x of [...cuts, ...windows.flat()]) for (const d of [-60_001, -60_000, -1, 0, 1, 59_999, 60_000]) probes.add(x + d)
    const ins = db.prepare('INSERT INTO hits (ts, path) VALUES (?, ?)')
    for (const ts of probes) ins.run(ts, `/p${ts}`) // one path per probe, so each group is one row
    const stmt = buildFact({ id: 'bskKpiDays', params: { todayEt: '2026-09-26' } }, NOW)
    const rows = db.prepare(stmt.sql).all(...(stmt.binds as number[])) as { d: number; s: number; path: string; c: number }[]
    let checked = 0
    for (const ts of probes) {
      const b = Math.floor(ts / 60_000) * 60_000
      const d = windows.findIndex(([a, z]) => b >= a && b < z)
      const row = rows.find((r) => r.path === `/p${ts}`)
      if (d < 0 || ts >= NOW || ts < etMidnightUtcMs('2026-09-19')) {
        expect(row, `ts ${ts}`).toBeUndefined() // outside every window (or outside the WHERE)
        continue
      }
      expect(row, `ts ${ts}`).toBeDefined()
      expect(row!.d).toBe(d)
      expect(row!.s).toBe(cuts.filter((c) => c <= b).length)
      checked++
    }
    expect(checked).toBeGreaterThan(20)
  })
})

describe('each fact runs on SQLite and reuses the endpoint clause helpers', () => {
  function geoDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    db.exec(
      "CREATE TABLE hits (id INTEGER PRIMARY KEY, ts INTEGER, site TEXT DEFAULT '', path TEXT DEFAULT '', referrer TEXT DEFAULT '', country TEXT DEFAULT '', region TEXT DEFAULT '', city TEXT DEFAULT '', org TEXT DEFAULT '', device TEXT DEFAULT '', browser TEXT DEFAULT '', os TEXT DEFAULT '', screenw INTEGER DEFAULT 0, visitor TEXT DEFAULT 'new', source TEXT DEFAULT '', medium TEXT DEFAULT '', campaign TEXT DEFAULT '')",
    )
    db.exec('CREATE TABLE ads_daily_metrics (campaign_id TEXT, date TEXT, cost_micros INTEGER, impressions INTEGER, clicks INTEGER, fetched_at TEXT)')
    db.exec('CREATE TABLE ads_sync_runs (campaigns_ok TEXT, finished_at TEXT, status TEXT)')
    return db
  }
  it.each(ALL.map((x) => [`${x.id} ${JSON.stringify(x.p)}`, x] as const))('%s executes', (_name, { stmt }) => {
    const db = geoDb()
    expect(() => db.prepare(stmt.sql).all(...(stmt.binds as (string | number)[]))).not.toThrow()
  })

  it('campaignReturns leaves out return rows before the campaign\'s attribution start, like the arrivals tile; no upper bound', () => {
    const retest = campaignById('24279250691')! // flight 2026-09-26, schedule starts 12:00 ET
    const start = Date.parse('2026-09-26T16:00:00Z') // 12:00 EDT
    const db = geoDb()
    const ins = db.prepare("INSERT INTO hits (ts, site, path) VALUES (?, 'bestsudoku-web', ?)")
    ins.run(start - 60_000, '/return/sudoku_funnel_retest/d0') // 11:59 ET: pre-launch test
    ins.run(start - 3_600_000, '/return/sudoku_funnel_retest/d1') // pre-launch
    ins.run(start, '/return/sudoku_funnel_retest/d0') // exactly at the start: counts
    ins.run(start + 40 * 86_400_000, '/return/sudoku_funnel_retest/d31-60') // long after the flight: counts
    const stmt = FACTS.campaignReturns.build({ campaignId: retest.id }, NOW)
    const rows = db.prepare(stmt.sql).all(...(stmt.binds as (string | number)[])) as { path: string; c: number }[]
    expect(rows.map((r) => `${r.path}:${r.c}`).sort()).toEqual(['/return/sudoku_funnel_retest/d0:1', '/return/sudoku_funnel_retest/d31-60:1'])
  })
  it('campaignReturns attributes nothing while a campaign has no confirmed flightStart', () => {
    const retest = campaignById('24279250691')!
    const spy = vi.spyOn(campaigns, 'campaignById').mockReturnValue({ ...retest, flightStart: null })
    try {
      const db = geoDb()
      db.prepare("INSERT INTO hits (ts, site, path) VALUES (?, 'bestsudoku-web', ?)").run(Date.parse('2026-09-27T16:00:00Z'), '/return/sudoku_funnel_retest/d0')
      const stmt = FACTS.campaignReturns.build({ campaignId: retest.id }, NOW)
      expect(stmt.sql).toContain('1 = 0')
      expect(db.prepare(stmt.sql).all(...(stmt.binds as (string | number)[]))).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
  it('campaignPathVisitor carries campaignAttributionClause verbatim (flightStartTimeEt included)', () => {
    const retest = campaignById('24279250691')!
    const stmt = buildFact({ id: 'campaignPathVisitor', params: { campaignId: retest.id } }, NOW)
    const attr = campaignAttributionClause(retest)
    expect(stmt.sql).toContain(attr.sql)
    expect(stmt.binds.slice(1, 1 + attr.binds.length)).toEqual(attr.binds) // after the pf instant
  })
  it('the flightPathsSeen fact builds flightPathsSeenStatement', () => {
    const c = campaignById('24215315197')!
    expect(FACTS.flightPathsSeen.build({ campaignId: c.id }, NOW)).toEqual(flightPathsSeenStatement(c))
  })
  it('adsSpend is the stored-spend summary the endpoints read (lib/adsStore.ts)', () => {
    expect(FACTS.adsSpend.build({}, NOW).sql).toBe(SPEND_SUMMARY_SQL)
  })
  it('a campaign fact refuses an unknown campaign (never builds SQL for it)', () => {
    expect(() => FACTS.campaignPathVisitor.build({ campaignId: '1 OR 1=1' }, NOW)).toThrow(/known campaignId/)
  })
})

describe('fact identity', () => {
  it('factKey keeps only the params the fact keys on', () => {
    expect(factKey('campaignPathVisitor', { campaignId: '24215315197', since: '2026-09-01', until: '2026-09-02', sites: ['x'] })).toEqual({ id: 'campaignPathVisitor', params: { campaignId: '24215315197' } })
    expect(factKey('popupRangePath', { campaignId: 'x', since: 'a', until: 'b', sites: [] })).toEqual({ id: 'popupRangePath', params: { since: 'a', until: 'b', sites: [] } })
    expect(factKey('adsSpend', { campaignId: 'x' })).toEqual({ id: 'adsSpend', params: {} })
  })
  it('rangeMs reads bare dates as ET days (until inclusive) and datetimes as given, UTC without a zone', () => {
    expect(rangeMs('2026-09-20', '2026-09-26')).toEqual([Date.parse('2026-09-20T04:00:00Z'), Date.parse('2026-09-27T04:00:00Z')])
    expect(rangeMs('2026-12-20', '2026-12-26')).toEqual([Date.parse('2026-12-20T05:00:00Z'), Date.parse('2026-12-27T05:00:00Z')]) // EST
    expect(rangeMs('2026-09-20T00:00:00Z', '2026-09-26T12:00:00Z')).toEqual([Date.parse('2026-09-20T00:00:00Z'), Date.parse('2026-09-26T12:00:00Z')])
    expect(rangeMs('2026-09-20T00:00', '2026-09-26T12:00:00.500')).toEqual([Date.parse('2026-09-20T00:00:00Z'), Date.parse('2026-09-26T12:00:00.500Z')])
  })
})

describe('fact SQL snapshots', () => {
  it.each(ALL.map((x) => [`${x.id} ${JSON.stringify(x.p)}`, x] as const))('%s', (_name, { stmt }) => {
    expect(stmt).toMatchSnapshot()
  })
})
