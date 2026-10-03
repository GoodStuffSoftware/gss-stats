// lib/range.ts — relative range tokens, including "since first campaign": a window from ET
// midnight of the earliest configured flight start to now, which grows instead of rolling.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dayDrillRange,
  etDayRangeToISO,
  firstCampaignStartMs,
  isSinceFirstCampaign,
  isSinceFirstUntilLastCampaign,
  lastCampaignEndMs,
  rangeLabel,
  relativeRange,
  SINCE_FIRST_CAMPAIGN,
  SINCE_FIRST_UNTIL_LAST_CAMPAIGN,
} from './range'
import { CAMPAIGNS } from './campaigns'
import { defaultCampaignsWidgets, flightDayWidget, hourOfDayWidget } from './defaults'

const NOW = Date.parse('2028-06-15T12:00:00Z') // well over a year after every configured flight
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
      // Closed, not NOW: ET midnight of the day after the retest's flightEnd (2026-10-02), the
      // latest of the three configured flights.
      expect(w.filters?.until, w.id).toBe('2026-10-03T04:00:00.000Z')
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

  it('the transition when the retest ends on 2026-10-02: open right up to ET midnight of 10-03, then closed', () => {
    const dayAfterRetestEndsEt = Date.parse('2026-10-03T04:00:00.000Z') // EDT midnight starting 10-03
    vi.setSystemTime(dayAfterRetestEndsEt - 1)
    expect(lastCampaignEndMs()).toBeNull()
    expect(relativeRange(SINCE_FIRST_UNTIL_LAST_CAMPAIGN)).toEqual({
      since: '2026-09-02T04:00:00.000Z',
      until: new Date(dayAfterRetestEndsEt - 1).toISOString(),
    })

    vi.setSystemTime(dayAfterRetestEndsEt)
    expect(lastCampaignEndMs()).toBe(dayAfterRetestEndsEt)
    expect(relativeRange(SINCE_FIRST_UNTIL_LAST_CAMPAIGN)).toEqual({
      since: '2026-09-02T04:00:00.000Z',
      until: new Date(dayAfterRetestEndsEt).toISOString(),
    })

    // Any later instant still reads the same closed instant — the range has stopped growing.
    vi.setSystemTime(dayAfterRetestEndsEt + 30 * 86_400_000)
    expect(lastCampaignEndMs()).toBe(dayAfterRetestEndsEt)
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
    const inside = (t: number) => t >= ms(r.since) && t <= ms(r.until)
    expect(inside(ms('2026-03-08T05:00:00.000Z'))).toBe(true) // 00:00 EST
    expect(inside(ms('2026-03-09T03:59:59.998Z'))).toBe(true) // 23:59:59.998 EDT
    expect(inside(ms('2026-03-08T04:59:59.999Z'))).toBe(false) // 23:59:59.999 EST the day before
    expect(inside(ms('2026-03-09T04:00:00.000Z'))).toBe(false) // 00:00 EDT the next day
  })
})
