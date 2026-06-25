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

const DEVICE_PRIORITY: Record<string, number> = { desktop: 0, mobile: 1, tablet: 2 }

export function metricValue(row: { pageviews: number; visits: number }, metric: Metric): number {
  return metric === 'visits' ? row.visits : row.pageviews
}

// Human-friendly label for a dimension value.
export function formatKey(dimension: string, value: string): string {
  if (!value) {
    if (dimension === 'refererHost') return '(direct)'
    if (dimension === 'requestPath') return '(none)'
    return '(none)'
  }
  if (dimension === 'countryName') return COUNTRY_NAMES[value] ?? value
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

  if (widget.type === 'stat' || widget.type === 'table') return null

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
    primaries.forEach((p, pi) => {
      devOrder.forEach((d, rank) => {
        const v = combo.get(`${p}||${d}`) ?? 0
        if (v <= 0) return
        const amt = rank === 0 ? -0.12 : Math.min(0.15 + rank * 0.22, 0.62)
        outerData.push(v)
        outerColors.push(shade(PALETTE[pi % PALETTE.length], amt))
        outerLabels.push(`${formatKey(dim, p)} · ${formatKey(dimB, d)}`)
      })
    })

    const grand = innerData.reduce((a, b) => a + b, 0)
    const border = isDark() ? '#211C18' : '#FFFFFF'
    return {
      type: 'doughnut',
      data: {
        labels: outerLabels,
        datasets: [
          { data: innerData, backgroundColor: innerColors, borderColor: border, borderWidth: 2 },
          { data: outerData, backgroundColor: outerColors, borderColor: border, borderWidth: 2 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '40%',
        plugins: {
          legend: {
            position: 'top',
            onClick: () => {},
            labels: {
              color: tickColor(),
              font: { family: 'Inter', size: 11 },
              boxWidth: 12,
              generateLabels: () =>
                primaries.map((_, i) => ({
                  text: `${siteLabels[i]} · ${innerData[i].toLocaleString('en-US')}`,
                  fillStyle: PALETTE[i % PALETTE.length],
                  strokeStyle: PALETTE[i % PALETTE.length],
                  lineWidth: 0,
                  index: i,
                })) as any,
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx: any) => {
                const lbl = ctx.datasetIndex === 0 ? siteLabels[ctx.dataIndex] : outerLabels[ctx.dataIndex]
                return `${lbl}: ${Number(ctx.parsed).toLocaleString('en-US')}`
              },
            },
          },
        },
      },
      plugins: [centerTextPlugin(grand, `${m} · ${primaries.length} sites`)],
    } as ChartConfiguration
  }

  // ── Single-dimension series ─────────────────────────────────────────────────
  const labels = resp.rows.map((r) => formatKey(dim, r.key[dim] ?? ''))
  const values = resp.rows.map((r) => metricValue(r, m))

  if (widget.type === 'doughnut' || widget.type === 'pie' || widget.type === 'nestedDoughnut') {
    return {
      type: widget.type === 'pie' ? 'pie' : 'doughnut',
      data: {
        labels,
        datasets: [{ data: values, backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length]), borderWidth: 2, borderColor: isDark() ? '#211C18' : '#FFFFFF' }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { color: tickColor(), font: { family: 'Inter', size: 11 }, boxWidth: 12 } } },
      },
    }
  }

  if (widget.type === 'line' || widget.type === 'area') {
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
            pointBackgroundColor: PALETTE[0],
            borderWidth: 2,
          },
        ],
      },
      options: { responsive: true, maintainAspectRatio: false, plugins: noLegend, scales: baseScales() },
    }
  }

  // bar / hbar
  const horizontal = widget.type === 'hbar'
  return {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: m, data: values, backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length]), borderRadius: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: horizontal ? 'y' : 'x',
      plugins: noLegend,
      scales: baseScales(),
    },
  }
}
