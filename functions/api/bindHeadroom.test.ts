// D1 bind headroom, measured by EXECUTION. D1 refuses a statement with more than 100 bound
// parameters (https://developers.cloudflare.com/d1/platform/limits/), and a chart that trips it
// fails to load. The only registry-driven binds a server query can carry are the campaign list
// and the refused-path list (lib/splitGuard.ts), so this builds the REAL statement of every
// server query that reads either, for its worst-case inputs (every filter on, the UI's maximum
// of sites and exclusions, every registered campaign plus several fake ones), and counts the
// binds it would hand to D1. Nothing here may grow with the number of campaigns or refused
// patterns; each must stay at or under HEADROOM_CEILING (10 below D1's limit, room for a filter
// or two added later).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MAX_SQL_BYTES } from '../../src/lib/queryLimits'

/** Binds a statement may carry: D1's limit is 100, and ten stay free. */
const HEADROOM_CEILING = 90
/** EXTRA sits on top of the real registered campaigns (5 today), so this suite goes red when the 6th real campaign registers; the planned 90 KB guard follow-up lifts that ceiling.
 * Fake campaigns registered on top of the real ones, each with two uc values. 5 is the most the worst-case geo ring
 * (16 filters, 50 sites) holds under MAX_SQL_BYTES: each campaign adds about 3.7 KB to it, and at 6 the statement is
 * 91 KB, refused with a 400. BIND_EXTRA=6 or 7 therefore fails the byte and no-refusal tests below, on purpose. */
const EXTRA = Number(process.env.BIND_EXTRA ?? 5)
const SITES50 = ['bestsudoku-web', ...Array.from({ length: 49 }, (_, i) => `s${i}`)]
const SUB_DAY = { since: '2026-10-01T15:00:00.000Z', until: '2026-10-01T16:00:00.000Z' }
const ALIGNED = { since: '2026-10-01', until: '2026-10-01' }
const OWN = { excludeOwnVisits: true, ownBrowser: 'Opera', ownOS: 'Windows' }

interface Worst {
  max: number
  shape: string
  /** Largest SQL text (UTF-8 bytes) seen for this category, against statementTooLarge's MAX_SQL_BYTES. A 400 from the guard
   * contributes the byte count its own message reports, never 0. */
  bytes: number
  /** First worst-case request the guard refused with a 400 (before D1 saw it), as shape + message; '' when none. */
  refused: string
}
interface Measured {
  campaigns: number
  ucValues: number
  geo: Record<'points' | 'breakdown' | 'ring', Worst>
  popups: Worst
  completions: Worst
  facts: Worst
  /** Each fact's own worst bind count. */
  perFact: Record<string, number>
  sites: Worst
}

/** Loads every server module against a fresh registry holding the real campaigns plus `extra` fake ones. */
async function load(extra: number) {
  vi.resetModules()
  const campaigns = await import('../../src/lib/campaigns')
  for (let i = 0; i < extra; i++) {
    campaigns.CAMPAIGNS.push({
      id: `9000000000${i}`,
      label: `Fake ${i}`,
      ucValues: [`fake_uc_${i}_a`, `fake_uc_${i}_b`],
      flightStart: `2026-10-${String(12 + i).padStart(2, '0')}`, // a distinct start each: every campaign start is a segment cut
      flightStartTimeEt: '12:00',
      flightEnd: '2026-11-30',
      status: 'upcoming',
      kind: 'web',
      notes: 'bind headroom guard fixture',
    })
  }
  const [geo, popups, completions, sites, engine, facts] = await Promise.all([
    import('./geo'),
    import('./popups'),
    import('./completions'),
    import('./sites'),
    import('../../src/lib/metrics/engine'),
    import('../../src/lib/metrics/facts'),
  ])
  return { campaigns, geo, popups, completions, sites, engine, facts }
}

/** Runs a handler against a D1 stub that records the statement and its binds. A statement the guard refuses with a 400
 * never reaches prepare(), so its size is read from the guard's own message (bind count from "(N values; at most",
 * SQL bytes from "(N bytes; at most"): a refused shape is still measured, never recorded as 0 binds or 0 bytes. */
