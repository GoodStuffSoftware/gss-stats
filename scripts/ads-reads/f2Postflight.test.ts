// Flight 2's post-flight RETURN reads: the same `ads:postflight-read` stages as flight 1, keyed
// to each arm's own flight end (2026-10-10) and its own funnel tag from campaigns.ts. wrapup
// (2026-10-17) is the day-2-to-7 read and day15 (2026-10-25) the day-8-to-14 read. Flight 1's
// own stage dates are pinned here too so a change to the schedule can't move either quietly.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fixtureDeps, type Fixture } from './cli'
import { runPostflightRead } from './read'
import { formatPostflightReport } from './report'
import { postflightDueDate } from '../../src/lib/adsRules'
import { campaignById } from '../../src/lib/campaigns'

const here = path.dirname(fileURLToPath(import.meta.url))
const RETEST = '24279250691'
const ARMS = [
  { id: '24311309184', uc: 'sudoku_funnel_f2_search', label: 'F2 search' },
  { id: '24316608605', uc: 'sudoku_funnel_f2_apps', label: 'F2 apps' },
] as const

/** The retest fixture re-pointed at an F2 arm: its id and funnel tag, with d1, d2-7 and d8-14 rows. */
function armFixture(arm: (typeof ARMS)[number], now: string): Fixture {
  const raw = fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8')
  const fx = JSON.parse(raw.split(RETEST).join(arm.id).split('sudoku_funnel_retest').join(arm.uc)) as Fixture
  fx.now = now
  const b = fx.beacon as Extract<Fixture['beacon'], { returns: unknown }>
  b.returns = [
    { site: 'bestsudoku-web', path: `/return/${arm.uc}/d0`, count: 40 },
    { site: 'bestsudoku-web', path: `/return/${arm.uc}/d1`, count: 4 },
    { site: 'bestsudoku-web', path: `/return/${arm.uc}/d2-7`, count: 3 },
    { site: 'bestsudoku-web', path: `/return/${arm.uc}/d8-14`, count: 2 },
    { site: 'bestsudoku-web', path: '/return/sudoku_funnel_retest/d0', count: 99 },
  ]
  return fx
}

describe('stage dates', () => {
  it('flight 1 is unchanged (end 2026-10-02)', () => {
    expect(['wrapup', 'day15', 'day30', 'day60', 'december'].map((s) => postflightDueDate(s as never, campaignById(RETEST)!.flightEnd))).toEqual(['2026-10-09', '2026-10-17', '2026-11-01', '2026-12-01', '2026-12-03'])
  })
  it.each(ARMS)('$label: wrapup 2026-10-17 (day 2-7 returns), day15 2026-10-25 (day 8-14 returns)', (arm) => {
    const end = campaignById(arm.id)!.flightEnd
    expect(end).toBe('2026-10-10')
    expect(postflightDueDate('wrapup', end)).toBe('2026-10-17')
    expect(postflightDueDate('day15', end)).toBe('2026-10-25')
  })
})

describe.each(ARMS)('$label post-flight return reads', (arm) => {
  it('wrapup on 2026-10-17: due, reads this arm only, d2-7 present', async () => {
    const deps = fixtureDeps(armFixture(arm, '2026-10-17T12:40:00Z'), true)
    const r = await runPostflightRead(deps, { campaignId: arm.id, stage: 'wrapup', force: false })
    expect(r.campaign.id).toBe(arm.id)
    expect(r.dueEt).toBe('2026-10-17')
    expect(r.due).toBe(true)
    expect(r.read!.returns!.web).toMatchObject({ d0: 40, d1: 4, 'd2-7': 3, 'd8-14': 2 })
    const text = formatPostflightReport(r)
    expect(text).toContain('d2-7')
    expect(text).not.toContain('99')
  })
  it('wrapup the day before is not due and records nothing', async () => {
    const deps = fixtureDeps(armFixture(arm, '2026-10-16T12:40:00Z'), false)
    const r = await runPostflightRead(deps, { campaignId: arm.id, stage: 'wrapup', force: false })
    expect(r.due).toBe(false)
    expect(r.read).toBeNull()
    expect(deps.store.written.readings).toEqual([])
  })
  it('day15 on 2026-10-25: due, d8-14 present; the day before it is not due', async () => {
    const r = await runPostflightRead(fixtureDeps(armFixture(arm, '2026-10-25T12:40:00Z'), true), { campaignId: arm.id, stage: 'day15', force: false })
    expect(r.dueEt).toBe('2026-10-25')
    expect(r.due).toBe(true)
    expect(r.read!.returns!.web['d8-14']).toBe(2)
    expect(formatPostflightReport(r)).toContain('d8-14')
    const early = await runPostflightRead(fixtureDeps(armFixture(arm, '2026-10-24T12:40:00Z'), true), { campaignId: arm.id, stage: 'day15', force: false })
    expect(early.due).toBe(false)
  })
})
