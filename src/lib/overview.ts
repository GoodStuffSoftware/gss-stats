// "Best Sudoku overview" page (Part C) — pure logic shared by functions/api/overview.ts and
// components/OverviewPage.vue. Aggregate-only, no joins — same rules as lib/campaigns.ts and
// lib/popupEvents.ts, which this module builds on rather than duplicates.

import { etDateFromMs, excludeInstallGapUnmeasured, TRACKING_ACTIVATION_DATE_ET } from './popupEvents'
import { etMidnightUtcMs, CAMPAIGNS, flightDayIndex, applyExclusions, type CampaignFlight } from './campaigns'

// ── Shared WHERE-clause builder for the KPI / timeline / release-panel D1 queries ────────
/** `site IN (...) AND ts >= ? AND ts < ?` plus every row-exclusion rule (see
 * lib/campaigns.ts applyExclusions) — ONE function so all three query sections in
 * functions/api/overview.ts apply exclusions identically. HIGH review finding, 2026-09-25:
 * three of the page's four query sections (KPI, timeline, release panel) had been reading
 * `hits` unfiltered while only the campaign scorecard (which calls
 * campaignAttributionClause + applyExclusions directly) excluded household/lifecycle rows —
 * 123 of 2,913 production bestsudoku* rows matched exclusion criteria and were leaking
 * through. Routing every section's WHERE clause through this one function makes that
 * divergence structurally impossible going forward. */
export function siteWindowClause(sites: string[], startMs: number, endMs: number): { sql: string; binds: unknown[] } {
  const w: string[] = [`site IN (${sites.map(() => '?').join(', ')})`, 'ts >= ?', 'ts < ?']
  const b: unknown[] = [...sites, startMs, endMs]
  applyExclusions(w, b)
  // Pre-fix install-gap rows are unmeasured (lib/popupEvents.ts INSTALL_GAP_PATHS) — dropped
  // row-exactly so the Installs tile/timeline/release panel only count measurable installs.
  excludeInstallGapUnmeasured(w, b)
  return { sql: w.join(' AND '), binds: b }
}

// ── ET calendar-date arithmetic ─────────────────────────────────────────────────────────
/** `dateEt` shifted by `days` (negative = earlier). Pure calendar-string arithmetic (UTC
 * midnight math on the YYYY-MM-DD string), never a timezone conversion — see
 * lib/campaigns.ts's etMidnightUtcMs for the DST-safe ET<->UTC boundary conversion. */
export function addEtDays(dateEt: string, days: number): string {
  const d = new Date(dateEt + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ── "Today at a glance": today-so-far vs the SAME wall-clock time on a comparison day ────
/** Milliseconds elapsed since ET midnight of `nowMs`'s own ET calendar day. Still useful on
 * its own (e.g. for display), but NOT used to build a comparison-day window any more — see
 * sameTimeWindowMs below for why a raw millisecond duration is wrong across a DST
 * transition. */
export function etDayElapsedMs(nowMs: number): number {
  return nowMs - etMidnightUtcMs(etDateFromMs(nowMs))
}

// ET wall-clock hour/minute/second of a UTC instant — DST-safe (Intl does the offset math).
const ET_CLOCK_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
})
function etClockParts(ms: number): { h: number; m: number; s: number } {
  const parts = ET_CLOCK_FMT.formatToParts(new Date(ms))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return { h: get('hour') % 24, m: get('minute'), s: get('second') } // hour12:false can format midnight as "24"
}

/** [start, end) covering the SAME ET WALL-CLOCK time-of-day on a DIFFERENT ET date as
 * `nowMs` — e.g. "yesterday, up to the same clock time it is right now". DST-safe: derives
 * the end instant from `nowMs`'s own hour/minute/second (via Intl) re-applied to
 * `dateEt`'s OWN midnight, rather than adding a fixed millisecond duration to it.
 *
 * HIGH review finding, 2026-09-25: the previous implementation computed one elapsed
 * millisecond span from TODAY's midnight and reused it for every comparison day. That's only
 * correct when today and the comparison day share the same UTC offset — for six days after
 * every DST transition (the transition day is still inside "yesterday" or the 7-day
 * lookback), it lands an hour off (e.g. comparing 3pm today against what was actually 2pm or
 * 4pm on the transition day). This version reads the wall-clock hour/minute/second directly
 * and re-derives the comparison instant from the comparison date's own midnight, so it's
 * correct on both sides of a transition. */
