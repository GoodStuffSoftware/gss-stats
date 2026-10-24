// The refused pop-up rows (src/lib/splitGuard.ts REFUSED_POPUP_PATH_PATTERNS: the first-finish sign-in
// ask shown, its eligibility row and its outcomes; ruling 2026-10-24) on a real SQLite engine:
//   - they COUNT in every unsplit and per-ET-day total: /api/popups, the /api/metrics pop-up facts
//     (popupRangePath, popupRangeDaily) and the ads routine's site-wide event read;
//   - they never reach an hour, place or device split: /api/geo leaves them out of every refused
//     dimension, and no reader returns an hour of one (every such row comes back with `hr` NULL);
//   - a sub-day window counts them over whole ET days, so hour windows never read them back per hour;
//   - every OTHER refused row (returns, completions, the funnel, ...) changes nothing: each output
//     with those rows in the data equals the output without them, which is what these readers
//     answered before (they left every refused row out).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { onRequestPost as popupsPost } from './popups'
import { onRequestPost as geoPost } from './geo'
import { onRequestPost as metricsPost } from './metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1, type HitRow } from '../_lib/testing/hitsDb'
import { popupRateOracle } from '../_lib/testing/popupRateOracle'
import { isSplitRefusedPath, REFUSED_POPUP_PATH_PATTERNS, refusedPathMatch, SPLIT_REFUSED_DIMS, SPLIT_REFUSED_PATH_PATTERNS } from '../../src/lib/splitGuard'
import { REFUSED_SAMPLE_PATHS } from '../../src/lib/__fixtures__/refusedPaths'
import { etWallTimeMs } from '../../src/lib/etTime'
import { POPUPS, POPUP_RATE_SPECS } from '../../src/lib/popupEvents'
import { summarizeSiteEvents } from '../../src/lib/adsRules'
import { CAMPAIGNS } from '../../src/lib/campaigns'
import { METRICS } from '../../src/lib/metrics/metrics'
import { createBeaconSource, siteEventsQuery, taggedCountryQuery, WEB_SITE } from '../../scripts/ads-reads/beacon'
import type { MetricsResponseBody } from '../../src/lib/metrics/types'

const Z = (iso: string) => Date.parse(iso)
const DAY = etWallTimeMs('2026-10-07') // 04:00Z, a 24 h EDT day
const NEXT = etWallTimeMs('2026-10-08')
const H = (h: number, m = 30) => DAY + h * 3_600_000 + m * 60_000 // h hours after ET midnight
const SITE = WEB_SITE
const geoCols = { country: 'US', region: 'VA', city: 'Reston', device: 'mobile', browser: 'Chrome', os: 'Android', lang: 'en' }

const FF_ASK = '/signin-prompt/first-finish'
const FF_ELIGIBLE = '/signin-eligible/earned/first-finish'
const FF_OUTCOME = '/popup-outcome/signin-prompt/first-finish/signed-in'

