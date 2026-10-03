// The generic breakdown bar (type 'breakdownBar', lib/charts.ts breakdownBarModel +
// buildChartConfig): one dimension on the axis × one as the series, grouped or stacked.
import { describe, expect, it } from 'vitest'
import { breakdownBarModel, buildChartConfig, orderDimValues, formatKey } from './charts'
import type { StatsResponse, Widget } from '../types'
import { CAMPAIGNS } from './campaigns'

function resp(rows: [string, string, number][], dims = ['popupFamily', 'popupOutcome']): StatsResponse {
  return {
    rows: rows.map(([a, b, c]) => ({ key: { [dims[0]]: a, [dims[1]]: b }, pageviews: c, visits: c })),
    totals: { pageviews: rows.reduce((t, r) => t + r[2], 0), visits: 0 },
    meta: { site: 'all', host: null, since: '2026-09-26', until: '2026-09-27', dimensions: dims, metric: 'pageviews' },
  }
}
function widget(over: Partial<Widget> = {}): Widget {
  return {
    id: 'b',
    i: 'b',
    title: 'b',
    type: 'breakdownBar',
    dataset: 'geo',
    dimension: 'popupFamily',
    breakdown: 'popupOutcome',
    metric: 'pageviews',
    limit: 100,
    x: 0,
    y: 0,
    w: 12,
    h: 10,
    ...over,
  }
}
// Rows arrive count-descending from /api/geo, in no useful order for these dims.
const ROWS: [string, string, number][] = [
  ['signin-prompt', 'shown', 21],
  ['install', 'shown', 9],
  ['signin-prompt', 'dismiss', 12],
  ['signin-prompt', 'accept', 4],
  ['install', 'installed', 2],
  ['upsell', 'shown', 1],
]

describe('breakdownBarModel', () => {
  it('grouped (the default): pop-ups in registry order, outcomes in shown → taps → outcomes order', () => {
    const m = breakdownBarModel(widget(), resp(ROWS))
    expect(m.stacked).toBe(false)
    expect(m.axis).toEqual(['signin-prompt', 'upsell', 'install'])
    expect(m.series).toEqual(['shown', 'accept', 'dismiss', 'installed'])
  })

  it('grouped: a missing combination is null (no empty slot), a real one its count', () => {
    const m = breakdownBarModel(widget(), resp(ROWS))
    const shown = m.values[m.series.indexOf('shown')]
    const installed = m.values[m.series.indexOf('installed')]
    expect(shown).toEqual([21, 1, 9])
    expect(installed).toEqual([null, null, 2])
  })

  it('stacked: a missing combination is 0, so every stack still totals', () => {
    const m = breakdownBarModel(widget({ barMode: 'stacked' }), resp(ROWS))
    expect(m.stacked).toBe(true)
    expect(m.values[m.series.indexOf('installed')]).toEqual([0, 0, 2])
    const stackTotals = m.axis.map((_, i) => m.values.reduce((t, s) => t + (s[i] ?? 0), 0))
    expect(stackTotals).toEqual([37, 1, 11])
  })

  it('sums duplicate (axis, series) rows instead of dropping one', () => {
    const m = breakdownBarModel(widget(), resp([['install', 'shown', 3], ['install', 'shown', 4]]))
    expect(m.values).toEqual([[7]])
  })

  it('the older stackedBar type is always stacked, whatever barMode says', () => {
    expect(breakdownBarModel(widget({ type: 'stackedBar', barMode: 'grouped' }), resp(ROWS)).stacked).toBe(true)
  })

  it('unknown dims keep the response (count) order', () => {
    const m = breakdownBarModel(widget({ dimension: 'country', breakdown: 'device' }), resp([['US', 'mobile', 5], ['CA', 'desktop', 3], ['US', 'desktop', 1]], ['country', 'device']))
    expect(m.axis).toEqual(['US', 'CA'])
    expect(m.series).toEqual(['mobile', 'desktop'])
  })
})

