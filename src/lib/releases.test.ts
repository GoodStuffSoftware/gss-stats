import { describe, expect, it } from 'vitest'
import { datedReleases, latestDatedRelease, releaseAwaitingFullDay, releaseSubjectOn } from './releases'
import { etMidnightMs } from './metrics/instrumentation'

// Derived from the marker list so adding a release never breaks these.
const dated = datedReleases()
const newestDate = dated.reduce((a, b) => (a.dateEt >= b.dateEt ? a : b)).dateEt
const oldestDate = dated.reduce((a, b) => (a.dateEt <= b.dateEt ? a : b)).dateEt
const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

describe('release panel subject', () => {
  it('on the newest release day, skips it and subjects an older release; the newest is awaiting', () => {
    const subject = releaseSubjectOn(newestDate)
    expect(subject).not.toBeNull()
    expect(subject!.dateEt < newestDate).toBe(true)
    expect(releaseAwaitingFullDay(newestDate)?.dateEt).toBe(newestDate)
  })

  it('the day after, subjects the newest release with nothing waiting', () => {
    expect(releaseSubjectOn(nextDay(newestDate))?.dateEt).toBe(newestDate)
    expect(releaseAwaitingFullDay(nextDay(newestDate))).toBeNull()
  })

  it('is null before any release has a full day after it', () => {
    expect(releaseSubjectOn(oldestDate)).toBeNull()
  })

  it('latestDatedRelease reads the ET date of its now argument', () => {
    const during = etMidnightMs(newestDate) + 3 * 3_600_000
    expect(latestDatedRelease(during)).toEqual(releaseSubjectOn(newestDate))
    expect(latestDatedRelease(during + 86_400_000)?.dateEt).toBe(newestDate)
  })
})
