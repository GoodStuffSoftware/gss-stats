import type { ChartConfiguration } from 'chart.js'
import type { DrillConstraint, GlobalFilters, Widget, StatsResponse, StatsRow, Metric } from '../types'
import { COUNTRY_NAMES } from './catalog'
import { ringDims, isDateDim } from './rings'
import { etDateFast } from './etTime'
import { TRACKING_ACTIVATION_DATE_ET, PLAY_TRACKING_MARKER_LABEL, POPUPS, POPUP_FAMILY_ORDER, POPUP_OUTCOME_ORDER, POPUP_OUTCOME_LABELS } from './popupEvents'
import { GAME_COMPLETE_MODES, GAME_COMPLETE_DIFFICULTIES, CAMPAIGNS, flightDayIndex, type CampaignFlight } from './campaigns'
import { campaignSegmentMarker, UPSELL_SIGNEDOUT_FIX_AT } from './adsRules'
import { isMobileViewport } from './responsive'
import { layoutMarkerLabels } from './markerLayout'
import { overlayItems, layoutFlightBands, markerIndex, type OverlayItem } from './timelineOverlay'

// Categorical palette: brand amber leads, with distinguishable warm/cool accents.
export const PALETTE = [
  '#E0722C', // amber (brand)
  '#2C7DA0', // teal
  '#9C6644', // cocoa
  '#6A994E', // olive green
  '#BC4749', // brick
  '#577590', // slate blue
  '#E9C46A', // gold
  '#8A8278', // warm grey
  '#A8631F', // burnt amber
  '#43AA8B', // mint
  '#7B4B94', // plum
  '#D88C9A', // rose
]

const INK = '#1A1715'
const INK_3 = '#8A8278'
const LINE = '#E7E2D7'

// ── Consistent series colors ────────────────────────────────────────────────
// A known categorical value gets a FIXED color so it reads the same on every chart and
// page (e.g. "mobile" is always the same swatch, "returning" always the same), instead of
// being colored by its sort position. Keyed by a normalized dimension → value → color.
const STABLE_COLORS: Record<string, Record<string, string>> = {
  device: { desktop: PALETTE[0], mobile: PALETTE[1], tablet: PALETTE[2], tv: PALETTE[5], bot: PALETTE[7] },
  visitor: { returning: PALETTE[0], new: PALETTE[1] },
  // Pop-up outcomes: shown is the brand hue, then one fixed color per tap/outcome, so the same
  // series reads the same on every breakdown chart. Install's raw signals share muted tones.
  popupOutcome: {
    shown: PALETTE[0],
    accept: PALETTE[1],
    dismiss: PALETTE[7],
    'signed-in': PALETTE[3],
    installed: PALETTE[9],
    returned: PALETTE[5],
    'still-playing': PALETTE[10],
    'pwa-installed': PALETTE[2],
    'standalone-detected': PALETTE[8],
    'play-detected': PALETTE[6],
  },
}
// Dimensions that read as an ordered magnitude rather than distinct categories → a single
// brand-hue ramp (most opaque = highest, fading down the sorted list) instead of a rainbow.
const GRADIENT_DIMS = new Set(['region', 'country', 'countryName'])
const RAMP_RGB = '224,114,44' // brand amber (PALETTE[0]) as rgb, for rgba() opacity ramps

function normDimKey(dim: string): string {
  return dim === 'deviceType' ? 'device' : dim
}
function stableColor(dim: string, rawValue: string): string | null {
  const map = STABLE_COLORS[normDimKey(dim)]
  return map ? (map[String(rawValue).toLowerCase()] ?? null) : null
}
function rampColor(i: number, total: number): string {
  const t = total <= 1 ? 0 : i / (total - 1) // rows arrive sorted desc → i=0 is the highest
  const alpha = 1 - t * 0.72 // 1.0 at the top, ~0.28 at the bottom
  return `rgba(${RAMP_RGB},${alpha.toFixed(3)})`
}
// Background colors for a single-dimension series, computed from the RAW values (not the
// display labels, which may be re-cased/renamed). Gradient dims ramp; known categoricals
// use their fixed color; everything else falls back to the positional palette.
export function seriesColors(dim: string, rawValues: string[]): string[] {
  if (GRADIENT_DIMS.has(dim)) return rawValues.map((_, i) => rampColor(i, rawValues.length))
  return rawValues.map((v, i) => stableColor(dim, v) ?? PALETTE[i % PALETTE.length])
}

// ── Color shading (for nested-ring charts: one base hue per primary, shaded per breakdown) ──
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('')
}
/** amount > 0 lightens toward white, < 0 darkens toward black. */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex)
  if (amount >= 0) return rgbToHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount)
  const k = 1 + amount
  return rgbToHex(r * k, g * k, b * k)
}

// Draws the grand total in the hole of a (nested) doughnut.
function centerTextPlugin(total: number, sub: string) {
  return {
    id: 'centerText',
    afterDraw(chart: any) {
      const { ctx, chartArea } = chart
      if (!chartArea) return
      const cx = (chartArea.left + chartArea.right) / 2
      const cy = (chartArea.top + chartArea.bottom) / 2
      ctx.save()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = isDark() ? '#F4F1EA' : INK
      ctx.font = '700 21px "Space Grotesk", system-ui, sans-serif'
      ctx.fillText(total.toLocaleString('en-US'), cx, cy - 7)
      ctx.fillStyle = tickColor()
      ctx.font = '10px Inter, system-ui, sans-serif'
      ctx.fillText(sub, cx, cy + 13)
      ctx.restore()
    },
  }
}

// Pick a legible text color for a given fill.
function textOn(hex: string): string {
  const [r, g, b] = hexToRgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? '#1A1715' : '#ffffff'
}

// Draws "name + count" on each arc of the given datasets (both rings of a nested
// doughnut), so every segment is self-labeled — no legend or hover needed. Skips
// slivers too small to fit a label; those stay on hover.
type ArcItem = { name: string; sub: string }

