// Value tokens (notes plan slice 1d, release 1): the `{=…}` grammar, the formats, the chart's own
// values and the fixed dates. The injection boundary is tested where tokens render
// (textLite.test.ts) and the card render in ChartCard.valueTokens.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StatsResponse, Widget } from '../types'
import {
  VALUE_TOKEN_OPTIONS,
  chartValueResolver,
  chartValues,
  formatDateYmd,
  formatValue,
  globalValues,
  parseValueToken,
  resolveValueToken,
  type TokenValues,
} from './valueTokens'
import { datedReleases, newest } from './releases'
import { dayDrillRange, relativeRange } from './range'
import { PLAY_TRACKING_ACTIVATION_DATE_ET, TRACKING_ACTIVATION_DATE_ET } from './popupEvents'
import { rangeNoticeText, type RangeNotice } from './rangeNotice'

const widget = (over: Partial<Widget> = {}): Widget =>
  ({ id: 'w', i: 'w', title: 'T', type: 'bar', dataset: 'geo', dimension: 'country', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 6, h: 6, ...over }) as Widget

const response = (over: Partial<StatsResponse> = {}): StatsResponse =>
  ({
    rows: [
      { key: { country: 'US' }, pageviews: 600, visits: 300 },
      { key: { country: 'CA' }, pageviews: 250, visits: 400 },
      { key: { country: 'US' }, pageviews: 150, visits: 10 },
    ],
    totals: { pageviews: 1000, visits: 710 },
    meta: { site: 'all', host: null, since: '2026-09-01T00:00:00.000Z', until: '2026-09-30T23:59:59.999Z', dimensions: ['country'], metric: 'pageviews' },
    ...over,
  }) as StatsResponse

describe('parseValueToken', () => {
  it('reads a path alone and a path with a format', () => {
    expect(parseValueToken('{=chart.total}')).toEqual({ path: 'chart.total', format: null })
    expect(parseValueToken('{=chart.total|number}')).toEqual({ path: 'chart.total', format: 'number' })
    expect(parseValueToken('{=chart.topShare|pct}')).toEqual({ path: 'chart.topShare', format: 'pct' })
    expect(parseValueToken('{=golive.web|date}')).toEqual({ path: 'golive.web', format: 'date' })
  })

  it('ignores spaces around the path, the bar and the format, and the format case', () => {
    expect(parseValueToken('{= chart.total | NUMBER }')).toEqual({ path: 'chart.total', format: 'number' })
  })

  it('parses a release-2 metric path today (so saved text keeps its meaning later)', () => {
    expect(parseValueToken('{=metric:returns@7d|number}')).toEqual({ path: 'metric:returns@7d', format: 'number' })
  })

  it('refuses malformed tokens', () => {
    for (const bad of ['{=}', '{= }', '{=chart total}', '{=chart.total|}', '{=chart.total|money}', '{=a|number|pct}', 'chart.total', '{chart.total}', '{=**x**}', '{=[a](https://x)}', '{=a}b']) {
      expect(parseValueToken(bad)).toBeNull()
    }
  })
})

describe('formats', () => {
  it('number: en-US grouping', () => {
    expect(formatValue({ kind: 'number', value: 1234567 })).toBe('1,234,567')
    expect(formatValue({ kind: 'number', value: 0 })).toBe('0')
  })
  it('pct: a 0..1 share with one decimal', () => {
    expect(formatValue({ kind: 'share', value: 0.75 })).toBe('75.0%')
    expect(formatValue({ kind: 'share', value: 1 / 3 })).toBe('33.3%')
  })
  it('date: month, day and year, from the calendar day as written', () => {
    expect(formatDateYmd('2026-10-03')).toBe('Oct 3, 2026')
    expect(formatValue({ kind: 'date', value: '2026-01-31' })).toBe('Jan 31, 2026')
    expect(formatDateYmd('2026-02-31')).toBeNull()
    expect(formatDateYmd('2026-10-03T00:00:00Z')).toBeNull()
  })
  it('text: as it is', () => {
    expect(formatValue({ kind: 'text', value: 'v1.98.0' })).toBe('v1.98.0')
  })
  it('missing or wrong-typed values are null', () => {
    expect(formatValue({ kind: 'number', value: null })).toBeNull()
    expect(formatValue({ kind: 'number', value: NaN })).toBeNull()
    expect(formatValue({ kind: 'number', value: '12' })).toBeNull()
    expect(formatValue({ kind: 'date', value: 5 })).toBeNull()
    expect(formatValue({ kind: 'text', value: '' })).toBeNull()
  })
})

