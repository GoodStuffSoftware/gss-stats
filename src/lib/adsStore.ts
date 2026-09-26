// The ads-read store: gss-stats' OWN D1 database `gss-stats-ads` (binding `gss_stats_ads`),
// schema in migrations/gss-stats-ads/, decision in docs/adr/0001-ads-read-store.md.
//
// One module for every SQL statement that touches it, shared by both sides:
//  - the routine (scripts/ads-reads/d1Store.ts) runs the WRITE builders and the readers
//    through `wrangler d1 execute gss-stats-ads --remote`;
//  - the dashboard's Pages Functions run the readers through the binding, FAIL SOFT: a
//    missing binding, a missing table (a fresh local `wrangler pages dev`) or any D1 error
//    reads as "no stored data", so /api/campaigns falls back to lib/campaigns.ts
//    CAMPAIGN_SPEND and the readings panel shows an empty state instead of an error.
//
// Money is integer micros. No statement here is a compound SELECT (D1 caps those at 5 terms),
// and nothing here ever reads or writes the beacon's gss-geo database.

import type { CampaignFlight } from './campaigns'
import { microsToDollars, round2, stripLocalPaths, type ReadingKind, type ReadingRecord, type ResolvedSpend, type SpendDay, type SpendSummary, type StoredSpend } from './adsRules'
import { etDateFromMs } from './popupEvents'

export const ADS_DB_NAME = 'gss-stats-ads'
export const ADS_DB_BINDING = 'gss_stats_ads'
/** Stamped on every ads_readings row. Bump when the read/rule logic changes meaning. */
export const ROUTINE_VERSION = 'ads-reads/1.0.0'

export interface SqlStatement {
  sql: string
  binds: unknown[]
}

const dollarsToMicros = (usd: number | null | undefined): number | null => (usd == null ? null : Math.round(usd * 1_000_000))
const chunk = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

// ── Writes (the routine only) ─────────────────────────────────────────────────────────────
/** Upserts every configured campaign — lib/campaigns.ts stays the source of truth; the table
 * is a synced copy so stored rows can reference it (FOREIGN KEY) and outlive config edits. */
export function campaignSyncStatement(campaigns: readonly CampaignFlight[], syncedAt: string): SqlStatement {
  const cols = ['id', 'name', 'uc_values', 'kind', 'flight_start', 'flight_start_time_et', 'flight_end', 'status', 'daily_budget_micros', 'hard_cap_micros', 'measurement', 'synced_at']
  const binds: unknown[] = []
  for (const c of campaigns) {
    binds.push(
      c.id,
      c.label,
      JSON.stringify(c.ucValues),
      c.kind,
      c.flightStart,
      c.flightStartTimeEt ?? null,
      c.flightEnd,
      c.status,
      dollarsToMicros(c.dailyBudgetUsd),
      dollarsToMicros(c.hardCapUsd),
      c.measurement === 'spend-only' ? 'spend-only' : 'beacon',
      syncedAt,
    )
  }
  const row = `(${cols.map(() => '?').join(', ')})`
  const update = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')
  return {
    sql: `INSERT INTO ads_campaigns (${cols.join(', ')}) VALUES ${campaigns.map(() => row).join(', ')} ON CONFLICT (id) DO UPDATE SET ${update}`,
    binds,
  }
}

/** Upsert-idempotent daily metrics, in chunks (each statement well under D1's 100 KB). */
export function dailyMetricsUpserts(campaignId: string, days: Record<string, SpendDay>, fetchedAt: string): SqlStatement[] {
  const entries = Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1))
  return chunk(entries, 50).map((part) => ({
    sql:
      `INSERT INTO ads_daily_metrics (campaign_id, date, cost_micros, impressions, clicks, source, fetched_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')} ` +
      `ON CONFLICT (campaign_id, date) DO UPDATE SET cost_micros = excluded.cost_micros, impressions = excluded.impressions, clicks = excluded.clicks, source = excluded.source, fetched_at = excluded.fetched_at`,
    binds: part.flatMap(([date, d]) => [campaignId, date, Math.round(d.costMicros), d.impressions, d.clicks, 'google-ads-api', fetchedAt]),
  }))
}

