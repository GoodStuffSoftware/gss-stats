// `ads:postflight-read --as-of <YYYY-MM-DD ET>`: a stage read that did not run on its day, taken afterwards
// on the clock of the end of that ET day (cli.ts resolvePostflightClock; read.ts runPostflightRead).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { endOfEtDayMs, fixtureDeps, resolvePostflightClock, type Fixture } from './cli'
import { runPostflightRead } from './read'
import { returnRowsQuery, returnSitesQuery, siteEventsQuery, taggedRowsQuery } from './beacon'
import { campaignById } from '../../src/lib/campaigns'
import { formatPostflightReport } from './report'
import { dataThroughOf, type PostflightStage } from '../../src/lib/adsRules'

const here = path.dirname(fileURLToPath(import.meta.url))
const RETEST = '24279250691'
const ARMS = [
  { id: '24311309184', uc: 'sudoku_funnel_f2_search' },
  { id: '24316608605', uc: 'sudoku_funnel_f2_apps' },
] as const
const TODAY = Date.parse('2026-10-29T15:00:00Z')
// 23:59:59.999 EDT on 10-17 and 10-25 (DST ends 2026-11-01).
const END_1017 = '2026-10-18T03:59:59.999Z'
const END_1025 = '2026-10-26T03:59:59.999Z'

/** The retest fixture re-pointed at an F2 arm, with spend on every day from the flight start to 10-28 ($10/day) and
 * tagged arrivals both before and after the as-of days. */
function armFixture(arm: (typeof ARMS)[number], now: string): Fixture {
  const raw = fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8')
  const fx = JSON.parse(raw.split(RETEST).join(arm.id).split('sudoku_funnel_retest').join(arm.uc)) as Fixture
  fx.now = now
  const ads = fx.ads as Extract<Fixture['ads'], { daily: unknown }>
  ads.daily = {}
  for (let d = 4; d <= 31; d++) ads.daily[`2026-10-${String(d).padStart(2, '0')}`] = { costMicros: 10_000_000, impressions: 1000, clicks: 10 }
  const b = fx.beacon as Extract<Fixture['beacon'], { returns: unknown }>
  b.returns = [
    { site: 'bestsudoku-web', path: `/return/${arm.uc}/d0`, count: 40 },
    { site: 'bestsudoku-web', path: `/return/${arm.uc}/d2-7`, count: 3 },
    { site: 'bestsudoku-web', path: `/return/${arm.uc}/d8-14`, count: 2 },
  ]
  return fx
}

const run = (arm: (typeof ARMS)[number], stage: PostflightStage, now: string) =>
  runPostflightRead(fixtureDeps(armFixture(arm, now), false), { campaignId: arm.id, stage, force: false })