describe('resolveValueToken', () => {
  const values: TokenValues = {
    n: { kind: 'number', value: 4200 },
    s: { kind: 'share', value: 0.125 },
    d: { kind: 'date', value: '2026-09-26' },
    t: { kind: 'text', value: 'Canada' },
    gone: { kind: 'number', value: null },
  }
  it('each kind in its own format, with or without naming it', () => {
    expect(resolveValueToken('{=n}', values)).toBe('4,200')
    expect(resolveValueToken('{=n|number}', values)).toBe('4,200')
    expect(resolveValueToken('{=s}', values)).toBe('12.5%')
    expect(resolveValueToken('{=s|pct}', values)).toBe('12.5%')
    expect(resolveValueToken('{=d}', values)).toBe('Sep 26, 2026')
    expect(resolveValueToken('{=d|date}', values)).toBe('Sep 26, 2026')
    expect(resolveValueToken('{=t}', values)).toBe('Canada')
  })
  it('a format that does not fit the kind is null', () => {
    expect(resolveValueToken('{=n|pct}', values)).toBeNull()
    expect(resolveValueToken('{=n|date}', values)).toBeNull()
    expect(resolveValueToken('{=d|number}', values)).toBeNull()
    expect(resolveValueToken('{=t|number}', values)).toBeNull()
  })
  it('missing data, an unknown path and a malformed token are null', () => {
    expect(resolveValueToken('{=gone}', values)).toBeNull()
    expect(resolveValueToken('{=nope}', values)).toBeNull()
    expect(resolveValueToken('{=N}', values)).toBeNull() // paths are case-sensitive
    expect(resolveValueToken('{=metric:returns@7d|number}', values)).toBeNull()
    expect(resolveValueToken('{=n|money}', values)).toBeNull()
    expect(resolveValueToken('{=toString}', values)).toBeNull() // no prototype lookups
    expect(resolveValueToken('{=__proto__}', values)).toBeNull()
  })
})

