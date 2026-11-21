import type { ChartConfiguration } from 'chart.js'
import type { DrillConstraint, GlobalFilters, Widget, StatsResponse, StatsRow, Metric } from '../types'
import { COUNTRY_NAMES, datasetSupportsBreakdown, dimensionDefOf, dimensionTitle, widgetShowsShares } from './catalog'
import { ringDims, isDateDim } from './rings'
import { etDateFast, etWallTimeMs } from './etTime'
import { TRACKING_ACTIVATION_DATE_ET, PLAY_TRACKING_MARKER_LABEL, POPUPS, POPUP_FAMILY_ORDER, POPUP_OUTCOME_ORDER, POPUP_OUTCOME_LABELS } from './popupEvents'
import { GAME_COMPLETE_MODES, GAME_COMPLETE_DIFFICULTIES, CAMPAIGNS, flightDayIndex, type CampaignFlight } from './campaigns'
import { campaignSegmentMarker, UPSELL_SIGNEDOUT_FIX_AT } from './adsRules'
import { isMobileViewport } from './responsive'
import { layoutMarkerLabels, markerPaddingExtra, settlePaddingExtra } from './markerLayout'
import { overlayItems, layoutFlightBands, layoutBandLabels, markerIndex, type OverlayItem } from './timelineOverlay'

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
    'accept-signin': PALETTE[11],
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
  if (map) return map[String(rawValue).toLowerCase()] ?? null
  // A dimension that fixes its own colours (catalog.ts DimensionDef.valueColors: palette slots).
  const slot = dimensionDefOf(dim)?.valueColors?.[String(rawValue).toLowerCase()]
  return slot === undefined ? null : PALETTE[slot]
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

function relLuminance(hex: string): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
/** WCAG contrast ratio (1..21) of two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relLuminance(a), relLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const LABEL_DARK = '#14110F'
const LABEL_LIGHT = '#FFFFFF'
/** The label ink (near-black or white) with the higher WCAG contrast against `fill`: never below about 4.5 on any
 * fill, in either site theme (the slice colour decides it; the theme only changes the slice border). */
export function inkOn(fill: string): string {
  return contrastRatio(fill, LABEL_DARK) >= contrastRatio(fill, LABEL_LIGHT) ? LABEL_DARK : LABEL_LIGHT
}

// Draws "name + count" on each arc of the given datasets (both rings of a nested
// doughnut), so every segment is self-labeled — no legend or hover needed. Skips
// slivers too small to fit a label; those stay on hover.
// `sub` may be a list of alternatives (longest first): the first that fits the arc is drawn, none when none fits.
// `tail` is the short text an OUTSIDE label shows after the name (the share); default: the last `sub` alternative.
export type ArcItem = { name: string; sub: string | string[]; tail?: string }

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

// ── Strict label fit (opt-in: ArcLabelOptions.fit) ──────────────────────────────────────────────────────
// A label is drawn only when the full box of every glyph, at its drawn position and rotation, lies inside the
// slice: between the inner and outer radius and between the start and end angle, with a margin. Shorter forms are
// tried before giving up, fullest first: the name with the best amount/share text, the same with the name wrapped
// on two lines, then the name alone (wrapped or not). Each form is tried along the arc and across it (the order
// follows whichever is closer to horizontal at the slice's angle). The text is never upside down.
export interface ArcGeom {
  cx: number
  cy: number
  innerRadius: number
  outerRadius: number
  startAngle: number
  endAngle: number
}
/** One drawn piece of text: `text` centred at (x, y) on the canvas, turned `rot` radians, `w` x `h` px. */
export interface ArcPlacement {
  text: string
  x: number
  y: number
  rot: number
  w: number
  h: number
  font: string
}
export interface ArcLine {
  text: string
  font: string
}
export type ArcLabelMeasure = (font: string, text: string) => number

const TAU = 2 * Math.PI
const FIT_MARGIN = 4 // px kept clear inside every edge of the slice (the 2 px border and the hover nudge)
const LINE_GAP = 2 // px between the boxes of two lines
const normAngle = (a: number) => ((a % TAU) + TAU) % TAU
const fontPx = (font: string): number => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 12)

/** True when the point (px, py) (canvas coordinates) lies inside the slice, `margin` px clear of every edge. */
export function pointInSlice(g: ArcGeom, px: number, py: number, margin: number): boolean {
  const dx = px - g.cx
  const dy = py - g.cy
  const rho = Math.hypot(dx, dy)
  if (rho < g.innerRadius + margin || rho > g.outerRadius - margin) return false
  const span = g.endAngle - g.startAngle
  if (span >= TAU - 1e-6) return true // the whole ring: no radial edge
  const d = normAngle(Math.atan2(dy, dx) - g.startAngle) // angle past the start edge, 0..2pi
  if (d > span) return false
  // distance to a radial edge (a point more than a quarter turn from an edge is far from it)
  const dist = (gap: number) => (gap >= Math.PI / 2 ? rho : rho * Math.sin(gap))
  return dist(d) >= margin && dist(span - d) >= margin
}

/** True when the whole rotated box of a placement lies inside the slice: its four corners are inside (the radial
 * bounds are extreme at the corners, and a slice up to a half turn is convex between its two edges). */
export function placementInSlice(g: ArcGeom, p: ArcPlacement, margin: number): boolean {
  const c = Math.cos(p.rot)
  const s = Math.sin(p.rot)
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const lx = (sx * p.w) / 2
    const ly = (sy * p.h) / 2
    if (!pointInSlice(g, p.x + lx * c - ly * s, p.y + lx * s + ly * c, margin)) return false
  }
  return true
}

/** Splits a name into two lines at the space that makes the wider one narrowest; null for a one-word name. */
export function wrapName(name: string, measure: (t: string) => number): [string, string] | null {
  const words = name.split(/\s+/).filter(Boolean)
  if (words.length < 2) return null
  let best: [string, string] | null = null
  let bestW = Infinity
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ')
    const b = words.slice(i).join(' ')
    const w = Math.max(measure(a), measure(b))
    if (w < bestW) {
      bestW = w
      best = [a, b]
    }
  }
  return best
}