describe.each(ARMS)('--as-of ($id)', (arm) => {
  it.each([
    ['wrapup', '2026-10-17', END_1017],
    ['day15', '2026-10-25', END_1025],
  ] as const)('%s as-of %s equals the same fixture run with --now at the end of that ET day', async (stage, date, endIso) => {
    const clock = resolvePostflightClock({ stage, campaign: arm.id, 'as-of': date }, stage, TODAY)
    expect(clock.campaignId).toBe(arm.id)
    expect(clock.nowMs).toBe(Date.parse(endIso))
    const asOf = await run(arm, stage, new Date(clock.nowMs).toISOString())
    const withNow = await run(arm, stage, endIso)
    expect(asOf).toEqual(withNow)
    expect(formatPostflightReport(asOf)).toBe(formatPostflightReport(withNow))
    expect(asOf.etDate).toBe(date)
  })

  it('an as-of read stops its Ads spend at the as-of day, not at the real today', async () => {
    const early = await run(arm, 'wrapup', END_1017)
    const real = await run(arm, 'wrapup', '2026-10-29T15:00:00Z')
    // After the flight (ends 10-10): 10-11 .. 10-17 as-of, against 10-11 .. 10-29 on the real day.
    expect(early.postFlightSpend?.value).toBe(70)
    expect(real.postFlightSpend?.value).toBe(190)
    expect(early.etDate).toBe('2026-10-17')
    expect(early.dataThrough).toBe('2026-10-16') // no as-of mark here, just an early clock: the last closed day
    expect(real.dataThrough).toBe('2026-10-28') // a live run: the last closed day before the read date
  })

  it('stores the reading under the stage date with the as-of in its notes, and read_at stays the real time', async () => {
    const clock = resolvePostflightClock({ stage: 'wrapup', campaign: arm.id, 'as-of': '2026-10-17' }, 'wrapup', TODAY)
    const deps = fixtureDeps(armFixture(arm, new Date(clock.nowMs).toISOString()), false)
    deps.asOf = clock.asOf!
    const r = await runPostflightRead(deps, { campaignId: arm.id, stage: 'wrapup', force: false })
    const rows = deps.store.written.readings
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'postflight', stage: 'wrapup', etDate: '2026-10-17', readAt: '2026-10-29T15:00:00.000Z' })
    expect(rows[0].id).toBe(`postflight:${arm.id}:wrapup:2026-10-29T15:00:00.000Z`)
    expect(rows[0].notes[0]).toContain('As-of read')
    expect(rows[0].notes[0]).toContain('end of 2026-10-17 ET')
    expect(r.readAt).toBe('2026-10-29T15:00:00.000Z')
    expect(r.notes[0]).toContain('As-of read')
    // The numbers run through the end of the as-of day: that is the stored data-through, and the report prints it beside the date.
    expect(r.dataThrough).toBe('2026-10-17')
    expect(dataThroughOf(rows[0].notes)).toBe('2026-10-17')
    expect(formatPostflightReport(r)).toContain('data through 2026-10-17')
    // A second as-of run of the same stage and day adds nothing.
    const again = await runPostflightRead(deps, { campaignId: arm.id, stage: 'wrapup', force: false })
    expect(again.dedup.skipped).toHaveLength(1)
    expect(deps.store.written.readings).toHaveLength(1)
  })
})

describe('as-of beacon reads carry an exclusive ET-midnight upper bound', () => {
  const camp = campaignById(ARMS[0].id)!
  const UNTIL = Date.parse('2026-10-18T04:00:00Z') // the ET midnight after 10-17 (EDT)
  it('each of the four D1 queries gets `ts < ?` with the bound among its binds, and none without one', () => {
    const live = [taggedRowsQuery(camp), siteEventsQuery(1), returnRowsQuery(camp), returnSitesQuery(1)]
    const bounded = [taggedRowsQuery(camp, undefined, null, UNTIL), siteEventsQuery(1, undefined, UNTIL), returnRowsQuery(camp, UNTIL), returnSitesQuery(1, UNTIL)]
    live.forEach((q, i) => {
      const n = (sql: string) => sql.split('ts < ?').length - 1 // the tagged read's install-gap exclusion has one already
      expect(n(bounded[i].sql)).toBe(n(q.sql) + 1)

      expect(bounded[i].binds).toContain(UNTIL)
      expect(bounded[i].binds.length).toBe(q.binds.length + 1)
      expect((bounded[i].sql.match(/\?/g) ?? []).length).toBe(bounded[i].binds.length)
    })
  })
  it('an as-of run passes the ET midnight after the as-of day to every beacon read; a live run passes none', async () => {
    const seen: Record<string, (number | null | undefined)[]> = { tagged: [], siteEvents: [], returns: [], returnSites: [] }
    const spy = (deps: ReturnType<typeof fixtureDeps>) => {
      const b = deps.beacon!
      deps.beacon = {
        ...b,
        tagged: (c, u, m, until) => (seen.tagged.push(until), b.tagged(c, u, m, until)),
        siteEvents: (s, until) => (seen.siteEvents.push(until), b.siteEvents(s, until)),
        returns: (c, until) => (seen.returns.push(until), b.returns(c, until)),
        returnSites: (s, until) => (seen.returnSites.push(until), b.returnSites(s, until)),
      }
    }
    const arm = ARMS[0]
    const clock = resolvePostflightClock({ stage: 'wrapup', campaign: arm.id, 'as-of': '2026-10-17' }, 'wrapup', TODAY)
    const asOfDeps = fixtureDeps(armFixture(arm, new Date(clock.nowMs).toISOString()), false)
    asOfDeps.asOf = clock.asOf!
    spy(asOfDeps)
    await runPostflightRead(asOfDeps, { campaignId: arm.id, stage: 'wrapup', force: false })
    for (const k of Object.keys(seen)) {
      expect(seen[k].length, k).toBeGreaterThan(0)
      expect(new Set(seen[k]), k).toEqual(new Set([UNTIL]))
    }
    for (const k of Object.keys(seen)) seen[k] = []
    const liveDeps = fixtureDeps(armFixture(arm, '2026-10-29T15:00:00Z'), false)
    spy(liveDeps)
    await runPostflightRead(liveDeps, { campaignId: arm.id, stage: 'wrapup', force: false })
    for (const k of Object.keys(seen)) {
      expect(seen[k].length, k).toBeGreaterThan(0)
      expect(new Set(seen[k].map((x) => x ?? null)), k).toEqual(new Set([null]))
    }
  })
})