/** Ordinary (splittable) pop-up rows, including the other earned reasons. */
const ORDINARY: (HitRow & { n: number })[] = [
  { ts: H(10), site: SITE, path: '/signin-prompt/placement', n: 5, ...geoCols },
  { ts: H(11), site: SITE, path: '/signin-prompt/accept', n: 3, ...geoCols },
  { ts: H(11), site: SITE, path: '/signin-prompt/dismiss', n: 1, ...geoCols },
  { ts: H(10), site: SITE, path: '/signin-eligible/earned/placement', n: 7, ...geoCols },
  { ts: H(12), site: SITE, path: '/signin-eligible/earned/committed-repeat', n: 11, ...geoCols },
  { ts: H(13), site: SITE, path: '/signin-eligible/earned/committed-challenge', n: 13, ...geoCols },
  { ts: H(12), site: SITE, path: '/popup-outcome/signin-prompt/placement/signed-in', n: 2, ...geoCols },
  { ts: H(9), site: SITE, path: '/upsell/shown/hints', n: 4, ...geoCols },
  { ts: H(9), site: SITE, path: '/game', n: 20, ...geoCols },
]
/** The new refused pop-up rows, spread over three ET hours and two ET days. */
const FIRST_FINISH: (HitRow & { n: number })[] = [
  { ts: H(10), site: SITE, path: FF_ASK, n: 4, ...geoCols },
  { ts: H(11), site: SITE, path: FF_ASK, n: 6, ...geoCols },
  { ts: H(12), site: SITE, path: FF_ASK, n: 8, ...geoCols },
  { ts: NEXT + 3_600_000, site: SITE, path: FF_ASK, n: 1, ...geoCols },
  { ts: H(10), site: SITE, path: FF_ELIGIBLE, n: 9, ...geoCols },
  { ts: H(12), site: SITE, path: FF_ELIGIBLE, n: 10, ...geoCols },
  { ts: H(11), site: SITE, path: FF_OUTCOME, n: 3, ...geoCols },
  // NUL-bearing look-alikes: refused and never counted anywhere (SQLite LIKE stops at the NUL).
  { ts: H(11), site: SITE, path: `${FF_ASK}\u0000x`, n: 900, ...geoCols },
  { ts: H(11), site: SITE, path: `${FF_ELIGIBLE}\u0000`, n: 900, ...geoCols },
]
const FF_ASK_DAY = 18
const FF_ELIGIBLE_DAY = 19
/** Every refused pattern that was refused before this change, with heavy counts, every hour. */
const OLD_REFUSED: (HitRow & { n: number })[] = REFUSED_SAMPLE_PATHS.filter((p) => !REFUSED_POPUP_PATH_PATTERNS.some((pat) => (pat.endsWith('%') ? p.startsWith(pat.slice(0, -1)) : p === pat))).flatMap((path, i) => [
  { ts: H(10), site: SITE, path, n: 100 + i, ...geoCols },
  { ts: H(14), site: SITE, path, n: 200 + i, ...geoCols },
])

