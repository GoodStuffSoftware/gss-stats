// A campaign's status is derived from its flight dates (campaignStatusOn), never hand-kept: the
// registry read on a pinned ET date (RETEST was shown 'active' after it closed; the F2 arms and
// the F3 Search flight were shown 'upcoming' while they ran).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { campaignById, campaignStatusOn, CAMPAIGNS } from './campaigns'
import { CAMPAIGN_FUNNEL, CAMPAIGN_SCORECARD } from './metrics/presets'
import { resolveRepeat, scopeField } from './metrics/scope'
import { noteRawText } from './notes'
import type { CardSpec } from './metrics/types'

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

// Both Campaigns-page cards read status and order from the registry alone (resolveRepeat over
// CAMPAIGNS, scopeField 'campaign.status' / 'campaign.statusToday', both campaignStatusOn): pinned
// for every campaign on several ET dates, with Flight 3's arms ahead of Flight 4 in each list.
describe('the scorecard and the funnel per campaign, from the registry', () => {
  const F4 = '24392866056'
  const PLAY_DIRECT = '24234347705' // spend-only too (no beacon rows)
  const ORDER = ['24215315197', PLAY_DIRECT, '24279250691', '24316608605', '24311309184', '24358792494', '24358792551', '24369758153', F4]
  const SPEND_ONLY = [PLAY_DIRECT, F4]
  const ids = (spec: CardSpec, todayEt: string) => resolveRepeat(spec.repeat, { todayEt }).flatMap((s) => (s.kind === 'campaign' ? [s.campaign.id] : []))
  const statusOf = (spec: CardSpec, todayEt: string, field: 'campaign.status' | 'campaign.statusToday') =>
    Object.fromEntries(resolveRepeat(spec.repeat, { todayEt }).flatMap((s) => (s.kind === 'campaign' ? [[s.campaign.id, scopeField(s, field, todayEt)]] : [])))
  const DATES = ['2026-10-01', '2026-10-08', '2026-10-20', '2026-10-29', '2026-11-03', '2026-11-10']
  // id -> the status on each of DATES
  const EXPECTED: Record<string, string[]> = {
    '24215315197': ['closed', 'closed', 'closed', 'closed', 'closed', 'closed'],
    [PLAY_DIRECT]: ['closed', 'closed', 'closed', 'closed', 'closed', 'closed'],
    '24279250691': ['active', 'closed', 'closed', 'closed', 'closed', 'closed'],
    '24316608605': ['upcoming', 'active', 'closed', 'closed', 'closed', 'closed'],
    '24311309184': ['upcoming', 'active', 'closed', 'closed', 'closed', 'closed'],
    '24358792494': ['upcoming', 'upcoming', 'active', 'closed', 'closed', 'closed'],
    '24358792551': ['upcoming', 'upcoming', 'active', 'active', 'active', 'closed'],
    '24369758153': ['upcoming', 'upcoming', 'active', 'closed', 'closed', 'closed'],
    [F4]: ['upcoming', 'upcoming', 'upcoming', 'active', 'closed', 'closed'],
  }

  it('the registry is in flight order, every Flight 3 arm before Flight 4', () => {
    expect(CAMPAIGNS.map((c) => c.id)).toEqual(ORDER)
    expect(CAMPAIGNS.filter((c) => c.measurement === 'spend-only').map((c) => c.id)).toEqual(SPEND_ONLY)
  })
  it('every campaign has the date-derived status on each date, in both cards', () => {
    DATES.forEach((d, i) => {
      const score = statusOf(CAMPAIGN_SCORECARD, d, 'campaign.status')
      const funnel = statusOf(CAMPAIGN_FUNNEL, d, 'campaign.status')
      for (const id of ORDER) {
        expect(campaignStatusOn(campaignById(id)!, d), `${id} ${d}`).toBe(EXPECTED[id][i])
        expect(score[id], `scorecard ${id} ${d}`).toBe(EXPECTED[id][i])
        expect(funnel[id], `funnel ${id} ${d}`).toBe(SPEND_ONLY.includes(id) ? undefined : EXPECTED[id][i])
      }
    })
  })
  it('the scorecard badge says "flighting today" exactly while a flight runs, else the status (10-29)', () => {
    const today = statusOf(CAMPAIGN_SCORECARD, '2026-10-29', 'campaign.statusToday')
    for (const id of ORDER) expect(today[id], id).toBe(EXPECTED[id][3] === 'active' ? 'flighting today' : EXPECTED[id][3])
  })
  it('the scorecard lists every campaign in registry order; the funnel the same order without the spend-only arms', () => {
    for (const d of DATES) {
      expect(ids(CAMPAIGN_SCORECARD, d)).toEqual(ORDER)
      expect(ids(CAMPAIGN_FUNNEL, d)).toEqual(ORDER.filter((id) => !SPEND_ONLY.includes(id)))
    }
  })
  it('the funnel says why F4 has no card, naming the spend-only arms from the registry', () => {
    expect(CAMPAIGN_FUNNEL.captions).toContain('funnel-spend-only-arms')
    const text = noteRawText('funnel-spend-only-arms')
    for (const id of SPEND_ONLY) expect(text).toContain(campaignById(id)!.label)
    expect(text).toContain('Campaign scorecard')
  })
})
