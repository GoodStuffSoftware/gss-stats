// Bind-free clauses vs the bound clauses they replaced (the D1 bind-headroom fix), on a REAL
// SQLite engine (node:sqlite, D1's dialect). Three registry-driven clauses used to bind their
// values (the campaign uc list, the game-completion prefix, the own-hosts list) and the metrics
// facts used to bind their segment cuts; each now inlines checked literals, so a statement's bind
// count no longer grows with the campaign registry (functions/api/bindHeadroom.test.ts holds that).
// This file proves the change moved no row:
//   1. clause by clause, the literal form selects exactly the rows the bound form selected;
//   2. through the real /api/geo handler, a request set answers identically with the OLD clause
//      functions swapped back in (frozen copies of the pre-change source) and with the new ones;
//   3. the segment cuts of a metrics fact give the same rows as bound cuts;
//   4. counts only: every hour, place and device split of those shapes still returns nothing when
//      the table holds only refused rows (/return, game-complete, tutorial-complete, game-start,
//      tour skip and tour exit, every pattern), and still counts ordinary rows;
//   5. the literal helper refuses quotes, and every registered uc value and own host passes it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openHitsDb, insertHits, sqliteD1, pagesContext, postJson, type HitRow } from '../_lib/testing/hitsDb'
import { CAMPAIGNS, campaignFlightPrefilter, gameDimPrefilter } from '../../src/lib/campaigns'
import { OWN_HOSTS, selfReferralClause } from '../../src/lib/ownExclusion'
import { sqlLit } from '../../src/lib/popupEvents'
import { SPLIT_REFUSED_DIMS, SPLIT_REFUSED_PATH_PATTERNS, isSplitRefusedPath } from '../../src/lib/splitGuard'
import { buildFact } from '../../src/lib/metrics/engine'

// ── Fixture ────────────────────────────────────────────────────────────────────────────
const T = Date.parse('2026-09-28T15:00:00Z') // inside the retest flight (sudoku_funnel_retest)
const range = { since: '2026-09-27', until: '2026-09-30' }

// Every refused shape: each registered pattern as a prefix row and a deeper row (or the exact path), the
// tour paths named out loud, and an upper-case variant (SQLite LIKE ignores ASCII case).
const REFUSED = [
  ...SPLIT_REFUSED_PATH_PATTERNS.flatMap((p) => (p.endsWith('%') ? [`${p.slice(0, -1)}x`, `${p.slice(0, -1)}a/b`] : [p])),
  '/tour/exit-at', '/tour/exit-at/3', '/tour/skip', '/tour/skip/later', '/RETURN/x/d0', '/Game/Complete/normal/easy',
]
// Neighbours of the refused families that are ordinary page views: none may be dropped.
const ORDINARY = ['/', '/game', '/game/first-move', '/tour/start', '/tour/complete', '/tour/skipped', '/tour/skip-all', '/settings']
const CAMPAIGN_TAGS = ['', 'sudoku_funnel_retest', 'tired_of_ads', 'launch_2026', 'sudoku_funnel_f2_apps', 'unrelated_beta']
const REFERRERS = ['', 'google.com', ...OWN_HOSTS, 'goodstuff.software.evil.com', 'WWW.GOODSTUFF.SOFTWARE', 'bestsudoku.app.example']
const UC_COUNT = new Set(CAMPAIGNS.flatMap((c) => c.ucValues)).size

function seed(db: DatabaseSync, paths: string[]): number {
  const rows: HitRow[] = []
  paths.forEach((path, pi) =>
    CAMPAIGN_TAGS.forEach((campaign, ci) =>
      REFERRERS.forEach((referrer, ri) => {
        const k = pi + ci + ri
        rows.push({
          ts: T + (k % 5) * 3_600_000, site: 'bestsudoku-web', path, referrer, campaign,
          country: 'US', region: k % 2 ? 'Ohio' : 'Texas', city: 'Columbus', postal: '43215', continent: 'NA',
          timezone: 'America/New_York', colo: 'EWR', org: 'Acme ISP', device: k % 2 ? 'mobile' : 'desktop',
          browser: 'Chrome', os: 'Android', lang: 'en', screenw: 390, visitor: k % 3 ? 'new' : 'returning',
        })
      }),
    ),
  )
  insertHits(db, rows)
  return rows.length
}
const ids = (db: DatabaseSync, where: string, binds: unknown[] = []) =>
  (db.prepare(`SELECT id FROM hits WHERE ${where} ORDER BY id`).all(...(binds as any[])) as { id: number }[]).map((r) => r.id)

