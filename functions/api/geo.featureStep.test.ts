// The featureStep geo dimension (src/lib/featureHealthSql.ts) through the REAL /api/geo handler on a real SQLite
// (node:sqlite, D1's dialect). Made-up rows only. The counts-only rule (src/lib/splitGuard.ts) is the point:
//   - a step's rows count in per-ET-day totals, refused paths (game start, tour skip, coach shown, paid funnel) included,
//     web and app combined;
//   - with an hour, place or device split (a group-by, a ring dim, a drill, points mode) a refused step's rows are out
//     entirely, and a non-refused step still counts;
//   - the always-exclusions (manual production checks, lib/campaigns.ts applyAlwaysExclusions) hold whatever the
//     known-traffic switch says;
//   - no visitor or device id is read, and no row is joined to another.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { onRequestPost } from './geo'
import { FEATURES, flatSteps, featureStepKey, stepMatches, stepMayMatchRefused } from '../../src/lib/featureHealth'
import { isSplitRefusedPath, SPLIT_REFUSED_DIMS } from '../../src/lib/splitGuard'
import { insertHits, installCaches, memoryCache, openHitsDb, sqliteD1, type HitRow } from '../_lib/testing/hitsDb'
import { buildSeriesLineConfig, formatKey } from '../../src/lib/charts'

let db: DatabaseSync
let undo: () => void
beforeEach(() => {
  db = openHitsDb()
  undo = installCaches(memoryCache())
})
afterEach(() => {
  undo()
  db.close()
})

// EDT in October 2026: ET midnight is 04:00Z, ET noon 16:00Z.
const noon = (day: string, plusMs = 0) => Date.parse(`${day}T16:00:00Z`) + plusMs
const DAYS = ['2026-10-12', '2026-10-13', '2026-10-14'] as const
// Whole ET days 10-12 .. 10-14.
const RANGE = { since: '2026-10-12T04:00:00Z', until: '2026-10-15T04:00:00Z' }
const PLACE = { country: 'US', region: 'Ohio', city: 'Columbus', device: 'mobile', os: 'Android', browser: 'Chrome', screenw: 390, lat: '39.9', lon: '-83.0', timezone: 'America/New_York', colo: 'CMH', org: 'AS1', lang: 'en', continent: 'NA', postal: '43004' }
const row = (day: string, path: string, site: string, n: number, extra: Partial<HitRow> = {}): HitRow & { n: number } => ({ ts: noon(day), site, path, n, ...PLACE, ...extra })

// Per day: web n, app 10+n. Refused step paths and plain ones.
const REFUSED_STEPS = ['games.start', 'tour.skip', 'coach.shown', 'funnel.purchase-web', 'games-easy.start', 'games.complete'] as const
const PLAIN_STEPS = ['tour.start', 'signin.accept', 'install.shown', 'coach.tour-opened'] as const
const PATH_OF: Record<string, string> = {
  'games.start': '/game/start/easy',
  'games-easy.start': '/game/start/easy',
  'games.complete': '/game/complete/daily/easy',
  'tour.skip': '/tour/skip',
  'coach.shown': '/coach/shown/place',
  'funnel.purchase-web': '/funnel/purchase/web',
  'tour.start': '/tour/start',
  'signin.accept': '/signin-prompt/accept',
  'install.shown': '/install/prompt/android',
  'coach.tour-opened': '/coach/tour-opened',
}
const DISTINCT_PATHS = [...new Set(Object.values(PATH_OF))]
function seed() {
  const rows: (HitRow & { n: number })[] = []
  DAYS.forEach((day, i) => {
    for (const p of DISTINCT_PATHS) {
      rows.push(row(day, p, 'bestsudoku-web', i + 1))
      rows.push(row(day, p, 'bestsudoku-app', 10 + i + 1))
    }
  })
  // Rows that must never count: manual production checks (always), known traffic (with the switch on), no step path, a NUL path.
  rows.push(row(DAYS[1], '/game/start/easy', 'bestsudoku-app', 50, { campaign: 'manual_check' }))
  rows.push(row(DAYS[1], '/tour/start', 'bestsudoku-web', 50, { campaign: 'manual_check' }))
  rows.push(row(DAYS[1], '/return/manual_check/d0', 'bestsudoku-app', 50))
  rows.push(row(DAYS[1], '/tour/start', 'bestsudoku-web', 7, { medium: 'lifecycle' })) // lifecycle email
  rows.push(row(DAYS[1], '/game/start/easy', 'bestsudoku-web', 9, { region: 'North Carolina', screenw: 412 })) // the household
  rows.push(row(DAYS[1], '/game/startx', 'bestsudoku-web', 30))
  rows.push(row(DAYS[1], '/tour/skip\u0000x', 'bestsudoku-web', 30))
  rows.push(row(DAYS[1], '/', 'bestsudoku-web', 30))
  insertHits(db, rows)
}
// The plain per-day count of one step's path: web + app, nothing excluded.
const perDay = (i: number) => i + 1 + (10 + i + 1)

