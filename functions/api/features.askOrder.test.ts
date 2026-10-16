// /api/features with view 'ask-order' (the Ask-order A/B card) on a REAL SQLite engine (node:sqlite),
// with made-up rows. Proves: per group / tag / step counts for the latest day and the range, an `allTime`
// total that ignores the range and the site selection but keeps the exclusions, "ever seen", that the
// `/ab` twin rows never move the default health model or the Coach tips totals, and that no statement
// asks for an hour, place, device or visitor dimension.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openHitsDb, insertHits, sqliteD1, pagesContext, postJson } from '../_lib/testing/hitsDb'
import { etWallTimeMs } from '../../src/lib/etTime'
import {
  ASK_ORDER_FEATURES, ASK_ORDER_VIEW, askOrderAssignedPath, askOrderFeatureId, askOrderOutcomePath, askOrderRespondedPath, askOrderShownPath,
  assignedStepId, outcomeStepId, respondedStepId, shownStepId,
} from '../../src/lib/askOrder'
import { COACH_TIPS_VIEW } from '../../src/lib/coachTips'
import { flatSteps } from '../../src/lib/featureHealth'
import { isSplitRefusedPath } from '../../src/lib/splitGuard'
import { viewerMayRequest } from '../_lib/auth'

const NOW = '2026-10-15T16:00:00Z'
const TODAY = '2026-10-15'
const LATEST = '2026-10-14'
const PREV = '2026-10-13'
const at = (date: string, hh: number) => etWallTimeMs(date) + hh * 3_600_000

let db: DatabaseSync
let d1: ReturnType<typeof sqliteD1>
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  db = openHitsDb()
  d1 = sqliteD1(db)
  ;(globalThis as any).caches = { default: { match: async () => undefined, put: async () => {} } }
})
afterEach(() => {
  vi.useRealTimers()
  db.close()
  delete (globalThis as any).caches
})

const post = async (body: Record<string, unknown>) => {
  const { onRequestPost } = await import('./features')
  const res = await onRequestPost(pagesContext(postJson('/api/features', body), { gss_geo: d1 }) as any)
  return { status: res.status, body: (await res.json()) as any }
}
const range = { since: '2026-10-08', until: '2026-10-15', view: ASK_ORDER_VIEW }
const hit = (path: string, ts: number, extra: Record<string, string | number> = {}) => ({ ts, site: 'bestsudoku-web', path, ...extra })
const feature = (body: any, g: string) => body.features.find((f: any) => f.id === askOrderFeatureId(g as any))
const st = (body: any, g: string, step: string) => feature(body, g).steps.find((s: any) => s.id === step)
const TAGGED = { campaign: 'sudoku_tired_of_ads' }