/** Lays the lines out along the arc (each line on its own circle, characters tangent to it, upright on both halves). */
function layoutAlongArc(g: ArcGeom, lines: ArcLine[], measure: ArcLabelMeasure): ArcPlacement[] {
  const mid = (g.startAngle + g.endAngle) / 2
  const ma = normAngle(mid)
  const bottom = ma > 0 && ma < Math.PI // bottom half (canvas y is down): the text runs the other way
  const hs = lines.map((l) => fontPx(l.font))
  const total = hs.reduce((a, b) => a + b, 0) + LINE_GAP * (lines.length - 1)
  const bandMid = (g.innerRadius + g.outerRadius) / 2
  const out: ArcPlacement[] = []
  let broken = false // a line would sit on a circle of no radius: no label
  let top = -total / 2 // the line's top, measured from the band centre towards the visual top
  lines.forEach((l, i) => {
    const centre = top + hs[i] / 2
    top += hs[i] + LINE_GAP
    const r = bottom ? bandMid + centre : bandMid - centre
    if (r <= 0) {
      broken = true
      return
    }
    const chars = [...l.text]
    const widths = chars.map((ch) => measure(l.font, ch))
    const totalAngle = widths.reduce((a, b) => a + b, 0) / r
    let a = bottom ? mid + totalAngle / 2 : mid - totalAngle / 2
    chars.forEach((ch, k) => {
      const ca = widths[k] / r
      a += bottom ? -ca / 2 : ca / 2
      out.push({
        text: ch,
        x: g.cx + Math.cos(a) * r,
        y: g.cy + Math.sin(a) * r,
        rot: bottom ? a - Math.PI / 2 : a + Math.PI / 2,
        w: widths[k],
        h: hs[i],
        font: l.font,
      })
      a += bottom ? -ca / 2 : ca / 2
    })
  })
  return broken ? [] : out
}

/** Lays the lines out across the arc: straight text along the radius through the slice's middle, stacked at right
 * angles to it, turned to read left to right (never upside down). */
function layoutAcrossArc(g: ArcGeom, lines: ArcLine[], measure: ArcLabelMeasure): ArcPlacement[] {
  const mid = (g.startAngle + g.endAngle) / 2
  const bandMid = (g.innerRadius + g.outerRadius) / 2
  const rot = Math.cos(mid) < 0 ? mid + Math.PI : mid
  const hs = lines.map((l) => fontPx(l.font))
  const total = hs.reduce((a, b) => a + b, 0) + LINE_GAP * (lines.length - 1)
  const ux = Math.cos(rot) // the text direction; its down direction is (-uy, ux)
  const uy = Math.sin(rot)
  const bx = g.cx + Math.cos(mid) * bandMid
  const by = g.cy + Math.sin(mid) * bandMid
  let top = -total / 2
  return lines.map((l, i) => {
    const centre = top + hs[i] / 2
    top += hs[i] + LINE_GAP
    return { text: l.text, x: bx - uy * centre, y: by + ux * centre, rot, w: measure(l.font, l.text), h: hs[i], font: l.font }
  })
}

/** The forms of one label, fullest first. */
function labelForms(name: string, subs: string[], nameFont: string, subFont: string, measure: ArcLabelMeasure): ArcLine[][] {
  const wrapped = wrapName(name, (t) => measure(nameFont, t))
  const forms: ArcLine[][] = []
  for (const sub of [...subs, '']) {
    const tail: ArcLine[] = sub ? [{ text: sub, font: subFont }] : []
    forms.push([{ text: name, font: nameFont }, ...tail])
    if (wrapped) forms.push([{ text: wrapped[0], font: nameFont }, { text: wrapped[1], font: nameFont }, ...tail])
  }
  return forms
}

/** The first label form and orientation that fits entirely inside the slice, or null. Pure geometry (no canvas). */
export function fitArcLabel(g: ArcGeom, item: ArcItem, fonts: { name: string; sub: string }, measure: ArcLabelMeasure): ArcPlacement[] | null {
  if (!(g.endAngle > g.startAngle) || g.outerRadius <= g.innerRadius) return null
  const subs = (Array.isArray(item.sub) ? item.sub : [item.sub]).filter(Boolean)
  const mid = (g.startAngle + g.endAngle) / 2
  // closer to horizontal: along the arc near 12 and 6 o'clock, across it near 3 and 9
  const alongFirst = Math.abs(Math.sin(mid)) >= Math.abs(Math.cos(mid))
  const layouts = alongFirst ? [layoutAlongArc, layoutAcrossArc] : [layoutAcrossArc, layoutAlongArc]
  for (const form of labelForms(item.name, subs, fonts.name, fonts.sub, measure)) {
    for (const layout of layouts) {
      const placed = layout(g, form, measure)
      if (placed.length && placed.every((p) => placementInSlice(g, p, FIT_MARGIN))) return placed
    }
  }
  return null
}

// ── Outside labels (opt-in: ArcLabelOptions.outside, with `fit`) ───────────────────────────────────────
// A slice that got no label inside gets one outside the ring, at the end of a short leader line: its name and its share (when
// the room is short the share goes first, and the name is cut with an ellipsis only when even it does not fit). Labels sit in a column on each side of the ring, one row
// per label, as near their slice's own height as the rows allow (spreadRows). A label is never drawn over another,
// over the ring or past the chart's edge: when there is no room for all of them, the smallest slices' labels go
// (placeOutsideLabels).
export interface OutsideCandidate {
  index: number
  name: string
  tail: string
  geom: ArcGeom
}
export interface OutsideLabel {
  index: number
  /** 1 = right of the ring (the text starts at x and runs right), -1 = left (the text ends at x and runs left). */
  side: 1 | -1
  /** The leader line, from the slice's edge to the text. */
  line: [number, number][]
  x: number
  y: number
  /** The name as drawn (maybe cut with an ellipsis) and the tail after it ('' and 0 wide when the share was dropped so
   * the whole name fits). */
  name: string
  tail: string
  nameW: number
  tailW: number
}
const OUT_LEAD = 8 // px a leader runs radially out of the ring when it has to bend around
const OUT_CLEAR = 3 // px kept between the ring and any label
const OUT_TICK = 6 // px of the leader's horizontal end
const OUT_PAD = 2 // px between the leader's end and the text
const OUT_EDGE = 2 // px kept clear of the chart's edge
const OUT_ROW_GAP = 2 // px between two rows
const OUT_SPACE = 4 // px between the name and the tail

