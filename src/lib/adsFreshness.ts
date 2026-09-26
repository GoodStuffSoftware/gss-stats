// Ads data freshness — pure helpers shared by the sync (lib/adsSync.ts), the dashboard's
// Pages Functions (/api/campaigns, /api/ads/readings) and the ads widgets. No I/O here.
//
//   spendThrough  the last ET day stored as CLOSED, contiguously from the flight's first day
//                 (a day counts as closed when it was fetched on a later ET day — Google keeps
//                 adding to an open day);
//   lastSync      the finish time of the latest sync run that synced the campaign
//                 (ads_sync_runs.campaigns_ok);
//   stale         a flight day that should be stored by now is not: yesterday once it is
//                 09:30 ET (the 08:00 ET morning read has synced by then), else the day before.

import type { CampaignFlight } from './campaigns'
import { etTimeUtcMs } from './campaigns'
import { addEtDays } from './overview'
import { etDateFromMs } from './popupEvents'

export { addEtDays }

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

/** True when a row for `date` was fetched after that ET day had ended. */
export function isClosedFetch(date: string, fetchedAt: string | null | undefined): boolean {
  if (!fetchedAt) return false
  const ms = Date.parse(fetchedAt)
  return Number.isFinite(ms) && etDateFromMs(ms) > date
}

/** Every ET date from `since` to `until` inclusive (empty when since > until). */
export function etDateRange(since: string, until: string): string[] {
  const out: string[] = []
  for (let d = since; d <= until; d = addEtDays(d, 1)) out.push(d)
  return out
}

/** The last day of the contiguous run of closed days starting at `flightStart`. */
export function contiguousThrough(flightStart: string | null, closedDates: ReadonlySet<string>): string | null {
  if (!flightStart) return null
  let last: string | null = null
  for (let d = flightStart; closedDates.has(d); d = addEtDays(d, 1)) last = d
  return last
}

/** spendThrough from stored (date, fetched_at) rows of one campaign. */
export function spendThroughFromRows(flightStart: string | null, rows: readonly { date: string; fetchedAt: string | null }[]): string | null {
  return contiguousThrough(flightStart, new Set(rows.filter((r) => isClosedFetch(r.date, r.fetchedAt)).map((r) => r.date)))
}

/** The latest flight day that should be stored at `nowMs` (null when none yet). */
export function expectedThrough(c: Pick<CampaignFlight, 'flightStart' | 'flightEnd'>, nowMs: number): string | null {
  if (!c.flightStart) return null
  const todayEt = etDateFromMs(nowMs)
  const due = nowMs >= etTimeUtcMs(todayEt, STALE_AFTER_ET) ? addEtDays(todayEt, -1) : addEtDays(todayEt, -2)
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

const SHORT_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })
/** "Spend through Sep 27 · synced 2h ago" (the widgets' freshness line). */
export function freshnessLine(f: Pick<AdsFreshness, 'spendThrough' | 'lastSync'>, nowMs: number): string {
  const through = f.spendThrough ? `Spend through ${SHORT_DATE.format(new Date(`${f.spendThrough}T00:00:00Z`))}` : 'No closed spend day stored yet'
  return `${through} · ${f.lastSync ? `synced ${relativeTime(f.lastSync, nowMs)}` : 'not synced yet'}`
}