export interface PlacementDayRow {
  date: string
  placement: string
  displayName: string | null
  type: string | null
  targetUrl: string | null
  approved: boolean | null
  costMicros: number
  impressions: number
  clicks: number
}
/** group_placement_view can return one row per ad group for the same (date, placement); an
 * upsert of both would keep only the last (review L5). Sums them first — cost, impressions and
 * clicks — keeping the first row's labels; approved is true if either row says so. */
export function mergePlacementDayRows(rows: readonly PlacementDayRow[]): PlacementDayRow[] {
  const byKey = new Map<string, PlacementDayRow>()
  for (const r of rows) {
    if (!r.placement || !r.date) continue
    const k = `${r.date}\u0000${r.placement}`
    const prev = byKey.get(k)
    if (!prev) {
      byKey.set(k, { ...r })
      continue
    }
    prev.costMicros += r.costMicros
    prev.impressions += r.impressions
    prev.clicks += r.clicks
    prev.approved = prev.approved === true || r.approved === true ? true : prev.approved ?? r.approved
  }
  return [...byKey.values()]
}

export function placementDailyUpserts(campaignId: string, rows: readonly PlacementDayRow[], fetchedAt: string): SqlStatement[] {
  const usable = mergePlacementDayRows(rows)
  return chunk(usable, 40).map((part) => ({
    sql:
      `INSERT INTO ads_placement_daily (campaign_id, date, placement, display_name, placement_type, target_url, approved, cost_micros, impressions, clicks, fetched_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')} ` +
      `ON CONFLICT (campaign_id, date, placement) DO UPDATE SET display_name = excluded.display_name, placement_type = excluded.placement_type, target_url = excluded.target_url, approved = excluded.approved, cost_micros = excluded.cost_micros, impressions = excluded.impressions, clicks = excluded.clicks, fetched_at = excluded.fetched_at`,
    binds: part.flatMap((r) => [
      campaignId,
      r.date,
      r.placement,
      r.displayName,
      r.type,
      r.targetUrl,
      r.approved == null ? null : r.approved ? 1 : 0,
      Math.round(r.costMicros),
      r.impressions,
      r.clicks,
      fetchedAt,
    ]),
  }))
}

/** One append (the table is append-only by trigger); a retry of the same key is a no-op. */
export function readingInsert(rec: ReadingRecord, routineVersion: string = ROUTINE_VERSION): SqlStatement {
  return {
    sql:
      'INSERT INTO ads_readings (reading_key, campaign_id, kind, stage, read_at, et_date, spend_through_et, cumulative_spend_micros, thresholds, complete, rules, proposal, decision, counts, notes, routine_version) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (reading_key) DO NOTHING',
    binds: [
      rec.id,
      rec.campaignId,
      rec.kind,
      rec.stage ?? null,
      rec.readAt,
      rec.etDate,
      rec.spendThroughEt,
      dollarsToMicros(rec.cumulativeSpend),
      JSON.stringify(rec.thresholds),
      rec.complete ? 1 : 0,
      rec.rules == null ? null : JSON.stringify(rec.rules),
      rec.proposal === 'PROPOSE PAUSE' || rec.proposal === 'CONTINUE' ? rec.proposal : null,
      rec.decision == null ? null : JSON.stringify(rec.decision),
      JSON.stringify(rec.counts),
      JSON.stringify(rec.notes.map(stripLocalPaths)), // no local paths in stored notes (review L10)
      routineVersion,
    ],
  }
}

/** Marks thresholds fired — only for a COMPLETE threshold read, pointing at its reading row.
 * The primary key (campaign_id, threshold_usd) makes a second firing impossible. */
