// The date-axis overlay (lib/timelineOverlay.ts) and the series line chart (lib/charts.ts
// buildSeriesLineConfig) that together replace the Overview's bespoke timeline panel.
import { describe, expect, it, vi } from 'vitest'
import { flightItems, goLiveItems, itemsInRange, layoutBandLabels, layoutFlightBands, markerIndex, overlayItems, releaseItems, type OverlayItem } from './timelineOverlay'
import { buildSeriesLineConfig, buildChartConfig, hasLineSeries, seriesDayModel, truncatedFrom, seriesRows, timelineOverlayPlugin, BAND_ROW_PX } from './charts'
import { compareReadoutText, compareTarget, compareTargets, compareWindows } from './beforeAfter'
import { featureStepSeriesOf } from './featureHealth'
import { timelineWidget, TIMELINE_SERIES } from './defaults'
import type { CampaignFlight } from './campaigns'
import type { StatsResponse, Widget } from '../types'

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

  it('the v1.97.0 go-live marker is the one labelled line on 2026-10-03; its release is an unlabelled tick', () => {
    const live = goLiveItems().filter((l) => l.date === '2026-10-03')
    expect(live.map((l) => l.label)).toEqual(['tutorial + tour exit beacons live'])
    const rel = releaseItems().filter((r) => r.date === '2026-10-03')
    expect(rel.map((r) => r.label)).toEqual(expect.arrayContaining(['v1.96.1', 'v1.97.0']))
    for (const r of rel) expect(r.kind).toBe('minor-release')
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

describe('band labels', () => {
  // Draw the bands of a 14-day axis on a fake canvas and read back where each band name was printed.
  const dates14 = days('2026-11-01', 14)
  const draw = (flights: OverlayItem[]) => {
    const plugin: any = timelineOverlayPlugin(dates14, flights)
    const printed: { text: string; x: number; y: number }[] = []
    const ctx: any = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t: string) => ({ width: t.length * 5 }) : k === 'fillText' ? (text: string, x: number, y: number) => printed.push({ text, x, y }) : () => {}), set: () => true })
    const chart: any = { ctx, chartArea: { left: 10, right: 410, top: 40, bottom: 300 }, scales: { x: { getPixelForValue: (i: number) => 20 + 30 * i } }, height: 340 }
    plugin.beforeDatasetsDraw(chart)
    return printed
  }
  it('two flights that overlap in time (F3 and F4 on the untagged card) print on separate rows, a full text height apart', () => {
    const p = draw([flight('2026-10-17', '2026-11-06', 'Flight 3'), flight('2026-10-26', '2026-11-09', 'Flight 4')])
    const f3 = p.find((t) => t.text.startsWith('Flight 3'))!
    const f4 = p.find((t) => t.text.startsWith('Flight 4'))!
    expect(f3.y).not.toBe(f4.y)
    expect(Math.abs(f3.y - f4.y)).toBeGreaterThanOrEqual(BAND_ROW_PX)
    expect(BAND_ROW_PX).toBeGreaterThanOrEqual(13) // a 9px name needs room above the one below it
  })
  it('three overlapping flights use three rows, all inside the plot; one that starts after another ends reuses row 0', () => {
    const p = draw([flight('2026-10-20', '2026-11-12', 'A'), flight('2026-10-22', '2026-11-12', 'B'), flight('2026-10-24', '2026-11-12', 'C')])
    const ys = [...new Set(p.map((t) => t.y))].sort((a, b) => a - b)
    expect(ys).toHaveLength(3)
    expect(ys[0]).toBeGreaterThan(40)
    const q = draw([flight('2026-10-20', '2026-11-03', 'early'), flight('2026-11-05', '2026-11-12', 'late')])
    expect(new Set(q.map((t) => t.y)).size).toBe(1)
  })
  it('a name wider than its one-day band prints in full, and the next band whose name would touch it moves to another row', () => {
    // Bands 11-03 (x 65..95) and 11-05 (x 125..155) never overlap in time, so both start on row 0; the first name runs ~100 px.
    const p = draw([flight('2026-11-03', '2026-11-03', 'Flight 3 — long name'), flight('2026-11-05', '2026-11-05', 'Flight 5 — Microsoft')])
    const a = p.find((t) => t.text === 'Flight 3 — long name')!
    const b = p.find((t) => t.text === 'Flight 5 — Microsoft')!
    expect(a).toBeTruthy() // in full, not cut to the band
    expect(b).toBeTruthy()
    expect(a.y).not.toBe(b.y)
  })
  it('names that fit their bands keep today\'s rows: non-overlapping bands share row 0', () => {
    const p = draw([flight('2026-11-01', '2026-11-05', 'early'), flight('2026-11-07', '2026-11-12', 'late')])
    expect(new Set(p.map((t) => t.y)).size).toBe(1)
  })
})

