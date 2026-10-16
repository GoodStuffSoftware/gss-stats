// Flight 2 and retest report output is byte-identical to what origin/main printed BEFORE the flight 3
// rule readouts landed. fixtures/f2-report-golden.json holds the report text and the result JSON for
// the retest and both flight 2 arms (morning reads at three spend levels, post-flight wrapup and
// day15), generated on the pre-F3 code from synthetic rows only (threshold-50.json re-pointed).
// To regenerate (only when F2 output is MEANT to change): F2_GOLDEN_WRITE=1 npx vitest run <this file>.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fixtureDeps, type Fixture } from './cli'
import { runMorningRead, runPostflightRead, type MorningOptions } from './read'
import { formatMorningReport, formatPostflightReport } from './report'
import { MIN_COHORT } from '../../src/lib/popupEvents'

const here = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN = path.join(here, 'fixtures', 'f2-report-golden.json')
const RETEST = '24279250691'
const ARMS = [
  { id: RETEST, uc: 'sudoku_funnel_retest', label: 'retest' },
  { id: '24311309184', uc: 'sudoku_funnel_f2_search', label: 'f2-search' },
  { id: '24316608605', uc: 'sudoku_funnel_f2_apps', label: 'f2-apps' },
] as const
type Arm = (typeof ARMS)[number]

/** The synthetic threshold-50 fixture re-pointed at an arm: its id and funnel tag, plus return rows. */
function armFixture(arm: Arm, now?: string): Fixture {
  let raw = fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8')
  // The F2 arms ran 2026-10-04 .. 10-10, the fixture's 2026-09-26 .. 09-30 days land on 10-04 .. 10-08.
  if (arm.id !== RETEST) {
    raw = raw.replace(/2026-09-(\d\d)/g, (_m, dd: string) => {
      const n = Number(dd) + 8
      return n > 30 ? `2026-10-${String(n - 30).padStart(2, '0')}` : `2026-09-${String(n).padStart(2, '0')}`
    })
  }
  const fx = JSON.parse(raw.split(RETEST).join(arm.id).split('sudoku_funnel_retest').join(arm.uc)) as Fixture
  if (now) fx.now = now
  const b = fx.beacon as Extract<Fixture['beacon'], { returns: unknown }>
  b.returns = [
    { site: 'bestsudoku-web', path: `/return/${arm.uc}/d0`, count: 40 },
    { site: 'bestsudoku-web', path: `/return/${arm.uc}/d1`, count: 4 },
    { site: 'bestsudoku-web', path: `/return/${arm.uc}/d2-7`, count: 3 },
    { site: 'bestsudoku-web', path: `/return/${arm.uc}/d8-14`, count: 2 },
  ]
  return fx
}

const scaleSpend = (fx: Fixture, factor: number): Fixture => {
  const ads = fx.ads as Extract<Fixture['ads'], { daily: unknown }>
  for (const d of Object.values(ads.daily)) d.costMicros = Math.round(d.costMicros * factor)
  return fx
}

const opts = (arm: Arm): MorningOptions => ({ campaignId: arm.id, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 })

async function scenarios(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const arm of ARMS) {
    const levels: [string, number][] = [['threshold', 1], ['low', 0.1], ['over-cap', 3]]
    for (const [name, factor] of levels) {
      const fx = scaleSpend(armFixture(arm), factor)
      const r = await runMorningRead(fixtureDeps(fx, true), opts(arm))
      out[`${arm.label}/morning-${name}/text`] = formatMorningReport(r)
      out[`${arm.label}/morning-${name}/json`] = JSON.stringify(r)
    }
    for (const [stage, now] of [['wrapup', '2026-10-17T12:40:00Z'], ['day15', '2026-10-25T12:40:00Z']] as const) {
      const r = await runPostflightRead(fixtureDeps(armFixture(arm, now), true), { campaignId: arm.id, stage, force: false })
      out[`${arm.label}/postflight-${stage}/text`] = formatPostflightReport(r)
      out[`${arm.label}/postflight-${stage}/json`] = JSON.stringify(r)
    }
  }
  return out
}

describe('flight 2 and retest report output is unchanged by the flight 3 rule readouts', () => {
  it('reproduces the pre-F3 golden text and result JSON exactly', async () => {
    const got = await scenarios()
    if (process.env.F2_GOLDEN_WRITE) {
      fs.writeFileSync(process.env.F2_GOLDEN_WRITE === '1' ? GOLDEN : process.env.F2_GOLDEN_WRITE, JSON.stringify(got, null, 1) + '\n')
      return
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, string>
    expect(Object.keys(got)).toEqual(Object.keys(golden))
    for (const k of Object.keys(golden)) expect(got[k], k).toBe(golden[k])
  })
  it('the F2 and retest text carries no flight 3 wording', async () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, string>
    for (const [k, v] of Object.entries(golden)) if (k.endsWith('/text')) expect(v, k).not.toMatch(/F3 rules|cost per complete row|flight 3 table/)
  })
})
