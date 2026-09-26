import { describe, expect, it } from 'vitest'
import { addDays, etDateFast, etHourFast, etOffsetHours, etWallTimeMs } from './etTime'
import { etDateFromMs } from './popupEvents'
import { etMidnightUtcMs, etTimeUtcMs } from './campaigns'
import { addEtDays } from './overview'

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
