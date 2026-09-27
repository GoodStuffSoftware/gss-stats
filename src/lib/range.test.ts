// lib/range.ts — relative range tokens, including "since first campaign": a window from ET
// midnight of the earliest configured flight start to now, which grows instead of rolling.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { firstCampaignStartMs, isSinceFirstCampaign, rangeLabel, relativeRange, SINCE_FIRST_CAMPAIGN } from './range'
import { CAMPAIGNS } from './campaigns'
import { defaultCampaignsWidgets, flightDayWidget, hourOfDayWidget } from './defaults'

const NOW = Date.parse('2028-06-15T12:00:00Z') // well over a year after every configured flight
beforeEach(() => vi.useFakeTimers({ now: NOW, toFake: ['Date'] }))
afterEach(() => vi.useRealTimers())

describe('since first campaign', () => {
  const earliest = CAMPAIGNS.map((c) => c.flightStart).filter((d): d is string => !!d).sort()[0]

  it('starts at ET midnight of the earliest configured flight start', () => {
    expect(earliest).toBe('2026-09-02')
    expect(new Date(firstCampaignStartMs()!).toISOString()).toBe('2026-09-02T04:00:00.000Z') // EDT midnight
  })

  it('relativeRange reads it (any casing, with or without "since"), until = now', () => {
    for (const t of [SINCE_FIRST_CAMPAIGN, 'Since first campaign', 'first campaign', 'since the first campaign']) {
      expect(isSinceFirstCampaign(t), t).toBe(true)
      expect(relativeRange(t), t).toEqual({ since: '2026-09-02T04:00:00.000Z', until: new Date(NOW).toISOString() })
    }
    expect(isSinceFirstCampaign('7d')).toBe(false)
    expect(relativeRange('7d')!.since).toBe(new Date(NOW - 7 * 86_400_000).toISOString())
  })

  it('labels itself "Since first campaign", not "Last 21mo"', () => {
    const r = relativeRange(SINCE_FIRST_CAMPAIGN)!
    expect(rangeLabel(r.since, r.until)).toMatch(/^Last \d+mo$/)
    expect(rangeLabel(r.since, r.until, SINCE_FIRST_CAMPAIGN)).toBe('Since first campaign')
    expect(rangeLabel(r.since, r.until, '12mo')).toMatch(/^Last \d+mo$/)
  })

  it('the two campaign arrivals charts read since the first campaign, not a rolling year', () => {
    const charts = [hourOfDayWidget({ x: 0, y: 0, w: 12, h: 8 }), flightDayWidget({ x: 0, y: 0, w: 12, h: 10 })]
    const shipped = defaultCampaignsWidgets().filter((w) => w.id === 'cw-hour' || w.id === 'cw-flightday')
    expect(shipped).toHaveLength(2)
    for (const w of [...charts, ...shipped]) {
      expect(w.filters?.rangeRel, w.id).toBe(SINCE_FIRST_CAMPAIGN)
      expect(w.filters?.since, w.id).toBe('2026-09-02T04:00:00.000Z') // the Android launch's first day stays in
      expect(w.filters?.until, w.id).toBe(new Date(NOW).toISOString())
    }
  })
})
