// /api/features (feature health) end to end on a REAL SQLite engine (node:sqlite, D1's dialect), with
// made-up rows. Proves: the ET-midnight windows (latest complete day, the day before, the range), the
// shared filters (sites, hide my own visits, known traffic), the SQL step match == the JS one, the
// counts-only guard (refused paths are read only as per-ET-day totals; no hour, place, device or
// visitor dimension in any executed statement), the "New" cutoff, and the viewer read allow-list.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openHitsDb, insertHits, sqliteD1, pagesContext, postJson } from '../_lib/testing/hitsDb'
import { etWallTimeMs } from '../../src/lib/etTime'
import { FEATURES, flatSteps, stepMatches } from '../../src/lib/featureHealth'
import { stepMatchSql } from '../../src/lib/featureHealthSql'
import { isSplitRefusedPath } from '../../src/lib/splitGuard'
import { MAX_SITES } from '../../src/lib/queryLimits'
import { viewerMayRequest } from '../_lib/auth'

// 2026-10-15 12:00 ET: today is 10-15, the latest complete ET day 10-14, the day before 10-13.
const NOW = '2026-10-15T16:00:00Z'
const TODAY = '2026-10-15'
const LATEST = '2026-10-14'
const PREV = '2026-10-13'
/** A timestamp at `hh` o'clock Eastern on the ET date `date` (mid-October: no DST change in range). */
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
const range = { since: '2026-10-08', until: '2026-10-15' }
const feature = (body: any, id: string) => body.features.find((f: any) => f.id === id)
const step = (body: any, fid: string, sid: string) => feature(body, fid).steps.find((s: any) => s.id === sid)
const hit = (path: string, ts: number, extra: Record<string, string | number> = {}) => ({ ts, site: 'bestsudoku-web', path, ...extra })

