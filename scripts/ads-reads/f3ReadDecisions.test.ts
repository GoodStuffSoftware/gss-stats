// read.ts wiring for flight 3: the cap decision uses the F3 table (F2 keeps decideAt100), and the
// F3 PROPOSE PAUSE push fires at most once per ET day per arm and never for an F2 arm.
// Synthetic fixture rows only: no network, no credentials.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fixtureDeps, type Fixture } from './cli'
import { morningPushText, runMorningRead, type MorningOptions } from './read'
import { formatMorningReport } from './report'
import { MIN_COHORT } from '../../src/lib/popupEvents'

const here = path.dirname(fileURLToPath(import.meta.url))
const F3_SEARCH = '24358792551'
const F2_SEARCH = '24311309184'
const optsFor = (campaignId: string): MorningOptions => ({ campaignId, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 })
type Tagged = Extract<Fixture['beacon'], { tagged: unknown }>['tagged']

/** F3 Search, flight day 3 (2026-10-19): closed days 10-17 and 10-18 at `perDay` dollars each. */
function f3Fixture(perDay: number, tagged: Tagged): Fixture {
  const micros = perDay * 1_000_000
  return {
    now: '2026-10-19T12:05:00Z',
    ads: {
      status: { id: F3_SEARCH, name: 'fixture F3 Search', status: 'ENABLED', servingStatus: 'SERVING', primaryStatus: 'ELIGIBLE', dailyBudget: 10 },
      daily: {
        '2026-10-17': { costMicros: micros, impressions: 400, clicks: 9 },
        '2026-10-18': { costMicros: micros, impressions: 500, clicks: 11 },
        '2026-10-19': { costMicros: 0, impressions: 0, clicks: 0 },
      },
      placements: [],
    },
    beacon: { tagged, siteEvents: [], returns: [], returnSites: [] },
    store: {},
  }
}
const arrivals: Tagged = [{ hour: '2026-10-17T17:00:00Z', path: '/', visitor: 'new', count: 40 }]
/** `asks` flight 3 ask rows, `completes` complete rows, `newAccounts` tagged new-account sign-ups. */
const rows = (asks: number, completes: number, newAccounts: number): Tagged => [
  ...arrivals,
  ...(completes ? [{ hour: '2026-10-18T18:00:00Z', path: '/game/complete/normal/easy', visitor: 'new' as const, count: completes }] : []),
  ...(asks ? [{ hour: '2026-10-18T19:00:00Z', path: '/signin-prompt/placement', visitor: 'new' as const, count: asks }] : []),
  ...(newAccounts ? [{ hour: '2026-10-18T20:00:00Z', path: '/auth/success/google/new', visitor: 'new' as const, count: newAccounts }] : []),
]

describe('the cap decision row (threshold read at the hard cap)', () => {
  // $110 a day x 2 = $220, over the $210 F3 Search cap (extended 10-23 and 10-26), so the read is a threshold read with the decision table printed.
  it.each([
    [25, 6, 'f3-go', 'GO'],
    [25, 3, 'f3-iterate', 'ITERATE'],
    [25, 1, 'f3-stop', 'STOP'],
    [19, 9, 'f3-inconclusive', 'INCONCLUSIVE'],
  ])('F3 with %i asks and %i new accounts reads %s', async (asks, accounts, row, word) => {
    const deps = fixtureDeps(f3Fixture(110, rows(asks, 14, accounts)), true)
    const r = await runMorningRead(deps, optsFor(F3_SEARCH))
    expect(r.thresholdRead!.decision!.row).toBe(row)
    expect(formatMorningReport(r)).toContain('Decision (flight 3 table, spec section 2): row ' + row)
    expect(formatMorningReport(r)).not.toContain('Decision table (spec section 13)')
    expect(r.notify.push).toBe(true)
    expect(r.notify.text).toContain(`F3 verdict ${word}`)
    expect(r.notify.text).not.toContain('row f3-')
    expect(morningPushText(r)).toBe(r.notify.text)
  })
  it('a flight 2 arm at its cap still uses the F2 table (decideAt100), never an f3- row', async () => {
    let raw = fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8')
    raw = raw.replace(/2026-09-(\d\d)/g, (_m, dd: string) => {
      const n = Number(dd) + 8
      return n > 30 ? `2026-10-${String(n - 30).padStart(2, '0')}` : `2026-09-${String(n).padStart(2, '0')}`
    })
    const fx = JSON.parse(raw.split('24279250691').join(F2_SEARCH).split('sudoku_funnel_retest').join('sudoku_funnel_f2_search')) as Fixture
    for (const d of Object.values((fx.ads as Extract<Fixture['ads'], { daily: unknown }>).daily)) d.costMicros *= 3
    const r = await runMorningRead(fixtureDeps(fx, true), optsFor(F2_SEARCH))
    const decision = r.thresholdRead!.decision!
    expect(decision.row.startsWith('f3-')).toBe(false)
    expect(formatMorningReport(r)).toContain('Decision table (spec section 13): row ' + decision.row)
    expect(r.notify.text).toContain(`row ${decision.row}`)
    expect(r.notify.text).not.toContain('F3 verdict')
    expect(r.flight3).toBeUndefined()
    expect('flight3' in r).toBe(false)
  })
})