describe('ask-order: per group, tag and step counts', () => {
  it('answers one feature per group with 26 steps, the latest day and a range', async () => {
    const { status, body } = await post(range)
    expect(status).toBe(200)
    expect(body.features.map((f: any) => f.id)).toEqual(['ao-signin-first', 'ao-install-first'])
    for (const f of body.features) expect(f.steps).toHaveLength(26)
    expect(body.latestDay).toBe(LATEST)
    expect(body.everSeen).toBe(false)
  })

  it('splits by group, ask, outcome and the row campaign tag, web and app combined', async () => {
    insertHits(db, [
      hit(askOrderAssignedPath('signin-first'), at(LATEST, 9), { n: 5 }),
      hit(askOrderAssignedPath('signin-first'), at(LATEST, 10), { n: 3, campaign: 'sudoku_tired_of_ads', site: 'bestsudoku-app' }),
      hit(askOrderAssignedPath('install-first'), at(LATEST, 9), { n: 4 }),
      hit(askOrderShownPath('signin-first', 'signin'), at(LATEST, 9), { n: 4 }),
      hit(askOrderShownPath('signin-first', 'signin'), at(LATEST, 9), { n: 2, ...TAGGED }),
      hit(askOrderOutcomePath('signin-first', 'signin', 'signed-in'), at(LATEST, 9), { n: 1 }),
      hit(askOrderOutcomePath('signin-first', 'signin', 'signed-in'), at(LATEST, 9), { n: 2, ...TAGGED }),
      hit(askOrderOutcomePath('signin-first', 'install', 'installed'), at('2026-10-09', 9), { n: 3 }),
      hit(askOrderOutcomePath('install-first', 'install', 'returned'), at(PREV, 9), { n: 6, ...TAGGED }),
      hit(askOrderRespondedPath('signin-first', 'signin'), at(LATEST, 9), { n: 2 }),
      hit(askOrderRespondedPath('install-first', 'install'), at(LATEST, 9), { n: 3, ...TAGGED }),
    ])
    const { body } = await post(range)
    expect(st(body, 'signin-first', respondedStepId('signin', 'organic'))).toMatchObject({ latest: 2, range: 2 })
    expect(st(body, 'install-first', respondedStepId('install', 'tagged'))).toMatchObject({ latest: 3, range: 3 })
    expect(st(body, 'install-first', respondedStepId('install', 'organic'))).toMatchObject({ latest: 0, range: 0 })
    expect(st(body, 'signin-first', assignedStepId('organic'))).toMatchObject({ latest: 5, range: 5 })
    expect(st(body, 'signin-first', assignedStepId('tagged'))).toMatchObject({ latest: 3, range: 3 })
    expect(st(body, 'install-first', assignedStepId('organic'))).toMatchObject({ latest: 4, range: 4 })
    expect(st(body, 'signin-first', shownStepId('signin', 'organic'))).toMatchObject({ latest: 4, range: 4 })
    expect(st(body, 'signin-first', shownStepId('signin', 'tagged'))).toMatchObject({ latest: 2, range: 2 })
    expect(st(body, 'signin-first', outcomeStepId('signin', 'signed-in', 'organic'))).toMatchObject({ latest: 1, range: 1 })
    expect(st(body, 'signin-first', outcomeStepId('signin', 'signed-in', 'tagged'))).toMatchObject({ latest: 2, range: 2 })
    // An older day inside the range counts in the range only.
    expect(st(body, 'signin-first', outcomeStepId('install', 'installed', 'organic'))).toMatchObject({ latest: 0, range: 3 })
    // The day before the latest is its own column.
    expect(st(body, 'install-first', outcomeStepId('install', 'returned', 'tagged'))).toMatchObject({ latest: 0, prev: 6, range: 6 })
    // Ratios are plain ratios of two counts, null for a zero denominator.
    expect(st(body, 'signin-first', shownStepId('signin', 'organic')).ratio.latest).toBeCloseTo(4 / 5)
    expect(st(body, 'signin-first', outcomeStepId('signin', 'signed-in', 'tagged')).ratio.latest).toBeCloseTo(2 / 2)
    expect(st(body, 'install-first', shownStepId('install', 'organic')).ratio.latest).toBe(0)
    expect(st(body, 'install-first', outcomeStepId('install', 'returned', 'tagged')).ratio.latest).toBeNull()
  })

  it('does not count look-alike paths (a wrong group, ask or outcome, a prefix, a different case)', async () => {
    insertHits(db, [
      hit('/ab/ask-order/other-group/assigned', at(LATEST, 9)),
      hit('/ab/ask-order/signin-first/assigned/extra', at(LATEST, 9)),
      hit('/ab/ask-order/signin-first/shown/other', at(LATEST, 9)),
      hit('/ab/ask-order/signin-first/signin/other', at(LATEST, 9)),
      hit('/ab/ask-order/Signin-first/assigned', at(LATEST, 9)),
      hit('/ab/ask-order/signin-first', at(LATEST, 9)),
      hit('/ab/ask-order', at(LATEST, 9)),
    ])
    const { body } = await post(range)
    for (const g of body.features) expect(g.range).toBe(0)
    for (const k of Object.keys(body.allTime)) expect(body.allTime[k], k).toBe(0)
  })

  it('everSeen tells "not shipped yet" from a quiet range, and ignores the site and exclusion filters', async () => {
    expect((await post(range)).body.everSeen).toBe(false)
    insertHits(db, [hit(askOrderAssignedPath('install-first'), at('2026-09-20', 9), { site: 'other-site' })])
    const quiet = (await post({ ...range, sites: ['bestsudoku-web'], excludeKnownTraffic: true })).body
    expect(quiet.everSeen).toBe(true)
    expect(st(quiet, 'install-first', assignedStepId('organic')).range).toBe(0)
  })

  it('applies the site selection and the exclusions to the range columns', async () => {
    insertHits(db, [
      hit(askOrderAssignedPath('signin-first'), at(LATEST, 9), { n: 3 }),
      hit(askOrderAssignedPath('signin-first'), at(LATEST, 9), { n: 5, site: 'other-site' }),
      hit(askOrderAssignedPath('signin-first'), at(LATEST, 9), { n: 7, medium: 'lifecycle', campaign: 'email_x' }),
      hit(askOrderAssignedPath('signin-first'), at(LATEST, 9), { n: 11, browser: 'Chrome', os: 'Windows' }),
    ])
    const col = (b: any) => st(b, 'signin-first', assignedStepId('organic')).latest
    expect(col((await post({ ...range, sites: ['bestsudoku-web'] })).body)).toBe(14) // 3 + 11 (the lifecycle row is tagged)
    expect(col((await post({ ...range, sites: ['bestsudoku-web'], excludeOwnVisits: true, ownBrowser: 'Chrome', ownOS: 'Windows' })).body)).toBe(3)
    expect(col((await post(range)).body)).toBe(19)
  })
})

