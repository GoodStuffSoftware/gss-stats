// Instrumentation windows and go-live gating (ADR 0003 section 2, "Instrumentation windows and
// go-live gating"). Rules are DATA on each metric (lib/metrics/metrics.ts); this module turns
// them into a measured interval I for one request's window W = [a, b):
//
//   1. beaconMeasurable   a spend-only campaign has no beacon rows at all  → unmeasured 'spend-only'
//   2. liveAt / liveOnEtDate   I starts at the go-live (null = not live → unmeasured 'not-live');
//      `against: 'flight'` compares with the campaign's SERVING window: a flight that ended
//      before the go-live is unmeasured outright (returnBeaconNotInstrumented /
//      gameCompleteNotInstrumented, which this reproduces — instrumentation.test.ts checks both)
//   3. unmeasuredBefore   the fact already drops earlier rows (the install gap); I starts there
//   4. seenInFlightWindow  a CLOSED flight whose serving window never saw the metric's paths
//      site-wide → unmeasured 'not-seen-in-flight' (the per-flight check /api/campaigns runs;
//      an active or upcoming flight's window is still open, so it stays live)
//   5. annotateAt   a marker, never a gate: the note travels with a window that spans it
//
// Then: I empty → unmeasured; I a strict part of W → partial (the value is a floor, measured
// from I's start); otherwise measured. Deltas and lag use the same go-live instants.
//
// Every instant is an EXISTING constant (lib/popupEvents.ts, lib/campaigns.ts) — never a copy.

import { classifyFunnelPath, etFlightRangeMs, FUNNEL_STEP_ORDER, type CampaignFlight, type FunnelStepKey } from '../campaigns'
import { addDays, etDateFast, etWallTimeMs } from '../etTime'
import { comparisonGateForGoLive } from '../kpiFormat'

export type InstrumentationRule =
  /** A beacon that started at an exact instant (e.g. GAME_COMPLETE_LIVE_AT); null = not live. */
  | { kind: 'liveAt'; atMs: number | null; against?: 'window' | 'flight'; source: string; noteId?: string; reason?: string }
  /** A beacon that started on an ET calendar date (e.g. TRACKING_ACTIVATION_DATE_ET). The whole
   * day counts as measured for values; for deltas the day itself is partial (kpiComparisonGate). */
  | { kind: 'liveOnEtDate'; dateEt: string | null; against?: 'window' | 'flight'; source: string; noteId?: string }
  /** Rows before `atMs` are dropped row-exactly by the fact itself (the install gap). */
  | { kind: 'unmeasuredBefore'; atMs: number | null; source: string; noteId?: string }
  /** Empirical, per closed flight: the metric's paths appeared site-wide in its serving window. */
  | { kind: 'seenInFlightWindow' }
  /** False for a `measurement: 'spend-only'` campaign. */
  | { kind: 'beaconMeasurable' }
  /** A marker, never a gate (the raw-install de-dupe). */
  | { kind: 'annotateAt'; atMs: number; noteId: string }

export interface MeasuredInterval {
  status: 'measured' | 'partial' | 'unmeasured'
  /** Start of I (epoch ms); equals the window start when measured. */
  from: number
  reason?: 'spend-only' | 'not-live' | 'not-seen-in-flight' | 'flight-pending' | string
  /** Registry note ids that travel with the value (a partial rule's note, annotations). */
  noteIds: string[]
  /** The latest go-live ET date among the rules (delta gating), or null when none gates. */
  goLiveEt: string | null
}

export interface IntervalInput {
  rules: readonly InstrumentationRule[]
  window: readonly [number, number]
  campaign?: CampaignFlight
  /** seenInFlightWindow's evidence: did any flightPathsSeen row match the metric? Only read for
   * a closed campaign (seenInFlightRequired); absent evidence counts as not seen. */
  seenInFlight?: boolean
}

/** Whether seenInFlightWindow applies: only a CLOSED flight's serving window is final. An
 * active or upcoming flight can still see a path for the first time, so it stays live. */
export function seenInFlightRequired(campaign: CampaignFlight | undefined): boolean {
  return !!campaign && campaign.status === 'closed'
}

// ET date <-> instant conversions: the engine asks for the same handful of go-live dates and
// flight bounds hundreds of times per batch, inside a 10 ms CPU budget, so it uses lib/etTime.ts's
// plain DST arithmetic (checked against Intl hour by hour in etTime.test.ts) instead of
// lib/campaigns.ts etMidnightUtcMs / lib/popupEvents.ts etDateFromMs, which format through Intl
// on every call (and whose first use in a fresh isolate is slower still). Same results.
/** lib/campaigns.ts etMidnightUtcMs, without Intl. */
export function etMidnightMs(dateEt: string): number {
  return etWallTimeMs(dateEt)
}
/** lib/popupEvents.ts etDateFromMs, without Intl. */
export function etDateOfMs(ms: number): string {
  return etDateFast(ms)
}

/** The end (exclusive, epoch ms) of a campaign's serving window: the ET midnight after flightEnd. */
export function servingEndMs(campaign: CampaignFlight): number {
  return etWallTimeMs(addDays(campaign.flightEnd, 1))
}

const unmeasured = (reason: string, goLiveEt: string | null = null): MeasuredInterval => ({ status: 'unmeasured', from: Number.POSITIVE_INFINITY, reason, noteIds: [], goLiveEt })

