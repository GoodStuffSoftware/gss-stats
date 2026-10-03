// Daily series (ADR 0005 slice 2): the per-ET-day points behind a `sparkline` display. A series
// is the SAME metric as its scalar value, counted per ET day from the metric's daily twin fact
// (lib/metrics/facts.ts campaignDaily / bskRangeDaily / popupRangeDaily / adsSpendDaily).
//
// Rules, each one a guard against drawing something the scalar could not:
//  - COUNTS AND MONEY ONLY. A ratio, a proportion or a cost never gets a series (validate.ts
//    refuses it), so no per-day rate can slip past MIN_COHORT.
//  - ET DAYS ONLY. Never an hour or a minute: the twins group by ET date, and the visitor kind is
//    collapsed on every path lib/splitGuard.ts refuses, so a /return or game-complete row is
//    never tied to a device on a day.
//  - A GAP IS NOT A ZERO. A day the metric was not measured (before a go-live, or a spend day the
//    store never synced) has NO point. A measured day with no rows has an explicit 0.
//  - AT MOST SERIES_MAX_DAYS points: the latest ones.
//
// Pure and synchronous: engine.ts picks the rows; nothing here sees SQL or a clock.

import { addDays } from '../etTime'
import type { DailyBeaconRow, FactId, SpendDayRow } from './facts'
import type { MetricDef } from './metrics'
import { etMidnightMs } from './instrumentation'
import type { SeriesPoint, WindowName } from './types'

export const SERIES_MAX_DAYS = 92

/** The windows a series may be asked in: a range with a defined start (the page range, or a
 * campaign's attribution window). A "today so far" window is one partial day, and the release
 * and upsell sides are split windows, so none has a day axis worth drawing. */
const SERIES_WINDOWS: ReadonlySet<WindowName> = new Set(['page', 'attribution'])

/** A fact's daily twin (a statement grouped by ET day over the same WHERE). Absent: no series. */
export const DAILY_TWIN: Readonly<Partial<Record<FactId, FactId>>> = {
  campaignPathVisitor: 'campaignDaily',
  bskRangePath: 'bskRangeDaily',
  popupRangePath: 'popupRangeDaily',
  adsSpend: 'adsSpendDaily',
}

/** The daily twin a metric's series reads in `window`, or null when it has no series: only a
 * beacon count or a stored-spend amount, in a ranged window with a twin. */
export function seriesTwin(def: MetricDef, window: WindowName): FactId | null {
  if (!SERIES_WINDOWS.has(window) || def.store) return null
  const fact = def.windows[window]
  const twin = fact ? DAILY_TWIN[fact] : undefined
  if (!twin) return null
  if (twin === 'adsSpendDaily') return def.spend ? twin : null
  if (def.unit === 'instant' || def.unit === 'code' || def.unit === 'usd') return null
  if (twin === 'popupRangeDaily' && def.visitor) return null // that twin has no visitor column
  return twin
}

/** The last SERIES_MAX_DAYS days of [first, last] (inclusive), dropping any day whose ET midnight
 * is before `measuredFromMs` (a go-live inside the window: those days are unmeasured). */
function dayAxis(first: string, last: string, measuredFromMs: number | null): string[] {
  const out: string[] = []
  if (first > last) return out
  let start = first
  const floor = addDays(last, -(SERIES_MAX_DAYS - 1))
  if (start < floor) start = floor
  for (let d = start; d <= last; d = addDays(d, 1)) {
    if (measuredFromMs !== null && etMidnightMs(d) < measuredFromMs) continue
    out.push(d)
  }
  return out
}

export interface BeaconSeriesInput {
  rows: readonly DailyBeaconRow[]
  /** The metric's path test (undefined: every path). */
  test?: (path: string) => boolean
  onlyNew: boolean
  anyTag: boolean
  /** Only these campaign tags (a campaign read from a site-wide twin), or null. */
  tags: ReadonlySet<string> | null
  /** The window's first and last ET day (inclusive). */
  firstDay: string
  lastDay: string
  /** The latest day the axis may reach (today, ET): a late row never extends it past that. */
  capDay: string
  /** Extend the axis to the latest day that has a counted row, even after `lastDay` (an
   * attribution window has no upper bound: a tagged row belongs to its campaign however late). */
  reachCounted: boolean
  /** A partial interval's start: days that begin before it are unmeasured (no point). */
  measuredFromMs: number | null
}

/** The metric's count per ET day, oldest first. Measured days with no counted row read 0. */
export function beaconSeries(i: BeaconSeriesInput): SeriesPoint[] {
  const counts = new Map<string, number>()
  const pass = new Map<string, boolean>()
  let latest = ''
  for (const r of i.rows) {
    if (i.onlyNew && r.visitor !== 'new') continue
    if (i.anyTag && r.campaign === '') continue
    if (i.tags && !i.tags.has(r.campaign)) continue
    if (i.test) {
      let ok = pass.get(r.path)
      if (ok === undefined) pass.set(r.path, (ok = i.test(r.path)))
      if (!ok) continue
    }
    counts.set(r.dt, (counts.get(r.dt) ?? 0) + r.c)
    if (r.c > 0 && r.dt > latest) latest = r.dt
  }
  let last = i.lastDay
  if (i.reachCounted && latest > last) last = latest
  if (last > i.capDay) last = i.capDay
  return dayAxis(i.firstDay, last, i.measuredFromMs).map((day) => ({ day, value: counts.get(day) ?? 0 }))
}

export interface SpendSeriesInput {
  rows: readonly SpendDayRow[]
  campaignId: string
  firstDay: string | null
  capDay: string
}
const round2 = (x: number) => Math.round(x * 100) / 100

/** A campaign's stored spend per ET day (dollars). Only days the store holds get a point: a day
 * it never synced is a gap, not $0. */
export function spendSeries(i: SpendSeriesInput): SeriesPoint[] {
  const days = i.rows
    .filter((r) => r.campaignId === i.campaignId && r.date <= i.capDay && (i.firstDay === null || r.date >= i.firstDay))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const keep = days.length > SERIES_MAX_DAYS ? days.slice(days.length - SERIES_MAX_DAYS) : days
  return keep.map((r) => ({ day: r.date, value: round2(r.costMicros / 1_000_000) }))
}
