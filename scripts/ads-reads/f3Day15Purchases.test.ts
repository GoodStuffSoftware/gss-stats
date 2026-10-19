// The flight 3 day15 post-flight read leaves the /funnel/purchase/* rows out of its P1 "paid funnel (rows)"
// parts: the gss-ads-f3-purchases-d21 read owns purchase counts that morning. Everything else is unchanged:
// the flight 3 wrapup read, the retest day15 read and flight 2 still print them (f2ReportGolden.test.ts pins
// flight 2 byte-identical). Synthetic rows only: no network, no credentials.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fixtureDeps, type Fixture } from './cli'
import { runPostflightRead } from './read'
import { formatPostflightReport } from './report'
import { P1_PURCHASES_OMITTED_NOTE, emptyP1Counts, p1Line } from '../../src/lib/adsRules'
import { STAGED_FLIGHT_3_DATES } from '../../src/lib/campaigns'

const here = path.dirname(fileURLToPath(import.meta.url))
const RETEST = '24279250691'
const RETEST_FIRST_DAY = '2026-09-26'
const F3 = [
  { arm: 'apps', id: '24358792494', uc: 'sudoku_funnel_f3_apps' },
  { arm: 'search', id: '24358792551', uc: 'sudoku_funnel_f3_search' },
] as const

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)

/** The retest fixture shifted onto an arm's flight (or left on the retest's own dates when `arm` is null). */
function fixtureFor(arm: (typeof F3)[number] | null, nowEt: string): Fixture {
  const raw = fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8')
  if (!arm) {
    const fx = JSON.parse(raw) as Fixture
    fx.now = `${nowEt}T12:05:00Z`
    return fx
  }
  const shiftDays = Math.round((Date.parse(STAGED_FLIGHT_3_DATES[arm.arm].flightStart! + 'T00:00:00Z') - Date.parse(RETEST_FIRST_DAY + 'T00:00:00Z')) / 86_400_000)
  const shifted = raw.replace(/2026-(09|10)-(\d\d)/g, (_m, mo, d) => addDays(`2026-${mo}-${d}`, shiftDays))
  const fx = JSON.parse(shifted.split(RETEST).join(arm.id).split('sudoku_funnel_retest').join(arm.uc)) as Fixture
  fx.now = `${nowEt}T12:05:00Z`
  return fx
}

/** Runs a post-flight read, plants purchase and checkout rows on both P1 sections, prints the report. */
async function report(arm: (typeof F3)[number] | null, stage: 'wrapup' | 'day15', nowEt: string): Promise<string> {
  const id = arm ? arm.id : RETEST
  const r = await runPostflightRead(fixtureDeps(fixtureFor(arm, nowEt), true), { campaignId: id, stage, force: true })
  expect(r.read).toBeTruthy()
  for (const section of [r.read!.tagged?.summary, r.read!.site?.summary]) {
    expect(section).toBeTruthy()
    section!.p1.funnel.purchase = { web: 3, play: 2 }
    section!.p1.funnel['checkout-start'] = { web: 5 }
  }
  return formatPostflightReport(r)
}

describe('p1Line omitPurchases', () => {
  const counts = () => {
    const c = emptyP1Counts()
    c.funnel['trial-start'] = 4
    c.funnel['checkout-start'] = { web: 5 }
    c.funnel.purchase = { web: 3, play: 2 }
    return c
  }
  it('default: purchase rows are printed, exactly as before', () => {
    expect(p1Line(counts())).toBe('paid funnel (rows): trial-start 4, checkout-start/web 5, purchase/web 3, purchase/play 2 [provisional beacon names]')
    expect(p1Line(counts(), {})).toBe(p1Line(counts()))
    expect(p1Line(counts(), { omitPurchases: false })).toBe(p1Line(counts()))
  })
  it('omitPurchases: trial-start and checkout-start stay, the purchase rows go, a note says so', () => {
    expect(p1Line(counts(), { omitPurchases: true })).toBe(`paid funnel (rows): trial-start 4, checkout-start/web 5; ${P1_PURCHASES_OMITTED_NOTE} [provisional beacon names]`)
  })
  it('omitPurchases with no purchase rows: identical to the default (no note)', () => {
    const c = counts()
    c.funnel.purchase = {}
    expect(p1Line(c, { omitPurchases: true })).toBe(p1Line(c))
    c.funnel.purchase = { web: 0 }
    expect(p1Line(c, { omitPurchases: true })).toBe('paid funnel (rows): trial-start 4, checkout-start/web 5 [provisional beacon names]')
  })
  it('only purchase rows: the line is just the note', () => {
    const c = emptyP1Counts()
    c.funnel.purchase = { web: 1 }
    expect(p1Line(c, { omitPurchases: true })).toBe(`${P1_PURCHASES_OMITTED_NOTE} [provisional beacon names]`)
  })
})

describe.each(F3)('flight 3 $arm', (a) => {
  const end = STAGED_FLIGHT_3_DATES[a.arm].flightEnd!
  it('the day15 read prints no purchase counts, keeps checkout-start, and points at the purchases read', async () => {
    const text = await report(a, 'day15', addDays(end, 15))
    expect(text).toContain('post-flight day15 read')
    expect(text).not.toMatch(/purchase\/(web|play)/)
    expect(text).toContain('checkout-start/web 5')
    expect(text).toContain(P1_PURCHASES_OMITTED_NOTE)
    expect(text).toMatch(/tagged P1 beacons: .*checkout-start\/web 5/)
    expect(text).toMatch(/site-wide P1 beacons: .*checkout-start\/web 5/)
  })
  it('the wrapup read still prints them (the purchases read is not on that date)', async () => {
    const text = await report(a, 'wrapup', addDays(end, 7))
    expect(text).toContain('purchase/web 3, purchase/play 2')
    expect(text).not.toContain(P1_PURCHASES_OMITTED_NOTE)
  })
})

describe('not flight 3', () => {
  it('the retest day15 read still prints the purchase rows', async () => {
    const text = await report(null, 'day15', '2026-10-18')
    expect(text).toContain('post-flight day15 read')
    expect(text).toContain('purchase/web 3, purchase/play 2')
    expect(text).not.toContain(P1_PURCHASES_OMITTED_NOTE)
  })
})
