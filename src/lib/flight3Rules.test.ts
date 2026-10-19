// Flight 3's rule readouts (src/lib/flight3Rules.ts): every rule's PASS / PROPOSE PAUSE / NOT YET /
// NO DATA state at flight days 1, 2, 3 and 8 for both arms, the go / iterate / stop table, and the
// numbered line shape. Pure functions of made-up counts: no network, no credentials.
import { describe, expect, it } from 'vitest'
import type { RuleResult } from './adsRules'
import {
  buildFlight3Rules,
  costPerCompleteRow,
  decideFlight3,
  F3_VALIDITY_ASKS,
  flight3VerdictWord,
  flightDayOf,
  killRuleReadout,
  ruleReadoutLine,
  type Flight3RulesInput,
  type ReadoutVerdict,
  type RuleReadout,
} from './flight3Rules'
import type { StagedArm } from './campaigns'

const DAYS = [1, 2, 3, 8] as const
const ARMS: StagedArm[] = ['search', 'apps']

const kill = (id: RuleResult['id'], status: RuleResult['status'], value: number | null = null, limit = 0.01): RuleResult => ({ id, label: id, status, value, limit, detail: `${id} ${status}` })
const KILLS_CLEAR: RuleResult[] = [kill('placement-leak', 'clear', 0.02, 0.1), kill('ctr', 'clear', 0.02, 0.01), kill('funnel-reach', 'clear', 4, 1), kill('hard-cap', 'clear', 20, 70)]

const tagged = (o: Partial<NonNullable<Flight3RulesInput['tagged']>> = {}) => ({ taggedArrivals: 100, completeRows: 40, flight3Asks: 5, coachShownPlace: 5, ...o })
const input = (arm: StagedArm, flightDay: number, o: Partial<Flight3RulesInput> = {}): Flight3RulesInput => ({
  arm,
  flightDay,
  killRules: KILLS_CLEAR,
  servingState: 'serving',
  spendOk: true,
  closedSpend: 40,
  tagged: tagged(),
  closedCompletes: 40,
  firstSession: { firstMove: 30, arrivals: 100 },
  signUps: { count: 3, note: 'exact' },
  ...o,
})
const rule = (b: ReturnType<typeof buildFlight3Rules>, n: number): RuleReadout => b.readouts[n - 1]
const verdictOf = (arm: StagedArm, day: number, n: number, o: Partial<Flight3RulesInput> = {}): ReadoutVerdict => rule(buildFlight3Rules(input(arm, day, o)), n).verdict

