// Derived columns (geo.ts derivedColumnSet): a statement states each filterable derived dim's expression once, as a
// column of a derived table over `hits`, instead of at its key, its blank test and every drill filter on it. Pinned
// against the inline form (derivedColumns.on = false, the old SQL byte for byte) through the real handler on a real
// SQLite, with the real registry: every derived dim as a key, a ring member and a drill; the byte-heaviest ring the
// bind headroom guard finds (16 pathFamily filters) and heavy rings that return rows; points and step series; late
// flight attribution on and off. Also pins the relabelled keys row by row, the query plans (SQLite flattens the
// derived table: the same index range scan) and the bytes saved.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { CAMPAIGNS, campaignAttributionStartMs, etFlightRangeMs, liveLandingTags, withFlightRegistry } from '../../src/lib/campaigns'
import { LANDING_SITES, LANDING_TAGS } from '../../src/lib/landingTags'
import {
  INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS,
  INSTALL_GAP_PATHS,
  INSTALL_OUTCOMES,
  INSTALL_PROMPT_DISMISS,
  INSTALL_SHOWN_PLATFORMS,
  POPUP_EVENT_PREFIXES,
  POPUP_OUTCOME_NAME_TO_FAMILY,
  POPUP_OUTCOME_TYPES,
  UPSELL_KINDS,
} from '../../src/lib/popupEvents'
import { FEATURES } from '../../src/lib/featureHealth'
import { breakdownColumnExpr, derivedColumns, flightAttribution, onRequestPost } from './geo'
import { insertHits, installCaches, memoryCache, openHitsDb, sqliteD1, type HitRow } from '../_lib/testing/hitsDb'

const H = 3_600_000
const D = 24 * H
const dated = CAMPAIGNS.filter((c) => campaignAttributionStartMs(c) !== null && c.flightStart)

// Every path shape the derived dims read: each pop-up family and outcome (both /popup-outcome shapes), install,
// key events, completions (well-formed and not), feature steps, landing arrivals, refused paths (return, starts,
// completions, tour, coach, funnel, ask order, visit), mixed case, slash runs, NUL paths and pages.
const PATHS = [
  ...new Set([
    '/', '/home', '/game', '/settings', '', '/game/complete', '/returns', '/return', '/funnels/x',
    '/signin-prompt/accept', '/signin-prompt/dismiss', '/signin-prompt/placement', '/signin-prompt', '/signin-prompt//accept/', '/signin-prompt/first-finish',
    ...['shown', 'accept', 'dismiss', 'other'].map((k) => `/promo-first50/${k}`),
    ...['shown', 'ack', 'close', 'other'].map((k) => `/first50-congrats/${k}`),
    ...UPSELL_KINDS.flatMap((k) => [`/upsell/${k}/limit`, `/upsell/${k}`]),
    '/upsell/other/limit',
    ...INSTALL_SHOWN_PLATFORMS.map((p) => `/install/prompt/${p}`),
    ...INSTALL_PROMPT_DISMISS.map((d) => `/install/prompt/${d}`),
    '/install/prompt/other', '/install/play', '/install/pwa-accept', '/install/app-store', '/install/pwa-decline', '/install/platforms/android', '/install/inapp/x',
    ...INSTALL_OUTCOMES.map((o) => `/install/${o}`),
    ...INSTALL_GAP_PATHS,
    ...Object.keys(POPUP_OUTCOME_NAME_TO_FAMILY).flatMap((n) => POPUP_OUTCOME_TYPES.flatMap((t) => [`/popup-outcome/${n}/${t}`, `/popup-outcome/${n}/limit/${t}`])),
    '/popup-outcome/other/signed-in', '/popup-outcome/upsell//signed-in/', '/popup-outcome/upsell/limit',
    '/auth/success/google', '/auth/success/email', '/auth/success/apple', '/auth/success/google/new', '/auth/success/email/existing', '/auth/error/x', '/auth/redirect',
    '/game/complete/normal/easy', '/game/complete/daily/hard', '/game/complete/normal', '/game/complete/x/y/z', '/game/complete//easy', '/game/complete-deferred/normal/medium',
    '/game/start/easy', '/game/tutorial-complete/first-run', '/game/first-move', '/game/abandon/26-50', '/game/first-finish',
    '/tour/start', '/tour/complete', '/tour/skip', '/tour/exit-at/3', '/coach/shown/place', '/coach/tour-opened', '/coach/dismissed/place',
    '/funnel/purchase/web', '/funnel/trial-start', '/ab/ask-order/signin-first/assigned', '/visit/day/new', '/signin-eligible/earned/placement',
    '/welcome-signed-in/shown', '/return/organic/d1', '/return/sudoku_tired_of_ads/d2-7',
    ...LANDING_TAGS.map((t) => `/return/${t.tag}/d0`),
    ...POPUP_EVENT_PREFIXES.map((p) => (p.endsWith('/') ? `${p}x` : p)),
    ...FEATURES.flatMap((f) => f.steps.flatMap((s) => [...(s.match.exact ?? []), ...(s.match.prefix ?? []).map((p) => `${p}x`)])),
    // Mixed case: the derived CASEs are case-sensitive where the JS is (= and substr) and not where LIKE is.
    '/Game/Complete/normal/easy', '/INSTALL/prompt/ios', '/Popup-Outcome/upsell/limit/signed-in', '/UPSELL/shown/limit', '/Return/x/d0', '/TOUR/skip', '/Signin-Prompt/accept', '/install/PWA-installed',
    // NUL paths (geo.nulPath.test.ts): the SQL sees the text up to the NUL in some functions.
    '/return\u0000x', '/install/pwa-installed\u0000', '/page\u0000x',
  ]),
]

