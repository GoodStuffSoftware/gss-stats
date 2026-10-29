// Late flight attribution (geo.ts groupedCountsSql, lib/campaigns.ts lateFlightSqlCase): a grouped statement
// that uses a flight dimension counts first and attributes flights per group. Pinned against the per-row form
// (flightAttribution.late = false) through the real handler on a real SQLite, with the real registry: every
// flight, its ET start/end boundaries, tags outside any flight, excluded rows, and every flight dimension as a
// key, a ring member and a drill. Also pins the rows-read claim (a probe counts every hits row and every
// flight_reg row the engine visits) and the bind ceiling.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { CAMPAIGNS, campaignAttributionStartMs, etFlightRangeMs } from '../../src/lib/campaigns'
import { LANDING_SITES, LANDING_TAGS } from '../../src/lib/landingTags'
import { INSTALL_GAP_PATHS } from '../../src/lib/popupEvents'
import { MAX_BOUND_PARAMS } from '../../src/lib/queryLimits'
import { flightAttribution, onRequestPost } from './geo'
import { insertHits, installCaches, memoryCache, openHitsDb, sqliteD1, type HitRow } from '../_lib/testing/hitsDb'

const dated = CAMPAIGNS.filter((c) => campaignAttributionStartMs(c) !== null && c.flightStart)
const H = 3_600_000
const D = 24 * H

/** Rows around every registry boundary (attribution start, ET window start and end), per uc, in several shapes. */
function fixture(copies: number): (HitRow & { n?: number })[] {
  const rows: (HitRow & { n?: number })[] = []
  const shapes: Partial<HitRow>[] = [
    { device: 'mobile', os: 'Android', visitor: 'new', site: 'bestsudoku', path: '/' },
    { device: 'desktop', os: 'Windows', visitor: 'returning', site: 'bestsudoku', path: '/play' },
    { device: 'mobile', os: 'iOS', visitor: 'new', site: 'bestsudoku', path: INSTALL_GAP_PATHS[0] },
    { device: 'mobile', os: 'Android', visitor: 'new', medium: 'lifecycle', site: 'bestsudoku', path: '/' }, // excluded (lifecycle email)
    { device: 'mobile', os: 'Android', visitor: 'new', region: 'North Carolina', screenw: 412, site: 'bestsudoku', path: '/' }, // household
  ]
  for (const c of dated) {
    const att = campaignAttributionStartMs(c)!
    const [from, to] = etFlightRangeMs(c.flightStart!, c.flightEnd)
    const times = [from - 1, from, att - 1, att, att + 5 * H, from + D + 7 * H, to - 1, to, to + 2 * D + 3 * H]
    for (const uc of c.ucValues) {
      for (const ts of times) for (const s of shapes) rows.push({ ts, campaign: uc, ...s, n: copies })
      for (const t of LANDING_TAGS) {
        for (const site of [...LANDING_SITES, 'elsewhere']) rows.push({ ts: att + H, campaign: uc, site, path: `/return/${t.tag}/d0`, visitor: 'new', n: copies })
        rows.push({ ts: att - 1, campaign: uc, site: LANDING_SITES[0], path: `/return/${t.tag}/d0`, visitor: 'new', n: copies })
      }
    }
    // Tags outside any flight, untagged rows and lowercase-twin campaigns in the same days.
    for (const ts of times) {
      rows.push({ ts, campaign: 'not_a_flight', device: 'mobile', os: 'Android', visitor: 'new', n: copies })
      rows.push({ ts, campaign: '', device: 'desktop', os: 'Mac', visitor: 'new', n: copies })
      rows.push({ ts, campaign: (c.ucValues[0] ?? 'x').toUpperCase(), visitor: 'new', n: copies })
    }
  }
  return rows
}

const first = Math.min(...dated.map((c) => etFlightRangeMs(c.flightStart!, c.flightEnd)[0]))
const last = Math.max(...dated.map((c) => etFlightRangeMs(c.flightStart!, c.flightEnd)[1]))
const RANGE = { since: new Date(first - 3 * D).toISOString().slice(0, 10), until: new Date(last + 5 * D).toISOString().slice(0, 10) }

