// The Play-direct arm's Play install lines (playDirect.ts): the PARTIAL / INSTALL VERDICT label, the
// "not landed yet" text, the closed twin's baseline and the report lines. Pure: Play reads are faked and
// every id and tag is made up; no network, no credentials.
import { describe, expect, it } from 'vitest'
import { CAMPAIGNS, type CampaignFlight } from '../../src/lib/campaigns'
import type { PlayReportsSection } from './play'
import {
  BASELINE_TAIL_DAYS,
  PLAY_ACQUISITION_NOTE,
  PLAY_BASELINE_NET_DEVICE_NOTE,
  PLAY_NOT_LANDED_TEXT,
  buildPlayDirectBlock,
  closedPlayDirectCampaigns,
  costPerTaggedFirstOpenLine,
  playDirectBaseline,
  playDirectInstalls,
  playDirectLines,
  playReadLabel,
} from './playDirect'

const UC = 'made_up_play_uc'
const campaign = (over: Partial<CampaignFlight> = {}): CampaignFlight => ({
  id: '99900000013',
  label: 'Made-up Play-direct arm',
  ucValues: [UC],
  flightStart: '2026-10-20',
  flightStartTimeEt: '12:00',
  flightEnd: '2026-10-23',
  status: 'active',
  kind: 'play-direct',
  dailyBudgetUsd: 10,
  hardCapUsd: 40,
  servingHoursEt: [12, 24],
  notes: 'test fixture only',
  ...over,
})
const twin = campaign({ id: '99900000099', label: 'Made-up closed twin', ucValues: ['sudoku_tired_of_ads_play'], flightStart: '2026-09-09', flightEnd: '2026-09-13', status: 'closed' })

const section = (over: Partial<PlayReportsSection> = {}): PlayReportsSection => ({
  ok: true,
  error: null,
  bucket: 'pubsite_prod_test',
  installsThrough: '2026-10-25',
  storePerformanceThrough: '2026-10-25',
  installsLagDays: 4,
  storePerformanceLagDays: 4,
  installsByDay: [],
  acquisitionByCountry: [],
  acquisitionBySource: [],
  acquisitionByUtmCampaign: [{ utmCampaign: UC, visitors: 40, acquisitions: 3, firstDate: '2026-10-20', lastDate: '2026-10-24' }],
  retentionNote: 'x',
  householdNote: 'x',
  checkpoints: [],
  errors: [],
  ...over,
})

describe('playReadLabel: PARTIAL until Play runs a week past the flight end', () => {
  it('flight end 2026-10-23 needs a horizon of 2026-10-30', () => {
    expect(playReadLabel('2026-10-29', '2026-10-23')).toBe('PARTIAL')
    expect(playReadLabel('2026-10-30', '2026-10-23')).toBe('INSTALL VERDICT')
    expect(playReadLabel('2026-11-15', '2026-10-23')).toBe('INSTALL VERDICT')
  })
  it('no horizon at all is PARTIAL', () => {
    expect(playReadLabel(null, '2026-10-23')).toBe('PARTIAL')
  })
})

describe('playDirectInstalls', () => {
  it('sums the arm\'s own utm_campaign rows and ignores other tags', () => {
    const p = section({
      acquisitionByUtmCampaign: [
        { utmCampaign: UC, visitors: 40, acquisitions: 3, firstDate: '2026-10-20', lastDate: '2026-10-22' },
        { utmCampaign: 'other_arm', visitors: 99, acquisitions: 9, firstDate: '2026-10-20', lastDate: '2026-10-22' },
      ],
    })
    const r = playDirectInstalls(p, [UC], '2026-10-23')
    expect(r).toMatchObject({ read: true, state: 'counts', acquisitions: 3, visitors: 40, label: 'PARTIAL' })
    expect(r.rows).toHaveLength(1)
  })
  it('no row while the horizon is short of the flight end = no row yet; at or past it = no row at horizon', () => {
    const none = { acquisitionByUtmCampaign: [] }
    expect(playDirectInstalls(section({ ...none, storePerformanceThrough: '2026-10-04' }), [UC], '2026-10-23')).toMatchObject({ state: 'no row yet', acquisitions: null })
    expect(playDirectInstalls(section({ ...none, storePerformanceThrough: '2026-10-23' }), [UC], '2026-10-23')).toMatchObject({ state: 'no row at horizon', acquisitions: null })
    expect(playDirectInstalls(section({ ...none, storePerformanceThrough: null }), [UC], '2026-10-23').state).toBe('no row yet')
  })
  it('a failed or missing read is "not read" and carries the reason', () => {
    expect(playDirectInstalls(null, [UC], '2026-10-23')).toMatchObject({ read: false, state: 'not read', error: 'not read' })
    expect(playDirectInstalls(section({ ok: false, error: 'GCS 403' }), [UC], '2026-10-23')).toMatchObject({ read: false, state: 'not read', error: 'GCS 403' })
  })
})

