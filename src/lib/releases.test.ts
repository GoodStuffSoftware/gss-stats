import { describe, expect, it } from 'vitest'
import { RELEASES, datedReleases, latestDatedRelease, newest, releaseAwaitingFullDay, releaseSubjectOn, type DatedRelease } from './releases'
import { etMidnightMs } from './metrics/instrumentation'
import { MEASUREMENT_CHANGES } from './measurementChanges'

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
  it('the release panel picks the newest: v1.99.4 Play (10-18 15:15:55Z, listed after v1.99.4 web 14:57:49Z so it wins the same-day tie) is newest; v1.99.3 Play (10-17 06:09:41Z, listed after v1.99.3 web 05:58:55Z so it wins that same-day tie); v1.99.2 wins the 10-16 tie with v1.99.1 as the subject once its day is full', () => {
    expect(newest(datedReleases())?.version).toBe('v1.105.1 Play')
    expect(releaseAwaitingFullDay('2026-10-16')?.version).toBe('v1.105.1 Play')
    expect(releaseSubjectOn('2026-10-16')?.version).toBe('v1.98.0')
    expect(releaseSubjectOn('2026-10-18')?.version).toBe('v1.99.2')
    expect(releaseSubjectOn('2026-10-19')?.version).toBe('v1.99.3 Play')
    expect(releaseSubjectOn('2026-10-20')?.version).toBe('v1.99.4 Play')
    expect(releaseSubjectOn('2026-10-27')?.version).toBe('v1.99.4 Play')
    expect(releaseSubjectOn('2026-10-28')?.version).toBe('v1.103.0 Play')
    expect(releaseSubjectOn('2026-10-29')?.version).toBe('v1.104.0 Play')
    expect(releaseSubjectOn('2026-10-30')?.version).toBe('v1.105.0 web')
  })
  it('v1.103.0 web and v1.103.0 Play are plain markers dated 2026-10-26 (web 22:19:36Z, Play 22:28:21Z; Play is newest), with no v1.102.0 entry and no coach or counting measurement change (the Android sign-in cancel entry is authErrorOnly and mints no marker)', () => {
    expect(datedReleases().find((r) => r.version === 'v1.103.0 web')).toMatchObject({ dateEt: '2026-10-26' })
    expect(datedReleases().some((r) => r.version.startsWith('v1.102.0'))).toBe(false)
    expect(datedReleases().find((r) => r.version === 'v1.103.0 Play')).toMatchObject({ dateEt: '2026-10-26' })
    expect(at('v1.103.0 Play')).toBeGreaterThan(at('v1.103.0 web'))
    expect(datedReleases().find((r) => r.version === 'v1.103.0 Play')!.note).toContain('from the no-code row to the user-cancelled row')
    expect(MEASUREMENT_CHANGES.filter((c) => c.id.startsWith('v1.103') && !c.authErrorOnly)).toEqual([])
    expect(RELEASES.filter((r) => r.version.startsWith('v1.103.0 ')).map((r) => r.version)).toEqual(['v1.103.0 web', 'v1.103.0 Play']) // one Play marker, not two
    expect(at('v1.103.0 web')).toBeGreaterThan(at('v1.99.4 Play'))
  })
  it('v1.104.0 web and v1.104.0 Play are plain markers dated 2026-10-27 (web 17:04:17Z, Play 17:18:40Z; Play is newest), with notes on the guest paywall prices and no measurement change', () => {
    const web = datedReleases().find((r) => r.version === 'v1.104.0 web')!
    const play = datedReleases().find((r) => r.version === 'v1.104.0 Play')!
    expect(web).toMatchObject({ dateEt: '2026-10-27' })
    expect(play).toMatchObject({ dateEt: '2026-10-27' })
    expect(at('v1.104.0 Play')).toBeGreaterThan(at('v1.104.0 web'))
    expect(at('v1.104.0 web')).toBeGreaterThan(at('v1.103.0 Play'))
    for (const r of [web, play]) {
      expect(r.note).toContain('Pass tapped, sign-in first')
      expect(r.note).toContain('Paywall shown rises')
      expect(r.note).not.toContain('/auth/')
    }
    expect(MEASUREMENT_CHANGES.some((c) => c.id.startsWith('v1.104'))).toBe(false)
    expect(RELEASES.filter((r) => r.version.startsWith('v1.104.0 ')).map((r) => r.version)).toEqual(['v1.104.0 web', 'v1.104.0 Play'])
  })
  it('v1.105.1 web (03:24:33Z) and v1.105.1 Play (03:31:18Z, 1105001) are plain markers on the ET day 2026-10-29, web listed first so the later-timed Play entry wins the tie; Play is when Flight 4 tagged counts start', () => {
    const web = datedReleases().find((r) => r.version === 'v1.105.1 web')!
    const play = datedReleases().find((r) => r.version === 'v1.105.1 Play')!
    expect(web).toMatchObject({ dateEt: '2026-10-29' })
    expect(play).toMatchObject({ dateEt: '2026-10-29' })
    expect(at('v1.105.1 Play')).toBeGreaterThan(at('v1.105.1 web'))
    expect(at('v1.105.1 web')).toBeGreaterThan(at('v1.105.0 web'))
    expect(web.note).toContain('03:24:33Z')
    expect(play.note).toContain('03:31:18Z')
    expect(play.note).toContain('1105001')
    expect(play.note).toContain('sudoku_funnel_f4_android')
    expect(RELEASES.filter((r) => r.version.startsWith('v1.105.1')).map((r) => r.version)).toEqual(['v1.105.1 web', 'v1.105.1 Play'])
    expect(MEASUREMENT_CHANGES.some((c) => c.id.startsWith('v1.105.1'))).toBe(false)
    expect(releaseSubjectOn('2026-10-30')?.version).toBe('v1.105.0 web') // 10-29 is not a full day yet
    expect(releaseSubjectOn('2026-10-31')?.version).toBe('v1.105.1 Play')
  })
  it('v1.105.0 Play (21:55:45Z) and v1.105.0 web (21:58:36Z) are markers dated 2026-10-28, web listed after Play because it went live later and so wins the same-day tie; the one counting change is a hidden measurement entry that mints no marker of its own', () => {
    const web = datedReleases().find((r) => r.version === 'v1.105.0 web')!
    const play = datedReleases().find((r) => r.version === 'v1.105.0 Play')!
    expect(web).toMatchObject({ dateEt: '2026-10-28' })
    expect(play).toMatchObject({ dateEt: '2026-10-28' })
    expect(at('v1.105.0 web')).toBeGreaterThan(at('v1.105.0 Play'))
    expect(at('v1.105.0 Play')).toBeGreaterThan(at('v1.104.0 Play'))
    for (const r of [web, play]) {
      expect(r.note).toContain('/app/error/sw-update-transient')
      expect(r.note).toContain('a second consecutive failure still does')
    }
    expect(web.note).toContain('21:58:36Z')
    expect(play.note).toContain('21:55:45Z')
    expect(play.note).toContain('1105000')
    expect(RELEASES.filter((r) => r.version.startsWith('v1.105.0')).map((r) => r.version)).toEqual(['v1.105.0 Play', 'v1.105.0 web']) // the measurement entry mints no third marker
    const change = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.105.0')!
    expect(change).toMatchObject({ dateEt: '2026-10-28', errorRowsOnly: true })
    expect(change.authErrorOnly).toBeUndefined()
    expect(change.coachOnly).toBeUndefined()
  })
  it('v1.99.4 web is a plain marker dated 2026-10-18 (live 14:57:49Z, rules 14:58:51Z), not a measurement change', () => {
    expect(datedReleases().find((r) => r.version === 'v1.99.4 web')).toMatchObject({
      dateEt: '2026-10-18',
      note: 'Web live 14:57:49Z 10-18 (rules 14:58:51Z). No change to the counting beacon.',
    })
    expect(MEASUREMENT_CHANGES.some((c) => c.id.startsWith('v1.99.4'))).toBe(false)
  })
  it('v1.99.4 Play is a plain marker dated 2026-10-18 (promoted 15:15:55Z, 19904), listed after v1.99.4 web', () => {
    expect(datedReleases().find((r) => r.version === 'v1.99.4 Play')).toMatchObject({
      dateEt: '2026-10-18',
      note: "Play production 15:15:55Z 10-18 (19904); public on Play 15:43Z 10-18. No change to the counting beacon.",
    })
    expect(at('v1.99.4 Play')).toBeGreaterThan(at('v1.99.4 web'))
  })
  it('v1.99.3 web is dated 2026-10-17 (live 05:58:55Z); the v1.99.3 Play marker is dated separately below', () => {
    expect(at('v1.99.3 web')).toBeGreaterThan(-1)
    expect(datedReleases().find((r) => r.version === 'v1.99.3 web')?.dateEt).toBe('2026-10-17')
  })
  it('the Play markers are dated (v1.99.2 and v1.99.3 on 2026-10-17, v1.99.4 on 2026-10-18, v1.103.0 on 2026-10-26, v1.104.0 on 2026-10-27, v1.105.0 on 2026-10-28, v1.105.1 on 2026-10-29), v1.99.3 Play listed after v1.99.3 web (the later-timed one wins the same-day tie)', () => {
    expect(datedReleases().filter((r) => /play/i.test(r.version))).toMatchObject([{ version: 'v1.99.2 Play', dateEt: '2026-10-17' }, { version: 'v1.99.3 Play', dateEt: '2026-10-17' }, { version: 'v1.99.4 Play', dateEt: '2026-10-18' }, { version: 'v1.103.0 Play', dateEt: '2026-10-26' }, { version: 'v1.104.0 Play', dateEt: '2026-10-27' }, { version: 'v1.105.0 Play', dateEt: '2026-10-28' }, { version: 'v1.105.1 Play', dateEt: '2026-10-29' }])
    expect(at('v1.99.3 Play')).toBeGreaterThan(at('v1.99.3 web'))
    expect(at('v1.99.3 web')).toBeGreaterThan(at('v1.99.2 Play'))
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
