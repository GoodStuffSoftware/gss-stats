// lib/range.ts — relative range tokens, including "since first campaign": a window from ET
// midnight of the earliest configured flight start to now, which grows instead of rolling.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dayDrillRange,
  etDayOfRange,
  etDayRangeToISO,
  firstCampaignStartMs,
  isSinceFirstCampaign,
  isSinceFirstUntilLastCampaign,
  lastCampaignEndMs,
  rangeLabel,
  rangeToYmd,
  relativeRange,
  SINCE_FIRST_CAMPAIGN,
  SINCE_FIRST_UNTIL_LAST_CAMPAIGN,
} from './range'
import { CAMPAIGNS, etMidnightUtcMs } from './campaigns'
import { defaultCampaignsWidgets, flightDayWidget, hourOfDayWidget } from './defaults'

const NOW = Date.parse('2028-06-15T12:00:00Z') // well over a year after every configured flight

/** ET midnight of the day after the latest configured flightEnd: the instant a closed
 * "until last campaign ends" range stops at. Read from the config (not a literal), so a new
 * flight, or a correction to a flight's dates, never needs this test touched. */
const LAST_END_MS = (() => {
  const lastEnd = CAMPAIGNS.map((c) => c.flightEnd).filter((d): d is string => !!d).sort().at(-1)!
  const [y, m, d] = lastEnd.split('-').map(Number)
  return etMidnightUtcMs(new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10))
})()
beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }))
afterEach(() => vi.useRealTimers())

describe('since first campaign', () => {
  const earliest = CAMPAIGNS.map((c) => c.flightStart).filter((d): d is string => !!d).sort()[0]

  it('starts at ET midnight of the earliest configured flight start', () => {
    expect(earliest).toBe('2026-09-02')
    expect(new Date(firstCampaignStartMs()!).toISOString()).toBe('2026-09-02T04:00:00.000Z') // EDT midnight
  })

  it('relativeRange reads it (any casing, with or without "since"), until = now', () => {
    for (const t of [SINCE_FIRST_CAMPAIGN, 'Since first campaign', 'first campaign', 'since the first campaign']) {
      expect(isSinceFirstCampaign(t), t).toBe(true)
      expect(relativeRange(t), t).toEqual({ since: '2026-09-02T04:00:00.000Z', until: new Date(NOW).toISOString() })
    }
    expect(isSinceFirstCampaign('7d')).toBe(false)
    expect(relativeRange('7d')!.since).toBe(new Date(NOW - 7 * 86_400_000).toISOString())
  })

  it('labels itself "Since first campaign", not "Last 21mo"', () => {
    const r = relativeRange(SINCE_FIRST_CAMPAIGN)!
    expect(rangeLabel(r.since, r.until)).toMatch(/^Last \d+mo$/)
    expect(rangeLabel(r.since, r.until, SINCE_FIRST_CAMPAIGN)).toBe('Since first campaign')
    expect(rangeLabel(r.since, r.until, '12mo')).toMatch(/^Last \d+mo$/)
  })

  it('the hour-of-day chart reads since the first campaign, open-ended (until = now)', () => {
    const shipped = defaultCampaignsWidgets().filter((w) => w.id === 'cw-hour')
    expect(shipped).toHaveLength(1)
    for (const w of [hourOfDayWidget({ x: 0, y: 0, w: 12, h: 8 }), ...shipped]) {
      expect(w.filters?.rangeRel, w.id).toBe(SINCE_FIRST_CAMPAIGN)
      expect(w.filters?.since, w.id).toBe('2026-09-02T04:00:00.000Z') // the Android launch's first day stays in
      expect(w.filters?.until, w.id).toBe(new Date(NOW).toISOString())
    }
  })

  it('the flight-day chart reads since the first campaign too, but closes once every flight is over (NOW is well past)', () => {
    const shipped = defaultCampaignsWidgets().filter((w) => w.id === 'cw-flightday')
    expect(shipped).toHaveLength(1)
    for (const w of [flightDayWidget({ x: 0, y: 0, w: 12, h: 10 }), ...shipped]) {
      expect(w.filters?.rangeRel, w.id).toBe(SINCE_FIRST_UNTIL_LAST_CAMPAIGN)
      expect(w.filters?.since, w.id).toBe('2026-09-02T04:00:00.000Z')
      // Closed, not NOW: ET midnight of the day after the latest configured flightEnd.
      expect(w.filters?.until, w.id).toBe(new Date(LAST_END_MS).toISOString())
      expect(w.filters?.until, w.id).not.toBe(new Date(NOW).toISOString())
    }
  })
})