describe('closedPlayDirectCampaigns', () => {
  it('finds the real closed twin by kind and status, and no open or web campaign', () => {
    const found = closedPlayDirectCampaigns(CAMPAIGNS)
    expect(found.length).toBeGreaterThan(0)
    expect(found.every((c) => c.kind === 'play-direct' && c.status === 'closed')).toBe(true)
    expect(closedPlayDirectCampaigns([campaign(), twin, campaign({ id: '1', kind: 'web', status: 'closed' })]).map((c) => c.id)).toEqual([twin.id])
  })
})

describe('playDirectBaseline', () => {
  it('reads the twin\'s dates (plus the tail) and its own tag, and carries the stored spend', async () => {
    let seen: { since: string; until: string; flightStart: string; cumulativeSpend: number } | null = null
    const read = async (o: { since: string; until: string; flightStart: string; cumulativeSpend: number }) => {
      seen = o
      return section({ acquisitionByUtmCampaign: [{ utmCampaign: 'sudoku_tired_of_ads_play', visitors: 120, acquisitions: 2, firstDate: '2026-09-09', lastDate: '2026-09-19' }], storePerformanceThrough: '2026-09-19' })
    }
    const b = await playDirectBaseline(twin, read, 75.17)
    expect(seen).toEqual({ since: '2026-09-09', until: '2026-10-04', flightStart: '2026-09-09', cumulativeSpend: 75.17 })
    expect(BASELINE_TAIL_DAYS).toBe(21)
    expect(b).toMatchObject({ read: true, error: null, spend: 75.17, listingAcquisitions: 2, listingVisitors: 120, taggedAppRows: 'none' })
  })
  it('a Play read that throws or fails is carried in the result, never thrown', async () => {
    const thrown = await playDirectBaseline(twin, async () => { throw new Error('GCS 403') }, 10)
    expect(thrown).toMatchObject({ read: false, error: 'GCS 403', listingAcquisitions: null })
    const notOk = await playDirectBaseline(twin, async () => section({ ok: false, error: 'bucket gone' }), 10)
    expect(notOk).toMatchObject({ read: false, error: 'bucket gone' })
  })
  it('no Play source (--play-sa not given) is "not read" without calling anything', async () => {
    expect(await playDirectBaseline(twin, null, 10)).toMatchObject({ read: false, error: '--play-sa not given' })
  })
  it('a twin with no row in the UTM file has null listing figures', async () => {
    const b = await playDirectBaseline(twin, async () => section({ acquisitionByUtmCampaign: [] }), 10)
    expect(b).toMatchObject({ read: true, listingAcquisitions: null, listingVisitors: null })
  })
  it('the real twin\'s default spend is the stored $75.17', async () => {
    const real = closedPlayDirectCampaigns(CAMPAIGNS)[0]
    const b = await playDirectBaseline(real, async () => section({ acquisitionByUtmCampaign: [] }))
    expect(b.spend).toBe(75.17)
  })
})