let db: DatabaseSync
let undo: () => void
beforeEach(() => {
  db = openHitsDb()
  undo = installCaches(memoryCache())
})
afterEach(() => {
  flightAttribution.late = true
  undo()
  db.close()
})

/** One handler call on a fresh cache, with the given attribution form; returns the JSON and the statements run. */
async function post(body: Record<string, unknown>, late: boolean, binding = sqliteD1(db)) {
  undo()
  undo = installCaches(memoryCache())
  flightAttribution.late = late
  const res = await onRequestPost({ request: { json: async () => ({ limit: 500, metric: 'pageviews', ...RANGE, ...body }) }, env: { gss_geo: binding }, waitUntil: () => {} } as any)
  return { json: (await res.json()) as any, statements: binding.statements }
}

const FLIGHT = ['campaignFlight', 'flightDay', 'arrival', 'landingTag']
const OTHER = ['hourEt', 'device', 'os', 'visitor']
const someId = dated[0].id
const drills = [
  [],
  [{ field: 'campaignFlight', value: someId }],
  [{ field: 'flightDay', value: '1' }],
  [{ field: 'arrival', value: 'tagged' }],
  [{ field: 'landingTag', value: LANDING_TAGS[0].tag }],
  [{ field: 'device', value: 'mobile' }, { field: 'campaignFlight', value: someId }],
]
const bodies: Record<string, unknown>[] = []
for (const constraints of drills) {
  for (const toggles of [{ includeEventBeacons: true }, { includeEventBeacons: true, excludeKnownTraffic: true }, {}]) {
    for (const dimension of [...FLIGHT, 'dateEt', 'hourEt', 'device']) bodies.push({ dimension, constraints, ...toggles })
    for (const a of FLIGHT) for (const b of [...FLIGHT, ...OTHER]) if (a !== b) bodies.push({ dimension: a, dims: [a, b], constraints, ...toggles }, { dimension: b, dims: [b, a], constraints, ...toggles })
    bodies.push({ dimension: 'campaignFlight', dims: ['campaignFlight', 'device', 'os'], constraints, ...toggles })
    bodies.push({ dimension: 'device', dims: ['device', 'os'], constraints, ...toggles })
  }
}
bodies.push({ dimension: 'dateEt', stepSeries: ['no.such-step'], constraints: [{ field: 'campaignFlight', value: someId }] })
// Windows that cut through flights (boundaries below, inside and above the window: _ft lists only the inside
// ones), sub-day ones on a boundary, and UTC-day ones (refusedWindowClause snaps refused rows to ET days).
const iso = (ms: number) => new Date(ms).toISOString()
for (const c of [dated[0], dated[Math.floor(dated.length / 2)], dated[dated.length - 1]]) {
  const att = campaignAttributionStartMs(c)!
  const [from, to] = etFlightRangeMs(c.flightStart!, c.flightEnd)
  const windows = [
    { since: iso(att + H), until: iso(to - H) },
    { since: iso(att - 30 * 60_000), until: iso(att + 30 * 60_000) },
    { since: iso(from - 1), until: iso(to + 1) },
    { since: c.flightStart!, until: c.flightStart! },
  ]
  for (const win of windows) {
    for (const extra of [{ dimension: 'flightDay', dims: ['flightDay', 'campaignFlight'] }, { dimension: 'campaignFlight', dims: ['campaignFlight', 'device', 'os'] }, { dimension: 'landingTag' }, { dimension: 'arrival' }, { dimension: 'dateEt', constraints: [{ field: 'arrival', value: 'tagged' }] }, { dimension: 'hourEt', dims: ['hourEt', 'campaignFlight'] }]) {
      bodies.push({ constraints: [], includeEventBeacons: true, ...win, ...extra })
    }
  }
}

