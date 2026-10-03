// The geometry of an inline sparkline (ADR 0005 slice 2): a MetricValue's per-ET-day series as
// SVG polyline point lists. Pure, so the shape is testable without a DOM.
//
// A day with no point is a GAP (the metric was not measured then: before a go-live, or a spend
// day the store never synced), never a zero: the line BREAKS there, and a run of one day is drawn
// as a dot. The scale starts at 0 so a quiet week does not look like a surge.

import type { SeriesPoint } from './types'

export interface SparklineGeometry {
  width: number
  height: number
  /** One `x,y x,y …` list per unbroken run of two or more consecutive days. */
  lines: string[]
  /** A run of one day (an isolated measured day, or a one-day series). */
  dots: { x: number; y: number }[]
  max: number
  firstDay: string
  lastDay: string
}

const DAY_MS = 86_400_000
const dayIndex = (day: string): number => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS)
const PAD = 2

export function sparklineGeometry(series: readonly SeriesPoint[], width = 80, height = 22): SparklineGeometry | null {
  const pts = series.filter((p) => Number.isFinite(p.value) && /^\d{4}-\d{2}-\d{2}$/.test(p.day))
  if (!pts.length) return null
  const first = dayIndex(pts[0].day)
  const last = dayIndex(pts[pts.length - 1].day)
  const span = Math.max(1, last - first)
  const max = Math.max(0, ...pts.map((p) => p.value))
  const x = (d: number) => PAD + ((d - first) / span) * (width - 2 * PAD)
  const y = (v: number) => (max <= 0 ? height - PAD : height - PAD - (v / max) * (height - 2 * PAD))
  const fmt = (n: number) => String(Math.round(n * 100) / 100)
  const lines: string[] = []
  const dots: { x: number; y: number }[] = []
  let run: { x: number; y: number }[] = []
  const flush = () => {
    if (run.length > 1) lines.push(run.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' '))
    else if (run.length === 1) dots.push({ x: Math.round(run[0].x * 100) / 100, y: Math.round(run[0].y * 100) / 100 })
    run = []
  }
  let prev: number | null = null
  for (const p of pts) {
    const d = dayIndex(p.day)
    if (prev !== null && d !== prev + 1) flush() // a missing day breaks the line
    run.push({ x: x(d), y: y(p.value) })
    prev = d
  }
  flush()
  return { width, height, lines, dots, max, firstDay: pts[0].day, lastDay: pts[pts.length - 1].day }
}