/** A small deterministic PRNG, so the fixture is the same on every run. */
function prng(seed: number) {
  let s = seed
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
}

function fixture(): HitRow[] {
  const rnd = prng(20261103)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
  const rows: HitRow[] = []
  const timesOf = (c: (typeof dated)[number]) => {
    const att = campaignAttributionStartMs(c)!
    const [from, to] = etFlightRangeMs(c.flightStart!, c.flightEnd)
    return [att - 1, att, att + 5 * H, from - 1, from, from + D + 7 * H, to - 1, to, to + 2 * D + 3 * H]
  }
  const base = (ts: number, c: (typeof dated)[number]): HitRow => {
    const r = rnd()
    const campaign = r < 0.7 ? pick(c.ucValues) : r < 0.8 ? '' : r < 0.9 ? 'not_a_flight' : c.ucValues[0].toUpperCase()
    const household = rnd() < 0.05
    return {
      ts,
      campaign,
      site: pick(['bestsudoku-web', 'bestsudoku-app', 'elsewhere', LANDING_SITES[0]]),
      visitor: rnd() < 0.6 ? 'new' : 'returning',
      device: pick(['mobile', 'desktop', 'tablet']),
      os: pick(['Android', 'iOS', 'Windows']),
      region: household ? 'North Carolina' : pick(['Ohio', 'Texas', '']),
      screenw: household ? 412 : pick([0, 390, 800, 1200, 1600]),
      // Map mode reads only rows with a location: about half have one, from a few made-up points.
      ...(rnd() < 0.5 ? pick([{ lat: '39.96', lon: '-83.00', city: 'Columbus' }, { lat: '30.27', lon: '-97.74', city: 'Austin' }, { lat: '35.78', lon: '-78.64', city: 'Raleigh' }]) : {}),
      medium: rnd() < 0.05 ? 'lifecycle' : '',
    }
  }
  // Every path, at times around the registry boundaries (attribution start, ET flight window start and end), the
  // tracking activation and the install fix, with random hours: about 10 rows a path.
  const fix = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS ?? Date.parse('2026-09-26T16:26:36Z')
  for (const path of PATHS) {
    for (let i = 0; i < 10; i++) {
      const c = pick(dated)
      const t = rnd() < 0.15 ? pick([fix - 1, fix, fix + 3 * H]) : pick(timesOf(c)) + (rnd() < 0.5 ? Math.floor(rnd() * 23) * H : 0)
      rows.push({ ...base(t, c), path })
    }
  }
  // A dense core the heavy rings must find: install rows (every pop-up and key-event dim describes them, and a feature
  // step matches them) and landing arrivals, tagged by an in-flight campaign, first beacons, on a landing site.
  for (const c of dated) {
    const [from] = etFlightRangeMs(c.flightStart!, c.flightEnd)
    const att = campaignAttributionStartMs(c)!
    for (const ts of [Math.max(att, fix) + H, from + D + 7 * H, from + 2 * D + 13 * H]) {
      for (const uc of c.ucValues) {
        for (const path of ['/install/pwa-installed', '/popup-outcome/install-prompt/installed', '/install/prompt/android', `/return/${uc}/d0`]) {
          rows.push({ ts, campaign: uc, path, site: 'bestsudoku-web', visitor: 'new', device: 'mobile', os: 'Android', region: 'Ohio', screenw: 390 })
        }
      }
    }
  }
  return rows
}