describe('/api/features: windows and counts', () => {
  it('counts the latest complete ET day, the day before and the range, per step', async () => {
    insertHits(db, [
      hit('/tour/start', at(LATEST, 9), { n: 10 }),
      hit('/tour/complete', at(LATEST, 10), { n: 4 }),
      hit('/tour/skip', at(LATEST, 11), { n: 2 }),
      hit('/tour/exit-at/hub', at(LATEST, 12), { n: 1 }), // the same skip again: counted nowhere
      hit('/tour/start', at(PREV, 9), { n: 6 }),
      hit('/tour/complete', at(PREV, 10), { n: 3 }),
      hit('/tour/start', at('2026-10-09', 9), { n: 5 }),
      hit('/tour/start', at(TODAY, 9), { n: 7 }),
    ])
    const { status, body } = await post(range)
    expect(status).toBe(200)
    expect(body.latestDay).toBe(LATEST)
    expect(body.prevDay).toBe(PREV)
    const start = step(body, 'tour', 'start')
    expect([start.latest, start.prev]).toEqual([10, 6])
    // The range 10-08..10-14 (until 10-15 is inclusive of the 15th as a date, so today is in too).
    expect(start.range).toBe(10 + 6 + 5 + 7)
    const complete = step(body, 'tour', 'complete')
    expect([complete.latest, complete.prev]).toEqual([4, 3])
    expect(step(body, 'tour', 'skip').latest).toBe(2)
    expect(body.features.find((f: any) => f.id === 'tour').steps.map((x: any) => x.id)).not.toContain('exit-at')
    // Plain ratios of counts.
    expect(complete.ratio.latest).toBeCloseTo(0.4)
    expect(complete.ratio.prev).toBeCloseTo(0.5)
    expect(complete.ratio.label).toMatch(/per started/)
    // The feature rows: the sum of its steps.
    expect([feature(body, 'tour').latest, feature(body, 'tour').prev]).toEqual([16, 9])
  })

  it('splits days at ET midnight, not UTC midnight', async () => {
    // 23:30 ET on 10-13 is already 03:30Z on 10-14; 00:30 ET on 10-14 is 04:30Z. Both belong to their ET day.
    insertHits(db, [hit('/tour/start', at(PREV, 23.5), { n: 3 }), hit('/tour/start', at(LATEST, 0.5), { n: 5 })])
    const { body } = await post(range)
    const s = step(body, 'tour', 'start')
    expect([s.prev, s.latest]).toEqual([3, 5])
  })

  it('a zero denominator gives a null ratio, which the client renders as a dash', async () => {
    insertHits(db, [hit('/tour/complete', at(LATEST, 10), { n: 2 })])
    const { body } = await post(range)
    expect(step(body, 'tour', 'complete').ratio.latest).toBeNull()
  })

  it('a path that matches no configured step is not counted anywhere', async () => {
    insertHits(db, [hit('/', at(LATEST, 9), { n: 9 }), hit('/tour/skipped', at(LATEST, 9), { n: 9 }), hit('/tour/start', at(LATEST, 9))])
    const { body } = await post(range)
    const total = body.features.reduce((a: number, f: any) => a + f.latest, 0)
    expect(total).toBe(1)
  })

  it('SQL and JS match the same paths for every configured step', () => {
    const paths = [
      '/tour/start', '/tour/skip', '/tour/skip/x', '/tour/exit-at', '/tour/exit-at/hub', '/signin-prompt/tutorial', '/signin-prompt/accept',
      '/signin-prompt/dismiss', '/auth/success/google', '/auth/success/google/new', '/auth/success/email/existing', '/upsell/shown/upgrade-tap',
      '/upsell/accept/cadence', '/install/prompt/android', '/install/prompt/dismiss', '/install/play', '/game/start/easy', '/game/start/normal',
      '/game/complete/daily/hard', '/game/complete/normal/easy', '/game/complete-deferred/x', '/coach/shown/place', '/coach/tour-opened',
      '/TOUR/START', '/', '/tour/start\u0000x',
    ]
    insertHits(db, paths.map((p) => hit(p, at(LATEST, 9))))
    for (const { step: s } of flatSteps()) {
      const rows = db.prepare(`SELECT path FROM hits WHERE ${stepMatchSql(s.match)} ORDER BY id`).all() as { path: string }[]
      const sqlPaths = rows.map((r) => r.path)
      const jsPaths = paths.filter((p) => stepMatches(s.match, p))
      // The NUL path matches the SQL step on the substr/equality terms only when its text compares equal,
      // which it does not: both agree. (The endpoint drops NUL rows on top, tested below.)
      expect(sqlPaths, JSON.stringify(s.match)).toEqual(jsPaths)
    }
  })

  it('a stored path with a NUL byte is excluded', async () => {
    insertHits(db, [hit('/tour/start\u0000', at(LATEST, 9), { n: 4 }), hit('/tour/skip\u0000x', at(LATEST, 9), { n: 4 }), hit('/tour/start', at(LATEST, 9))])
    const { body } = await post(range)
    expect(step(body, 'tour', 'start').latest).toBe(1)
    expect(step(body, 'tour', 'skip').latest).toBe(0)
  })

  it('a long range is charted one value per ET day', async () => {
    insertHits(db, [hit('/game/start/easy', at('2026-10-01', 12), { n: 2 }), hit('/game/start/easy', at('2026-10-12', 12), { n: 3 })])
    const { body } = await post({ since: '2026-10-01', until: '2026-10-14' })
    expect(body.days[0]).toBe('2026-10-01')
    expect(body.days.at(-1)).toBe('2026-10-14')
    const s = step(body, 'games-easy', 'start')
    expect(s.perDay).toHaveLength(body.days.length)
    expect(s.perDay[0]).toBe(2)
    expect(s.perDay[body.days.indexOf('2026-10-12')]).toBe(3)
    expect(s.range).toBe(5)
  })
})