// Draw text curved along a circle of radius r, centered on midAngle. Characters
// stay tangent to the ring; the bottom half is flipped so text reads upright all
// the way around. Uses the currently-set ctx font / fillStyle / align / baseline.
function drawCurvedText(ctx: any, text: string, cx: number, cy: number, r: number, midAngle: number) {
  if (r <= 0 || !text) return
  const chars = [...text]
  const widths = chars.map((c) => ctx.measureText(c).width)
  const totalAngle = widths.reduce((a, b) => a + b, 0) / r
  const ma = ((midAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const bottom = ma > 0 && ma < Math.PI // bottom half (canvas y is down) → flip
  let a = bottom ? midAngle + totalAngle / 2 : midAngle - totalAngle / 2
  for (let i = 0; i < chars.length; i++) {
    const ca = widths[i] / r
    a += bottom ? -ca / 2 : ca / 2
    ctx.save()
    ctx.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    ctx.rotate(bottom ? a - Math.PI / 2 : a + Math.PI / 2)
    ctx.fillText(chars[i], 0, 0)
    ctx.restore()
    a += bottom ? -ca / 2 : ca / 2
  }
}

function arcLabelsPlugin(itemsByDataset: Record<number, ArcItem[]>) {
  return {
    id: 'arcLabels',
    afterDatasetsDraw(chart: any) {
      const ctx = chart.ctx
      for (const key of Object.keys(itemsByDataset)) {
        const di = Number(key)
        const ds = chart.data.datasets[di]
        if (!ds) continue
        const meta = chart.getDatasetMeta(di)
        const colors = (ds.backgroundColor as string[]) ?? []
        const items = itemsByDataset[di] ?? []
        meta.data.forEach((arc: any, i: number) => {
          const it = items[i]
          if (!it) return
          const span = arc.endAngle - arc.startAngle
          if (span < 0.2) return // ~11°, too small to label
          const mid = (arc.startAngle + arc.endAngle) / 2
          const bandMid = (arc.innerRadius + arc.outerRadius) / 2
          const ma = ((mid % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
          const bottom = ma > 0 && ma < Math.PI
          // keep "name" visually above "sub" on either half
          const nameR = bottom ? bandMid - 6 : bandMid + 6
          const subR = bottom ? bandMid + 6 : bandMid - 6
          ctx.save()
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillStyle = textOn(colors[i] ?? '#888888')
          ctx.font = '600 10px Inter, system-ui, sans-serif'
          const nameFits = ctx.measureText(it.name).width / nameR < span * 0.96
          if (nameFits) drawCurvedText(ctx, it.name, arc.x, arc.y, nameR, mid)
          // only show the number line if the name fit too — no orphan "9 · 13%"
          ctx.font = '700 11px "Space Grotesk", system-ui, sans-serif'
          if (nameFits && ctx.measureText(it.sub).width / subR < span * 0.96) drawCurvedText(ctx, it.sub, arc.x, arc.y, subR, mid)
          ctx.restore()
        })
      }
    },
  }
}

// ── Pop-up trend charts: "tracking starts" marker + pre-activation de-emphasis (Part A
// hard requirement: "before activation is unmeasured, not zero" — see
// lib/popupEvents.ts TRACKING_ACTIVATION_DATE_ET) ──────────────────────────────────
// Index (into a zero-filled 'date' series `rows`, see seriesRows) of the boundary
// between pre- and post-activation days: the first index on/after `activationDateEt`,
// or `rows.length` (every plotted day is still pre-activation) when there's no such day
// in range, or -1 when there's no activation date at all (exported for tests).
export function activationMarkerIndex(rows: { key: { date?: string } }[], activationDateEt: string | null): number {
  if (!activationDateEt) return -1
  const idx = rows.findIndex((r) => (r.key.date ?? '') >= activationDateEt)
  return idx === -1 ? rows.length : idx
}

// Vertical dashed boundary + a "tracking starts" label at the activation day — only drawn
// when the boundary actually falls within (or at the edge of) the visible chart area.
// `label`/`id` are parameterized so the SAME plugin draws either the web "tracking starts"
// marker (TRACKING_ACTIVATION_DATE_ET) or the Play/Android one (PLAY_TRACKING_ACTIVATION_
// DATE_ET, see lib/popupEvents.ts) — two distinct, independently-gated boundaries a chart
// may need to draw at once, so they can't share a Chart.js plugin id.
function activationMarkerPlugin(index: number, label = 'tracking starts', id = 'activationMarker') {
  return {
    id,
    afterDraw(chart: any) {
      const { ctx, chartArea, scales } = chart
      if (!chartArea || !scales?.x) return
      const x = scales.x.getPixelForValue(index)
      if (x == null || Number.isNaN(x) || x < chartArea.left || x > chartArea.right) return
      ctx.save()
      ctx.strokeStyle = isDark() ? 'rgba(231,226,215,0.45)' : 'rgba(26,23,21,0.35)'
      ctx.setLineDash([4, 3])
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, chartArea.top)
      ctx.lineTo(x, chartArea.bottom)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = tickColor()
      ctx.font = '600 10px Inter, system-ui, sans-serif'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      const labelX = Math.min(x + 5, chartArea.right - ctx.measureText(label).width - 2)
      ctx.fillText(label, Math.max(chartArea.left + 2, labelX), chartArea.top + 3)
      ctx.restore()
    },
  }
}

/** The Play/Android twin of the web activation marker above — draws
 * PLAY_TRACKING_MARKER_LABEL at PLAY_TRACKING_ACTIVATION_DATE_ET's boundary. That date is
 * the Play production-track SUBMISSION day, not an arrival — see lib/popupEvents.ts — so,
 * unlike the web marker, this is a "reaching devices from here" flag, not a hard
 * before/after step; nothing after this boundary should be treated as unmeasured or
 * grayed out. Exported (unlike the web marker, which stays module-private) because it's
 * opt-in per chart: only a chart that actually plots bestsudoku-app /return or
 * Play-referrer data should add it.
 *
 * UNUSED as of this commit (review note, 2026-09-26) — no chart plots a bestsudoku-app
 * `/return` or Play-referrer date-axis series yet, so nothing calls this. It's kept ready
 * for when one exists; wire it in the same way the web marker is wired into the pop-up
 * 'date' trend (see seriesRows/ChartCard.vue's `boundary`/`plugins` computation). If a
 * chart ever needs BOTH markers at once (a web date-axis series that also has Play data),
 * this plugin's label needs a vertical offset from the web marker's — right now both draw
 * their label at the same `chartArea.top + 3`, so two boundaries close together would
 * overlap illegibly. */
export function playActivationMarkerPlugin(index: number) {
  return activationMarkerPlugin(index, PLAY_TRACKING_MARKER_LABEL, 'playActivationMarker')
}

// Small corner watermark shown instead of the boundary marker while
// TRACKING_ACTIVATION_DATE_ET is still null — the WHOLE series is pre-release, so there's
// no boundary to point at; the page-level note (App.vue) carries the full explanation.
// Best Sudoku release markers (widget.markers === 'releases') on any date-dimension trend
// chart — dashed vertical lines + version label, on the Overview timeline and on any other
// trend (the launch/traffic page's own, for one). `rows` are
// the chart's own plotted rows (zero-filled — see seriesRows), so the marker lands on the
// correct category-axis INDEX, not a raw date value (the x axis here is a category axis of
// formatted labels, not real date values — see formatKey).
/** The overlay switches on a date-axis line chart (release markers, go-live markers, campaign
 * flight bands — see lib/timelineOverlay.ts). */
export function widgetOverlayOptions(widget: Pick<Widget, 'markers' | 'goLiveMarkers' | 'flightBands'>) {
  return { releases: widget.markers === 'releases', goLive: !!widget.goLiveMarkers, flights: !!widget.flightBands }
}
export function widgetHasOverlay(widget: Pick<Widget, 'markers' | 'goLiveMarkers' | 'flightBands'>): boolean {
  const o = widgetOverlayOptions(widget)
  return o.releases || o.goLive || o.flights
}

/** Draws a date-axis chart's overlay: shaded flight bands (labelled, one label row per overlap),
 * dashed labelled lines for major releases and go-live moments (labels placed by
 * layoutMarkerLabels, so close markers stagger instead of colliding, and a label that fits
 * nowhere is dropped, not overprinted), short ticks for minor releases. Hover or tap near a
 * marker line, or on a band's label strip, shows that item's date, name and note. `dates` are
 * the plotted category values (YYYY-MM-DD), in order. */
export function timelineOverlayPlugin(dates: string[], items: OverlayItem[], narrow = false) {
  const dark = isDark()
  const lineColor = dark ? 'rgba(240,238,233,0.45)' : 'rgba(26,23,21,0.4)'
  const labelColor = dark ? 'rgba(240,238,233,0.8)' : 'rgba(26,23,21,0.72)'
  const tickColor = dark ? 'rgba(240,238,233,0.3)' : 'rgba(26,23,21,0.3)'
  const bands = layoutFlightBands(dates, items.filter((i) => i.kind === 'flight'))
  const points = items
    .filter((i) => i.kind !== 'flight')
    .map((i) => ({ item: i, index: markerIndex(dates, i.date) }))
    .filter((p) => p.index !== -1)
  // Hit areas from the last draw, for hover/tap.
  let hits: { x0: number; x1: number; y0: number; y1: number; item: OverlayItem }[] = []
  let active: { item: OverlayItem; x: number; y: number } | null = null
  const bandFlightIndex = new Map(items.filter((i) => i.kind === 'flight').map((it, n) => [it, n]))
  return {
    id: 'timelineOverlay',
    beforeDatasetsDraw(chart: any) {
      const { ctx, chartArea, scales } = chart
      if (!chartArea || !scales?.x) return
      hits = []
      const half = dates.length > 1 ? Math.abs(scales.x.getPixelForValue(1) - scales.x.getPixelForValue(0)) / 2 : 12
      ctx.save()
      ctx.font = '600 9px Inter, system-ui, sans-serif'
      for (const b of bands) {
        const left = Math.max(chartArea.left, scales.x.getPixelForValue(b.startIndex) - half)
        const right = Math.min(chartArea.right, scales.x.getPixelForValue(b.endIndex) + half)
        if (right <= left) continue
        const color = PALETTE[(bandFlightIndex.get(b.item) ?? 0) % PALETTE.length]
        ctx.fillStyle = color + '22'
        ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top)
        // A band's name sits in a strip at its bottom edge; an open-ended band gets an arrow.
        const y = chartArea.bottom - 4 - b.row * 11
        const text = `${b.item.label}${b.clippedEnd && b.item.openEnded ? ' →' : ''}`
        let shown = text
        const room = right - left - 6
        while (shown.length > 1 && ctx.measureText(shown).width > room) shown = shown.slice(0, -2) + '…'
        if (room > 14) {
          ctx.fillStyle = color
          ctx.textAlign = 'left'
          ctx.fillText(shown, left + 3, y)
        }
        hits.push({ x0: left, x1: right, y0: y - 10, y1: y + 2, item: b.item })
      }
      ctx.restore()
    },
    afterDatasetsDraw(chart: any) {
      const { ctx, chartArea, scales } = chart
      if (!chartArea || !scales?.x) return
      const labelled: { x: number; label: string }[] = []
      ctx.save()
      for (const p of points) {
        const x = scales.x.getPixelForValue(p.index)
        if (x == null || Number.isNaN(x) || x < chartArea.left || x > chartArea.right) continue
        if (p.item.kind === 'minor-release') {
          ctx.strokeStyle = tickColor
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(x, chartArea.top)
          ctx.lineTo(x, chartArea.top + 6)
          ctx.stroke()
        } else {
          ctx.strokeStyle = lineColor
          ctx.lineWidth = 1.2
          ctx.setLineDash(p.item.kind === 'go-live' ? [2, 3] : [4, 3])
          ctx.beginPath()
          ctx.moveTo(x, chartArea.top)
          ctx.lineTo(x, chartArea.bottom)
          ctx.stroke()
          ctx.setLineDash([])
          labelled.push({ x, label: p.item.label })
        }
        hits.push({ x0: x - 6, x1: x + 6, y0: chartArea.top - 34, y1: chartArea.bottom, item: p.item })
      }
      // Labels above the plot, in the layout padding: staggered into rows; at phone width only
      // two rows, so crowded labels drop out (every item stays in the list under the chart).
      ctx.font = '600 9.5px Inter, system-ui, sans-serif'
      const placed = layoutMarkerLabels(labelled, {
        measureWidth: (t) => ctx.measureText(t).width,
        areaLeft: chartArea.left,
        areaRight: chartArea.right,
        maxRows: narrow ? 2 : 3,
        rowHeight: 10,
      })
      ctx.fillStyle = labelColor
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      const top = chartArea.top - (narrow ? 22 : 32)
      for (const l of placed) ctx.fillText(l.label, l.x, top + l.y)
      ctx.restore()
    },
    afterEvent(chart: any, args: any) {
      const e = args.event
      if (!e) return
      if (e.type === 'mouseout') {
        if (active) {
          active = null
          args.changed = true
        }
        return
      }
      if (e.type !== 'mousemove' && e.type !== 'click') return
      const hit = hits.find((h) => e.x >= h.x0 && e.x <= h.x1 && e.y >= h.y0 && e.y <= h.y1)
      const next = hit ? { item: hit.item, x: e.x, y: e.y } : null
      if ((next?.item ?? null) !== (active?.item ?? null)) {
        active = next
        args.changed = true
      }
    },
    afterDraw(chart: any) {
      if (!active) return
      const { ctx, chartArea } = chart
      const it = active.item
      const when = it.kind === 'flight' ? `${it.date} to ${it.openEnded ? 'now' : it.endDate}` : it.date
      const lines = [`${when} · ${it.label}`, ...wrapText(ctx, it.note, 220)]
      ctx.save()
      ctx.font = '11px Inter, system-ui, sans-serif'
      const w = Math.min(240, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14)
      const h = lines.length * 14 + 10
      const x = Math.min(Math.max(chartArea.left, active.x + 8), chartArea.right - w)
      const y = chartArea.top + 4
      ctx.fillStyle = dark ? 'rgba(33,28,24,0.96)' : 'rgba(255,255,255,0.97)'
      ctx.strokeStyle = dark ? 'rgba(240,238,233,0.25)' : 'rgba(26,23,21,0.18)'
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
      ctx.fillStyle = dark ? '#F4F1EA' : INK
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      lines.forEach((l, i) => {
        ctx.font = i === 0 ? '600 11px Inter, system-ui, sans-serif' : '11px Inter, system-ui, sans-serif'
        ctx.fillText(l, x + 7, y + 5 + i * 14)
      })
      ctx.restore()
    },
  }
}
function wrapText(ctx: any, text: string, maxW: number): string[] {
  ctx.font = '11px Inter, system-ui, sans-serif'
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word
    if (line && ctx.measureText(next).width > maxW) {
      out.push(line)
      line = word
    } else line = next
  }
  if (line) out.push(line)
  return out
}

/** A widget that renders its own body (own data fetch, or none) and never loads a chart response:
 * a metric card, the 'overview', 'campaigns' and 'ads-readings' datasets (cards since layout
 * version 11), a pop-up rate tile (a one-item card since layout version 18) and a note. ChartCard skips its fetch for these, so their `chart.*` value tokens
 * (lib/valueTokens.ts) can never fill, and the editor does not offer them. */
export function rendersOwnBody(widget: Pick<Widget, 'card' | 'dataset' | 'type'>): boolean {
  return !!widget.card || widget.dataset === 'overview' || widget.dataset === 'campaigns' || widget.dataset === 'ads-readings' || widget.type === 'note' || widget.type === 'rate'
}

/** True for a line/area chart on the beacon's date axis that draws its own series list. */
export function hasLineSeries(widget: Pick<Widget, 'type' | 'dataset' | 'dimension' | 'series'>): boolean {
  return (widget.type === 'line' || widget.type === 'area') && widget.dataset === 'geo' && isDateDim(widget.dimension) && !!widget.series?.length
}

/** A line chart's series (Widget.series): each one is its own date query, filtered on a geo
 * field (e.g. keyEvent = 'install'), drawn on the left or right axis. `responses` is one
 * StatsResponse per series, in order. */
export function buildSeriesLineConfig(widget: Widget, responses: StatsResponse[]): ChartConfiguration | null {
  const series = widget.series ?? []
  if (!series.length || responses.length !== series.length) return null
  const first = responses[0]
  const dim = widget.dimension
  const allDays = dayBucketsInRange(first.meta.since, first.meta.until, dim === 'dateEt') ?? [...new Set(responses.flatMap((r) => r.rows.map((x) => x.key[dim] ?? '')))].sort()
  const byDay = responses.map((r) => new Map(r.rows.map((x) => [x.key[dim] ?? '', metricValue(x, widget.metric)])))
  // The axis starts at the first day any series has data (a long range, e.g. "since January",
  // would otherwise open with months of flat zeros); every later empty day still plots as 0.
  const firstData = allDays.findIndex((d) => byDay.some((m) => (m.get(d) ?? 0) > 0))
  // A series the server cut to its limit only covers its newest days: start there too.
  const cuts = responses.map((r) => truncatedFrom(dim, r)).filter((c): c is string => !!c)
  const cutFrom = cuts.length ? cuts.reduce((a, b) => (a > b ? a : b)) : ''
  const buckets = (firstData > 0 ? allDays.slice(firstData) : allDays).filter((d) => d >= cutFrom)
  const hasRight = series.some((s) => s.axis === 'right')
  const narrow = isMobileViewport()
  const items = overlayItems(widgetOverlayOptions(widget))
  const hasLabels = items.some((i) => i.kind === 'release' || i.kind === 'go-live')
  const dash = (style?: string) => (style === 'dashed' ? [4, 3] : style === 'dotted' ? [1, 3] : [])
  const axisTitle = (text?: string) => (text ? { display: !narrow, text, color: tickColor(), font: { family: 'Inter', size: 10 } } : { display: false })
  const scales: any = {
    x: { grid: { color: gridColor() }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 }, maxRotation: 0, autoSkip: true } },
    y: { position: 'left', beginAtZero: true, grid: { color: gridColor() }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 } }, title: axisTitle(widget.axisTitles?.left) },
  }
  if (hasRight) {
    scales.y2 = { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 } }, title: axisTitle(widget.axisTitles?.right) }
  }
  return {
    type: 'line',
    data: {
      labels: buckets.map((d) => formatKey('date', d)),
      datasets: series.map((s, i) => {
        const color = PALETTE[s.color ?? i] ?? PALETTE[i % PALETTE.length]
        return {
          label: s.label,
          data: buckets.map((d) => byDay[i].get(d) ?? 0),
          borderColor: color,
          backgroundColor: color,
          yAxisID: s.axis === 'right' ? 'y2' : 'y',
          borderDash: dash(s.style),
          borderWidth: s.style === 'dotted' ? 1.5 : 2,
          tension: 0.2,
          pointRadius: 0,
          pointHitRadius: 16,
          fill: false,
        }
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: hasLabels ? (narrow ? 24 : 34) : 4 } },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: tickColor(), font: { family: 'Inter', size: narrow ? 10 : 11 }, boxWidth: narrow ? 8 : 10, boxHeight: narrow ? 8 : 10, padding: narrow ? 6 : 10 } },
      },
      scales,
    },
    plugins: items.length ? [timelineOverlayPlugin(buckets, items, narrow)] : [],
  } as ChartConfiguration
}