async function post(body: Record<string, unknown>) {
  const gss_geo = sqliteD1(db)
  const res = await onRequestPost({ request: { json: async () => ({ limit: 500, metric: 'pageviews', ...RANGE, ...body }) }, env: { gss_geo }, waitUntil: () => {} } as any)
  return { body: (await res.json()) as any, statements: gss_geo.statements, status: res.status }
}
const step = (key: string) => ({ field: 'featureStep', value: key })
const byDay = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.key.dateEt, r.pageviews]))

describe('featureStep: the config agrees with the split guard', () => {
  it('stepMayMatchRefused is true for every step that can match a refused path, false for none of the others', () => {
    // Sample paths for each step: its exact paths and a child of each prefix.
    for (const { feature, step: st } of flatSteps(FEATURES)) {
      const samples = [...(st.match.exact ?? []), ...(st.match.prefix ?? []).map((p) => `${p}x`)].filter((p) => stepMatches(st.match, p, null))
      const anyRefused = samples.some(isSplitRefusedPath)
      if (anyRefused) expect(stepMayMatchRefused(st.match), `${feature.id}.${st.id}`).toBe(true)
    }
    for (const k of REFUSED_STEPS) expect(isSplitRefusedPath(PATH_OF[k]), k).toBe(true)
    for (const k of PLAIN_STEPS) expect(isSplitRefusedPath(PATH_OF[k]), k).toBe(false)
  })
})

describe('featureStep: per-ET-day totals (the step chart query)', () => {
  beforeEach(seed)

  for (const key of [...REFUSED_STEPS, ...PLAIN_STEPS]) {
    it(`${key}: counts its rows per ET day, web and app combined, with no split-guard caption`, async () => {
      const { body, status } = await post({ dimension: 'dateEt', constraints: [step(key)], excludeKnownTraffic: true })
      expect(status).toBe(200)
      expect(byDay(body.rows)).toEqual(Object.fromEntries(DAYS.map((d, i) => [d, perDay(i)])))
      expect(body.totals.pageviews).toBe(DAYS.reduce((a, _, i) => a + perDay(i), 0))
      expect(body.meta.splitGuard).toBeUndefined()
    })
  }

  it('a site filter (web vs app, a product split) narrows a refused step without refusing it', async () => {
    const { body } = await post({ dimension: 'dateEt', constraints: [step('games.start')], sites: ['bestsudoku-app'], excludeKnownTraffic: true })
    expect(byDay(body.rows)).toEqual({ '2026-10-12': 11, '2026-10-13': 12, '2026-10-14': 13 })
    expect(body.meta.splitGuard).toBeUndefined()
  })

  it('two steps that share a path each count it (Games and Games, easy)', async () => {
    const a = await post({ dimension: 'dateEt', constraints: [step('games.start')], excludeKnownTraffic: true })
    const b = await post({ dimension: 'dateEt', constraints: [step('games-easy.start')], excludeKnownTraffic: true })
    expect(byDay(a.body.rows)).toEqual(byDay(b.body.rows))
    expect(a.body.totals.pageviews).toBeGreaterThan(0)
  })

  it('an unknown or forged step value matches no row', async () => {
    for (const value of ['nope.start', 'games', 'games.', ".start", "games.start' OR 1=1 --", 'games.start\u0000']) {
      const { body, status } = await post({ dimension: 'dateEt', constraints: [{ field: 'featureStep', value }] })
      expect(status, value).toBe(200)
      expect(body.totals.pageviews, value).toBe(0)
    }
  })
})