describe('chartValues', () => {
  it('total, top item (summed across rows), its count and share, and the days shown', () => {
    const v = chartValues(widget(), response())
    expect(v['chart.total'].value).toBe(1000)
    expect(v['chart.top'].value).toBe('United States')
    expect(v['chart.topValue'].value).toBe(750)
    expect(v['chart.topShare'].value).toBe(0.75)
    expect(v['chart.from'].value).toBe('2026-09-01')
    expect(v['chart.to'].value).toBe('2026-09-30')
  })

  it('a tie for the top value goes to the first item in the order the server sent', () => {
    const rows = [
      { key: { country: 'CA' }, pageviews: 300, visits: 1 },
      { key: { country: 'US' }, pageviews: 200, visits: 1 },
      { key: { country: 'US' }, pageviews: 100, visits: 1 },
      { key: { country: 'MX' }, pageviews: 300, visits: 1 },
    ]
    const v = chartValues(widget(), response({ rows, totals: { pageviews: 900, visits: 4 } }))
    expect(v['chart.top'].value).toBe('Canada')
    expect(v['chart.topValue'].value).toBe(300)
    const flipped = chartValues(widget(), response({ rows: [rows[1], rows[2], rows[0], rows[3]], totals: { pageviews: 900, visits: 4 } }))
    expect(flipped['chart.top'].value).toBe('United States')
  })

  it("uses the chart's metric", () => {
    const v = chartValues(widget({ metric: 'visits' }), response())
    expect(v['chart.total'].value).toBe(710)
    expect(v['chart.top'].value).toBe('Canada')
    expect(v['chart.topValue'].value).toBe(400)
  })

  it('a cut range: the served days, the last one being the day before the exclusive end (ET)', () => {
    const notice = {
      kind: 'range-clamped' as const,
      source: 'cf-rum' as const,
      reason: 'lookback' as const,
      requested: { from: '2026-01-01T05:00:00.000Z', to: '2026-10-01T04:00:00.000Z' },
      served: { from: '2026-07-01T04:00:00.000Z', to: '2026-10-01T04:00:00.000Z' },
      limitDays: 93,
      lookbackDays: 184,
    }
    const v = chartValues(widget(), response({ notice }))
    expect(v['chart.from'].value).toBe('2026-07-01')
    expect(v['chart.to'].value).toBe('2026-09-30')
    const utc = chartValues(widget(), response({ notice: { ...notice, dayZone: 'utc', served: { from: '2026-07-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' } } }))
    expect(utc['chart.from'].value).toBe('2026-07-01')
    expect(utc['chart.to'].value).toBe('2026-09-30')
    const none = chartValues(widget(), response({ notice: { ...notice, reason: 'outside-lookback', served: null } }))
    expect(none['chart.from'].value).toBeNull()
  })

  describe('an uncut range names the days the chart shows (ET on a chart without a `date` series, as the range note does)', () => {
    afterEach(() => {
      vi.useRealTimers()
    })
    const daysOf = (r: { since: string; until: string } | null) => {
      const v = chartValues(widget(), response({ meta: { ...response().meta, ...r! } }))
      return [v['chart.from'].value, v['chart.to'].value]
    }
    const lastAt = (iso: string, rel = '7d') => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(iso))
      return relativeRange(rel)
    }

    it('"Last 7d" viewed at 21:30 EDT (already the next UTC day): Sep 26 – Oct 3', () => {
      expect(daysOf(lastAt('2026-10-04T01:30:00.000Z'))).toEqual(['2026-09-26', '2026-10-03'])
    })

    it('the same range viewed at 10:00 EDT names the same days', () => {
      expect(daysOf(lastAt('2026-10-03T14:00:00.000Z'))).toEqual(['2026-09-26', '2026-10-03'])
    })

    it('a custom range of whole UTC days (and a `date` drill) names its own UTC days', () => {
      expect(daysOf({ since: '2026-09-01T00:00:00.000Z', until: '2026-09-30T23:59:59.999Z' })).toEqual(['2026-09-01', '2026-09-30'])
      expect(daysOf(dayDrillRange('date', '2026-09-05'))).toEqual(['2026-09-05', '2026-09-05'])
      // the server may echo the bounds without milliseconds; the instants are what count
      expect(daysOf({ since: '2026-09-01T00:00:00Z', until: '2026-09-30T23:59:59.999Z' })).toEqual(['2026-09-01', '2026-09-30'])
      // bare days: the server reads a bare `until` as the whole UTC day
      expect(daysOf({ since: '2026-09-01', until: '2026-09-30' })).toEqual(['2026-09-01', '2026-09-30'])
    })

    it('an ET-day drill names one day, on both DST change days too', () => {
      for (const day of ['2026-09-05', '2026-11-01', '2027-03-14']) {
        expect(daysOf(dayDrillRange('dateEt', day))).toEqual([day, day])
      }
    })

    it('across a DST change: the ET days of `since` and `until − 1 ms`', () => {
      // fall back (Nov 1, 2026): 21:30 EST Nov 3 is 02:30Z Nov 4; 7 days before is 22:30 EDT Oct 27
      expect(daysOf(lastAt('2026-11-04T02:30:00.000Z'))).toEqual(['2026-10-27', '2026-11-03'])
      // spring forward (Mar 14, 2027): 21:30 EDT Mar 16 is 01:30Z Mar 17; 7 days before is 20:30 EST Mar 9
      expect(daysOf(lastAt('2027-03-17T01:30:00.000Z'))).toEqual(['2027-03-09', '2027-03-16'])
      // a range ending exactly at ET midnight: its last day is the day before
      expect(daysOf({ since: '2026-10-25T04:00:00.000Z', until: '2026-11-02T05:00:00.000Z' })).toEqual(['2026-10-25', '2026-11-01'])
    })

    it('unreadable bounds name no days', () => {
      expect(daysOf({ since: 'soon', until: '2026-09-30T23:59:59.999Z' })).toEqual([null, null])
    })
  })

  // Review SHOULD-A (fix round C): the days named are the days the chart plots. A `date` series
  // (the default Overview trend) plots UTC days; a `dateEt` one, or a chart with no day dimension,
  // ET days. A cut and an uncut range on the same chart name days the same way.
  describe("names the days in the chart's own day zone", () => {
    afterEach(() => {
      vi.useRealTimers()
    })
    const trend = widget({ id: 'trend', type: 'area', dataset: undefined, dimension: 'date' })
    const trendEt = widget({ type: 'area', dataset: 'geo', dimension: 'dateEt' })
    const rowsFor = (w: Widget) => (w.dimension === 'country' ? response().rows : [])
    const daysOn = (w: Widget, r: { since: string; until: string } | null, extra: Partial<StatsResponse> = {}) => {
      const meta = { ...response().meta, ...r!, dimensions: [w.dimension] }
      const v = chartValues(w, response({ rows: rowsFor(w), meta, ...extra }))
      return [v['chart.from'].value, v['chart.to'].value]
    }
    const lastAt = (iso: string, rel = '7d') => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(iso))
      return relativeRange(rel)
    }

    it('a `date` chart, "Last 7d" at 21:30 EDT Oct 3 (01:30Z Oct 4): the UTC days it plots, Sep 27 – Oct 4', () => {
      expect(daysOn(trend, lastAt('2026-10-04T01:30:00.000Z'))).toEqual(['2026-09-27', '2026-10-04'])
    })

    it('a `date` chart, "Last 7d" at 10:00 EDT Oct 3: Sep 26 – Oct 3 (the UTC and ET days agree then)', () => {
      expect(daysOn(trend, lastAt('2026-10-03T14:00:00.000Z'))).toEqual(['2026-09-26', '2026-10-03'])
    })

    it('a `dateEt` chart, the same moments: its ET days, Sep 26 – Oct 3 both times', () => {
      expect(daysOn(trendEt, lastAt('2026-10-04T01:30:00.000Z'))).toEqual(['2026-09-26', '2026-10-03'])
      expect(daysOn(trendEt, lastAt('2026-10-03T14:00:00.000Z'))).toEqual(['2026-09-26', '2026-10-03'])
    })

    it('a chart with no day dimension (country): ET days, Sep 26 – Oct 3', () => {
      expect(daysOn(widget(), lastAt('2026-10-04T01:30:00.000Z'))).toEqual(['2026-09-26', '2026-10-03'])
    })

    it('the widget alone, or the response alone, saying `date` is enough', () => {
      const r = lastAt('2026-10-04T01:30:00.000Z')
      const noDims = { ...response().meta, ...r, dimensions: [] }
      const fromWidget = chartValues(trend, response({ rows: [], meta: noDims }))
      expect([fromWidget['chart.from'].value, fromWidget['chart.to'].value]).toEqual(['2026-09-27', '2026-10-04'])
      const fromResponse = chartValues(widget({ dimension: '' }), response({ rows: [], meta: { ...noDims, dimensions: ['date'] } }))
      expect([fromResponse['chart.from'].value, fromResponse['chart.to'].value]).toEqual(['2026-09-27', '2026-10-04'])
    })

    it('in EST (winter) too: "Last 7d" at 20:30 EST Dec 3 (01:30Z Dec 4)', () => {
      const r = lastAt('2026-12-04T01:30:00.000Z')
      expect(daysOn(trend, r)).toEqual(['2026-11-27', '2026-12-04'])
      expect(daysOn(trendEt, r)).toEqual(['2026-11-26', '2026-12-03'])
      expect(daysOn(widget(), r)).toEqual(['2026-11-26', '2026-12-03'])
    })

    it('on a `date` chart, a cut range and an uncut one agree, and with the range note', () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-04T01:30:00.000Z')) // 21:30 EDT Oct 3
      const uncut = relativeRange('90d')
      // "Last 120d", cut by the server on UTC days to the 93 allowed, ending where it was asked to
      const asked = relativeRange('120d')!
      const notice: RangeNotice = {
        kind: 'range-clamped',
        source: 'cf-rum',
        reason: 'max-duration',
        dayZone: 'utc',
        requested: { from: asked.since, to: asked.until },
        served: { from: '2026-07-03T00:00:00.000Z', to: asked.until },
        limitDays: 93,
        lookbackDays: 184,
      }
      const cut = daysOn(trend, { since: notice.served!.from, until: asked.until }, { notice })
      expect(daysOn(trend, uncut)[1]).toBe('2026-10-04')
      expect(cut).toEqual(['2026-07-03', '2026-10-04'])
      expect(rangeNoticeText(notice, Date.now())).toContain('Jul 3 – Oct 4 shown')
      // a `date` drill (one UTC day) and a custom whole-UTC-day range: those days
      expect(daysOn(trend, dayDrillRange('date', '2026-10-01'))).toEqual(['2026-10-01', '2026-10-01'])
      expect(daysOn(trend, { since: '2026-09-01', until: '2026-09-30' })).toEqual(['2026-09-01', '2026-09-30'])
      // an ET-day drill plots two partial UTC bars on a `date` chart, and names both
      expect(daysOn(trend, dayDrillRange('dateEt', '2026-10-01'))).toEqual(['2026-10-01', '2026-10-02'])
      expect(daysOn(trendEt, dayDrillRange('dateEt', '2026-10-01'))).toEqual(['2026-10-01', '2026-10-01'])
    })
  })

  it('no response or an error: every chart value is missing', () => {
    for (const v of [chartValues(widget(), null), chartValues(widget(), response(), 'stats 502')]) {
      expect(Object.values(v).every((x) => x.value === null)).toBe(true)
    }
  })

  it('no rows: the total (0) but no top item or share', () => {
    const v = chartValues(widget(), response({ rows: [], totals: { pageviews: 0, visits: 0 } }))
    expect(v['chart.total'].value).toBe(0)
    expect(v['chart.top'].value).toBeNull()
    expect(v['chart.topShare'].value).toBeNull()
  })

  it('a zero total has no share; a chart without a dimension has no top item', () => {
    const zero = chartValues(widget(), response({ rows: [{ key: { country: 'US' }, pageviews: 0, visits: 0 }], totals: { pageviews: 0, visits: 0 } }))
    expect(zero['chart.top'].value).toBe('United States')
    expect(zero['chart.topShare'].value).toBeNull()
    const stat = chartValues(widget({ type: 'stat', dimension: '' }), response())
    expect(stat['chart.total'].value).toBe(1000)
    expect(stat['chart.top'].value).toBeNull()
  })

  it('a rate tile and a multi-series line chart have no single total or top item, only dates', () => {
    const rate = chartValues(widget({ type: 'rate', dataset: 'popup' }), response())
    expect(rate['chart.total'].value).toBeNull()
    expect(rate['chart.from'].value).toBe('2026-09-01')
    const series = chartValues(widget({ type: 'line', dimension: 'date', series: [{ label: 'a' }] as Widget['series'] }), response())
    expect(series['chart.total'].value).toBeNull()
    expect(series['chart.top'].value).toBeNull()
    expect(series['chart.to'].value).toBe('2026-09-30')
  })
})

