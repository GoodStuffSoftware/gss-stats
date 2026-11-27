import { describe, expect, it } from 'vitest'
import { addDays, daysBetween, formatRange, isIsoDate, localToday, parseSmartDate, weekday, ymd } from './smartDate'

// Fri 27 Nov 2026, local time. Local-constructor dates so the tests do not depend on the machine's time zone.
const NOW = new Date(2026, 10, 27, 14, 30)

function dates(text: string, now: Date = NOW): [string, string] | string {
  const r = parseSmartDate(text, now)
  return r.ok ? [r.from, r.to] : r.hint
}

describe('parseSmartDate: period words', () => {
  it.each([
    ['today', '2026-11-27', '2026-11-27'],
    ['Yesterday', '2026-11-26', '2026-11-26'],
    ['this week', '2026-11-22', '2026-11-27'], // Sunday to today
    ['last week', '2026-11-15', '2026-11-21'], // the whole Sunday-Saturday before
    ['this month', '2026-11-01', '2026-11-27'],
    ['last month', '2026-10-01', '2026-10-31'],
    ['this year', '2026-01-01', '2026-11-27'],
    ['last year', '2025-01-01', '2025-12-31'],
    ['ytd', '2026-01-01', '2026-11-27'],
    ['year to date', '2026-01-01', '2026-11-27'],
    ['this quarter', '2026-10-01', '2026-11-27'],
    ['last quarter', '2026-07-01', '2026-09-30'],
  ])('%s', (text, from, to) => expect(dates(text)).toEqual([from, to]))

  it.each([
    ['last 7 days', '2026-11-21', '2026-11-27'],
    ['last 30 days', '2026-10-29', '2026-11-27'],
    ['Last 90 days', '2026-08-30', '2026-11-27'],
    ['past 14 days', '2026-11-14', '2026-11-27'],
    ['last 2 weeks', '2026-11-14', '2026-11-27'],
    ['last 3 months', '2026-09-01', '2026-11-27'], // the Budget preset's meaning
    ['past week', '2026-11-21', '2026-11-27'],
  ])('%s', (text, from, to) => expect(dates(text)).toEqual([from, to]))

  it('is forgiving about case, spacing, punctuation and en dashes', () => {
    expect(dates('  LAST   30 Days. ')).toEqual(['2026-10-29', '2026-11-27'])
    expect(dates('Oct 1 – Nov 15')).toEqual(['2026-10-01', '2026-11-15'])
  })
})

describe('parseSmartDate: months, years, quarters, since', () => {
  it('a month name is the most recent such month that has begun', () => {
    expect(dates('March')).toEqual(['2026-03-01', '2026-03-31'])
    expect(dates('november')).toEqual(['2026-11-01', '2026-11-30'])
    expect(dates('December')).toEqual(['2025-12-01', '2025-12-31']) // December 2026 has not begun
    expect(dates('feb')).toEqual(['2026-02-01', '2026-02-28'])
  })
  it('a month and year', () => {
    expect(dates('March 2025')).toEqual(['2025-03-01', '2025-03-31'])
    expect(dates('Feb 2024')).toEqual(['2024-02-01', '2024-02-29']) // leap year
    expect(dates('sept 2025')).toEqual(['2025-09-01', '2025-09-30'])
  })
  it('a year', () => {
    expect(dates('2025')).toEqual(['2025-01-01', '2025-12-31'])
    expect(dates('in 2024')).toEqual(['2024-01-01', '2024-12-31'])
  })
  it('quarters', () => {
    expect(dates('Q3')).toEqual(['2026-07-01', '2026-09-30'])
    expect(dates('q4')).toEqual(['2026-10-01', '2026-12-31'])
    expect(dates('Q3 2025')).toEqual(['2025-07-01', '2025-09-30'])
    expect(dates('2025 Q1')).toEqual(['2025-01-01', '2025-03-31'])
    expect(dates('3q 2024')).toEqual(['2024-07-01', '2024-09-30'])
  })
  it('a quarter that has not begun is last year\'s', () => {
    expect(dates('Q4', new Date(2026, 5, 10))).toEqual(['2025-10-01', '2025-12-31'])
  })
  it('since: from the start of what follows to today', () => {
    expect(dates('since March')).toEqual(['2026-03-01', '2026-11-27'])
    expect(dates('since March 2025')).toEqual(['2025-03-01', '2026-11-27'])
    expect(dates('since Oct 1')).toEqual(['2026-10-01', '2026-11-27'])
    expect(dates('since 2025')).toEqual(['2025-01-01', '2026-11-27'])
    expect(dates('since 2027')).toMatch(/starts after today/)
  })
})

