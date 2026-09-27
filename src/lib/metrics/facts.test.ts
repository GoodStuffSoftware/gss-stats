// Facts are the only SQL the registry runs. Every statement must be an anonymous aggregate
// (ADR 0003 section 3, rule 6): COUNT/SUM/MIN/MAX with GROUP BY (or a bare MIN/MAX), no JOIN,
// no `id`, and no raw `ts` — only minute/hour buckets and the boolean install-fix split. Each is
// also run against a real SQLite (node:sqlite, D1's dialect) and snapshotted, so any change to a
// statement is a reviewed diff.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { FACTS, factKey, flightPathsSeenStatement, rangeMs, type FactId, type FactParams } from './facts'
import { CAMPAIGNS, campaignAttributionClause, campaignById } from '../campaigns'
import { SPEND_SUMMARY_SQL } from '../adsStore'

const NOW = Date.parse('2026-09-26T21:00:00Z')
const SAMPLE_PARAMS: Record<FactId, FactParams[]> = {
  campaignPathVisitor: CAMPAIGNS.map((c) => ({ campaignId: c.id })),
  campaignReturns: CAMPAIGNS.map((c) => ({ campaignId: c.id })),
  flightPathsSeen: CAMPAIGNS.filter((c) => c.flightStart).map((c) => ({ campaignId: c.id })),
  bskKpiMinutes: [{ todayEt: '2026-09-26' }],
  bskHourPath: [{ since: '2026-09-20', until: '2026-09-26' }],
  popupHourPath: [
    { since: '2026-09-20', until: '2026-09-26', sites: [] },
    { since: '2026-09-20T00:00:00Z', until: '2026-09-26T12:00:00Z', sites: ['bestsudoku', 'bestsudoku-web'] },
  ],
  adsSpend: [{}],
}
const ALL = (Object.keys(FACTS) as FactId[]).flatMap((id) => SAMPLE_PARAMS[id].map((p) => ({ id, p, stmt: FACTS[id].build(p, NOW) })))

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
const BUCKET = /^CAST\(ts \/ (\d+) AS INTEGER\)$/

describe('every fact is an anonymous aggregate', () => {
  it.each(ALL.map((x) => [`${x.id} ${JSON.stringify(x.p)}`, x] as const))('%s', (_name, { stmt }) => {
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
      const bucket = BUCKET.exec(item)
      if (bucket) {
        expect(Number(bucket[1])).toBeGreaterThanOrEqual(60_000) // a minute or coarser, never a raw ts
        continue
      }
      if (item === '(ts >= ?)' || item === '0') continue // the boolean install-fix split
      expect(item, `select item "${item}"`).toMatch(/^[a-z_]+$/)
      expect(['ts', 'id']).not.toContain(item)
    }
  })

  it('binds are only numbers and strings (validated values, never SQL)', () => {
    for (const { stmt } of ALL) for (const b of stmt.binds) expect(['number', 'string']).toContain(typeof b)
  })
})

describe('each fact runs on SQLite and reuses the endpoint clause helpers', () => {
  function geoDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    db.exec(
      "CREATE TABLE hits (id INTEGER PRIMARY KEY, ts INTEGER, site TEXT DEFAULT '', path TEXT DEFAULT '', referrer TEXT DEFAULT '', country TEXT DEFAULT '', region TEXT DEFAULT '', city TEXT DEFAULT '', org TEXT DEFAULT '', device TEXT DEFAULT '', browser TEXT DEFAULT '', os TEXT DEFAULT '', screenw INTEGER DEFAULT 0, visitor TEXT DEFAULT 'new', source TEXT DEFAULT '', medium TEXT DEFAULT '', campaign TEXT DEFAULT '')",
    )
    db.exec('CREATE TABLE ads_daily_metrics (campaign_id TEXT, date TEXT, cost_micros INTEGER, impressions INTEGER, clicks INTEGER, fetched_at TEXT)')
    return db
  }
  it.each(ALL.map((x) => [`${x.id} ${JSON.stringify(x.p)}`, x] as const))('%s executes', (_name, { stmt }) => {
    const db = geoDb()
    expect(() => db.prepare(stmt.sql).all(...(stmt.binds as (string | number)[]))).not.toThrow()
  })

  it('campaignPathVisitor carries campaignAttributionClause verbatim (flightStartTimeEt included)', () => {
    const retest = campaignById('24279250691')!
    const stmt = FACTS.campaignPathVisitor.build({ campaignId: retest.id }, NOW)
    const attr = campaignAttributionClause(retest)
    expect(stmt.sql).toContain(attr.sql)
    expect(stmt.binds.slice(1, 1 + attr.binds.length)).toEqual(attr.binds) // after the pf instant
  })
  it('flightPathsSeen is exactly the statement functions/_lib/campaignInstrumentation.ts runs', () => {
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
    expect(factKey('popupHourPath', { campaignId: 'x', since: 'a', until: 'b', sites: [] })).toEqual({ id: 'popupHourPath', params: { since: 'a', until: 'b', sites: [] } })
    expect(factKey('adsSpend', { campaignId: 'x' })).toEqual({ id: 'adsSpend', params: {} })
  })
  it('rangeMs reads a bare until as inclusive, like /api/popups and /api/overview', () => {
    expect(rangeMs('2026-09-20', '2026-09-26')).toEqual([Date.parse('2026-09-20'), Date.parse('2026-09-27')])
    expect(rangeMs('2026-09-20T00:00:00Z', '2026-09-26T12:00:00Z')).toEqual([Date.parse('2026-09-20T00:00:00Z'), Date.parse('2026-09-26T12:00:00Z')])
  })
})

describe('fact SQL snapshots', () => {
  it.each(ALL.map((x) => [`${x.id} ${JSON.stringify(x.p)}`, x] as const))('%s', (_name, { stmt }) => {
    expect(stmt).toMatchSnapshot()
  })
})