describe('ask-order: allTime', () => {
  it('counts every day so far, whatever the range, keyed <feature>.<step>', async () => {
    insertHits(db, [
      hit(askOrderAssignedPath('signin-first'), at('2026-08-01', 9), { n: 2 }),
      hit(askOrderAssignedPath('signin-first'), at(LATEST, 9), { n: 3, ...TAGGED }),
      hit(askOrderShownPath('install-first', 'install'), at(TODAY, 9), { n: 4 }),
    ])
    const { body } = await post({ ...range, since: '2026-10-14', until: '2026-10-14' })
    expect(body.allTime['ao-signin-first.assigned-organic']).toBe(2)
    expect(body.allTime['ao-signin-first.assigned-tagged']).toBe(3)
    expect(body.allTime['ao-install-first.shown-install-organic']).toBe(4) // today is counted too
    expect(st(body, 'signin-first', assignedStepId('organic')).range).toBe(0)
    expect(Object.keys(body.allTime)).toHaveLength(ASK_ORDER_FEATURES.length * 26)
  })

  it('ignores the site selection but honours the own-visit and known-traffic exclusions', async () => {
    insertHits(db, [
      hit(askOrderAssignedPath('install-first'), at(LATEST, 9), { n: 3 }),
      hit(askOrderAssignedPath('install-first'), at(LATEST, 9), { n: 5, site: 'other-site' }),
      hit(askOrderAssignedPath('install-first'), at(LATEST, 9), { n: 7, medium: 'lifecycle', campaign: 'email_x' }),
      hit(askOrderAssignedPath('install-first'), at(LATEST, 9), { n: 11, browser: 'Chrome', os: 'Windows' }),
    ])
    const org = (b: any) => b.allTime['ao-install-first.assigned-organic']
    const tag = (b: any) => b.allTime['ao-install-first.assigned-tagged']
    const all = (await post({ ...range, sites: ['bestsudoku-web'] })).body
    expect(org(all)).toBe(19) // other-site is still counted: the call point is about all traffic
    expect(tag(all)).toBe(7)
    const known = (await post({ ...range, excludeKnownTraffic: true })).body
    expect(tag(known)).toBe(0)
    const own = (await post({ ...range, excludeOwnVisits: true, ownBrowser: 'Chrome', ownOS: 'Windows' })).body
    expect(org(own)).toBe(8)
  })
})