/** `text` cut with an ellipsis to at most `maxW` wide; whole when it fits; null when not even `minChars` letters and
 * the ellipsis do. */
export function ellipsize(text: string, maxW: number, measure: (t: string) => number, minChars = 2): string | null {
  if (measure(text) <= maxW) return text
  const chars = [...text]
  for (let n = chars.length - 1; n >= minChars; n--) {
    const cut = `${chars.slice(0, n).join('').trimEnd()}…`
    if (measure(cut) <= maxW) return cut
  }
  return null
}

/** Rows `pitch` apart, in the order of `ideal` (ascending), each as near its ideal centre as the others allow
 * (colliding rows are pooled around the mean of their ideals), all within lo..hi; null when they cannot fit. */
export function spreadRows(ideal: number[], pitch: number, lo: number, hi: number): number[] | null {
  const n = ideal.length
  if (n === 0) return []
  if (lo + (n - 1) * pitch > hi + 1e-9) return null
  const blocks: { i: number; n: number; y: number }[] = ideal.map((y, i) => ({ i, n: 1, y })) // y: centre of the first row
  for (;;) {
    for (const b of blocks) b.y = Math.min(Math.max(b.y, lo), hi - (b.n - 1) * pitch)
    let merged = false
    for (let k = 1; k < blocks.length; k++) {
      const a = blocks[k - 1]
      const b = blocks[k]
      if (a.y + a.n * pitch > b.y + 1e-9) {
        const count = a.n + b.n
        let sum = 0
        for (let j = a.i; j < a.i + count; j++) sum += ideal[j] - (j - a.i) * pitch
        blocks.splice(k - 1, 2, { i: a.i, n: count, y: sum / count })
        merged = true
        break
      }
    }
    if (!merged) break
  }
  const out: number[] = []
  for (const b of blocks) for (let j = 0; j < b.n; j++) out.push(b.y + j * pitch)
  return out
}

/** Where the outside labels go, and which slices go without one. Pure geometry (no canvas). `size` is the chart's
 * width and height; every label stays inside it, clear of the ring and of the other labels. */
export function placeOutsideLabels(
  cands: OutsideCandidate[],
  size: { w: number; h: number },
  fonts: { name: string; tail: string },
  measure: ArcLabelMeasure,
): OutsideLabel[] {
  const h = Math.max(fontPx(fonts.name), fontPx(fonts.tail)) + 2
  const pitch = h + OUT_ROW_GAP
  const lo = OUT_EDGE + h / 2
  const hi = size.h - OUT_EDGE - h / 2
  const result: OutsideLabel[] = []
  type Row = { c: OutsideCandidate; mid: number; span: number; ideal: number }
  for (const side of [1, -1] as const) {
    let group: Row[] = cands
      .filter((c) => c.geom.endAngle > c.geom.startAngle && (Math.cos((c.geom.startAngle + c.geom.endAngle) / 2) >= 0 ? 1 : -1) === side)
      .map((c) => {
        const mid = (c.geom.startAngle + c.geom.endAngle) / 2
        return { c, mid, span: c.geom.endAngle - c.geom.startAngle, ideal: c.geom.cy + (c.geom.outerRadius + OUT_LEAD) * Math.sin(mid) }
      })
      .sort((a, b) => a.ideal - b.ideal)
    while (group.length) {
      const ys = spreadRows(group.map((g) => g.ideal), pitch, lo, hi)
      if (!ys) {
        const smallest = group.reduce((m, g) => (g.span < m.span ? g : m))
        group = group.filter((g) => g !== smallest)
        continue
      }
      const labels: OutsideLabel[] = []
      let failed: Row | null = null
      for (let k = 0; k < group.length && !failed; k++) {
        const label = fitOutsideLabel(group[k].c, group[k].mid, ys[k], side, h, size.w, fonts, measure)
        if (label) labels.push(label)
        else failed = group[k]
      }
      if (!failed) {
        result.push(...labels)
        break
      }
      const dropped: Row = failed
      group = group.filter((g) => g !== dropped)
    }
  }
  return result.sort((a, b) => a.index - b.index)
}

/** One label at height `y` on `side`: its leader and its text, or null when the room is too small for the name. */
function fitOutsideLabel(
  c: OutsideCandidate,
  mid: number,
  y: number,
  side: 1 | -1,
  h: number,
  width: number,
  fonts: { name: string; tail: string },
  measure: ArcLabelMeasure,
): OutsideLabel | null {
  const g = c.geom
  const cos = Math.cos(mid)
  const sin = Math.sin(mid)
  const p0: [number, number] = [g.cx + (g.outerRadius + 1) * cos, g.cy + (g.outerRadius + 1) * sin]
  // the label's box must clear the ring: judged at its edge nearest the ring's centre line
  const dyMin = Math.max(0, Math.abs(y - g.cy) - h / 2)
  const clear = Math.sqrt(Math.max(0, (g.outerRadius + OUT_CLEAR) ** 2 - dyMin ** 2))
  const qx = g.cx + side * Math.max(clear, Math.abs(p0[0] - g.cx) + 3)
  const q: [number, number] = [qx, y]
  const t: [number, number] = [qx + side * OUT_TICK, y]
  // a leader that would double back into the ring bends around it first
  const outward = (q[0] - p0[0]) * cos + (q[1] - p0[1]) * sin >= 0
  const bend: [number, number] = [g.cx + (g.outerRadius + OUT_LEAD) * cos, g.cy + (g.outerRadius + OUT_LEAD) * sin]
  const line: [number, number][] = outward ? [p0, q, t] : [p0, bend, q, t]
  const start = t[0] + side * OUT_PAD
  const room = side === 1 ? width - OUT_EDGE - start : start - OUT_EDGE
  const nameOf = (s: string) => measure(fonts.name, s)
  // The whole name beats the share: when the name would be cut to leave room for the share, the share goes first,
  // and the name is cut only when even the bare name does not fit.
  const tailW = measure(fonts.tail, c.tail)
  const fullW = nameOf(c.name)
  if (fullW > room - tailW - OUT_SPACE && fullW <= room) {
    return { index: c.index, side, line, x: start, y, name: c.name, tail: '', nameW: fullW, tailW: 0 }
  }
  const name = ellipsize(c.name, room - tailW - OUT_SPACE, nameOf)
  if (name === null) return null
  return { index: c.index, side, line, x: start, y, name, tail: c.tail, nameW: nameOf(name), tailW }
}

