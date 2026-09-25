// "Best Sudoku overview" page (Part C) — pure logic shared by functions/api/overview.ts and
// components/OverviewPage.vue. Aggregate-only, no joins — same rules as lib/campaigns.ts and
// lib/popupEvents.ts, which this module builds on rather than duplicates.

import { etDateFromMs, TRACKING_ACTIVATION_DATE_ET } from './popupEvents'
import { etMidnightUtcMs, CAMPAIGNS, flightDayIndex, type CampaignFlight } from './campaigns'

// ── ET calendar-date arithmetic ─────────────────────────────────────────────────────────
/** `dateEt` shifted by `days` (negative = earlier). Pure calendar-string arithmetic (UTC
 * midnight math on the YYYY-MM-DD string), never a timezone conversion — see
 * lib/campaigns.ts's etMidnightUtcMs for the DST-safe ET<->UTC boundary conversion. */
export function addEtDays(dateEt: string, days: number): string {
  const d = new Date(dateEt + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ── "Today at a glance": today-so-far vs the SAME elapsed time on a comparison day ──────
/** Milliseconds elapsed since ET midnight of `nowMs`'s own ET calendar day. */
export function etDayElapsedMs(nowMs: number): number {
  return nowMs - etMidnightUtcMs(etDateFromMs(nowMs))
}
/** [start, end) covering the same elapsed-time-of-day window on a DIFFERENT ET date —
 * e.g. "yesterday, up to the same clock time it is right now". */
export function sameTimeWindowMs(dateEt: string, elapsedMs: number): [number, number] {
  const start = etMidnightUtcMs(dateEt)
  return [start, start + elapsedMs]
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
