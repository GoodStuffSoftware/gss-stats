// The flight 3 day 1-2 tracking check reads three tagged counts from the ads report alone:
// complete rows, the three flight 3 sign-in ask paths, and /coach/shown/place. Made-up fixture
// rows only (threshold-50.json, synthetic): no network, no credentials.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fixtureDeps, type Fixture } from './cli'
import { runMorningRead, type MorningOptions } from './read'
import { formatMorningReport } from './report'
import { MIN_COHORT } from '../../src/lib/popupEvents'
import { summarizeTaggedRows, type TaggedRow } from '../../src/lib/adsRules'

const here = path.dirname(fileURLToPath(import.meta.url))
const base = (): Fixture => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8'))
const opts: MorningOptions = { campaignId: '24279250691', releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 }
type Tagged = Extract<Fixture['beacon'], { tagged: unknown }>['tagged']
const beaconOf = (fx: Fixture) => fx.beacon as Extract<Fixture['beacon'], { tagged: unknown }>
const YESTERDAY = '2026-09-29T20:00:00Z' // fixture "now" is 2026-09-30 12:05Z, so yesterday's ET day is 09-29
const EARLIER = '2026-09-28T17:00:00Z'

const rows = (extra: Tagged): Fixture => {
  const fx = base()
  beaconOf(fx).tagged = [...beaconOf(fx).tagged, ...extra]
  return fx
}
const reportOf = async (fx: Fixture) => formatMorningReport(await runMorningRead(fixtureDeps(fx, true), opts))
const dailyLine = async (fx: Fixture) => (await reportOf(fx)).split('\n').find((l) => l.startsWith('Tagged so far'))!
const blockLine = async (fx: Fixture) => (await reportOf(fx)).split('\n').find((l) => l.startsWith('  tracking-check counts'))!

describe('ads report: the flight 3 day 1-2 tracking-check counts', () => {
  const fx = () =>
    rows([
      { hour: EARLIER, path: '/coach/shown/place', visitor: 'new', count: 4 },
      { hour: YESTERDAY, path: '/coach/shown/place', visitor: 'new', count: 3 },
      // not /coach/shown/place: never counted
      { hour: YESTERDAY, path: '/coach/shown/hint', visitor: 'new', count: 9 },
      { hour: YESTERDAY, path: '/coach/dismissed/place', visitor: 'new', count: 8 },
      { hour: YESTERDAY, path: '/coach/tour-opened', visitor: 'new', count: 7 },
      { hour: EARLIER, path: '/game/complete/normal/easy', visitor: 'returning', count: 5 },
      { hour: YESTERDAY, path: '/game/complete/daily/hard', visitor: 'returning', count: 2 },
      { hour: YESTERDAY, path: '/signin-prompt/committed-repeat', visitor: 'returning', count: 1 },
      { hour: EARLIER, path: '/signin-prompt/committed-challenge', visitor: 'returning', count: 1 },
      { hour: YESTERDAY, path: '/signin-prompt/streak', visitor: 'returning', count: 6 }, // an ask, but not a flight 3 ask path
    ])

  it('the daily "Tagged so far" line prints cumulative and yesterday counts for all three', async () => {
    const line = await dailyLine(fx())
    // ask rows: fixture placement 3 + committed-repeat 1 + committed-challenge 1 = 5 (yesterday 1; streak 6 not counted)
    expect(line).toContain(
      'tracking-check counts (tagged ET-day totals; yesterday in brackets): complete rows 7 (2), sign-in ask rows (placement, committed-repeat, committed-challenge) 5 (1), /coach/shown/place rows 7 (3)',
    )
  })
  it('the threshold / post-flight tagged-funnel block prints the same counts', async () => {
    const line = await blockLine(fx())
    expect(line).toContain('complete rows 7, sign-in ask rows (placement, committed-repeat, committed-challenge) 5, /coach/shown/place rows 7')
  })
  it('zero rows print 0, never a dash (the check needs a real zero)', async () => {
    const f = base() // the fixture has no complete or coach rows at all
    const line = await dailyLine(f)
    expect(line).toContain('complete rows 0 (0)')
    expect(line).toContain('/coach/shown/place rows 0 (0)')
    expect(line).not.toMatch(/\/coach\/shown\/place rows —/)
    expect(line).not.toMatch(/complete rows —/)
    const block = await blockLine(f)
    expect(block).toContain('/coach/shown/place rows 0')
    expect(block).not.toContain('—')
  })
  it('a zero ask count with coach rows present reads 0 beside the coach count', async () => {
    const f = rows([{ hour: YESTERDAY, path: '/coach/shown/place', visitor: 'new', count: 31 }])
    beaconOf(f).tagged = beaconOf(f).tagged.filter((t) => t.path !== '/signin-prompt/placement')
    const line = await dailyLine(f)
    expect(line).toContain('sign-in ask rows (placement, committed-repeat, committed-challenge) 0 (0), /coach/shown/place rows 31 (31)')
  })
  it('the printed counts are ET-day totals: no hour, country or device split on the line', async () => {
    const line = await dailyLine(fx())
    expect(line).not.toMatch(/\d{2}:\d{2}|T\d{2}|by hour|by country|device/i)
  })
})

describe('summarizeTaggedRows: flight3Asks and coachShownPlace', () => {
  const H = 3_600_000
  const r = (path: string, count: number, hourStartMs = 100 * H, visitor = 'returning'): TaggedRow => ({ hourStartMs, path, visitor, count })
  it('counts only the three flight 3 ask paths and the exact place tip', () => {
    const s = summarizeTaggedRows([
      r('/signin-prompt/placement', 2),
      r('/signin-prompt/committed-repeat', 3),
      r('/signin-prompt/committed-challenge', 4),
      r('/signin-prompt/streak', 50),
      r('/signin-prompt/tutorial', 60),
      r('/promo-first50/shown', 70),
      r('/coach/shown/place', 5),
      r('/coach/shown/wheel', 80),
      r('/coach/shown/place/extra', 90),
      r('/COACH/Shown/Place', 100),
      r('/ab/ask-order/x/coach/shown/place', 110),
    ])
    expect(s.flight3Asks).toBe(9)
    expect(s.coachShownPlace).toBe(5)
  })
  it('an empty window is a real zero, and the window narrows both counts', () => {
    expect(summarizeTaggedRows([])).toMatchObject({ flight3Asks: 0, coachShownPlace: 0 })
    const rowsIn = [r('/coach/shown/place', 5, 10 * H), r('/coach/shown/place', 2, 40 * H)]
    expect(summarizeTaggedRows(rowsIn, { fromMs: 30 * H, toMs: 50 * H }).coachShownPlace).toBe(2)
    expect(summarizeTaggedRows(rowsIn, { fromMs: 60 * H, toMs: 70 * H }).coachShownPlace).toBe(0)
  })
})