describe('line shape', () => {
  it('prints Rule <n> · <name>: <number> | threshold <t> → <verdict>', () => {
    expect(ruleReadoutLine({ n: 6, name: 'cost per complete row', number: '$2.00 per complete row', threshold: 'at most $3.00 a complete row', verdict: 'PASS' })).toBe(
      'Rule 6 · cost per complete row: $2.00 per complete row | threshold at most $3.00 a complete row → PASS',
    )
  })
  it('an n/a rule has no threshold or verdict', () => {
    expect(ruleReadoutLine({ n: 7, name: 'first-move row ratio', number: 'n/a (Apps arm only)', threshold: null, verdict: 'n/a' })).toBe('Rule 7 · first-move row ratio: n/a (Apps arm only)')
  })
  it('the block always has rules 1-9 in order, for both arms on every judged day', () => {
    for (const arm of ARMS)
      for (const day of DAYS) {
        const b = buildFlight3Rules(input(arm, day))
        expect(b.readouts.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
        expect(b.flightDay).toBe(day)
        expect(b.arm).toBe(arm)
        expect(rule(b, 7).verdict === 'n/a').toBe(arm === 'search')
      }
  })
})

describe('killRuleReadout (rules 1-4)', () => {
  it('maps each coded status to a readout verdict', () => {
    expect(killRuleReadout(kill('ctr', 'trip', 0.0005, 0.01))).toMatchObject({ n: 2, name: 'CTR', verdict: 'PROPOSE PAUSE' })
    expect(killRuleReadout(kill('ctr', 'clear', 0.02, 0.01))).toMatchObject({ n: 2, verdict: 'PASS' })
    expect(killRuleReadout(kill('ctr', 'not-armed'))).toMatchObject({ n: 2, verdict: 'NOT YET' })
    expect(killRuleReadout(kill('ctr', 'no-data'))).toMatchObject({ n: 2, verdict: 'NO DATA' })
    expect(killRuleReadout(kill('funnel-reach', 'watch', 1, 1))).toMatchObject({ n: 3, verdict: 'PASS' })
  })
  it('the hard cap is always armed: not-armed reads PASS, not NOT YET', () => {
    expect(killRuleReadout(kill('hard-cap', 'not-armed', 5, 70))).toMatchObject({ n: 4, name: 'hard cap', verdict: 'PASS' })
    expect(killRuleReadout(kill('hard-cap', 'trip', 70, 70))).toMatchObject({ n: 4, verdict: 'PROPOSE PAUSE' })
    expect(killRuleReadout(kill('hard-cap', 'no-data'))).toMatchObject({ n: 4, number: 'campaign status unreadable', verdict: 'NO DATA' })
  })
  it('an n/a rule (placement leak on Search) has no threshold', () => {
    const r = killRuleReadout(kill('placement-leak', 'n/a'))
    expect(r).toMatchObject({ n: 1, threshold: null, verdict: 'n/a' })
  })
  it('names the number and the threshold', () => {
    expect(killRuleReadout(kill('placement-leak', 'clear', 0.034, 0.1))).toMatchObject({ number: '3.4% of spend outside the approved list', threshold: 'at most 10% of spend outside the approved list' })
    expect(killRuleReadout(kill('funnel-reach', 'clear', 2, 1), { taggedArrivals: 40 })).toMatchObject({ number: '2 asks from 40 tagged arrivals', threshold: 'at least 1 tagged sign-in ask' })
    expect(killRuleReadout(kill('hard-cap', 'clear', 20, 70))).toMatchObject({ number: '$20.00 of $70.00', threshold: 'under $70.00' })
  })
  it('a rule the caller did not supply reads NO DATA, not a silent gap', () => {
    const b = buildFlight3Rules(input('search', 3, { killRules: [kill('hard-cap', 'clear', 10, 70)] }))
    expect(rule(b, 1)).toMatchObject({ verdict: 'NO DATA', number: 'not evaluated' })
    expect(rule(b, 2).verdict).toBe('NO DATA')
    expect(rule(b, 4).verdict).toBe('PASS')
  })
})

describe('rule 5: tracking check', () => {
  it('Search: day 1 is always NOT YET', () => {
    expect(verdictOf('search', 1, 5, { tagged: tagged({ completeRows: 50, flight3Asks: 0 }) })).toBe('NOT YET')
    expect(verdictOf('search', 1, 5, { tagged: null })).toBe('NOT YET')
  })
  it.each([2, 3, 8])('Search day %i: 10+ completes with 0 ask rows proposes a pause, with an ask passes', (day) => {
    expect(verdictOf('search', day, 5, { tagged: tagged({ completeRows: 10, flight3Asks: 0 }) })).toBe('PROPOSE PAUSE')
    expect(verdictOf('search', day, 5, { tagged: tagged({ completeRows: 10, flight3Asks: 1 }) })).toBe('PASS')
    expect(verdictOf('search', day, 5, { tagged: tagged({ completeRows: 200, flight3Asks: 0 }) })).toBe('PROPOSE PAUSE')
  })
  it('Search: under 10 completes is NOT YET on days 1-2 and NO DATA from day 3', () => {
    const t = tagged({ completeRows: 9, flight3Asks: 0 })
    expect(verdictOf('search', 2, 5, { tagged: t })).toBe('NOT YET')
    expect(verdictOf('search', 3, 5, { tagged: t })).toBe('NO DATA')
    expect(verdictOf('search', 8, 5, { tagged: t })).toBe('NO DATA')
    expect(rule(buildFlight3Rules(input('search', 3, { tagged: t })), 5).number).toContain('too few rows to judge')
  })
  it.each([2, 3, 8])('Apps day %i: 30+ arrivals with 0 /coach/shown/place rows proposes a pause, with coach rows passes', (day) => {
    expect(verdictOf('apps', day, 5, { tagged: tagged({ taggedArrivals: 30, coachShownPlace: 0 }) })).toBe('PROPOSE PAUSE')
    expect(verdictOf('apps', day, 5, { tagged: tagged({ taggedArrivals: 30, coachShownPlace: 1 }) })).toBe('PASS')
  })
  it('Apps: day 1 NOT YET; under 30 arrivals NOT YET on day 2 and NO DATA from day 3', () => {
    expect(verdictOf('apps', 1, 5, { tagged: tagged({ taggedArrivals: 90, coachShownPlace: 0 }) })).toBe('NOT YET')
    const t = tagged({ taggedArrivals: 29, coachShownPlace: 0 })
    expect(verdictOf('apps', 2, 5, { tagged: t })).toBe('NOT YET')
    expect(verdictOf('apps', 3, 5, { tagged: t })).toBe('NO DATA')
    expect(verdictOf('apps', 8, 5, { tagged: t })).toBe('NO DATA')
  })
  it.each(ARMS)('%s: a failed tagged read is NO DATA from day 2', (arm) => {
    expect(verdictOf(arm, 2, 5, { tagged: null })).toBe('NO DATA')
    expect(verdictOf(arm, 8, 5, { tagged: null })).toBe('NO DATA')
  })
  it('names the counts it judged', () => {
    expect(rule(buildFlight3Rules(input('search', 3, { tagged: tagged({ completeRows: 12, flight3Asks: 0 }) })), 5).number).toBe('12 complete rows, 0 sign-in ask rows')
    expect(rule(buildFlight3Rules(input('apps', 3, { tagged: tagged({ taggedArrivals: 31, coachShownPlace: 0 }) })), 5).number).toBe('31 tagged arrivals, 0 /coach/shown/place rows')
  })
})

describe('rule 5: Play-direct tracking check (keyed on the arm property, not on an id)', () => {
  const pd = (clicks: number | null, d0Rows: number | null) => ({ playDirect: { clicks, d0Rows } })
  it.each([2, 3, 8])('day %i: 30+ clicks with 0 tagged d0 rows is a WATCH line, never a pause proposal', (day) => {
    const b = buildFlight3Rules(input('apps', day, pd(30, 0)))
    const r = rule(b, 5)
    expect(r.verdict).toBe('WATCH')
    expect(r.number.startsWith('Watch: 30 clicks, 0 tagged first opens. The app side is proven:')).toBe(true)
    expect(r.number).toContain('At this size, 0 opens can also be chance.')
    expect(r.number).not.toMatch(/PAUSE|broken/i)
    expect(r.threshold).toBe('30+ clicks need 1+ tagged /return/<uc>/d0 row')
    expect(b.tripped).not.toContain(5)
    expect(b.proposal).toBe('CONTINUE')
  })
  it('one tagged d0 row clears it, and a WATCH never reaches the proposal, whatever the serving state', () => {
    expect(verdictOf('apps', 2, 5, pd(400, 1))).toBe('PASS')
    expect(buildFlight3Rules(input('apps', 2, pd(40, 0))).proposal).toBe('CONTINUE')
    expect(buildFlight3Rules(input('apps', 2, { ...pd(40, 0), servingState: 'paused' })).proposal).toBe('CONTINUE')
  })
  it('day 1 is NOT YET; under 30 clicks is NOT YET on day 2 and NO DATA from day 3; unread clicks or rows are NO DATA from day 2', () => {
    expect(verdictOf('apps', 1, 5, pd(90, 0))).toBe('NOT YET')
    expect(verdictOf('apps', 2, 5, pd(29, 0))).toBe('NOT YET')
    expect(verdictOf('apps', 3, 5, pd(29, 0))).toBe('NO DATA')
    expect(rule(buildFlight3Rules(input('apps', 3, pd(29, 0))), 5).number).toContain('too few clicks to judge')
    expect(verdictOf('apps', 2, 5, pd(null, 0))).toBe('NO DATA')
    expect(verdictOf('apps', 2, 5, pd(50, null))).toBe('NO DATA')
    expect(verdictOf('apps', 2, 5, { playDirect: null })).toBe('NO DATA')
  })
  it('a web arm (no playDirect input) keeps its own rule 5 untouched, and the block carries the sign-ups for the Play readout', () => {
    expect(rule(buildFlight3Rules(input('apps', 3, { tagged: tagged({ taggedArrivals: 31, coachShownPlace: 0 }) })), 5).verdict).toBe('PROPOSE PAUSE')
    expect(rule(buildFlight3Rules(input('apps', 3)), 5).threshold).toContain('/coach/shown/place')
    expect(buildFlight3Rules(input('apps', 3, { signUps: { count: 3, note: 'exact' } })).signUps).toEqual({ count: 3, note: 'exact' })
  })
})

describe('rule 6: cost per complete row', () => {
  it.each(ARMS)('%s: days 1 and 2 are NOT YET whatever the spend', (arm) => {
    for (const day of [1, 2]) {
      expect(verdictOf(arm, day, 6, { closedSpend: 50, closedCompletes: 2 })).toBe('NOT YET')
      expect(verdictOf(arm, day, 6, { closedSpend: 50, closedCompletes: 0 })).toBe('NOT YET')
    }
  })
  it.each(ARMS)('%s: from day 3 over $3 a row proposes a pause, at or under passes', (arm) => {
    for (const day of [3, 8]) {
      expect(verdictOf(arm, day, 6, { closedSpend: 20, closedCompletes: 10 })).toBe('PASS')
      expect(verdictOf(arm, day, 6, { closedSpend: 30, closedCompletes: 10 })).toBe('PASS') // exactly $3.00
      expect(verdictOf(arm, day, 6, { closedSpend: 40, closedCompletes: 10 })).toBe('PROPOSE PAUSE')
    }
  })
  it.each(ARMS)('%s: 0 complete rows is a pause once spend is over $3, else NO DATA', (arm) => {
    for (const day of [3, 8]) {
      expect(verdictOf(arm, day, 6, { closedSpend: 3.01, closedCompletes: 0 })).toBe('PROPOSE PAUSE')
      expect(verdictOf(arm, day, 6, { closedSpend: 3, closedCompletes: 0 })).toBe('NO DATA')
    }
    expect(rule(buildFlight3Rules(input(arm, 3, { closedSpend: 12.5, closedCompletes: 0 })), 6).number).toBe('0 complete rows from $12.50')
  })
  it.each(ARMS)('%s: unread spend or rows is NO DATA from day 3', (arm) => {
    expect(verdictOf(arm, 3, 6, { spendOk: false })).toBe('NO DATA')
    expect(verdictOf(arm, 8, 6, { closedCompletes: null })).toBe('NO DATA')
  })
  it('prints the division it made', () => {
    expect(rule(buildFlight3Rules(input('search', 3, { closedSpend: 24, closedCompletes: 12 })), 6).number).toBe('$2.00 per complete row ($24.00 / 12 rows)')
  })
  it('the block carries cost per row for the Tagged so far line, null under 1 row', () => {
    expect(buildFlight3Rules(input('apps', 3, { closedSpend: 24, closedCompletes: 12 }), { costPerRowYesterday: 1.5 }).costPerRow).toEqual({ cumulative: 2, yesterday: 1.5 })
    expect(buildFlight3Rules(input('apps', 3, { closedSpend: 24, closedCompletes: 0 })).costPerRow).toEqual({ cumulative: null, yesterday: null })
    expect(costPerCompleteRow(10, 0)).toBeNull()
    expect(costPerCompleteRow(null, 5)).toBeNull()
    expect(costPerCompleteRow(10, 4)).toBe(2.5)
  })
})

describe('rule 7: Apps first-move row ratio', () => {
  it.each(DAYS)('Search day %i: n/a, no threshold', (day) => {
    const r = rule(buildFlight3Rules(input('search', day)), 7)
    expect(r).toMatchObject({ verdict: 'n/a', threshold: null, number: 'n/a (Apps arm only)' })
  })
  it('Apps: days 1 and 2 are NOT YET', () => {
    for (const day of [1, 2]) expect(verdictOf('apps', day, 7, { firstSession: { firstMove: 0, arrivals: 100 } })).toBe('NOT YET')
  })
  it.each([3, 8])('Apps day %i: under 20% proposes a pause, 20% and over passes', (day) => {
    expect(verdictOf('apps', day, 7, { firstSession: { firstMove: 7, arrivals: 40 } })).toBe('PROPOSE PAUSE') // 17.5%
    expect(verdictOf('apps', day, 7, { firstSession: { firstMove: 8, arrivals: 40 } })).toBe('PASS') // exactly 20%
    expect(verdictOf('apps', day, 7, { firstSession: { firstMove: 0, arrivals: 40 } })).toBe('PROPOSE PAUSE')
  })
  it.each([3, 8])('Apps day %i: under 5 d0 rows or an unread first-session block is NO DATA', (day) => {
    expect(verdictOf('apps', day, 7, { firstSession: { firstMove: 0, arrivals: 4 } })).toBe('NO DATA')
    expect(verdictOf('apps', day, 7, { firstSession: { firstMove: null, arrivals: 40 } })).toBe('NO DATA')
    expect(verdictOf('apps', day, 7, { firstSession: null })).toBe('NO DATA')
  })
  it('names the ratio as a row ratio with F2s definition', () => {
    expect(rule(buildFlight3Rules(input('apps', 3, { firstSession: { firstMove: 8, arrivals: 40 } })), 7).number).toBe("20.0% (8 first-move rows / 40 d0 rows; row ratio, same definition as F2's 6.4%)")
  })
})

describe('rule 8: traffic held (derived from rules 2 and 6)', () => {
  const ctr = (status: RuleResult['status']) => [kill('placement-leak', 'clear', 0.02, 0.1), kill('ctr', status, 0.02, 0.01), kill('funnel-reach', 'clear', 4, 1), kill('hard-cap', 'clear', 20, 70)]
  it.each(ARMS)('%s: both pass -> PASS', (arm) => {
    expect(verdictOf(arm, 3, 8, { killRules: ctr('clear'), closedSpend: 20, closedCompletes: 10 })).toBe('PASS')
    expect(verdictOf(arm, 8, 8, { killRules: ctr('clear'), closedSpend: 20, closedCompletes: 10 })).toBe('PASS')
  })
  it.each(ARMS)('%s: a CTR trip or a cost trip proposes a pause', (arm) => {
    expect(verdictOf(arm, 3, 8, { killRules: ctr('trip'), closedSpend: 20, closedCompletes: 10 })).toBe('PROPOSE PAUSE')
    expect(verdictOf(arm, 3, 8, { killRules: ctr('clear'), closedSpend: 40, closedCompletes: 10 })).toBe('PROPOSE PAUSE')
    // a trip outranks a not-yet on the other side
    expect(verdictOf(arm, 3, 8, { killRules: ctr('not-armed'), closedSpend: 40, closedCompletes: 10 })).toBe('PROPOSE PAUSE')
  })
  it.each(ARMS)('%s: days 1 and 2 are NOT YET (rule 6 is not yet judged)', (arm) => {
    for (const day of [1, 2]) expect(verdictOf(arm, day, 8, { killRules: ctr('not-armed'), closedSpend: 20, closedCompletes: 10 })).toBe('NOT YET')
  })
  it('a not-armed CTR keeps it NOT YET even once cost is judged; NO DATA on either side without a trip reads NO DATA', () => {
    expect(verdictOf('search', 3, 8, { killRules: ctr('not-armed'), closedSpend: 20, closedCompletes: 10 })).toBe('NOT YET')
    expect(verdictOf('search', 3, 8, { killRules: ctr('no-data'), closedSpend: 20, closedCompletes: 10 })).toBe('NO DATA')
    expect(verdictOf('search', 3, 8, { killRules: ctr('clear'), spendOk: false })).toBe('NO DATA')
  })
  it('is never counted twice: a cost-per-row trip lists rule 6 only, and rule 8 is not in the tripped list', () => {
    const b = buildFlight3Rules(input('search', 3, { closedSpend: 40, closedCompletes: 10 }))
    expect(rule(b, 8).verdict).toBe('PROPOSE PAUSE')
    expect(b.tripped).toEqual([6])
  })
})

describe('rule 9: D+7 verdict', () => {
  it.each(ARMS)('%s: days 1-3 are NOT YET and show what the table would say', (arm) => {
    for (const day of [1, 2, 3]) {
      const r = rule(buildFlight3Rules(input(arm, day, { tagged: tagged({ flight3Asks: 25 }), signUps: { count: 6, note: 'exact' } })), 9)
      expect(r.verdict).toBe('NOT YET')
      expect(r.number).toContain('running, the table would say GO')
    }
  })
  it.each(ARMS)('%s: day 8 states GO / ITERATE / STOP / INCONCLUSIVE', (arm) => {
    const v = (count: number, asks: number) => verdictOf(arm, 8, 9, { tagged: tagged({ flight3Asks: asks }), signUps: { count, note: 'exact' } })
    expect(v(5, 20)).toBe('GO')
    expect(v(4, 20)).toBe('ITERATE')
    expect(v(1, 20)).toBe('STOP')
    expect(v(9, 19)).toBe('INCONCLUSIVE')
  })
  it.each(ARMS)('%s: a failed tagged read is NOT YET before day 8 and NO DATA on it', (arm) => {
    expect(verdictOf(arm, 3, 9, { tagged: null })).toBe('NOT YET')
    expect(verdictOf(arm, 8, 9, { tagged: null })).toBe('NO DATA')
    expect(verdictOf(arm, 8, 9, { signUps: null })).toBe('NO DATA')
  })
  it('is a verdict, not a pause: it never trips', () => {
    const b = buildFlight3Rules(input('search', 8, { tagged: tagged({ flight3Asks: 30 }), signUps: { count: 0, note: 'exact' } }))
    expect(rule(b, 9).verdict).toBe('STOP')
    expect(b.tripped).toEqual([])
    expect(b.proposal).toBe('CONTINUE')
  })
})

describe('proposal', () => {
  it('CONTINUE when nothing tripped', () => {
    for (const arm of ARMS) for (const day of DAYS) expect(buildFlight3Rules(input(arm, day)).proposal).toBe('CONTINUE')
  })
  it('PROPOSE PAUSE lists the tripped rules for a serving or unknown-state campaign', () => {
    const t = tagged({ completeRows: 12, flight3Asks: 0 })
    const serving = buildFlight3Rules(input('search', 3, { tagged: t, closedSpend: 50, closedCompletes: 12 }))
    expect(serving.tripped).toEqual([5, 6])
    expect(serving.proposal).toBe('PROPOSE PAUSE')
    expect(buildFlight3Rules(input('search', 3, { tagged: t, closedSpend: 50, closedCompletes: 12, servingState: 'unknown' })).proposal).toBe('PROPOSE PAUSE')
  })
  it('null (nothing to pause) when rules tripped but the campaign is ended, paused or not serving', () => {
    const t = tagged({ completeRows: 12, flight3Asks: 0 })
    for (const servingState of ['ended', 'paused', 'not-serving'] as const) {
      const b = buildFlight3Rules(input('search', 8, { tagged: t, servingState }))
      expect(b.tripped).toEqual([5])
      expect(b.proposal).toBeNull()
      expect(b.servingState).toBe(servingState)
    }
  })
  it('a coded kill-rule trip (1-4) counts as tripped', () => {
    const b = buildFlight3Rules(input('apps', 3, { killRules: [kill('placement-leak', 'trip', 0.4, 0.1), ...KILLS_CLEAR.slice(1)] }))
    expect(b.tripped).toEqual([1])
    expect(b.proposal).toBe('PROPOSE PAUSE')
  })
})

describe('decideFlight3: the go / iterate / stop table', () => {
  it.each([
    [0, 20, 'f3-stop'],
    [1, 20, 'f3-stop'],
    [2, 20, 'f3-iterate'],
    [4, 20, 'f3-iterate'],
    [5, 20, 'f3-go'],
    [9, 45, 'f3-go'],
    [0, 500, 'f3-stop'],
  ])('%i new accounts with %i asks -> %s', (accounts, asks, row) => {
    expect(decideFlight3(accounts, asks).row).toBe(row)
  })
  it.each([0, 1, 2, 4, 5, 12])('%i new accounts under %i asks is inconclusive, whatever the count', (accounts) => {
    expect(decideFlight3(accounts, F3_VALIDITY_ASKS - 1).row).toBe('f3-inconclusive')
    expect(decideFlight3(accounts, 0).row).toBe('f3-inconclusive')
  })
  it('puts the figure and the next step in the result, proposal only', () => {
    const go = decideFlight3(5, 30)
    expect(go.reading).toContain('5 new accounts')
    expect(go.reading).toContain('30 ask rows')
    expect(go.next).toContain('Mike decides')
    expect(decideFlight3(1, 20).reading).toContain('1 new account ')
  })
  it('verdict words for the push text; null for a flight 2 row', () => {
    expect(flight3VerdictWord('f3-go')).toBe('GO')
    expect(flight3VerdictWord('f3-iterate')).toBe('ITERATE')
    expect(flight3VerdictWord('f3-stop')).toBe('STOP')
    expect(flight3VerdictWord('f3-inconclusive')).toBe('INCONCLUSIVE')
    expect(flight3VerdictWord('two-plus')).toBeNull()
  })
})

describe('flightDayOf', () => {
  it('day 1 is the flight start, the D+7 final read is day 8', () => {
    expect(flightDayOf('2026-10-17', '2026-10-17')).toBe(1)
    expect(flightDayOf('2026-10-17', '2026-10-18')).toBe(2)
    expect(flightDayOf('2026-10-17', '2026-10-19')).toBe(3)
    expect(flightDayOf('2026-10-17', '2026-10-24')).toBe(8)
    expect(flightDayOf('2026-10-28', '2026-11-04')).toBe(8)
  })
})

describe('Play-direct arm: every rule that reads TAGGED rows is a WATCH line (keyed on the playDirect input, never an id)', () => {
  const pd = { playDirect: { clicks: 120, d0Rows: 0 } }
  // Rule 3 trip (zero asks), rule 6 over $3 a row, rule 7 under 20%, and rule 5 (30+ clicks, no first open): all four tagged-row rules fire at once.
  const WATCH_KILLS: RuleResult[] = [kill('placement-leak', 'clear', 0.02, 0.1), kill('ctr', 'clear', 0.02, 0.01), kill('funnel-reach', 'trip', 0, 0), kill('hard-cap', 'clear', 20, 70)]
  const allWatch = (arm: StagedArm = 'apps', o: Partial<Flight3RulesInput> = {}) =>
    input(arm, 4, { killRules: WATCH_KILLS, closedSpend: 40, closedCompletes: 4, firstSession: { firstMove: 1, arrivals: 100 }, ...pd, ...o })

  it('rules 3, 5, 6 and 7 all fire together: four WATCH lines, no PROPOSE PAUSE, no tripped rule, proposal CONTINUE', () => {
    const b = buildFlight3Rules(allWatch())
    expect([3, 5, 6, 7].map((n) => rule(b, n).verdict)).toEqual(['WATCH', 'WATCH', 'WATCH', 'WATCH'])
    expect(b.readouts.some((r) => r.verdict === 'PROPOSE PAUSE')).toBe(false)
    expect(b.tripped).toEqual([])
    expect(b.proposal).toBe('CONTINUE')
    for (const n of [3, 6, 7]) expect(rule(b, n).number).toContain('WATCH on a Play-direct arm')
  })
  it('a WATCH never proposes a pause whatever the serving state', () => {
    for (const servingState of ['serving', 'unknown', 'paused', 'ended'] as const) expect(buildFlight3Rules(allWatch('apps', { servingState })).proposal).toBe('CONTINUE')
  })
  it('rule 6: over $3 a complete row and zero complete rows over $3 are WATCH; a good ratio is still PASS and NOT YET stays NOT YET', () => {
    expect(verdictOf('apps', 4, 6, { ...pd, closedSpend: 40, closedCompletes: 4 })).toBe('WATCH')
    expect(verdictOf('apps', 4, 6, { ...pd, closedSpend: 12, closedCompletes: 0 })).toBe('WATCH')
    expect(verdictOf('apps', 4, 6, { ...pd, closedSpend: 12, closedCompletes: 8 })).toBe('PASS')
    expect(verdictOf('apps', 2, 6, { ...pd, closedSpend: 40, closedCompletes: 0 })).toBe('NOT YET')
  })
  it('rule 7: a first-move ratio under 20% is WATCH; at 20% it passes; under the cohort floor it stays NO DATA', () => {
    expect(verdictOf('apps', 4, 7, { ...pd, firstSession: { firstMove: 5, arrivals: 100 } })).toBe('WATCH')
    expect(verdictOf('apps', 4, 7, { ...pd, firstSession: { firstMove: 20, arrivals: 100 } })).toBe('PASS')
    expect(verdictOf('apps', 4, 7, { ...pd, firstSession: { firstMove: 0, arrivals: 2 } })).toBe('NO DATA')
  })
  it('rule 3: the readout of a funnel-reach trip is WATCH; a funnel-reach clear stays PASS', () => {
    expect(verdictOf('apps', 4, 3, { ...pd })).toBe('PASS')
    expect(verdictOf('apps', 4, 3, { ...pd, killRules: WATCH_KILLS })).toBe('WATCH')
  })
  it('the same inputs on a web arm (no playDirect input) still propose a pause on rules 3, 6 and 7', () => {
    for (const arm of ARMS) {
      const b = buildFlight3Rules(allWatch(arm, { playDirect: undefined }))
      expect(rule(b, 3).verdict).toBe('PROPOSE PAUSE')
      expect(rule(b, 6).verdict).toBe('PROPOSE PAUSE')
      expect(b.tripped).toContain(3)
      expect(b.tripped).toContain(6)
      expect(b.proposal).toBe('PROPOSE PAUSE')
    }
    expect(rule(buildFlight3Rules(allWatch('apps', { playDirect: undefined })), 7).verdict).toBe('PROPOSE PAUSE')
  })
  it('rules 1, 2 and 4 stay real: each still proposes a pause on a Play-direct arm', () => {
    for (const [id, n, limit] of [['placement-leak', 1, 0.1], ['ctr', 2, 0.0015], ['hard-cap', 4, 49.14]] as const) {
      const killRules = KILLS_CLEAR.map((r) => (r.id === id ? kill(id, 'trip', n === 4 ? 49.5 : 0.2, limit) : r))
      const b = buildFlight3Rules(allWatch('apps', { killRules, playDirect: { clicks: 120, d0Rows: 5 } }))
      expect(rule(b, n).verdict).toBe('PROPOSE PAUSE')
      expect(b.tripped).toContain(n)
      expect(b.proposal).toBe('PROPOSE PAUSE')
    }
  })
  it('rule 8 (traffic held) stays real: a CTR trip proposes a pause; a rule 6 WATCH alone does not', () => {
    const ctrTrip = KILLS_CLEAR.map((r) => (r.id === 'ctr' ? kill('ctr', 'trip', 0.001, 0.0015) : r))
    expect(verdictOf('apps', 4, 8, { ...pd, killRules: ctrTrip, closedSpend: 12, closedCompletes: 8 })).toBe('PROPOSE PAUSE')
    const only6 = buildFlight3Rules(allWatch())
    expect(rule(only6, 6).verdict).toBe('WATCH')
    expect(rule(only6, 8).verdict).toBe('PASS')
    expect(rule(only6, 8).number).toContain('rule 6 is a WATCH line on this arm')
    // a web arm's rule 8 is still derived from rule 6 as before
    expect(verdictOf('apps', 4, 8, { closedSpend: 40, closedCompletes: 4 })).toBe('PROPOSE PAUSE')
  })
  it('a funnel-reach status of watch (what the kill evaluation reports for a Play-direct arm) reads WATCH on rule 3, and PASS as before on a web arm', () => {
    const watchKills = KILLS_CLEAR.map((r) => (r.id === 'funnel-reach' ? kill('funnel-reach', 'watch', 0, 0) : r))
    const b = buildFlight3Rules(input('apps', 4, { killRules: watchKills, playDirect: { clicks: 10, d0Rows: 3 } }))
    expect(rule(b, 3).verdict).toBe('WATCH')
    expect(rule(b, 3).number).toContain('WATCH on a Play-direct arm')
    expect(b.proposal).toBe('CONTINUE')
    expect(verdictOf('apps', 4, 3, { killRules: watchKills })).toBe('PASS')
  })
  it('rule 9 at the D+7 read: NOT YET with the interim tagged first opens and sign-ins, and the install verdict read named', () => {
    const r9 = rule(buildFlight3Rules(input('apps', 6, { playDirect: { clicks: 140, d0Rows: 17 }, signUps: { count: 2, note: 'exact' } })), 9)
    expect(r9.verdict).toBe('NOT YET')
    expect(r9.number).toContain('tagged first opens (/return/<uc>/d0): 17')
    expect(r9.number).toContain('tagged sign-ins (/auth/success/*/new): 2')
    expect(r9.number).toContain('the 11-21 d35 read is the install verdict')
    expect(rule(buildFlight3Rules(input('apps', 6, { playDirect: { clicks: null, d0Rows: null }, signUps: null, tagged: null })), 9).number).toContain('tagged first opens (/return/<uc>/d0): not read')
    // a web arm's rule 9 line is unchanged
    expect(rule(buildFlight3Rules(input('apps', 6)), 9).number).not.toMatch(/interim|install verdict/)
  })
})