/** Per-plugin look. The defaults are the nested doughnut's, unchanged. */
export interface ArcLabelOptions {
  nameFont?: string
  subFont?: string
  /** true: ink by best WCAG contrast (see inkOn), instead of the nested doughnut's brightness cut. */
  bestContrast?: boolean
  /** Distance (px) of each of the two text lines from the ring's centre line; default 6 (tight, for 10-11 px text). */
  lineGap?: number
  /** true: a label is drawn only where its full text box lies inside the slice, trying shorter forms and the other
   * orientation first (see fitArcLabel); lineGap is not used. Default false: the nested doughnut's own rule. */
  fit?: boolean
  /** With `fit`: a slice that got no label inside gets one outside the ring on a leader line (see
   * placeOutsideLabels). `ink` and `line` are the text and leader colours, `font` the name's font (the tail uses the
   * sub font), `ready` is asked on every draw: the labels wait while it says false (a motion is playing).
   * Default: none. The chart needs layout padding for them to sit in. */
  outside?: { ink: string; line: string; font?: string; ready?: () => boolean }
}

export function arcLabelsPlugin(itemsByDataset: Record<number, ArcItem[]>, look: ArcLabelOptions = {}) {
  const nameFont = look.nameFont ?? '600 10px Inter, system-ui, sans-serif'
  const subFont = look.subFont ?? '700 11px "Space Grotesk", system-ui, sans-serif'
  const gap = look.lineGap ?? 6 // px from the band centre to each of the two text lines
  const ink = look.bestContrast ? inkOn : textOn
  const outsideFont = look.outside?.font ?? '500 11px Inter, system-ui, sans-serif'
  /** Draws the label inside the slice when it fits; false when it did not (the slice may get one outside). */
  const drawFitted = (ctx: any, arc: any, item: ArcItem, fill: string): boolean => {
    const measure: ArcLabelMeasure = (font, text) => {
      ctx.font = font
      return ctx.measureText(text).width
    }
    const geom: ArcGeom = {
      cx: arc.x,
      cy: arc.y,
      innerRadius: arc.innerRadius,
      outerRadius: arc.outerRadius,
      startAngle: arc.startAngle,
      endAngle: arc.endAngle,
    }
    ctx.save() // the measuring below changes ctx.font
    const placed = fitArcLabel(geom, item, { name: nameFont, sub: subFont }, measure)
    if (!placed) {
      ctx.restore()
      return false
    }
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = ink(fill)
    for (const p of placed) {
      ctx.font = p.font
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(p.rot)
      ctx.fillText(p.text, 0, 0)
      ctx.restore()
    }
    ctx.restore()
    return true
  }
  /** The outside labels of the slices that got none inside: placed together (so they never collide), then drawn. */
  const drawOutside = (chart: any, ctx: any, cands: OutsideCandidate[]) => {
    const out = look.outside
    if (!out || !cands.length || out.ready?.() === false) return
    ctx.save()
    const measure: ArcLabelMeasure = (font, text) => {
      ctx.font = font
      return ctx.measureText(text).width
    }
    const labels = placeOutsideLabels(cands, { w: chart.width, h: chart.height }, { name: outsideFont, tail: subFont }, measure)
    ctx.lineWidth = 1
    ctx.strokeStyle = out.line
    ctx.fillStyle = out.ink
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    for (const l of labels) {
      ctx.beginPath()
      l.line.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      ctx.stroke()
      const x0 = l.side === 1 ? l.x : l.x - (l.nameW + (l.tail ? OUT_SPACE + l.tailW : 0))
      ctx.font = outsideFont
      ctx.fillText(l.name, x0, l.y)
      if (l.tail) {
        ctx.font = subFont
        ctx.fillText(l.tail, x0 + l.nameW + OUT_SPACE, l.y)
      }
    }
    ctx.restore()
  }
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
        const outside: OutsideCandidate[] = []
        meta.data.forEach((arc: any, i: number) => {
          const it = items[i]
          if (!it) return
          if (look.fit) {
            if (!drawFitted(ctx, arc, it, colors[i] ?? '#888888') && look.outside) {
              const subs = (Array.isArray(it.sub) ? it.sub : [it.sub]).filter(Boolean)
              const tail = it.tail ?? subs[subs.length - 1] ?? ''
              const geom: ArcGeom = { cx: arc.x, cy: arc.y, innerRadius: arc.innerRadius, outerRadius: arc.outerRadius, startAngle: arc.startAngle, endAngle: arc.endAngle }
              outside.push({ index: i, name: it.name, tail, geom })
            }
            return
          }
          const span = arc.endAngle - arc.startAngle
          if (span < 0.2) return // ~11°, too small to label
          const mid = (arc.startAngle + arc.endAngle) / 2
          const bandMid = (arc.innerRadius + arc.outerRadius) / 2
          const ma = ((mid % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
          const bottom = ma > 0 && ma < Math.PI
          // keep "name" visually above "sub" on either half
          const nameR = bottom ? bandMid - gap : bandMid + gap
          const subR = bottom ? bandMid + gap : bandMid - gap
          ctx.save()
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillStyle = ink(colors[i] ?? '#888888')
          ctx.font = nameFont
          const nameFits = ctx.measureText(it.name).width / nameR < span * 0.96
          if (nameFits) drawCurvedText(ctx, it.name, arc.x, arc.y, nameR, mid)
          // only show the number line if the name fit too — no orphan "9 · 13%"
          ctx.font = subFont
          if (nameFits) {
            const sub = (Array.isArray(it.sub) ? it.sub : [it.sub]).find((t) => t && ctx.measureText(t).width / subR < span * 0.96)
            if (sub) drawCurvedText(ctx, sub, arc.x, arc.y, subR, mid)
          }
          ctx.restore()
        })
        drawOutside(chart, ctx, outside)
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
export function widgetOverlayOptions(widget: Pick<Widget, 'markers' | 'goLiveMarkers' | 'changeMarkers' | 'flightBands'>) {
  return { releases: widget.markers === 'releases', goLive: !!widget.goLiveMarkers, changes: !!widget.changeMarkers, flights: !!widget.flightBands }
}
export function widgetHasOverlay(widget: Pick<Widget, 'markers' | 'goLiveMarkers' | 'changeMarkers' | 'flightBands'>): boolean {
  const o = widgetOverlayOptions(widget)
  return o.releases || o.goLive || o.changes || o.flights
}

/** Draws a date-axis chart's overlay: shaded flight bands (labelled, one label row per overlap),
 * dashed labelled lines for major releases and go-live moments (labels placed by
 * layoutMarkerLabels: close markers stack into extra rows instead of colliding, none is dropped;
 * the chart's top padding grows by the rows beyond the base ones), short ticks for minor releases.
 * A band's name is placed by its measured extent (layoutBandLabels), colliding ones on another row.
 * Hover or tap near a marker line, or on a band's label strip, shows that item's date, name and
 * note. `dates` are the plotted category values (YYYY-MM-DD), in order. */
export const BAND_ROW_PX = 14
/** The top room the marker labels have by default: the layout padding, the label rows that padding
 * holds, and where the first row starts above the plot. A chart with more rows than `rows` gets
 * MARKER_LABEL_ROW_PX more padding per extra row (the plugin does it); one that fits keeps exactly these. */
export const MARKER_LABEL_ROW_PX = 10
export function markerLabelRoom(narrow: boolean): { pad: number; rows: number; offset: number } {
  return narrow ? { pad: 24, rows: 2, offset: 22 } : { pad: 34, rows: 3, offset: 32 }
}
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
  // Every item under the pointer: markers that share an x position (a web and a Play release on one day) all show.
  let active: { items: OverlayItem[]; x: number; y: number } | null = null
  const bandFlightIndex = new Map(items.filter((i) => i.kind === 'flight').map((it, n) => [it, n]))
  const room = markerLabelRoom(narrow)
  // The marker labels' top padding extra (px) this chart is laid out with, decided after each layout from where the labels
  // really fall (afterLayout). `growOnly` locks it to growth once a chart size has changed it, so passes converge.
  const padState = { extra: 0, touched: false, size: '', growOnly: false }
  type Visible = { p: (typeof points)[number]; x: number }
  // The marker points inside the plot, with their pixel x (after a layout, so the x scale is final).
  const visiblePoints = (chart: any): Visible[] => {
    const { chartArea, scales } = chart
    const out: Visible[] = []
    for (const p of points) {
      const x = scales.x.getPixelForValue(p.index)
      if (x == null || Number.isNaN(x) || x < chartArea.left || x > chartArea.right) continue
      out.push({ p, x })
    }
    return out
  }
  // Where every labelled marker's text goes: unlimited rows, so none is dropped.
  const placeMarkerLabels = (chart: any, visible: Visible[]) => {
    const { ctx, chartArea } = chart
    ctx.save()
    ctx.font = '600 9.5px Inter, system-ui, sans-serif'
    const placed = layoutMarkerLabels(
      visible.filter((v) => v.p.item.kind !== 'minor-release').map((v) => ({ x: v.x, label: v.p.item.label })),
      { measureWidth: (t) => ctx.measureText(t).width, areaLeft: chartArea.left, areaRight: chartArea.right, maxRows: Infinity, rowHeight: MARKER_LABEL_ROW_PX },
    )
    ctx.restore()
    return placed
  }
  return {
    id: 'timelineOverlay',
    // The padding the config sets holds the base rows (markerLabelRoom); rows beyond them add MARKER_LABEL_ROW_PX each.
    beforeLayout(chart: any) {
      if (!padState.touched) return
      const pad = chart.options?.layout?.padding
      if (pad && typeof pad === 'object') pad.top = room.pad + padState.extra
    },
    // After a layout the x positions are final: if the labels need more (or fewer) rows than the padding holds, set the
    // padding and lay out once more. That pass is the last one unless the plot width shifted (a wider axis label); then the
    // padding may only grow, so the passes end and never flip back and forth.
    afterLayout(chart: any) {
      const { chartArea, scales } = chart
      if (!chartArea || !scales?.x || !chart.ctx || !points.length) return
      const needed = markerPaddingExtra(placeMarkerLabels(chart, visiblePoints(chart)), room.rows, MARKER_LABEL_ROW_PX)
      const size = `${chart.width}x${chart.height}`
      if (size !== padState.size) {
        padState.size = size
        padState.growOnly = false
      }
      const next = settlePaddingExtra(padState.extra, needed, padState.growOnly)
      if (next === padState.extra) return
      padState.extra = next
      padState.touched = true
      padState.growOnly = true
      queueMicrotask(() => {
        if (chart.ctx) chart.update('none')
      })
    },
    beforeDatasetsDraw(chart: any) {
      const { ctx, chartArea, scales } = chart
      if (!chartArea || !scales?.x) return
      hits = []
      const half = dates.length > 1 ? Math.abs(scales.x.getPixelForValue(1) - scales.x.getPixelForValue(0)) / 2 : 12
      ctx.save()
      ctx.font = '600 9px Inter, system-ui, sans-serif'
      const extents = bands
        .map((b) => ({
          b,
          left: Math.max(chartArea.left, scales.x.getPixelForValue(b.startIndex) - half),
          right: Math.min(chartArea.right, scales.x.getPixelForValue(b.endIndex) + half),
        }))
        .filter((e) => e.right > e.left)
      // A band's name sits in a strip at its bottom edge; an open-ended band gets an arrow. A name is placed by its measured
      // extent (layoutBandLabels), BAND_ROW_PX per row: bands that overlap in time, or names that would touch, take successive rows.
      const labels = layoutBandLabels(
        extents.map((e) => ({ text: `${e.b.item.label}${e.b.clippedEnd && e.b.item.openEnded ? ' →' : ''}`, left: e.left, row: e.b.row })),
        { measureWidth: (t) => ctx.measureText(t).width, areaLeft: chartArea.left, areaRight: chartArea.right },
      )
      extents.forEach(({ b, left, right }, n) => {
        const color = PALETTE[(bandFlightIndex.get(b.item) ?? 0) % PALETTE.length]
        ctx.fillStyle = color + '22'
        ctx.fillRect(left, chartArea.top, right - left, chartArea.bottom - chartArea.top)
        const l = labels[n]
        const y = chartArea.bottom - 5 - l.row * BAND_ROW_PX
        ctx.fillStyle = color
        ctx.textAlign = 'left'
        ctx.fillText(l.text, l.x, y)
        hits.push({ x0: Math.min(left, l.x - 3), x1: Math.max(right, l.x + l.width + 3), y0: y - 10, y1: y + 2, item: b.item })
      })
      ctx.restore()
    },
    afterDatasetsDraw(chart: any) {
      const { ctx, chartArea, scales } = chart
      if (!chartArea || !scales?.x) return
      const visible = visiblePoints(chart)
      const placed = placeMarkerLabels(chart, visible)
      // The labels sit above the plot, in the layout padding, MARKER_LABEL_ROW_PX per row; rows beyond the base ones
      // (markerLabelRoom) are the padding extra, so the first row starts that much higher.
      const extraPx = markerPaddingExtra(placed, room.rows, MARKER_LABEL_ROW_PX)
      const top = chartArea.top - room.offset - extraPx
      // The text measures wider now than at the last layout (a web font arriving after it): the padding holds fewer rows than
      // these need, so the first row would sit above the canvas. Take the larger extra and lay out once more; `padState.extra`
      // then matches, so later draws queue nothing, and a layout can only keep or grow it from here (growOnly).
      if (extraPx > padState.extra) {
        padState.extra = extraPx
        padState.touched = true
        padState.growOnly = true
        queueMicrotask(() => {
          if (chart.ctx) chart.update('none')
        })
      }
      ctx.save()
      for (const { p, x } of visible) {
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
          ctx.setLineDash(p.item.kind === 'go-live' ? [2, 3] : p.item.kind === 'change' ? [8, 3, 2, 3] : [4, 3])
          ctx.beginPath()
          ctx.moveTo(x, chartArea.top)
          ctx.lineTo(x, chartArea.bottom)
          ctx.stroke()
          ctx.setLineDash([])
        }
        // The hit column reaches up through the label rows, so a tap on the line's label (any row) finds it.
        hits.push({ x0: x - 6, x1: x + 6, y0: Math.min(chartArea.top - 34, top - 2), y1: chartArea.bottom, item: p.item })
      }
      ctx.font = '600 9.5px Inter, system-ui, sans-serif'
      ctx.fillStyle = labelColor
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
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
      const under = itemsAtPointer(hits, e.x, e.y)
      const next = under.length ? { items: under, x: e.x, y: e.y } : null
      const same = (next?.items.length ?? 0) === (active?.items.length ?? 0) && (next?.items ?? []).every((it, i) => it === active!.items[i])
      if (!same) {
        active = next
        args.changed = true
      }
    },
    afterDraw(chart: any) {
      if (!active) return
      const { ctx, chartArea } = chart
      ctx.save()
      ctx.font = '11px Inter, system-ui, sans-serif'
      // One block per item (a bold "date · name" line, then its wrapped note), a thin rule between blocks.
      const blocks = active.items.map((it) => {
        const when = it.kind === 'flight' ? `${it.date} to ${it.openEnded ? 'now' : it.endDate}` : it.date
        return [`${when} · ${it.label}`, ...wrapText(ctx, it.note, 220)]
      })
      const gap = 7
      // Many markers on one x (up to eight on a busy day) would overflow the canvas: keep as many whole blocks as fit, then a "+N more" line.
      const room = (chart.height ?? Infinity) - 4
      const heightOf = (bs: string[][], more: boolean) => bs.reduce((n, b) => n + b.length, 0) * 14 + 10 + (bs.length - 1) * gap + (more ? 14 + gap : 0)
      let more = 0
      while (blocks.length > 1 && heightOf(blocks, more > 0 || blocks.length < active.items.length) > room) {
        blocks.pop()
        more = active.items.length - blocks.length
      }
      const moreLine = more ? `+${more} more, listed under the chart` : ''
      const w = Math.min(240, Math.max(...blocks.flat().map((l) => ctx.measureText(l).width), moreLine ? ctx.measureText(moreLine).width : 0) + 14)
      const h = heightOf(blocks, more > 0)
      const x = Math.min(Math.max(chartArea.left, active.x + 8), chartArea.right - w)
      const y = Math.max(2, Math.min(chartArea.top + 4, (chart.height ?? Infinity) - h - 2))
      ctx.fillStyle = dark ? 'rgba(33,28,24,0.96)' : 'rgba(255,255,255,0.97)'
      ctx.strokeStyle = dark ? 'rgba(240,238,233,0.25)' : 'rgba(26,23,21,0.18)'
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
      ctx.fillStyle = dark ? '#F4F1EA' : INK
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      let ly = y + 5
      blocks.forEach((lines, b) => {
        if (b > 0) {
          ctx.beginPath()
          ctx.moveTo(x + 7, ly + gap / 2 - 0.5)
          ctx.lineTo(x + w - 7, ly + gap / 2 - 0.5)
          ctx.stroke()
          ly += gap
        }
        lines.forEach((l, i) => {
          ctx.font = i === 0 ? '600 11px Inter, system-ui, sans-serif' : '11px Inter, system-ui, sans-serif'
          ctx.fillText(l, x + 7, ly)
          ly += 14
        })
      })
      if (moreLine) {
        ctx.beginPath()
        ctx.moveTo(x + 7, ly + gap / 2 - 0.5)
        ctx.lineTo(x + w - 7, ly + gap / 2 - 0.5)
        ctx.stroke()
        ctx.font = 'italic 11px Inter, system-ui, sans-serif'
        ctx.fillText(moreLine, x + 7, ly + gap)
      }
      ctx.restore()
    },
  }
}
/** The overlay items a pointer at (x, y) is over. A band's name strip wins (as before); otherwise the marker whose line is nearest
 * the pointer, plus every other marker on that same x (a web and a Play release on one day), never a neighbouring day's. */
function itemsAtPointer(hits: { x0: number; x1: number; y0: number; y1: number; item: OverlayItem }[], x: number, y: number): OverlayItem[] {
  const under = hits.filter((h) => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1)
  const band = under.find((h) => h.item.kind === 'flight')
  if (band) return [band.item]
  const centre = (h: { x0: number; x1: number }) => (h.x0 + h.x1) / 2
  let nearest = Infinity
  for (const h of under) if (Math.abs(centre(h) - x) < Math.abs(nearest - x)) nearest = centre(h)
  return under.filter((h) => Math.abs(centre(h) - nearest) < 0.5).map((h) => h.item)
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
  return !!widget.card || widget.dataset === 'overview' || widget.dataset === 'campaigns' || widget.dataset === 'ads-readings' || widget.dataset === 'features' || widget.type === 'note' || widget.type === 'rate'
}

/** True for a line/area chart on the beacon's date axis that draws its own series list. */
export function hasLineSeries(widget: Pick<Widget, 'type' | 'dataset' | 'dimension' | 'series'>): boolean {
  return (widget.type === 'line' || widget.type === 'area') && widget.dataset === 'geo' && isDateDim(widget.dimension) && !!widget.series?.length
}

export interface SeriesDayModel {
  /** The plotted days (YYYY-MM-DD), oldest first. */
  days: string[]
  /** True when the range starts part-way through the first plotted day (a rolling range does), so that day holds
   * only part of a day. False when the axis was trimmed to start at the first day with data, or the range starts
   * on a day boundary (a featureStep query counts whole ET days). */
  firstDayPartial: boolean
  /** Per series, one value per plotted day: the count, or for a ratio series the percent (null on a day the
   * denominator is 0). Same order as widget.series. */
  values: (number | null)[][]
}

/** What a series line chart plots, before any drawing: the plotted days and each series' value per day. One
 * place, so the chart and the before/after readout (lib/beforeAfter.ts) read the same numbers. */
export function seriesDayModel(widget: Widget, responses: StatsResponse[]): SeriesDayModel | null {
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
  const days = (firstData > 0 ? allDays.slice(firstData) : allDays).filter((d) => d >= cutFrom)
  const counts: (number | null)[][] = byDay.map((m) => days.map((d) => m.get(d) ?? 0))
  const values = series.map((s, i) => {
    const r = s.ratio
    if (!r) return counts[i]
    const num = counts[r.num]
    const den = counts[r.den]
    if (!num || !den) return days.map(() => null)
    return days.map((_, k) => (den[k]! > 0 ? (num[k]! / den[k]!) * 100 : null))
  })
  const sinceMs = new Date(first.meta.since).getTime()
  // A range start that is not a day boundary (ET midnight for dateEt, UTC midnight for date) leaves the first day part-filled.
  const boundaryMs = !isFinite(sinceMs) ? NaN : dim === 'dateEt' ? etWallTimeMs(etDateFast(sinceMs)) : Date.parse(new Date(sinceMs).toISOString().slice(0, 10) + 'T00:00:00Z')
  const firstDayPartial = !!days.length && days[0] === allDays[0] && isFinite(sinceMs) && sinceMs !== boundaryMs
  return { days, firstDayPartial, values }
}

/** A line chart's series (Widget.series): each one is its own date query, filtered on a geo
 * field (e.g. keyEvent = 'install'), drawn on the left or right axis. `responses` is one
 * StatsResponse per series, in order. */
export function buildSeriesLineConfig(widget: Widget, responses: StatsResponse[]): ChartConfiguration | null {
  const series = widget.series ?? []
  const model = seriesDayModel(widget, responses)
  if (!model) return null
  const { days: buckets, values } = model
  const hasRatio = series.some((s) => s.ratio)
  // A ratio series is a percent and always on the right axis; the axis shows a % only when every right-axis line is one.
  const hasRight = series.some((s) => s.axis === 'right' || s.ratio)
  const rightIsPercent = hasRatio && series.every((s) => !(s.axis === 'right' && !s.ratio))
  const narrow = isMobileViewport()
  const items = overlayItems(widgetOverlayOptions(widget))
  const hasLabels = items.some((i) => i.kind === 'release' || i.kind === 'go-live' || i.kind === 'change')
  const dash = (style?: string) => (style === 'dashed' ? [4, 3] : style === 'dotted' ? [1, 3] : [])
  const axisTitle = (text?: string) => (text ? { display: !narrow, text, color: tickColor(), font: { family: 'Inter', size: 10 } } : { display: false })
  const scales: any = {
    x: { grid: { color: gridColor() }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 }, maxRotation: 0, autoSkip: true } },
    // Every series is a row count, so a tick is a whole number (a quiet chart would otherwise read 0.5 rows).
    y: { position: 'left', beginAtZero: true, grid: { color: gridColor() }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 }, precision: 0 }, title: axisTitle(widget.axisTitles?.left) },
  }
  if (hasRight) {
    scales.y2 = {
      position: 'right',
      beginAtZero: true,
      grid: { drawOnChartArea: false },
      ticks: { color: tickColor(), font: { family: 'Inter', size: 11 }, precision: 0, ...(rightIsPercent ? { callback: (v: number | string) => `${v}%` } : {}) },
      title: axisTitle(widget.axisTitles?.right),
    }
  }
  return {
    type: 'line',
    data: {
      labels: buckets.map((d) => formatKey('date', d)),
      datasets: series.map((s, i) => {
        const color = PALETTE[s.color ?? i] ?? PALETTE[i % PALETTE.length]
        return {
          label: s.label,
          data: values[i],
          borderColor: color,
          backgroundColor: color,
          yAxisID: s.axis === 'right' || s.ratio ? 'y2' : 'y',
          borderDash: dash(s.style),
          borderWidth: s.style === 'dotted' ? 1.5 : 2,
          tension: 0.2,
          pointRadius: 0,
          pointHitRadius: 16,
          fill: false,
          ...(s.ratio ? { isRatio: true } : {}),
        }
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: hasLabels ? markerLabelRoom(narrow).pad : 4 } },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: tickColor(), font: { family: 'Inter', size: narrow ? 10 : 11 }, boxWidth: narrow ? 8 : 10, boxHeight: narrow ? 8 : 10, padding: narrow ? 6 : 10 } },
        // A ratio line reads as a percent in the tooltip (a day with nothing in the denominator shows no value).
        ...(hasRatio ? { tooltip: { callbacks: { label: (c: any) => (c.dataset.isRatio ? `${c.dataset.label}: ${Math.round(c.parsed.y * 10) / 10}%` : `${c.dataset.label}: ${c.formattedValue}`) } } } : {}),
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

