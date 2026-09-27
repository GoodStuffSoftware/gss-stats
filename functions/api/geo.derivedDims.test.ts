// The popupFamily / popupOutcome / gameMode / gameDifficulty / campaignFlight derived dimensions
// (functions/api/geo.ts), run on a REAL SQLite engine (node:sqlite, the dialect D1 speaks), the
// same way geo.mergedSql.test.ts does it. Two layers:
//  1. the CASE expressions themselves, row for row against their JS readings of the canonical
//     classifiers (classifyPopupPath, parseGameCompletePath, campaignAttributionClause), over
//     the full wire vocabulary plus the edge rows that must get no value;
//  2. the actual onRequestPost handler with a node:sqlite-backed fake D1, so the grouping, the
//     event-beacon exclusion lift, the prefilters and the bind count are what a request gets.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { breakdownColumnExpr, onRequestPost, RING_EXCLUDED_DIMS, EVENT_DIMS, GEO_DIMS } from './geo'
import type { CacheLike } from '../_lib/edgeCache'
import {
  INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS,
  popupFamilyOf,
  popupOutcomeOf,
  sqlLit,
  sqlInt,
  trackingActivationStartMs,
  etDateFromMs,
} from '../../src/lib/popupEvents'
import { CAMPAIGNS, etMidnightUtcMs, gameDimOf, keyEventOf, arrivalOf } from '../../src/lib/campaigns'
import { etWallTimeMs, etDateFast } from '../../src/lib/etTime'

const noopCache: CacheLike = { match: async () => undefined, put: async () => {} }

