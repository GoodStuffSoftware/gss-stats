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

  // ── Single-dimension series ─────────────────────────────────────────────────
  const labels = resp.rows.map((r) => formatKey(dim, r.key[dim] ?? ''))
  const values = resp.rows.map((r) => metricValue(r, m))

  if (widget.type === 'doughnut' || widget.type === 'pie') {
    return {
      type: widget.type,
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