/** "Label · N · P%" for one slice of a doughnut or pie that shows shares; P is the slice's share of every plotted slice. */
export function shareLegendText(label: string, value: number, all: number[]): string {
  const total = all.reduce((a, b) => a + b, 0)
  const pct = total > 0 ? Math.round((value / total) * 100) : 0
  return `${label} · ${value.toLocaleString('en-US')} · ${pct}%`
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
  const valueLabel = dimensionDefOf(dimension)?.valueLabel
  if (valueLabel) return valueLabel(value)
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

export function gridColor() {
  return isDark() ? 'rgba(231,226,215,0.10)' : 'rgba(26,23,21,0.07)'
}
export function tickColor() {
  return isDark() ? '#A8A096' : INK_3
}

const baseScales = () => ({
  x: { grid: { color: gridColor() }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 } } },
  y: { grid: { color: gridColor() }, ticks: { color: tickColor(), font: { family: 'Inter', size: 11 } }, beginAtZero: true },
})

const noLegend = { legend: { display: false } }
/** A legend title naming what each legend entry is (see sliceTitle). */
function legendTitle(text: string, size: number) {
  return { display: !!text, text, color: tickColor(), font: { family: 'Inter', size, weight: 600 } }
}
/** What one slice / bar / row of a one-mark-per-row chart is: "<dimension> · <breakdown>" when it
 * draws pairs (pairRows), else the dimension alone. */
