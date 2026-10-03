import { describe, expect, it } from 'vitest'
import { datedReleases, latestDatedRelease, newest, releaseAwaitingFullDay, releaseSubjectOn, type DatedRelease } from './releases'
import { etMidnightMs } from './metrics/instrumentation'

// Derived from the marker list so adding a release never breaks these.
const dated = datedReleases()
const newestDate = dated.reduce((a, b) => (a.dateEt >= b.dateEt ? a : b)).dateEt
const oldestDate = dated.reduce((a, b) => (a.dateEt <= b.dateEt ? a : b)).dateEt
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

describe('release panel subject', () => {
  it('on the newest release day, skips it and subjects an older release; the newest is awaiting', () => {
    const subject = releaseSubjectOn(newestDate)
    expect(subject).not.toBeNull()
    expect(subject!.dateEt < newestDate).toBe(true)
    expect(releaseAwaitingFullDay(newestDate)?.dateEt).toBe(newestDate)
  })

  it('a release does not qualify the day after its date (its first after-day is still running)', () => {
    expect(releaseSubjectOn(addDays(newestDate, 1))?.dateEt).not.toBe(newestDate)
    expect(releaseAwaitingFullDay(addDays(newestDate, 1))?.dateEt).toBe(newestDate)
  })

  it('two days after its date it qualifies, with nothing waiting', () => {
    expect(releaseSubjectOn(addDays(newestDate, 2))?.dateEt).toBe(newestDate)
    expect(releaseAwaitingFullDay(addDays(newestDate, 2))).toBeNull()
  })

  it('v1.96.0 (dated 10-02) does not qualify on 10-03 and qualifies on 10-04', () => {
    expect(releaseSubjectOn('2026-10-03')?.version).not.toBe('v1.96.0')
    expect(releaseSubjectOn('2026-10-04')?.version).toBe('v1.96.0')
  })

  it('is null before any release has a full day after it', () => {
    expect(releaseSubjectOn(oldestDate)).toBeNull()
  })

  it('latestDatedRelease reads the ET date of its now argument', () => {
    const during = etMidnightMs(newestDate) + 3 * 3_600_000
    expect(latestDatedRelease(during)).toEqual(releaseSubjectOn(newestDate))
    expect(latestDatedRelease(during + 2 * 86_400_000)?.dateEt).toBe(newestDate)
  })
})

describe('RELEASES order', () => {
  it('is listed oldest to newest (non-decreasing dates), which the same-date tie-break relies on', () => {
    const dates = dated.map((r) => r.dateEt)
    expect(dates.every((d, i) => i === 0 || dates[i - 1] <= d)).toBe(true)
  })
})

describe('newest', () => {
  const r = (version: string, dateEt: string): DatedRelease => ({ version, dateEt, note: '' })
  it('on a date tie the later-listed release wins', () => {
    expect(newest([r('v1', '2026-10-03'), r('v2', '2026-10-03')])?.version).toBe('v2')
    expect(newest([r('v1', '2026-10-03'), r('v2', '2026-10-02')])?.version).toBe('v1')
  })
  it('null for an empty list', () => {
    expect(newest([])).toBeNull()
  })
})