const ROWS = fixture()
const first = Math.min(...ROWS.map((r) => r.ts))
const last = Math.max(...ROWS.map((r) => r.ts))
const RANGE = { since: new Date(first - 3 * D).toISOString().slice(0, 10), until: new Date(last + 5 * D).toISOString().slice(0, 10) }
// A sub-day window on a flight start: the late inputs list only the boundaries inside it, and the guard's exact window applies.
const mid = dated[Math.floor(dated.length / 2)]
const midFrom = etFlightRangeMs(mid.flightStart!, mid.flightEnd)[0]
const SUB_DAY = { since: new Date(midFrom - 6 * H).toISOString(), until: new Date(midFrom + D + 12 * H).toISOString() }

const HOISTED = ['screenwBucket', 'pathFamily', 'popupFamily', 'popupOutcome', 'gameMode', 'gameDifficulty', 'campaignFlight', 'arrival', 'keyEvent', 'hourEt', 'flightDay', 'landingTag']
const landing = liveLandingTags()[0] ?? LANDING_TAGS[0].tag
const VALUE: Record<string, string> = {
  screenwBucket: '(unknown)',
  pathFamily: 'install',
  popupFamily: 'install',
  popupOutcome: 'shown',
  gameMode: 'normal',
  gameDifficulty: 'easy',
  campaignFlight: dated[0].id,
  arrival: 'tagged',
  keyEvent: 'raw-install-signal',
  hourEt: '12',
  flightDay: '1',
  landingTag: landing,
  region: 'Ohio',
}
const drill = (field: string, value = VALUE[field]) => ({ field, value })
const SITES = { sites: ['bestsudoku-web', 'bestsudoku-app', 'elsewhere'] }

/** The heaviest ring the bind headroom sweep found before the derived table (bindHeadroom.test.ts now finds the same 8 dims
 * heaviest with 16 flightDay filters, which the single-dim and ring bodies below also drill), with 16 pathFamily filters. No row can
 * be in it: a landing arrival is a /return/ row, which no pop-up or key-event dim describes (and hourEt's guard drops). */
const HEAVIEST = ['popupOutcome', 'popupFamily', 'keyEvent', 'featureStep', 'hourEt', 'pathFamily', 'flightDay', 'landingTag']
const sixteen = (field: string, value?: string, n = 16) => Array.from({ length: n }, (_, i) => drill(field, value ?? `${field}-${i}`))
/** Heavy rings that do return rows (asserted below): the heaviest with a flight dim in landingTag's place, and the landing
 * ring, each with 16 filters on one value; plus mixed drills. */