let db: DatabaseSync
let undoCaches: () => void
const open = (rows: (HitRow & { n: number })[]) => {
  const d = openHitsDb()
  insertHits(d, rows)
  return d
}
beforeEach(() => {
  vi.useFakeTimers({ now: Z('2026-10-12T12:00:00Z'), toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
  db = open([...ORDINARY, ...FIRST_FINISH, ...OLD_REFUSED])
})
afterEach(() => {
  db.close()
  undoCaches()
  vi.useRealTimers()
})

async function popups(d: DatabaseSync, body: Record<string, unknown>) {
  const statements: { sql: string; binds: unknown[] }[] = []
  const d1 = { prepare: (sql: string) => ({ bind: (...binds: unknown[]) => (statements.push({ sql, binds }), { all: async () => ({ results: d.prepare(sql).all(...(binds as any[])) }) }) }) }
  const res = await popupsPost({ request: { json: async () => body }, env: { gss_geo: d1 } } as any)
  return { body: (await res.json()) as any, statements }
}
async function geo(d: DatabaseSync, body: Record<string, unknown>) {
  const res = await geoPost(pagesContext(postJson('/api/geo', { includeEventBeacons: true, since: '2026-10-07', until: '2026-10-08', ...body }), { gss_geo: sqliteD1(d) }) as any)
  return (await res.json()) as any
}
async function metrics(d: DatabaseSync, context: Record<string, unknown>, requests: Record<string, unknown>[]) {
  const waited: Promise<unknown>[] = []
  const res = await metricsPost(pagesContext(postJson('/api/metrics', { v: 1, context, requests }), { gss_geo: sqliteD1(d) }, waited) as any)
  await Promise.all(waited)
  if (res.status !== 200) throw new Error(await res.text())
  return ((await res.json()) as MetricsResponseBody).results as Record<string, any>
}
const day = { since: '2026-10-07', until: '2026-10-07' }
const twoDays = { since: '2026-10-07', until: '2026-10-08' }

describe('REFUSED_POPUP_PATH_PATTERNS', () => {
  it('is exactly the three first-finish sign-in ask patterns, all refused, none an older pattern', () => {
    expect([...REFUSED_POPUP_PATH_PATTERNS]).toEqual([FF_ASK, FF_ELIGIBLE, '/popup-outcome/signin-prompt/first-finish/%'])
    for (const p of REFUSED_POPUP_PATH_PATTERNS) expect(SPLIT_REFUSED_PATH_PATTERNS).toContain(p)
    for (const p of [FF_ASK, FF_ELIGIBLE, FF_OUTCOME]) expect(isSplitRefusedPath(p)).toBe(true)
  })
})

describe('/api/popups counts the first-finish ask per ET day and never by hour', () => {
  it('the shown reason breakdown and the per-ET-day trend include it; NUL look-alikes never count', async () => {
    const r = (await popups(db, { dimension: 'reason', popup: 'signin-prompt', kind: 'shown', ...twoDays })).body
    const by = Object.fromEntries(r.rows.map((x: any) => [x.key.reason, x.pageviews]))
    expect(by['first-finish']).toBe(FF_ASK_DAY + 1)
    expect(by['placement']).toBe(5)
    const d = (await popups(db, { dimension: 'date', popup: 'signin-prompt', kind: 'shown', ...twoDays })).body
    expect(Object.fromEntries(d.rows.map((x: any) => [x.key.date, x.pageviews]))).toEqual({ '2026-10-07': 5 + FF_ASK_DAY, '2026-10-08': 1 })
    const k = (await popups(db, { dimension: 'kind', popup: 'signin-prompt', ...day })).body
    expect(Object.fromEntries(k.rows.map((x: any) => [x.key.kind, x.pageviews]))).toEqual({ shown: 5 + FF_ASK_DAY, accept: 3, dismiss: 1 })
    const o = (await popups(db, { dimension: 'outcome', popup: 'signin-prompt', ...day })).body
    expect(o.rows.find((x: any) => x.key.outcome === 'signed-in').pageviews).toBe(2 + 3)
    const or = (await popups(db, { dimension: 'reason', popup: 'signin-prompt', kind: 'signed-in', ...day })).body
    expect(Object.fromEntries(or.rows.map((x: any) => [x.key.reason, x.pageviews]))).toEqual({ placement: 2, 'first-finish': 3 })
  })

  it('its one statement returns every refused row with hr NULL and only an ET date', async () => {
    const { statements } = await popups(db, { dimension: 'kind', popup: 'signin-prompt', ...twoDays })
    expect(statements).toHaveLength(1)
    const out = db.prepare(statements[0].sql).all(...(statements[0].binds as any[])) as any[]
    const refused = out.filter((x) => isSplitRefusedPath(String(x.path)))
    expect(refused.length).toBeGreaterThan(0)
    for (const x of refused) {
      expect(x.hr).toBeNull()
      expect(String(x.etd)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
    // Only the three first-finish families come back refused: no older refused row, no NUL path.
    for (const x of refused) expect([FF_ASK, FF_ELIGIBLE, FF_OUTCOME]).toContain(x.path)
    for (const x of out.filter((x) => !isSplitRefusedPath(String(x.path)))) expect(x.etd).toBeNull()
  })

  it('three one-hour windows read 0 / whole day / 0, never the per-hour 4 / 6 / 8', async () => {
    const hours = [10, 11, 12].map((h) => [new Date(DAY + h * 3_600_000).toISOString(), new Date(DAY + (h + 1) * 3_600_000).toISOString()])
    const got: number[] = []
    for (const [since, until] of hours) {
      const r = (await popups(db, { dimension: 'reason', popup: 'signin-prompt', kind: 'shown', since, until })).body
      got.push(r.rows.find((x: any) => x.key.reason === 'first-finish')?.pageviews ?? 0)
    }
    expect(got).not.toEqual([4, 6, 8])
    // 10-11 and 12-13 ET snap to an empty window; 11-12 ET ties at noon to the whole ET day.
    expect(got).toEqual([0, FF_ASK_DAY, 0])
  })

  it('the rate oracle agrees with the endpoint on the same rows', () => {
    const o = popupRateOracle(db, POPUP_RATE_SPECS.find((s) => s.key.startsWith('signin-prompt:') && s.key.includes('tap'))!.key, twoDays)
    expect(o.denominator).toBe(5 + FF_ASK_DAY + 1)
  })
})

describe('/api/metrics pop-up facts count it; placement and committed reasons are unchanged', () => {
  it('scalars and their per-ET-day series', async () => {
    const res = await metrics(db, twoDays, [
      { key: 'ff', metric: 'popup.eligibleEarnedFirstFinish', window: 'page', series: 'daily' },
      { key: 'earned', metric: 'popup.eligibleEarned', window: 'page', series: 'daily' },
      { key: 'placement', metric: 'popup.eligibleEarnedPlacement', window: 'page' },
      { key: 'repeat', metric: 'popup.eligibleEarnedCommittedRepeat', window: 'page' },
      { key: 'challenge', metric: 'popup.eligibleEarnedCommittedChallenge', window: 'page' },
      { key: 'shown', metric: 'popup.shown', params: { popup: 'signin-prompt' }, window: 'page', series: 'daily' },
      { key: 'signed_in', metric: 'popup.outcomeSignedIn', params: { popup: 'signin-prompt' }, window: 'page' },
      { key: 'tap', ratio: 'popup.tapRate', params: { popup: 'signin-prompt' }, window: 'page' },
      { key: 'bsk_shown', metric: 'bsk.popupShown', window: 'page' },
    ])
    expect(res.ff.value).toBe(FF_ELIGIBLE_DAY)
    expect(res.earned.value).toBe(7 + 11 + 13 + FF_ELIGIBLE_DAY)
    expect(res.placement.value).toBe(7)
    expect(res.repeat.value).toBe(11)
    expect(res.challenge.value).toBe(13)
    expect(res.shown.value).toBe(5 + FF_ASK_DAY + 1)
    expect(res.signed_in.value).toBe(5)
    expect(res.tap.denominator).toBe(5 + FF_ASK_DAY + 1)
    expect(res.tap.numerator).toBe(3)
    const series = (k: string) => Object.fromEntries((res[k].series ?? []).map((p: any) => [p.day, p.value]))
    expect(series('ff')['2026-10-07']).toBe(FF_ELIGIBLE_DAY)
    expect(series('shown')).toMatchObject({ '2026-10-07': 5 + FF_ASK_DAY, '2026-10-08': 1 })
    // The opt-out tile keeps its arrows and live refresh, so it leaves the refused ask out (like page views).
    expect(res.bsk_shown.value).toBe(5 + 4)
    expect(res.bsk_shown.liveSafe).toBe(true)
    expect(res.ff.liveSafe).toBeUndefined()
  })
})

describe('the ads routine: site-wide counts include it per ET day; the country read never does', () => {
  const select = (d: DatabaseSync) => async (sql: string, binds: unknown[]) => d.prepare(sql).all(...(binds as any[])) as any[]
  it('siteEvents counts the ask, eligibility and outcome, each placed at its ET midnight', async () => {
    const rows = await createBeaconSource(select(db)).siteEvents(DAY - 86_400_000)
    for (const r of rows.filter((x) => isSplitRefusedPath(x.path) && !x.path.startsWith('/funnel/'))) {
      expect([FF_ASK, FF_ELIGIBLE, FF_OUTCOME]).toContain(r.path)
      expect([DAY, NEXT]).toContain(r.hourStartMs)
    }
    const s = summarizeSiteEvents(rows, NEXT + 86_400_000)
    expect(s.shown['signin-prompt']).toBe(5 + FF_ASK_DAY + 1)
    expect(s.signinEligible.earned).toBe(7 + 11 + 13 + FF_ELIGIBLE_DAY)
    expect(s.outcomes['signin-prompt']['signed-in']).toBe(5)
    const raw = db.prepare(siteEventsQuery(DAY - 86_400_000).sql).all(...(siteEventsQuery(DAY - 86_400_000).binds as any[])) as any[]
    for (const x of raw.filter((x) => isSplitRefusedPath(String(x.path)))) expect(x.hr).toBeNull()
  })
  it('taggedCountryQuery leaves every refused row out, the first-finish ask included', () => {
    const q = taggedCountryQuery(CAMPAIGNS[0])
    expect(q.sql).toContain(`NOT ${refusedPathMatch().sql}`)
    expect(refusedPathMatch().sql).toContain(`'${FF_ASK}'`)
  })
})

describe('/api/geo refuses it in every refused dimension and counts it by path', () => {
  const refusedTotal = (rows: (HitRow & { n: number })[]) => rows.filter((r) => !isSplitRefusedPath(String(r.path))).reduce((a, r) => a + r.n, 0)
  it('each refused dimension, the map points, and a refused drill leave it out; by path it counts', async () => {
    const ffOnly = open([...ORDINARY, ...FIRST_FINISH])
    try {
      const expected = refusedTotal([...ORDINARY, ...FIRST_FINISH].filter((r) => r.ts < NEXT))
      for (const dim of SPLIT_REFUSED_DIMS) {
        const r = await geo(ffOnly, { dimension: dim })
        expect(r.totals.pageviews, dim).toBe(expected)
        expect(r.meta.splitGuard, dim).toBe(true)
      }
      const pts = await geo(ffOnly, { dimension: 'points' })
      expect(pts.meta.splitGuard).toBe(true)
      const drilled = await geo(ffOnly, { dimension: 'path', constraints: [{ field: 'country', value: 'US' }] })
      expect(drilled.rows.some((x: any) => isSplitRefusedPath(String(x.key.path)))).toBe(false)
      const byPath = await geo(ffOnly, { dimension: 'path' })
      const p = Object.fromEntries(byPath.rows.map((x: any) => [x.key.path, x.pageviews]))
      expect(p[FF_ASK]).toBe(FF_ASK_DAY + 1)
      expect(p[FF_ELIGIBLE]).toBe(FF_ELIGIBLE_DAY)
      expect(p[FF_OUTCOME]).toBe(3)
    } finally {
      ffOnly.close()
    }
  })
})

describe('every older refused row changes nothing (byte-identical outputs with and without them)', () => {
  it('/api/popups, every dimension and pop-up', async () => {
    const without = open([...ORDINARY, ...FIRST_FINISH])
    try {
      for (const range of [day, twoDays, { since: '2026-10-07T13:00:00Z', until: '2026-10-07T19:00:00Z' }]) {
        for (const dimension of ['kind', 'reason', 'date', 'outcome', 'installOutcome']) {
          for (const popup of POPUPS.map((p) => p.id)) {
            for (const kind of ['shown', 'accept', 'signed-in']) {
              const body = { dimension, popup, kind, ...range }
              expect(JSON.stringify((await popups(db, body)).body), JSON.stringify(body)).toBe(JSON.stringify((await popups(without, body)).body))
            }
          }
        }
      }
    } finally {
      without.close()
    }
  })

  it('/api/metrics, every pop-up metric and bsk.popupShown', async () => {
    const without = open([...ORDINARY, ...FIRST_FINISH])
    try {
      const requests = [...METRICS.values()].filter((m) => m.id.startsWith('popup.') || m.id === 'bsk.popupShown').flatMap((m) =>
        (m.params ?? []).includes('popup' as any)
          ? POPUPS.map((p) => ({ key: `${m.id}:${p.id}`.toLowerCase(), metric: m.id, params: { popup: p.id }, window: 'page', series: 'daily' }))
          : [{ key: m.id.toLowerCase(), metric: m.id, window: 'page', ...(m.id.startsWith('popup.') ? { series: 'daily' } : {}) }],
      )
      for (const ctx of [day, twoDays, { since: '2026-10-07T13:00:00Z', until: '2026-10-07T19:00:00Z' }]) {
        const a = await metrics(db, ctx, requests)
        const b = await metrics(without, ctx, requests)
        for (const r of requests) expect(JSON.stringify({ ...a[r.key], asOfMs: 0 }), r.key).toBe(JSON.stringify({ ...b[r.key], asOfMs: 0 }))
      }
    } finally {
      without.close()
    }
  })

  it('the routine site-event summary', async () => {
    const without = open([...ORDINARY, ...FIRST_FINISH])
    try {
      const sel = (d: DatabaseSync) => async (sql: string, binds: unknown[]) => d.prepare(sql).all(...(binds as any[])) as any[]
      const a = await createBeaconSource(sel(db)).siteEvents(DAY - 86_400_000)
      const b = await createBeaconSource(sel(without)).siteEvents(DAY - 86_400_000)
      const strip = (rows: typeof a) => rows.filter((r) => !r.path.startsWith('/funnel/'))
      const key = (r: (typeof a)[number]) => `${r.path}|${r.hourStartMs}|${r.postInstallFix}`
      expect(strip(a).map(key).sort()).toEqual(strip(b).map(key).sort())
      const sa = summarizeSiteEvents(a, NEXT)
      const sb = summarizeSiteEvents(b, NEXT)
      expect(JSON.stringify({ ...sa, p1: { ...sa.p1, funnel: undefined } })).toBe(JSON.stringify({ ...sb, p1: { ...sb.p1, funnel: undefined } }))
    } finally {
      without.close()
    }
  })
})
