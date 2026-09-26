import { describe, expect, it } from 'vitest'
import { contiguousThrough, expectedThrough, freshnessLine, freshnessOf, isClosedFetch, relativeTime, spendThroughFromRows, STALE_NOTE } from './adsFreshness'

// The retest: flight 2026-09-26 (noon ET start) .. 2026-10-02.
const retest = { flightStart: '2026-09-26', flightEnd: '2026-10-02' }
const et = (d: string, hhmm: string) => {
  // EDT (UTC-4) throughout the flight.
  const [h, m] = hhmm.split(':').map(Number)
  return Date.parse(`${d}T00:00:00Z`) + (h + 4) * 3_600_000 + m * 60_000
}

describe('closed days and spendThrough', () => {
  it('a day is closed only when it was fetched on a later ET day', () => {
    expect(isClosedFetch('2026-09-26', '2026-09-27T04:30:00Z')).toBe(true) // 00:30 ET on 09-27
    expect(isClosedFetch('2026-09-26', '2026-09-27T03:30:00Z')).toBe(false) // 23:30 ET on 09-26
    expect(isClosedFetch('2026-09-26', null)).toBe(false)
  })
  it('spendThrough is the end of the contiguous closed run from the flight start (a gap stops it)', () => {
    const closed = '2026-10-01T13:00:00Z'
    expect(spendThroughFromRows('2026-09-26', [
      { date: '2026-09-26', fetchedAt: closed },
      { date: '2026-09-27', fetchedAt: closed },
      { date: '2026-09-29', fetchedAt: closed },
    ])).toBe('2026-09-27')
    expect(contiguousThrough('2026-09-26', new Set())).toBeNull()
    expect(contiguousThrough(null, new Set(['2026-09-26']))).toBeNull()
    // a row stored while its day was still open does not count
    expect(spendThroughFromRows('2026-09-26', [{ date: '2026-09-26', fetchedAt: '2026-09-26T20:00:00Z' }])).toBeNull()
  })
})

describe('stale: a flight day that should be stored by now is missing', () => {
  it("yesterday's data is expected from 09:30 ET; before that, the day before", () => {
    expect(expectedThrough(retest, et('2026-09-28', '09:29'))).toBe('2026-09-26')
    expect(expectedThrough(retest, et('2026-09-28', '09:30'))).toBe('2026-09-27')
  })
  it('not stale before the first flight day is due, stale when yesterday is missing after 09:30 ET on a flight day', () => {
    expect(freshnessOf(retest, null, null, et('2026-09-26', '15:00')).stale).toBe(false) // first day still open
    expect(freshnessOf(retest, null, null, et('2026-09-27', '09:00')).stale).toBe(false) // morning read not due yet
    expect(freshnessOf(retest, null, null, et('2026-09-27', '09:31')).stale).toBe(true)
    expect(freshnessOf(retest, '2026-09-26', '2026-09-27T12:05:00Z', et('2026-09-27', '09:31')).stale).toBe(false)
    expect(freshnessOf(retest, '2026-09-26', '2026-09-27T12:05:00Z', et('2026-09-28', '10:00')).stale).toBe(true)
  })
  it('after the flight only flight days count: a finished campaign with its flight stored is never stale', () => {
    expect(freshnessOf(retest, '2026-10-02', null, et('2026-10-20', '12:00')).stale).toBe(false)
    expect(freshnessOf(retest, '2026-10-01', null, et('2026-10-20', '12:00')).stale).toBe(true)
    expect(freshnessOf({ flightStart: null, flightEnd: '2026-10-02' }, null, null, et('2026-10-20', '12:00')).stale).toBe(false)
  })
})

describe('the widgets\' freshness line', () => {
  const now = Date.parse('2026-09-28T15:00:00Z')
  it('relative time', () => {
    expect(relativeTime('2026-09-28T14:59:40Z', now)).toBe('just now')
    expect(relativeTime('2026-09-28T14:48:00Z', now)).toBe('12m ago')
    expect(relativeTime('2026-09-28T12:00:00Z', now)).toBe('3h ago')
    expect(relativeTime('2026-09-25T15:00:00Z', now)).toBe('3d ago')
    expect(relativeTime(null, now)).toBe('never')
  })
  it('"Spend through <date> · synced <relative time>"', () => {
    expect(freshnessLine({ spendThrough: '2026-09-27', lastSync: '2026-09-28T12:05:00Z' }, now)).toBe('Spend through Sep 27 · synced 2h ago')
    expect(freshnessLine({ spendThrough: null, lastSync: null }, now)).toBe('No closed spend day stored yet · not synced yet')
    expect(STALE_NOTE).toBe('stale — sync pending')
  })
})