export function sameTimeWindowMs(dateEt: string, nowMs: number): [number, number] {
  const { h, m, s } = etClockParts(nowMs)
  const start = etMidnightUtcMs(dateEt)
  const targetMsIntoDay = ((h * 60 + m) * 60 + s) * 1000
  for (const offsetHours of [5, 4]) {
    const candidate = Date.parse(`${dateEt}T00:00:00Z`) + offsetHours * 3_600_000 + targetMsIntoDay
    const c = etClockParts(candidate)
    if (etDateFromMs(candidate) === dateEt && c.h === h && c.m === m && c.s === s) return [start, candidate]
  }
  // The wall-clock instant doesn't exist on this date (spring-forward's skipped hour, e.g.
  // comparing against 2:30am on the day the clock jumps from 2:00 to 3:00) — fall back to
  // the pre-transition (EST) offset rather than throw; this only affects that one skipped
  // hour, one day a year.
  return [start, Date.parse(`${dateEt}T00:00:00Z`) + 5 * 3_600_000 + targetMsIntoDay]
}
/** The 7 ET calendar dates strictly before `todayEt` (most recent first), for the "7-day
 * average at the same time of day" comparison. */
export function last7DatesBefore(todayEt: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addEtDays(todayEt, -(i + 1)))
}

// ── Delta math (never NaN/Infinity — same discipline as popupEvents.ts computeRate) ─────
export interface Delta {
  delta: number // today - compare, a real number even when compare is 0
  deltaPct: number | null // null when compare is 0 (a percent change has no meaning there)
}
export function computeDelta(today: number, compare: number): Delta {
  return { delta: today - compare, deltaPct: compare === 0 ? null : (today - compare) / compare }
}

// ── KPI tile shape ───────────────────────────────────────────────────────────────────────
export interface KpiTile {
  key: string
  label: string
  today: number | null // null = notYetTracking
  vsYesterday: Delta | null
  vsAvg7: Delta | null
  notYetTracking: boolean
}
export function buildKpiTile(key: string, label: string, today: number, yesterday: number, avg7: number): KpiTile {
  return {
    key,
    label,
    today,
    vsYesterday: computeDelta(today, yesterday),
    vsAvg7: computeDelta(today, avg7),
    notYetTracking: false,
  }
}
export function notYetTrackingTile(key: string, label: string): KpiTile {
  return { key, label, today: null, vsYesterday: null, vsAvg7: null, notYetTracking: true }
}

// ── Which campaigns are actually flighting on a given ET date (dynamic — never a stale
// hand-set `status` field going out of date) ────────────────────────────────────────────
export function campaignsFlightingOn(etDate: string): CampaignFlight[] {
  return CAMPAIGNS.filter((c) => flightDayIndex(c, etDate) !== null)
}

// ── Return beacon instrumentation (site-wide, not per-campaign — see
// lib/campaigns.ts returnBeaconNotInstrumented for the per-campaign version) ─────────────
export function returnBeaconLiveToday(): boolean {
  return TRACKING_ACTIVATION_DATE_ET !== null
}

// ── Release panel: N-day window after vs before a release date, N capped by how much
// history actually exists on either side ────────────────────────────────────────────────
/** Both windows are [start, end) ms ranges of equal length — `days` capped to whatever's
 * actually available before the release (so an early release doesn't request a "before"
 * window reaching past the start of history) and after it (so a very recent release
 * doesn't request an "after" window reaching into the future). `nowMs`/`firstHitMs` bound
 * the after/before windows respectively. */
export function releaseComparisonWindows(
  releaseDateEt: string,
  firstHitEtDate: string,
  nowMs: number,
): { before: [number, number]; after: [number, number]; days: number } | null {
  const releaseMs = etMidnightUtcMs(releaseDateEt)
  const firstHitMs = etMidnightUtcMs(firstHitEtDate)
  const daysAvailableBefore = Math.max(0, Math.floor((releaseMs - firstHitMs) / 86_400_000))
  const daysAvailableAfter = Math.max(0, Math.floor((nowMs - releaseMs) / 86_400_000))
  const days = Math.min(daysAvailableBefore, daysAvailableAfter)
  if (days <= 0) return null
  return {
    before: [releaseMs - days * 86_400_000, releaseMs],
    after: [releaseMs, releaseMs + days * 86_400_000],
    days,
  }
}
