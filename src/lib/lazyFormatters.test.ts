// The module-level Intl formatters became lazy (built on first use) and installFixMarkerLabel
// became plain ET arithmetic, so the gss-stats-sync Worker's cold start does no Intl work.
// Their output must be byte-identical to the former eager formatters: compared here with
// reference formatters built exactly as before, over a spread of instants including both DST
// transition days (minute by minute around each switch) and New Year.
import { describe, expect, it } from 'vitest'
import { etDateFromMs, installFixMarkerLabel, INSTALL_FIX_NOTE } from './popupEvents'
import { etDateTimeFromMs, etHourFromMs } from './campaigns'
import { etHourLabel, etHourOf, INSTALL_OUTCOME_GAP_NOTE } from './adsRules'

const TZ = 'America/New_York'
const ref = {
  date: new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }),
  hour: new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }),
  dateTime: new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  hourLabel: new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }),
  marker: new Intl.DateTimeFormat('en-US', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
}
const parts = (f: Intl.DateTimeFormat, ms: number) => Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]))
const old = {
  etDateFromMs: (ms: number) => ref.date.format(new Date(ms)),
  etHourFromMs: (ms: number) => Number(ref.hour.format(new Date(ms))),
  etDateTimeFromMs: (ms: number) => {
    const p = parts(ref.dateTime, ms)
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
  },
  etHourLabel: (ms: number) => {
    const p = parts(ref.hourLabel, ms)
    return `${p.year}-${p.month}-${p.day} ${p.hour}:00 ET`
  },
  etHourOf: (ms: number) => Number(ref.hour.format(new Date(ms))) % 24,
  installFixMarkerLabel: (ms: number) => {
    const p = parts(ref.marker, ms)
    return `install fix went live ${p.day} ${p.month} ${p.hour}:${p.minute} ET`
  },
}

const HOUR = 3_600_000
function instants(): number[] {
  const out: number[] = []
  // every 7 hours over 2025-2027 (walks through every hour of the day and every month)
  for (let ms = Date.UTC(2025, 0, 1); ms < Date.UTC(2028, 0, 1); ms += 7 * HOUR + 13 * 60_000) out.push(ms)
  // minute by minute around the 2025-2027 DST switches and New Year
  for (const around of [Date.UTC(2025, 2, 9, 7), Date.UTC(2025, 10, 2, 6), Date.UTC(2026, 2, 8, 7), Date.UTC(2026, 10, 1, 6), Date.UTC(2027, 2, 14, 7), Date.UTC(2027, 10, 7, 6), Date.UTC(2027, 0, 1, 5)]) {
    for (let ms = around - 2 * HOUR; ms <= around + 2 * HOUR; ms += 60_000) out.push(ms)
  }
  return out
}

describe('lazy formatters produce byte-identical output to the former eager ones', () => {
  const all = instants()
  it(`checks ${all.length} instants, DST days minute by minute`, () => {
    expect(all.length).toBeGreaterThan(4000)
  })
  for (const [name, fn] of [
    ['etDateFromMs', etDateFromMs],
    ['etHourFromMs', etHourFromMs],
    ['etDateTimeFromMs', etDateTimeFromMs],
    ['etHourLabel', etHourLabel],
    ['etHourOf', etHourOf],
    ['installFixMarkerLabel', installFixMarkerLabel],
  ] as const) {
    it(name, () => {
      const mismatches = all.filter((ms) => (fn as (ms: number) => unknown)(ms) !== old[name](ms))
      expect(mismatches.map((ms) => new Date(ms).toISOString()).slice(0, 5)).toEqual([])
    })
  }
  it('the module-load notes are unchanged', () => {
    expect(INSTALL_FIX_NOTE).toBe('install fix went live 26 Sep 12:26 ET; earlier prompt-driven installs not recorded')
    expect(INSTALL_OUTCOME_GAP_NOTE).toContain('install fix went live 26 Sep 12:26 ET (Best Sudoku v1.95.4)')
  })
})
