// The range gate's clamp math (functions/_lib/rangeGate.ts). All instants are written in UTC
// with the ET reading beside them: ET midnight is 04:00Z in EDT (Mar 8 – Nov 1 2026) and 05:00Z
// in EST, so "Jan 1 ET" is 2026-01-01T05:00Z and "Oct 4 ET" is 2026-10-04T04:00Z.
import { describe, expect, it } from 'vitest'
import { gateRange, isRangeLimitError, RANGE_LIMITS, upstreamRejectedNotice } from './rangeGate'

const T = (iso: string) => Date.parse(iso)
const DAY = 86_400_000
const MAX = RANGE_LIMITS['cf-rum'].maxDurationDays * DAY

// Noon EDT on Oct 3 2026. The lookback edge is then Apr 2 12:00 EDT, so the first whole ET day
// the source can serve is Apr 3 (2026-04-03T04:00Z).
const NOW = T('2026-10-03T16:00:00Z')
const END = T('2026-10-04T04:00:00Z') // "until Oct 3" inclusive, as ET midnight after it
const EARLIEST = '2026-04-03T04:00:00Z'

describe('RANGE_LIMITS', () => {
  it('holds the limits read from the account settings (93 d = 13w2d, 184 d = 26w2d)', () => {
    expect(RANGE_LIMITS['cf-rum']).toEqual({ dataset: 'rumPageloadEventsAdaptiveGroups', maxDurationDays: 93, notOlderThanDays: 184 })
    expect(93 * 86_400).toBe(8_035_200) // settings.maxDuration
    expect(184 * 86_400).toBe(15_897_600) // settings.notOlderThan
  })
})

describe('gateRange — maximum duration', () => {
  it('a span exactly at the limit is not touched', () => {
    const r = gateRange('cf-rum', END - MAX, END, NOW)
    expect(r.notice).toBeNull()
    expect(r.unservable).toBe(false)
    expect([r.fromMs, r.toMs]).toEqual([END - MAX, END])
  })

  it('a span one day over is cut to the most recent 93 days, ending at the requested end', () => {
    const r = gateRange('cf-rum', END - MAX - DAY, END, NOW)
    expect(r.unservable).toBe(false)
    expect([r.fromMs, r.toMs]).toEqual([END - MAX, END])
    expect(r.notice).toEqual({
      kind: 'range-clamped',
      source: 'cf-rum',
      reason: 'max-duration',
      requested: { from: '2026-07-02T04:00:00.000Z', to: '2026-10-04T04:00:00.000Z' },
      served: { from: '2026-07-03T04:00:00.000Z', to: '2026-10-04T04:00:00.000Z' },
      limitDays: 93,
      lookbackDays: 184,
    })
  })

  it('one second over is also cut, and the new start lands on an ET midnight', () => {
    const r = gateRange('cf-rum', END - MAX - 1000, END, NOW)
    expect(r.notice?.reason).toBe('max-duration')
    expect(new Date(r.fromMs).toISOString()).toBe('2026-07-03T04:00:00.000Z')
    expect(r.toMs - r.fromMs).toBeLessThanOrEqual(MAX)
  })

  it('an end that is not a midnight (a "now" range) keeps the end and rounds the start up to an ET day', () => {
    const end = T('2026-10-03T15:30:00Z')
    const r = gateRange('cf-rum', T('2026-06-01T04:00:00Z'), end, NOW)
    expect(r.toMs).toBe(end)
    expect(new Date(r.fromMs).toISOString()).toBe('2026-07-03T04:00:00.000Z') // end - 93d = Jul 2 11:30 EDT → the next ET midnight
    expect(r.toMs - r.fromMs).toBeLessThanOrEqual(MAX)
  })

  it('the span is elapsed time: 93 ET calendar days across spring-forward fit (92d 23h)', () => {
    const now = T('2026-04-10T16:00:00Z')
    const start = T('2026-01-01T05:00:00Z') // Jan 1 00:00 EST
    const end = T('2026-04-04T04:00:00Z') // Apr 4 00:00 EDT
    expect(end - start).toBe(MAX - 3_600_000)
    expect(gateRange('cf-rum', start, end, now).notice).toBeNull()
  })

  it('94 ET calendar days across spring-forward are cut, and the start is the next ET midnight (EST, 05:00Z)', () => {
    const now = T('2026-04-10T16:00:00Z')
    const r = gateRange('cf-rum', T('2026-01-01T05:00:00Z'), T('2026-04-05T04:00:00Z'), now)
    expect(r.notice?.reason).toBe('max-duration')
    // end - 93d = Jan 2 04:00Z = Jan 1 23:00 EST, so the first whole ET day after it is Jan 2 (05:00Z).
    expect(new Date(r.fromMs).toISOString()).toBe('2026-01-02T05:00:00.000Z')
  })
})