describe('since first campaign until last campaign ends', () => {
  it('isSinceFirstUntilLastCampaign matches only the exact composite token', () => {
    expect(isSinceFirstUntilLastCampaign(SINCE_FIRST_UNTIL_LAST_CAMPAIGN)).toBe(true)
    expect(isSinceFirstUntilLastCampaign('Since First Campaign Until Last Campaign Ends')).toBe(true) // case-insensitive
    expect(isSinceFirstUntilLastCampaign(SINCE_FIRST_CAMPAIGN)).toBe(false) // the start-only token
    expect(isSinceFirstUntilLastCampaign('7d')).toBe(false)
    // The two tokens don't collide the other way either.
    expect(isSinceFirstCampaign(SINCE_FIRST_UNTIL_LAST_CAMPAIGN)).toBe(false)
  })

  it('lastCampaignEndMs is null while any flight is open-ended or still running', () => {
    vi.setSystemTime(Date.parse('2026-09-26T21:00:00Z')) // the retest is active (2026-09-26..10-02)
    expect(lastCampaignEndMs()).toBeNull()
    const pending = { ...CAMPAIGNS[2], id: '99999999999', flightStart: null }
    CAMPAIGNS.push(pending)
    try {
      vi.setSystemTime(Date.parse('2028-06-15T12:00:00Z')) // every dated flight long over
      expect(lastCampaignEndMs()).toBeNull() // the pending one has no window to close on
    } finally {
      CAMPAIGNS.splice(CAMPAIGNS.indexOf(pending), 1)
    }
  })

  it('the transition when the last flight ends: open right up to ET midnight of the day after its flightEnd, then closed', () => {
    const dayAfterLastEndsEt = LAST_END_MS
    vi.setSystemTime(dayAfterLastEndsEt - 1)
    expect(lastCampaignEndMs()).toBeNull()
    expect(relativeRange(SINCE_FIRST_UNTIL_LAST_CAMPAIGN)).toEqual({
      since: '2026-09-02T04:00:00.000Z',
      until: new Date(dayAfterLastEndsEt - 1).toISOString(),
    })

    vi.setSystemTime(dayAfterLastEndsEt)
    expect(lastCampaignEndMs()).toBe(dayAfterLastEndsEt)
    expect(relativeRange(SINCE_FIRST_UNTIL_LAST_CAMPAIGN)).toEqual({
      since: '2026-09-02T04:00:00.000Z',
      until: new Date(dayAfterLastEndsEt).toISOString(),
    })

    // Any later instant still reads the same closed instant — the range has stopped growing.
    vi.setSystemTime(dayAfterLastEndsEt + 30 * 86_400_000)
    expect(lastCampaignEndMs()).toBe(dayAfterLastEndsEt)
  })

  it('labels itself "Since first campaign" too, not a calendar range', () => {
    const r = relativeRange(SINCE_FIRST_UNTIL_LAST_CAMPAIGN)!
    expect(rangeLabel(r.since, r.until, SINCE_FIRST_UNTIL_LAST_CAMPAIGN)).toBe('Since first campaign')
  })
})

describe('ET-day drill range (a click on a dateEt bucket)', () => {
  const ms = (iso: string) => Date.parse(iso)
  const hours = (r: { since: string; until: string }) => (ms(r.until) + 1 - ms(r.since)) / 3_600_000

  it('a normal day runs from ET midnight to the next ET midnight (24 h, EDT)', () => {
    expect(etDayRangeToISO('2026-06-15')).toEqual({ since: '2026-06-15T04:00:00.000Z', until: '2026-06-16T03:59:59.999Z' })
    expect(hours(etDayRangeToISO('2026-06-15'))).toBe(24)
    expect(etDayRangeToISO('2026-01-15')).toEqual({ since: '2026-01-15T05:00:00.000Z', until: '2026-01-16T04:59:59.999Z' }) // EST
  })
  it('the spring-forward day is 23 h: it starts on EST and ends on EDT midnight', () => {
    // 2026-03-08, the second Sunday of March: 02:00 EST jumps to 03:00 EDT.
    const r = etDayRangeToISO('2026-03-08')
    expect(r).toEqual({ since: '2026-03-08T05:00:00.000Z', until: '2026-03-09T03:59:59.999Z' })
    expect(hours(r)).toBe(23)
  })
  it('the fall-back day is 25 h: it starts on EDT and ends on EST midnight', () => {
    // 2026-11-01, the first Sunday of November: 02:00 EDT falls back to 01:00 EST.
    const r = etDayRangeToISO('2026-11-01')
    expect(r).toEqual({ since: '2026-11-01T04:00:00.000Z', until: '2026-11-02T04:59:59.999Z' })
    expect(hours(r)).toBe(25)
  })
  it('consecutive ET days tile with no gap and no overlap, across both DST changes and a year end', () => {
    for (const [a, b] of [['2026-03-07', '2026-03-08'], ['2026-03-08', '2026-03-09'], ['2026-10-31', '2026-11-01'], ['2026-11-01', '2026-11-02'], ['2026-12-31', '2027-01-01']]) {
      expect(ms(etDayRangeToISO(b).since) - ms(etDayRangeToISO(a).until)).toBe(1)
    }
  })
  it('the drill filter range is the ET day for dateEt, the UTC day for date, and nothing for other dimensions', () => {
    expect(dayDrillRange('dateEt', '2026-11-01')).toEqual(etDayRangeToISO('2026-11-01'))
    expect(dayDrillRange('date', '2026-11-01')).toEqual({ since: '2026-11-01T00:00:00.000Z', until: '2026-11-01T23:59:59.999Z' })
    for (const d of ['hourEt', 'country', 'dateWeek', '']) expect(dayDrillRange(d, '2026-11-01'), d).toBeNull()
  })
  it('an instant just inside either edge of the ET day is in the range, the instants just outside are not', () => {
    const r = dayDrillRange('dateEt', '2026-03-08')!
    // `until` is EXCLUSIVE wherever the server reads it (ts < until), like the UTC path's 23:59:59.999Z.
    const inside = (t: number) => t >= ms(r.since) && t < ms(r.until)
    expect(inside(ms('2026-03-08T05:00:00.000Z'))).toBe(true) // 00:00 EST
    expect(inside(ms('2026-03-09T03:59:59.998Z'))).toBe(true) // 23:59:59.998 EDT
    expect(inside(ms('2026-03-09T03:59:59.999Z'))).toBe(false) // 23:59:59.999 EDT: the last millisecond is dropped, as on the UTC path
    expect(inside(ms('2026-03-08T04:59:59.999Z'))).toBe(false) // 23:59:59.999 EST the day before
    expect(inside(ms('2026-03-09T04:00:00.000Z'))).toBe(false) // 00:00 EDT the next day
  })
  it('a malformed dateEt key is no drill (null), never a throw; the date and other dimensions are as before', () => {
    for (const bad of ['', 'abc', '2026-13-45', '2026-02-31', '2026-3-8', '2026-03-08T00:00', ' 2026-03-08']) {
      expect(() => dayDrillRange('dateEt', bad), bad).not.toThrow()
      expect(dayDrillRange('dateEt', bad), bad).toBeNull()
    }
    expect(dayDrillRange('dateEt', '2026-02-28')).not.toBeNull()
    expect(dayDrillRange('dateEt', '2028-02-29')).not.toBeNull() // a leap day is a real date
  })
})

