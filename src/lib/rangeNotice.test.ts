import { describe, expect, it } from 'vitest'
import { rangeNoticeText, type RangeNotice } from './rangeNotice'

// Noon EDT on Oct 3 2026: the current year is 2026.
const NOW = Date.parse('2026-10-03T16:00:00Z')

const notice = (over: Partial<RangeNotice> = {}): RangeNotice => ({
  kind: 'range-clamped',
  source: 'cf-rum',
  reason: 'max-duration',
  requested: { from: '2026-01-01T05:00:00.000Z', to: '2026-10-04T04:00:00.000Z' },
  served: { from: '2026-07-03T04:00:00.000Z', to: '2026-10-04T04:00:00.000Z' },
  limitDays: 93,
  lookbackDays: 184,
  ...over,
})

describe('rangeNoticeText', () => {
  it('names the served days (ET) and the per-query limit', () => {
    expect(rangeNoticeText(notice(), NOW)).toBe('Jul 3 – Oct 3 shown (Cloudflare limit: 93 days).')
  })

  it('the end is the last day INSIDE the range: an exclusive end at ET midnight shows the day before', () => {
    const n = notice({ served: { from: '2026-06-10T04:00:00.000Z', to: '2026-09-11T04:00:00.000Z' } })
    expect(rangeNoticeText(n, NOW)).toContain('Jun 10 – Sep 10 shown')
  })

  it('a start at 04:00Z reads as that ET day, not the evening before', () => {
    const n = notice({ served: { from: '2026-04-03T04:00:00.000Z', to: '2026-05-01T04:00:00.000Z' } })
    expect(rangeNoticeText(n, NOW)).toContain('Apr 3 – Apr 30 shown')
  })

  it("a 'date' series names UTC days, matching its bars: a UTC-midnight start reads as that day, not the evening before in ET", () => {
    const n = notice({ dayZone: 'utc', served: { from: '2026-06-30T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' } })
    // Read in ET the same start would be "Jun 29" and the end "Sep 30".
    expect(rangeNoticeText(n, NOW)).toContain('Jun 30 – Sep 30 shown')
    expect(rangeNoticeText({ ...n, dayZone: undefined }, NOW)).toContain('Jun 29 – Sep 30 shown')
  })

  it('lookback and both reasons say what Cloudflare keeps', () => {
    expect(rangeNoticeText(notice({ reason: 'lookback' }), NOW)).toBe('Jul 3 – Oct 3 shown (Cloudflare keeps 184 days).')
    expect(rangeNoticeText(notice({ reason: 'both' }), NOW)).toBe('Jul 3 – Oct 3 shown (Cloudflare limits: 93-day span, 184 days kept).')
  })

  it('shows years when the range is not wholly in the current year', () => {
    const n = notice({ served: { from: '2025-12-20T05:00:00.000Z', to: '2026-02-01T05:00:00.000Z' } })
    expect(rangeNoticeText(n, NOW)).toContain('Dec 20, 2025 – Jan 31, 2026 shown')
  })

  it('a range wholly older than the lookback says so instead of showing a window', () => {
    const n = notice({ reason: 'outside-lookback', served: null })
    expect(rangeNoticeText(n, NOW)).toBe('No data shown (Cloudflare keeps 184 days).')
  })

  it('an upstream refusal gets the generic wording, with no raw error text', () => {
    const text = rangeNoticeText(notice({ reason: 'upstream-rejected', served: null, limitDays: null, lookbackDays: null }), NOW)
    expect(text).toBe("No data shown (Cloudflare couldn't serve this range; try a shorter, more recent one).")
    expect(text).not.toMatch(/graphql|account|\{/i)
  })

  it('unknown limits do not print "null"', () => {
    expect(rangeNoticeText(notice({ limitDays: null }), NOW)).not.toContain('null')
  })
})