describe('gateRange — lookback (notOlderThan)', () => {
  it('a start on the first servable ET day is not touched', () => {
    const r = gateRange('cf-rum', T(EARLIEST), T('2026-05-01T04:00:00Z'), NOW)
    expect(r.notice).toBeNull()
  })

  it('a start one ET day earlier is moved forward to it', () => {
    const r = gateRange('cf-rum', T('2026-04-02T04:00:00Z'), T('2026-05-01T04:00:00Z'), NOW)
    expect(r.notice).toMatchObject({ reason: 'lookback', served: { from: '2026-04-03T04:00:00.000Z', to: '2026-05-01T04:00:00.000Z' } })
    expect(new Date(r.fromMs).toISOString()).toBe('2026-04-03T04:00:00.000Z')
  })

  it('the edge keeps a minute of slack for the API clock: at 00:00:30 ET the lookback day is not yet servable', () => {
    // Apr 2 00:00:30 EDT is 184 d before Oct 3 00:00:30 EDT; the start of Apr 2 is 30 s older than the limit.
    const now = T('2026-10-03T04:00:30Z')
    const r = gateRange('cf-rum', T('2026-04-02T04:00:00Z'), T('2026-05-01T04:00:00Z'), now)
    expect(r.notice?.reason).toBe('lookback')
    expect(new Date(r.fromMs).toISOString()).toBe('2026-04-03T04:00:00.000Z')
  })

  it('a range that is too wide AND too old is cut on both counts', () => {
    // "Jan 1 – Oct 3" asked on Oct 3: the start is past the lookback, and what is left is still > 93 d.
    const r = gateRange('cf-rum', T('2026-01-01T05:00:00Z'), END, NOW)
    expect(r.notice).toMatchObject({ reason: 'both', served: { from: '2026-07-03T04:00:00.000Z', to: '2026-10-04T04:00:00.000Z' } })
    expect(r.unservable).toBe(false)
  })

  it('a range entirely older than the lookback is unservable: nothing is queried', () => {
    const r = gateRange('cf-rum', T('2026-01-01T05:00:00Z'), T('2026-03-01T05:00:00Z'), NOW)
    expect(r.unservable).toBe(true)
    expect(r.notice).toMatchObject({ reason: 'outside-lookback', served: null, requested: { from: '2026-01-01T05:00:00.000Z', to: '2026-03-01T05:00:00.000Z' } })
  })

  it('a range ending exactly at the first servable day is also unservable (the end is exclusive)', () => {
    expect(gateRange('cf-rum', T('2026-03-01T05:00:00Z'), T(EARLIEST), NOW).unservable).toBe(true)
  })

  it('lookback in EST (winter): the edge is on the right ET day when the offset differs from the start', () => {
    // now = Jan 15 2027 noon EST → edge Jul 15 2026 noon EDT → first servable ET day is Jul 16 (04:00Z).
    const now = T('2027-01-15T17:00:00Z')
    const r = gateRange('cf-rum', T('2026-07-01T04:00:00Z'), T('2026-09-01T04:00:00Z'), now)
    expect(r.notice?.reason).toBe('lookback')
    expect(new Date(r.fromMs).toISOString()).toBe('2026-07-16T04:00:00.000Z')
  })
})

describe('gateRange — inputs it leaves alone', () => {
  it.each([
    ['an unparseable start', NaN, END],
    ['an unparseable end', T('2026-09-01T04:00:00Z'), NaN],
    ['an empty range', END, END],
    ['a reversed range', END, T('2026-09-01T04:00:00Z')],
  ])('%s passes through untouched for the query to handle', (_n, start, end) => {
    const r = gateRange('cf-rum', start, end, NOW)
    expect(r).toMatchObject({ notice: null, unservable: false })
  })

  it('never lets the served window exceed the limit or start before the lookback, for a spread of requests', () => {
    for (let startDaysAgo = 1; startDaysAgo <= 400; startDaysAgo += 7) {
      for (const spanDays of [1, 30, 92, 93, 94, 200, 400]) {
        const end = END
        const start = end - Math.max(spanDays, 1) * DAY - (startDaysAgo % 5) * 3_600_000
        const r = gateRange('cf-rum', start, Math.min(end, start + spanDays * DAY), NOW)
        if (r.unservable) continue
        expect(r.toMs - r.fromMs).toBeLessThanOrEqual(MAX)
        expect(r.fromMs).toBeGreaterThanOrEqual(T(EARLIEST))
      }
    }
  })
})

describe('isRangeLimitError', () => {
  it('recognises the two messages Cloudflare sends (real wording, account id redacted)', () => {
    expect(isRangeLimitError([{ message: 'account "a32b" cannot request a time range wider than 13w2d, but your query time range spans 38w2d15h32m42s924ms' }])).toBe(true)
    expect(isRangeLimitError([{ message: 'account "a32b" cannot request data older than 26w2d, but your query requests data from 28w4d6s ago' }])).toBe(true)
  })
  it('does not swallow other errors', () => {
    expect(isRangeLimitError([{ message: 'unknown field "foo"' }])).toBe(false)
    expect(isRangeLimitError([{ message: 'rate limit exceeded' }, { message: 'authentication error' }])).toBe(false)
    expect(isRangeLimitError(null)).toBe(false)
    expect(isRangeLimitError('cannot request data older than')).toBe(false)
  })
})

describe('upstreamRejectedNotice', () => {
  it('serves nothing and does not repeat constants that were just contradicted', () => {
    expect(upstreamRejectedNotice('cf-rum', T('2026-01-01T05:00:00Z'), END)).toEqual({
      kind: 'range-clamped',
      source: 'cf-rum',
      reason: 'upstream-rejected',
      requested: { from: '2026-01-01T05:00:00.000Z', to: '2026-10-04T04:00:00.000Z' },
      served: null,
      limitDays: null,
      lookbackDays: null,
    })
  })
})