describe('/api/features: status', () => {
  it('went silent: 5+ a day over the prior 7 days and none on the latest complete day', async () => {
    const rows = []
    for (let i = 2; i <= 8; i++) rows.push(hit('/promo-first50/shown', at(`2026-10-${String(15 - i).padStart(2, '0')}`, 9), { n: 6 }))
    insertHits(db, rows)
    const { body } = await post(range)
    expect(feature(body, 'first50-promo').status).toBe('silent')
    expect(feature(body, 'first50-promo').statusNote).toMatch(/none on 2026-10-14/)
  })

  it('a quiet day on a low-volume feature stays OK', async () => {
    const rows = []
    for (let i = 2; i <= 8; i++) rows.push(hit('/promo-first50/shown', at(`2026-10-${String(15 - i).padStart(2, '0')}`, 9), { n: 2 }))
    insertHits(db, rows)
    const { body } = await post(range)
    expect(feature(body, 'first50-promo').status).toBe('ok')
  })

  it('new: rows only inside the last 7 complete days', async () => {
    insertHits(db, [hit('/welcome-signed-in/shown', at(LATEST, 9), { n: 3 }), hit('/welcome-signed-in/shown', at(PREV, 9), { n: 3 })])
    const { body } = await post(range)
    expect(feature(body, 'welcome').status).toBe('new')
  })

  it('a row before the new-days cutoff makes the feature OK, and a feature with no rows ever reads New', async () => {
    insertHits(db, [hit('/welcome-signed-in/shown', at('2026-09-20', 9)), hit('/welcome-signed-in/shown', at(LATEST, 9))])
    const { body } = await post(range)
    expect(feature(body, 'welcome').status).toBe('ok')
    expect(feature(body, 'coach').status).toBe('new')
    expect(feature(body, 'coach').statusNote).toBe('no rows yet')
  })

  it('every configured feature is in the response, in config order', async () => {
    const { body } = await post(range)
    expect(body.features.map((f: any) => f.id)).toEqual(FEATURES.map((f) => f.id))
    for (const f of body.features) expect(f.steps.length).toBe(FEATURES.find((d) => d.id === f.id)!.steps.length)
  })
})

describe('/api/features: filters', () => {
  it('the site filter keeps only the chosen sites', async () => {
    insertHits(db, [hit('/tour/start', at(LATEST, 9), { n: 3 }), hit('/tour/start', at(LATEST, 9), { n: 5, site: 'bestsudoku-app' })])
    expect(step((await post({ ...range, sites: ['bestsudoku-app'] })).body, 'tour', 'start').latest).toBe(5)
    expect(step((await post({ ...range, sites: ['bestsudoku-web', 'bestsudoku-app'] })).body, 'tour', 'start').latest).toBe(8)
    // Web and app are combined when no site is picked.
    expect(step((await post(range)).body, 'tour', 'start').latest).toBe(8)
    expect(step((await post({ ...range, sites: ['all'] })).body, 'tour', 'start').latest).toBe(8)
  })

  it('hide my own visits drops the own browser + OS combination only when both are given', async () => {
    insertHits(db, [
      hit('/tour/start', at(LATEST, 9), { n: 4, browser: 'Chrome', os: 'Windows' }),
      hit('/tour/start', at(LATEST, 9), { n: 3, browser: 'Chrome', os: 'Android' }),
    ])
    expect(step((await post({ ...range, excludeOwnVisits: true, ownBrowser: 'Chrome', ownOS: 'Windows' })).body, 'tour', 'start').latest).toBe(3)
    expect(step((await post({ ...range, excludeOwnVisits: true, ownBrowser: 'Chrome' })).body, 'tour', 'start').latest).toBe(7)
    expect(step((await post({ ...range, ownBrowser: 'Chrome', ownOS: 'Windows' })).body, 'tour', 'start').latest).toBe(7)
  })

  it('known traffic is excluded only when the widget asks for it', async () => {
    insertHits(db, [
      hit('/tour/start', at(LATEST, 9), { n: 5, region: 'Ohio' }),
      hit('/tour/start', at(LATEST, 9), { n: 2, region: 'North Carolina', screenw: 412 }),
      hit('/tour/start', at(LATEST, 9), { n: 1, medium: 'lifecycle' }),
    ])
    expect(step((await post(range)).body, 'tour', 'start').latest).toBe(8)
    expect(step((await post({ ...range, excludeKnownTraffic: true })).body, 'tour', 'start').latest).toBe(5)
  })

  it('too many sites is a 400', async () => {
    const sites = Array.from({ length: MAX_SITES + 1 }, (_, i) => `site-${i}`)
    expect((await post({ ...range, sites })).status).toBe(400)
  })

  it('a full set of sites plus every filter stays under D1\'s 100 bound parameters', async () => {
    const sites = Array.from({ length: MAX_SITES }, (_, i) => `site-${i}`)
    const { status } = await post({ ...range, sites, excludeOwnVisits: true, ownBrowser: 'Chrome', ownOS: 'Windows', excludeKnownTraffic: true })
    expect(status).toBe(200)
    // The binds are the window, the sites and the shared exclusions: never a path.
    const binds = (sql: string) => (sql.match(/\?/g) ?? []).length
    for (const s of d1.statements) expect(binds(s)).toBeLessThan(100)
  })
})

