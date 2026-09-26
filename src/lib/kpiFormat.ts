// Pure display-formatting helpers for OverviewWidgetBody.vue's "Today at a glance" KPI tiles
// (fix/clean-look, 2026-09-26) — pulled out of the component so the delta-rounding fix is
// independently unit-testable without mounting a Vue component. Not shared with
// CampaignsWidgetBody.vue's own formatters (separate widget, separate ownership area).
import type { Delta } from './overview'
import { addEtDays } from './overview'
import {
  isInsufficientCohort,
  etDateFromMs,
  GAME_COMPLETE_LIVE_AT,
  INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS,
  TRACKING_ACTIVATION_DATE_ET,
} from './popupEvents'
import { noteRawText } from './notes'

export function fmtCount(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}

export function pct(n: number | null | undefined, denominator?: number): string {
  if (n == null) return denominator != null && isInsufficientCohort(denominator) ? noteRawText('too-few-to-report') : '—'
  return `${(n * 100).toFixed(1)}%`
}

export function counts(numerator: number | null | undefined, denominator: number | null | undefined): string {
  return numerator == null || denominator == null ? '' : `(${numerator}/${denominator})`
}

export function money(n: number | null | undefined): string {
  return n == null ? '—' : `$${n.toFixed(2)}`
}

// KPI deltas are always a difference of COUNTS (page views, arrivals, …) — including
// vs-7d-avg, where the average itself is fractional (e.g. 102.142857…), so the raw delta is
// too unless rounded. Owner-reported regression, 2026-09-26: "vs 7d avg +102.143 (+941%)" read
// the raw decimal straight through. Sensible precision for a count is an integer; the percent
// part already rounds to 0 decimals.
export function deltaLabel(d: Delta | null | undefined): string {
  if (!d) return ''
  const rounded = Math.round(d.delta)
  const sign = rounded > 0 ? '+' : ''
  const pctPart = d.deltaPct == null ? '' : ` (${d.delta > 0 ? '+' : ''}${(d.deltaPct * 100).toFixed(0)}%)`
  return `${sign}${rounded.toLocaleString('en-US')}${pctPart}`
}

export function deltaClass(d: Delta | null | undefined): '' | 'up' | 'down' {
  if (!d || d.delta === 0) return ''
  return d.delta > 0 ? 'up' : 'down'
}

// ── Go-live-boundary gating for "vs yesterday" / "vs 7d avg" (coordinator addition,
// 2026-09-26) ────────────────────────────────────────────────────────────────────────────
// A KPI whose underlying beacon only started existing partway through its own comparison
// window reads as nonsense once you do the subtraction: "Games completed" didn't exist before
// GAME_COMPLETE_LIVE_AT (2026-09-26T19:43:02Z), the install-outcome fix landed mid-flight
// (INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS, 16:26:36Z), and the pop-up beacons went live on
// TRACKING_ACTIVATION_DATE_ET — so "vs yesterday" or "vs 7d avg" for any of these is comparing
// today's real count against days that are silently zero/unmeasured, producing things like
// "+2525%" or "-100%" that look like real swings but are really just "there was no data
// before". Each go-live instant is a SINGLE SOURCE OF TRUTH constant already (popupEvents.ts /
// adsRules.ts) — this only maps a KPI tile's `key` to the constant that governs it and derives
// the ET calendar day boundary from it, never a hard-coded date of its own.
const KPI_GO_LIVE_ET_DATE: Record<string, string> = {
  // Both instants are typed `number | null` upstream (pre-launch they can still be unset) —
  // spread in only once known, same defensive pattern the rest of the codebase uses for these
  // same constants (e.g. lib/notes.ts's PLAY_TRACKING_ACTIVATION_DATE_ET checks).
  ...(GAME_COMPLETE_LIVE_AT != null ? { completed: etDateFromMs(GAME_COMPLETE_LIVE_AT) } : {}), // v1.95.5 "Games completed"
  ...(INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS != null
    ? { install: etDateFromMs(INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS) } // install-outcome fix
    : {}),
  // 'installRaw' (raw install signals) is deliberately NOT gated here: isRawInstallSignal
  // matches a separate `/install/<outcome>` beacon family that fired before and after the fix
  // — the fix was specifically about the deduplicated popup-outcome install step ('install'
  // above) never recording an outcome for prompt-driven installs, not about these raw signals.
  ...(TRACKING_ACTIVATION_DATE_ET
    ? {
        popupShown: TRACKING_ACTIVATION_DATE_ET,
        popupAccept: TRACKING_ACTIVATION_DATE_ET,
        returns: TRACKING_ACTIVATION_DATE_ET, // /return/ d1+ — same beacon go-live
      }
    : {}),
}

export interface KpiComparisonGate {
  hideVsYesterday: boolean
  hideVsAvg7: boolean
  /** Both comparisons are meaningless (go-live is today or later) — the caller should show
   * "new today" instead of either line, rather than just silently omitting them. */
  newToday: boolean
}

const NO_GATE: KpiComparisonGate = { hideVsYesterday: false, hideVsAvg7: false, newToday: false }

/** `todayEt` is the response's own `OverviewResponse.todayEt` (an ET calendar date string —
 * lexical comparison is chronological for 'YYYY-MM-DD'). A tile with no entry in
 * KPI_GO_LIVE_ET_DATE (an established metric with no go-live gap, e.g. page views) is never
 * gated. */
export function kpiComparisonGate(key: string, todayEt: string): KpiComparisonGate {
  const goLiveEt = KPI_GO_LIVE_ET_DATE[key]
  if (!goLiveEt || !todayEt) return NO_GATE
  const yesterdayEt = addEtDays(todayEt, -1)
  const avg7StartEt = addEtDays(todayEt, -7) // earliest day folded into the 7-day average
  // ">=": go-live ON the comparison day still means that day was only PARTLY measured, which
  // is as misleading as a day with no data at all.
  const hideVsYesterday = goLiveEt >= yesterdayEt
  const hideVsAvg7 = goLiveEt >= avg7StartEt
  return { hideVsYesterday, hideVsAvg7, newToday: hideVsYesterday && hideVsAvg7 }
}