// ── Frozen copies of the pre-change clause builders (the bound forms) ────────────────────
function legacyCampaignFlightPrefilter(w: string[], b: unknown[]): void {
  const ucs = [...new Set(CAMPAIGNS.flatMap((c) => c.ucValues))]
  w.push(`campaign IN (${ucs.map(() => '?').join(', ')})`)
  b.push(...ucs)
}
function legacyGameDimPrefilter(w: string[], b: unknown[]): void {
  w.push('path LIKE ?')
  b.push('/game/complete/%')
}
function legacySelfReferralClause(activeDims: string[], w: string[], b: unknown[], excludeSelf: boolean): void {
  if (!excludeSelf || !activeDims.includes('referrer')) return
  w.push(`referrer <> ''`)
  w.push(`referrer NOT IN (${OWN_HOSTS.map(() => '?').join(', ')})`)
  b.push(...OWN_HOSTS)
}

let db: DatabaseSync
beforeEach(() => {
  db = openHitsDb()
})
afterEach(() => {
  db.close()
  vi.doUnmock('../../src/lib/campaigns')
  vi.doUnmock('../../src/lib/ownExclusion')
  vi.resetModules()
  delete (globalThis as any).caches
})

describe('clause parity: literal form selects the rows the bound form selected', () => {
  beforeEach(() => {
    seed(db, [...REFUSED, ...ORDINARY])
  })

  it('campaign uc list', () => {
    const [nw, nb] = [[] as string[], [] as unknown[]]
    const [lw, lb] = [[] as string[], [] as unknown[]]
    campaignFlightPrefilter(nw, nb)
    legacyCampaignFlightPrefilter(lw, lb)
    expect(nb).toEqual([]) // binds nothing
    expect(nw[0]).not.toContain('?')
    const [got, want] = [ids(db, nw[0]), ids(db, lw[0], lb)]
    expect(got).toEqual(want)
    const all = ids(db, '1 = 1').length
    expect(want.length).toBeGreaterThan(0)
    expect(want.length).toBeLessThan(all) // the clause really filters
  })

  it('game-completion prefix', () => {
    const [nw, nb] = [[] as string[], [] as unknown[]]
    const [lw, lb] = [[] as string[], [] as unknown[]]
    gameDimPrefilter(nw, nb)
    legacyGameDimPrefilter(lw, lb)
    expect(nb).toEqual([])
    expect(nw[0]).not.toContain('?')
    const [got, want] = [ids(db, nw[0]), ids(db, lw[0], lb)]
    expect(got).toEqual(want)
    expect(want.length).toBeGreaterThan(0)
    expect(want.length).toBeLessThan(ids(db, '1 = 1').length)
  })

  it('own-hosts exclusion (only when the chart groups by referrer, and only when on)', () => {
    for (const [dims, on] of [[['referrer'], true], [['referrer', 'region'], true], [['region'], true], [['referrer'], false]] as [string[], boolean][]) {
      const [nw, nb] = [[] as string[], [] as unknown[]]
      const [lw, lb] = [[] as string[], [] as unknown[]]
      selfReferralClause(dims, nw, nb, on)
      legacySelfReferralClause(dims, lw, lb, on)
      expect(nb).toEqual([])
      const active = dims.includes('referrer') && on
      expect(nw.length).toBe(active ? 2 : 0)
      expect(lw.length).toBe(nw.length)
      const [got, want] = [ids(db, nw.join(' AND ') || '1 = 1'), ids(db, lw.join(' AND ') || '1 = 1', lb)]
      expect(got).toEqual(want)
      if (active) expect(want.length).toBeLessThan(ids(db, '1 = 1').length)
    }
  })
})