export function thresholdStateInsert(rec: ReadingRecord): SqlStatement | null {
  if (rec.kind !== 'threshold' || !rec.complete || !rec.thresholds.length) return null
  return {
    sql:
      `INSERT INTO ads_threshold_state (campaign_id, threshold_usd, fired_at, reading_id) VALUES ${rec.thresholds
        .map(() => '(?, ?, ?, (SELECT id FROM ads_readings WHERE reading_key = ?))')
        .join(', ')} ON CONFLICT (campaign_id, threshold_usd) DO NOTHING`,
    binds: rec.thresholds.flatMap((t) => [rec.campaignId, Math.round(t), rec.readAt, rec.id]),
  }
}

// ── Reads (routine and dashboard) ─────────────────────────────────────────────────────────
export const SPEND_SUMMARY_SQL =
  'SELECT campaign_id, SUM(cost_micros) AS cost_micros, SUM(impressions) AS impressions, SUM(clicks) AS clicks, COUNT(*) AS days, MIN(date) AS first_date, MAX(date) AS last_date, MAX(fetched_at) AS fetched_at FROM ads_daily_metrics GROUP BY campaign_id'
export const DAILY_ROWS_SQL = 'SELECT date, cost_micros, impressions, clicks, fetched_at FROM ads_daily_metrics WHERE campaign_id = ? ORDER BY date'
export const THRESHOLD_STATE_SQL = 'SELECT threshold_usd, fired_at FROM ads_threshold_state WHERE campaign_id = ? ORDER BY threshold_usd'
export const READINGS_SQL =
  'SELECT reading_key, campaign_id, kind, stage, read_at, et_date, spend_through_et, cumulative_spend_micros, thresholds, complete, rules, proposal, decision, counts, notes, routine_version FROM ads_readings WHERE campaign_id = ? ORDER BY read_at DESC, id DESC LIMIT ?'

const num = (x: unknown): number => (typeof x === 'number' ? x : Number(x) || 0)
const str = (x: unknown): string | null => (x == null ? null : String(x))

export function mapSpendSummary(row: Record<string, unknown>): SpendSummary {
  return {
    campaignId: String(row.campaign_id ?? ''),
    costMicros: num(row.cost_micros),
    impressions: num(row.impressions),
    clicks: num(row.clicks),
    days: num(row.days),
    firstDate: str(row.first_date),
    lastDate: str(row.last_date),
    fetchedAt: str(row.fetched_at),
  }
}

/** Stored daily rows as the routine's in-memory StoredSpend. A day counts as "closed at
 * fetch" when its ET date is before the ET date it was fetched on — closedThroughEt is the
 * latest such day, so restatement detection only ever compares closed days. */
export function rowsToStoredSpend(campaignId: string, rows: readonly Record<string, unknown>[]): StoredSpend | null {
  if (!rows.length) return null
  const days: Record<string, SpendDay> = {}
  let closedThroughEt: string | null = null
  let fetchedAt = ''
  for (const r of rows) {
    const date = String(r.date)
    days[date] = { costMicros: num(r.cost_micros), impressions: num(r.impressions), clicks: num(r.clicks) }
    const f = String(r.fetched_at ?? '')
    if (f > fetchedAt) fetchedAt = f
    const fetchedEt = f ? etDateFromMs(Date.parse(f)) : null
    if (fetchedEt && date < fetchedEt && (closedThroughEt == null || date > closedThroughEt)) closedThroughEt = date
  }
  return { v: 1, campaignId, source: 'google-ads-api', apiVersion: '', customerId: '', fetchedAt, closedThroughEt, days }
}

function parseJson<T>(x: unknown, fallback: T): T {
  if (typeof x !== 'string') return fallback
  try {
    return JSON.parse(x) as T
  } catch {
    return fallback
  }
}
const KINDS: readonly ReadingKind[] = ['daily', 'threshold', 'postflight', 'health']

