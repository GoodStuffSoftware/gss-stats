import { describe, expect, it } from 'vitest'
import { addDays, etDateFast, etHourFast, etOffsetHours, etSameTimeWindow, etWallTimeMs } from './etTime'
import { etDateFromMs } from './popupEvents'
import { etMidnightUtcMs, etTimeUtcMs } from './campaigns'
import { addEtDays, sameTimeWindowMs } from './overview'

const HOUR = 3_600_000
const intlHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' })

describe('fast ET arithmetic matches Intl', () => {
  it('date and hour, every hour from 2025 through 2028', () => {
    const start = Date.UTC(2025, 0, 1)
    const end = Date.UTC(2029, 0, 1)
    let checked = 0
    for (let ms = start; ms < end; ms += HOUR) {
      expect(etDateFast(ms)).toBe(etDateFromMs(ms))
      expect(etHourFast(ms)).toBe(Number(intlHour.format(new Date(ms))))
      checked++
    }
    expect(checked).toBeGreaterThan(35_000)
  })
  it('minute by minute around the 2026 transitions', () => {
    for (const around of [Date.UTC(2026, 2, 8, 7), Date.UTC(2026, 10, 1, 6)]) {
      for (let ms = around - 3 * HOUR; ms < around + 3 * HOUR; ms += 60_000) {
        expect(etDateFast(ms)).toBe(etDateFromMs(ms))
        expect(etHourFast(ms)).toBe(Number(intlHour.format(new Date(ms))))
      }
    }
    expect(etOffsetHours(Date.UTC(2026, 2, 8, 6, 59))).toBe(-5)
    expect(etOffsetHours(Date.UTC(2026, 2, 8, 7))).toBe(-4)
    expect(etOffsetHours(Date.UTC(2026, 10, 1, 5, 59))).toBe(-4)
    expect(etOffsetHours(Date.UTC(2026, 10, 1, 6))).toBe(-5)
  })
  it('wall times and day arithmetic agree with the dashboard helpers', () => {
    for (let d = '2025-01-01'; d < '2028-12-31'; d = addDays(d, 1)) {
      expect(etWallTimeMs(d)).toBe(etMidnightUtcMs(d))
      expect(etWallTimeMs(d, '09:30')).toBe(etTimeUtcMs(d, '09:30'))
      expect(addDays(d, 1)).toBe(addEtDays(d, 1))
    }
  })
})

describe('etSameTimeWindow matches lib/overview.ts sameTimeWindowMs (the KPI comparison windows)', () => {
  it('every 37 minutes through 2026, against the 7 days before', () => {
    let checked = 0
    for (let now = Date.UTC(2026, 0, 1, 0, 7, 13); now < Date.UTC(2027, 0, 1); now += 37 * 60_000 + 11_111) {
      const today = etDateFast(now)
      for (let k = 1; k <= 7; k += 3) {
        const d = addDays(today, -k)
        expect(etSameTimeWindow(d, now), `${d} @ ${new Date(now).toISOString()}`).toEqual(sameTimeWindowMs(d, now))
        checked++
      }
    }
    expect(checked).toBeGreaterThan(40_000)
  })
  it('minute by minute across both 2026 transitions, for the transition day and its neighbours', () => {
    for (const around of [Date.UTC(2026, 2, 8, 7), Date.UTC(2026, 10, 1, 6)]) {
      for (let now = around - 30 * HOUR; now < around + 30 * HOUR; now += 60_000 + 1_234) {
        const today = etDateFast(now)
        for (const k of [1, 2, 7]) {
          const d = addDays(today, -k)
          expect(etSameTimeWindow(d, now)).toEqual(sameTimeWindowMs(d, now))
        }
        // The comparison day IS the transition day (a week later).
        const d = etDateFast(around)
        const later = now + 7 * 24 * HOUR
        expect(etSameTimeWindow(d, later)).toEqual(sameTimeWindowMs(d, later))
      }
    }
  })
})
