// fmtCount (the Overview release panel) and the go-live comparison gate the metrics registry
// uses for "vs yesterday" / "vs 7d avg" (comparisonGateForGoLive; kpiComparisonGate maps a
// former KPI tile key to it and is kept as the registry's reference in its tests). The KPI
// tiles' own formatters retired with the tiles (CONFIG_VERSION 10: the 'bsk-kpis' card).
import { addEtDays } from './overview'
import {

  etDateFromMs,
  GAME_COMPLETE_LIVE_AT,
  INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS,
  TRACKING_ACTIVATION_DATE_ET,
} from './popupEvents'
import { campaignById } from './campaigns'

export function fmtCount(n: number | null | undefined): string {
  return n == null ? '—' : n.toLocaleString('en-US')
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

/** A per-campaign "Tagged arrivals" tile (`arrivals-<campaignId>`, a key of the retired
 * /api/overview KPI section, which kpiComparisonGate still reads) is gated on its flight's start
 * date: attribution starts there (campaignAttributionClause), so a
 * comparison day before it is 0 by construction, and the start day itself is partial (the retest
 * starts at 12:00 ET). Same boundary rule as the go-live constants above (ADR 0003 row 15). */
function arrivalsTileFlightStart(key: string): string | undefined {
  if (!key.startsWith('arrivals-')) return undefined
  return campaignById(key.slice('arrivals-'.length))?.flightStart ?? undefined
}

const NO_GATE: KpiComparisonGate = { hideVsYesterday: false, hideVsAvg7: false, newToday: false }

/** The per-tile gate of the retired KPI section, kept as the reference the metrics registry's
 * instrumentation rules are tested against (lib/metrics/instrumentation.test.ts); the cards use
 * comparisonGateForGoLive below. `todayEt` is an ET calendar date string (lexical comparison is
 * chronological for 'YYYY-MM-DD'). A tile with no entry in KPI_GO_LIVE_ET_DATE (an established
 * metric with no go-live gap, e.g. page views) is never gated. */
export function kpiComparisonGate(key: string, todayEt: string): KpiComparisonGate {
  return comparisonGateForGoLive((Object.hasOwn(KPI_GO_LIVE_ET_DATE, key) ? KPI_GO_LIVE_ET_DATE[key] : undefined) ?? arrivalsTileFlightStart(key), todayEt)
}

/** The boundary rule itself, for any go-live ET date: shared with the metrics registry
 * (lib/metrics/instrumentation.ts), which derives `goLiveEt` from a metric's instrumentation
 * rules instead of a tile key. undefined/null = never gated. */
export function comparisonGateForGoLive(goLiveEt: string | null | undefined, todayEt: string): KpiComparisonGate {
  if (!goLiveEt || !todayEt) return NO_GATE
  const yesterdayEt = addEtDays(todayEt, -1)
  const avg7StartEt = addEtDays(todayEt, -7) // earliest day folded into the 7-day average
  // ">=": go-live ON the comparison day still means that day was only PARTLY measured, which
  // is as misleading as a day with no data at all.
  const hideVsYesterday = goLiveEt >= yesterdayEt
  const hideVsAvg7 = goLiveEt >= avg7StartEt
  return { hideVsYesterday, hideVsAvg7, newToday: hideVsYesterday && hideVsAvg7 }
}