const HEAVY: Record<string, Record<string, unknown>> = {
  // 15 filters, not 16: with the landing family in pathFamily's CASE, 16 inlined are 90175 bytes, over MAX_SQL_BYTES (90000) in the old inline form.
  heaviest: { dimension: HEAVIEST[0], dims: HEAVIEST, constraints: sixteen('pathFamily', undefined, 15) },
  heavyInstallFlight: { dimension: HEAVIEST[0], dims: [...HEAVIEST.slice(0, 7), 'campaignFlight'], constraints: sixteen('pathFamily', 'install', 15) },
  // Mixed drills, as many as the inline form still fits under MAX_SQL_BYTES (a pop-up filter inlined is about 8.5 KB).
  heavyInstallArrival: { dimension: HEAVIEST[0], dims: [...HEAVIEST.slice(0, 6), 'arrival'], constraints: [...sixteen('pathFamily', 'install').slice(0, 8), ...Array.from({ length: 3 }, () => drill('keyEvent')), drill('popupFamily')] },
  heavyLanding: { dimension: 'landingTag', dims: ['landingTag', 'flightDay', 'campaignFlight', 'arrival', 'pathFamily'], constraints: sixteen('pathFamily', 'return') },
  popupRing: { dimension: 'pathFamily', dims: ['pathFamily', 'popupFamily', 'popupOutcome', 'hourEt'], constraints: [drill('popupFamily', 'upsell')] },
  // No screen split here: the counts-only guard keeps game rows out of one (screenRing covers screenwBucket).
  gameRing: { dimension: 'gameMode', dims: ['gameMode', 'gameDifficulty', 'keyEvent', 'pathFamily'], constraints: [drill('gameMode'), drill('gameDifficulty')] },
  // A ring drops blank keys, so its '(unknown)' screen rows are out by design: drill a real bucket. The single-dim
  // bodies drill '(unknown)', the label the filter compares against.
  screenRing: { dimension: 'screenwBucket', dims: ['screenwBucket', 'device', 'pathFamily'], constraints: [drill('screenwBucket', '768-1023')] },
}
/** The heavy shapes that must return rows (the prototype's heavy shapes returned none, which proves nothing). */
const MUST_HAVE_ROWS = ['heavyInstallFlight', 'heavyInstallArrival', 'heavyLanding', 'popupRing', 'gameRing', 'screenRing']

const bodies: Record<string, unknown>[] = []
const TOGGLES = [{}, { includeEventBeacons: true }, { includeEventBeacons: true, excludeKnownTraffic: true, ...SITES }]
for (const toggles of TOGGLES) {
  for (const dimension of [...HOISTED, 'featureStep', 'region', 'dateEt']) {
    for (const constraints of [[], HOISTED.includes(dimension) ? [drill(dimension)] : [drill('region')], [drill('pathFamily'), drill('screenwBucket')]]) {
      bodies.push({ dimension, constraints, ...toggles })
    }
  }
  for (const a of HOISTED) {
    for (const b of ['pathFamily', 'screenwBucket', 'device']) {
      if (a === b) continue
      for (const constraints of [[], [drill(a)]]) bodies.push({ dimension: a, dims: [a, b], constraints, ...toggles }, { dimension: b, dims: [b, a], constraints, ...toggles })
    }
  }
}
for (const [, h] of Object.entries(HEAVY)) for (const toggles of [{ includeEventBeacons: true }, { includeEventBeacons: true, excludeKnownTraffic: true, ...SITES }, {}]) bodies.push({ ...h, ...toggles })
for (const constraints of [[drill('pathFamily', 'page')], sixteen('pathFamily', 'install'), [drill('campaignFlight'), drill('screenwBucket')], [drill('flightDay'), drill('arrival'), drill('landingTag')], [drill('keyEvent'), drill('hourEt')]]) {
  for (const toggles of [{}, { includeEventBeacons: true }]) bodies.push({ dimension: 'points', constraints, ...toggles })
}
bodies.push({ dimension: 'dateEt', stepSeries: ['install.installed', 'install.shown', 'no.such-step'], constraints: [drill('pathFamily'), drill('campaignFlight')] })
bodies.push({ dimension: 'dateEt', stepSeries: ['games.start', 'games.complete'], constraints: [drill('gameDifficulty'), drill('screenwBucket', '1440+')] })
// The sub-day window, for the flight and heavy shapes.
for (const h of Object.values(HEAVY)) bodies.push({ ...h, ...SUB_DAY, includeEventBeacons: true })
for (const d of ['flightDay', 'campaignFlight', 'arrival', 'landingTag']) bodies.push({ dimension: d, dims: [d, 'pathFamily'], constraints: [drill('pathFamily'), drill(d)], ...SUB_DAY, includeEventBeacons: true })