describe('featureStep: hour, place and device splits leave refused rows out entirely', () => {
  beforeEach(seed)

  // Every refused dim as a drill on the step chart query (the page carries the filter).
  const drillValue: Record<string, string> = { hourEt: '12', date: '2026-10-13', country: 'US', region: 'Ohio', city: 'Columbus', postal: '43004', continent: 'NA', timezone: 'America/New_York', colo: 'CMH', org: 'AS1', device: 'mobile', browser: 'Chrome', os: 'Android', lang: 'en', screenw: '390', screenwBucket: '' , visitor: 'new' }
  for (const dim of [...SPLIT_REFUSED_DIMS].filter((d) => d !== 'date' && d !== 'screenwBucket')) {
    it(`a ${dim} drill: refused steps count nothing, a plain step still counts`, async () => {
      for (const key of REFUSED_STEPS) {
        const { body } = await post({ dimension: 'dateEt', constraints: [step(key), { field: dim, value: drillValue[dim] }], excludeKnownTraffic: true })
        expect(body.rows, `${key} by ${dim}`).toEqual([])
        expect(body.totals.pageviews, `${key} by ${dim}`).toBe(0)
        expect(body.meta.splitGuard, `${key} by ${dim}`).toBe(true)
      }
      const { body } = await post({ dimension: 'dateEt', constraints: [step('tour.start'), { field: dim, value: drillValue[dim] }], excludeKnownTraffic: true })
      expect(body.totals.pageviews, `tour.start by ${dim}`).toBeGreaterThan(0)
      expect(body.meta.splitGuard).toBe(true)
    })
  }

  for (const dim of ['hourEt', 'date', 'country', 'region', 'device', 'os', 'browser', 'screenw', 'screenwBucket', 'visitor']) {
    it(`grouped by ${dim}: a refused step has no rows; a plain step does`, async () => {
      for (const key of REFUSED_STEPS) {
        const { body } = await post({ dimension: dim, constraints: [step(key)], excludeKnownTraffic: true })
        expect(body.totals.pageviews, `${key} by ${dim}`).toBe(0)
        expect(body.meta.splitGuard).toBe(true)
      }
      const { body } = await post({ dimension: dim, constraints: [step('signin.accept')], excludeKnownTraffic: true })
      expect(body.totals.pageviews).toBe(DAYS.reduce((a, _, i) => a + perDay(i), 0))
    })
  }

  it('a ring of featureStep x country, device or hour holds only non-refused steps; featureStep x site keeps them all', async () => {
    for (const other of ['country', 'device', 'hourEt', 'os']) {
      const { body } = await post({ dimension: 'featureStep', dims: ['featureStep', other], excludeKnownTraffic: true })
      const keys = new Set(body.rows.map((r: any) => r.key.featureStep))
      expect(keys.size, other).toBeGreaterThan(0)
      for (const k of keys) expect(REFUSED_STEPS.includes(k as never), `${k} by ${other}`).toBe(false)
      expect(body.meta.splitGuard).toBe(true)
    }
    const { body } = await post({ dimension: 'featureStep', dims: ['featureStep', 'site'], excludeKnownTraffic: true })
    expect(body.meta.splitGuard).toBeUndefined()
    const keys = new Set(body.rows.map((r: any) => r.key.featureStep))
    for (const k of ['games.start', 'tour.skip', 'coach.shown', 'funnel.purchase-web']) expect(keys.has(k), k).toBe(true)
  })

  it('points mode (the map) on a refused step counts nothing', async () => {
    const { body } = await post({ dimension: 'points', constraints: [step('games.start')], excludeKnownTraffic: true })
    expect(body.rows).toEqual([])
    expect(body.meta.splitGuard).toBe(true)
  })
})

