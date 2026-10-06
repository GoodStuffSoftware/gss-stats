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
/** Fake campaigns registered on top of the real ones (5 today), each with two short uc values. The flight dims (campaignFlight,
 * flightDay, arrival) read the registry through one flight_reg CTE stated once per statement (lib/campaigns.ts), so a worst-case
 * geo ring carries 81 binds at any count and grows about 0.21 KB per added campaign. The worst legal ring is 8 dims with 16
 * flightDay filters (70.5 KB at 5 campaigns, 81.1 KB at the default 55). The byte cap is what campaigns hit, never the bind cap.
 * Measured by bisecting BIND_EXTRA: the room test first goes red at BIND_EXTRA=68 (73 campaigns in all), and the byte and
 * no-refusal tests first go red at BIND_EXTRA=93 (98 in all: 92 extra is 89,961 B and fits, 93 is 90,173 B and is refused).
 * Lighter filters hold more (16 campaignFlight filters about 170 campaigns), but the guard is judged on the worst ring.
 * The per-campaign cost grows with the uc count and name length: a realistic campaign (4 ucs, ~38-char names) costs about
 * 0.63 KB, 3x the fakes here, so the worst ring reaches the cap at about 36 of them in all. Keep that in mind before reading
 * "55 campaigns" as comfortable. MIN_ROOM_CAMPAIGNS below is the warning margin. */
const EXTRA = Number(process.env.BIND_EXTRA ?? 50)
/** The fewest extra campaigns the worst-case ring must still have room for (the extrapolated headroom test below). The
 * worst ring has room for about 42 more at the default EXTRA=50, so a floor of 25 goes red while real room remains (about 8
 * realistic campaigns at 3x cost): early enough to act on, with slack for a filter or two added later. */
const MIN_ROOM_CAMPAIGNS = 25
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
  /** The shape that produced `bytes` (the byte-worst request), which is not always the bind-worst `shape`. */
  bytesShape: string
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
      flightStart: new Date(Date.UTC(2026, 9, 12 + i)).toISOString().slice(0, 10), // a distinct start each: every campaign start is a segment cut
      flightStartTimeEt: '12:00',
      flightEnd: '2099-12-31',
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
  const bytes = r ? r.bytes : new TextEncoder().encode(sql).length
  if (bytes > w.bytes) {
    w.bytes = bytes
    w.bytesShape = shape
  }
  if (r?.refused && !w.refused) w.refused = `${shape}: ${r.refused}`
  if (binds > w.max) {
    w.max = binds
    w.shape = shape
  }
}
const worst = (): Worst => ({ max: -1, shape: '', bytes: 0, bytesShape: '', refused: '' })
const countQ = (sql: string) => (sql.match(/\?/g) ?? []).length

async function measure(extra: number): Promise<Measured> {
  const m = await load(extra)
  const { CAMPAIGNS } = m.campaigns
  const geoRes = { points: worst(), breakdown: worst(), ring: worst() }

  // Every constraint a request may carry (MAX_CONSTRAINTS = 16), as plain columns or as a derived dim.
  const constraintSets: [string, { field: string; value: string }[]][] = [
    ['16 region filters', Array.from({ length: 16 }, (_, i) => ({ field: 'region', value: `r${i}` }))],
    ['16 campaignFlight filters', Array.from({ length: 16 }, (_, i) => ({ field: 'campaignFlight', value: `flight-${i}` }))],
    // flightDay and arrival clauses each carry their own registry lookup, so these are the heavy ones: 16 flightDay is the worst
    // legal ring (the byte maximum), and the mixed set is the largest realistic drill (6 + 5 + 5 = 16 constraints).
    ['16 flightDay filters', Array.from({ length: 16 }, (_, i) => ({ field: 'flightDay', value: `2026-10-${String(1 + i).padStart(2, '0')}` }))],
    ['16 arrival filters', Array.from({ length: 16 }, (_, i) => ({ field: 'arrival', value: `arrival-${i}` }))],
    [
      'mixed 16 (6 campaignFlight, 5 flightDay, 5 arrival)',
      [
        ...Array.from({ length: 6 }, (_, i) => ({ field: 'campaignFlight', value: `flight-${i}` })),
        ...Array.from({ length: 5 }, (_, i) => ({ field: 'flightDay', value: `2026-10-${String(1 + i).padStart(2, '0')}` })),
        ...Array.from({ length: 5 }, (_, i) => ({ field: 'arrival', value: `arrival-${i}` })),
      ],
    ],
  ]
  // Dims whose clause adds binds, plus a filler; the rest of GEO_DIMS add none (the single-dim sweep below covers them).
  const BIND_DIMS = ['referrer', 'gameMode', 'gameDifficulty', 'campaignFlight', 'flightDay', 'arrival', 'popupFamily', 'popupOutcome']
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
    sites: { max: 1, shape: '/api/sites: one window bind (no registry input)', bytes: 0, bytesShape: '', refused: '' },
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
      for (const [name, w] of rows(m)) {
        console.log(`BINDS   ${name.padEnd(14)} ${String(w.max).padStart(3)} binds  ${w.shape}`)
        console.log(`BINDS   ${''.padEnd(14)} ${String(w.bytes).padStart(6)} B      ${w.bytesShape}`)
      }
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
    for (const m of [base, grown]) for (const [name, w] of rows(m)) expect(w.bytes, `${name}: ${w.bytesShape}`).toBeLessThan(MAX_SQL_BYTES)
  })
  it('registering campaigns costs the worst geo ring little: room for at least MIN_ROOM_CAMPAIGNS more under MAX_SQL_BYTES', () => {
    const perCampaign = (grown.geo.ring.bytes - base.geo.ring.bytes) / EXTRA
    expect(perCampaign, 'ring bytes added per campaign').toBeGreaterThan(0)
    expect(perCampaign, 'ring bytes added per campaign').toBeLessThan(1000)
    const room = (MAX_SQL_BYTES - grown.geo.ring.bytes) / perCampaign
    expect(room, 'more campaigns the worst-case ring holds under MAX_SQL_BYTES').toBeGreaterThanOrEqual(MIN_ROOM_CAMPAIGNS)
  })
  it('no worst-case request is refused by statementTooLarge (a 400 is a failure, not a smaller statement)', () => {
    for (const m of [base, grown]) for (const [name, w] of rows(m)) expect(w.refused, `${name}`).toBe('')
  })
})