describe('marker label padding after a layout', () => {
  // A fake phone-width chart: x = 20 + 30 * index, three markers whose labels (100 px each) all collide.
  const dates = days('2026-10-26', 5)
  const item = (date: string, label: string): OverlayItem => ({ kind: 'go-live', date, label, note: '' })
  const setup = (items: OverlayItem[], narrow = true) => {
    const plugin: any = timelineOverlayPlugin(dates, items, narrow)
    const ctx: any = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t: string) => ({ width: t.length * 5 }) : () => {}), set: () => true })
    const chart: any = { ctx, width: 300, height: 240, chartArea: { left: 10, right: 290, top: 24, bottom: 200 }, scales: { x: { getPixelForValue: (i: number) => 20 + 30 * i } }, options: { layout: { padding: { top: 24 } } }, update: vi.fn() }
    return { plugin, chart }
  }
  const crowd = [item('2026-10-26', 'a'.repeat(20)), item('2026-10-27', 'b'.repeat(20)), item('2026-10-28', 'c'.repeat(20))]

  it('labels that need more rows than the base ask for one more layout, with the top padding grown by the extra rows', async () => {
    const { plugin, chart } = setup(crowd)
    plugin.beforeLayout(chart)
    expect(chart.options.layout.padding.top).toBe(24) // nothing decided yet: the config's padding stands
    plugin.afterLayout(chart)
    await Promise.resolve()
    expect(chart.update).toHaveBeenCalledTimes(1)
    plugin.beforeLayout(chart) // the re-layout
    expect(chart.options.layout.padding.top).toBe(34) // three rows at phone width: 24 + one 10 px row
    plugin.afterLayout(chart) // same need, same chart size: settled
    await Promise.resolve()
    expect(chart.update).toHaveBeenCalledTimes(1)
  })
  it('a chart whose labels fit the base rows never re-lays out and keeps the configured padding', async () => {
    const { plugin, chart } = setup([item('2026-10-26', 'aaaaaaaaaa'), item('2026-10-29', 'bbbbbbbbbb')])
    plugin.beforeLayout(chart)
    plugin.afterLayout(chart)
    await Promise.resolve()
    expect(chart.update).not.toHaveBeenCalled()
    expect(chart.options.layout.padding.top).toBe(24)
  })
  it('the same crowd at desktop width fits the three base rows: no extra padding', async () => {
    const { plugin, chart } = setup(crowd, false)
    plugin.afterLayout(chart)
    await Promise.resolve()
    expect(chart.update).not.toHaveBeenCalled()
  })
  it('every label is drawn, the first row one extra row higher, and its hit column reaches that high', () => {
    const { plugin, chart } = setup(crowd)
    plugin.afterLayout(chart)
    plugin.beforeLayout(chart)
    const printed: { text: string; y: number }[] = []
    chart.ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t: string) => ({ width: t.length * 5 }) : k === 'fillText' ? (text: string, _x: number, y: number) => printed.push({ text, y }) : () => {}), set: () => true })
    plugin.beforeDatasetsDraw(chart)
    plugin.afterDatasetsDraw(chart)
    expect(printed.map((p) => p.text)).toEqual(['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)])
    expect(printed.map((p) => p.y)).toEqual([24 - 22 - 10, 24 - 22, 24 - 22 + 10]) // top = chartArea.top - offset - extra
  })
})