describe('featureStep: grouped (a row on its first matching step)', () => {
  beforeEach(seed)

  it('counts every step row once, on its first step in config order, refused rows included', async () => {
    const { body } = await post({ dimension: 'featureStep', excludeKnownTraffic: true })
    const want: Record<string, number> = {}
    const flat = flatSteps(FEATURES)
    DAYS.forEach((_, i) => {
      for (const p of DISTINCT_PATHS) {
        const first = flat.find((f) => stepMatches(f.step.match, p, null))!
        const k = featureStepKey(first.feature.id, first.step.id)
        want[k] = (want[k] ?? 0) + perDay(i)
      }
    })
    expect(Object.fromEntries(body.rows.map((r: any) => [r.key.featureStep, r.pageviews]))).toEqual(want)
    expect(body.meta.splitGuard).toBeUndefined()
  })

  it('matches the JS step test over every configured path shape, the except list and decoys', async () => {
    const flat = flatSteps(FEATURES)
    const paths = [
      ...new Set([
        ...flat.flatMap((f) => [...(f.step.match.exact ?? []), ...(f.step.match.prefix ?? []).map((p) => `${p}a/b`), ...(f.step.match.except ?? [])]),
        '/signin-prompt/first-finish', '/game/start', '/game/complete-deferred/normal/easy', '/coach/shown', '/funnel/other', '/install/prompt/other',
      ]),
    ]
    db.exec('DELETE FROM hits')
    insertHits(db, paths.map((p, i) => ({ ts: noon(DAYS[0], i), site: 'bestsudoku-web', path: p })))
    const { body } = await post({ dimension: 'featureStep', excludeKnownTraffic: false })
    const want: Record<string, number> = {}
    for (const p of paths) {
      const first = flat.find((f) => stepMatches(f.step.match, p, null))
      if (first) want[featureStepKey(first.feature.id, first.step.id)] = (want[featureStepKey(first.feature.id, first.step.id)] ?? 0) + 1
    }
    expect(Object.fromEntries(body.rows.map((r: any) => [r.key.featureStep, r.pageviews]))).toEqual(want)
    // And each step as a filter counts exactly the paths the JS test says.
    for (const f of flat) {
      const key = featureStepKey(f.feature.id, f.step.id)
      const r = await post({ dimension: 'dateEt', constraints: [step(key)] })
      expect(r.body.totals.pageviews, key).toBe(paths.filter((p) => stepMatches(f.step.match, p, null)).length)
    }
  })
})

describe('featureStep: the always-exclusions (commit 98bcbbc4) and known traffic', () => {
  beforeEach(seed)

  it('manual production checks never count, with known traffic hidden or shown; known traffic counts only when shown', async () => {
    const hidden = await post({ dimension: 'dateEt', constraints: [step('games.start')], excludeKnownTraffic: true })
    const shown = await post({ dimension: 'dateEt', constraints: [step('games.start')], excludeKnownTraffic: false })
    expect(byDay(hidden.body.rows)['2026-10-13']).toBe(perDay(1))
    expect(byDay(shown.body.rows)['2026-10-13']).toBe(perDay(1) + 9) // the household row; never the 50 manual checks
    const tourShown = await post({ dimension: 'dateEt', constraints: [step('tour.start')], excludeKnownTraffic: false })
    expect(byDay(tourShown.body.rows)['2026-10-13']).toBe(perDay(1) + 7) // the lifecycle row; never the 50 manual checks
    const grouped = await post({ dimension: 'featureStep', excludeKnownTraffic: false })
    const total = grouped.body.rows.reduce((a: number, r: any) => a + r.pageviews, 0)
    expect(total).toBe(DAYS.reduce((a, _, i) => a + perDay(i) * DISTINCT_PATHS.length, 0) + 7 + 9)
  })
})

describe('featureStep: no visitor or device id, no join', () => {
  beforeEach(seed)

  it('the step chart and grouped queries read path, campaign and ts only for their keys, group by the key alone, and join nothing', async () => {
    for (const body of [
      { dimension: 'dateEt', constraints: [step('games.start')], excludeKnownTraffic: true },
      { dimension: 'dateEt', constraints: [step('tour.start')], excludeKnownTraffic: false },
      { dimension: 'featureStep', excludeKnownTraffic: true },
    ]) {
      const { statements, body: res } = await post(body)
      expect(statements).toHaveLength(1)
      const sql = statements[0]
      expect(sql).not.toMatch(/\bJOIN\b/i)
      expect(sql).not.toMatch(/\bvisitor\b/)
      // The grouping is the one derived key; the select list reads no hour, place or device column.
      expect(sql).toMatch(/GROUP BY k\)/)
      const selectList = sql.slice(sql.indexOf('FROM (SELECT ') + 'FROM (SELECT '.length, sql.indexOf(' FROM hits'))
      expect(selectList).not.toMatch(/\b(visitor|device|browser|os|country|region|city|postal|lat|lon|colo|org|screenw|timezone|lang)\b/)
      for (const r of res.rows) expect(Object.keys(r.key)).toEqual([body.dimension])
    }
  })
})

