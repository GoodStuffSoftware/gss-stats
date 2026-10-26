// Flight 3 Search and Apps through the real registry (dates read from STAGED_FLIGHT_3_DATES, so a date slip
// never turns this red): the day 1-2 tracking-check line, the flight-end read, the derived post-flight stage
// dates, and the Apps-only Play-install caveat. The synthetic retest fixture is re-pointed at each arm and its
// dates shifted onto the arm's own flight; no network, no credentials.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { fixtureDeps, type Fixture } from './cli'
import { runMorningRead, runPostflightRead } from './read'
import { APPS_PAUSED_NOTE, APPS_PLAY_CREDIT_NOTE, APPS_PLAY_RELEASE_CAVEAT, formatMorningReport, formatPostflightReport } from './report'
import { MIN_COHORT } from '../../src/lib/popupEvents'
import { ADS_READ_PLANS, postflightDueDate, type ReadingRecord } from '../../src/lib/adsRules'
import { campaignById, STAGED_FLIGHT_3_DATES } from '../../src/lib/campaigns'

const here = path.dirname(fileURLToPath(import.meta.url))
const RETEST = '24279250691'
const RETEST_FIRST_DAY = '2026-09-26'
const ARMS = [
  { arm: 'apps', id: '24358792494', uc: 'sudoku_funnel_f3_apps', label: 'F3 apps', caveat: true },
  { arm: 'search', id: '24358792551', uc: 'sudoku_funnel_f3_search', label: 'F3 search', caveat: false },
] as const
type Arm = (typeof ARMS)[number]

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10)
const startOf = (a: Arm) => STAGED_FLIGHT_3_DATES[a.arm].flightStart!
const endOf = (a: Arm) => STAGED_FLIGHT_3_DATES[a.arm].flightEnd!

/** The retest fixture moved onto the arm's flight (every 09-26 .. 10-03 date shifted) and re-pointed at the arm's id and tag. */
function armFixture(a: Arm, nowEt: string): Fixture {
  const shiftDays = Math.round((Date.parse(startOf(a) + 'T00:00:00Z') - Date.parse(RETEST_FIRST_DAY + 'T00:00:00Z')) / 86_400_000)
  const raw = fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8')
  const shifted = raw.replace(/2026-(09|10)-(\d\d)/g, (_m, mo, d) => addDays(`2026-${mo}-${d}`, shiftDays))
  const fx = JSON.parse(shifted.split(RETEST).join(a.id).split('sudoku_funnel_retest').join(a.uc)) as Fixture
  fx.now = `${nowEt}T12:05:00Z`
  return fx
}
const morning = async (a: Arm, nowEt: string) =>
  formatMorningReport(await runMorningRead(fixtureDeps(armFixture(a, nowEt), true), { campaignId: a.id, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 }))
const postflight = async (a: Arm, nowEt: string, stage: 'wrapup' | 'day15') => runPostflightRead(fixtureDeps(armFixture(a, nowEt), true), { campaignId: a.id, stage, force: false })
const TRACKING =
  /Tagged so far: .*tracking-check counts \(tagged ET-day totals; yesterday in brackets\): complete rows \d+ \(\d+\), sign-in ask rows \(placement, committed-repeat, committed-challenge\) \d+ \(\d+\), \/coach\/shown\/place rows \d+ \(\d+\)/

it('Apps Play (24369758153, a five-day flight) never labels rule 9 interim, on any read day', async () => {
  const play = { arm: 'appsPlay', id: '24369758153', uc: 'sudoku_funnel_f3_apps_play', label: 'F3 apps play', caveat: false } as unknown as Arm
  const s = startOf(play)
  for (let d = 1; d <= 6; d++) {
    const report = await morning(play, addDays(s, d))
    expect(report, addDays(s, d)).not.toContain('interim, week 2 running')
  }
})