describe('buildChartConfig — breakdownBar', () => {
  it('grouped: unstacked axes, skipNull datasets, a legend, one dataset per series', () => {
    const cfg: any = buildChartConfig(widget(), resp(ROWS))
    expect(cfg.type).toBe('bar')
    expect(cfg.options.scales.x.stacked).toBe(false)
    expect(cfg.options.scales.y.stacked).toBe(false)
    expect(cfg.options.plugins.legend.display).toBe(true)
    expect(cfg.data.datasets.map((d: any) => d.label)).toEqual(['Shown', 'Tapped / accepted', 'Dismissed', 'Installed'])
    expect(cfg.data.datasets.every((d: any) => d.skipNull)).toBe(true)
    expect(cfg.data.labels).toEqual(['Sign-in prompt', 'Upsell', 'Install prompt'])
  })
  it('stacked: both axes stacked', () => {
    const cfg: any = buildChartConfig(widget({ barMode: 'stacked' }), resp(ROWS))
    expect(cfg.options.scales.x.stacked).toBe(true)
    expect(cfg.options.scales.y.stacked).toBe(true)
  })
  it('a series keeps its color across charts (stable per outcome)', () => {
    const a: any = buildChartConfig(widget(), resp(ROWS))
    const b: any = buildChartConfig(widget(), resp([['upsell', 'installed', 1], ['upsell', 'shown', 3]]))
    const color = (cfg: any, label: string) => cfg.data.datasets.find((d: any) => d.label === label).backgroundColor
    expect(color(a, 'Installed')).toBe(color(b, 'Installed'))
    expect(color(a, 'Shown')).toBe(color(b, 'Shown'))
  })
  it('serves the completions mode × difficulty breakdown on the same widget', () => {
    const cfg: any = buildChartConfig(
      widget({ dimension: 'gameMode', breakdown: 'gameDifficulty', barMode: 'stacked' }),
      resp([['normal', 'hard', 2], ['daily', 'easy', 1], ['normal', 'easy', 3]], ['gameMode', 'gameDifficulty']),
    )
    expect(cfg.data.labels).toEqual(['Normal', 'Daily'])
    expect(cfg.data.datasets.map((d: any) => d.label)).toEqual(['Easy', 'Hard'])
  })
})

describe('labels for the derived dims', () => {
  it('formatKey', () => {
    expect(formatKey('popupFamily', 'promo-first50')).toBe('First 50 promo')
    expect(formatKey('popupOutcome', 'still-playing')).toBe('Still playing')
    expect(formatKey('campaignFlight', '24279250691')).toBe('US+CA web retest')
  })
  it('orderDimValues puts unknown values after known ones', () => {
    expect(orderDimValues('popupOutcome', ['weird', 'returned', 'shown'])).toEqual(['shown', 'returned', 'weird'])
  })
})