describe('marker label rows that outgrow the padding at draw time', () => {
  const dates = days('2026-10-26', 5)
  const item = (date: string, label: string): OverlayItem => ({ kind: 'go-live', date, label, note: '' })
  // Label width = chars * px.value, so a later draw can measure wider than the layout did (a web font arriving).
  const setup = (items: OverlayItem[], px: { value: number }) => {
    const plugin: any = timelineOverlayPlugin(dates, items, true)
    const mkCtx = () => new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t: string) => ({ width: t.length * px.value }) : () => {}), set: () => true })
    const chart: any = { ctx: mkCtx(), width: 300, height: 240, chartArea: { left: 10, right: 290, top: 24, bottom: 200 }, scales: { x: { getPixelForValue: (i: number) => 20 + 30 * i } }, options: { layout: { padding: { top: 24 } } }, update: vi.fn() }
    return { plugin, chart }
  }
  const crowd = [item('2026-10-26', 'a'.repeat(20)), item('2026-10-27', 'b'.repeat(20)), item('2026-10-28', 'c'.repeat(20))]
  const draw = (plugin: any, chart: any) => {
    plugin.beforeDatasetsDraw(chart)
    plugin.afterDatasetsDraw(chart)
  }

  it('a draw that needs more rows than the layout gave queues exactly one update, then converges', async () => {
    const px = { value: 1 } // laid out with narrow text: everything fits one row
    const { plugin, chart } = setup(crowd, px)
    plugin.beforeLayout(chart)
    plugin.afterLayout(chart)
    await Promise.resolve()
    expect(chart.update).not.toHaveBeenCalled()
    px.value = 5 // the font arrives: three rows at phone width
    draw(plugin, chart)
    draw(plugin, chart) // a second draw before the update runs queues nothing more
    await Promise.resolve()
    expect(chart.update).toHaveBeenCalledTimes(1)
    plugin.beforeLayout(chart) // the update's layout
    expect(chart.options.layout.padding.top).toBe(34)
    plugin.afterLayout(chart)
    draw(plugin, chart)
    await Promise.resolve()
    expect(chart.update).toHaveBeenCalledTimes(1)
  })
  it('a draw that fits the padding queues nothing', async () => {
    const px = { value: 5 }
    const { plugin, chart } = setup(crowd, px)
    plugin.beforeLayout(chart)
    plugin.afterLayout(chart) // asks for its one update
    await Promise.resolve()
    plugin.beforeLayout(chart)
    plugin.afterLayout(chart)
    draw(plugin, chart)
    draw(plugin, chart)
    await Promise.resolve()
    expect(chart.update).toHaveBeenCalledTimes(1) // only the layout path's own
    const fit = setup([item('2026-10-26', 'aaaaaaaaaa'), item('2026-10-29', 'bbbbbbbbbb')], { value: 5 })
    fit.plugin.afterLayout(fit.chart)
    draw(fit.plugin, fit.chart)
    await Promise.resolve()
    expect(fit.chart.update).not.toHaveBeenCalled()
  })
  it('a destroyed chart queues nothing', async () => {
    const px = { value: 1 }
    const { plugin, chart } = setup(crowd, px)
    plugin.afterLayout(chart)
    px.value = 5
    draw(plugin, chart) // queues the update ...
    chart.ctx = null // ... and the chart is destroyed before it runs
    await Promise.resolve()
    expect(chart.update).not.toHaveBeenCalled()
  })
})