describe.each(ARMS)('$label', (a) => {
  it('is live in the registry with a seven-day week (Search: three weeks) and the read window start + 1 .. end + 1', () => {
    expect(campaignById(a.id)).toBeTruthy()
    expect(endOf(a)).toBe(addDays(startOf(a), a.arm === 'search' ? 20 : 6)) // Search was extended a week on 10-23 and again on 10-26
    expect(ADS_READ_PLANS[a.id].morningReadFirstEt).toBe(addDays(startOf(a), 1))
    expect(ADS_READ_PLANS[a.id].morningReadLastEt).toBe(addDays(endOf(a), 1))
  })
  it('the morning read stores its F3 rules block on the daily reading only (ads_readings.f3), as the report prints it', async () => {
    const day = addDays(startOf(a), 3)
    const deps = fixtureDeps(armFixture(a, day), false)
    // What the read hands the store (the memory store's own de-dup is not under test here).
    const append = vi.spyOn(deps.store, 'appendReadings')
    const result = await runMorningRead(deps, { campaignId: a.id, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 })
    const block = result.flight3!
    const written = append.mock.calls.flatMap((c) => c[0] as ReadingRecord[])
    const daily = written.find((r) => r.kind === 'daily')!
    expect(daily.f3).toEqual({ v: 1, arm: a.arm, flightDay: block.flightDay, readouts: block.readouts.map(({ n, name, number, threshold, verdict }) => ({ n, name, number, threshold, verdict })), proposal: block.proposal })
    expect(daily.f3!.readouts.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    // The stored proposal agrees with the row's own column.
    expect(daily.proposal === 'PROPOSE PAUSE').toBe(daily.f3!.proposal === 'PROPOSE PAUSE' || daily.rules?.[0]?.status === 'trip')
    for (const r of written.filter((x) => x.kind !== 'daily')) expect(r).not.toHaveProperty('f3')
  })
  it.each([1, 2])('day %i morning read prints the tracking-check counts line', async (day) => {
    const report = await morning(a, addDays(startOf(a), day))
    expect(report).toContain(`morning read, ${addDays(startOf(a), day)} 08:05 ET`)
    expect(report).toMatch(TRACKING)
    expect(report).toContain('Errors: none')
  })
  it('the read on flight end + 1 (D+7, the last window day) closes the spend at the flight end and still prints the tracking line', async () => {
    const day = addDays(endOf(a), 1)
    const report = await morning(a, day)
    expect(report).toContain(`morning read, ${day} ${day >= '2026-11-01' ? '07' : '08'}:05 ET`) // the fixture clock is 12:05Z: 08:05 EDT, 07:05 once EST starts on 11-01
    expect(report).toContain(`closed days through ${endOf(a)}`)
    expect(report).toMatch(TRACKING)
    expect(report).toContain('Errors: none')
  })
  it.runIf(a.arm === 'search')('--window-end pins the week-1 read: on 10-24 the window closes at 2026-10-23 although the registry end is 2026-11-06', async () => {
    const fx = armFixture(a, '2026-10-24')
    const run = (windowEndEt?: string) =>
      runMorningRead(fixtureDeps(fx, true), { campaignId: a.id, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24, ...(windowEndEt ? { windowEndEt } : {}) })
    const pinned = formatMorningReport(await run('2026-10-23'))
    expect(pinned).toContain('closed days through 2026-10-23')
    expect(pinned).toContain('Errors: none')
    expect(pinned).not.toContain('not due')
    await expect(run('2026-11-07')).rejects.toThrow(/--window-end must be/)
  })
  describe('rule 9 label', () => {
    const rule9 = (report: string) => report.split(/\r?\n/).find((l) => l.startsWith('Rule 9 · '))!
    const INTERIM = /^Rule 9 · D\+7 verdict \(interim, week 2 running; final on (\d\d-\d\d)\)/
    it('names rule 9 interim on every unpinned daily of an extended flight from day 8 up to the flight end, with the final read on end + 1; the final read and a pin are plain', async () => {
      const extended = endOf(a) > addDays(startOf(a), 6)
      const finalEt = addDays(endOf(a), 1)
      if (a.arm === 'search') expect(finalEt).toBe('2026-11-07') // Search's final read is 11-07 (end 11-06 + 1), shown as "final on 11-07"
      for (let d = 1; d <= 22; d++) {
        const day = addDays(startOf(a), d)
        const inWindow = day <= finalEt
        if (!inWindow) continue
        const line = rule9(await morning(a, day))
        if (extended && d >= 7 && day <= endOf(a)) {
          expect(line, day).toMatch(INTERIM)
          expect(line.match(INTERIM)![1], day).toBe(finalEt.slice(5))
        } else expect(line, day).toMatch(/^Rule 9 · D\+7 verdict: /)
      }
    })
    it.runIf(a.arm === 'search')('a read pinned at the week-1 end prints the plain, unlabelled rule 9', async () => {
      const fx = armFixture(a, '2026-10-24')
      const pinned = formatMorningReport(await runMorningRead(fixtureDeps(fx, true), { campaignId: a.id, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24, windowEndEt: '2026-10-23' }))
      expect(rule9(pinned)).toMatch(/^Rule 9 · D\+7 verdict: \d+ new accounts \(/)
      expect(pinned).not.toContain('interim, week 2 running')
    })
  })
  it('a read one day past the window still reads the flight only (spend stays closed at the flight end, no error)', async () => {
    const report = await morning(a, addDays(endOf(a), 2))
    expect(report).toContain(`closed days through ${endOf(a)}`)
    expect(report).toContain('Errors: none')
  })
  it('post-flight stages derive from the flight end: wrapup end + 7, day15 end + 15; due on that day, not the day before', async () => {
    expect(postflightDueDate('wrapup', endOf(a))).toBe(addDays(endOf(a), 7))
    expect(postflightDueDate('day15', endOf(a))).toBe(addDays(endOf(a), 15))
    for (const [stage, offset] of [['wrapup', 7], ['day15', 15]] as const) {
      const due = addDays(endOf(a), offset)
      const on = await postflight(a, due, stage)
      expect(on.dueEt).toBe(due)
      expect(on.due).toBe(true)
      expect((await postflight(a, addDays(due, -1), stage)).due).toBe(false)
    }
  })
  it('does not print the Apps Play-install caveat: a flight 3 reading starts at 12:00 ET 10-17, after v1.99.3 went public on Play (06:34:32Z)', async () => {
    for (const day of [addDays(startOf(a), 1), addDays(endOf(a), 1)]) {
      const report = await morning(a, day)
      expect(report).not.toContain(APPS_PLAY_RELEASE_CAVEAT)
      expect(report).not.toMatch(/Read caveat|until the Play release/)
    }
    expect(formatPostflightReport(await postflight(a, addDays(endOf(a), 7), 'wrapup'))).not.toMatch(/Read caveat|until the Play release/)
  })
  it(`${a.caveat ? 'prints' : 'does not print'} the standing Play-credit note on every ${a.label} read, after the cut`, async () => {
    const reads = [await morning(a, addDays(startOf(a), 1)), await morning(a, addDays(endOf(a), 1)), formatPostflightReport(await postflight(a, addDays(endOf(a), 7), 'wrapup'))]
    for (const report of reads) {
      if (a.caveat) expect(report).toContain(APPS_PLAY_CREDIT_NOTE)
      else expect(report).not.toContain('Play installs credited')
      if (a.caveat) expect(report).toContain(APPS_PAUSED_NOTE)
      else expect(report).not.toContain('Paused 10-19')
    }
  })
})