describe('featureStep: whole ET days for every row', () => {
  beforeEach(seed)

  it('a sub-day window counts whole ET days for refused and plain steps alike; the caption flag follows the refused steps', async () => {
    // 10-12 10:00 ET .. 10-14 14:00 ET snaps (nearest) to 10-12 00:00 .. 10-15 00:00 ET.
    insertHits(db, [row(DAYS[0], '/tour/start', 'bestsudoku-web', 100, { ts: Date.parse('2026-10-12T05:00:00Z') }), row(DAYS[0], '/game/start/easy', 'bestsudoku-web', 100, { ts: Date.parse('2026-10-12T05:00:00Z') })])
    const window = { since: '2026-10-12T14:00:00Z', until: '2026-10-14T18:00:00Z' }
    const plain = await post({ ...window, dimension: 'dateEt', constraints: [step('tour.start')], excludeKnownTraffic: true })
    const refused = await post({ ...window, dimension: 'dateEt', constraints: [step('games.start')], excludeKnownTraffic: true })
    const want = { '2026-10-12': perDay(0) + 100, '2026-10-13': perDay(1), '2026-10-14': perDay(2) }
    expect(byDay(plain.body.rows)).toEqual(want)
    expect(byDay(refused.body.rows)).toEqual(want)
    expect(refused.body.meta.refusedWholeDays).toBe(true)
    expect(plain.body.meta.refusedWholeDays).toBeUndefined()
    // With a split the guard's exact window applies (and refused rows are out).
    const split = await post({ ...window, dimension: 'dateEt', constraints: [step('tour.start'), { field: 'device', value: 'mobile' }], excludeKnownTraffic: true })
    expect(byDay(split.body.rows)['2026-10-12']).toBe(perDay(0))
  })
})

describe('featureStep: today on the step chart axis (the counted window is the echoed one)', () => {
  beforeEach(seed)
  // Today is 10-15 (EDT). Rows at 01:00 ET today; the range starts on an ET midnight and ends "now".
  const since = '2026-10-12T04:00:00Z'
  const chart = (resp: any) => buildSeriesLineConfig({ id: 't', i: 't', x: 0, y: 0, w: 6, h: 8, type: 'line', dataset: 'geo', dimension: 'dateEt', metric: 'pageviews', series: [{ label: 'Started', filter: [step('tour.start')], axis: 'left', style: 'solid' }] } as any, [resp])!
  const labels = (c: any) => c.data.labels as string[]
  const points = (c: any) => c.data.datasets[0].data as number[]
  beforeEach(() => insertHits(db, [row('2026-10-15', '/tour/start', 'bestsudoku-web', 5, { ts: Date.parse('2026-10-15T05:00:00Z') })]))

  it('before noon ET today is neither counted nor drawn (the old card had no such day either)', async () => {
    const { body } = await post({ since, until: '2026-10-15T14:00:00Z', dimension: 'dateEt', constraints: [step('tour.start')], excludeKnownTraffic: true })
    expect(byDay(body.rows)['2026-10-15']).toBeUndefined()
    expect(body.meta.since).toBe('2026-10-12T04:00:00.000Z')
    expect(body.meta.until).toBe('2026-10-15T03:59:59.999Z') // the last counted ms: 10-14 23:59:59.999 ET
    const c = chart(body)
    expect(labels(c)).toEqual(DAYS.map((d) => formatKey('date', d)))
    expect(points(c)).toEqual(DAYS.map((_, i) => perDay(i)))
  })

  it('from noon ET today is counted so far and drawn', async () => {
    const { body } = await post({ since, until: '2026-10-15T20:00:00Z', dimension: 'dateEt', constraints: [step('tour.start')], excludeKnownTraffic: true })
    expect(byDay(body.rows)['2026-10-15']).toBe(5)
    expect(body.meta.until).toBe('2026-10-16T03:59:59.999Z')
    const c = chart(body)
    expect(labels(c)).toEqual([...DAYS, '2026-10-15'].map((d) => formatKey('date', d)))
    expect(points(c)).toEqual([...DAYS.map((_, i) => perDay(i)), 5])
  })

  it('a query with no featureStep, or with a split, echoes the window it was sent', async () => {
    const until = '2026-10-15T14:00:00Z'
    const plain = await post({ since, until, dimension: 'dateEt', constraints: [{ field: 'path', value: '/tour/start' }] })
    expect([plain.body.meta.since, plain.body.meta.until]).toEqual([since, until])
    const split = await post({ since, until, dimension: 'dateEt', constraints: [step('tour.start'), { field: 'device', value: 'mobile' }] })
    expect([split.body.meta.since, split.body.meta.until]).toEqual([since, until])
  })
})