describe('ask-order: counts only (no refused dimension)', () => {
  it('every ask-order path is a refused path for hour, place and device splits', () => {
    const paths = flatSteps(ASK_ORDER_FEATURES).flatMap((f) => f.step.match.exact ?? [])
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) expect(isSplitRefusedPath(p), p).toBe(true)
  })

  it('no executed statement has an hour, place, device or visitor dimension, or a MIN/MAX of ts', async () => {
    insertHits(db, [hit(askOrderAssignedPath('signin-first'), at(LATEST, 9))])
    await post({ ...range, sites: ['bestsudoku-web'], excludeOwnVisits: true, ownBrowser: 'Chrome', ownOS: 'Windows', excludeKnownTraffic: true })
    expect(d1.statements).toHaveLength(3)
    for (const sql of d1.statements) {
      const groupBy = sql.match(/GROUP BY (.*?)( ORDER BY|$)/)?.[1] ?? ''
      expect(['d', '']).toContain(groupBy)
      expect(sql).not.toMatch(/MIN\(\s*ts|MAX\(\s*ts/i)
      const select = sql.slice(0, sql.indexOf(' FROM hits')).replace(/'[^']*'/g, "''")
      expect(select).not.toMatch(/\b(hourEt|country|region|city|postal|device|visitor|colo|org|lat|lon|screenw|browser|os)\b/)
      // Only the ask-order paths are matched, never the health table's other families.
      expect(sql).not.toMatch(/\/tour\/|\/game\/|\/coach\//)
    }
  })

  it('the response carries no hour, place or device field', async () => {
    insertHits(db, [hit(askOrderAssignedPath('signin-first'), at(LATEST, 9), { country: 'US', device: 'mobile' })])
    const keys = new Set<string>()
    const walk = (v: any) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x))
    }
    walk((await post(range)).body)
    expect([...keys].filter((k) => /hour|country|region|city|device|visitor|browser/i.test(k))).toEqual([])
  })

  it('a view-only session may read it (the same POST /api/features)', () => {
    expect(viewerMayRequest('POST', '/api/features')).toBe(true)
  })
})

describe('ask-order: the /ab twin rows stay out of every other total', () => {
  const twinPaths = () => flatSteps(ASK_ORDER_FEATURES).flatMap((f) => f.step.match.exact ?? [])
  const twinRows = () => [...new Set(twinPaths())].map((p) => hit(p, at(LATEST, 9), { n: 3 }))
  const base = [
    hit('/popup-outcome/signed-in', at(LATEST, 9), { n: 2 }),
    hit('/return/sudoku_tired_of_ads/d1', at(LATEST, 9), { n: 4 }),
    hit('/coach/shown/place', at(LATEST, 9), { n: 5 }),
    hit('/coach/dismissed/place', at(LATEST, 9), { n: 1 }),
    hit('/game/start/easy', at(LATEST, 9), { n: 6 }),
    hit('/auth/success/google/new', at(LATEST, 9), { n: 2 }),
  ]

  it('leaves the default Feature health model identical, rows and all', async () => {
    insertHits(db, base)
    const without = (await post({ since: range.since, until: range.until })).body
    insertHits(db, twinRows())
    const withTwins = (await post({ since: range.since, until: range.until })).body
    expect(withTwins).toEqual(without)
  })

  it('leaves the Coach tips view identical', async () => {
    insertHits(db, base)
    const without = (await post({ since: range.since, until: range.until, view: COACH_TIPS_VIEW })).body
    insertHits(db, twinRows())
    const withTwins = (await post({ since: range.since, until: range.until, view: COACH_TIPS_VIEW })).body
    expect(withTwins).toEqual(without)
  })

  it('the Ask-order view reads nothing but its own paths: the base rows move none of its counts', async () => {
    insertHits(db, base)
    const { body } = await post(range)
    expect(body.everSeen).toBe(false)
    for (const k of Object.keys(body.allTime)) expect(body.allTime[k], k).toBe(0)
    for (const f of body.features) expect(f.range).toBe(0)
  })
})
