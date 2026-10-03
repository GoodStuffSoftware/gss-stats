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
    expect(rangeNoticeText(notice(), NOW)).toBe('Showing Jul 3 – Oct 3 only. Cloudflare analytics allows up to 93 days per query.')
  })

  it('the end is the last day INSIDE the range: an exclusive end at ET midnight shows the day before', () => {
    const n = notice({ served: { from: '2026-06-10T04:00:00.000Z', to: '2026-09-11T04:00:00.000Z' } })
    expect(rangeNoticeText(n, NOW)).toContain('Showing Jun 10 – Sep 10 only.')
  })

  it('a start at 04:00Z reads as that ET day, not the evening before', () => {
    const n = notice({ served: { from: '2026-04-03T04:00:00.000Z', to: '2026-05-01T04:00:00.000Z' } })
    expect(rangeNoticeText(n, NOW)).toContain('Showing Apr 3 – Apr 30 only.')
  })

  it('lookback and both reasons say what Cloudflare keeps', () => {
    expect(rangeNoticeText(notice({ reason: 'lookback' }), NOW)).toBe('Showing Jul 3 – Oct 3 only. Cloudflare analytics keeps only the last 184 days.')
    expect(rangeNoticeText(notice({ reason: 'both' }), NOW)).toBe('Showing Jul 3 – Oct 3 only. Cloudflare analytics allows up to 93 days per query and keeps only the last 184 days.')
  })

  it('shows years when the range is not wholly in the current year', () => {
    const n = notice({ served: { from: '2025-12-20T05:00:00.000Z', to: '2026-02-01T05:00:00.000Z' } })
    expect(rangeNoticeText(n, NOW)).toContain('Showing Dec 20, 2025 – Jan 31, 2026 only.')
  })

  it('a range wholly older than the lookback says so instead of showing a window', () => {
    const n = notice({ reason: 'outside-lookback', served: null })
    expect(rangeNoticeText(n, NOW)).toBe('No data shown. Cloudflare analytics keeps only the last 184 days, and this range is older than that.')
  })

  it('an upstream refusal gets the generic wording, with no raw error text', () => {
    const text = rangeNoticeText(notice({ reason: 'upstream-rejected', served: null, limitDays: null, lookbackDays: null }), NOW)
    expect(text).toBe('Cloudflare analytics could not serve this range (it limits how long and how far back a query can reach). Try a shorter, more recent range.')
    expect(text).not.toMatch(/graphql|account|\{/i)
  })

  it('unknown limits do not print "null"', () => {
    expect(rangeNoticeText(notice({ limitDays: null }), NOW)).not.toContain('null')
  })
})
