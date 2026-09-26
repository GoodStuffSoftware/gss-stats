// Ads data freshness — pure helpers shared by the sync (lib/adsSync.ts), the dashboard's
// Pages Functions (/api/campaigns, /api/ads/readings) and the ads widgets. No I/O here, and
// only the fast ET arithmetic of lib/etTime.ts (the sync runs on a tight CPU budget).
//
//   spendThrough  the last ET day stored as CLOSED, contiguously from the flight's first day,
//                 and never past the flight end (a day counts as closed when it was fetched at
//                 or after 03:00 ET the next day — Google keeps adding to a day for a while);
//   lastSync      the finish time of the latest sync run that synced the campaign
//                 (ads_sync_runs.campaigns_ok);
//   stale         a flight day that should be stored by now is not: yesterday once it is
//                 09:30 ET (the 08:00 ET morning read has synced by then), else the day before.

import type { CampaignFlight } from './campaigns'
import { addDays, etDateFast, etWallTimeMs } from './etTime'

/** An ET date plus `days` (same result as lib/overview.ts addEtDays). */
export const addEtDays = addDays

/** When yesterday's data is expected to be stored (ET wall clock). */
export const STALE_AFTER_ET = '09:30'
/** Dashboard wording (kept here until a notes registry exists on main). */
export const STALE_NOTE = 'stale — sync pending'

export interface AdsFreshness {
  /** Last closed ET day stored contiguously from the flight start; null = none yet. */
  spendThrough: string | null
  /** ISO time of the latest sync run that synced this campaign; null = never. */
  lastSync: string | null
  stale: boolean
}

/** A day counts as closed only when it was fetched this long after the next ET midnight:
 * Google keeps adding late clicks and cost to a day for a while after it ends, so a pull at
 * 00:05 ET must not be taken as the day's final number (review M1, 2026-09-26). */
export const CLOSED_AFTER_ET = '03:00'
/** True when a row for `date` was fetched at or after 03:00 ET on a later ET day. */
export function isClosedFetch(date: string, fetchedAt: string | null | undefined): boolean {
  if (!fetchedAt) return false
  const ms = Date.parse(fetchedAt)
  return Number.isFinite(ms) && ms >= etWallTimeMs(addDays(date, 1), CLOSED_AFTER_ET)
}

/** Every ET date from `since` to `until` inclusive (empty when since > until). */
export function etDateRange(since: string, until: string): string[] {
  const out: string[] = []
  for (let d = since; d <= until; d = addDays(d, 1)) out.push(d)
  return out
}

/** The last day of the contiguous run of closed days starting at `flightStart`, capped at
 * `flightEnd` when given (days after the flight are not part of its coverage). */
export function contiguousThrough(flightStart: string | null, closedDates: ReadonlySet<string>, flightEnd?: string | null): string | null {
  if (!flightStart) return null
  let last: string | null = null
  for (let d = flightStart; closedDates.has(d) && (!flightEnd || d <= flightEnd); d = addDays(d, 1)) last = d
  return last
}

/** spendThrough from stored (date, fetched_at) rows of one campaign. */
export function spendThroughFromRows(flightStart: string | null, rows: readonly { date: string; fetchedAt: string | null }[], flightEnd?: string | null): string | null {
  return contiguousThrough(flightStart, new Set(rows.filter((r) => isClosedFetch(r.date, r.fetchedAt)).map((r) => r.date)), flightEnd)
}

/** The latest flight day that should be stored at `nowMs` (null when none yet). */
export function expectedThrough(c: Pick<CampaignFlight, 'flightStart' | 'flightEnd'>, nowMs: number): string | null {
  if (!c.flightStart) return null
  const todayEt = etDateFast(nowMs)
  const due = nowMs >= etWallTimeMs(todayEt, STALE_AFTER_ET) ? addDays(todayEt, -1) : addDays(todayEt, -2)
  const last = due < c.flightEnd ? due : c.flightEnd
  return last >= c.flightStart ? last : null
}

export function freshnessOf(c: Pick<CampaignFlight, 'flightStart' | 'flightEnd'>, spendThrough: string | null, lastSync: string | null, nowMs: number): AdsFreshness {
  const expected = expectedThrough(c, nowMs)
  return { spendThrough, lastSync, stale: expected != null && (spendThrough == null || spendThrough < expected) }
}

/** "just now", "12m ago", "3h ago", "2d ago" — for "synced …". */
export function relativeTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return 'never'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return 'never'
  const s = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "Spend through Sep 27 · synced 2h ago" (the widgets' freshness line). */
export function freshnessLine(f: Pick<AdsFreshness, 'spendThrough' | 'lastSync'>, nowMs: number): string {
  const through = f.spendThrough ? `Spend through ${MONTHS[Number(f.spendThrough.slice(5, 7)) - 1]} ${Number(f.spendThrough.slice(8, 10))}` : 'No closed spend day stored yet'
  return `${through} · ${f.lastSync ? `synced ${relativeTime(f.lastSync, nowMs)}` : 'not synced yet'}`
}
