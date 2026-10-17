import { describe, expect, it } from 'vitest'
import { RELEASES, datedReleases, latestDatedRelease, newest, releaseAwaitingFullDay, releaseSubjectOn, type DatedRelease } from './releases'
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

describe('the flight 3 web releases', () => {
  const at = (v: string) => RELEASES.findIndex((r) => r.version === v)
  it('v1.99.1 web (live 2026-10-16 21:07Z) is a labelled marker on its ET day, listed before v1.99.2', () => {
    const r = RELEASES[at('v1.99.1')]
    expect(r).toMatchObject({ dateEt: '2026-10-16', major: true })
    expect(at('v1.99.1')).toBeGreaterThan(at('v1.98.0'))
    expect(at('v1.99.1')).toBeLessThan(at('v1.99.2'))
  })
  it('v1.99.0 has no marker of its own: it never went live (v1.99.1 carries it)', () => {
    expect(at('v1.99.0')).toBe(-1)
  })
  it('the release panel picks the newest: v1.99.2 wins the 10-16 tie with v1.99.1, waiting on 10-16 and the subject two days on', () => {
    expect(newest(datedReleases())?.version).toBe('v1.99.2')
    expect(releaseAwaitingFullDay('2026-10-16')?.version).toBe('v1.99.2')
    expect(releaseSubjectOn('2026-10-16')?.version).toBe('v1.98.0')
    expect(releaseSubjectOn('2026-10-18')?.version).toBe('v1.99.2')
  })
  it('no Play-store marker is dated yet', () => {
    expect(datedReleases().some((r) => /play/i.test(r.version))).toBe(false)
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