describe('resolvePostflightClock', () => {
  const base = { stage: 'wrapup', campaign: '24311309184' }
  it('without --as-of the clock is the one given', () => {
    expect(resolvePostflightClock(base, 'wrapup', TODAY)).toEqual({ campaignId: '24311309184', nowMs: TODAY, asOf: null })
  })
  it('as-of today uses the real now, not a future end of day', () => {
    expect(resolvePostflightClock({ ...base, 'as-of': '2026-10-29' }, 'wrapup', TODAY)).toMatchObject({ nowMs: TODAY, asOf: { etDate: '2026-10-29' } })
  })
  it('the end of an ET day follows DST', () => {
    expect(new Date(endOfEtDayMs('2026-10-31')).toISOString()).toBe('2026-11-01T03:59:59.999Z') // EDT
    expect(new Date(endOfEtDayMs('2026-11-01')).toISOString()).toBe('2026-11-02T04:59:59.999Z') // EST from 02:00
  })
  it('refuses a date in the future', () => {
    expect(() => resolvePostflightClock({ ...base, 'as-of': '2026-10-30' }, 'wrapup', TODAY)).toThrow(/in the future/)
    // checked before the campaign is resolved, so it is the message even without --campaign
    expect(() => resolvePostflightClock({ stage: 'wrapup', 'as-of': '2026-10-30' }, 'wrapup', TODAY)).toThrow(/in the future/)
  })
  it('refuses a date before the stage is due', () => {
    expect(() => resolvePostflightClock({ ...base, 'as-of': '2026-10-16' }, 'wrapup', TODAY)).toThrow(/before the wrapup stage's due date 2026-10-17/)
    expect(() => resolvePostflightClock({ ...base, 'as-of': '2026-10-24' }, 'day15', TODAY)).toThrow(/before the day15 stage's due date 2026-10-25/)
  })
  it('accepts a date after the due date', () => {
    expect(resolvePostflightClock({ ...base, 'as-of': '2026-10-20' }, 'wrapup', TODAY).nowMs).toBe(endOfEtDayMs('2026-10-20'))
  })
  it('refuses a malformed or impossible date, an empty one, and --now beside it', () => {
    for (const bad of ['10-17', '2026-10-17T12:00', '2026-13-01', '2026-02-30', '', 'today']) {
      expect(() => resolvePostflightClock({ ...base, 'as-of': bad }, 'wrapup', TODAY), bad).toThrow(/YYYY-MM-DD/)
    }
    expect(() => resolvePostflightClock({ ...base, 'as-of': '2026-10-17', now: '2026-10-17T12:00:00Z' }, 'wrapup', TODAY)).toThrow(/cannot be combined/)
  })
  it('an unknown campaign is still refused', () => {
    expect(() => resolvePostflightClock({ ...base, campaign: 'nope', 'as-of': '2026-10-17' }, 'wrapup', TODAY)).toThrow(/not a registered campaign id/)
  })
})
