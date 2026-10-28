// A campaign's status is derived from its flight dates (campaignStatusOn), never hand-kept: the
// registry read on a pinned ET date (RETEST was shown 'active' after it closed; the F2 arms and
// the F3 Search flight were shown 'upcoming' while they ran).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { campaignById, campaignStatusOn, CAMPAIGNS } from './campaigns'

afterEach(() => vi.useRealTimers())

describe('campaignStatusOn', () => {
  const c = { flightStart: '2026-10-17', flightEnd: '2026-11-06' }
  it('upcoming before the start day, active from the start day through the end day inclusive, closed after', () => {
    expect(campaignStatusOn(c, '2026-10-16')).toBe('upcoming')
    expect(campaignStatusOn(c, '2026-10-17')).toBe('active')
    expect(campaignStatusOn(c, '2026-11-06')).toBe('active')
    expect(campaignStatusOn(c, '2026-11-07')).toBe('closed')
  })
  it('a flight with no start yet is upcoming whatever the date', () => {
    expect(campaignStatusOn({ flightStart: null, flightEnd: '2026-11-06' }, '2027-01-01')).toBe('upcoming')
  })
})

describe('the registry statuses on 2026-10-28 (ET)', () => {
  const at = (iso: string) => vi.useFakeTimers({ now: Date.parse(iso), toFake: ['Date'] })
  it('closed flights are closed, the live Search flight and the Android installs flight are active', () => {
    at('2026-10-28T16:00:00Z')
    expect(campaignById('24279250691')!.status).toBe('closed') // RETEST, ended 10-02
    expect(campaignById('24316608605')!.status).toBe('closed') // F2 arm, ended 10-10
    expect(campaignById('24311309184')!.status).toBe('closed') // F2 arm, ended 10-10
    expect(campaignById('24358792551')!.status).toBe('active') // F3 Search, 10-17..11-06
    expect(campaignById('24392866056')!.status).toBe('active') // F4, 10-26..11-02
  })
  it('it moves with the date: F4 is closed on 11-03, and the day turns at ET midnight, not UTC', () => {
    at('2026-11-03T16:00:00Z')
    expect(campaignById('24392866056')!.status).toBe('closed')
    at('2026-11-03T03:30:00Z') // 23:30 ET on 11-02: still the last day
    expect(campaignById('24392866056')!.status).toBe('active')
  })
  it('every registered campaign agrees with the derivation', () => {
    at('2026-10-28T16:00:00Z')
    for (const c of CAMPAIGNS) expect(c.status, c.id).toBe(campaignStatusOn(c, '2026-10-28'))
  })
})