describe('fixed dates', () => {
  it('the newest release, the web go-live day and the Play submission day', () => {
    const latest = newest(datedReleases())!
    const g = globalValues()
    expect(g['release.latest'].value).toBe(latest.dateEt)
    expect(g['release.latestVersion'].value).toBe(latest.version)
    expect(g['golive.web'].value).toBe(TRACKING_ACTIVATION_DATE_ET)
    expect(g['play.submitted'].value).toBe(PLAY_TRACKING_ACTIVATION_DATE_ET)
    // `golive.<app>` is kept for a real go-live day: the Play submission is not one
    expect(g).not.toHaveProperty('golive.play')
    expect(chartValueResolver(widget(), null)('{=golive.play|date}')).toBeNull()
  })

  it('resolve on any chart, even one with no data', () => {
    const r = chartValueResolver(widget(), null)
    expect(r(`{=golive.web|date}`)).toBe(formatDateYmd(TRACKING_ACTIVATION_DATE_ET!))
    expect(r('{=chart.total}')).toBeNull()
  })
})

describe('the Insert value menu', () => {
  it('every option is a well-formed token whose path the resolver knows', () => {
    const known = new Set([...Object.keys(globalValues()), ...Object.keys(chartValues(widget(), null))])
    for (const o of VALUE_TOKEN_OPTIONS) {
      const t = parseValueToken(o.token)
      expect(t, o.token).not.toBeNull()
      expect(known.has(t!.path), o.token).toBe(true)
    }
    const r = chartValueResolver(widget(), response())
    expect(VALUE_TOKEN_OPTIONS.every((o) => r(o.token) !== null)).toBe(true)
  })
})