describe('layoutBandLabels', () => {
  const measure = (t: string) => t.length * 5
  const area = { measureWidth: measure, areaLeft: 10, areaRight: 410 }

  it('names that sit inside their bands keep the rows they came with', () => {
    const out = layoutBandLabels([{ text: 'one', left: 10, row: 0 }, { text: 'two', left: 200, row: 0 }, { text: 'three', left: 100, row: 1 }], area)
    expect(out.map((p) => p.row)).toEqual([0, 0, 1])
    expect(out[0].x).toBe(13)
  })
  it('a name wider than its band is shown in full, not cut', () => {
    const out = layoutBandLabels([{ text: 'Flight 3 — Microsoft search', left: 100, row: 0 }], area)
    expect(out[0].text).toBe('Flight 3 — Microsoft search')
  })
  it('two names whose extents touch go to different rows; one clear of the gap stays', () => {
    const out = layoutBandLabels([{ text: 'aaaaaaaaaa', left: 100, row: 0 }, { text: 'bbbbbbbbbb', left: 140, row: 0 }, { text: 'cccccccccc', left: 300, row: 0 }], area)
    expect(out.map((p) => p.row)).toEqual([0, 1, 0])
  })
  it('three mutually touching names take three rows', () => {
    const out = layoutBandLabels([{ text: 'aaaaaaaaaa', left: 100, row: 0 }, { text: 'bbbbbbbbbb', left: 110, row: 0 }, { text: 'cccccccccc', left: 120, row: 0 }], area)
    expect(out.map((p) => p.row)).toEqual([0, 1, 2])
  })
  it('a bumped name starts from the row it was given, never below it', () => {
    const out = layoutBandLabels([{ text: 'aaaaaaaaaa', left: 100, row: 1 }, { text: 'bbbbbbbbbb', left: 110, row: 1 }], area)
    expect(out.map((p) => p.row)).toEqual([1, 2])
  })
  it('a name near the right edge is pulled left to stay inside the plot', () => {
    const out = layoutBandLabels([{ text: 'Flight 5 — Microsoft search', left: 380, row: 0 }], area)
    expect(out[0].x + out[0].width).toBeLessThanOrEqual(408)
  })
  it('a name wider than the plot itself is cut with an ellipsis to fit', () => {
    const out = layoutBandLabels([{ text: 'x'.repeat(100), left: 10, row: 0 }], area)
    expect(out[0].text.endsWith('…')).toBe(true)
    expect(out[0].width).toBeLessThanOrEqual(400 - 6)
  })
})

describe('timelineOverlayPlugin tooltip', () => {
  // A fake chart and canvas context: x = 20 + 30 * index, plot area 40..200 tall. fillText calls are recorded.
  const dates = days('2026-10-26', 5) // 10-26 .. 10-30
  const mk = (items: OverlayItem[], step = 30, height = 240) => {
    const plugin: any = timelineOverlayPlugin(dates, items)
    const texts: string[] = []
    const ctx: any = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? (t: string) => ({ width: t.length * 5 }) : k === 'fillText' ? (t: string) => texts.push(t) : () => {}), set: () => true })
    const chart: any = { ctx, chartArea: { left: 10, right: 200, top: 40, bottom: 200 }, scales: { x: { getPixelForValue: (i: number) => 20 + step * i } }, height }
    plugin.beforeDatasetsDraw(chart)
    plugin.afterDatasetsDraw(chart)
    const move = (x: number, y = 100) => {
      texts.length = 0
      plugin.afterEvent(chart, { event: { type: 'mousemove', x, y } })
      plugin.afterDraw(chart)
      return [...texts]
    }
    return { move }
  }
  const rel = (date: string, label: string, kind: OverlayItem['kind'] = 'minor-release'): OverlayItem => ({ kind, date, label, note: 'note of ' + label })
  it('one marker under the pointer shows just that marker; empty space shows nothing', () => {
    const { move } = mk([rel('2026-10-27', 'solo')])
    expect(move(50)).toEqual(['2026-10-27 · solo', 'note of solo'])
    expect(move(150)).toEqual([])
  })
  it('a hover lists only the markers on the nearest x, never a neighbouring day (5 px a day, hit boxes overlap)', () => {
    const { move } = mk([rel('2026-10-27', 'before'), rel('2026-10-28', 'web'), rel('2026-10-28', 'Play'), rel('2026-10-29', 'after')], 5)
    // x = 20 + 5 * index: 10-28 sits at x = 30
    expect(move(30).filter((t) => t.startsWith('2026-'))).toEqual(['2026-10-28 · web', '2026-10-28 · Play'])
    expect(move(26).filter((t) => t.startsWith('2026-'))).toEqual(['2026-10-27 · before'])
  })
  it('many markers on one x are capped to what fits the canvas, with a +N more line', () => {
    const many = Array.from({ length: 8 }, (_, i) => rel('2026-10-28', 'm' + i))
    const out = mk(many, 30, 200).move(80)
    const shown = out.filter((t) => t.startsWith('2026-'))
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan(8)
    expect(out[out.length - 1]).toBe(`+${8 - shown.length} more, listed under the chart`)
    expect(mk(many, 30, 2000).move(80).some((t) => t.startsWith('+'))).toBe(false)
  })
  it('markers that share an x position all show, in item order (two and three)', () => {
    const two = mk([rel('2026-10-28', 'web'), rel('2026-10-28', 'Play', 'release')])
    expect(two.move(80)).toEqual(['2026-10-28 · web', 'note of web', '2026-10-28 · Play', 'note of Play'])
    const three = mk([rel('2026-10-28', 'a'), rel('2026-10-28', 'b', 'go-live'), rel('2026-10-28', 'c', 'release'), rel('2026-10-29', 'other')])
    expect(three.move(80).filter((t) => t.startsWith('2026-'))).toEqual(['2026-10-28 · a', '2026-10-28 · b', '2026-10-28 · c'])
    expect(three.move(110).filter((t) => t.startsWith('2026-'))).toEqual(['2026-10-29 · other'])
  })
})