export function sliceTitle(widget: Pick<Widget, 'dataset' | 'dimension' | 'breakdown'>, paired: boolean): string {
  const dim = dimensionTitle(widget.dataset, widget.dimension)
  return paired && widget.breakdown ? `${dim} · ${dimensionTitle(widget.dataset, widget.breakdown)}` : dim
}

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
export function pairBreakdown(widget: Pick<Widget, 'dimension' | 'breakdown' | 'dataset'>): string | null {
  const bd = widget.breakdown
  // A dataset whose API ignores a breakdown (catalog.ts DATASET_BREAKDOWN) returns rows with no
  // second key: pairing them would label every mark "<value> · (none)", so those chart plainly.
  if (!bd || !datasetSupportsBreakdown(widget.dataset) || bd === widget.dimension || isDateDim(widget.dimension) || isDateDim(bd)) return null
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
export function pairRows(widget: Pick<Widget, 'dimension' | 'breakdown' | 'dataset' | 'metric'>, resp: StatsResponse): PairRow[] | null {
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
 * so every pair of one dimension value reads as one family. The lightening step narrows as the
 * breakdown grows (0.16 for up to 5 values, then fitting the 0..0.72 range) so a long breakdown
 * keeps distinct shades; a dimension value past the palette reuses a hue, darkened one notch per
 * lap, so no two pairs share a colour however many there are. */
export function pairColors(widget: Pick<Widget, 'dimension' | 'breakdown'>, pairs: PairRow[]): string[] {
  const bd = widget.breakdown ?? ''
  const aOrder = [...new Set(pairs.map((p) => p.a))]
  const bOrder = orderDimValues(bd, [...new Set(pairs.map((p) => p.b))])
  const step = bOrder.length <= 5 ? 0.16 : 0.72 / (bOrder.length - 1)
  return pairs.map((p) => {
    const ai = aOrder.indexOf(p.a)
    const stable = stableColor(widget.dimension, p.a)
    const lap = Math.floor(ai / PALETTE.length)
    const base = stable ?? shade(PALETTE[ai % PALETTE.length], -0.22 * lap)
    return shade(base, bOrder.indexOf(p.b) * step)
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
            ? { display: true, position: 'bottom', title: legendTitle(dimensionTitle(widget.dataset, widget.breakdown!), 10), labels: { color: tickColor(), font: { family: 'Inter', size: 10 }, boxWidth: 8, boxHeight: 8, padding: 6 } }
            : { display: true, title: legendTitle(dimensionTitle(widget.dataset, widget.breakdown!), 11), labels: { color: tickColor(), font: { family: 'Inter', size: 11 }, boxWidth: 12 } },
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
            ? { display: true, position: 'bottom', title: legendTitle(dimensionTitle(widget.dataset, widget.breakdown!), 10), labels: { color: tickColor(), font: { family: 'Inter', size: 10 }, boxWidth: 8, boxHeight: 8, padding: 6 } }
            : { display: true, position: 'bottom', title: legendTitle(dimensionTitle(widget.dataset, widget.breakdown!), 11), labels: { color: tickColor(), font: { family: 'Inter', size: 11 }, boxWidth: 12 } },
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
    // A doughnut or pie that shows shares (Widget.showShares, else its dimension's default) reads its
    // slices as counts AND shares: the legend line is "Label · N · P%" (P of the plotted slices' sum)
    // and the tooltip says the same.
    const withShares = widgetShowsShares(widget)
    const shown = withShares ? labels.map((l, i) => shareLegendText(l, values[i], values)) : labels
    return {
      type: widget.type === 'pie' ? 'pie' : 'doughnut',
      data: {
        labels: shown,
        datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: isDark() ? '#211C18' : '#FFFFFF' }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // The legend's title names what a slice is: "Mode · Difficulty" for pairs, "Mode" for one
        // dimension, so a pie that lost its breakdown can never pass for the paired one.
        plugins: {
          legend: { position: 'right', title: legendTitle(sliceTitle(widget, !!pairs), 11), labels: { color: tickColor(), font: { family: 'Inter', size: 11 }, boxWidth: 12 } },
          ...(withShares ? { tooltip: { callbacks: { title: () => '', label: (ctx: any) => ` ${shareLegendText(labels[ctx.dataIndex], values[ctx.dataIndex], values)}` } } } : {}),
        },
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
        ...(overlay.length && overlay.some((i) => i.kind === 'release' || i.kind === 'go-live' || i.kind === 'change') ? { layout: { padding: { top: markerLabelRoom(isMobileViewport()).pad } } } : {}),
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