function notYetTrackedWatermarkPlugin() {
  return {
    id: 'notYetTracked',
    afterDraw(chart: any) {
      const { ctx, chartArea } = chart
      if (!chartArea) return
      ctx.save()
      ctx.fillStyle = tickColor()
      ctx.font = '600 10px Inter, system-ui, sans-serif'
      ctx.textAlign = 'right'
      ctx.textBaseline = 'top'
      ctx.fillText('pre-release — not yet tracked', chartArea.right, chartArea.top + 3)
      ctx.restore()
    },
  }
}

const DEVICE_PRIORITY: Record<string, number> = { desktop: 0, mobile: 1, tablet: 2 }

export function metricValue(row: { pageviews: number; visits: number }, metric: Metric): number {
  return metric === 'visits' ? row.visits : row.pageviews
}

// ── Nested doughnut: shared N-ring model ────────────────────────────────────────────────
// A nested doughnut can have an arbitrary number of rings — inner→outer = ringDims(widget)
// (dimension, breakdown, then any further widget.rings; see lib/rings.ts). This model is the
// ONE place that groups rows into ring "paths" and orders them, so buildChartConfig (render)
// and nestedDoughnutClickValue (drill-down) can never disagree on which arc holds which value.
interface NestedDoughnutModel {
  dims: string[] // ring dimensions, innermost → outermost
  // pathsAtDepth[d] = every distinct value-path of length d+1 that has data, in draw order.
  // A "path" is dims[0..d]'s values for one arc, e.g. ['starrupture','mobile','Android'].
  pathsAtDepth: string[][][]
  total: (path: string[]) => number // a path's summed metric value
  grand: number // ring-0 total (the whole doughnut)
}
function nestedDoughnutModel(widget: Widget, resp: StatsResponse): NestedDoughnutModel {
  const dims = ringDims(widget)
  const sums = new Map<string, number>() // `${depth}:${path.join('||')}` -> value
  const keyOf = (depth: number, path: string[]) => `${depth}:${path.join('||')}`
  for (const r of resp.rows) {
    const vals = dims.map((d) => r.key[d] ?? '')
    const v = metricValue(r, widget.metric)
    for (let depth = 0; depth < dims.length; depth++) {
      const k = keyOf(depth, vals.slice(0, depth + 1))
      sums.set(k, (sums.get(k) ?? 0) + v)
    }
  }
  const total = (path: string[]) => sums.get(keyOf(path.length - 1, path)) ?? 0

  // Ring 0 (innermost): distinct primary values, ordered by total desc (site-major, as before).
  const ring0 = [...new Set(resp.rows.map((r) => r.key[dims[0]] ?? ''))]
  ring0.sort((a, b) => total([b]) - total([a]))
  const pathsAtDepth: string[][][] = [ring0.map((v) => [v])]

  // Ring 1+: each ring's distinct values get ONE global order — the same priority-then-alpha
  // rule the original 2-ring "device" breakdown used — applied under every parent path,
  // skipping any (parent, child) combination that has no data. This is the original
  // `primaries.forEach(p => devOrder.forEach(d => ...))` double loop, extended to N depths.
  for (let depth = 1; depth < dims.length; depth++) {
    const valueSet = new Set<string>()
    for (const r of resp.rows) valueSet.add(r.key[dims[depth]] ?? '')
    const order = [...valueSet].sort(
      (a, b) => (DEVICE_PRIORITY[a] ?? 9) - (DEVICE_PRIORITY[b] ?? 9) || a.localeCompare(b),
    )
    const paths: string[][] = []
    for (const parent of pathsAtDepth[depth - 1]) {
      for (const child of order) {
        const candidate = [...parent, child]
        if (total(candidate) > 0) paths.push(candidate)
      }
    }
    pathsAtDepth.push(paths)
  }

  const grand = pathsAtDepth[0].reduce((a, p) => a + total(p), 0)
  return { dims, pathsAtDepth, total, grand }
}

