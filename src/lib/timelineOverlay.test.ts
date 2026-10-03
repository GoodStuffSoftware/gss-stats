// The date-axis overlay (lib/timelineOverlay.ts) and the series line chart (lib/charts.ts
// buildSeriesLineConfig) that together replace the Overview's bespoke timeline panel.
import { describe, expect, it } from 'vitest'
import { flightItems, goLiveItems, itemsInRange, layoutFlightBands, markerIndex, overlayItems, releaseItems, type OverlayItem } from './timelineOverlay'
import { buildSeriesLineConfig, buildChartConfig, hasLineSeries, truncatedFrom, seriesRows } from './charts'
import { timelineWidget, TIMELINE_SERIES } from './defaults'
import type { CampaignFlight } from './campaigns'
import type { StatsResponse } from '../types'

const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(from + 'T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10))
const flight = (date: string, endDate: string | undefined, label = 'f'): OverlayItem =>
  endDate ? { kind: 'flight', date, endDate, label, note: '' } : { kind: 'flight', date, openEnded: true, label, note: '' }

describe('layoutFlightBands', () => {
  const axis = days('2026-09-01', 30) // 09-01 .. 09-30

  it('covers whole ET days, both ends inclusive', () => {
    const [b] = layoutFlightBands(axis, [flight('2026-09-02', '2026-09-09')])
    expect(axis[b.startIndex]).toBe('2026-09-02')
    expect(axis[b.endIndex]).toBe('2026-09-09')
    expect(b.clippedStart || b.clippedEnd).toBe(false)
  })

  it('an open-ended (active) flight runs to the axis end', () => {
    const [b] = layoutFlightBands(axis, [flight('2026-09-26', undefined)])
    expect(axis[b.startIndex]).toBe('2026-09-26')
    expect(b.endIndex).toBe(axis.length - 1)
    expect(b.clippedEnd).toBe(true)
  })

  it('clips a flight that started before the axis, and drops one wholly outside it', () => {
    const bands = layoutFlightBands(axis, [flight('2026-08-20', '2026-09-03', 'early'), flight('2026-10-05', '2026-10-09', 'later'), flight('2026-07-01', '2026-07-09', 'before')])
    expect(bands.map((b) => b.item.label)).toEqual(['early'])
    expect(bands[0]).toMatchObject({ startIndex: 0, clippedStart: true })
    expect(axis[bands[0].endIndex]).toBe('2026-09-03')
  })

  it('overlapping flights take successive label rows; a later non-overlapping one reuses row 0', () => {
    const bands = layoutFlightBands(axis, [flight('2026-09-02', '2026-09-09', 'a'), flight('2026-09-09', '2026-09-13', 'b'), flight('2026-09-20', '2026-09-22', 'c')])
    const row = Object.fromEntries(bands.map((b) => [b.item.label, b.row]))
    expect(row).toEqual({ a: 0, b: 1, c: 0 })
  })

  it('ET day edges: a band ending the day before the axis starts is dropped; one starting on the last day is kept', () => {
    expect(layoutFlightBands(axis, [flight('2026-08-25', '2026-08-31')])).toEqual([])
    const [b] = layoutFlightBands(axis, [flight('2026-09-30', '2026-10-04')])
    expect([b.startIndex, b.endIndex]).toEqual([29, 29])
  })

  it('on a sparse axis (missing days) the band snaps to the plotted days inside it', () => {
    const sparse = ['2026-09-01', '2026-09-05', '2026-09-10']
    const [b] = layoutFlightBands(sparse, [flight('2026-09-03', '2026-09-07')])
    expect([b.startIndex, b.endIndex]).toEqual([1, 1])
    expect(layoutFlightBands(sparse, [flight('2026-09-06', '2026-09-08')])).toEqual([]) // no plotted day inside
  })
})

describe('overlay items', () => {
  it('flights: closed ones end at flightEnd, the active one is open-ended, a pending one is skipped', () => {
    const cs = [
      { id: '1', label: 'closed', flightStart: '2026-09-02', flightEnd: '2026-09-09', status: 'closed' },
      { id: '2', label: 'active', flightStart: '2026-09-26', flightEnd: '2026-10-02', status: 'active' },
      { id: '3', label: 'pending', flightStart: null, flightEnd: '2026-10-10', status: 'upcoming' },
    ] as unknown as CampaignFlight[]
    const items = flightItems(cs, '2026-09-30') // pinned: the active fixture flight ends 2026-10-02
    expect(items.map((i) => i.label)).toEqual(['closed', 'active'])
    expect(items[0]).toMatchObject({ endDate: '2026-09-09' })
    expect(items[1]).toMatchObject({ openEnded: true })
    expect(items[1].endDate).toBeUndefined()
  })

  it('an active flight is open-ended only while today (ET) is on or before its flightEnd', () => {
    const active = [{ id: '2', label: 'active', flightStart: '2026-09-26', flightEnd: '2026-10-02', status: 'active' }] as unknown as CampaignFlight[]
    expect(flightItems(active, '2026-10-02')[0]).toMatchObject({ openEnded: true })
    const past = flightItems(active, '2026-10-03')[0]
    expect(past.openEnded).toBeUndefined()
    expect(past.endDate).toBe('2026-10-02')
  })

  it('releases split into labelled majors and minor ticks; go-live markers carry plain notes', () => {
    const rel = releaseItems()
    expect(rel.some((r) => r.kind === 'release')).toBe(true)
    expect(rel.some((r) => r.kind === 'minor-release')).toBe(true)
    const live = goLiveItems()
    expect(live.map((l) => l.label)).toEqual(expect.arrayContaining(['tracking starts', 'install fix']))
    for (const it of [...rel, ...live]) expect(it.note).not.toMatch(/\blib\/|\.ts\b|`/)
  })

  it('lists v1.95.4 to v1.96.1 (incl. v1.95.7/8) once each, on their ET release dates', () => {
    const byLabel = new Map<string, string[]>()
    for (const r of releaseItems()) byLabel.set(r.label, [...(byLabel.get(r.label) ?? []), r.date])
    expect(byLabel.get('v1.95.4')).toEqual(['2026-09-26'])
    expect(byLabel.get('v1.95.5')).toEqual(['2026-09-26'])
    expect(byLabel.get('v1.95.6')).toEqual(['2026-09-26'])
    expect(byLabel.get('v1.95.7')).toEqual(['2026-09-28'])
    expect(byLabel.get('v1.95.8')).toEqual(['2026-09-28'])
    expect(byLabel.get('v1.96.0')).toEqual(['2026-10-02'])
    expect(byLabel.get('v1.96.1')).toEqual(['2026-10-03'])
    for (const dates of byLabel.values()) expect(dates).toHaveLength(1)
  })

  it('the 2026-09-26 releases are unlabelled ticks so they do not crowd the go-live labels', () => {
    const sameDay = releaseItems().filter((r) => r.date === '2026-09-26' && r.label !== 'v1.95.3')
    expect(sameDay.length).toBeGreaterThan(0)
    for (const r of sameDay) expect(r.kind).toBe('minor-release')
  })

  it('the three toggles switch their own items on and off', () => {
    expect(overlayItems({})).toEqual([])
    const all = overlayItems({ releases: true, goLive: true, flights: true })
    expect(new Set(all.map((i) => i.kind))).toEqual(new Set(['release', 'minor-release', 'go-live', 'flight']))
    expect(overlayItems({ goLive: true }).every((i) => i.kind === 'go-live')).toBe(true)
    expect(overlayItems({ flights: true }).every((i) => i.kind === 'flight')).toBe(true)
    // sorted by date
    const dates = all.map((i) => i.date)
    expect([...dates].sort()).toEqual(dates)
  })

  it('itemsInRange keeps a flight that overlaps the range and point items inside it', () => {
    const items = [flight('2026-09-02', '2026-09-09', 'a'), { kind: 'go-live', date: '2026-09-26', label: 'x', note: '' } as OverlayItem, { kind: 'release', date: '2026-08-31', label: 'y', note: '' } as OverlayItem]
    expect(itemsInRange(items, '2026-09-05', '2026-09-30').map((i) => i.label)).toEqual(['a', 'x'])
  })

  it('markerIndex: first plotted day on/after the date, -1 outside', () => {
    const axis = ['2026-09-01', '2026-09-03', '2026-09-05']
    expect(markerIndex(axis, '2026-09-02')).toBe(1)
    expect(markerIndex(axis, '2026-09-05')).toBe(2)
    expect(markerIndex(axis, '2026-09-06')).toBe(-1)
    expect(markerIndex(axis, '2026-08-31')).toBe(-1)
  })
})

describe('series line chart (the Overall timeline as a standard line chart)', () => {
  const resp = (rows: [string, number][]): StatsResponse => ({
    rows: rows.map(([date, c]) => ({ key: { dateEt: date }, pageviews: c, visits: c })),
    totals: { pageviews: 0, visits: 0 },
    // ET days: noon UTC on both ends sits inside the same ET day
    meta: { site: 'all', host: null, since: '2026-09-24T12:00:00Z', until: '2026-09-26T12:00:00Z', dimensions: ['dateEt'], metric: 'pageviews' },
  })
  const w = timelineWidget({ x: 0, y: 0, w: 12, h: 12 })

  it('is a standard line widget with series, overlays and the known-traffic filter on', () => {
    expect(w).toMatchObject({ type: 'line', dataset: 'geo', dimension: 'dateEt', markers: 'releases', goLiveMarkers: true, flightBands: true, excludeKnownTraffic: true })
    expect(hasLineSeries(w)).toBe(true)
    expect(w.series!.map((s) => s.label)).toEqual(['Page views', 'Tagged arrivals', 'Auth successes', 'Installs', 'Raw install signals (can double-count)'])
    expect(w.siteSel).toEqual(['bestsudoku-web', 'bestsudoku', 'bestsudoku-app'])
  })

  it('one dataset per series, zero-filled over the range, on its own axis', () => {
    const responses = TIMELINE_SERIES.map((_, i) => resp(i === 0 ? [['2026-09-24', 5], ['2026-09-26', 7]] : [['2026-09-25', i]]))
    const cfg: any = buildSeriesLineConfig(w, responses)
    expect(cfg.data.labels).toHaveLength(3)
    expect(cfg.data.datasets[0].data).toEqual([5, 0, 7])
    expect(cfg.data.datasets.map((d: any) => d.yAxisID)).toEqual(['y', 'y', 'y2', 'y2', 'y2'])
    expect(cfg.options.scales.y2.position).toBe('right')
    expect(cfg.options.scales.y.title.text).toBe('page views / arrivals')
    expect(cfg.data.datasets[4].borderDash).toEqual([1, 3])
    // the overlay plugin rides along when any overlay is on
    expect(cfg.plugins.map((p: any) => p.id)).toEqual(['timelineOverlay'])
  })

  it('a range longer than the limit (the server kept the newest days) starts the axis at the oldest returned day, never zero-filling unknown days', () => {
    // 450 days in range; the server returned only the newest 400 (their sum < the grand total).
    const since = '2025-01-01T12:00:00Z'
    const until = new Date(Date.parse(since) + 449 * 86_400_000).toISOString()
    const allDays = Array.from({ length: 450 }, (_, i) => new Date(Date.parse(since) + i * 86_400_000).toISOString().slice(0, 10))
    const kept = allDays.slice(50)
    const cut: StatsResponse = {
      rows: kept.map((d) => ({ key: { dateEt: d }, pageviews: 1, visits: 1 })),
      totals: { pageviews: 450, visits: 450 },
      meta: { site: 'all', host: null, since, until, dimensions: ['dateEt'], metric: 'pageviews' },
    }
    const full: StatsResponse = { ...cut, rows: allDays.map((d) => ({ key: { dateEt: d }, pageviews: 1, visits: 1 })) }
    const one = { ...w, series: [{ label: 'Page views' }, { label: 'x', filter: [{ field: 'keyEvent', value: 'install' }] }] }
    const cfg: any = buildSeriesLineConfig(one, [cut, full])
    expect(cfg.data.labels).toHaveLength(400)
    expect(cfg.data.datasets[0].data.every((v: number) => v === 1)).toBe(true) // no fake zeros
    expect(truncatedFrom('dateEt', cut)).toBe(kept[0])
    expect(truncatedFrom('dateEt', full)).toBeNull()
    // the single-series path does the same
    expect(seriesRows('dateEt', cut)).toHaveLength(400)
  })

  it('no right-axis series → no second axis; buildChartConfig routes series widgets here', () => {
    const left = { ...w, series: [{ label: 'Page views' }] }
    const cfg: any = buildChartConfig(left, resp([['2026-09-24', 1]]), [resp([['2026-09-24', 1]])])
    expect(cfg.options.scales.y2).toBeUndefined()
    expect(buildChartConfig(left, resp([]))).toBeNull() // no series responses yet → nothing drawn
  })
})