describe('parseSmartDate: single dates and ranges (chrono-node)', () => {
  it.each([
    ['11/3', '2026-11-03'],
    ['Nov 3', '2026-11-03'],
    ['November 3rd', '2026-11-03'],
    ['2026-11-03', '2026-11-03'],
    ['11/3/2025', '2025-11-03'],
    ['11/3/25', '2025-11-03'],
    ['Dec 5', '2025-12-05'], // no year: the most recent one, not next month
    ['12/25', '2025-12-25'],
    ['Nov 27', '2026-11-27'],
    ['3 days ago', '2026-11-24'],
  ])('%s is one day', (text, day) => expect(dates(text)).toEqual([day, day]))

  it.each([
    ['Oct 1 to Nov 15', '2026-10-01', '2026-11-15'],
    ['Oct 1 - Nov 15', '2026-10-01', '2026-11-15'],
    ['Oct 1-Nov 15', '2026-10-01', '2026-11-15'],
    ['between Oct 1 and Nov 15', '2026-10-01', '2026-11-15'],
    ['from Oct 1 to Nov 15', '2026-10-01', '2026-11-15'],
    ['10/1 to 11/15', '2026-10-01', '2026-11-15'],
    ['2026-10-01 to 2026-11-15', '2026-10-01', '2026-11-15'],
    ['Oct 1 - 15', '2026-10-01', '2026-10-15'],
    ['Dec 1 2025 to Jan 15 2026', '2025-12-01', '2026-01-15'],
    ['Dec 1 to Jan 15', '2025-12-01', '2026-01-15'], // no years: Dec 1 is the year before Jan 15
    ['Nov 15 to Oct 1', '2025-11-15', '2026-10-01'], // no years: the start is the Nov 15 before Oct 1
    ['Nov 15 2026 to Oct 1 2026', '2026-10-01', '2026-11-15'], // reversed with years: put in order
  ])('%s', (text, from, to) => expect(dates(text)).toEqual([from, to]))
})

describe('parseSmartDate: month, year and week boundaries', () => {
  it('last week across a year change', () => {
    const jan2 = new Date(2026, 0, 2, 10) // Friday
    expect(dates('this week', jan2)).toEqual(['2025-12-28', '2026-01-02'])
    expect(dates('last week', jan2)).toEqual(['2025-12-21', '2025-12-27'])
  })
  it('last month in January is December of the year before', () => {
    const jan15 = new Date(2026, 0, 15)
    expect(dates('last month', jan15)).toEqual(['2025-12-01', '2025-12-31'])
    expect(dates('last quarter', jan15)).toEqual(['2025-10-01', '2025-12-31'])
    expect(dates('last 3 months', jan15)).toEqual(['2025-11-01', '2026-01-15'])
  })
  it('last N days crosses month and year ends', () => {
    expect(dates('last 7 days', new Date(2026, 0, 3))).toEqual(['2025-12-28', '2026-01-03'])
    expect(dates('last 30 days', new Date(2024, 2, 1))).toEqual(['2024-02-01', '2024-03-01']) // leap February
  })
  it('a month name in January looks back, and December on Dec 31 is this month', () => {
    expect(dates('December', new Date(2026, 0, 5))).toEqual(['2025-12-01', '2025-12-31'])
    expect(dates('December', new Date(2026, 11, 31))).toEqual(['2026-12-01', '2026-12-31'])
  })
  it('year-less dates around New Year', () => {
    expect(dates('Dec 31', new Date(2026, 0, 1))).toEqual(['2025-12-31', '2025-12-31'])
    expect(dates('Jan 1', new Date(2026, 0, 1))).toEqual(['2026-01-01', '2026-01-01'])
  })
  it('a leap day', () => {
    expect(dates('Feb 29 2024')).toEqual(['2024-02-29', '2024-02-29'])
  })
})