let db: DatabaseSync
beforeEach(() => {
  ;(globalThis as any).caches = { default: noopCache }
  db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE hits (
    ts INTEGER, site TEXT DEFAULT '', path TEXT DEFAULT '', referrer TEXT DEFAULT '', country TEXT DEFAULT '',
    region TEXT DEFAULT '', city TEXT DEFAULT '', postal TEXT DEFAULT '', continent TEXT DEFAULT '',
    timezone TEXT DEFAULT '', lat TEXT DEFAULT '', lon TEXT DEFAULT '', colo TEXT DEFAULT '', org TEXT DEFAULT '',
    device TEXT DEFAULT '', browser TEXT DEFAULT '', os TEXT DEFAULT '', lang TEXT DEFAULT '',
    screenw INTEGER DEFAULT 0, visitor TEXT DEFAULT 'new', refpath TEXT DEFAULT '', source TEXT DEFAULT '',
    medium TEXT DEFAULT '', campaign TEXT DEFAULT ''
  )`)
})
afterEach(() => {
  db.close()
  delete (globalThis as any).caches
})

type Row = { ts: number; path?: string; campaign?: string; medium?: string; device?: string; region?: string; screenw?: number; site?: string }
function insert(r: Row) {
  db.prepare('INSERT INTO hits (ts, path, campaign, medium, device, region, screenw, site) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    r.ts,
    r.path ?? '/',
    r.campaign ?? '',
    r.medium ?? '',
    r.device ?? 'mobile',
    r.region ?? 'Ohio',
    r.screenw ?? 390,
    r.site ?? 'bestsudoku-web',
  )
}
function exprValues(dim: string, rows: Row[]): string[] {
  for (const r of rows) insert(r)
  const sql = `SELECT ${breakdownColumnExpr(dim, '')} AS v FROM hits ORDER BY rowid`
  return (db.prepare(sql).all() as any[]).map((x) => String(x.v))
}

const ACT = trackingActivationStartMs()!
const FIX = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS!
const LIVE = FIX + 3_600_000 // measured: after activation AND after the install fix

// The whole wire vocabulary (lib/popupEvents.ts FINAL LIST) plus rows that must get no value.
const POPUP_PATHS = [
  '/signin-prompt/placement', '/signin-prompt/streak', '/signin-prompt/accept', '/signin-prompt/dismiss', '/signin-prompt', '/signin-prompt/',
  '/promo-first50/shown', '/promo-first50/accept', '/promo-first50/dismiss', '/promo-first50/bogus',
  '/first50-congrats/shown', '/first50-congrats/ack', '/first50-congrats/close', '/first50-congrats/other',
  '/upsell/shown/cadence', '/upsell/accept/limit', '/upsell/dismiss/daily-locked', '/upsell/shown/upgrade-tap', '/upsell/shown/settings-upgrade', '/upsell/shown',
  '/install/prompt/android', '/install/prompt/ios', '/install/prompt/desktop', '/install/prompt/dismiss', '/install/prompt/dismiss-forever', '/install/prompt/have-it',
  '/install/platforms/web', '/install/platforms/play', '/install/play', '/install/pwa-accept', '/install/app-store', '/install/pwa-decline',
  '/install/pwa-installed', '/install/standalone-detected', '/install/play-detected', '/install/bogus',
  ...['signin-prompt', 'first50-offer', 'promo-first50', 'upsell', 'install-prompt'].flatMap((n) =>
    ['signed-in', 'installed', 'returned', 'still-playing'].map((o) => `/popup-outcome/${n}/${o}`),
  ),
  '/popup-outcome/first50-congrats/returned', '/popup-outcome/upsell/bogus', '/popup-outcome/upsell', '/popup-outcome/',
  '/signin-eligible/earned', '/', '/game', '/game/complete/normal/easy', '/return/sudoku_tired_of_ads/d0', '/auth/success/google',
  '/SIGNIN-PROMPT/accept', // case matters: classifyPopupPath is case-sensitive, so is the SQL
  // Off-vocabulary shapes: trailing and doubled slashes, extra segments. classifyPopupPath
  // ignores empty segments and anything past the ones it reads, and so must the SQL.
  '/signin-prompt/accept/',
  '/signin-prompt//dismiss',
  '/signin-prompt/placement/extra',
  '/promo-first50/shown/',
  '/promo-first50//accept',
  '/first50-congrats/ack/x',
  '/upsell/shown/cadence/extra',
  '/upsell//accept//limit',
  '/upsell/dismiss/',
  '/install/prompt/android/',
  '/install//prompt//ios',
  '/install/play/extra',
  '/install/pwa-installed/',
  '/popup-outcome/upsell/signed-in/extra',
  '/popup-outcome//first50-offer//returned/',
  '/popup-outcome/install-prompt/installed/',
]

describe('popupFamily / popupOutcome SQL match classifyPopupPath row for row', () => {
  const rows: Row[] = [
    ...POPUP_PATHS.map((path) => ({ ts: LIVE, path })),
    // Unmeasured: before tracking activation (ET midnight of TRACKING_ACTIVATION_DATE_ET).
    { ts: ACT - 1, path: '/signin-prompt/placement' },
    { ts: ACT, path: '/signin-prompt/placement' }, // boundary is inclusive
    // Pre-fix install-gap rows are unmeasured; other install rows at the same instant are not.
    { ts: FIX - 60_000, path: '/popup-outcome/install-prompt/installed' },
    { ts: FIX - 60_000, path: '/install/pwa-installed' },
    { ts: FIX - 60_000, path: '/install/prompt/android' },
    { ts: FIX, path: '/popup-outcome/install-prompt/installed' },
  ]

  it('popupFamily', () => {
    const got = exprValues('popupFamily', rows)
    expect(got).toEqual(rows.map((r) => popupFamilyOf(r.path!, r.ts)))
  })
  it('popupOutcome', () => {
    const got = exprValues('popupOutcome', rows)
    expect(got).toEqual(rows.map((r) => popupOutcomeOf(r.path!, r.ts)))
  })

  it('the JS readings say what the Pop-ups page needs them to say', () => {
    // first50-offer is the REAL wire name of the first-50 promo's outcome beacon.
    expect(popupFamilyOf('/popup-outcome/first50-offer/signed-in', LIVE)).toBe('promo-first50')
    expect(popupOutcomeOf('/popup-outcome/first50-offer/signed-in', LIVE)).toBe('signed-in')
    expect(popupFamilyOf('/popup-outcome/install-prompt/installed', LIVE)).toBe('install')
    // The shown row counts as outcome 'shown', whatever the reason / platform.
    expect(popupOutcomeOf('/signin-prompt/placement', LIVE)).toBe('shown')
    expect(popupOutcomeOf('/install/prompt/ios', LIVE)).toBe('shown')
    expect(popupOutcomeOf('/upsell/shown/cadence', LIVE)).toBe('shown')
    expect(popupOutcomeOf('/first50-congrats/ack', LIVE)).toBe('accept')
    expect(popupOutcomeOf('/install/pwa-installed', LIVE)).toBe('pwa-installed')
    // No value: not a pop-up, the platform list, an unknown outcome name, unmeasured rows.
    for (const p of ['/', '/signin-eligible/earned', '/install/platforms/web', '/popup-outcome/first50-congrats/returned', '/game/complete/normal/easy']) {
      expect(popupFamilyOf(p, LIVE)).toBe('')
    }
    expect(popupFamilyOf('/signin-prompt/placement', ACT - 1)).toBe('')
    expect(popupOutcomeOf('/popup-outcome/install-prompt/installed', FIX - 1)).toBe('')
  })

  it('first50-offer lands on promo-first50 in SQL too', () => {
    const got = exprValues('popupFamily', [{ ts: LIVE, path: '/popup-outcome/first50-offer/returned' }])
    expect(got).toEqual(['promo-first50'])
  })
})

describe('gameMode / gameDifficulty SQL match parseGameCompletePath', () => {
  const paths = [
    '/game/complete/normal/easy', '/game/complete/daily/expert', '/game/complete/normal/unknown',
    '/game/complete/normal', '/game/complete/', '/game/complete//easy', '/game/complete/normal/easy/x',
    '/game', '/game/completely-new', '/', '/Game/complete/normal/easy',
  ]
  for (const dim of ['gameMode', 'gameDifficulty'] as const) {
    it(dim, () => {
      const rows = paths.map((path) => ({ ts: LIVE, path }))
      expect(exprValues(dim, rows)).toEqual(paths.map((p) => gameDimOf(dim, p)))
    })
  }
  it('buckets a right-prefix, wrong-shape row as (other), like /api/completions', () => {
    expect(gameDimOf('gameMode', '/game/complete/normal')).toBe('(other)')
    expect(gameDimOf('gameMode', '/game')).toBe('')
  })
})

describe('campaignFlight SQL follows campaignAttributionClause + EXCLUSIONS', () => {
  const android = CAMPAIGNS[0]
  const retest = CAMPAIGNS.find((c) => c.flightStartTimeEt)!
  it('attributes by uc and flight start, and drops excluded rows', () => {
    const rows: Row[] = [
      { ts: etMidnightUtcMs(android.flightStart!) + 1000, campaign: 'sudoku_tired_of_ads' }, // android
      { ts: etMidnightUtcMs(android.flightStart!) - 1000, campaign: 'sudoku_tired_of_ads' }, // before its flight
      { ts: LIVE, campaign: 'sudoku_tired_of_ads_test' }, // QA variant, not in ucValues
      { ts: LIVE, campaign: 'beta_v2_tier1en' }, // unrelated campaign
      { ts: LIVE, campaign: 'sudoku_tired_of_ads', medium: 'lifecycle' }, // EXCLUSIONS: lifecycle email
      { ts: etWallTimeMs(retest.flightStart!, retest.flightStartTimeEt) - 1000, campaign: 'sudoku_funnel_retest' }, // pre-schedule QA
      { ts: etWallTimeMs(retest.flightStart!, retest.flightStartTimeEt), campaign: 'sudoku_funnel_retest' }, // schedule start
      { ts: LIVE, campaign: '' },
    ]
    expect(exprValues('campaignFlight', rows)).toEqual([android.id, '', '', '', '', '', retest.id, ''])
  })
})

describe('arrival / keyEvent SQL (the Overall timeline series filters)', () => {
  const android = CAMPAIGNS[0]
  const inFlight = etMidnightUtcMs(android.flightStart!) + 1000
  it('keyEvent matches its JS reading, and install counts only from the install fix on', () => {
    const rows: Row[] = [
      '/auth/success/google', '/auth/success/email', '/auth/success/google/new', '/popup-outcome/install-prompt/installed',
      '/install/pwa-installed', '/install/standalone-detected', '/install/play-detected', '/install/play', '/game/complete/normal/easy', '/game', '/',
    ].map((path) => ({ ts: LIVE, path }))
    rows.push({ ts: FIX - 1, path: '/popup-outcome/install-prompt/installed' })
    const got = exprValues('keyEvent', rows)
    expect(got).toEqual(rows.map((r) => keyEventOf(r.path!, r.ts)))
    expect(got).toEqual(['auth-success', 'auth-success', '', 'install', 'raw-install-signal', 'raw-install-signal', 'raw-install-signal', '', 'game-complete', '', '', ''])
  })
  it("arrival: a first-ever beacon is 'tagged' only when a campaign flight claims it", () => {
    for (const [visitor, campaign, ts] of [
      ['new', 'sudoku_tired_of_ads', inFlight],
      ['new', 'beta_v2_tier1en', inFlight],
      ['new', '', inFlight],
      ['returning', 'sudoku_tired_of_ads', inFlight],
    ] as const) {
      db.prepare('INSERT INTO hits (ts, path, campaign, visitor) VALUES (?, ?, ?, ?)').run(ts, '/', campaign, visitor)
    }
    const got = (db.prepare(`SELECT ${breakdownColumnExpr('arrival', '')} AS v FROM hits ORDER BY rowid`).all() as any[]).map((x) => x.v)
    expect(got).toEqual(['tagged', 'untagged', 'untagged', ''])
    expect(arrivalOf('new', android.id)).toBe('tagged')
    expect(arrivalOf('returning', android.id)).toBe('')
  })
})

describe('review fixes: arrivals, raw signals, date limit, request caps', () => {
  it('keyEvent: a pre-fix /install/pwa-installed is not a raw install signal; post-fix it is; off-vocabulary shapes agree', () => {
    const rows: Row[] = [
      { ts: FIX - 1, path: '/install/pwa-installed' },
      { ts: FIX, path: '/install/pwa-installed' },
      { ts: FIX - 1, path: '/install/standalone-detected' },
      { ts: LIVE, path: '/install/play-detected/' },
      { ts: LIVE, path: '/popup-outcome/install-prompt/installed/' },
      { ts: FIX - 1, path: '/popup-outcome//install-prompt/installed' },
    ]
    const got = exprValues('keyEvent', rows)
    expect(got).toEqual(rows.map((r) => keyEventOf(r.path!, r.ts)))
    expect(got).toEqual(['', 'raw-install-signal', 'raw-install-signal', 'raw-install-signal', 'install', ''])
  })

  it("the timeline's tagged-arrivals total per flight equals /api/campaigns' taggedArrivals", async () => {
    const retest = CAMPAIGNS.find((c) => c.flightStartTimeEt)!
    const start = etWallTimeMs(retest.flightStart!, retest.flightStartTimeEt)
    // First-ever beacons for the retest: page views AND event beacons (e.g. an install prompt as
    // the very first row), plus a pre-fix gap row, a returning row and pre-schedule QA.
    const seed: [string, string, number][] = [
      ['/', 'new', 5],
      ['/game', 'new', 2],
      ['/install/prompt/android', 'new', 3],
      ['/signin-prompt/placement', 'new', 1],
      ['/', 'returning', 4],
    ]
    for (const [path, visitor, n] of seed) {
      for (let i = 0; i < n; i++) db.prepare('INSERT INTO hits (ts, path, campaign, visitor, site) VALUES (?, ?, ?, ?, ?)').run(FIX + 3_600_000 + i, path, 'sudoku_funnel_retest', visitor, 'bestsudoku-web')
    }
    db.prepare('INSERT INTO hits (ts, path, campaign, visitor, site) VALUES (?, ?, ?, ?, ?)').run(start - 1000, '/', 'sudoku_funnel_retest', 'new', 'bestsudoku-web')
    db.prepare('INSERT INTO hits (ts, path, campaign, visitor, site) VALUES (?, ?, ?, ?, ?)').run(FIX - 1000, '/install/pwa-installed', 'sudoku_funnel_retest', 'new', 'bestsudoku-web')

    // The timeline series: a date query filtered to arrival = tagged (no event-beacon opt-in).
    const { body: series } = await post({ dimension: 'dateEt', constraints: [{ field: 'arrival', value: 'tagged' }], limit: 400, ...range, since: '2026-09-01', until: '2026-10-05' })
    const timelineTotal = series.rows.reduce((a: number, r: any) => a + r.pageviews, 0)

    const { onRequestPost: campaignsPost } = await import('./campaigns')
    const { gss_geo } = fakeD1()
    const res = await campaignsPost({ request: { json: async () => ({ campaignId: retest.id }) }, env: { gss_geo }, waitUntil: () => {} } as any)
    const camp: any = await res.json()
    expect(camp.funnel.counts.arrivals).toBe(11)
    expect(timelineTotal).toBe(camp.funnel.counts.arrivals)
  })

  it('a date axis keeps the most recent `limit` days, returned oldest first', async () => {
    const day0 = Date.parse('2025-01-01T12:00:00Z')
    for (let d = 0; d < 450; d++) insert({ ts: day0 + d * 86_400_000 })
    const { body } = await post({ dimension: 'date', limit: 400, since: '2024-12-01', until: '2026-12-31' })
    const days = body.rows.map((r: any) => r.key.date)
    expect(days).toHaveLength(400)
    expect(days[0]).toBe(new Date(day0 + 50 * 86_400_000).toISOString().slice(0, 10))
    expect(days[399]).toBe(new Date(day0 + 449 * 86_400_000).toISOString().slice(0, 10))
    expect([...days].sort()).toEqual(days)
    expect(body.totals.pageviews).toBe(450)
  })

  it('caps sites at 50 and filters at 16 with a clear 400, before touching D1', async () => {
    const tooManySites = await post({ dimension: 'device', sites: Array.from({ length: 51 }, (_, i) => `s${i}`), ...range })
    expect(tooManySites.body.error).toMatch(/too many sites/)
    expect(tooManySites.calls).toHaveLength(0)
    const tooManyFilters = await post({ dimension: 'device', constraints: Array.from({ length: 17 }, () => ({ field: 'device', value: 'mobile' })), ...range })
    expect(tooManyFilters.body.error).toMatch(/too many filters/)
    expect(tooManyFilters.calls).toHaveLength(0)
    const ok = await post({ dimension: 'device', sites: Array.from({ length: 50 }, (_, i) => `s${i}`), constraints: Array.from({ length: 16 }, () => ({ field: 'device', value: 'mobile' })), ...range })
    expect(ok.body.error).toBeUndefined()
  })

  it('refuses a statement over D1\'s 100 bound parameters with a clear 400 (50 sites + 16 path filters + a referrer ring)', async () => {
    const { body, calls } = await post({
      dimension: 'referrer',
      breakdown: 'device',
      dims: ['referrer', 'device'],
      sites: Array.from({ length: 50 }, (_, i) => `s${i}`),
      constraints: Array.from({ length: 16 }, (_, i) => ({ field: 'path', value: `/p${i}` })),
      excludeOwnVisits: true,
      ownBrowser: 'Opera',
      ownOS: 'Windows',
      excludeKnownTraffic: true,
      ...range,
    })
    expect(body.error).toMatch(/too many to query at once \(110 values; at most 100\)/)
    expect(calls).toHaveLength(0) // never reached D1
  })

  it('exactly 100 bound parameters is still allowed', async () => {
    const { body, calls } = await post({
      dimension: 'referrer',
      breakdown: 'device',
      dims: ['referrer', 'device'],
      sites: Array.from({ length: 50 }, (_, i) => `s${i}`),
      constraints: Array.from({ length: 16 }, (_, i) => ({ field: 'path', value: `/p${i}` })),
      excludeOwnVisits: true,
      ownBrowser: 'Opera',
      ownOS: 'Windows',
      ...range,
    })
    expect(body.error).toBeUndefined()
    expect(calls[0].binds.length).toBe(100)
  })

  it('refuses a statement over 90,000 bytes of SQL with a clear 400 (16 pop-up outcome filters)', async () => {
    const { body, calls } = await post({
      dimension: 'device',
      constraints: Array.from({ length: 16 }, () => ({ field: 'popupOutcome', value: 'shown' })),
      ...range,
    })
    expect(body.error).toMatch(/too large \(\d+ bytes; at most 90000\)/)
    expect(calls).toHaveLength(0)
  })

  it('a failing D1 query returns a generic error, never the D1 message', async () => {
    const gss_geo = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('SQLITE_ERROR: secret detail') } }) }) }
    const res = await onRequestPost({ request: { json: async () => ({ dimension: 'device', ...range }) }, env: { gss_geo }, waitUntil: () => {} } as any)
    const text = await res.text()
    expect(res.status).toBe(500)
    expect(text).not.toContain('secret detail')
  })
})

describe("dateEt — US-Eastern day buckets in SQL, matching the BSK code's own ET days", () => {
  const Z = (iso: string) => Date.parse(iso)
  it('splits at ET midnight, not UTC midnight (EDT: 04:00Z)', () => {
    const rows: Row[] = ['2026-09-27T03:59:59.999Z', '2026-09-27T04:00:00.000Z', '2026-09-26T23:30:00Z', '2026-09-27T00:30:00Z'].map((iso) => ({ ts: Z(iso) }))
    expect(exprValues('dateEt', rows)).toEqual(['2026-09-26', '2026-09-27', '2026-09-26', '2026-09-26'])
  })
  it('splits at 05:00Z in winter (EST)', () => {
    const rows: Row[] = ['2026-12-15T04:59:59Z', '2026-12-15T05:00:00Z'].map((iso) => ({ ts: Z(iso) }))
    expect(exprValues('dateEt', rows)).toEqual(['2026-12-14', '2026-12-15'])
  })
  it('agrees with etDateFast and etDateFromMs hour by hour across both 2026 DST transition days', () => {
    const rows: Row[] = []
    for (const day of ['2026-03-07T00:00:00Z', '2026-10-31T00:00:00Z']) {
      for (let h = 0; h < 72; h++) rows.push({ ts: Z(day) + h * 3_600_000 + 1234 })
    }
    const got = exprValues('dateEt', rows)
    expect(got).toEqual(rows.map((r) => etDateFast(r.ts)))
    expect(got).toEqual(rows.map((r) => etDateFromMs(r.ts)))
    // 2026-11-01 lasts 25 hours in ET (04:00Z to 05:00Z the next day), 2026-03-08 only 23.
    expect(got.filter((d) => d === '2026-11-01')).toHaveLength(25)
    expect(got.filter((d) => d === '2026-03-08')).toHaveLength(23)
  })
  it('dateEt is a trend bucket: never a ring and never a filter', async () => {
    expect(RING_EXCLUDED_DIMS.has('dateEt')).toBe(true)
    insert({ ts: LIVE, path: '/' })
    const { calls } = await post({ dimension: 'device', constraints: [{ field: 'dateEt', value: '2026-09-26' }], ...range })
    expect(calls[0].binds).not.toContain('2026-09-26')
  })
})

describe('sqlLit / sqlInt guard every inlined constant', () => {
  it('rejects anything that could leave a string literal', () => {
    expect(sqlLit('/popup-outcome/first50-offer/')).toBe("'/popup-outcome/first50-offer/'")
    for (const bad of ["x'", "a' OR '1'='1", 'a;b', 'a"b', 'a\\b', 'a\nb']) expect(() => sqlLit(bad)).toThrow()
    expect(() => sqlInt(1.5)).toThrow()
    expect(sqlInt(FIX)).toBe(FIX)
  })
})

// ── The real handler ────────────────────────────────────────────────────────────────────
function fakeD1() {
  const calls: { sql: string; binds: unknown[] }[] = []
  const gss_geo = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql, binds })
          return { all: async () => ({ results: db.prepare(sql).all(...(binds as any[])) }) }
        },
      }
    },
  }
  return { gss_geo: gss_geo as any, calls }
}
async function post(body: unknown) {
  const { gss_geo, calls } = fakeD1()
  const ctx = { request: { json: async () => body }, env: { gss_geo }, waitUntil: () => {} } as any
  const res = await onRequestPost(ctx)
  return { body: (await res.json()) as any, calls }
}
const range = { since: new Date(ACT - 86_400_000).toISOString(), until: new Date(LIVE + 86_400_000).toISOString() }

describe('onRequestPost with the derived dims', () => {
  beforeEach(() => {
    const seed: [string, number][] = [
      ['/signin-prompt/placement', 6], ['/signin-prompt/accept', 2], ['/signin-prompt/dismiss', 3],
      ['/promo-first50/shown', 4], ['/popup-outcome/first50-offer/signed-in', 1],
      ['/install/prompt/android', 5], ['/popup-outcome/install-prompt/installed', 1],
      ['/', 40], ['/game', 12], ['/signin-eligible/earned', 3], ['/game/complete/normal/easy', 2], ['/game/complete/daily/hard', 1],
    ]
    for (const [path, n] of seed) for (let i = 0; i < n; i++) insert({ ts: LIVE + i, path })
    insert({ ts: ACT - 5, path: '/signin-prompt/placement' }) // pre-activation: never counted
  })

  it('groups popupFamily × popupOutcome over pop-up rows only, without opting in to event beacons', async () => {
    const { body, calls } = await post({ dimension: 'popupFamily', breakdown: 'popupOutcome', dims: ['popupFamily', 'popupOutcome'], limit: 100, ...range })
    const cells = Object.fromEntries(body.rows.map((r: any) => [`${r.key.popupFamily}|${r.key.popupOutcome}`, r.pageviews]))
    expect(cells).toEqual({
      'signin-prompt|shown': 6,
      'signin-prompt|accept': 2,
      'signin-prompt|dismiss': 3,
      'promo-first50|shown': 4,
      'promo-first50|signed-in': 1, // first50-offer → promo-first50
      'install|shown': 5,
      'install|installed': 1,
    })
    expect(body.totals.pageviews).toBe(22)
    // D1 caps a query at 100 bound parameters.
    expect(calls[0].binds.length).toBeLessThan(100)
  })

  it('a single popupFamily chart never shows page views as a "(none)" bar', async () => {
    const { body } = await post({ dimension: 'popupFamily', limit: 50, ...range })
    expect(body.rows.map((r: any) => r.key.popupFamily).sort()).toEqual(['install', 'promo-first50', 'signin-prompt'])
  })

  it('gameMode × gameDifficulty serves the completions breakdown on the generic path', async () => {
    const { body } = await post({ dimension: 'gameMode', breakdown: 'gameDifficulty', dims: ['gameMode', 'gameDifficulty'], limit: 50, ...range })
    const cells = Object.fromEntries(body.rows.map((r: any) => [`${r.key.gameMode}|${r.key.gameDifficulty}`, r.pageviews]))
    expect(cells).toEqual({ 'normal|easy': 2, 'daily|hard': 1 })
  })

  it('ordinary dims keep the standing event-beacon exclusion', async () => {
    const { body } = await post({ dimension: 'path', limit: 50, ...range })
    expect(body.rows.map((r: any) => r.key.path).sort()).toEqual(['/', '/game'])
  })

  it('a drill on popupFamily lifts the exclusion for the other charts on that page', async () => {
    const { body } = await post({ dimension: 'device', constraints: [{ field: 'popupFamily', value: 'install' }], limit: 50, ...range })
    expect(body.totals.pageviews).toBe(6)
  })

  it('whitelist: the new dims are known, only date stays out of multi-dim queries', () => {
    for (const d of ['popupFamily', 'popupOutcome', 'gameMode', 'gameDifficulty', 'campaignFlight']) {
      expect(GEO_DIMS.has(d)).toBe(true)
      expect(RING_EXCLUDED_DIMS.has(d)).toBe(false)
    }
    expect(RING_EXCLUDED_DIMS.has('date')).toBe(true)
    expect(EVENT_DIMS.has('campaignFlight')).toBe(false)
  })
})