describe('handler parity: /api/geo answers identically with the old clauses swapped back in', () => {
  const noCache = { match: async () => undefined, put: async () => {} }
  async function runAll(bodies: Record<string, unknown>[]) {
    ;(globalThis as any).caches = { default: noCache }
    const { onRequestPost } = await import('./geo')
    const out: { status: number; body: any; binds: number }[] = []
    for (const body of bodies) {
      let binds = -1
      const d1 = sqliteD1(db)
      const orig = d1.prepare.bind(d1)
      ;(d1 as any).prepare = (sql: string) => {
        const st = orig(sql) as any
        return { ...st, bind: (...v: unknown[]) => ((binds = v.length), st.bind(...v)) }
      }
      const res = await onRequestPost(pagesContext(postJson('/api/geo', body), { gss_geo: d1 }) as any)
      out.push({ status: res.status, body: await res.json(), binds })
    }
    return out
  }

  // drop = how many fewer binds the new statement carries than the old one (0 when the shape has no changed clause).
  const SHAPES: { name: string; body: Record<string, unknown>; drop: number }[] = [
    { name: 'referrer chart', body: { dimension: 'referrer' }, drop: OWN_HOSTS.length },
    { name: 'referrer x region ring', body: { dimension: 'referrer', dims: ['referrer', 'region'] }, drop: OWN_HOSTS.length },
    { name: 'campaignFlight chart', body: { dimension: 'campaignFlight' }, drop: UC_COUNT },
    { name: 'flightDay chart', body: { dimension: 'flightDay' }, drop: UC_COUNT },
    { name: 'campaignFlight x region ring', body: { dimension: 'campaignFlight', dims: ['campaignFlight', 'region'] }, drop: UC_COUNT },
    { name: 'gameMode chart', body: { dimension: 'gameMode' }, drop: 1 },
    { name: 'gameMode x gameDifficulty ring', body: { dimension: 'gameMode', dims: ['gameMode', 'gameDifficulty'] }, drop: 1 },
    { name: 'four-dim ring', body: { dimension: 'referrer', dims: ['referrer', 'gameMode', 'campaignFlight', 'region'] }, drop: OWN_HOSTS.length + 1 + UC_COUNT },
    { name: 'hourEt x referrer ring', body: { dimension: 'hourEt', dims: ['hourEt', 'referrer'] }, drop: OWN_HOSTS.length },
    { name: 'path chart (no changed clause)', body: { dimension: 'path' }, drop: 0 },
  ]

  it('same status, same body, fewer binds, on every shape and flag combination', async () => {
    const total = seed(db, [...REFUSED, ...ORDINARY])
    expect(total).toBeGreaterThan(1000)
    const bodies: Record<string, unknown>[] = []
    const meta: { name: string; drop: number }[] = []
    for (const s of SHAPES)
      for (const excludeKnownTraffic of [false, true])
        for (const includeEventBeacons of [false, true]) {
          bodies.push({ ...s.body, ...range, limit: 200, excludeKnownTraffic, includeEventBeacons })
          meta.push({ name: `${s.name} (known=${excludeKnownTraffic}, events=${includeEventBeacons})`, drop: s.drop })
        }

    // OLD clauses: the module graph is rebuilt with the frozen bound builders swapped in.
    vi.resetModules()
    vi.doMock('../../src/lib/campaigns', async (orig) => {
      const real = (await orig()) as any
      return {
        ...real,
        campaignFlightPrefilter: (w: string[], b: unknown[]) => {
          const ucs = [...new Set(real.CAMPAIGNS.flatMap((c: any) => c.ucValues))]
          w.push(`campaign IN (${ucs.map(() => '?').join(', ')})`)
          b.push(...ucs)
        },
        gameDimPrefilter: legacyGameDimPrefilter,
      }
    })
    vi.doMock('../../src/lib/ownExclusion', async (orig) => ({ ...((await orig()) as any), selfReferralClause: legacySelfReferralClause }))
    const before = await runAll(bodies)
    vi.doUnmock('../../src/lib/campaigns')
    vi.doUnmock('../../src/lib/ownExclusion')

    // NEW clauses: the real modules.
    vi.resetModules()
    const after = await runAll(bodies)

    let nonEmpty = 0
    bodies.forEach((_, i) => {
      expect(after[i].status, meta[i].name).toBe(before[i].status)
      expect(after[i].body, meta[i].name).toEqual(before[i].body)
      expect(before[i].binds - after[i].binds, meta[i].name).toBe(meta[i].drop)
      if (after[i].body.totals?.pageviews > 0) nonEmpty++
    })
    expect(nonEmpty).toBeGreaterThan(bodies.length / 2) // the comparison is not vacuous
    // The own-host rows really are dropped from the referrer chart, in both forms alike.
    const referrerChart = after[0].body.rows.map((r: any) => r.key.referrer)
    for (const h of OWN_HOSTS) expect(referrerChart).not.toContain(h)
    expect(referrerChart).toContain('google.com')
    expect(referrerChart).toContain('WWW.GOODSTUFF.SOFTWARE') // NOT IN is case-sensitive, as before
  }, 60_000)
})