// Resolve a clicked nested-doughnut arc back to its dimension + value, for drill-down. Chart.js
// draws dataset[0] as the OUTERMOST ring (see buildChartConfig, which pushes datasets
// outermost→innermost), so datasetIndex 0 = the last ring dim, and the last dataset = ring 0
// (widget.dimension). Returns null for a widget with fewer than 2 effective rings, or an index
// that doesn't resolve (e.g. a stale click after a data refresh).
export function nestedDoughnutClickValue(
  widget: Widget,
  resp: StatsResponse,
  datasetIndex: number,
  index: number,
): { dimension: string; value: string } | null {
  const dims = ringDims(widget)
  if (dims.length < 2) return null
  const g = nestedDoughnutModel(widget, resp)
  const depth = dims.length - 1 - datasetIndex
  const path = g.pathsAtDepth[depth]?.[index]
  return path ? { dimension: dims[depth], value: path[depth] } : null
}

// Human-friendly label for a dimension value.
// Beacon `site` tags are the hostname's first label; show the full domain so
// "goodstuff" reads as goodstuff.software, "goodstuffsoftware" as the .com, etc.
const BEACON_SITE_LABELS: Record<string, string> = {
  goodstuff: 'goodstuff.software',
  goodstuffsoftware: 'goodstuffsoftware.com',
  starrupture: 'starrupture.goodstuff.software',
  simpletile: 'simpletile.goodstuff.software',
  bestsudoku: 'bestsudoku.app',
}

