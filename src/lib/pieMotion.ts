// Motion for a drill-down pie: a Chart.js plugin that plays the pie in when it appears, and the small memory
// that tells a freshly built pie where the user came from. Generic: it knows slices by key and share only.
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
//   fade     the calm version for prefers-reduced-motion: nothing moves, the pie fades in.
//   none     no motion.
import type { Plugin } from 'chart.js'

const TAU = Math.PI * 2
const TOP = -Math.PI / 2 // where a doughnut starts: 12 o'clock

export type PieOrigin = { kind: 'expand'; from: number; to: number } | { kind: 'unfurl'; mid: number }
export type PieMotion = { kind: 'none' } | { kind: 'fade' } | PieOrigin

export const MOTION_MS = { expand: 560, unfurl: 560, fade: 220 } as const

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export interface PieFrame {
  /** Angle (radians) where the circle's first edge sits this frame. */
  start: number
  /** Angle the whole circle spans this frame. */
  span: number
  /** Opacity 0..1. */
  alpha: number
}

/** The geometry of a frame at progress `p` (0 = first frame, 1 = final pie). Pure; the plugin and the tests use it. */
export function pieFrame(motion: PieMotion, p: number): PieFrame {
  const t = Math.min(1, Math.max(0, p))
  if (motion.kind === 'none') return { start: TOP, span: TAU, alpha: 1 }
  if (motion.kind === 'fade') return { start: TOP, span: TAU, alpha: easeOutCubic(t) }
  const e = easeOutCubic(t)
  if (motion.kind === 'expand') {
    const from = Math.min(1, Math.max(0, motion.from))
    const to = Math.min(1, Math.max(from, motion.to))
    return { start: lerp(TOP + from * TAU, TOP, e), span: lerp((to - from) * TAU, TAU, e), alpha: 1 }
  }
  // unfurl: keep the point `mid` (a share of the circle) where it ends up, grow the span around it
  const mid = Math.min(1, Math.max(0, motion.mid))
  const span = TAU * e
  return { start: TOP + mid * TAU - mid * span, span, alpha: 1 }
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
export function pieMotionPlugin(opts: PieMotionOptions): Plugin<'doughnut'> & { motion: PieMotion } {
  const { motion } = opts
  const now = opts.now ?? (() => performance.now())
  const schedule = opts.schedule ?? ((cb: () => void) => void requestAnimationFrame(cb))
  const duration = motion.kind === 'none' ? 0 : MOTION_MS[motion.kind]
  let t0: number | null = null
  let done = motion.kind === 'none'
  let queued = false
  let gone = false
  let saved: { arc: ArcLike; s: number; e: number; c: number }[] = []
  let alphaSet = false

  const progress = () => {
    if (t0 === null) t0 = now()
    return duration > 0 ? Math.min(1, (now() - t0) / duration) : 1
  }
  let p = 1

  return {
    id: 'pieMotion',
    motion, // readable by callers and tests; Chart.js ignores it
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
      if (f.alpha < 1) {
        chart.ctx.save()
        chart.ctx.globalAlpha = f.alpha
        alphaSet = true
      }
    },
    afterDatasetsDraw(chart) {
      for (const { arc, s, e, c } of saved) {
        arc.startAngle = s
        arc.endAngle = e
        arc.circumference = c
      }
      saved = []
      if (alphaSet) {
        chart.ctx.restore()
        alphaSet = false
      }
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

// ── Where did the user come from? ────────────────────────────────────────────────────────────────────────────
// A pick is remembered when a slice is chosen; the next pie that appears either opens from it (a different
// level, soon after) or, when its slices are the ones the pick was made on, is the way back up. Module-level
// on purpose: each level is a new pie component, the old one is gone before the new one exists.

export interface Pick {
  /** Signature of the slice keys the pick was made on (see sliceSignature). */
  sig: string
  /** The picked slice's key in that pie. */
  key: string
  /** The picked slice's wedge, as shares of the circle (0..1). */
  from: number
  to: number
  at: number
}

/** A pick is "the cause" of the next new pie only this soon after it (the answer for the next level is fetched). */
export const FORWARD_WINDOW_MS = 4000
const MAX_PICKS = 8
let picks: Pick[] = []

export function sliceSignature(keys: readonly string[]): string {
  return keys.join('\u0001')
}

export function rememberPick(p: Omit<Pick, 'at'>, at = Date.now()): void {
  picks.push({ ...p, at })
  if (picks.length > MAX_PICKS) picks = picks.slice(-MAX_PICKS)
}

/** Clears the memory (tests; also a clean slate if a caller wants one). */
export function forgetPicks(): void {
  picks = []
}

/** The origin for a pie that is appearing with these slices, or null (nothing to come from). Takes the
 * matching pick off the memory when it is the way back up. `shareOf(key)` is that slice's wedge in the NEW pie. */
export function takeOrigin(
  keys: readonly string[],
  shareOf: (key: string) => { from: number; to: number } | null,
  at = Date.now(),
): PieOrigin | null {
  const sig = sliceSignature(keys)
  const back = picks.map((p) => p.sig).lastIndexOf(sig)
  if (back >= 0) {
    const came = picks[back]
    picks = picks.slice(0, back)
    const w = shareOf(came.key)
    return w ? { kind: 'unfurl', mid: (w.from + w.to) / 2 } : null
  }
  const last = picks[picks.length - 1]
  if (last && at - last.at <= FORWARD_WINDOW_MS) return { kind: 'expand', from: last.from, to: last.to }
  return null
}