describe('segment-cut parity: literal cuts give the rows bound cuts gave', () => {
  it('every fact that takes cuts', () => {
    seed(db, [...REFUSED.slice(0, 6), ...ORDINARY])
    const nowMs = Date.parse('2026-09-30T20:00:00Z')
    const cuts = [T - 3_600_000, T + 2 * 3_600_000 + 17, T + 4 * 3_600_000] // between and across the fixture's hours
    const params = { todayEt: '2026-09-30', releaseDateEt: '2026-09-28', days: 2, ownBrowser: 'Opera', ownOS: 'Windows', since: '2026-09-27', until: '2026-09-30' } as any
    let checked = 0
    for (const id of ['bskKpiDays', 'bskRangePath', 'popupRangePath', 'bskReleaseSides'] as const) {
      const stmt = buildFact({ id, params }, nowMs)
      // buildFact derives its own cuts; rebuild the cut CASE as bound parameters from its literals.
      const m = /CASE((?: WHEN ts >= \d+ THEN \d+)+) ELSE 0 END AS s/.exec(stmt.sql)
      if (!m) continue // a fact with no cuts in this registry state selects the constant 0
      const literals = [...m[1].matchAll(/WHEN ts >= (\d+) THEN (\d+)/g)].map((x) => [Number(x[1]), x[2]] as const)
      const bound = stmt.sql.replace(m[0], `CASE${literals.map(([, k]) => ` WHEN ts >= ? THEN ${k}`).join('')} ELSE 0 END AS s`)
      const lead = (stmt.sql.slice(0, m.index).match(/\?/g) ?? []).length // binds that come before the CASE in the text
      const legacyBinds = [...stmt.binds.slice(0, lead), ...literals.map(([x]) => x), ...stmt.binds.slice(lead)]
      expect(stmt.sql).not.toContain('WHEN ts >= ? THEN')
      expect((stmt.sql.match(/\?/g) ?? []).length).toBe(stmt.binds.length)
      expect((bound.match(/\?/g) ?? []).length).toBe(legacyBinds.length)
      const run = (sql: string, binds: unknown[]) => db.prepare(sql).all(...(binds as any[]))
      expect(run(stmt.sql, stmt.binds), id).toEqual(run(bound, legacyBinds))
      expect(literals.length, id).toBeGreaterThan(0)
      checked++
    }
    expect(checked).toBeGreaterThan(0)
  })
})