export function measuredInterval({ rules, window, campaign, seenInFlight }: IntervalInput): MeasuredInterval {
  // No closures in here: it runs for every request side, and the production bundle names every
  // named closure (esbuild keepNames) at each creation.
  const a = window[0]
  const b = window[1]
  let from = a
  let goLiveEt: string | null = null
  let partialNote: string | null = null
  const noteIds: string[] = []
  for (const rule of rules) {
    let at: number | null = null // the instant this rule starts the interval at, if any
    let et: string | null = null // its ET go-live date (delta gating)
    let note: string | undefined
    switch (rule.kind) {
      case 'beaconMeasurable':
        if (campaign?.measurement === 'spend-only') return unmeasured('spend-only')
        continue
      case 'liveAt':
        if (rule.atMs === null) return unmeasured(rule.reason ?? 'not-live')
        if (rule.against === 'flight' && campaign && servingEndMs(campaign) <= rule.atMs) return unmeasured(rule.reason ?? 'not-live')
        at = rule.atMs
        et = etDateOfMs(rule.atMs)
        note = rule.noteId
        break
      case 'liveOnEtDate':
        if (rule.dateEt === null) return unmeasured('not-live')
        if (rule.against === 'flight' && campaign && campaign.flightEnd < rule.dateEt) return unmeasured('not-live')
        at = etMidnightMs(rule.dateEt)
        et = rule.dateEt
        note = rule.noteId
        break
      case 'unmeasuredBefore':
        if (rule.atMs === null) return unmeasured('not-live')
        at = rule.atMs
        et = etDateOfMs(rule.atMs)
        note = rule.noteId
        break
      case 'seenInFlightWindow':
        if (seenInFlightRequired(campaign)) {
          if (!campaign!.flightStart) return unmeasured('flight-pending')
          if (seenInFlight !== true) return unmeasured('not-seen-in-flight') // no evidence is not evidence of a path
        }
        continue
      case 'annotateAt':
        if (rule.atMs > a && rule.atMs < b) noteIds.push(rule.noteId)
        continue
    }
    if (goLiveEt === null || et! > goLiveEt) goLiveEt = et
    if (at! > from) {
      from = at!
      partialNote = note ?? null
    }
  }
  // A window that has not started yet (a > b: an attribution window before the flight's start
  // time, e.g. the retest before 12:00 ET on its first day) is 'not-started' — never a measured
  // 0, and never "not yet tracking" either: the campaign simply has not begun.
  if (a > b) return { ...unmeasured('not-started', goLiveEt), noteIds: ['not-started'] }
  // An empty window (today so far at exactly ET midnight: a == b) is measured, value 0, as long
  // as no go-live falls after its start; only a go-live at or past the end leaves it unmeasured.
  if (from > a && from >= b) return unmeasured('not-live', goLiveEt)
  if (from > a) return { status: 'partial', from, noteIds: [partialNote ?? 'counted-from', ...noteIds], goLiveEt }
  return { status: 'measured', from: a, noteIds, goLiveEt }
}

/** Which "today so far" deltas may be shown: both comparison windows must be fully measured,
 * the same day-level rule the KPI tiles use (lib/kpiFormat.ts comparisonGateForGoLive). */
export function deltasAllowed(goLiveEt: string | null, todayEt: string): { yesterday: boolean; avg7: boolean } {
  const g = comparisonGateForGoLive(goLiveEt, todayEt)
  return { yesterday: !g.hideVsYesterday, avg7: !g.hideVsAvg7 }
}

/** Lagged outcomes (a sign-in within a day of the ask, an install within 7 days of the prompt, a
 * d2-7 return): the value is provisional until the longest lag has passed since the
 * denominator stopped growing (`stopMs`). */
export function isProvisional(lagDays: readonly [number, number] | undefined, stopMs: number, nowMs: number): boolean {
  if (!lagDays) return false
  return nowMs < stopMs + lagDays[1] * 86_400_000
}

/** The latest of two ET dates (either may be null). */
export function laterEtDate(x: string | null, y: string | null): string | null {
  if (x === null) return y
  if (y === null) return x
  return x > y ? x : y
}

// ── flightPathsSeen classification (moved from functions/_lib/campaignInstrumentation.ts) ──
export interface PathCount {
  path: string
  c: number
}

/** Funnel steps (excluding 'arrivals', always instrumented) with no hit at all in a flight's
 * flightPathsSeen rows — the legacy per-flight "not instrumented" list /api/campaigns and the
 * overview scorecard use. */
export function notInstrumentedStepsFromRows(rows: readonly PathCount[]): FunnelStepKey[] {
  const seen = new Set<FunnelStepKey>()
  for (const r of rows) {
    const step = classifyFunnelPath(r.path)
    if (step && r.c > 0) seen.add(step)
  }
  return FUNNEL_STEP_ORDER.filter((k) => k !== 'arrivals' && !seen.has(k))
}

/** The same evidence for any metric: did any row with a positive count match its path test? */
export function anyPathSeen(rows: readonly PathCount[], matches: (path: string) => boolean): boolean {
  return rows.some((r) => r.c > 0 && matches(r.path))
}

/** The serving window [start, end) flightPathsSeen covers, or null for a pending flight. */
export function flightWindowMs(campaign: CampaignFlight): [number, number] | null {
  return campaign.flightStart ? etFlightRangeMs(campaign.flightStart, campaign.flightEnd) : null
}