async function run(handler: (ctx: any) => Response | Promise<Response>, body: Record<string, unknown>) {
  const calls: { sql: string; binds: unknown[] }[] = []
  const d1 = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => {
        calls.push({ sql, binds })
        return { all: async () => ({ results: [] }) }
      },
    }),
  }
  ;(globalThis as any).caches = { default: { match: async () => undefined, put: async () => {} } }
  const res = await handler({ request: { json: async () => body }, env: { gss_geo: d1 }, waitUntil: () => {} })
  const out = (await res.json()) as any
  if (calls.length) return { binds: calls[0].binds.length, sql: calls[0].sql, bytes: new TextEncoder().encode(calls[0].sql).length, refused: '' }
  const error = String(out.error ?? '')
  const vals = /\((\d+) values; at most/.exec(error)
  const bytes = /\((\d+) bytes; at most/.exec(error)
  if (res.status !== 400 || !(vals || bytes)) throw new Error(`worst-case request neither reached D1 nor was refused by statementTooLarge: ${res.status} ${error}`)
  return { binds: vals ? Number(vals[1]) : 0, sql: '', bytes: bytes ? Number(bytes[1]) : 0, refused: error }
}

const track = (w: Worst, binds: number, shape: string, sql = '', r?: { bytes: number; refused: string }) => {
  w.bytes = Math.max(w.bytes, r ? r.bytes : new TextEncoder().encode(sql).length)
  if (r?.refused && !w.refused) w.refused = `${shape}: ${r.refused}`
  if (binds > w.max) {
    w.max = binds
    w.shape = shape
  }
}
const worst = (): Worst => ({ max: -1, shape: '', bytes: 0, refused: '' })
const countQ = (sql: string) => (sql.match(/\?/g) ?? []).length

async function measure(extra: number): Promise<Measured> {
  const m = await load(extra)
  const { CAMPAIGNS } = m.campaigns
  const geoRes = { points: worst(), breakdown: worst(), ring: worst() }

  // Every constraint a request may carry (MAX_CONSTRAINTS = 16), as plain columns or as a derived dim.
  const constraintSets: [string, { field: string; value: string }[]][] = [
    ['16 region filters', Array.from({ length: 16 }, (_, i) => ({ field: 'region', value: `r${i}` }))],
    ['16 campaignFlight filters', Array.from({ length: 16 }, (_, i) => ({ field: 'campaignFlight', value: `flight-${i}` }))],
  ]
  // Dims whose clause adds binds, plus a filler; the rest of GEO_DIMS add none (the single-dim sweep below covers them).
  const BIND_DIMS = ['referrer', 'gameMode', 'gameDifficulty', 'campaignFlight', 'flightDay', 'popupFamily', 'popupOutcome']
  const common = { sites: SITES50, excludeKnownTraffic: true, ...OWN }

  for (const win of [SUB_DAY, ALIGNED]) {
    for (const includeEventBeacons of [true, false]) {
      for (const [cname, constraints] of constraintSets) {
        const base = { ...common, ...win, includeEventBeacons, constraints }
        const tag = `${win === SUB_DAY ? 'sub-day' : 'aligned'}, eventBeacons=${includeEventBeacons}, ${cname}`
        { const r = await run(m.geo.onRequestPost, { ...base, dimension: 'points' }); track(geoRes.points, r.binds, `points, ${tag}`, r.sql, r) }
        for (const d of m.geo.GEO_DIMS) { const r = await run(m.geo.onRequestPost, { ...base, dimension: d }); track(geoRes.breakdown, r.binds, `breakdown ${d}, ${tag}`, r.sql, r) }
        for (let mask = 0; mask < 1 << BIND_DIMS.length; mask++) {
          const dims = [...BIND_DIMS.filter((_, i) => mask & (1 << i)), 'region'].slice(0, 8)
          if (dims.length < 2) continue
          { const r = await run(m.geo.onRequestPost, { ...base, dimension: dims[0], dims }); track(geoRes.ring, r.binds, `ring [${dims.join(', ')}], ${tag}`, r.sql, r) }
        }
      }
    }
  }

  const popups = worst()
  for (const win of [SUB_DAY, ALIGNED]) for (const d of ['kind', 'reason', 'date', 'outcome', 'installOutcome']) {
    { const r = await run(m.popups.onRequestPost, { ...win, dimension: d, sites: SITES50, ...OWN }); track(popups, r.binds, `popups ${d}`, r.sql, r) }
  }
  const completions = worst()
  for (const win of [SUB_DAY, ALIGNED]) {
    { const r = await run(m.completions.onRequestPost, { ...win, dimension: 'mode', breakdown: 'difficulty', sites: SITES50 }); track(completions, r.binds, 'completions, 50 sites', r.sql, r) }
  }

  // /api/metrics: every fact, built exactly as the planner builds it (real segment cuts), per campaign and organic arm.
  const facts = worst()
  const perFact: Record<string, number> = {}
  const ids = Object.keys(m.facts.FACTS) as (keyof typeof m.facts.FACTS)[]
  for (const id of ids) {
    for (const campaignId of [...CAMPAIGNS.map((c) => c.id), m.campaigns.ORGANIC_ARM_ID]) {
      for (const win of [SUB_DAY, ALIGNED]) {
        let stmt
        try {
          stmt = m.engine.buildFact({ id, params: { campaignId, todayEt: '2026-10-04', releaseDateEt: '2026-10-01', days: 7, sites: SITES50, ownBrowser: 'Opera', ownOS: 'Windows', ...win } }, Date.parse('2026-10-04T16:00:00Z'))
        } catch {
          continue // a fact that cannot be built for this campaign (e.g. no confirmed flightStart)
        }
        expect(stmt.binds.length, `${id} placeholders vs binds`).toBe(countQ(stmt.sql))
        perFact[id] = Math.max(perFact[id] ?? 0, stmt.binds.length)
        track(facts, stmt.binds.length, `fact ${id} (${campaignId}), ${win === SUB_DAY ? 'sub-day' : 'aligned'}`, stmt.sql)
      }
    }
  }

  return {
    campaigns: CAMPAIGNS.length,
    ucValues: new Set(CAMPAIGNS.flatMap((c) => c.ucValues)).size,
    geo: geoRes,
    popups,
    completions,
    facts,
    perFact,
    sites: { max: 1, shape: '/api/sites: one window bind (no registry input)', bytes: 0, refused: '' },
  }
}

const rows = (m: Measured) =>
  [
    ['geo points', m.geo.points],
    ['geo breakdown', m.geo.breakdown],
    ['geo ring', m.geo.ring],
    ['popups', m.popups],
    ['completions', m.completions],
    ['metrics facts', m.facts],
  ] as [string, Worst][]

describe('D1 bind headroom (worst-case statements, by execution)', () => {
  let base: Measured
  let grown: Measured
  beforeAll(async () => {
    base = await measure(0)
    grown = await measure(EXTRA)
    for (const [label, m] of [['today', base], ['+' + EXTRA + ' fake campaigns', grown]] as [string, Measured][]) {
      console.log(`BINDS ${label}: ${m.campaigns} campaigns, ${m.ucValues} uc values`)
      for (const [name, w] of rows(m)) console.log(`BINDS   ${name.padEnd(14)} ${String(w.max).padStart(3)}  ${String(w.bytes).padStart(6)} B  ${w.shape}`)
      console.log('BINDS   per fact: ' + Object.entries(m.perFact).map(([k, v]) => `${k}=${v}`).join(' '))
    }
  }, 120_000)
  afterEach(() => vi.resetModules())


  it('every server query binds at most HEADROOM_CEILING parameters today', () => {
    for (const [name, w] of rows(base)) expect(w.max, `${name}: ${w.shape}`).toBeLessThanOrEqual(HEADROOM_CEILING)
  })
  it('every server query still does with extra campaigns registered', () => {
    for (const [name, w] of rows(grown)) expect(w.max, `${name}: ${w.shape}`).toBeLessThanOrEqual(HEADROOM_CEILING)
  })
  it('the bind count is flat: registering more campaigns adds no bind to any query', () => {
    expect(grown.campaigns).toBe(base.campaigns + EXTRA)
    expect(grown.ucValues).toBeGreaterThan(base.ucValues)
    const flat = (s: Measured) => rows(s).map(([name, w]) => `${name}=${w.max}`)
    expect(flat(grown)).toEqual(flat(base))
  })
  it('every worst-case statement stays under the MAX_SQL_BYTES cap of statementTooLarge', () => {
    for (const m of [base, grown]) for (const [name, w] of rows(m)) expect(w.bytes, `${name}: ${w.shape}`).toBeLessThan(MAX_SQL_BYTES)
  })
  it('no worst-case request is refused by statementTooLarge (a 400 is a failure, not a smaller statement)', () => {
    for (const m of [base, grown]) for (const [name, w] of rows(m)) expect(w.refused, `${name}`).toBe('')
  })
})
