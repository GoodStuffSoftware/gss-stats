// The flight registry CTE (lib/campaigns.ts flightRegistryCte / withFlightRegistry): the one place the
// campaign list enters a geo statement for the campaignFlight, flightDay and arrival dimensions, run on a real
// SQLite. Covers registry order, a campaign with no start, an empty registry, statements that must stay
// untouched, and the size contract (a registered campaign adds a table row, never a branch per use).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { CAMPAIGNS, FLIGHT_REGISTRY_TABLE, campaignAttributionStartMs, etFlightRangeMs, campaignFlightSqlCase, arrivalSqlCase, flightDaySqlCase, flightRegistryCte, withFlightRegistry, type CampaignFlight } from '../../src/lib/campaigns'
import { buildMergedBreakdownSql, buildMergedRingSql } from './geo'
import { insertHits, openHitsDb } from '../_lib/testing/hitsDb'

const real = CAMPAIGNS.slice()
const fake = (id: string, ucValues: string[], flightStart: string | null, flightEnd: string, extra: Partial<CampaignFlight> = {}): CampaignFlight => ({
  id, label: id, ucValues, flightStart, flightEnd, status: 'upcoming', kind: 'web', notes: 'registry test', ...extra,
})
const setRegistry = (list: CampaignFlight[]) => CAMPAIGNS.splice(0, CAMPAIGNS.length, ...list)

let db: DatabaseSync
beforeEach(() => { db = openHitsDb() })
afterEach(() => { db.close(); setRegistry(real) })

/** The value of `expr` for every hit, in insertion order, through the same wrapper the handler uses. */
const values = (expr: string): string[] => (db.prepare(withFlightRegistry(`SELECT ${expr} AS v FROM hits ORDER BY rowid`)).all() as { v: string }[]).map((r) => r.v)
const T = (iso: string) => Date.parse(iso)