// ── Before and after readout (lib/beforeAfter.ts) ─────────────────────────────────────────────
describe('compareWindows', () => {
  const axis = days('2026-11-01', 14) // 11-01 .. 11-14

  it('leaves the marker day out and takes equal runs: the most days both sides have', () => {
    const w = compareWindows(axis, '2026-11-09', '2026-11-20')
    // before 11-01..11-08 = 8 days, after 11-10..11-14 = 5 days: 5 each, the 5 days right before the marker
    expect(w.before.map((i) => axis[i])).toEqual(['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'])
    expect(w.after.map((i) => axis[i])).toEqual(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'])
    expect(w.afterAvailable).toBe(5)
    expect(w.beforeAvailable).toBe(8)
  })

  it('never counts today (a partial day) in the after run', () => {
    const w = compareWindows(axis, '2026-11-09', '2026-11-14')
    expect(w.after.map((i) => axis[i])).toEqual(['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'])
    expect(w.before).toHaveLength(4)
  })

  it('clips to the range when the marker is near its start', () => {
    const w = compareWindows(axis, '2026-11-03', '2026-11-20')
    expect(w.before.map((i) => axis[i])).toEqual(['2026-11-01', '2026-11-02'])
    expect(w.after).toHaveLength(2)
  })
})

describe('compareReadoutText', () => {
  const axis = days('2026-11-01', 14)
  const target = { id: 'first-50-ended', label: 'First-50 days end', date: '2026-11-09' }
  const flat = (v: (i: number) => number) => axis.map((_, i) => v(i))

  it('says avg/day before, after and the percent change, per series, over equal windows', () => {
    // before (11-04..11-08, indexes 3..7) = 10 each; after (11-10..11-14 but 11-14 is today so 11-10..11-13 = 4 days): windows are 4 and 4
    const text = compareReadoutText(target, axis, [{ label: 'Web', values: flat((i) => (i < 8 ? 10 : 15)) }], '2026-11-14')!
    expect(text).toContain('**Before and after First-50 days end (2026-11-09):** the 4 days each side, the marker day left out.')
    expect(text).toContain('Web, avg/day before: 10, after: 15 (+50%)')
  })

  it('too few complete days after: says so and gives no numbers', () => {
    const text = compareReadoutText(target, axis, [{ label: 'Web', values: flat(() => 4) }], '2026-11-11')!
    expect(text).toBe('**Before and after First-50 days end (2026-11-09):** only 1 complete day after it so far (it takes 3), too early to compare.')
    expect(compareReadoutText(target, axis, [{ label: 'Web', values: flat(() => 4) }], '2026-11-10')).toContain('only 0 complete days')
  })

  it('too few days before in the range: asks to widen it', () => {
    const t = { ...target, date: '2026-11-03' }
    const text = compareReadoutText(t, axis, [{ label: 'Web', values: flat(() => 4) }], '2026-11-20')!
    expect(text).toContain('only 2 days before it in this range')
    expect(text).not.toContain('avg/day')
  })

  it('handles series that are all zero: no change, and from zero', () => {
    const zeros = compareReadoutText(target, axis, [{ label: 'Paywall', values: flat(() => 0) }], '2026-11-20')!
    expect(zeros).toContain('Paywall, avg/day before: 0, after: 0 (no change)')
    const rises = compareReadoutText(target, axis, [{ label: 'Paywall', values: flat((i) => (i > 8 ? 2 : 0)) }], '2026-11-20')!
    expect(rises).toContain('avg/day before: 0, after: 2 (from zero)')
    const drops = compareReadoutText(target, axis, [{ label: 'Paywall', values: flat((i) => (i > 8 ? 0 : 3)) }], '2026-11-20')!
    expect(drops).toContain('avg/day before: 3, after: 0 (-100%)')
  })

  it('a ratio series pools the run (total over total), and reports points, not percent of a percent', () => {
    const num = flat((i) => (i < 8 ? 1 : 3))
    const den = flat((i) => (i < 8 ? 10 : 10))
    const text = compareReadoutText(target, axis, [{ label: 'Accept rate', values: num.map((n, i) => (n / den[i]) * 100), ratio: { num, den } }], '2026-11-20')!
    expect(text).toContain('Accept rate: before: 10%, after: 30% (+20 points)')
  })

  it('a ratio with nothing to divide by shows none, not NaN', () => {
    const z = flat(() => 0)
    const text = compareReadoutText(target, axis, [{ label: 'Rate', values: z.map(() => null), ratio: { num: z, den: z } }], '2026-11-20')!
    expect(text).toContain('Rate: before: none, after: none')
    expect(text).not.toContain('NaN')
  })

  it('an unknown marker gives no readout', () => {
    expect(compareReadoutText(null, axis, [], '2026-11-20')).toBeNull()
  })

  it('a rolling range that starts mid-day: the partial first day is no "before" day (8d range, marker 11-09)', () => {
    // 8d range on 11-14: plotted 11-06 .. 11-14, the 11-06 bucket is a few hours only (4 against a normal 10).
    const eight = days('2026-11-06', 9)
    const web = { label: 'Web', values: eight.map((d) => (d === '2026-11-06' ? 4 : 10)) }
    // Counting the partial day as a whole one (the old behaviour) makes a flat series a 25% "rise" ((10+10+10)/3 vs (4+10+10)/3).
    const old = compareReadoutText({ id: 'x', label: 'First-50 days end', date: '2026-11-09' }, eight, [web], '2026-11-14')!
    expect(old).toContain('avg/day before: 8, after: 10 (+25%)')
    const text = compareReadoutText({ id: 'x', label: 'First-50 days end', date: '2026-11-09' }, eight, [web], '2026-11-14', true)!
    expect(text).toBe('**Before and after First-50 days end (2026-11-09):** only 2 days before it in this range (it takes 3); widen the range to compare.')
    const w = compareWindows(eight, '2026-11-09', '2026-11-14', true)
    expect(w.beforeAvailable).toBe(2)
    expect(w.before.map((i) => eight[i])).toEqual(['2026-11-07', '2026-11-08'])
  })

  it('a partial first day is left out of the after run too', () => {
    const range = days('2026-11-08', 8) // 11-08 .. 11-15
    expect(compareWindows(range, '2026-11-07', '2026-11-20', false).afterAvailable).toBe(8)
    expect(compareWindows(range, '2026-11-07', '2026-11-20', true).afterAvailable).toBe(7)
  })

  it('a marker before the whole plotted range says so, not "too early"', () => {
    // 2d page range on 11-14: plotted 11-12 .. 11-14, the change was on 11-09.
    const three = days('2026-11-12', 3)
    const text = compareReadoutText({ id: 'x', label: 'First-50 days end', date: '2026-11-09' }, three, [{ label: 'Web', values: [5, 6, 7] }], '2026-11-14', true)!
    expect(text).toBe('**Before and after First-50 days end (2026-11-09):** this change is before the shown range; widen the range to compare.')
    expect(text).not.toContain('too early')
  })

  it('"too early" stays for a marker inside the range with fewer than 3 whole days after it', () => {
    const text = compareReadoutText({ id: 'x', label: 'First-50 days end', date: '2026-11-09' }, days('2026-11-01', 12), [{ label: 'Web', values: Array(12).fill(5) }], '2026-11-11')!
    expect(text).toContain('only 1 complete day after it so far (it takes 3), too early to compare.')
  })
})

describe('seriesDayModel firstDayPartial', () => {
  const mkResp = (since: string, until: string): StatsResponse => ({
    rows: [
      { key: { dateEt: '2026-11-06' }, pageviews: 4, visits: 4 },
      { key: { dateEt: '2026-11-07' }, pageviews: 10, visits: 10 },
    ],
    totals: { pageviews: 14, visits: 14 },
    meta: { site: 'all', host: null, since, until, dimensions: ['dateEt'], metric: 'pageviews' },
  })
  const widget = { ...timelineWidget({ x: 0, y: 0, w: 12, h: 12 }), series: [{ label: 'Web' }] }
  it('is true when the range starts part-way through the first ET day (a rolling range)', () => {
    expect(seriesDayModel(widget, [mkResp('2026-11-06T22:00:00.000Z', '2026-11-14T22:00:00.000Z')])!.firstDayPartial).toBe(true)
  })
  it('is false when the range starts on an ET midnight (a whole-day window), or the axis was trimmed to the first day with data', () => {
    expect(seriesDayModel(widget, [mkResp('2026-11-06T05:00:00.000Z', '2026-11-14T22:00:00.000Z')])!.firstDayPartial).toBe(false)
    const trimmed = seriesDayModel(widget, [mkResp('2026-11-04T22:00:00.000Z', '2026-11-14T22:00:00.000Z')])!
    expect(trimmed.days[0]).toBe('2026-11-06')
    expect(trimmed.firstDayPartial).toBe(false)
  })
})

describe('compareTargets', () => {
  it('offers the labelled releases and the product changes, newest first, ids unique, and resolves each id', () => {
    const t = compareTargets()
    const ids = t.map((x) => x.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('v1.107.0 web')
    expect(ids).toContain('v1.108.0 web')
    expect(ids).toContain('first-50-ended')
    expect(ids).toContain('play-listing-fixed')
    expect(ids).toContain('v1.108.0 Play')
    expect([...t.map((x) => x.date)].sort().reverse()).toEqual(t.map((x) => x.date))
    expect(compareTarget('first-50-ended')).toMatchObject({ label: 'First-50 days end', date: '2026-11-09' })
    expect(compareTarget('v1.107.0 web')).toMatchObject({ label: 'v1.107.0 sign-in copy', date: '2026-11-04' })
    expect(compareTarget('nope')).toBeNull()
    expect(compareTarget(undefined)).toBeNull()
  })
})

// ── Ratio series (LineSeries.ratio) ───────────────────────────────────────────────────────────
describe('a ratio series on the series line chart', () => {
  const resp = (rows: [string, number][]): StatsResponse => ({
    rows: rows.map(([date, c]) => ({ key: { date }, pageviews: c, visits: c })),
    totals: { pageviews: 0, visits: 0 },
    meta: { site: 'all', host: null, since: '2026-11-01', until: '2026-11-04', dimensions: ['date'], metric: 'pageviews' },
  })
  const widget: Widget = {
    id: 'r',
    i: 'r',
    title: 'Sign-in ask',
    type: 'line',
    dataset: 'geo',
    dimension: 'date',
    metric: 'pageviews',
    limit: 500,
    x: 0,
    y: 0,
    w: 6,
    h: 8,
    series: [
      { label: 'Shown', axis: 'left', style: 'solid' },
      { label: 'Accepted', axis: 'left', style: 'solid' },
      { label: 'Accept rate', axis: 'right', style: 'dashed', ratio: { num: 1, den: 0 } },
    ],
  }
  const responses = [resp([['2026-11-01', 10], ['2026-11-02', 0], ['2026-11-03', 20], ['2026-11-04', 8]]), resp([['2026-11-01', 5], ['2026-11-03', 5], ['2026-11-04', 6]]), resp([])]

  it('is accepted over shown per day as a percent, empty (a gap) on a day nothing was shown', () => {
    const model = seriesDayModel(widget, responses)!
    expect(model.days).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'])
    expect(model.values[0]).toEqual([10, 0, 20, 8])
    expect(model.values[2]).toEqual([50, null, 25, 75])
  })

  it('draws it on the right axis with a % tick label, flagged for the tooltip; the counts stay on the left', () => {
    const cfg: any = buildSeriesLineConfig(widget, responses)
    expect(cfg.data.datasets.map((d: any) => d.yAxisID)).toEqual(['y', 'y', 'y2'])
    expect(cfg.data.datasets[2]).toMatchObject({ data: [50, null, 25, 75], isRatio: true })
    expect(cfg.data.datasets[0].isRatio).toBeUndefined()
    expect(cfg.options.scales.y2.ticks.callback(30)).toBe('30%')
    expect(cfg.options.plugins.tooltip.callbacks.label({ dataset: cfg.data.datasets[2], parsed: { y: 33.333 }, formattedValue: '33.3' })).toBe('Accept rate: 33.3%')
    expect(cfg.options.plugins.tooltip.callbacks.label({ dataset: cfg.data.datasets[0], parsed: { y: 10 }, formattedValue: '10' })).toBe('Shown: 10')
  })

  it('a chart without a ratio series is unchanged: no tooltip override, no % ticks, no isRatio', () => {
    const plain: Widget = { ...widget, series: widget.series!.slice(0, 2) }
    const cfg: any = buildSeriesLineConfig(plain, responses.slice(0, 2))
    expect(cfg.options.plugins.tooltip).toBeUndefined()
    expect(cfg.options.scales.y2).toBeUndefined()
    expect(cfg.data.datasets.some((d: any) => 'isRatio' in d)).toBe(false)
  })

  it('a right-axis count series next to the ratio keeps the plain tick labels (no % on counts)', () => {
    const mixed: Widget = { ...widget, series: [...widget.series!.slice(0, 2).map((s, i) => (i === 0 ? { ...s, axis: 'right' as const } : s)), widget.series![2]] }
    const cfg: any = buildSeriesLineConfig(mixed, responses)
    expect(cfg.options.scales.y2.ticks.callback).toBeUndefined()
  })

  it('the ratio stays out of the step-series request: featureStepSeriesOf ignores it', () => {
    const steps: Widget = {
      ...widget,
      series: [
        { label: 'Shown', filter: [{ field: 'featureStep', value: 'signin.shown' }] },
        { label: 'Accepted', filter: [{ field: 'featureStep', value: 'signin.accept' }] },
        { label: 'Accept rate', axis: 'right', ratio: { num: 1, den: 0 } },
      ],
    }
    expect(featureStepSeriesOf(steps)).toEqual(['signin.shown', 'signin.accept'])
  })
})

describe('a plain date chart with only product changes on', () => {
  it('leaves room above the plot for the change labels, as it does for release labels', () => {
    const w: Widget = { id: 'p', i: 'p', title: 'Page views', type: 'line', dataset: 'geo', dimension: 'date', metric: 'pageviews', limit: 500, x: 0, y: 0, w: 6, h: 8, changeMarkers: true }
    const r: StatsResponse = {
      rows: [{ key: { date: '2026-11-08' }, pageviews: 3, visits: 3 }, { key: { date: '2026-11-09' }, pageviews: 4, visits: 4 }, { key: { date: '2026-11-10' }, pageviews: 5, visits: 5 }],
      totals: { pageviews: 12, visits: 12 },
      meta: { site: 'all', host: null, since: '2026-11-08', until: '2026-11-10', dimensions: ['date'], metric: 'pageviews' },
    }
    const cfg: any = buildChartConfig(w, r)
    expect(cfg.options.layout.padding.top).toBeGreaterThanOrEqual(24)
    const off: any = buildChartConfig({ ...w, changeMarkers: undefined }, r)
    expect(off.options.layout?.padding?.top).toBeUndefined()
  })
})