// A campaignFlight breakdown (the campaign arrivals charts) draws every beacon-tracked campaign,
// rows or not, as the old campaign charts did — including one with no start date yet, which can
// never be attributed any rows (campaignAttributionClause) so it draws at 0 like any other
// campaign with no arrivals: its legend entry stays at 0, and the flight-day axis runs to the
// longest of the DATED flights (a flight with no start has flightLength 0, lib/charts.ts, so it
// never stretches the axis).
describe('campaignFlight breakdown: every tracked campaign, zero-filled', () => {
  const TRACKED = CAMPAIGNS.filter((c) => c.measurement !== 'spend-only')
  const android = TRACKED.find((c) => c.flightStart === '2026-09-02')!
  const retest = TRACKED.find((c) => c.flightStart === '2026-09-26')!
  const flight = (c: (typeof CAMPAIGNS)[number]) => Math.round((Date.parse(c.flightEnd) - Date.parse(c.flightStart!)) / 86_400_000) + 1
  const maxFlight = Math.max(...TRACKED.map(flight))

  it('the configuration tracks Android, the retest and the two flight-2 arms; the longest is Android at 8 days', () => {
    expect(TRACKED.map((c) => c.id)).toEqual([android.id, retest.id, '24316608605', '24311309184'])
    expect(maxFlight).toBe(8)
    expect(flight(retest)).toBeLessThan(maxFlight)
  })

  it('flight day: only the retest has rows; every other campaign is still a series (all 0), and the axis is Day 1 to 8', () => {
    const w = widget({ type: 'line', dimension: 'flightDay', breakdown: 'campaignFlight', cumulative: true })
    const r = resp([['1', retest.id, 5], ['3', retest.id, 2]], ['flightDay', 'campaignFlight'])
    const m = breakdownBarModel({ ...w, type: 'breakdownBar', barMode: 'stacked' }, r)
    expect(m.series).toEqual(TRACKED.map((c) => c.id))
    expect(m.axis).toEqual(Array.from({ length: maxFlight }, (_, i) => String(i + 1)))
    expect(m.values[0]).toEqual(Array(maxFlight).fill(0))
    expect(m.values[1]).toEqual([5, 0, 2, 0, 0, 0, 0, 0])
    for (const i of m.series.keys()) if (i !== 1) expect(m.values[i], m.series[i]).toEqual(Array(maxFlight).fill(0))
    const cfg: any = buildChartConfig(w, r)
    expect(cfg.data.datasets.map((d: any) => d.label)).toEqual([...TRACKED.map((c) => c.label), ...TRACKED.map((c) => `${c.label} (cumulative)`)])
    expect(cfg.data.datasets[TRACKED.length].data).toEqual(Array(maxFlight).fill(0)) // Android's cumulative line
  })

  it('hour of day (grouped bars): a campaign with no arrivals is 0 in every hour, not missing', () => {
    const w = widget({ dimension: 'hourEt', breakdown: 'campaignFlight' })
    const cfg: any = buildChartConfig(w, resp([['9', android.id, 4]], ['hourEt', 'campaignFlight']))
    expect(cfg.data.labels).toHaveLength(24)
    expect(cfg.data.datasets.map((d: any) => d.label)).toEqual(TRACKED.map((c) => c.label))
    expect(cfg.data.datasets[1].data).toEqual(Array(24).fill(0))
    // A campaign WITH rows still leaves an empty hour out (no zero-height bar), as before (H1).
    expect(cfg.data.datasets[0].data[8]).toBeNull()
    expect(cfg.data.datasets[0].data[9]).toBe(4)
  })

  it('a campaignFlight drill narrows the series (and the axis) to the drilled campaign', () => {
    const w = widget({ type: 'line', dimension: 'flightDay', breakdown: 'campaignFlight' })
    const drill = [{ key: 'campaignFlight', value: retest.id, label: retest.label }]
    const empty = resp([], ['flightDay', 'campaignFlight'])
    const m = breakdownBarModel({ ...w, type: 'breakdownBar', barMode: 'stacked' }, empty, drill)
    expect(m.series).toEqual([retest.id])
    expect(m.axis).toHaveLength(flight(retest))
    const cfg: any = buildChartConfig(w, empty, undefined, { drill } as never)
    expect(cfg.data.datasets.map((d: any) => d.label)).toEqual([retest.label])
  })

  it('other breakdowns keep only the values the response has', () => {
    const m = breakdownBarModel(widget(), resp(ROWS))
    expect(m.series).not.toContain(android.id)
  })

  it('a campaign with no start date yet is still a series (at 0), and never stretches the flight-day axis', () => {
    const pending = { ...retest, id: '99999999999', label: 'Upcoming test flight', flightStart: null }
    CAMPAIGNS.push(pending)
    try {
      const w = widget({ type: 'line', dimension: 'flightDay', breakdown: 'campaignFlight', cumulative: true })
      const r = resp([['1', retest.id, 5]], ['flightDay', 'campaignFlight'])
      const m = breakdownBarModel({ ...w, type: 'breakdownBar', barMode: 'stacked' }, r)
      expect(m.series).toEqual([...TRACKED.map((c) => c.id), pending.id])
      expect(m.axis).toEqual(Array.from({ length: maxFlight }, (_, i) => String(i + 1))) // unchanged: still 1..8
      expect(m.values[m.series.indexOf(pending.id)]).toEqual(Array(maxFlight).fill(0))

      const hourW = widget({ dimension: 'hourEt', breakdown: 'campaignFlight' })
      const cfg: any = buildChartConfig(hourW, resp([['9', android.id, 4]], ['hourEt', 'campaignFlight']))
      expect(cfg.data.datasets.map((d: any) => d.label)).toContain(pending.label)
      expect(cfg.data.datasets.find((d: any) => d.label === pending.label).data).toEqual(Array(24).fill(0))
    } finally {
      CAMPAIGNS.splice(CAMPAIGNS.indexOf(pending), 1)
    }
  })
})
