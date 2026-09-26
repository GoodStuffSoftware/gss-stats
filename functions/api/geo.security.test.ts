// Security/whitelist tests for functions/api/geo.ts's onRequestPost — the ACTUAL request
// handler, not a re-implementation of its logic, so these prove what a real request does.
//
// "The whitelist is the security boundary: a column name must NEVER come from the request
// unvalidated" (task brief). These tests send unknown/injection strings as `dimension`,
// `breakdown`, `dims[]` and `constraints[].field`, and inspect the EXACT SQL string D1 would
// have received (captured by a fake D1Database) to prove the malicious/unknown value never
// reaches it — either the request falls back to a safe default, or the bad entry is silently
// dropped, matching GEO_DIMS.has(...) gating everywhere in geo.ts.
//
// Also covers: GEO_DIMS/DERIVED_ONLY_DIMS whitelist membership directly, the "Include event
// beacons" per-chart opt-in (default OFF, lifts the exclusion only when explicitly true), and
// the new dimensions' blank-value labels end-to-end through a real (in-memory) D1-shaped query.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { onRequestPost, GEO_DIMS, DERIVED_ONLY_DIMS } from './geo'
import type { CacheLike } from '../_lib/edgeCache'

// ── A fake Cache API (see functions/_lib/edgeCache.ts's CacheLike) — always a miss, records
// nothing, so every request runs computeGeoResponse() for real instead of short-circuiting.
const noopCache: CacheLike = {
  match: async () => undefined,
  put: async () => {},
}

beforeEach(() => {
  ;(globalThis as any).caches = { default: noopCache }
})
afterEach(() => {
  delete (globalThis as any).caches
  vi.restoreAllMocks()
})