describe('featureStep: a step chart asks once (stepSeries), each series as its own query would answer', () => {
  beforeEach(seed)
  const keysOf = (f: (typeof FEATURES)[number]) => f.steps.map((s) => featureStepKey(f.id, s.id))
  const variants: Record<string, Record<string, unknown>> = {
    'known traffic hidden': { excludeKnownTraffic: true },
    'known traffic shown': { excludeKnownTraffic: false },
    'app only': { excludeKnownTraffic: true, sites: ['bestsudoku-app'] },
    'a sub-day window': { excludeKnownTraffic: true, since: '2026-10-12T14:00:00Z', until: '2026-10-14T18:00:00Z' },
    'before noon ET': { excludeKnownTraffic: true, until: '2026-10-14T14:00:00Z' },
    'a device drill (split guard)': { excludeKnownTraffic: true, constraints: [{ field: 'device', value: 'mobile' }] },
    'a featureStep drill': { excludeKnownTraffic: true, constraints: [step('games.start')] },
    'own visits hidden': { excludeKnownTraffic: true, excludeOwnVisits: true, ownBrowser: 'Chrome', ownOS: 'Android' },
    'a short limit': { excludeKnownTraffic: true, limit: 2 },
  }
  for (const [name, v] of Object.entries(variants)) {
    it(`${name}: every feature's batched series equal its per-series answers, from one statement`, async () => {
      for (const f of FEATURES) {
        const keys = keysOf(f)
        const drills = (v.constraints as unknown[]) ?? []
        const batched = await post({ ...v, dimension: 'dateEt', stepSeries: keys })
        expect(batched.status).toBe(200)
        expect(batched.statements, f.id).toHaveLength(1)
        expect(batched.body.series).toHaveLength(keys.length)
        for (const [i, key] of keys.entries()) {
          const one = await post({ ...v, dimension: 'dateEt', constraints: [...drills, step(key)] })
          expect(batched.body.series[i], `${name} ${key}`).toEqual(one.body)
        }
      }
    })
  }

  it('repeated and unknown values: each series still answers for itself', async () => {
    const keys = ['games.start', 'games-easy.start', 'games.start', 'nope.x', "games.start' OR 1=1 --"]
    const { body, status } = await post({ dimension: 'dateEt', stepSeries: keys, excludeKnownTraffic: true })
    expect(status).toBe(200)
    expect(byDay(body.series[0].rows)).toEqual(byDay(body.series[1].rows))
    expect(body.series[2]).toEqual(body.series[0])
    for (const i of [3, 4]) expect(body.series[i].totals.pageviews).toBe(0)
  })

  it('the batched statement reads no hour, place, device or visitor column, joins nothing and groups by the date key alone', async () => {
    const { statements } = await post({ dimension: 'dateEt', stepSeries: keysOf(FEATURES.find((f) => f.id === 'install')!), excludeKnownTraffic: true })
    const sql = statements[0]
    expect(sql).not.toMatch(/\bJOIN\b/i)
    expect(sql).not.toMatch(/\bvisitor\b/)
    expect(sql).toMatch(/GROUP BY k\)/)
    const selectList = sql.slice(sql.indexOf('FROM (SELECT ') + 'FROM (SELECT '.length, sql.indexOf(' FROM hits'))
    expect(selectList).not.toMatch(/\b(visitor|device|browser|os|country|region|city|postal|lat|lon|colo|org|screenw|timezone|lang)\b/)
  })

  it('refuses a non-date dimension, points, a ring and too many series', async () => {
    expect((await post({ dimension: 'country', stepSeries: ['tour.start'] })).status).toBe(400)
    expect((await post({ dimension: 'points', stepSeries: ['tour.start'] })).status).toBe(400)
    expect((await post({ dimension: 'site', dims: ['site', 'featureStep'], stepSeries: ['tour.start'] })).status).toBe(400)
    expect((await post({ dimension: 'dateEt', stepSeries: Array.from({ length: 17 }, () => 'tour.start') })).status).toBe(400)
  })
})