describe('flight registry CTE', () => {
  it('attributes by registry order: the first campaign whose uc matches and whose start the row has reached', () => {
    setRegistry([
      fake('A', ['shared', 'a_only'], '2026-10-05', '2026-10-11'),
      fake('B', ['shared', 'b_only'], '2026-10-01', '2026-10-04'),
    ])
    insertHits(db, [
      { ts: T('2026-10-06T16:00:00Z'), campaign: 'shared' }, // A (first in order, started)
      { ts: T('2026-10-02T16:00:00Z'), campaign: 'shared' }, // before A's start: falls through to B
      { ts: T('2026-09-30T16:00:00Z'), campaign: 'shared' }, // before both starts
      { ts: T('2026-10-06T16:00:00Z'), campaign: 'b_only' }, // B has no upper bound on attribution
      { ts: T('2026-10-06T16:00:00Z'), campaign: 'a_only' },
      { ts: T('2026-10-06T16:00:00Z'), campaign: 'nope' },
    ])
    expect(values(campaignFlightSqlCase('(none)'))).toEqual(['A', 'B', '(none)', 'B', 'A', '(none)'])
    // The day belongs to the campaign campaignFlight names, and only inside its serving window.
    expect(values(flightDaySqlCase('(none)'))).toEqual(['2', '2', '(none)', '(none)', '2', '(none)'])
  })

  it('two started campaigns claiming one uc: the first registered wins, whatever their start order', () => {
    const first = fake('FIRST', ['dup'], '2026-10-03', '2026-10-09')
    const second = fake('SECOND', ['dup'], '2026-10-01', '2026-10-09') // started earlier, registered later
    insertHits(db, [{ ts: T('2026-10-06T16:00:00Z'), campaign: 'dup' }])
    setRegistry([first, second])
    expect(values(campaignFlightSqlCase('-'))).toEqual(['FIRST'])
    setRegistry([second, first])
    expect(values(campaignFlightSqlCase('-'))).toEqual(['SECOND'])
    expect(values(flightDaySqlCase('-'))).toEqual(['6']) // SECOND's day 1 is 10-01
  })

  it('pins the window boundaries: attribution starts AT the start, the serving window is [from, to)', () => {
    // A starts at noon ET (a start time, so its attribution start is later than its ET-midnight window start);
    // B starts at ET midnight (attribution start = window start). Both end 10-07, so the window ends at ET midnight of 10-08.
    const a = fake('A', ['a'], '2026-10-05', '2026-10-07', { flightStartTimeEt: '12:00' })
    const b = fake('B', ['b'], '2026-10-05', '2026-10-07')
    setRegistry([a, b])
    const att = campaignAttributionStartMs(a)!
    const [from, to] = etFlightRangeMs('2026-10-05', '2026-10-07')
    expect(att).toBeGreaterThan(from)
    insertHits(db, [
      { ts: att - 1, campaign: 'a' }, // one ms before A's attribution start: not A's
      { ts: att, campaign: 'a' }, // exactly at the start: A's, and inside its window (day 1)
      { ts: from - 1, campaign: 'b' }, // one ms before B's start
      { ts: from, campaign: 'b' }, // exactly at the window start: B, day 1
      { ts: to - 1, campaign: 'b' }, // last ms of the window: day 3
      { ts: to, campaign: 'b' }, // exactly at the window end: still B's (no upper bound on attribution), but outside the day window
    ])
    expect(values(campaignFlightSqlCase('-'))).toEqual(['-', 'A', '-', 'B', 'B', 'B'])
    expect(values(flightDaySqlCase('-'))).toEqual(['-', '1', '-', '1', '3', '-'])
  })

  it('a campaign with no confirmed flightStart attributes nothing', () => {
    setRegistry([fake('U', ['u'], null, '2026-10-30'), fake('S', ['s'], '2026-10-01', '2026-10-03')])
    insertHits(db, [{ ts: T('2026-10-02T16:00:00Z'), campaign: 'u' }, { ts: T('2026-10-02T16:00:00Z'), campaign: 's' }])
    expect(values(campaignFlightSqlCase('-'))).toEqual(['-', 'S'])
    expect(values(flightDaySqlCase('-'))).toEqual(['-', '2'])
    expect(flightRegistryCte()).not.toContain("'U'")
  })

  it('an empty or all-unstarted registry still runs and attributes nothing', () => {
    setRegistry([])
    insertHits(db, [{ ts: T('2026-10-02T16:00:00Z'), campaign: 'sudoku_tired_of_ads' }])
    expect(values(campaignFlightSqlCase('-'))).toEqual(['-'])
    expect(values(flightDaySqlCase('-'))).toEqual(['-'])
    expect(values(arrivalSqlCase(''))).toEqual(['untagged'])
    setRegistry([fake('U', ['u'], null, '2026-10-30')])
    expect(values(campaignFlightSqlCase('-'))).toEqual(['-'])
  })

  it('rows the known-traffic exclusions cover are never attributed', () => {
    setRegistry([fake('A', ['a'], '2026-10-01', '2026-10-05')])
    insertHits(db, [
      { ts: T('2026-10-02T16:00:00Z'), campaign: 'a', region: 'North Carolina', screenw: 412 }, // the household
      { ts: T('2026-10-02T16:00:00Z'), campaign: 'a', region: 'Ohio', screenw: 390 },
    ])
    expect(values(campaignFlightSqlCase('-'))).toEqual(['-', 'A'])
  })

  it('leaves a statement without a flight expression exactly as it was', () => {
    const plain = buildMergedBreakdownSql('region', 'ts >= ? AND ts < ?', 'c DESC')
    expect(plain.startsWith('SELECT')).toBe(true)
    expect(plain).not.toContain(FLIGHT_REGISTRY_TABLE)
    expect(withFlightRegistry('SELECT 1')).toBe('SELECT 1')
    const ring = buildMergedRingSql(['region AS k0', 'device AS k1'], 'ts >= ?', 'k0, k1')
    expect(ring.startsWith('SELECT')).toBe(true)
  })

  it('states the registry once per statement, however many times a flight expression is used', () => {
    const col = campaignFlightSqlCase('-')
    const where = Array.from({ length: 16 }, () => `(${col}) = ?`).join(' AND ')
    const sql = buildMergedBreakdownSql(col, where, 'c DESC')
    expect(sql.startsWith('WITH flight_reg(')).toBe(true)
    expect(sql.split('(VALUES').length - 1).toBe(1)
    expect(sql.split('FROM flight_reg').length - 1).toBe(17)
  })

  it('a registered campaign adds one row per uc to the statement, never a branch per use', () => {
    const base = flightRegistryCte().length
    for (let i = 0; i < 20; i++) CAMPAIGNS.push(fake(`9${i}`, [`uc${i}_a`, `uc${i}_b`], '2026-11-01', '2026-11-08'))
    const perCampaign = (flightRegistryCte().length - base) / 20
    expect(perCampaign).toBeGreaterThan(0)
    expect(perCampaign).toBeLessThan(300)
    // the expressions themselves do not mention a single campaign
    expect(campaignFlightSqlCase('-')).not.toContain('uc0_a')
    expect(flightDaySqlCase('-')).not.toContain('uc0_a')
  })
})