describe('counts only: the hour, place and device splits still refuse every refused row', () => {
  const noCache = { match: async () => undefined, put: async () => {} }
  const post = async (body: Record<string, unknown>) => {
    ;(globalThis as any).caches = { default: noCache }
    const { onRequestPost } = await import('./geo')
    const res = await onRequestPost(pagesContext(postJson('/api/geo', { ...body, ...range, limit: 200, includeEventBeacons: true }), { gss_geo: sqliteD1(db) }) as any)
    return { status: res.status, body: (await res.json()) as any }
  }
  // Companions are the changed clauses: own hosts, uc list, game prefix, and all three together.
  const COMPANIONS: string[][] = [['referrer'], ['campaignFlight'], ['gameMode'], ['flightDay'], ['referrer', 'gameMode', 'campaignFlight']]

  it('the refused set is exactly the nine patterns, and each fixture path is refused', () => {
    expect(SPLIT_REFUSED_PATH_PATTERNS).toEqual([
      '/return/%', '/game/complete/%', '/game/complete-deferred/%', '/game/tutorial-complete/%', '/game/start/%',
      '/tour/exit-at/%', '/tour/exit-at', '/tour/skip', '/tour/skip/%',
    ])
    for (const p of REFUSED) expect(isSplitRefusedPath(p), p).toBe(true)
    for (const p of ORDINARY) expect(isSplitRefusedPath(p), p).toBe(false)
  })

  it('a table of refused rows only: every split of every changed shape returns nothing', async () => {
    seed(db, REFUSED)
    let asked = 0
    for (const dim of SPLIT_REFUSED_DIMS) {
      for (const comp of COMPANIONS) {
        const dims = [dim, ...comp]
        const { status, body } = await post({ dimension: dim, dims })
        expect(status, dims.join('x')).toBe(200)
        expect(body.totals.pageviews, dims.join('x')).toBe(0)
        expect(body.rows, dims.join('x')).toEqual([])
        asked++
      }
      const single = await post({ dimension: dim })
      expect(single.body.totals.pageviews, dim).toBe(0)
      asked++
    }
    expect(asked).toBe(SPLIT_REFUSED_DIMS.size * (COMPANIONS.length + 1))
    // Points mode (the map) is a split too.
    expect((await post({ dimension: 'points' })).body.totals.pageviews).toBe(0)
  }, 120_000)

  it('control: the same splits over ordinary rows still count them (the zeros above are not vacuous)', async () => {
    seed(db, ORDINARY)
    for (const dim of ['region', 'device', 'hourEt', 'country', 'visitor']) {
      for (const comp of [['referrer'], ['campaignFlight'], ['referrer', 'campaignFlight']]) {
        const { body } = await post({ dimension: dim, dims: [dim, ...comp] })
        expect(body.totals.pageviews, [dim, ...comp].join('x')).toBeGreaterThan(0)
      }
    }
  }, 60_000)
})

describe('the literal helper', () => {
  it('rejects quotes and anything outside the path alphabet', () => {
    for (const bad of ["a'b", "'; DROP TABLE hits; --", 'a"b', 'a\\b', 'a;b', 'a\nb', 'a,b', 'é']) expect(() => sqlLit(bad), bad).toThrow(/unsafe SQL literal/)
  })
  it('every registered uc value, own host and the game prefix pass it, so the inlined lists cannot throw at request time', () => {
    for (const c of CAMPAIGNS) for (const uc of c.ucValues) expect(() => sqlLit(uc), `${c.id}: ${uc}`).not.toThrow()
    for (const h of OWN_HOSTS) expect(() => sqlLit(h), h).not.toThrow()
    expect(() => sqlLit('/game/complete/%')).not.toThrow()
  })
  it('a hostile uc value cannot reach a statement: the prefilter throws instead of emitting it', () => {
    CAMPAIGNS.push({ ...CAMPAIGNS[0], id: '9000000000099', ucValues: ["x' OR '1'='1"] })
    try {
      expect(() => campaignFlightPrefilter([], [])).toThrow(/unsafe SQL literal/)
    } finally {
      CAMPAIGNS.pop()
    }
  })
})

describe('/api/completions site cap (it had none: 99+ sites reached D1 as 101+ binds)', () => {
  const noCache = { match: async () => undefined, put: async () => {} }
  const post = async (sites: string[]) => {
    ;(globalThis as any).caches = { default: noCache }
    const { onRequestPost } = await import('./completions')
    const binds: number[] = []
    const d1 = sqliteD1(db)
    const orig = d1.prepare.bind(d1)
    ;(d1 as any).prepare = (sql: string) => {
      const st = orig(sql) as any
      return { ...st, bind: (...v: unknown[]) => (binds.push(v.length), st.bind(...v)) }
    }
    const res = await onRequestPost(pagesContext(postJson('/api/completions', { ...range, sites }), { gss_geo: d1 }) as any)
    return { status: res.status, body: (await res.json()) as any, binds }
  }
  const sites = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)

  it('50 sites answer 200 with 2 window binds plus one per site', async () => {
    const r = await post(sites(50))
    expect(r.status).toBe(200)
    expect(r.binds).toEqual([52])
  })
  it('51 or 200 sites are a clear 400 and never reach D1', async () => {
    for (const n of [51, 200]) {
      const r = await post(sites(n))
      expect(r.status, `${n} sites`).toBe(400)
      expect(r.body.error).toMatch(/too many sites \(at most 50\)/)
      expect(r.binds, `${n} sites`).toEqual([])
    }
  })
})
