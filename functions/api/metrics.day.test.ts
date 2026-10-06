// The day selector on the Today at a glance card: POST /api/metrics with `context.day` reads a past
// ET day whole and compares it with the day before it and the 7 whole days before that, instead of
// today so far. Run through the real handler over the node:sqlite fixture: the ET-day bounds
// (including the DST days), the comparisons for a past day, the validation of the parameter, and
// that a past day is static (liveSafe never set, the answer independent of the clock).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { onRequestPost as metricsPost } from './metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../_lib/testing/hitsDb'
import type { MetricRequest, MetricsResponseBody } from '../../src/lib/metrics/types'
import { MAX_DAY_LOOKBACK_DAYS } from '../../src/lib/metrics/validate'

const WEB = 'bestsudoku-web'
const at = (iso: string) => Date.parse(iso)
const NOW = at('2026-10-06T15:00:00Z') // 11:00 EDT on Tue 2026-10-06
let db: ReturnType<typeof openHitsDb>
let undoCaches: () => void

beforeAll(() => {
  db = openHitsDb()
  const row = (ts: string, n: number, path = '/') => ({ site: WEB, ts: at(ts), path, visitor: 'returning' as const, n })
  insertHits(db, [
    // ET day 2026-10-01
    row('2026-10-01T14:00:00Z', 4),
    // ET day 2026-10-02: 6 at midday, and 1 at 23:59 ET (2026-10-03T03:59Z)
    row('2026-10-02T14:00:00Z', 6),
    row('2026-10-03T03:59:00Z', 1),
    // ET day 2026-10-03: the first instant (04:00Z), midday, evening, and the last instant (23:59:59 ET)
    row('2026-10-03T04:00:00Z', 2),
    row('2026-10-03T14:00:00Z', 20),
    row('2026-10-03T22:00:00Z', 3),
    row('2026-10-04T03:59:59Z', 1),
    // ET day 2026-10-04 and today (2026-10-06 until 11:00): never part of 10-03
    row('2026-10-04T14:00:00Z', 9),
    row('2026-10-06T13:00:00Z', 5),
    // return beacons (a metric that can count refused rows: whole ET days, in wholeDays)
    row('2026-10-02T15:00:00Z', 2, '/return/sudoku_tired_of_ads/d1'),
    row('2026-10-03T15:00:00Z', 3, '/return/sudoku_tired_of_ads/d1'),
    // another site is never a Best Sudoku figure
    { site: 'goodstuff', ts: at('2026-10-03T14:00:00Z'), path: '/', visitor: 'new' as const, n: 100 },
  ])
})
beforeEach(() => {
  undoCaches = installCaches(memoryCache())
})
afterEach(() => {
  vi.useRealTimers()
  undoCaches()
})

async function postOn(database: ReturnType<typeof openHitsDb>, nowMs: number, body: unknown) {
  vi.useFakeTimers({ now: nowMs, toFake: ['Date'] })
  const waited: Promise<unknown>[] = []
  const res = await metricsPost(pagesContext(postJson('/api/metrics', body), { gss_geo: sqliteD1(database) }, waited) as never)
  await Promise.all(waited)
  return { res, json: (await res.json()) as MetricsResponseBody & { error?: string } }
}
const post = (nowMs: number, body: unknown) => postOn(db, nowMs, body)
const PV: MetricRequest = { key: 'pv', metric: 'bsk.pageviews', window: 'todaySoFar', deltas: ['yesterday', 'avg7'] }
async function pvOn(nowMs: number, day?: string, database = db) {
  const { res, json } = await postOn(database, nowMs, { v: 1, ...(day ? { context: { day } } : {}), requests: [PV] })
  expect(res.status).toBe(200)
  return json.results.pv
}

describe('a past day is read whole, over its ET-day bounds', () => {
  it('counts the day from its first instant to its last, nothing of the days beside it', async () => {
    const v = await pvOn(NOW, '2026-10-03')
    expect(v).toMatchObject({ status: 'ok', value: 2 + 20 + 3 + 1 })
  })
  it('the prior day is its own whole ET day (a 23:59 ET row belongs to it, not to the next day)', async () => {
    const v = await pvOn(NOW, '2026-10-03')
    expect(v.value! - v.deltas!.yesterday!.delta!).toBe(6 + 1)
  })
  it('the 7-day average is the 7 whole ET days before the chosen day, summed over 7', async () => {
    const v = await pvOn(NOW, '2026-10-03')
    expect(v.value! - v.deltas!.avg7!.delta!).toBeCloseTo((4 + 6 + 1) / 7, 6) // 10-01 and 10-02 are the only days with rows before 10-03
  })
  it('a day with no rows is a measured 0, with the prior day beside it', async () => {
    const v = await pvOn(NOW, '2026-10-05')
    expect(v).toMatchObject({ status: 'ok', value: 0 })
    expect(v.deltas?.yesterday?.delta).toBe(-9) // 0 against the 9 of 10-04
  })
  it('today stays today so far (day = today, or no day, are the same live read)', async () => {
    expect(await pvOn(NOW)).toMatchObject({ status: 'ok', value: 5 })
    expect((await pvOn(NOW, '2026-10-06')).value).toBe(5)
  })
  it('a past day does not move with the clock: the same answer a week later', async () => {
    const a = await pvOn(NOW, '2026-10-03')
    undoCaches()
    undoCaches = installCaches(memoryCache())
    const b = await pvOn(NOW + 7 * 24 * 3_600_000, '2026-10-03')
    expect(b.value).toBe(a.value)
    expect(b.deltas).toEqual(a.deltas)
  })
  it('a day is never answered from the live (today) cache entry, nor today from the day entry', async () => {
    const day = await pvOn(NOW, '2026-10-03')
    const today = await pvOn(NOW)
    expect(day.value).toBe(26)
    expect(today.value).toBe(5)
  })
})