describe('parseSmartDate: local calendar dates, no UTC day shift', () => {
  it('just before and just after local midnight', () => {
    const late = new Date(2026, 10, 27, 23, 59, 59)
    const early = new Date(2026, 10, 28, 0, 0, 1)
    expect(dates('today', late)).toEqual(['2026-11-27', '2026-11-27'])
    expect(dates('today', early)).toEqual(['2026-11-28', '2026-11-28'])
    expect(dates('yesterday', early)).toEqual(['2026-11-27', '2026-11-27'])
    expect(dates('last 7 days', late)).toEqual(['2026-11-21', '2026-11-27'])
    expect(dates('this week', early)).toEqual(['2026-11-22', '2026-11-28'])
    expect(dates('3 days ago', early)).toEqual(['2026-11-25', '2026-11-25'])
  })
  it('a date typed back reads as itself', () => {
    expect(dates('2026-11-03', new Date(2026, 10, 3, 0, 0, 1))).toEqual(['2026-11-03', '2026-11-03'])
    expect(dates('2026-11-03', new Date(2026, 10, 3, 23, 59, 59))).toEqual(['2026-11-03', '2026-11-03'])
  })
})

describe('parseSmartDate: what it cannot read', () => {
  it.each(['', '   ', 'asdf', 'sometime soon-ish', 'last 0 days', '2026-13-45', 'Feb 30', '99999', 'I paid rent on Nov 3', 'March 1999999'])(
    '%j gets a hint',
    (text) => {
      const r = parseSmartDate(text, NOW)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.hint.length).toBeGreaterThan(10)
    },
  )
  it('the hint names the text and shows examples', () => {
    const r = parseSmartDate('blorp', NOW)
    expect(r.ok ? '' : r.hint).toBe('Couldn\'t read "blorp". Try "last 30 days", "March", "Oct 1 to Nov 15" or "11/3".')
  })
  it('years out of range are refused', () => {
    expect(parseSmartDate('1850', NOW).ok).toBe(false)
    expect(parseSmartDate('2300', NOW).ok).toBe(false)
  })
})

describe('parseSmartDate: review fixes', () => {
  it('"past month" and "past year" at the end of a month stop at the last day of the earlier month', () => {
    const mar31 = new Date(2026, 2, 31, 12)
    expect(dates('past month', mar31)).toEqual(['2026-03-01', '2026-03-31'])
    const feb29 = new Date(2028, 1, 29, 12)
    expect(dates('past year', feb29)).toEqual(['2027-03-01', '2028-02-29'])
  })

  it('a year typed on the end of a range is the start\'s year too', () => {
    expect(dates('Jan 1 to Mar 5 2027')).toEqual(['2027-01-01', '2027-03-05'])
  })

  it('a range across New Year with the end year typed runs from last year to next', () => {
    expect(dates('Dec 1 to Jan 15 2027')).toEqual(['2026-12-01', '2027-01-15'])
  })

  it('absurd text never throws, and an absurd year count is unreadable', () => {
    const texts = ['last 5000 years', 'last 99999999999 days', 'x'.repeat(5000), '9'.repeat(400), '\u0000‮', 'Feb 31 to Feb 32', '31/31/9999', 'year 99999', '-5 days']
    for (const t of texts) expect(() => parseSmartDate(t, NOW)).not.toThrow()
    expect(parseSmartDate('last 5000 years', NOW).ok).toBe(false)
  })
})

describe('labels', () => {
  it('one day', () => expect(formatRange('2026-11-03', '2026-11-03')).toBe('Nov 3, 2026'))
  it('inside one year the year shows once', () => expect(formatRange('2026-10-01', '2026-11-15')).toBe('Oct 1 – Nov 15, 2026'))
  it('across years both show', () => expect(formatRange('2025-12-01', '2026-01-15')).toBe('Dec 1, 2025 – Jan 15, 2026'))
  it('parse results carry the label', () => {
    const r = parseSmartDate('Oct 1 to Nov 15', NOW)
    expect(r.ok && r.label).toBe('Oct 1 – Nov 15, 2026')
  })
})

describe('date helpers', () => {
  it('ymd rolls over', () => {
    expect(ymd(2026, 13, 1)).toBe('2027-01-01')
    expect(ymd(2026, 3, 0)).toBe('2026-02-28')
  })
  it('addDays, daysBetween, weekday', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(daysBetween('2026-10-01', '2026-11-15')).toBe(45)
    expect(weekday('2026-11-27')).toBe(5)
  })
  it('isIsoDate', () => {
    expect(isIsoDate('2026-02-29')).toBe(false)
    expect(isIsoDate('2024-02-29')).toBe(true)
    expect(isIsoDate('26-1-1')).toBe(false)
  })
  it('localToday reads the local calendar date', () => {
    expect(localToday(new Date(2026, 10, 27, 23, 59))).toBe('2026-11-27')
    expect(localToday(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01')
  })
})