let db: DatabaseSync
let undo: () => void = () => {}
beforeAll(() => {
  db = openHitsDb()
  insertHits(db, ROWS)
  return () => db.close()
})
afterEach(() => {
  derivedColumns.on = true
  flightAttribution.late = true
})

interface Run {
  json: any
  sql: string
  binds: unknown[]
}
/** One handler call on a fresh cache, with the given forms; returns the JSON and the one statement it ran (and its binds). */
async function post(body: Record<string, unknown>, derived: boolean, late: boolean): Promise<Run> {
  undo()
  undo = installCaches(memoryCache())
  derivedColumns.on = derived
  flightAttribution.late = late
  const base = sqliteD1(db)
  let binds: unknown[] = []
  const recording = {
    ...base,
    prepare: (sql: string) => {
      const p = base.prepare(sql)
      return { ...p, bind: (...v: unknown[]) => ((binds = v), p.bind(...v)) }
    },
  } as unknown as ReturnType<typeof sqliteD1>
  const res = await onRequestPost({ request: { json: async () => ({ limit: 500, metric: 'pageviews', ...RANGE, ...body }) }, env: { gss_geo: recording }, waitUntil: () => {} } as any)
  undo()
  undo = () => {}
  return { json: (await res.json()) as any, sql: base.statements[0] ?? '', binds }
}

const DERIVED_TABLE = 'FROM (SELECT hits.*, '
const rowsOf = (j: any) => (j.rows ?? j.series?.flatMap((s: any) => s.rows) ?? []) as unknown[]
const bytes = (s: string) => new TextEncoder().encode(s).length
/** The plan lines of `sql`, numbers dropped (sub-query ids). */
const plan = (sql: string, binds: unknown[]) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(binds as never[])) as { detail: string }[]).map((r) => r.detail.replace(/\d+/g, '#'))