describe('/api/features: counts only', () => {
  it('refused paths are counted as per-ET-day totals', async () => {
    const refused = ['/tour/skip', '/tour/exit-at/hub', '/game/start/easy', '/game/complete/daily/easy', '/coach/shown/place', '/coach/dismissed/place']
    for (const p of refused) expect(isSplitRefusedPath(p), p).toBe(true)
    insertHits(db, refused.map((p) => hit(p, at(LATEST, 9), { n: 2 })))
    const { body } = await post(range)
    expect(step(body, 'tour', 'skip').latest).toBe(2)
    expect(step(body, 'games-easy', 'start').latest).toBe(2)
    expect(step(body, 'games-easy', 'complete').latest).toBe(2)
    expect(step(body, 'coach', 'shown').latest).toBe(2)
  })

  it('a request window that is not ET-midnight aligned is snapped, never read as a partial day', async () => {
    insertHits(db, [hit('/tour/skip', at(LATEST, 1)), hit('/tour/skip', at(LATEST, 23))])
    // A timestamp range mid-day: the day is read whole or not at all.
    const { body } = await post({ since: `${LATEST}T12:00:00Z`, until: `${LATEST}T13:00:00Z` })
    expect(step(body, 'tour', 'skip').latest).toBe(2)
  })

  it('no executed statement has an hour, place, device or visitor dimension, or a MIN/MAX of ts', async () => {
    insertHits(db, [hit('/tour/skip', at(LATEST, 9))])
    await post({ ...range, sites: ['bestsudoku-web'], excludeOwnVisits: true, ownBrowser: 'Chrome', ownOS: 'Windows', excludeKnownTraffic: true })
    expect(d1.statements).toHaveLength(2)
    for (const sql of d1.statements) {
      const groupBy = sql.match(/GROUP BY (.*?)( ORDER BY|$)/)?.[1] ?? ''
      // The daily statement groups by the ET date alone; the before-cutoff statement is one total row.
      expect(['d', '']).toContain(groupBy)
      expect(sql).not.toMatch(/MIN\(\s*ts|MAX\(\s*ts/i)
      // The select list: the ET date and the step counts, nothing else.
      const select = sql.slice(0, sql.indexOf(' FROM hits')).replace(/'[^']*'/g, "''")
      expect(select).not.toMatch(/\b(hourEt|country|region|city|postal|device|visitor|colo|org|lat|lon|screenw|browser|os)\b/)
    }
  })

  it('the response carries no hour, place or device field', async () => {
    insertHits(db, [hit('/tour/skip', at(LATEST, 9), { country: 'US', device: 'mobile' })])
    const text = JSON.stringify((await post(range)).body)
    expect(text).not.toMatch(/hour|country|region|city|device|visitor|browser/i)
  })
})

describe('/api/features: input handling', () => {
  it('rejects a body that is not JSON', async () => {
    const { onRequestPost } = await import('./features')
    const req = new Request('https://stats.goodstuff.software/api/features', { method: 'POST', body: 'nope' })
    const res = await onRequestPost(pagesContext(req, { gss_geo: d1 }) as any)
    expect(res.status).toBe(400)
  })
  it('answers with no body fields at all (defaults to the last week)', async () => {
    insertHits(db, [hit('/tour/start', at(LATEST, 9))])
    const { status, body } = await post({})
    expect(status).toBe(200)
    expect(step(body, 'tour', 'start').latest).toBe(1)
  })
})

describe('/api/features: viewer read', () => {
  it('a view-only session may POST the endpoint', () => {
    expect(viewerMayRequest('POST', '/api/features')).toBe(true)
  })
})