describe('a metric that can count a refused row compares whole ET days', () => {
  it('a past day carries the prior whole day in wholeDays, never deltas', async () => {
    const { res, json } = await post(NOW, { v: 1, context: { day: '2026-10-03' }, requests: [{ key: 'r', metric: 'bsk.returnsD1plus', window: 'todaySoFar', deltas: ['yesterday', 'avg7'] }] })
    expect(res.status).toBe(200)
    const v = json.results.r
    expect(v).toMatchObject({ status: 'ok', value: 3 })
    expect(v.deltas).toBeUndefined()
    expect(v.wholeDays?.yesterday).toBe(2)
  })
})

describe('a past day is static', () => {
  it('no value of a past day is flagged liveSafe, so a live ping never refetches it', async () => {
    expect((await pvOn(NOW, '2026-10-03')).liveSafe).toBeUndefined()
  })
})

describe('the ET-day bounds over a DST change', () => {
  // 2026-11-01 is the 25-hour day (clocks fall back); 2026-03-08 the 23-hour one.
  it('the fall-back day (25 hours) is whole: its first and last instants are in, its neighbours are out', async () => {
    const d = openHitsDb()
    insertHits(d, [
      { site: WEB, ts: at('2026-11-01T03:59:59Z'), path: '/', visitor: 'returning', n: 7 }, // 23:59:59 EDT on 10-31
      { site: WEB, ts: at('2026-11-01T04:00:00Z'), path: '/', visitor: 'returning', n: 1 }, // 00:00 EDT, first instant
      { site: WEB, ts: at('2026-11-02T04:59:59Z'), path: '/', visitor: 'returning', n: 2 }, // 23:59:59 EST, last instant
      { site: WEB, ts: at('2026-11-02T05:00:00Z'), path: '/', visitor: 'returning', n: 11 }, // 11-02 00:00 EST
    ])
    const v = await pvOn(at('2026-11-10T15:00:00Z'), '2026-11-01', d)
    expect(v).toMatchObject({ status: 'ok', value: 3 })
    expect(v.value! - v.deltas!.yesterday!.delta!).toBe(7)
  })
  it('the spring-forward day (23 hours) is whole', async () => {
    const d = openHitsDb()
    insertHits(d, [
      { site: WEB, ts: at('2026-03-08T04:59:59Z'), path: '/', visitor: 'returning', n: 5 }, // 23:59:59 EST on 03-07
      { site: WEB, ts: at('2026-03-08T05:00:00Z'), path: '/', visitor: 'returning', n: 1 }, // 00:00 EST, first instant
      { site: WEB, ts: at('2026-03-09T03:59:59Z'), path: '/', visitor: 'returning', n: 2 }, // 23:59:59 EDT, last instant
      { site: WEB, ts: at('2026-03-09T04:00:00Z'), path: '/', visitor: 'returning', n: 9 }, // 03-09 00:00 EDT
    ])
    const v = await pvOn(at('2026-03-20T15:00:00Z'), '2026-03-08', d)
    expect(v).toMatchObject({ status: 'ok', value: 3 })
    expect(v.value! - v.deltas!.yesterday!.delta!).toBe(5)
  })
})

describe('context.day validation', () => {
  const body = (day: unknown) => ({ v: 1, context: { day }, requests: [PV] })
  it.each([
    ['a datetime', '2026-10-03T00:00:00Z'],
    ['a month only', '2026-10'],
    ['a slashed date', '10/03/2026'],
    ['not a date', 'yesterday'],
    ['a day that does not exist', '2026-02-30'],
    ['a number', 20261003],
    ['an empty string', ''],
    ['tomorrow', '2026-10-07'],
    ['a far-future day', '2030-01-01'],
    ['past the floor', '2025-01-01'],
  ])('%s is a 400', async (_n, day) => {
    const { res, json } = await post(NOW, body(day))
    expect(res.status).toBe(400)
    expect(json.error).toMatch(/^context\.day /)
  })
  it('names the reason: future and floor', async () => {
    expect((await post(NOW, body('2026-10-07'))).json.error).toBe('context.day cannot be in the future')
    expect((await post(NOW, body('2025-01-01'))).json.error).toBe(`context.day is more than ${MAX_DAY_LOOKBACK_DAYS} days back`)
  })
  it('the floor itself and today are allowed; the day before the floor is not', async () => {
    expect((await post(NOW, body('2026-07-08'))).res.status).toBe(200) // 90 ET days before 2026-10-06
    expect((await post(NOW, body('2026-07-07'))).res.status).toBe(400)
    expect((await post(NOW, body('2026-10-06'))).res.status).toBe(200)
  })
  it('"today" is the ET day: just after ET midnight the new date is allowed and the next is a future day', async () => {
    const justAfter = at('2026-10-07T04:00:30Z') // 00:00:30 EDT on 10-07, still 10-06 in UTC
    expect((await post(justAfter, body('2026-10-07'))).res.status).toBe(200)
    expect((await post(justAfter, body('2026-10-08'))).res.status).toBe(400)
    const justBefore = at('2026-10-07T03:59:30Z') // 23:59:30 EDT on 10-06
    expect((await post(justBefore, body('2026-10-07'))).res.status).toBe(400)
  })
  it('an unknown context key is still refused (the key list did not open up)', async () => {
    const { res } = await post(NOW, { v: 1, context: { days: '2026-10-03' }, requests: [PV] })
    expect(res.status).toBe(400)
  })
})