describe('derived columns', () => {
  it('every response is exactly the inline form, late flight attribution on and off', async () => {
    let derivedRuns = 0
    let nonEmpty = 0
    const usesHoisted = (b: Record<string, unknown>, late: boolean) =>
      [b.dimension, ...((b.dims as string[]) ?? []), ...(b.constraints as { field: string }[]).map((c) => c.field)].some(
        (d) => HOISTED.includes(d as string) && !(late && b.dimension !== 'points' && ['campaignFlight', 'flightDay', 'arrival', 'landingTag'].includes(d as string)),
      )
    for (const late of [true, false]) {
      for (const body of bodies) {
        const now = await post(body, true, late)
        const old = await post(body, false, late)
        expect(old.json.error, JSON.stringify({ late, body })).toBeUndefined() // both forms answer: no shape here is refused inline
        expect(now.json, JSON.stringify({ late, body })).toEqual(old.json)
        expect(now.binds, 'no bind moves').toEqual(old.binds)
        expect(old.sql.includes(DERIVED_TABLE), 'the inline form has no derived table').toBe(false)
        if (now.sql.includes(DERIVED_TABLE)) derivedRuns++
        else expect(now.sql, 'a statement without a derived dim is unchanged').toBe(old.sql)
        if (rowsOf(now.json).length) nonEmpty++
      }
    }
    // Not vacuous: every statement that uses a derived dim outside the late stage reads it from the derived table, and most
    // answers have rows.
    const expected = [true, false].reduce((n, late) => n + bodies.filter((b) => usesHoisted(b, late)).length, 0)
    expect(derivedRuns).toBe(expected)
    expect(nonEmpty).toBeGreaterThan(bodies.length)
  }, 300_000)

  it('the heavy rings return rows, and the heaviest is less than half its inline size', async () => {
    for (const name of MUST_HAVE_ROWS) {
      for (const late of [true, false]) {
        const now = await post({ ...HEAVY[name], includeEventBeacons: true }, true, late)
        const old = await post({ ...HEAVY[name], includeEventBeacons: true }, false, late)
        expect(now.json.rows.length, `${name} returns rows`).toBeGreaterThan(0)
        expect(now.json).toEqual(old.json)
      }
    }
    // Map mode, through the derived table, finds located rows too.
    for (const constraints of [[drill('pathFamily', 'install')], [drill('screenwBucket', '768-1023'), drill('keyEvent')], sixteen('pathFamily', 'install')]) {
      const body = { dimension: 'points', constraints, includeEventBeacons: true }
      const p = await post(body, true, true)
      expect(p.sql, JSON.stringify(body)).toContain(DERIVED_TABLE)
      expect(p.json.rows.length, `points ${JSON.stringify(constraints)} returns rows`).toBeGreaterThan(0)
      expect(p.json).toEqual((await post(body, false, true)).json)
    }
    const now = await post({ ...HEAVY.heaviest, includeEventBeacons: true }, true, true)
    const old = await post({ ...HEAVY.heaviest, includeEventBeacons: true }, false, true)
    expect(now.json).toEqual(old.json)
    expect(now.sql.split('CASE WHEN path = \'/signin-prompt\'').length - 1, 'the pathFamily CASE is stated once').toBe(1)
    expect(old.sql.split('CASE WHEN path = \'/signin-prompt\'').length - 1, 'inline: key, blank test and 15 filters').toBe(17)
    expect(bytes(now.sql) * 2).toBeLessThan(bytes(old.sql))
  })

  it('a labelled key is the blank form with its blanks relabelled, on every row', () => {
    for (const d of HOISTED) {
      for (const label of ['(none)', '(unknown)']) {
        const e = breakdownColumnExpr(d, '')
        const sql = withFlightRegistry(`SELECT COUNT(*) AS n, SUM((${breakdownColumnExpr(d, label)}) IS (CASE WHEN (${e}) = '' THEN '${label}' ELSE (${e}) END)) AS same FROM hits`)
        const r = db.prepare(sql).get() as { n: number; same: number }
        expect(r.same, `${d} ${label}`).toBe(r.n)
      }
    }
  })

  it('keeps the query plan: the derived table is flattened into the same index range scan', async () => {
    const shapes = [
      ...Object.values(HEAVY).map((h) => ({ ...h, includeEventBeacons: true })),
      ...Object.values(HEAVY).map((h) => ({ ...h, includeEventBeacons: true, ...SITES })),
      { dimension: 'pathFamily', constraints: sixteen('pathFamily', 'install'), includeEventBeacons: true },
      { dimension: 'points', constraints: sixteen('pathFamily', 'install'), ...SITES },
      { dimension: 'keyEvent', dims: ['keyEvent', 'flightDay'], constraints: [drill('flightDay')] },
      { dimension: 'dateEt', stepSeries: ['install.installed'], constraints: [drill('pathFamily')] },
    ]
    for (const late of [true, false]) {
      for (const body of shapes) {
        const now = await post(body, true, late)
        const old = await post(body, false, late)
        expect(now.sql).toContain(DERIVED_TABLE)
        expect(old.sql, JSON.stringify(body)).not.toBe('')
        const p = plan(now.sql, now.binds)
        // The same plan nodes: one range scan of hits, the same subqueries. Only their order differs, as the
        // derived table lists its columns in first-use order rather than where each expression sat inline.
        expect([...p].sort(), JSON.stringify(body)).toEqual([...plan(old.sql, old.binds)].sort())
        const index = (body as { sites?: unknown }).sites ? /^SEARCH hits USING INDEX idx_hits_site_ts \(site=\? AND ts>\? AND ts<\?\)$/ : /^SEARCH hits USING INDEX idx_hits_ts \(ts>\? AND ts<\?\)$/
        expect(p.some((l) => index.test(l)), p.join('\n')).toBe(true)
        expect(p.filter((l) => /\bhits\b/.test(l) && !index.test(l)), 'no other read of hits').toEqual([])
      }
    }
  })
})
