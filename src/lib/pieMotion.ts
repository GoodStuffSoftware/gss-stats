// Motion for a drill-down pie: a Chart.js plugin that plays the pie in when it appears. Generic: it knows
// angles and shares only; the caller says where the pie comes from.
//
// Why a plugin and not Chart.js's own animation: the site turns Chart.js animation off for every chart
// (BaseChart sets `Chart.defaults.animation = false`, and a per-chart option cannot override that), and the
// drill levels are separate charts, so there is nothing to `update()` from one level to the next. The plugin
// drives itself: for `duration` ms it re-draws the chart every frame with the arcs' angles remapped for that
// frame (same radius, so nothing jumps), then stops. Labels drawn by a plugin that runs before this one's
// `afterDatasetsDraw` read the same remapped arcs, so they follow the motion and never lag behind it.
//
// Motions (all end on the normal, final pie):
//   expand   a level opened from slice `from..to`: the new slices start squeezed into that slice's wedge,
//            where it sat, and grow to fill the circle.
//   unfurl   a level reached back up: the whole pie grows around the slice (`mid`) you came from, which
//            stays where it was. A first appearance with nothing to come from is an unfurl around the top,
//            a clockwise sweep.
//   none     no motion.
import type { Plugin } from 'chart.js'

const TAU = Math.PI * 2
const TOP = -Math.PI / 2 // where a doughnut starts: 12 o'clock

export type PieOrigin = { kind: 'expand'; from: number; to: number } | { kind: 'unfurl'; mid: number }
export type PieMotion = { kind: 'none' } | PieOrigin

export const MOTION_MS = { expand: 560, unfurl: 560 } as const

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export interface PieFrame {
  /** Angle (radians) where the circle's first edge sits this frame. */
  start: number
  /** Angle the whole circle spans this frame. */
  span: number
}

/** The geometry of a frame at progress `p` (0 = first frame, 1 = final pie). Pure; the plugin and the tests use it. */
export function pieFrame(motion: PieMotion, p: number): PieFrame {
  const t = Math.min(1, Math.max(0, p))
  if (motion.kind === 'none') return { start: TOP, span: TAU }
  const e = easeOutCubic(t)
  if (motion.kind === 'expand') {
    const from = Math.min(1, Math.max(0, motion.from))
    const to = Math.min(1, Math.max(from, motion.to))
    return { start: lerp(TOP + from * TAU, TOP, e), span: lerp((to - from) * TAU, TAU, e) }
  }
  // unfurl: keep the point `mid` (a share of the circle) where it ends up, grow the span around it
  const mid = Math.min(1, Math.max(0, motion.mid))
  const span = TAU * e
  return { start: TOP + mid * TAU - mid * span, span }
}

export interface PieMotionOptions {
  motion: PieMotion
  /** Test hooks: a clock in ms and a frame scheduler. */
  now?: () => number
  schedule?: (cb: () => void) => void
}

type ArcLike = { startAngle: number; endAngle: number; circumference: number }

/** The plugin. List it AFTER any labels plugin in the chart's `plugins`: it puts the arcs back in
 * `afterDatasetsDraw`, which has to come after the labels have been drawn on the moved arcs. */
export function pieMotionPlugin(opts: PieMotionOptions): Plugin<'doughnut'> & { motion: PieMotion; settled: () => boolean } {
  const { motion } = opts
  const now = opts.now ?? (() => performance.now())
  const schedule = opts.schedule ?? ((cb: () => void) => void requestAnimationFrame(cb))
  const duration = motion.kind === 'none' ? 0 : MOTION_MS[motion.kind]
  let t0: number | null = null
  let done = motion.kind === 'none'
  let queued = false
  let gone = false
  let saved: { arc: ArcLike; s: number; e: number; c: number }[] = []

  const progress = () => {
    if (t0 === null) t0 = now()
    return duration > 0 ? Math.min(1, (now() - t0) / duration) : 1
  }
  let p = 1

  return {
    id: 'pieMotion',
    motion, // readable by callers and tests; Chart.js ignores it
    /** True when the frame being drawn is the final pie (or no motion plays): things that must not follow a moving
     * arc, such as labels outside the ring, wait for it. Valid from `beforeDatasetsDraw` on. */
    settled: () => done || p >= 1,
    beforeDatasetsDraw(chart) {
      if (done) return
      p = progress()
      const f = pieFrame(motion, p)
      const k = f.span / TAU
      for (let di = 0; di < chart.data.datasets.length; di++) {
        for (const arc of chart.getDatasetMeta(di).data as unknown as ArcLike[]) {
          saved.push({ arc, s: arc.startAngle, e: arc.endAngle, c: arc.circumference })
          // the arcs' own angles are shares of a circle that starts at the top
          arc.startAngle = f.start + ((arc.startAngle - TOP) / TAU) * f.span
          arc.endAngle = f.start + ((arc.endAngle - TOP) / TAU) * f.span
          arc.circumference = arc.circumference * k
        }
      }
    },
    afterDatasetsDraw(chart) {
      for (const { arc, s, e, c } of saved) {
        arc.startAngle = s
        arc.endAngle = e
        arc.circumference = c
      }
      saved = []
      if (done) return
      if (p >= 1) {
        done = true
        return
      }
      if (!queued && !gone) {
        queued = true
        schedule(() => {
          queued = false
          if (!gone) chart.draw()
        })
      }
    },
    beforeDestroy() {
      gone = true
    },
  }
}