describe('the F3 PROPOSE PAUSE push', () => {
  // Day 3, $17 spent, 0 complete rows: rule 6 (cost per complete row, 0 rows over $3) proposes a pause.
  const pausing = () => f3Fixture(8.5, rows(3, 0, 0))

  it('pushes on the first read of an ET day, naming the rule', async () => {
    const r = await runMorningRead(fixtureDeps(pausing(), false), optsFor(F3_SEARCH))
    expect(r.flight3!.proposal).toBe('PROPOSE PAUSE')
    expect(r.flight3!.tripped).toContain(6)
    expect(r.notify.push).toBe(true)
    expect(r.notify.text).toContain('F3 rules PROPOSE PAUSE')
    expect(r.notify.text).toContain('rule 6 cost per complete row')
  })
  it('a second read the same ET day on the same store does not push again', async () => {
    const deps = fixtureDeps(pausing(), false)
    const first = await runMorningRead(deps, optsFor(F3_SEARCH))
    expect(first.notify.push).toBe(true)
    const again = await runMorningRead({ ...deps, nowMs: deps.nowMs + 60_000 }, optsFor(F3_SEARCH))
    expect(again.flight3!.proposal).toBe('PROPOSE PAUSE') // still shown in the report
    expect(again.notify.push).toBe(false)
    expect(again.notify.text).toBeNull()
    expect(again.dedup.skipped.map((s) => s.kind)).toContain('daily')
    expect(deps.store.written.readings.filter((x) => x.kind === 'daily')).toHaveLength(1)
  })
  it('the next ET day pushes once more while the proposal stands, for the same arm', async () => {
    const deps = fixtureDeps(pausing(), false)
    await runMorningRead(deps, optsFor(F3_SEARCH))
    const next = await runMorningRead({ ...deps, nowMs: deps.nowMs + 86_400_000 }, optsFor(F3_SEARCH))
    expect(next.flight3!.proposal).toBe('PROPOSE PAUSE')
    expect(next.notify.push).toBe(true)
    expect(deps.store.written.readings.filter((x) => x.kind === 'daily').map((x) => x.etDate)).toEqual(['2026-10-19', '2026-10-20'])
  })
  it('no push when no rule is tripped (continue)', async () => {
    const r = await runMorningRead(fixtureDeps(f3Fixture(8.5, rows(3, 14, 0)), false), optsFor(F3_SEARCH))
    expect(r.flight3!.proposal).toBe('CONTINUE')
    expect(r.notify.push).toBe(false)
  })
  it('never for a flight 2 arm, whatever the tagged rows and spend say', async () => {
    let raw = fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8')
    raw = raw.replace(/2026-09-(\d\d)/g, (_m, dd: string) => {
      const n = Number(dd) + 8
      return n > 30 ? `2026-10-${String(n - 30).padStart(2, '0')}` : `2026-09-${String(n).padStart(2, '0')}`
    })
    const fx = JSON.parse(raw.split('24279250691').join(F2_SEARCH).split('sudoku_funnel_retest').join('sudoku_funnel_f2_search')) as Fixture
    for (const d of Object.values((fx.ads as Extract<Fixture['ads'], { daily: unknown }>).daily)) d.costMicros = Math.round(d.costMicros * 0.1)
    // $5 spent and 0 complete rows would trip F3's rule 6; an F2 arm has no such rule.
    const r = await runMorningRead(fixtureDeps(fx, false), optsFor(F2_SEARCH))
    expect(r.flight3).toBeUndefined()
    expect(r.notify.push).toBe(false)
    expect(r.notify.text).toBeNull()
    expect(formatMorningReport(r)).not.toContain('F3 rules')
  })
})