export function formatKey(dimension: string, value: string): string {
  if (dimension === 'site') return BEACON_SITE_LABELS[value] ?? value
  if (!value) {
    if (dimension === 'refererHost' || dimension === 'referrer' || dimension === 'refpath') return '(direct)'
    if (['region', 'city', 'colo', 'country', 'postal', 'continent', 'timezone', 'org', 'lang'].includes(dimension))
      return '(unknown)'
    return '(none)'
  }
  if (dimension === 'countryName' || dimension === 'country') return COUNTRY_NAMES[value] ?? value
  if (dimension === 'visitor' || dimension === 'mode' || dimension === 'difficulty' || dimension === 'gameMode' || dimension === 'gameDifficulty')
    return value.charAt(0).toUpperCase() + value.slice(1)
  if (dimension === 'popupFamily') return POPUPS.find((p) => p.id === value)?.label ?? value
  if (dimension === 'popupOutcome') return POPUP_OUTCOME_LABELS[value] ?? value
  if (dimension === 'campaignFlight') return CAMPAIGNS.find((c) => c.id === value)?.label ?? value
  if (dimension === 'hourEt') return `${value}:00`
  // "Day 3", and "Day 3 ▼ upsell fix" on a campaign's flight day the signed-out upsell fix falls
  // on (a funnel segment boundary; lib/adsRules.ts UPSELL_SIGNEDOUT_FIX_AT, unset today).
  if (dimension === 'flightDay') return upsellFixFlightDays().has(Number(value)) ? `Day ${value} ▼ upsell fix` : `Day ${value}`
  if (dimension === 'date' || dimension === 'dateEt') {
    // YYYY-MM-DD → "Jun 24"
    const d = new Date(value + 'T00:00:00Z')
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  }
  if (dimension === 'refererHost') return value.replace(/^www\./, '')
  if (dimension === 'requestHost') return value.replace(/\.goodstuff\.software$/, ' (gs)')
  return value
}

const isDark = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark')

function gridColor() {
  return isDark() ? 'rgba(231,226,215,0.10)' : 'rgba(26,23,21,0.07)'
}
function tickColor() {
  return isDark() ? '#A8A096' : INK_3
}

const baseScales = () => ({
  x: { grid: { color: gridColor() }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 } } },
  y: { grid: { color: gridColor() }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 } }, beginAtZero: true },
})

const noLegend = { legend: { display: false } }

// Zero-fill a date series: every day between since/until gets a bucket (0 if it had no rows),
// so a sparse range doesn't visually collapse into just its non-empty days — e.g. a 4-day
// range with data on only 2 of those days renders 4 points (two of them 0), not 2 points that
// read as "the range is only 2 days". `since`/`until` come from resp.meta (both /api/geo and
// /api/stats already echo back the range they queried — see types.ts StatsResponse — so no new
// plumbing from ChartCard/effectiveFilters is needed; buildChartConfig already has it).
// Returns null (skip filling, keep the original rows) when since/until are missing/invalid or
// the span is implausibly huge — a malformed or enormous range shouldn't allocate thousands of
// empty buckets, and callers fall back to the pre-fill behavior in that case.
const MAX_FILL_DAYS = 400
function dayBucketsInRange(since: string, until: string, et = false): string[] | null {
  const s0 = new Date(since).getTime()
  const u0 = new Date(until).getTime()
  if (!isFinite(s0) || !isFinite(u0)) return null
  // An ET-day axis ('dateEt') spans the ET days of since/until; a UTC one their UTC days.
  const dayOf = (ms: number) => (et ? etDateFast(ms) : new Date(ms).toISOString().slice(0, 10))
  const startDay = Date.parse(dayOf(s0) + 'T00:00:00Z')
  const endDay = Date.parse(dayOf(u0) + 'T00:00:00Z')
  if (endDay < startDay) return null
  const dayCount = Math.round((endDay - startDay) / 86_400_000) + 1
  if (dayCount > MAX_FILL_DAYS) return null
  const days: string[] = []
  for (let i = 0; i < dayCount; i++) days.push(new Date(startDay + i * 86_400_000).toISOString().slice(0, 10))
  return days
}

// The rows a single-dimension chart actually PLOTS, in draw order — the response rows for
// every dimension, plus the zero-filled days for a 'date' series. Both the renderer
// (buildChartConfig) and the drill-down click handler (ChartCard.onPoint) read this, so a
// clicked point index always resolves to the value drawn there: with zero-fill the chart can
// have more points than the response has rows, and indexing the raw rows would drill into the
// wrong day (or miss entirely).
/** The first day a date response actually covers when the server cut it to its `limit` (it keeps
 * the NEWEST days — functions/api/geo.ts): the rows then sum to less than the grand total. Days
 * before it are unknown, not zero, so a chart must not zero-fill them. null = not truncated. */
export function truncatedFrom(dim: string, resp: StatsResponse): string | null {
  const shown = resp.rows.reduce((a, r) => a + (r.pageviews || 0), 0)
  if (!resp.rows.length || shown >= (resp.totals?.pageviews ?? 0)) return null
  return resp.rows.reduce((min, r) => (r.key[dim] && (min === null || r.key[dim] < min) ? r.key[dim] : min), null as string | null)
}

export function seriesRows(dim: string, resp: StatsResponse): StatsRow[] {
  if (!isDateDim(dim)) return resp.rows
  const all = dayBucketsInRange(resp.meta.since, resp.meta.until, dim === 'dateEt')
  if (!all) return resp.rows
  const cut = truncatedFrom(dim, resp)
  const buckets = cut ? all.filter((d) => d >= cut) : all
  const byDay = new Map(resp.rows.map((r) => [r.key[dim] ?? '', r]))
  return buckets.map((day) => byDay.get(day) ?? { key: { [dim]: day }, pageviews: 0, visits: 0 })
}