describe('the label and date pickers of an ET-day range name that one ET day', () => {
  const label = (day: string) => {
    const r = etDayRangeToISO(day)
    return rangeLabel(r.since, r.until)
  }
  it('a normal day, either side of DST, and a year end read as the single ET date', () => {
    expect(label('2026-06-15')).toBe('Jun 15') // EDT
    expect(label('2026-01-15')).toBe('Jan 15') // EST
    expect(label('2026-12-31')).toBe('Dec 31') // its end falls on Jan 1 UTC
  })
  it('the spring-forward day (23 h) is "Mar 8", not "Mar 8 – Mar 9"', () => {
    expect(label('2026-03-08')).toBe('Mar 8')
    expect(etDayOfRange('2026-03-08T05:00:00.000Z', '2026-03-09T03:59:59.999Z')).toBe('2026-03-08')
  })
  it('the fall-back day (25 h) is "Nov 1", not "Nov 1 – Nov 2"', () => {
    expect(label('2026-11-01')).toBe('Nov 1')
    expect(etDayOfRange('2026-11-01T04:00:00.000Z', '2026-11-02T04:59:59.999Z')).toBe('2026-11-01')
  })
  it('a UTC day, a rolling window, a two-ET-day span and a day off by a millisecond keep their UTC label', () => {
    expect(rangeLabel('2026-03-08T00:00:00.000Z', '2026-03-08T23:59:59.999Z')).toBe('Mar 8 – Mar 8')
    expect(rangeLabel('2026-06-01T00:00:00.000Z', '2026-06-26T23:59:59.999Z')).toBe('Jun 1 – Jun 26')
    expect(rangeLabel('2026-03-08T05:00:00.000Z', '2026-03-10T03:59:59.999Z')).toBe('Mar 8 – Mar 10')
    expect(etDayOfRange('2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z')).toBeNull() // ends at the next midnight itself
    expect(etDayOfRange('2026-03-08T05:00:00.001Z', '2026-03-09T03:59:59.999Z')).toBeNull()
    expect(etDayOfRange('2026-03-08', '2026-03-08')).toBeNull() // legacy day values
    expect(etDayOfRange('nope', 'nope')).toBeNull()
  })
  it('the date pickers show the ET day on both sides of an ET-day range, and the UTC dates otherwise', () => {
    for (const day of ['2026-03-08', '2026-11-01', '2026-06-15', '2026-12-31']) {
      const r = etDayRangeToISO(day)
      expect(rangeToYmd(r.since, r.until), day).toEqual({ from: day, to: day })
    }
    expect(rangeToYmd('2026-03-08T00:00:00.000Z', '2026-03-08T23:59:59.999Z')).toEqual({ from: '2026-03-08', to: '2026-03-08' })
    expect(rangeToYmd('2026-06-01T00:00:00.000Z', '2026-06-26T23:59:59.999Z')).toEqual({ from: '2026-06-01', to: '2026-06-26' })
    expect(rangeToYmd('2026-03-08T05:00:00.000Z', '2026-03-10T03:59:59.999Z')).toEqual({ from: '2026-03-08', to: '2026-03-10' })
  })
})