export function mapReadingRow(row: Record<string, unknown>): ReadingRecord | null {
  const kind = String(row.kind ?? '') as ReadingKind
  if (!KINDS.includes(kind) || typeof row.read_at !== 'string') return null
  const micros = row.cumulative_spend_micros
  return {
    v: 1,
    id: String(row.reading_key ?? ''),
    campaignId: String(row.campaign_id ?? ''),
    kind,
    ...(row.stage != null ? { stage: String(row.stage) } : {}),
    readAt: row.read_at,
    etDate: String(row.et_date ?? ''),
    spendThroughEt: str(row.spend_through_et),
    cumulativeSpend: micros == null ? null : round2(microsToDollars(num(micros))),
    thresholds: parseJson<number[]>(row.thresholds, []),
    complete: num(row.complete) === 1,
    rules: parseJson(row.rules, null),
    proposal: str(row.proposal),
    decision: parseJson(row.decision, null),
    counts: parseJson<Record<string, number | null>>(row.counts, {}),
    notes: parseJson<string[]>(row.notes, []),
  }
}

// ── GET /api/ads/readings — shape shared by the Function and AdsReadingsWidgetCard.vue ────
export interface AdsReadingsCampaign {
  campaignId: string
  label: string
  status: string
  spend: ResolvedSpend
  thresholdsFired: { threshold: number; firedAt: string }[] | null
  /** Newest first. Anonymous aggregates only (counts, rule results, proposals). */
  readings: ReadingRecord[]
}
export interface AdsReadingsResponse {
  /** false when the gss_stats_ads binding is absent (e.g. plain `vite` dev). */
  storeBound: boolean
  /** false when bound but unreadable (e.g. local D1 without the migration applied). */
  storeReadable: boolean
  campaigns: AdsReadingsCampaign[]
  generatedAt: string
}

/** `?campaignId=a&campaignId=b` and/or `?campaignIds=a,b`; unknown ids are dropped; none (or
 * none known) means every campaign — the widget's "empty = all campaigns" rule. */
export function parseCampaignIdsParam(params: URLSearchParams, known: readonly string[]): string[] {
  const asked = [...params.getAll('campaignId'), ...params.getAll('campaignIds').flatMap((v) => v.split(','))].map((s) => s.trim()).filter(Boolean)
  const valid = [...new Set(asked)].filter((id) => known.includes(id))
  return valid.length ? valid : [...known]
}

// ── Dashboard readers (Pages Functions binding) — fail soft ───────────────────────────────
/** The only D1 surface these readers use (D1Database satisfies it; tests pass a stub). */
export interface D1Reader {
  prepare(sql: string): { bind(...values: unknown[]): { all(): Promise<{ results?: unknown[] }> } }
}

async function allRows(db: D1Reader, sql: string, binds: unknown[]): Promise<Record<string, unknown>[]> {
  const res = await db.prepare(sql).bind(...binds).all()
  return (res.results ?? []) as Record<string, unknown>[]
}

/** Every campaign's stored totals, keyed by id — null when the store is absent or unreadable. */
export async function readSpendSummaries(db: D1Reader | undefined | null): Promise<Map<string, SpendSummary> | null> {
  if (!db) return null
  try {
    const rows = await allRows(db, SPEND_SUMMARY_SQL, [])
    return new Map(rows.map((r) => mapSpendSummary(r)).map((s) => [s.campaignId, s]))
  } catch {
    return null
  }
}

export async function readReadings(db: D1Reader | undefined | null, campaignId: string, limit = 100): Promise<ReadingRecord[] | null> {
  if (!db) return null
  try {
    const rows = await allRows(db, READINGS_SQL, [campaignId, Math.max(1, Math.min(500, Math.floor(limit)))])
    return rows.map(mapReadingRow).filter((r): r is ReadingRecord => r !== null)
  } catch {
    return null
  }
}

export async function readThresholdState(db: D1Reader | undefined | null, campaignId: string): Promise<{ threshold: number; firedAt: string }[] | null> {
  if (!db) return null
  try {
    const rows = await allRows(db, THRESHOLD_STATE_SQL, [campaignId])
    return rows.map((r) => ({ threshold: num(r.threshold_usd), firedAt: String(r.fired_at ?? '') }))
  } catch {
    return null
  }
}