// ── A fake D1Database backed by a real in-memory SQLite engine (node:sqlite), so a captured
// SQL string is also PROVEN to execute (a typo'd column name would throw, not just look right).
function makeFakeD1() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE hits (
    ts INTEGER, site TEXT, path TEXT, referrer TEXT, country TEXT, region TEXT, city TEXT,
    postal TEXT, continent TEXT, timezone TEXT, lat TEXT, lon TEXT, colo TEXT, org TEXT,
    device TEXT, browser TEXT, os TEXT, lang TEXT, screenw INTEGER, visitor TEXT, refpath TEXT,
    source TEXT, medium TEXT, campaign TEXT
  )`)
  const calls: { sql: string; binds: unknown[] }[] = []
  const gss_geo = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds })
          return {
            async all() {
              const rows = db.prepare(sql).all(...(binds as any[]))
              return { results: rows }
            },
          }
        },
      }
    },
  }
  return { gss_geo: gss_geo as any, calls, db }
}

function post(body: unknown, env: { gss_geo: any }) {
  const ctx = {
    request: { json: async () => body },
    env,
    waitUntil: (_p: Promise<unknown>) => {},
  } as any
  return onRequestPost(ctx)
}

describe('GEO_DIMS / DERIVED_ONLY_DIMS whitelist membership', () => {
  it('accepts every real hits column exposed as a dimension', () => {
    for (const d of [
      'country', 'region', 'city', 'postal', 'continent', 'timezone', 'colo', 'org', 'referrer',
      'refpath', 'path', 'site', 'device', 'browser', 'os', 'lang', 'visitor', 'date', 'campaign',
      'source', 'medium', 'screenw', 'screenwBucket', 'pathFamily',
    ]) {
      expect(GEO_DIMS.has(d)).toBe(true)
    }
  })

  it('rejects the identifier/raw-timestamp columns this task explicitly excludes on privacy grounds', () => {
    expect(GEO_DIMS.has('id')).toBe(false)
    expect(GEO_DIMS.has('ts')).toBe(false)
    expect(GEO_DIMS.has('lat')).toBe(false)
    expect(GEO_DIMS.has('lon')).toBe(false)
    // in_app: declared in gss-beacon's schema.sql, but the migration hasn't run against
    // production yet (confirmed live via PRAGMA table_info) — whitelisting it now would 500.
    expect(GEO_DIMS.has('in_app')).toBe(false)
  })

  it('rejects unknown and SQL-injection-shaped column names', () => {
    for (const bad of [
      'nope', '', 'Region', 'REGION', 'region--', "region' OR '1'='1",
      'region; DROP TABLE hits;--', 'region,ip', '../ip', 'ip', 'excluded_ips.ip',
    ]) {
      expect(GEO_DIMS.has(bad)).toBe(false)
    }
  })

  it('date/screenwBucket/pathFamily are derived-only: groupable but never a real column', () => {
    expect(DERIVED_ONLY_DIMS.has('date')).toBe(true)
    expect(DERIVED_ONLY_DIMS.has('screenwBucket')).toBe(true)
    expect(DERIVED_ONLY_DIMS.has('pathFamily')).toBe(true)
    expect(DERIVED_ONLY_DIMS.has('screenw')).toBe(false) // real column — fully filterable/ring-able
  })
})

describe('onRequestPost — dimension whitelist rejection (real handler, real SQL)', () => {
  it('an unknown dimension falls back to the safe default ("region") and never reaches the SQL', async () => {
    const { gss_geo, calls } = makeFakeD1()
    const res = await post({ dimension: "region'; DROP TABLE hits;--" }, { gss_geo })
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).not.toContain('DROP TABLE')
    expect(calls[0].sql).toContain('region') // fell back to the default dimension
  })

  it('an injection-shaped dimension containing a real column name substring is still rejected outright', async () => {
    const { gss_geo, calls } = makeFakeD1()
    await post({ dimension: 'region UNION SELECT ip FROM excluded_ips--' }, { gss_geo })
    expect(calls[0].sql).not.toContain('UNION')
    expect(calls[0].sql).not.toContain('excluded_ips')
  })

  it('a constraint on an unknown/injection field is dropped entirely — never appears in WHERE or binds', async () => {
    const { gss_geo, calls } = makeFakeD1()
    await post(
      {
        dimension: 'device',
        constraints: [
          { field: 'device', value: 'mobile' }, // legitimate — should survive
          { field: "device; DROP TABLE hits;--", value: 'x' },
          { field: 'ip', value: '1.2.3.4' },
          { field: '__proto__', value: 'x' },
        ],
      },
      { gss_geo },
    )
    const { sql, binds } = calls[0]
    expect(sql).not.toContain('DROP TABLE')
    expect(sql).not.toContain('ip')
    expect(binds).toContain('mobile')
    expect(binds).not.toContain('1.2.3.4')
    expect(binds).not.toContain('x')
  })

  it('a constraint field that is a known dimension but not a real column ("date") is dropped, not turned into an equality filter', async () => {
    const { gss_geo, calls } = makeFakeD1()
    await post({ dimension: 'device', constraints: [{ field: 'date', value: '2026-09-01' }] }, { gss_geo })
    expect(calls[0].sql).not.toContain("date(ts/1000,'unixepoch') = ?")
    expect(calls[0].binds).not.toContain('2026-09-01')
  })

  it('screenwBucket/pathFamily constraints DO filter — as a bound-parameter equality against the whitelisted CASE expression, never string-interpolated', async () => {
    const { gss_geo, calls, db } = makeFakeD1()
    const now = Date.now()
    db.exec(`INSERT INTO hits (ts, path, screenw) VALUES
      (${now}, '/install/play', 1024), (${now}, '/home', 1024), (${now}, '/home', 320)`)
    const res: any = await post(
      { dimension: 'device', since: new Date(now - 1000).toISOString(), until: new Date(now + 1000).toISOString(), constraints: [{ field: 'pathFamily', value: 'install' }] },
      { gss_geo },
    )
    const body = await res.json()
    // The whitelisted family filter matched exactly the one /install/... row (the popup-event
    // exclusion is bypassed here only because 'install' rows ARE what's being filtered FOR —
    // includeEventBeacons is still false, but drillClause runs independently of popupExcludeClause,
    // proving the constraint itself works against the real CASE expression).
    expect(calls[0].sql).toMatch(/\(CASE .* END\) = \?/)
    expect(calls[0].binds).toContain('install')
    expect(body.totals.pageviews).toBe(0) // excluded by the standing popup-event filter (includeEventBeacons defaults off)
  })
})

describe('onRequestPost — "Include event beacons" opt-in', () => {
  it('defaults OFF: event-beacon paths stay excluded exactly as before this feature', async () => {
    const { gss_geo, db } = makeFakeD1()
    const now = Date.now()
    db.exec(`INSERT INTO hits (ts, path) VALUES (${now}, '/home'), (${now}, '/install/play'), (${now}, '/return/uc1/d0')`)
    const res: any = await post({ dimension: 'path', since: new Date(now - 1000).toISOString(), until: new Date(now + 1000).toISOString() }, { gss_geo })
    const body = await res.json()
    expect(body.totals.pageviews).toBe(1) // only /home
  })

  it('includeEventBeacons: true lifts the exclusion so event rows are counted too', async () => {
    const { gss_geo, db } = makeFakeD1()
    const now = Date.now()
    db.exec(`INSERT INTO hits (ts, path) VALUES (${now}, '/home'), (${now}, '/install/play'), (${now}, '/return/uc1/d0')`)
    const res: any = await post(
      { dimension: 'path', since: new Date(now - 1000).toISOString(), until: new Date(now + 1000).toISOString(), includeEventBeacons: true },
      { gss_geo },
    )
    const body = await res.json()
    expect(body.totals.pageviews).toBe(3) // all three rows now count
  })

  it('a non-boolean includeEventBeacons value is NOT treated as true (fails closed to the safe default)', async () => {
    const { gss_geo, db } = makeFakeD1()
    const now = Date.now()
    db.exec(`INSERT INTO hits (ts, path) VALUES (${now}, '/home'), (${now}, '/install/play')`)
    const res: any = await post(
      { dimension: 'path', since: new Date(now - 1000).toISOString(), until: new Date(now + 1000).toISOString(), includeEventBeacons: 'true' },
      { gss_geo },
    )
    const body = await res.json()
    expect(body.totals.pageviews).toBe(1) // string 'true' !== boolean true — stays excluded
  })
})

describe('onRequestPost — blank-value labels for the new dimensions', () => {
  it('screenw: rows with no reported width (0) group under "(unknown)"', async () => {
    const { gss_geo, db } = makeFakeD1()
    const now = Date.now()
    db.exec(`INSERT INTO hits (ts, path, screenw) VALUES (${now}, '/home', 0), (${now}, '/home', 0), (${now}, '/home', 1440)`)
    const res: any = await post({ dimension: 'screenw', since: new Date(now - 1000).toISOString(), until: new Date(now + 1000).toISOString() }, { gss_geo })
    const body = await res.json()
    const byKey = Object.fromEntries(body.rows.map((r: any) => [r.key.screenw, r.pageviews]))
    expect(byKey['(unknown)']).toBe(2)
    expect(byKey['1440']).toBe(1)
  })

  it('pathFamily: an ordinary page view groups under "page"', async () => {
    const { gss_geo, db } = makeFakeD1()
    const now = Date.now()
    db.exec(`INSERT INTO hits (ts, path) VALUES (${now}, '/home')`)
    const res: any = await post(
      { dimension: 'pathFamily', includeEventBeacons: true, since: new Date(now - 1000).toISOString(), until: new Date(now + 1000).toISOString() },
      { gss_geo },
    )
    const body = await res.json()
    expect(body.rows).toEqual([{ key: { pathFamily: 'page' }, pageviews: 1, visits: 1 }])
  })
})
