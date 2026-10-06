// The day selector's pure side: which ET day a chosen value means, stepping, bounds and names.
import { describe, expect, it } from 'vitest'
import { dayBounds, dayLabel, dayTitle, earliestDay, effectiveDay, stepDay } from './glanceDay'
import { MAX_DAY_LOOKBACK_DAYS } from './metrics/validate'

const TODAY = '2026-10-06'

describe('earliestDay / dayBounds', () => {
  it('the floor is the server bound, 90 ET days back', () => {
    expect(MAX_DAY_LOOKBACK_DAYS).toBe(90)
    expect(earliestDay(TODAY)).toBe('2026-07-08')
    expect(dayBounds(TODAY)).toEqual({ min: '2026-07-08', max: TODAY })
  })
})

describe('effectiveDay', () => {
  it('today, the future, nothing and a non-date are all today (null)', () => {
    for (const c of [TODAY, '2026-10-07', '2030-01-01', null, undefined, '', 'yesterday', '2026-02-30', '2026-10-05T00:00', '10/05/2026']) expect(effectiveDay(c, TODAY)).toBeNull()
  })
  it('a past day in range is itself, the floor included', () => {
    expect(effectiveDay('2026-10-05', TODAY)).toBe('2026-10-05')
    expect(effectiveDay('2026-07-08', TODAY)).toBe('2026-07-08')
  })
  it('a day before the floor is the floor', () => {
    expect(effectiveDay('2025-01-01', TODAY)).toBe('2026-07-08')
  })
})

describe('stepDay', () => {
  it('back from today is yesterday; forward from yesterday is today (null); forward from today stays today', () => {
    expect(stepDay(null, -1, TODAY)).toBe('2026-10-05')
    expect(stepDay('2026-10-05', 1, TODAY)).toBeNull()
    expect(stepDay(null, 1, TODAY)).toBeNull()
  })
  it('walks across a month boundary and stops at the floor', () => {
    expect(stepDay('2026-10-01', -1, TODAY)).toBe('2026-09-30')
    expect(stepDay('2026-09-30', 1, TODAY)).toBe('2026-10-01')
    expect(stepDay('2026-07-08', -1, TODAY)).toBe('2026-07-08')
    expect(stepDay('2026-01-01', -1, '2026-01-20')).toBe('2025-12-31')
  })
  it('steps over the DST days by calendar day', () => {
    expect(stepDay('2026-11-02', -1, '2026-11-10')).toBe('2026-11-01')
    expect(stepDay('2026-11-01', -1, '2026-11-10')).toBe('2026-10-31')
    expect(stepDay('2026-03-09', -1, '2026-03-20')).toBe('2026-03-08')
    expect(stepDay('2026-03-08', -1, '2026-03-20')).toBe('2026-03-07')
  })
})

describe('dayLabel / dayTitle', () => {
  it('names the weekday, month and day', () => {
    expect(dayLabel('2026-10-05')).toBe('Mon Oct 5')
    expect(dayLabel('2026-11-01')).toBe('Sun Nov 1')
    expect(dayLabel('2028-02-29')).toBe('Tue Feb 29')
  })
  it('"Today at a glance" becomes the day; today keeps the title', () => {
    expect(dayTitle('Today at a glance', '2026-10-05')).toBe('Mon Oct 5 at a glance')
    expect(dayTitle('Today at a glance', null)).toBe('Today at a glance')
  })
  it('a custom title keeps its words and gets the day appended', () => {
    expect(dayTitle('KPIs', '2026-10-05')).toBe('KPIs · Mon Oct 5')
  })
})