describe('playDirectLines', () => {
  const block = (p: PlayReportsSection | null, baseline = null as Awaited<ReturnType<typeof playDirectBaseline>> | null) =>
    buildPlayDirectBlock({ campaign: campaign(), playReports: p, clicks: 120, d0Rows: 14, signIns: { count: 2, note: 'at most' }, baseline })
  const text = (b: ReturnType<typeof block>) => playDirectLines(b).join('\n')

  it('prints nothing for a web arm (no block)', () => {
    expect(playDirectLines(undefined)).toEqual([])
    expect(playDirectLines(null)).toEqual([])
  })
  it('counts, the PARTIAL label with the date it needs, and the acquisitions-vs-device-installs note', () => {
    const t = text(block(section({ storePerformanceThrough: '2026-10-25' })))
    expect(t).toContain('Tagged first opens (/return/<uc>/d0 rows for made_up_play_uc): 14 from 120 clicks; tagged sign-ins (new accounts): 2 (at most)')
    expect(t).toContain('3 acquisitions of 40 listing visitors; PARTIAL')
    expect(t).toContain('needs 2026-10-30')
    expect(t).not.toContain('INSTALL VERDICT')
    expect(t).toContain(PLAY_ACQUISITION_NOTE)
    expect(t).toContain('they differ from device installs')
  })
  it('INSTALL VERDICT once the horizon is a week past the flight end', () => {
    const t = text(block(section({ storePerformanceThrough: '2026-10-30' })))
    expect(t).toContain('3 acquisitions of 40 listing visitors; INSTALL VERDICT')
    expect(t).not.toContain('PARTIAL')
  })
  it('no row yet prints the exact "not landed yet (lags 6-14 days)" text', () => {
    const t = text(block(section({ acquisitionByUtmCampaign: [], storePerformanceThrough: '2026-10-04' })))
    expect(PLAY_NOT_LANDED_TEXT).toBe('not landed yet (lags 6-14 days)')
    expect(t).toContain('not landed yet (lags 6-14 days)')
    expect(t).toContain('runs through 2026-10-04')
  })
  it('no row at the horizon is a labelled zero, not "not landed"', () => {
    const t = text(block(section({ acquisitionByUtmCampaign: [], storePerformanceThrough: '2026-10-25' })))
    expect(t).toContain('no row for the tag in Play\'s store-listing file through 2026-10-25 (0 acquisitions as printed; Play folds small tags into Other); PARTIAL')
    expect(t).not.toContain('not landed yet')
  })
  it('a failed Play read says not read and also carries the not-landed text', () => {
    const t = text(block(section({ ok: false, error: 'GCS 403' })))
    expect(t).toContain('not read (GCS 403); not landed yet (lags 6-14 days)')
  })
  it('missing counts print a dash and "not read"', () => {
    const b = buildPlayDirectBlock({ campaign: campaign(), playReports: section(), clicks: null, d0Rows: null, signIns: null, baseline: null })
    expect(playDirectLines(b).join('\n')).toContain('Tagged first opens (/return/<uc>/d0 rows for made_up_play_uc): —; tagged sign-ins (new accounts): not read')
  })
  it('the baseline prints the data figures first and the hand-derived net device installs apart, as a quoted note naming its source', async () => {
    const baseline = await playDirectBaseline(
      twin,
      async () => section({ acquisitionByUtmCampaign: [{ utmCampaign: 'sudoku_tired_of_ads_play', visitors: 120, acquisitions: 2, firstDate: '2026-09-09', lastDate: '2026-09-19' }] }),
      75.17,
    )
    const t = text(block(section(), baseline))
    expect(t).toContain('2 acquisitions / 120 listing visitors (UTM file)')
    expect(t).toContain('$75.17 spent')
    expect(t).not.toContain('76.25')
    expect(t).toContain(PLAY_BASELINE_NET_DEVICE_NOTE)
    expect(t).toContain('"8 net device installs" (hand-derived in the September review of the closed twin, not from the Play file)')
    expect(t.indexOf('2 acquisitions / 120')).toBeLessThan(t.indexOf('8 net device installs'))
    expect(t).toContain('tagged app rows: none')
  })
  it('a later closed Play-direct arm gets the data figures but neither the September note nor "tagged app rows: none"', async () => {
    const later = campaign({ id: '99900000055', label: 'Made-up later arm', ucValues: ['made_up_later_uc'], flightStart: '2026-10-20', flightEnd: '2026-10-23', status: 'closed' })
    const baseline = await playDirectBaseline(later, async () => section({ acquisitionByUtmCampaign: [{ utmCampaign: 'made_up_later_uc', visitors: 50, acquisitions: 4, firstDate: '2026-10-20', lastDate: '2026-10-25' }] }), 40)
    const t = text(block(section(), baseline))
    expect(t).toContain('4 acquisitions / 50 listing visitors (UTM file)')
    expect(t).not.toContain('net device installs')
    expect(t).not.toContain('tagged app rows')
  })
  it('a baseline whose Play read failed says so', async () => {
    const baseline = await playDirectBaseline(twin, null, 75.17)
    expect(text(block(section(), baseline))).toContain('Baseline (closed Play-direct twin Made-up closed twin, 2026-09-09..2026-09-13, $75.17 spent, utm_campaign sudoku_tired_of_ads_play): not read (--play-sa not given)')
  })
  describe('WATCH line: cost per tagged first open', () => {
    const withSpend = (spend: number | null, d0Rows: number | null, baseline = null as Awaited<ReturnType<typeof playDirectBaseline>> | null) =>
      buildPlayDirectBlock({ campaign: campaign(), playReports: section(), clicks: 120, spend, d0Rows, signIns: null, baseline })
    it('is spend over the tagged first opens, labelled watch only, with no baseline line when there is no twin', () => {
      const t = costPerTaggedFirstOpenLine(withSpend(60, 8))
      expect(t).toBe('  WATCH \u00b7 cost per tagged first open: $7.50 ($60.00 closed-day spend / 8 tagged first opens); watch only, a first open is not an install')
    })
    it('0 first opens prints "no tagged first opens yet", never a divide-by-zero', () => {
      const t = costPerTaggedFirstOpenLine(withSpend(60, 0))
      expect(t).toBe('  WATCH \u00b7 cost per tagged first open: no tagged first opens yet')
      expect(t).not.toMatch(/Infinity|NaN/)
      expect(costPerTaggedFirstOpenLine(withSpend(0, 0))).toContain('no tagged first opens yet')
    })
    it('unread counts say so; the line is part of the Play-direct block', () => {
      expect(costPerTaggedFirstOpenLine(withSpend(60, null))).toContain('tagged first opens not read')
      expect(costPerTaggedFirstOpenLine(withSpend(null, 5))).toContain('spend not read (5 tagged first opens)')
      expect(playDirectLines(withSpend(60, 8)).join('\n')).toContain('WATCH \u00b7 cost per tagged first open: $7.50')
    })
    it('the September twin is the reference, quoted as hand-derived from the same source as the net device installs; a later twin gets none', async () => {
      const sept = await playDirectBaseline(twin, async () => section(), 75.17)
      const t = costPerTaggedFirstOpenLine(withSpend(60, 8, sept))
      expect(t).toContain("reference, the September twin's ~$9.50 per net install")
      expect(t).toContain('hand-derived in the September review')
      expect(t).toContain('the same source note as the net device installs figure in the Baseline line')
      expect(costPerTaggedFirstOpenLine(withSpend(60, 0, sept))).toContain('no tagged first opens yet; reference, the September twin')
      const later = campaign({ id: '99900000055', label: 'Made-up later arm', ucValues: ['made_up_later_uc'], flightStart: '2026-10-20', flightEnd: '2026-10-23', status: 'closed' })
      const lb = await playDirectBaseline(later, async () => section(), 40)
      expect(costPerTaggedFirstOpenLine(withSpend(60, 8, lb))).not.toContain('September')
    })
  })
  it('counts only: the lines carry no visitor id, hour, place or device split', () => {
    const t = text(block(section()))
    expect(t).not.toMatch(/visitor id|by hour|by device|by country/i)
  })
})