/** The breakdown a one-mark-per-row chart (bar, horizontal bar, doughnut, pie, table) draws as
 * pairs, or null when it has none to draw. A response with a breakdown has one row per
 * (dimension, breakdown) pair; those charts plot ONE mark per row, so reading only
 * `key[dimension]` would repeat each dimension value once per breakdown value (a table) or,
 * after the editor dropped the breakdown, sum the breakdown away (a pie of one slice). A date
 * axis never pairs: the query itself drops a date from a multi-dimension request (rings.ts). */
export function pairBreakdown(widget: Pick<Widget, 'dimension' | 'breakdown'>): string | null {
  const bd = widget.breakdown
  if (!bd || bd === widget.dimension || isDateDim(widget.dimension) || isDateDim(bd)) return null
  return bd
}

/** One (dimension value, breakdown value) pair of a 2-D response: its raw values, the shared
 * label `<dimension> · <breakdown>` every one-mark-per-row chart shows, and its metric. */
export interface PairRow {
  a: string
  b: string
  label: string
  value: number
}
/** The response's pairs in response order (the server's count order), or null when the widget
 * has no breakdown to pair (see pairBreakdown). A repeated pair is summed, never listed twice. */
export function pairRows(widget: Pick<Widget, 'dimension' | 'breakdown' | 'metric'>, resp: StatsResponse): PairRow[] | null {
  const bd = pairBreakdown(widget)
  if (!bd) return null
  const dim = widget.dimension
  const sums = new Map<string, PairRow>()
  for (const r of resp.rows) {
    const a = r.key[dim] ?? ''
    const b = r.key[bd] ?? ''
    const k = JSON.stringify([a, b])
    const v = metricValue(r, widget.metric)
    const cur = sums.get(k)
    if (cur) cur.value += v
    else sums.set(k, { a, b, label: `${formatKey(dim, a)} · ${formatKey(bd, b)}`, value: v })
  }
  return [...sums.values()]
}

/** One color per pair: a hue per dimension value (its fixed color where it has one), lightened
 * step by step per breakdown value in the breakdown's own order — the nested doughnut's scheme,
 * so every pair of one dimension value reads as one family. */
export function pairColors(widget: Pick<Widget, 'dimension' | 'breakdown'>, pairs: PairRow[]): string[] {
  const bd = widget.breakdown ?? ''
  const aOrder = [...new Set(pairs.map((p) => p.a))]
  const bOrder = orderDimValues(bd, [...new Set(pairs.map((p) => p.b))])
  return pairs.map((p) => {
    const base = stableColor(widget.dimension, p.a) ?? PALETTE[aOrder.indexOf(p.a) % PALETTE.length]
    return shade(base, Math.min(bOrder.indexOf(p.b) * 0.16, 0.64))
  })
}

// Known value order for a dimension's values, wherever one reads better than count order: the
// pop-ups in registry order, shown → taps → outcomes, modes and difficulties in game order.
const DIM_VALUE_ORDER: Record<string, readonly string[]> = {
  popupFamily: POPUP_FAMILY_ORDER,
  popupOutcome: POPUP_OUTCOME_ORDER,
  gameMode: GAME_COMPLETE_MODES,
  gameDifficulty: GAME_COMPLETE_DIFFICULTIES,
  mode: GAME_COMPLETE_MODES,
  difficulty: GAME_COMPLETE_DIFFICULTIES,
}
/** Dimensions whose values are whole numbers, read in numeric order (hour 9 before hour 10). */
const NUMERIC_DIMS: ReadonlySet<string> = new Set(['hourEt', 'flightDay'])
/** `values` in the dimension's known order (DIM_VALUE_ORDER), unknown values after the known
 * ones in their given (first-seen, i.e. count) order. */
export function orderDimValues(dim: string, values: string[]): string[] {
  if (NUMERIC_DIMS.has(dim)) return [...values].sort((a, b) => Number(a) - Number(b))
  const order = DIM_VALUE_ORDER[dim]
  if (!order) return values
  const rank = (v: string) => {
    const i = order.indexOf(v)
    return i === -1 ? order.length + values.indexOf(v) : i
  }
  return [...values].sort((a, b) => rank(a) - rank(b))
}

/** The flight days (1-based) on which the signed-out upsell fix falls, over every campaign. */
function upsellFixFlightDays(): Set<number> {
  const out = new Set<number>()
  for (const c of CAMPAIGNS) {
    const m = campaignSegmentMarker(c, [], UPSELL_SIGNEDOUT_FIX_AT)
    const d = m ? flightDayIndex(c, m.boundaryDate) : null
    if (d != null) out.add(d)
  }
  return out
}
/** A campaign flight's length in days (flight day N's largest N), or 0 while it has no start. */
function flightLength(c: CampaignFlight): number {
  return c.flightStart ? Math.round((Date.parse(c.flightEnd + 'T00:00:00Z') - Date.parse(c.flightStart + 'T00:00:00Z')) / 86_400_000) + 1 : 0
}
/** The campaigns a campaignFlight breakdown always draws, rows or not: every beacon-tracked
 * campaign (not spend-only: its ads bypass the beacon), in configured order, narrowed by any
 * campaignFlight drill in effect. A campaign with no arrivals yet — including one with no start
 * date yet, which can never be attributed any rows (campaignAttributionClause) — keeps its
 * series (at 0, per flightLength below) and its place in the legend, as on the old campaign
 * charts; the funnel and country cards already draw it this way (defaults.ts). */
function campaignFlightDomain(drill: DrillConstraint[] | undefined): CampaignFlight[] {
  const picked = (drill ?? []).filter((d) => d.key === 'campaignFlight').map((d) => d.value)
  return CAMPAIGNS.filter((c) => c.measurement !== 'spend-only' && picked.every((v) => v === c.id))
}
/** The whole axis for a dimension with a known domain, so an empty bucket still shows: every
 * hour of the day, and every flight day up to the longest flight among the chart's campaigns
 * (the old flight-day chart's axis: every drawn campaign's length, whether or not it has rows).
 * Other dimensions keep the values the response has. */
function fullAxis(dim: string, seen: string[], breakdown: string, series: string[]): string[] {
  if (dim === 'hourEt') return Array.from({ length: 24 }, (_, h) => String(h))
  if (dim === 'flightDay') {
    const flights = breakdown === 'campaignFlight' ? CAMPAIGNS.filter((c) => series.includes(c.id)) : []
    const max = Math.max(0, ...seen.map(Number).filter(Number.isFinite), ...flights.map(flightLength))
    return Array.from({ length: max }, (_, i) => String(i + 1))
  }
  return seen
}

export interface BreakdownBarModel {
  axis: string[] // raw axis values (widget.dimension), in draw order
  series: string[] // raw series values (widget.breakdown), in legend order
  values: (number | null)[][] // [seriesIndex][axisIndex]
  stacked: boolean
}
/** The data behind a breakdown bar (type 'breakdownBar', and the older 'stackedBar' which is
 * always stacked): one bar group per axis value, one series per breakdown value, summed from the
 * response's (axis, series) rows. A missing combination is null when grouped (so Chart.js leaves
 * no empty slot) and 0 when stacked (so the stack still totals). */