describe('late flight attribution', () => {
  it('returns exactly the per-row result for every flight dimension combination', async () => {
    insertHits(db, fixture(1))
    let lateRuns = 0
    let nonEmpty = 0
    for (const body of bodies) {
      const late = await post(body, true)
      const old = await post(body, false)
      expect(late.json, JSON.stringify(body)).toEqual(old.json)
      if (late.statements.some((s) => s.includes(' AS _ft'))) lateRuns++
      if ((late.json.rows ?? late.json.series?.[0]?.rows ?? []).length) nonEmpty++
    }
    // Not vacuous: every body with a flight dim took the late form, and most answers have rows.
    const withFlight = bodies.filter((b) => [b.dimension, ...((b.dims as string[]) ?? []), ...(b.constraints as { field: string }[]).map((c) => c.field)].some((d) => FLIGHT.includes(d as string)))
    expect(lateRuns).toBe(withFlight.length)
    expect(nonEmpty).toBeGreaterThan(bodies.length / 2)
  }, 120_000)

  it('the flight charts read about the window, not window x registry rows', async () => {
    insertHits(db, fixture(20))
    let hitsRows = 0
    let regRows = 0
    // DatabaseSync.function (Node 22.13+) is missing from this @types/node.
    const fn = (db as unknown as { function(name: string, f: () => number): void }).function.bind(db)
    fn('rr_hits', () => (hitsRows++, 1))
    fn('rr_reg', () => (regRows++, 1))
    const base = sqliteD1(db)
    const probe = {
      ...base,
      prepare: (sql: string) => base.prepare(sql.replaceAll('FROM hits WHERE ', 'FROM hits WHERE rr_hits() AND ').replaceAll('FROM flight_reg WHERE ', 'FROM flight_reg WHERE rr_reg() AND ')),
    } as unknown as ReturnType<typeof sqliteD1>
    const measure = async (body: Record<string, unknown>, late: boolean) => {
      hitsRows = 0
      regRows = 0
      await post(body, late, probe)
      return { hitsRows, regRows, total: hitsRows + regRows }
    }
    const charts = [
      { dimension: 'flightDay', dims: ['flightDay', 'campaignFlight'], includeEventBeacons: true },
      { dimension: 'campaignFlight', dims: ['campaignFlight', 'device', 'os'], includeEventBeacons: true },
      { dimension: 'hourEt', dims: ['hourEt', 'campaignFlight'], includeEventBeacons: true },
    ]
    // On this fixture (19,680 window rows) the per-row form reads 375k / 175k / 176k rows and the late form
    // 21.6k / 22.5k / 21.9k (window + groups x registry rows): the prod 289k / 183k / 124k calls drop the same way.
    for (const body of charts) {
      const old = await measure(body, false)
      const late = await measure(body, true)
      expect(late.hitsRows).toBe(old.hitsRows) // the same window scan
      expect(old.regRows).toBeGreaterThan(old.hitsRows * 5) // per-row lookups: the multiplier
      expect(late.total).toBeLessThan(old.hitsRows * 1.5) // about the window
      expect(late.total * 5).toBeLessThan(old.total)
    }
  }, 120_000)

  it('moves no bind and stays under the bind ceiling with the most drills', async () => {
    const constraints = [
      ...FLIGHT.map((field) => ({ field, value: field === 'flightDay' ? '1' : 'x' })),
      ...Array.from({ length: 12 }, (_, i) => ({ field: 'region', value: `r${i}` })),
    ]
    const sites = Array.from({ length: 10 }, (_, i) => `site${i}`)
    for (const body of [{ dimension: 'flightDay', dims: ['flightDay', 'campaignFlight', 'device'], constraints, sites, excludeOwnVisits: true, ownBrowser: 'Chrome', ownOS: 'Windows' }, { dimension: 'flightDay', constraints, sites }]) {
      const counts: number[] = []
      for (const late of [true, false]) {
        const base = sqliteD1(db)
        let n = 0
        const counting = { ...base, prepare: (sql: string) => { const p = base.prepare(sql); return { ...p, bind: (...v: unknown[]) => { n = v.length; return p.bind(...v) } } } } as unknown as ReturnType<typeof sqliteD1>
        const { json } = await post(body, late, counting)
        expect(json.error).toBeUndefined()
        counts.push(n)
      }
      expect(counts[0]).toBe(counts[1])
      expect(counts[0]).toBeLessThanOrEqual(MAX_BOUND_PARAMS)
    }
  })
})
