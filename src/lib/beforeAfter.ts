// The "before and after" readout of a date-axis series chart (Widget.compareAt): the average per day on an
// equal run of days each side of a marker, from the series the chart already draws (no extra query, so the
// read budget and the geo SQL are untouched). Pure: the chart card hands in the plotted days and per-day
// values and shows the text as one note under the chart.
//
// Rules, all plain: the marker's own Eastern day is left out (it holds both sides); only COMPLETE days count
// (today is partial, so it is never in the after run, and a first plotted day that the range starts part-way
// through is partial too, so it is in neither run); both runs have the same length, the most days that
// both sides have inside the plotted range, the after run starting the day after the marker and the before run
// ending the day before it; and under MIN_DAYS complete days the readout says it is too early, with no numbers.
import { datedReleases } from './releases'
import { datedProductChanges } from './productChanges'

/** Fewest days each side that the readout will compare. */
export const COMPARE_MIN_DAYS = 3

export interface CompareTarget {
  id: string
  label: string
  /** The marker's Eastern day (YYYY-MM-DD). */
  date: string
}

/** The markers a chart can compare around: the labelled releases (major) and the product changes, newest first. */
export function compareTargets(): CompareTarget[] {
  const all: CompareTarget[] = [
    ...datedReleases().filter((r) => r.major).map((r) => ({ id: r.version, label: r.label ?? r.version, date: r.dateEt })),
    ...datedProductChanges().map((c) => ({ id: c.id, label: c.label, date: c.dateEt })),
  ]
  return all.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.label < b.label ? -1 : 1))
}

export function compareTarget(id: string | undefined): CompareTarget | null {
  return id ? (compareTargets().find((t) => t.id === id) ?? null) : null
}

export interface CompareWindows {
  /** Indexes into the plotted days. Equal length. */
  before: number[]
  after: number[]
  /** Complete days after the marker inside the range, before any clipping to the before side. */
  afterAvailable: number
  beforeAvailable: number
}

/** The two runs of days around `markerDate`. `days` are the plotted ET days, oldest first; `todayEt` bounds the
 * complete days (a day that is today or later is partial); `firstDayPartial` says the range starts part-way through
 * the first plotted day (a rolling range does), so that day holds only part of a day and is left out. */
export function compareWindows(days: string[], markerDate: string, todayEt: string, firstDayPartial = false): CompareWindows {
  const beforeIdx: number[] = []
  const afterIdx: number[] = []
  days.forEach((d, i) => {
    if (i === 0 && firstDayPartial) return
    if (d < markerDate) beforeIdx.push(i)
    else if (d > markerDate && d < todayEt) afterIdx.push(i)
  })
  const n = Math.min(beforeIdx.length, afterIdx.length)
  return { before: beforeIdx.slice(beforeIdx.length - n), after: afterIdx.slice(0, n), afterAvailable: afterIdx.length, beforeAvailable: beforeIdx.length }
}

/** One series' per-day values for the readout: counts, or (a ratio series) the numerator and denominator
 * counts, so a rate is pooled over the run instead of an average of daily rates. */
export interface CompareSeries {
  label: string
  values: (number | null)[]
  ratio?: { num: (number | null)[]; den: (number | null)[] }
}

const sum = (xs: (number | null)[], idx: number[]) => idx.reduce((a, i) => a + (xs[i] ?? 0), 0)

function fmtAvg(n: number): string {
  return n >= 100 ? String(Math.round(n)) : n >= 10 ? n.toFixed(1).replace(/\.0$/, '') : n.toFixed(2).replace(/\.?0+$/, '') || '0'
}
function fmtPct(n: number): string {
  return `${n >= 10 ? n.toFixed(0) : n.toFixed(1).replace(/\.0$/, '')}%`
}
function change(before: number, after: number): string {
  if (before === 0) return after === 0 ? 'no change' : 'from zero'
  const p = ((after - before) / before) * 100
  const r = Math.abs(p) >= 10 ? Math.round(p) : Math.round(p * 10) / 10
  return r === 0 ? 'no change' : `${r > 0 ? '+' : ''}${r}%`
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** The readout as note text (paragraphs split by a blank line, **bold** allowed: lib/textLite.ts), or null when
 * the marker is unknown. */
export function compareReadoutText(target: CompareTarget | null, days: string[], series: CompareSeries[], todayEt: string, firstDayPartial = false): string | null {
  if (!target || !days.length) return null
  const head = `**Before and after ${target.label} (${target.date}):**`
  // The change is older than the whole plotted range: nothing before it is shown, and the days after it are not
  // "so far", so the cure is a wider range, not waiting.
  if (target.date < days[0]) return `${head} this change is before the shown range; widen the range to compare.`
  const w = compareWindows(days, target.date, todayEt, firstDayPartial)
  if (w.afterAvailable < COMPARE_MIN_DAYS) {
    return `${head} only ${plural(w.afterAvailable, 'complete day')} after it so far (it takes ${COMPARE_MIN_DAYS}), too early to compare.`
  }
  if (w.before.length < COMPARE_MIN_DAYS) {
    return `${head} only ${plural(w.beforeAvailable, 'day')} before it in this range (it takes ${COMPARE_MIN_DAYS}); widen the range to compare.`
  }
  const n = w.before.length
  const lines = series.map((s) => {
    if (s.ratio) {
      const rate = (idx: number[]) => {
        const d = sum(s.ratio!.den, idx)
        return d > 0 ? (sum(s.ratio!.num, idx) / d) * 100 : null
      }
      const b = rate(w.before)
      const a = rate(w.after)
      if (b === null || a === null) return `${s.label}: before: ${b === null ? 'none' : fmtPct(b)}, after: ${a === null ? 'none' : fmtPct(a)}`
      const diff = Math.round((a - b) * 10) / 10
      return `${s.label}: before: ${fmtPct(b)}, after: ${fmtPct(a)} (${diff === 0 ? 'no change' : `${diff > 0 ? '+' : ''}${diff} points`})`
    }
    const b = sum(s.values, w.before) / n
    const a = sum(s.values, w.after) / n
    return `${s.label}, avg/day before: ${fmtAvg(b)}, after: ${fmtAvg(a)} (${change(b, a)})`
  })
  return [`${head} the ${plural(n, 'day')} each side, the marker day left out.`, ...lines].join('\n\n')
}