export function breakdownBarModel(widget: Pick<Widget, 'type' | 'dimension' | 'breakdown' | 'barMode' | 'metric' | 'filters'>, resp: StatsResponse, drill?: DrillConstraint[]): BreakdownBarModel {
  const dim = widget.dimension
  const bd = widget.breakdown ?? ''
  const stacked = widget.type === 'stackedBar' || widget.barMode === 'stacked'
  const axisSeen: string[] = []
  const seriesSeen: string[] = []
  const cell = new Map<string, number>() // `${axis}||${series}` -> value
  for (const r of resp.rows) {
    const a = r.key[dim] ?? ''
    const b = r.key[bd] ?? ''
    if (!axisSeen.includes(a)) axisSeen.push(a)
    if (!seriesSeen.includes(b)) seriesSeen.push(b)
    cell.set(`${a}||${b}`, (cell.get(`${a}||${b}`) ?? 0) + metricValue(r, widget.metric))
  }
  // A campaign breakdown draws its whole domain (campaignFlightDomain), then any other value seen.
  const domain = bd === 'campaignFlight' ? campaignFlightDomain(drill ?? widget.filters?.drill).map((c) => c.id) : []
  const series = domain.length ? [...domain, ...seriesSeen.filter((b) => !domain.includes(b))] : orderDimValues(bd, seriesSeen)
  const axis = orderDimValues(dim, fullAxis(dim, axisSeen, bd, series))
  // A series with no rows at all is 0 throughout (drawn, and in the tooltip), not missing.
  const values = series.map((b) => axis.map((a) => cell.get(`${a}||${b}`) ?? (stacked || !seriesSeen.includes(b) ? 0 : null)))
  return { axis, series, values, stacked }
}

/**
 * Build a Chart.js configuration from a widget + its data. Returns null for
 * non-Chart.js widget types (stat / table) which the card renders itself.
 */
