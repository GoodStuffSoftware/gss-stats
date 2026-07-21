import type { ChartConfiguration } from 'chart.js'
import type { Widget, StatsResponse, Metric } from '../types'
import { COUNTRY_NAMES } from './catalog'

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

const DEVICE_PRIORITY: Record<string, number> = { desktop: 0, mobile: 1, tablet: 2 }

export function metricValue(row: { pageviews: number; visits: number }, metric: Metric): number {
  return metric === 'visits' ? row.visits : row.pageviews
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
  if (dimension === 'visitor') return value.charAt(0).toUpperCase() + value.slice(1)
  if (dimension === 'date') {
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

/**
 * Build a Chart.js configuration from a widget + its data. Returns null for
 * non-Chart.js widget types (stat / table) which the card renders itself.
 */
export function buildChartConfig(widget: Widget, resp: StatsResponse): ChartConfiguration | null {
  const m = widget.metric
  const dim = widget.dimension

  if (widget.type === 'stat' || widget.type === 'table' || widget.type === 'map') return null

  // ── Stacked bar: primary dimension × breakdown ──────────────────────────────
  if (widget.type === 'stackedBar' && widget.breakdown) {
    const primaries: string[] = []
    const breakdowns: string[] = []
    const cell = new Map<string, number>() // `${p}||${b}` -> value
    for (const r of resp.rows) {
      const p = r.key[dim] ?? ''
      const b = r.key[widget.breakdown] ?? ''
      if (!primaries.includes(p)) primaries.push(p)
      if (!breakdowns.includes(b)) breakdowns.push(b)
      cell.set(`${p}||${b}`, (cell.get(`${p}||${b}`) ?? 0) + metricValue(r, m))
    }
    const datasets = breakdowns.map((b, i) => ({
      label: formatKey(widget.breakdown!, b),
      data: primaries.map((p) => cell.get(`${p}||${b}`) ?? 0),
      backgroundColor: PALETTE[i % PALETTE.length],
      borderRadius: 4,
    }))
    return {
      type: 'bar',
      data: { labels: primaries.map((p) => formatKey(dim, p)), datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true, labels: { color: tickColor(), font: { family: 'Inter', size: 11 } } } },
        scales: {
          x: { stacked: true, grid: { color: gridColor() }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 } } },
          y: { stacked: true, beginAtZero: true, grid: { color: gridColor() }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 } } },
        },
      },
    }
  }

  // ── Nested doughnut: inner ring = primary dimension, outer ring = breakdown ──
  if (widget.type === 'nestedDoughnut' && widget.breakdown) {
    const dimB = widget.breakdown
    const primaryTotals = new Map<string, number>()
    const combo = new Map<string, number>() // `${p}||${b}` -> value
    const deviceSet = new Set<string>()
    for (const r of resp.rows) {
      const p = r.key[dim] ?? ''
      const b = r.key[dimB] ?? ''
      const v = metricValue(r, m)
      primaryTotals.set(p, (primaryTotals.get(p) ?? 0) + v)
      combo.set(`${p}||${b}`, (combo.get(`${p}||${b}`) ?? 0) + v)
      deviceSet.add(b)
    }
    const primaries = [...primaryTotals.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0])
    const devOrder = [...deviceSet].sort(
      (a, b) => (DEVICE_PRIORITY[a] ?? 9) - (DEVICE_PRIORITY[b] ?? 9) || a.localeCompare(b),
    )
    const innerData = primaries.map((p) => primaryTotals.get(p) ?? 0)
    const innerColors = primaries.map((_, i) => PALETTE[i % PALETTE.length])
    const siteLabels = primaries.map((p) => formatKey(dim, p))

    // Outer ring ordered site-major so each device arc nests under its site arc.
    const outerData: number[] = []
    const outerColors: string[] = []
    const outerLabels: string[] = []
    const outerItems: ArcItem[] = []
    primaries.forEach((p, pi) => {
      const pTotal = primaryTotals.get(p) || 1
      devOrder.forEach((d, rank) => {
        const v = combo.get(`${p}||${d}`) ?? 0
        if (v <= 0) return
        const amt = Math.min(0.16 + rank * 0.2, 0.62) // progressively lighter outward (gradient)
        outerData.push(v)
        outerColors.push(shade(PALETTE[pi % PALETTE.length], amt))
        outerLabels.push(`${formatKey(dim, p)} · ${formatKey(dimB, d)}`)
        // outer % is within its parent (e.g. desktop = 53% of starrupture)
        outerItems.push({ name: formatKey(dimB, d), sub: `${v.toLocaleString('en-US')} · ${Math.round((v / pTotal) * 100)}%` })
      })
    })

    const grand = innerData.reduce((a, b) => a + b, 0)
    // inner % is of the grand total (e.g. starrupture = 55% of all)
    const innerItems: ArcItem[] = primaries.map((p, i) => ({
      name: siteLabels[i],
      sub: `${innerData[i].toLocaleString('en-US')} · ${Math.round((innerData[i] / (grand || 1)) * 100)}%`,
    }))
    const border = isDark() ? '#211C18' : '#FFFFFF'
    return {
      type: 'doughnut',
      // Chart.js draws dataset[0] as the OUTER ring, so the breakdown goes first
      // (outer) and the primary dimension second (inner).
      data: {
        labels: outerLabels,
        datasets: [
          { data: outerData, backgroundColor: outerColors, borderColor: border, borderWidth: 2 },
          { data: innerData, backgroundColor: innerColors, borderColor: border, borderWidth: 2 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '40%',
        plugins: {
          legend: { display: false }, // arcs are labeled in place
          tooltip: {
            callbacks: {
              // The two rings share one labels array, so the default title is wrong
              // for the inner ring — suppress it and build the line ourselves.
              title: () => '',
              label: (ctx: any) => {
                const it = (ctx.datasetIndex === 0 ? outerItems : innerItems)[ctx.dataIndex]
                return it ? `${it.name}: ${it.sub}` : ''
              },
            },
          },
        },
      },
      plugins: [centerTextPlugin(grand, m), arcLabelsPlugin({ 0: outerItems, 1: innerItems })],
    } as ChartConfiguration
  }

  // ── Single-dimension series ─────────────────────────────────────────────────
  const labels = resp.rows.map((r) => formatKey(dim, r.key[dim] ?? ''))
  const values = resp.rows.map((r) => metricValue(r, m))
  const rawValues = resp.rows.map((r) => String(r.key[dim] ?? ''))
  const colors = seriesColors(dim, rawValues)

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
    // offset:true keeps the first/last points off the very edges (lead space either end),
    // and index/intersect:false makes the tooltip appear on a tap anywhere along the line —
    // essential on touch, where hitting a 2px point precisely is impractical.
    const scales = baseScales()
    ;(scales.x as Record<string, unknown>).offset = true
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
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: noLegend,
        scales,
      },
    }
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