export function buildChartConfig(widget: Widget, resp: StatsResponse, seriesResponses?: StatsResponse[], filters?: GlobalFilters): ChartConfiguration | null {
  const drill = (filters ?? widget.filters ?? undefined)?.drill
  const m = widget.metric
  const dim = widget.dimension
  if (hasLineSeries(widget)) return seriesResponses ? buildSeriesLineConfig(widget, seriesResponses) : null

  if (widget.type === 'stat' || widget.type === 'table' || widget.type === 'map' || widget.type === 'rate' || widget.type === 'rateTable') return null

  // ── Breakdown bar (and the older stacked bar): axis dimension × series (breakdown) ──
  if ((widget.type === 'breakdownBar' || widget.type === 'stackedBar') && widget.breakdown) {
    const model = breakdownBarModel(widget, resp, drill)
    const datasets = model.series.map((b, i) => ({
      label: formatKey(widget.breakdown!, b),
      data: model.values[i],
      backgroundColor: stableColor(widget.breakdown!, b) ?? PALETTE[i % PALETTE.length],
      borderRadius: 4,
      // Grouped: an axis value with no row for this series leaves no gap (Chart.js skipNull).
      skipNull: true,
    }))
    const narrow = isMobileViewport()
    const axis = (stacked: boolean) => ({ stacked, grid: { color: gridColor() }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 } } })
    return {
      type: 'bar',
      data: { labels: model.axis.map((p) => formatKey(dim, p)), datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // A tap anywhere over an axis value shows every series' count for it (touch-friendly).
        interaction: { mode: 'index', intersect: false },
        plugins: {
          // Phone width: a compact legend under the bars, so the series names don't eat the plot.
          legend: narrow
            ? { display: true, position: 'bottom', labels: { color: tickColor(), font: { family: 'Inter', size: 10 }, boxWidth: 8, boxHeight: 8, padding: 6 } }
            : { display: true, labels: { color: tickColor(), font: { family: 'Inter', size: 11 }, boxWidth: 12 } },
          tooltip: { filter: (item: any) => item.raw != null },
        },
        scales: { x: axis(model.stacked), y: { ...axis(model.stacked), beginAtZero: true } },
      },
    } as ChartConfiguration
  }

  // ── Line with a breakdown (not a date axis): one line per breakdown value over the axis
  // dimension, an empty bucket at 0; with `cumulative`, each value's running total too, dashed,
  // on a right-hand axis (the campaigns flight-day chart). ─────────────────────────────────────
  if ((widget.type === 'line' || widget.type === 'area') && widget.breakdown && !isDateDim(dim)) {
    const model = breakdownBarModel({ ...widget, type: 'breakdownBar', barMode: 'stacked' }, resp, drill)
    const color = (b: string, i: number) => stableColor(widget.breakdown!, b) ?? PALETTE[i % PALETTE.length]
    const daily = model.series.map((b, i) => ({
      label: formatKey(widget.breakdown!, b),
      data: model.values[i] as number[],
      borderColor: color(b, i),
      // An area stacks its series (each fills down to the one below, the first to the axis), so
      // the top edge is the total and a breakdown reads as an area, not as overlapping lines.
      backgroundColor: widget.type === 'area' ? `${color(b, i)}99` : color(b, i),
      ...(widget.type === 'area' ? { fill: i === 0 ? 'origin' : '-1' } : {}),
      tension: 0.25,
      pointRadius: 2,
      pointHitRadius: 24,
      yAxisID: 'y',
    }))
    const running = widget.cumulative
      ? model.series.map((b, i) => {
          let sum = 0
          return {
            label: `${formatKey(widget.breakdown!, b)} (cumulative)`,
            data: (model.values[i] as number[]).map((v) => (sum += v ?? 0)),
            borderColor: color(b, i),
            backgroundColor: 'transparent',
            borderDash: [5, 3],
            tension: 0.2,
            pointRadius: 0,
            pointHitRadius: 24,
            yAxisID: 'y1',
          }
        })
      : []
    const narrow = isMobileViewport()
    return {
      type: 'line',
      data: { labels: model.axis.map((a) => formatKey(dim, a)), datasets: [...daily, ...running] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: narrow
            ? { display: true, position: 'bottom', labels: { color: tickColor(), font: { family: 'Inter', size: 10 }, boxWidth: 8, boxHeight: 8, padding: 6 } }
            : { display: true, position: 'bottom', labels: { color: tickColor(), font: { family: 'Inter', size: 11 }, boxWidth: 12 } },
        },
        scales: {
          ...baseScales(),
          ...(widget.type === 'area' ? { y: { ...baseScales().y, stacked: true } } : {}),
          ...(running.length ? { y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 } }, title: { display: true, text: 'cumulative', color: tickColor() } } } : {}),
        },
      },
    } as ChartConfiguration
  }

  // ── Nested doughnut: ring 0 (innermost) = dimension, each ring outward subdivides its
  // parent by the next ring dim (breakdown, then any further widget.rings) ──────────────────
  if (widget.type === 'nestedDoughnut' && ringDims(widget).length >= 2) {
    const g = nestedDoughnutModel(widget, resp)
    const { dims, pathsAtDepth, total, grand } = g
    const N = dims.length
    const primaryIndex = new Map(pathsAtDepth[0].map((p, i) => [p[0], i]))

    // Ring 1's lightening curve is the ORIGINAL 2-ring formula, unchanged (exact backward
    // compatibility for existing charts); rings beyond that keep lightening further out.
    const shadeAmt = (depth: number, rank: number) =>
      depth === 1 ? Math.min(0.16 + rank * 0.2, 0.62) : Math.min(0.16 + rank * 0.2 + (depth - 1) * 0.16, 0.86)

    // Each ring's global child order (same rule nestedDoughnutModel uses to draw them) — needed
    // here again to look up a path's RANK within its ring for the shading amount above.
    const orderAtDepth: string[][] = [[]] // depth 0 unused (colored by primary index, not shaded)
    for (let depth = 1; depth < N; depth++) {
      const valueSet = new Set<string>()
      for (const r of resp.rows) valueSet.add(r.key[dims[depth]] ?? '')
      orderAtDepth.push(
        [...valueSet].sort((a, b) => (DEVICE_PRIORITY[a] ?? 9) - (DEVICE_PRIORITY[b] ?? 9) || a.localeCompare(b)),
      )
    }

    const dataAtDepth: number[][] = []
    const colorsAtDepth: string[][] = []
    const labelsAtDepth: string[][] = []
    const itemsAtDepth: ArcItem[][] = []
    for (let depth = 0; depth < N; depth++) {
      const paths = pathsAtDepth[depth]
      dataAtDepth.push(paths.map((p) => total(p)))
      labelsAtDepth.push(paths.map((p) => p.map((v, i) => formatKey(dims[i], v)).join(' · ')))
      colorsAtDepth.push(
        paths.map((p) => {
          const pi = primaryIndex.get(p[0]) ?? 0
          if (depth === 0) return PALETTE[pi % PALETTE.length]
          const rank = orderAtDepth[depth].indexOf(p[depth])
          return shade(PALETTE[pi % PALETTE.length], shadeAmt(depth, rank))
        }),
      )
      itemsAtDepth.push(
        paths.map((p) => {
          const v = total(p)
          // % is within the parent ring (e.g. desktop = 53% of starrupture); ring 0 has no
          // parent, so its % is of the grand total (e.g. starrupture = 55% of all).
          const parentTotal = depth === 0 ? grand : total(p.slice(0, depth))
          return { name: formatKey(dims[depth], p[depth]), sub: `${v.toLocaleString('en-US')} · ${Math.round((v / (parentTotal || 1)) * 100)}%` }
        }),
      )
    }

    const border = isDark() ? '#211C18' : '#FFFFFF'
    // Chart.js draws dataset[0] as the OUTERMOST ring, so push rings outermost → innermost.
    const datasets: { data: number[]; backgroundColor: string[]; borderColor: string; borderWidth: number }[] = []
    const itemsByDatasetIndex: Record<number, ArcItem[]> = {}
    for (let depth = N - 1; depth >= 0; depth--) {
      const datasetIndex = N - 1 - depth
      datasets.push({ data: dataAtDepth[depth], backgroundColor: colorsAtDepth[depth], borderColor: border, borderWidth: 2 })
      itemsByDatasetIndex[datasetIndex] = itemsAtDepth[depth]
    }

    return {
      type: 'doughnut',
      data: { labels: labelsAtDepth[N - 1], datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '40%',
        plugins: {
          legend: { display: false }, // arcs are labeled in place
          tooltip: {
            callbacks: {
              // Every ring shares one labels array, so the default title is wrong for all
              // but the outermost — suppress it and build the line ourselves.
              title: () => '',
              label: (ctx: any) => {
                const it = itemsByDatasetIndex[ctx.datasetIndex]?.[ctx.dataIndex]
                return it ? `${it.name}: ${it.sub}` : ''
              },
            },
          },
        },
      },
      plugins: [centerTextPlugin(grand, m), arcLabelsPlugin(itemsByDatasetIndex)],
    } as ChartConfiguration
  }

  // ── Single-dimension series ─────────────────────────────────────────────────
  // 'date' gets zero-filled to every day in range; every other dimension is untouched. Shared
  // with the drill-down click handler so point index → value can't drift (see seriesRows).
  const rows = seriesRows(dim, resp)
  // A 2-D response (a breakdown is set) on a one-mark-per-row chart: one mark per
  // dimension × breakdown pair, labelled "<dimension> · <breakdown>".
  const pairs = pairRows(widget, resp)
  const labels = pairs ? pairs.map((p) => p.label) : rows.map((r) => formatKey(dim, r.key[dim] ?? ''))
  const values = pairs ? pairs.map((p) => p.value) : rows.map((r) => metricValue(r, m))
  const rawValues = rows.map((r) => String(r.key[dim] ?? ''))
  const colors = pairs ? pairColors(widget, pairs) : seriesColors(dim, rawValues)

  if (widget.type === 'doughnut' || widget.type === 'pie' || widget.type === 'nestedDoughnut') {
    return {
      type: widget.type === 'pie' ? 'pie' : 'doughnut',
      data: {
        labels,
        datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: isDark() ? '#211C18' : '#FFFFFF' }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { color: tickColor(), font: { family: 'Inter', size: 11 }, boxWidth: 12 } } },
      },
    }
  }

  if (widget.type === 'line' || widget.type === 'area') {
    // Pop-up 'date' trend charts get a "tracking starts" boundary + a muted pre-activation
    // segment (or, while TRACKING_ACTIVATION_DATE_ET is still null, the whole line is muted
    // with a corner watermark instead — see activationMarkerIndex above).
    const isPopupTrend = widget.dataset === 'popup' && dim === 'date'
    const boundary = isPopupTrend ? (TRACKING_ACTIVATION_DATE_ET ? activationMarkerIndex(rows, TRACKING_ACTIVATION_DATE_ET) : rows.length) : -1
    const overlay = isDateDim(dim) ? overlayItems(widgetOverlayOptions(widget)) : []
    const muted = isDark() ? 'rgba(231,226,215,0.35)' : 'rgba(26,23,21,0.28)'
    const mutedFill = isDark() ? 'rgba(231,226,215,0.08)' : 'rgba(26,23,21,0.06)'

    // index/intersect:false + a wide point hit radius makes the tooltip appear on a tap
    // anywhere along the line — essential on touch, where hitting a 2px point is impractical.
    return {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: m,
            data: values,
            borderColor: PALETTE[0],
            backgroundColor: widget.type === 'area' ? 'rgba(224,114,44,0.15)' : 'rgba(224,114,44,0.6)',
            fill: widget.type === 'area',
            tension: 0.3,
            pointRadius: 2,
            pointHitRadius: 24,
            pointBackgroundColor: PALETTE[0],
            borderWidth: 2,
            ...(boundary >= 0
              ? {
                  segment: {
                    borderColor: (ctx: any) => (ctx.p0DataIndex < boundary ? muted : undefined),
                    backgroundColor: (ctx: any) => (ctx.p0DataIndex < boundary ? mutedFill : undefined),
                  },
                }
              : {}),
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        ...(overlay.length && overlay.some((i) => i.kind === 'release' || i.kind === 'go-live') ? { layout: { padding: { top: isMobileViewport() ? 24 : 34 } } } : {}),
        plugins: noLegend,
        scales: baseScales(),
      },
      ...((isPopupTrend || overlay.length) && {
        plugins: [
          ...(isPopupTrend ? [TRACKING_ACTIVATION_DATE_ET ? activationMarkerPlugin(boundary) : notYetTrackedWatermarkPlugin()] : []),
          ...(overlay.length ? [timelineOverlayPlugin(rows.map((r) => r.key[dim] ?? ''), overlay, isMobileViewport())] : []),
        ],
      }),
    } as ChartConfiguration
  }

  // bar / hbar
  const horizontal = widget.type === 'hbar'
  return {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: m, data: values, backgroundColor: colors, borderRadius: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: horizontal ? 'y' : 'x',
      // Show a bar's tooltip on a tap near it (not only a pixel-perfect hit) — touch-friendly.
      interaction: { mode: 'index', intersect: false },
      plugins: noLegend,
      scales: baseScales(),
    },
  }
}
