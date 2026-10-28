// The ads-read store: gss-stats' OWN D1 database `gss-stats-ads` (binding `gss_stats_ads`),
// schema in migrations/gss-stats-ads/, decision in docs/adr/0001-ads-read-store.md.
//
// One module for every SQL statement that touches it, shared by every side:
//  - the local routine (scripts/ads-reads/) runs them through `wrangler d1 execute
//    gss-stats-ads --remote` (scripts/ads-reads/d1Store.ts wranglerAdsDb);
//  - the gss-stats-sync Worker (workers/sync/) runs them through its D1 binding
//    (d1BindingAdsDb below) — the same createSqlAdsStore on a different AdsDb adapter;
//  - the dashboard's Pages Functions run the readers through the binding, FAIL SOFT: a
//    missing binding, a missing table (a fresh local `wrangler pages dev`) or any D1 error
//    reads as "no stored data", so the campaign spend metric falls back to lib/campaigns.ts
//    CAMPAIGN_SPEND and the readings panel shows an empty state instead of an error.
//
// Money is integer micros. No statement here is a compound SELECT (D1 caps those at 5 terms),
// none binds more than 100 parameters (D1's per-statement cap), and nothing here ever reads or
// writes the beacon's gss-geo database.

import type { CampaignFlight } from './campaigns'
import { etDateFast } from './etTime'
import { CAMPAIGNS, campaignStatusOn, STAGED_ARMS, type StagedArm } from './campaigns'
import {
  microsToDollars,
  readingEntryKind,
  round2,
  stripLocalPaths,
  type ReadingF3,
  type ReadingKind,
  type ReadingRecord,
  type ResolvedSpend,
  type SpendDay,
  type SpendSummary,
  type StoredSpend,
} from './adsRules'
import type { ReadoutVerdict } from './flight3Rules'
import { FIRST_FINISH_START_ET } from './releases'
import { freshnessOf, isClosedFetch, spendThroughFromRows, unfinishedSyncAlert, UNFINISHED_SYNC_AFTER_MS, UNFINISHED_SYNC_LOOKBACK_MS, type AdsFreshness, type SyncAlert } from './adsFreshness'

export const ADS_DB_NAME = 'gss-stats-ads'
export const ADS_DB_BINDING = 'gss_stats_ads'
/** Stamped on every ads_readings row. Bump when the read/rule logic changes meaning.
 * 1.1.0: spend comes from the shared sync (closed days only); same-day reruns are de-duped. */
export const ROUTINE_VERSION = 'ads-reads/1.1.0'
/** D1 caps a statement at 100 bound parameters; every builder chunks under it. */
export const MAX_BINDS = 100

export interface SqlStatement {
  sql: string
  binds: unknown[]
}

const dollarsToMicros = (usd: number | null | undefined): number | null => (usd == null ? null : Math.round(usd * 1_000_000))
const chunk = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))
const rowsPerStatement = (bindsPerRow: number) => Math.max(1, Math.floor(MAX_BINDS / bindsPerRow))
/** Rows per upsert statement for conversions, daily asset rows and the asset catalog (7, 11 and 6
 * binds a row): lib/adsSync.ts plans an extras run's D1 statements with them before it fetches. */
export const CONVERSION_ROWS_PER_STATEMENT = rowsPerStatement(7)
export const ASSET_ROWS_PER_STATEMENT = rowsPerStatement(11)
export const ASSET_CATALOG_ROWS_PER_STATEMENT = rowsPerStatement(6)

// ── Write guard (every adapter) ───────────────────────────────────────────────────────────
/** SQL with every quoted literal blanked, so keyword checks never trip on a campaign tag. */
export function stripSqlLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""')
}

const FORBIDDEN_IN_WRITES = /\b(DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|TRUNCATE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|REPLACE)\b/i

/** Writes are single INSERT statements into ads_* tables (upserts use ON CONFLICT ... DO
 * UPDATE / DO NOTHING); no DELETE, DROP, ALTER, bare UPDATE, PRAGMA or comment. Enforced by
 * createSqlAdsStore before any adapter sees the statement. */
export function assertAdsWriteSql(sql: string): void {
  const bare = stripSqlLiterals(sql).trim()
  const m = /^INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(bare)
  if (!m) throw new Error('ads store writes must be INSERT INTO <table>')
  if (!/^ads_[a-z_]+$/.test(m[1])) throw new Error(`ads store writes only ads_* tables, not ${m[1]}`)
  if (bare.includes(';')) throw new Error('ads store writes must be a single statement')
  if (/--|\/\*/.test(bare)) throw new Error('ads store writes must not contain SQL comments')
  const f = FORBIDDEN_IN_WRITES.exec(bare)
  if (f) throw new Error(`ads store writes must not contain ${f[1].toUpperCase()}`)
  // UPDATE only as the upsert clause "ON CONFLICT ... DO UPDATE SET".
  if (/\bUPDATE\b/i.test(bare.replace(/\bDO\s+UPDATE\s+SET\b/gi, ''))) throw new Error('ads store writes must not contain a bare UPDATE')
}

/** Store reads are single SELECTs. */
export function assertAdsReadSql(sql: string): void {
  const bare = stripSqlLiterals(sql).trim()
  if (!/^SELECT\b/i.test(bare)) throw new Error('ads store reads must be a SELECT')
  if (bare.includes(';') || /--|\/\*/.test(bare)) throw new Error('ads store reads must be a single statement without comments')
  if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA)\b/i.test(bare)) throw new Error('ads store reads must not write')
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────
const CAMPAIGN_COLS = ['id', 'name', 'uc_values', 'kind', 'flight_start', 'flight_start_time_et', 'flight_end', 'status', 'daily_budget_micros', 'hard_cap_micros', 'measurement', 'synced_at']

/** Upserts the configured campaigns — lib/campaigns.ts stays the source of truth; the table is
 * a synced copy so stored rows can reference it (FOREIGN KEY) and outlive config edits. The
 * update fires only when a definition actually changed, so an unchanged config is a no-op
 * (synced_at then records the last real change). */
export function campaignSyncStatements(campaigns: readonly CampaignFlight[], syncedAt: string): SqlStatement[] {
  const row = `(${CAMPAIGN_COLS.map(() => '?').join(', ')})`
  const data = CAMPAIGN_COLS.filter((c) => c !== 'id' && c !== 'synced_at')
  const update = CAMPAIGN_COLS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')
  const changed = data.map((c) => `ads_campaigns.${c} IS NOT excluded.${c}`).join(' OR ')
  return chunk(campaigns, rowsPerStatement(CAMPAIGN_COLS.length)).map((part) => ({
    sql: `INSERT INTO ads_campaigns (${CAMPAIGN_COLS.join(', ')}) VALUES ${part.map(() => row).join(', ')} ON CONFLICT (id) DO UPDATE SET ${update} WHERE ${changed}`,
    binds: part.flatMap((c) => [
      c.id,
      c.label,
      JSON.stringify(c.ucValues),
      c.kind,
      c.flightStart,
      c.flightStartTimeEt ?? null,
      c.flightEnd,
      campaignStatusOn(c, etDateFast(Date.parse(syncedAt))), // derived from the flight dates on the sync's own ET day
      dollarsToMicros(c.dailyBudgetUsd),
      dollarsToMicros(c.hardCapUsd),
      c.measurement === 'spend-only' ? 'spend-only' : 'beacon',
      syncedAt,
    ]),
  }))
}

/** One stored day of campaign metrics (ads_daily_metrics). */
export interface StoredDayRow {
  date: string
  costMicros: number
  impressions: number
  clicks: number
  /** When these metrics were last written; the day is CLOSED when this is a later ET day. */
  fetchedAt: string
  /** When the placement pull covering this day last succeeded (null = still to pull). */
  placementsFetchedAt: string | null
}

/** Upserts exactly the given day rows (the sync decides which rows changed). */
export function dailyRowUpserts(campaignId: string, rows: readonly StoredDayRow[]): SqlStatement[] {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : 1))
  return chunk(sorted, rowsPerStatement(8)).map((part) => ({
    sql:
      `INSERT INTO ads_daily_metrics (campaign_id, date, cost_micros, impressions, clicks, source, fetched_at, placements_fetched_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')} ` +
      `ON CONFLICT (campaign_id, date) DO UPDATE SET cost_micros = excluded.cost_micros, impressions = excluded.impressions, clicks = excluded.clicks, source = excluded.source, fetched_at = excluded.fetched_at, placements_fetched_at = excluded.placements_fetched_at`,
    binds: part.flatMap((d) => [campaignId, d.date, Math.round(d.costMicros), d.impressions, d.clicks, 'google-ads-api', d.fetchedAt, d.placementsFetchedAt ?? null]),
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
  return chunk(usable, rowsPerStatement(11)).map((part) => ({
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

// ── Conversions and per-asset results per ET day (migration 0007) ─────────────────────────
// Counts only: Google's aggregates per campaign, day, conversion action or asset. A conversion
// action is kept as its trailing numeric id (lib/adsApi.ts conversionActionIdOf), never as its
// resource name, which carries the account's customer id.

/** One campaign's conversions for one ET day and one conversion action (ads_daily_conversions). */
export interface ConversionDayRow {
  date: string
  /** Digits only: the trailing id of the action's resource name. */
  conversionActionId: string
  conversionActionName: string | null
  conversions: number
  allConversions: number
}
/** One asset's delivery for one ET day in one ad (ads_daily_assets). assetType, text and name
 * describe the asset itself and feed the ads_assets catalog (assetCatalogFrom). */
export interface AssetDayRow {
  date: string
  adGroupId: string
  adId: string
  assetId: string
  fieldType: string
  impressions: number
  clicks: number
  conversions: number
  performanceLabel: string | null
  assetType: string | null
  text: string | null
  name: string | null
}
/** One ads_assets row: what an asset is, and the first and last ET day it had a daily row. */
export interface AssetRecord {
  assetId: string
  type: string
  text: string | null
  name: string | null
  firstSeen: string
  lastSeen: string
}

const ADS_DATE = /^\d{4}-\d{2}-\d{2}$/
const ADS_ID = /^\d{1,20}$/
const ADS_ENUM = /^[A-Z0-9_]{1,40}$/
/** The column caps migration 0007 checks (a longer value is clipped, so no row trips a CHECK). */
export const CONVERSION_ACTION_NAME_MAX = 200
export const ASSET_TEXT_MAX = 2000
export const ASSET_NAME_MAX = 500
/** A count the 0007 CHECKs accept: finite, >= 0, at most 1e12. */
const okCount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e12
/** Trimmed and clipped to `max`; null when empty or not a string. */
export const clipText = (s: unknown, max: number): string | null => {
  if (typeof s !== 'string') return null
  const t = s.trim()
  return t ? t.slice(0, max) : null
}
const enumOrNull = (s: unknown): string | null => (typeof s === 'string' && ADS_ENUM.test(s) ? s : null)

/** Usable conversion rows, one per (date, action): a malformed row is dropped, and two rows for
 * the same key are summed (the first non-null name is kept). Sorted by date, then action id. */
export function mergeConversionRows(rows: readonly ConversionDayRow[]): ConversionDayRow[] {
  const byKey = new Map<string, ConversionDayRow>()
  for (const r of rows) {
    if (!ADS_DATE.test(r.date) || !ADS_ID.test(r.conversionActionId) || !okCount(r.conversions) || !okCount(r.allConversions)) continue
    const k = `${r.date}\u0000${r.conversionActionId}`
    const prev = byKey.get(k)
    const name = clipText(r.conversionActionName, CONVERSION_ACTION_NAME_MAX)
    if (!prev) {
      byKey.set(k, { date: r.date, conversionActionId: r.conversionActionId, conversionActionName: name, conversions: r.conversions, allConversions: r.allConversions })
      continue
    }
    prev.conversions += r.conversions
    prev.allConversions += r.allConversions
    prev.conversionActionName ??= name
  }
  return [...byKey.values()].sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.conversionActionId < b.conversionActionId ? -1 : a.conversionActionId > b.conversionActionId ? 1 : 0))
}

const assetKey = (r: Pick<AssetDayRow, 'date' | 'adGroupId' | 'adId' | 'assetId' | 'fieldType'>) => [r.date, r.adGroupId, r.adId, r.assetId, r.fieldType].join('\u0000')
/** Usable asset rows, one per (date, ad group, ad, asset, field type): a malformed row is dropped,
 * two rows for the same key are summed, and the first non-null label and description are kept.
 * Impressions and clicks are whole numbers. Sorted by key. */
export function mergeAssetRows(rows: readonly AssetDayRow[]): AssetDayRow[] {
  const byKey = new Map<string, AssetDayRow>()
  for (const r of rows) {
    if (!ADS_DATE.test(r.date) || !ADS_ID.test(r.adGroupId) || !ADS_ID.test(r.adId) || !ADS_ID.test(r.assetId) || !ADS_ENUM.test(r.fieldType)) continue
    if (!okCount(r.impressions) || !okCount(r.clicks) || !okCount(r.conversions)) continue
    const k = assetKey(r)
    const prev = byKey.get(k)
    const clean: AssetDayRow = {
      date: r.date,
      adGroupId: r.adGroupId,
      adId: r.adId,
      assetId: r.assetId,
      fieldType: r.fieldType,
      impressions: Math.round(r.impressions),
      clicks: Math.round(r.clicks),
      conversions: r.conversions,
      performanceLabel: enumOrNull(r.performanceLabel),
      assetType: enumOrNull(r.assetType),
      text: clipText(r.text, ASSET_TEXT_MAX),
      name: clipText(r.name, ASSET_NAME_MAX),
    }
    if (!prev) {
      byKey.set(k, clean)
      continue
    }
    prev.impressions += clean.impressions
    prev.clicks += clean.clicks
    prev.conversions += clean.conversions
    prev.performanceLabel ??= clean.performanceLabel
    prev.assetType ??= clean.assetType
    prev.text ??= clean.text
    prev.name ??= clean.name
  }
  return [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r)
}

/** The ads_assets rows a set of daily asset rows names: one per asset with a known type, its
 * first and last day across the rows, and the first non-null text and name. A row with no asset
 * type still stores its daily numbers; it just adds nothing to the catalog. */
export function assetCatalogFrom(rows: readonly AssetDayRow[]): AssetRecord[] {
  const byId = new Map<string, AssetRecord>()
  for (const r of mergeAssetRows(rows)) {
    if (!r.assetType) continue
    const prev = byId.get(r.assetId)
    if (!prev) {
      byId.set(r.assetId, { assetId: r.assetId, type: r.assetType, text: r.text, name: r.name, firstSeen: r.date, lastSeen: r.date })
      continue
    }
    if (r.date < prev.firstSeen) prev.firstSeen = r.date
    if (r.date > prev.lastSeen) prev.lastSeen = r.date
    prev.text ??= r.text
    prev.name ??= r.name
  }
  return [...byId.values()].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0))
}

/** Upserts conversion rows, idempotent on (campaign_id, date, conversion_action_id): a re-pull
 * overwrites a restated day, and an unchanged one changes nothing (the WHERE clause), so
 * fetched_at records the last real change. A name the re-pull leaves blank keeps its stored value. */
export function conversionDailyUpserts(campaignId: string, rows: readonly ConversionDayRow[], fetchedAt: string): SqlStatement[] {
  return chunk(mergeConversionRows(rows), CONVERSION_ROWS_PER_STATEMENT).map((part) => ({
    sql:
      `INSERT INTO ads_daily_conversions (campaign_id, date, conversion_action_id, conversion_action_name, conversions, all_conversions, source, fetched_at) VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, 'google-ads-api', ?)").join(', ')} ` +
      `ON CONFLICT (campaign_id, date, conversion_action_id) DO UPDATE SET conversion_action_name = COALESCE(excluded.conversion_action_name, ads_daily_conversions.conversion_action_name), conversions = excluded.conversions, all_conversions = excluded.all_conversions, source = excluded.source, fetched_at = excluded.fetched_at ` +
      `WHERE ads_daily_conversions.conversions IS NOT excluded.conversions OR ads_daily_conversions.all_conversions IS NOT excluded.all_conversions OR (excluded.conversion_action_name IS NOT NULL AND ads_daily_conversions.conversion_action_name IS NOT excluded.conversion_action_name)`,
    binds: part.flatMap((r) => [campaignId, r.date, r.conversionActionId, r.conversionActionName, r.conversions, r.allConversions, fetchedAt]),
  }))
}

/** Upserts daily asset rows, idempotent on (campaign_id, date, ad_group_id, ad_id, asset_id,
 * field_type): a re-pull overwrites changed numbers, an unchanged one changes nothing. The
 * performance label is Google's label at fetch time, not a daily metric, so the first label
 * stored for a day is kept (a blank one is filled in). */
export function assetDailyUpserts(campaignId: string, rows: readonly AssetDayRow[], fetchedAt: string): SqlStatement[] {
  return chunk(mergeAssetRows(rows), ASSET_ROWS_PER_STATEMENT).map((part) => ({
    sql:
      `INSERT INTO ads_daily_assets (campaign_id, ad_group_id, ad_id, asset_id, field_type, date, impressions, clicks, conversions, performance_label, source, fetched_at) VALUES ${part.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'google-ads-api', ?)").join(', ')} ` +
      `ON CONFLICT (campaign_id, date, ad_group_id, ad_id, asset_id, field_type) DO UPDATE SET impressions = excluded.impressions, clicks = excluded.clicks, conversions = excluded.conversions, performance_label = COALESCE(ads_daily_assets.performance_label, excluded.performance_label), source = excluded.source, fetched_at = excluded.fetched_at ` +
      `WHERE ads_daily_assets.impressions IS NOT excluded.impressions OR ads_daily_assets.clicks IS NOT excluded.clicks OR ads_daily_assets.conversions IS NOT excluded.conversions OR (ads_daily_assets.performance_label IS NULL AND excluded.performance_label IS NOT NULL)`,
    binds: part.flatMap((r) => [campaignId, r.adGroupId, r.adId, r.assetId, r.fieldType, r.date, r.impressions, r.clicks, r.conversions, r.performanceLabel, fetchedAt]),
  }))
}

/** Upserts the asset catalog, idempotent on asset_id: first_seen only moves earlier, last_seen
 * only later, a blank text or name keeps the stored one, and an unchanged asset changes nothing. */
export function assetCatalogUpserts(assets: readonly AssetRecord[]): SqlStatement[] {
  const usable = assets.filter((a) => ADS_ID.test(a.assetId) && ADS_ENUM.test(a.type) && ADS_DATE.test(a.firstSeen) && ADS_DATE.test(a.lastSeen) && a.firstSeen <= a.lastSeen)
  return chunk(usable, ASSET_CATALOG_ROWS_PER_STATEMENT).map((part) => ({
    sql:
      `INSERT INTO ads_assets (asset_id, type, text, name, first_seen, last_seen) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')} ` +
      `ON CONFLICT (asset_id) DO UPDATE SET type = excluded.type, text = COALESCE(excluded.text, ads_assets.text), name = COALESCE(excluded.name, ads_assets.name), first_seen = min(ads_assets.first_seen, excluded.first_seen), last_seen = max(ads_assets.last_seen, excluded.last_seen) ` +
      `WHERE ads_assets.type IS NOT excluded.type OR (excluded.text IS NOT NULL AND ads_assets.text IS NOT excluded.text) OR (excluded.name IS NOT NULL AND ads_assets.name IS NOT excluded.name) OR excluded.first_seen < ads_assets.first_seen OR excluded.last_seen > ads_assets.last_seen`,
    binds: part.flatMap((a) => [a.assetId, a.type, clipText(a.text, ASSET_TEXT_MAX), clipText(a.name, ASSET_NAME_MAX), a.firstSeen, a.lastSeen]),
  }))
}

// ── Play's own per-day install totals (migration 0005; written by `npm run ads:play-sync`) ──
/** One Play day: Google's aggregate for the whole app (never a beacon row, never split by country,
 * source, device or hour). A count is null when the report had no such column or value. */
export interface PlayDayRow {
  date: string
  deviceInstalls: number | null
  userInstalls: number | null
  deviceUninstalls: number | null
  activeDeviceInstalls: number | null
}
const PLAY_DATE = /^\d{4}-\d{2}-\d{2}$/
const playCount = (n: number | null | undefined): number | null => (n == null || !Number.isFinite(n) || n < 0 ? null : Math.round(n))

/** The usable Play days: a well-formed date only, one row per date (the last one wins), by date. */
export function normalizePlayDays(rows: readonly PlayDayRow[]): PlayDayRow[] {
  const byDate = new Map<string, PlayDayRow>()
  for (const r of rows) if (PLAY_DATE.test(r.date)) byDate.set(r.date, { date: r.date, deviceInstalls: playCount(r.deviceInstalls), userInstalls: playCount(r.userInstalls), deviceUninstalls: playCount(r.deviceUninstalls), activeDeviceInstalls: playCount(r.activeDeviceInstalls) })
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

/** Upserts Play day rows, idempotent on `date` (Play re-posts days, so a re-sync overwrites; a count
 * the re-post leaves blank keeps its stored value). */
export function playDailyUpserts(rows: readonly PlayDayRow[], fetchedAt: string): SqlStatement[] {
  return chunk(normalizePlayDays(rows), rowsPerStatement(6)).map((part) => ({
    sql:
      `INSERT INTO ads_play_daily (date, device_installs, user_installs, device_uninstalls, active_device_installs, fetched_at) VALUES ${part.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')} ` +
      `ON CONFLICT (date) DO UPDATE SET ` +
      // A blank count in a re-post keeps the last known number (COALESCE); only fetched_at always moves.
      `device_installs = COALESCE(excluded.device_installs, ads_play_daily.device_installs), user_installs = COALESCE(excluded.user_installs, ads_play_daily.user_installs), device_uninstalls = COALESCE(excluded.device_uninstalls, ads_play_daily.device_uninstalls), active_device_installs = COALESCE(excluded.active_device_installs, ads_play_daily.active_device_installs), fetched_at = excluded.fetched_at`,
    binds: part.flatMap((r) => [r.date, r.deviceInstalls, r.userInstalls, r.deviceUninstalls, r.activeDeviceInstalls, fetchedAt]),
  }))
}

/** Writes Play days through any AdsDb. Every statement passes assertAdsWriteSql first;
 * `dryRun` sends nothing (written: false, with the statement count a real run would send). */
export async function writePlayDaily(db: AdsDb, rows: readonly PlayDayRow[], fetchedAt: string, opts: { dryRun: boolean }): Promise<{ written: boolean; days: number; statements: number }> {
  const stmts = playDailyUpserts(rows, fetchedAt)
  const days = normalizePlayDays(rows).length
  for (const s of stmts) assertAdsWriteSql(s.sql)
  if (opts.dryRun) return { written: false, days, statements: stmts.length }
  for (const s of stmts) await db.run(s)
  return { written: stmts.length > 0, days, statements: stmts.length }
}

/** One append (the table is append-only by trigger). `ON CONFLICT DO NOTHING` covers both
 * uniques: a retry of the same reading_key, and a second row for the same (campaign, ET date,
 * entry kind) — migration 0003's de-dup key. */
export function readingInsert(rec: ReadingRecord, routineVersion: string = ROUTINE_VERSION): SqlStatement {
  return {
    sql:
      'INSERT INTO ads_readings (reading_key, campaign_id, kind, stage, read_at, et_date, spend_through_et, cumulative_spend_micros, thresholds, complete, rules, proposal, decision, counts, notes, routine_version, entry_kind, f3) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
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
      rec.entryKind ?? readingEntryKind(rec),
      rec.f3 == null ? null : JSON.stringify(rec.f3),
    ],
  }
}

/** Marks thresholds fired — only for a COMPLETE threshold read, pointing at its reading row
 * (found by the de-dup key, so it resolves even if a concurrent run stored that entry). The
 * primary key (campaign_id, threshold_usd) makes a second firing impossible. */
export function thresholdStateInsert(rec: ReadingRecord): SqlStatement | null {
  if (rec.kind !== 'threshold' || !rec.complete || !rec.thresholds.length) return null
  const ek = rec.entryKind ?? readingEntryKind(rec)
  // The reading is found by its de-dup key, or by its reading_key for a row stored before 0003.
  return {
    sql:
      `INSERT INTO ads_threshold_state (campaign_id, threshold_usd, fired_at, reading_id) VALUES ${rec.thresholds
        .map(() => '(?, ?, ?, COALESCE((SELECT id FROM ads_readings WHERE campaign_id = ? AND et_date = ? AND entry_kind = ?), (SELECT id FROM ads_readings WHERE reading_key = ?)))')
        .join(', ')} ON CONFLICT (campaign_id, threshold_usd) DO NOTHING`,
    binds: rec.thresholds.flatMap((t) => [rec.campaignId, Math.round(t), rec.readAt, rec.campaignId, rec.etDate, ek, rec.id]),
  }
}

// ── Sync runs (ads_sync_runs, migrations 0003 + 0004) ─────────────────────────────────────
export const SYNC_SOURCES = ['ads-sync', 'morning-read', 'backstop', 'postflight-read', 'backfill', 'worker-cron', 'worker-on-demand'] as const
export type SyncSource = (typeof SYNC_SOURCES)[number]
export type SyncStatus = 'ok' | 'partial' | 'failed'
export interface SyncRunRecord {
  runKey: string
  source: SyncSource
  startedAt: string
  finishedAt: string
  /** Campaign ids the run was asked to sync. */
  campaigns: string[]
  /** The ones whose daily metrics synced (lastSync is read from here). */
  campaignsOk: string[]
  /** The ones whose closed days were pulled through the end of their window (the restatement
   * window was re-checked): the recheck cadence reads this. */
  campaignsPulled: string[]
  daysFetched: number
  daysChanged: number
  placementRowsFetched: number
  placementRowsChanged: number
  status: SyncStatus
  /** Redacted, one line, no local paths. */
  error: string | null
  /** Per-campaign ranges and counts (anonymous). */
  detail: Record<string, unknown>
}
export function syncRunInsert(r: SyncRunRecord): SqlStatement {
  return {
    sql:
      'INSERT INTO ads_sync_runs (run_key, source, started_at, finished_at, campaigns, campaigns_ok, days_fetched, days_changed, placement_rows_fetched, placement_rows_changed, status, error, detail, campaigns_pulled) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
    binds: [
      r.runKey,
      r.source,
      r.startedAt,
      r.finishedAt < r.startedAt ? r.startedAt : r.finishedAt,
      JSON.stringify(r.campaigns),
      JSON.stringify(r.campaignsOk),
      r.daysFetched,
      r.daysChanged,
      r.placementRowsFetched,
      r.placementRowsChanged,
      r.status,
      r.error == null ? null : stripLocalPaths(r.error).slice(0, 500),
      JSON.stringify(r.detail),
      JSON.stringify(r.campaignsPulled ?? []),
    ],
  }
}

/** The conversions-and-assets pass (lib/adsSync.ts syncAdsExtras) keeps its own rows in
 * ads_sync_runs, keyed with this prefix. Every reader of the COST sync's runs below (the claim,
 * the rate limit, lastSync) skips them, so that pass can never delay, block or stale the cost
 * sync; LAST_PULLS_SQL needs no filter (those rows always have campaigns_pulled '[]'). */
export const EXTRAS_RUN_KEY_PREFIX = 'extras:'
const NOT_EXTRAS_RUN = `run_key NOT LIKE '${EXTRAS_RUN_KEY_PREFIX}%'`

/** The atomic claim a Worker sync makes BEFORE it syncs (migration 0004): a 'running' row,
 * inserted only when no sync run (claim or finished; never a conversions-and-assets row) ended
 * inside the last `windowMs`. One
 * statement, so of two concurrent requests exactly one inserts (changes = 1) and the other gets
 * changes = 0. A claim that is never followed by a finished row is a run that died (e.g. out of
 * CPU) — visible in the table, and it only blocks for one window. */
export function syncClaimStatement(source: SyncSource, nowMs: number, windowMs: number): SqlStatement {
  const now = new Date(nowMs).toISOString()
  return {
    sql:
      "INSERT INTO ads_sync_runs (run_key, source, started_at, finished_at, campaigns, campaigns_ok, days_fetched, days_changed, placement_rows_fetched, placement_rows_changed, status, error, detail, campaigns_pulled) " +
      `SELECT ?, ?, ?, ?, '[]', '[]', 0, 0, 0, 0, 'running', NULL, '{}', '[]' WHERE NOT EXISTS (SELECT 1 FROM ads_sync_runs WHERE finished_at > ? AND ${NOT_EXTRAS_RUN}) ON CONFLICT DO NOTHING`,
    binds: [`claim:${source}:${now}`, source, now, now, new Date(nowMs - windowMs).toISOString()],
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────
export const SPEND_SUMMARY_SQL =
  `SELECT campaign_id, SUM(cost_micros) AS cost_micros, SUM(CASE WHEN date >= '${FIRST_FINISH_START_ET}' THEN cost_micros ELSE 0 END) AS cost_micros_from_first_finish, SUM(impressions) AS impressions, SUM(clicks) AS clicks, COUNT(*) AS days, MIN(date) AS first_date, MAX(date) AS last_date, MAX(fetched_at) AS fetched_at FROM ads_daily_metrics GROUP BY campaign_id`
export const DAILY_ROWS_SQL = 'SELECT date, cost_micros, impressions, clicks, fetched_at, placements_fetched_at FROM ads_daily_metrics WHERE campaign_id = ? ORDER BY date'
/** Every campaign's day rows in ONE query (the sync's plan; a few hundred rows at most). */
export const ALL_DAILY_ROWS_SQL = 'SELECT campaign_id, date, cost_micros, impressions, clicks, fetched_at, placements_fetched_at FROM ads_daily_metrics ORDER BY campaign_id, date'
/** The latest runs that pulled campaigns through their window (index on finished_at). */
export const LAST_PULLS_SQL = "SELECT campaigns_pulled, finished_at FROM ads_sync_runs WHERE campaigns_pulled <> '[]' ORDER BY finished_at DESC LIMIT 30"
/** Thresholds consumed by a COMPLETE threshold reading (the log is the source of truth; the
 * threshold-state table is its index). */
export const CONSUMED_FROM_READINGS_SQL = "SELECT thresholds FROM ads_readings WHERE campaign_id = ? AND kind = 'threshold' AND complete = 1"
export const PLACEMENT_ROWS_SQL =
  'SELECT date, placement, display_name, placement_type, target_url, approved, cost_micros, impressions, clicks FROM ads_placement_daily WHERE campaign_id = ? AND date >= ? AND date <= ? ORDER BY date, placement'
/** One campaign's stored conversion rows over an ET date range (migration 0007). */
export const CONVERSION_ROWS_SQL =
  'SELECT date, conversion_action_id, conversion_action_name, conversions, all_conversions FROM ads_daily_conversions WHERE campaign_id = ? AND date >= ? AND date <= ? ORDER BY date, conversion_action_id'
/** One campaign's stored daily asset rows over an ET date range (migration 0007). */
export const ASSET_ROWS_SQL =
  'SELECT date, ad_group_id, ad_id, asset_id, field_type, impressions, clicks, conversions, performance_label FROM ads_daily_assets WHERE campaign_id = ? AND date >= ? AND date <= ? ORDER BY date, ad_group_id, ad_id, asset_id, field_type'
export const THRESHOLD_STATE_SQL = 'SELECT threshold_usd, fired_at FROM ads_threshold_state WHERE campaign_id = ? ORDER BY threshold_usd'
const READING_COLS = 'reading_key, campaign_id, kind, stage, read_at, et_date, spend_through_et, cumulative_spend_micros, thresholds, complete, rules, proposal, decision, counts, notes, routine_version, entry_kind, f3'
export const READINGS_SQL = `SELECT ${READING_COLS} FROM ads_readings WHERE campaign_id = ? ORDER BY read_at DESC, id DESC LIMIT ?`
export const READINGS_ON_DAY_SQL = `SELECT ${READING_COLS} FROM ads_readings WHERE campaign_id = ? AND et_date = ? ORDER BY id`
/** Every stored Play day (the adsPlayDaily fact; a few hundred rows at most). */
export const PLAY_DAILY_SQL = 'SELECT date, device_installs, user_installs, device_uninstalls, active_device_installs FROM ads_play_daily ORDER BY date'
/** Coverage rows for spendThrough (every campaign; a few hundred rows at most). */
export const COVERAGE_ROWS_SQL = 'SELECT campaign_id, date, fetched_at FROM ads_daily_metrics ORDER BY campaign_id, date'
/** Latest successful sync per campaign, from the 50 newest finished cost runs only (index on
 * finished_at), so the cost stays flat as the log grows. */
export const LAST_SYNC_SQL =
  `SELECT j.value AS campaign_id, MAX(r.finished_at) AS last_sync FROM (SELECT campaigns_ok, finished_at FROM ads_sync_runs WHERE status <> 'running' AND ${NOT_EXTRAS_RUN} ORDER BY finished_at DESC LIMIT 50) AS r, json_each(r.campaigns_ok) AS j GROUP BY j.value`
/** When the latest cost sync run (any source) finished — the on-demand rate limit. */
export const LAST_RUN_SQL = `SELECT finished_at AS last FROM ads_sync_runs WHERE ${NOT_EXTRAS_RUN} ORDER BY finished_at DESC LIMIT 1`
/** The latest conversions-and-assets run: its detail carries that pass's state forward
 * (lib/adsSync.ts syncAdsExtras). Those runs never write a 'running' row. */
export const LAST_EXTRAS_RUN_SQL = `SELECT detail, finished_at FROM ads_sync_runs WHERE run_key LIKE '${EXTRAS_RUN_KEY_PREFIX}%' ORDER BY finished_at DESC, id DESC LIMIT 1`
/** Sync claims with no finished run after them (review I2): a 'running' row started between the
 * two bounds whose source and start have no non-running row. The Worker's finished row reuses
 * its claim's source and started_at. */
export const UNFINISHED_SYNCS_SQL =
  "SELECT c.source AS source, c.started_at AS started_at FROM ads_sync_runs AS c WHERE c.status = 'running' AND c.started_at >= ? AND c.started_at <= ? AND NOT EXISTS (SELECT 1 FROM ads_sync_runs AS f WHERE f.status <> 'running' AND f.source = c.source AND f.started_at = c.started_at) ORDER BY c.started_at DESC LIMIT 5"
export function unfinishedSyncBinds(nowMs: number): string[] {
  return [new Date(nowMs - UNFINISHED_SYNC_LOOKBACK_MS).toISOString(), new Date(nowMs - UNFINISHED_SYNC_AFTER_MS).toISOString()]
}
const toSyncAlerts = (rows: Record<string, unknown>[]): SyncAlert[] => rows.map((r) => unfinishedSyncAlert(String(r.source ?? '?'), String(r.started_at ?? '')))
export const RECENT_SYNC_RUNS_SQL =
  'SELECT run_key, source, started_at, finished_at, campaigns, campaigns_ok, days_fetched, days_changed, placement_rows_fetched, placement_rows_changed, status, error FROM ads_sync_runs ORDER BY id DESC LIMIT ?'

const num = (x: unknown): number => (typeof x === 'number' ? x : Number(x) || 0)
const str = (x: unknown): string | null => (x == null ? null : String(x))

export function mapSpendSummary(row: Record<string, unknown>): SpendSummary {
  return {
    campaignId: String(row.campaign_id ?? ''),
    costMicros: num(row.cost_micros),
    impressions: num(row.impressions),
    clicks: num(row.clicks),
    days: num(row.days),
    costMicrosFromFirstFinish: num(row.cost_micros_from_first_finish),
    firstDate: str(row.first_date),
    lastDate: str(row.last_date),
    fetchedAt: str(row.fetched_at),
  }
}

export function mapDailyRow(r: Record<string, unknown>): StoredDayRow {
  return {
    date: String(r.date),
    costMicros: num(r.cost_micros),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    fetchedAt: String(r.fetched_at ?? ''),
    placementsFetchedAt: str(r.placements_fetched_at),
  }
}

export function mapPlacementRow(r: Record<string, unknown>): PlacementDayRow {
  return {
    date: String(r.date),
    placement: String(r.placement),
    displayName: str(r.display_name),
    type: str(r.placement_type),
    targetUrl: str(r.target_url),
    approved: r.approved == null ? null : num(r.approved) === 1,
    costMicros: num(r.cost_micros),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
  }
}

export function mapConversionRow(r: Record<string, unknown>): ConversionDayRow {
  return {
    date: String(r.date),
    conversionActionId: String(r.conversion_action_id),
    conversionActionName: str(r.conversion_action_name),
    conversions: num(r.conversions),
    allConversions: num(r.all_conversions),
  }
}

/** A stored daily asset row. What the asset is (type, text, name) lives in ads_assets, so those
 * read back null here. */
export function mapAssetRow(r: Record<string, unknown>): AssetDayRow {
  return {
    date: String(r.date),
    adGroupId: String(r.ad_group_id),
    adId: String(r.ad_id),
    assetId: String(r.asset_id),
    fieldType: String(r.field_type),
    impressions: num(r.impressions),
    clicks: num(r.clicks),
    conversions: num(r.conversions),
    performanceLabel: str(r.performance_label),
    assetType: null,
    text: null,
    name: null,
  }
}

/** Stored day rows as the in-memory StoredSpend the reads use. closedThroughEt is the last day
 * that was already closed when it was written, so restatement detection only compares closed
 * days. Accepts raw rows (snake_case) or StoredDayRows. */
export function rowsToStoredSpend(campaignId: string, rows: readonly (StoredDayRow | Record<string, unknown>)[]): StoredSpend | null {
  if (!rows.length) return null
  const days: Record<string, SpendDay> = {}
  let closedThroughEt: string | null = null
  let fetchedAt = ''
  for (const raw of rows) {
    const r = 'costMicros' in raw ? (raw as StoredDayRow) : mapDailyRow(raw as Record<string, unknown>)
    days[r.date] = { costMicros: r.costMicros, impressions: r.impressions, clicks: r.clicks }
    if (r.fetchedAt > fetchedAt) fetchedAt = r.fetchedAt
    if (isClosedFetch(r.date, r.fetchedAt) && (closedThroughEt == null || r.date > closedThroughEt)) closedThroughEt = r.date
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

/** Readings stored before R-1b carry the old Play line, which named the ET hour of a /return/
 * row ("... seen 2026-09-30 21:00 ET"). Keep the date only, at read time, so no stored row needs
 * rewriting. Scoped to that line: every other note (flight starts etc.) keeps its time. */
export function scrubPlayHour(note: string): string {
  if (!note.startsWith('Play:') || !note.includes('/return/')) return note
  return note.replace(/(\d{4}-\d{2}-\d{2}) \d{2}:\d{2} ET/g, '$1 ET')
}
/** scrubPlayHour over stored notes, total: a malformed row (notes not an array, or holding
 * non-strings) passes through exactly as it did before the scrub, never throwing. */
function scrubNotes(notes: string[]): string[] {
  if (!Array.isArray(notes)) return notes
  return notes.map((n: unknown) => (typeof n === 'string' ? scrubPlayHour(n) : n)) as string[]
}
export function mapReadingRow(row: Record<string, unknown>): ReadingRecord | null {
  const kind = String(row.kind ?? '') as ReadingKind
  if (!KINDS.includes(kind) || typeof row.read_at !== 'string') return null
  const micros = row.cumulative_spend_micros
  const rec: ReadingRecord = {
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
    notes: scrubNotes(parseJson<string[]>(row.notes, [])),
  }
  // Rows from before migration 0003 carry no entry_kind: derive the same key from the fields.
  rec.entryKind = typeof row.entry_kind === 'string' && row.entry_kind ? row.entry_kind : readingEntryKind(rec)
  const f3 = parseReadingF3(parseJson<unknown>(row.f3, null))
  if (f3) rec.f3 = f3
  return rec
}
const F3_VERDICTS: readonly string[] = ['PASS', 'PROPOSE PAUSE', 'WATCH', 'NOT YET', 'NO DATA', 'n/a', 'GO', 'ITERATE', 'STOP', 'INCONCLUSIVE']
/** The stored F3 rules block (migration 0006), or undefined for NULL (every non-F3 row and rows
 * written before the column) and for anything malformed: a bad value never reaches a card. */
export function parseReadingF3(raw: unknown): ReadingF3 | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.arm !== 'string' || !STAGED_ARMS.includes(o.arm as StagedArm)) return undefined
  if (typeof o.flightDay !== 'number' || !Number.isFinite(o.flightDay) || !Array.isArray(o.readouts)) return undefined
  const proposal = o.proposal === 'PROPOSE PAUSE' || o.proposal === 'CONTINUE' ? o.proposal : null
  const readouts: ReadingF3['readouts'] = []
  for (const r of o.readouts as unknown[]) {
    if (!r || typeof r !== 'object') return undefined
    const x = r as Record<string, unknown>
    if (typeof x.n !== 'number' || typeof x.name !== 'string' || typeof x.number !== 'string') return undefined
    if (x.threshold !== null && typeof x.threshold !== 'string') return undefined
    if (typeof x.verdict !== 'string' || !F3_VERDICTS.includes(x.verdict)) return undefined
    readouts.push({ n: x.n, name: x.name, number: x.number, threshold: x.threshold, verdict: x.verdict as ReadoutVerdict })
  }
  return { v: 1, arm: o.arm as StagedArm, flightDay: o.flightDay, readouts, proposal }
}

// ── The store over any D1-shaped database ─────────────────────────────────────────────────
/** The only database surface the store needs. Adapters: scripts/ads-reads/d1Store.ts
 * wranglerAdsDb (the local CLIs), d1BindingAdsDb below (a Worker or Pages Function), and a
 * node:sqlite one in the tests (migrations 0001-0003 applied for real). */
export interface AdsDb {
  all(stmt: SqlStatement): Promise<Record<string, unknown>[]>
  /** changes: rows the statement changed, or null when the adapter cannot tell. */
  run(stmt: SqlStatement): Promise<{ changes: number | null }>
}

/** A Cloudflare D1 binding (D1Database satisfies this structurally). */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      all(): Promise<{ results?: unknown[] }>
      run(): Promise<{ meta?: { changes?: number } }>
    }
  }
}
export function d1BindingAdsDb(db: D1Like): AdsDb {
  return {
    async all(stmt) {
      const res = await db.prepare(stmt.sql).bind(...stmt.binds).all()
      return (res.results ?? []) as Record<string, unknown>[]
    },
    async run(stmt) {
      const res = await db.prepare(stmt.sql).bind(...stmt.binds).run()
      return { changes: typeof res.meta?.changes === 'number' ? res.meta.changes : null }
    },
  }
}

export interface AppendOutcome {
  /** false in --dry-run (nothing was sent). */
  written: boolean
  /** reading ids the database actually stored. */
  inserted: string[]
  /** reading ids the database ignored (same key already stored, e.g. a concurrent run). */
  ignored: string[]
}

/** What the shared sync (lib/adsSync.ts) needs — all a Worker has to provide. */
export interface AdsSyncStore {
  readonly kind: string
  readonly dryRun: boolean
  syncCampaigns(campaigns: readonly CampaignFlight[], syncedAt: string): Promise<boolean>
  /** Every campaign's day rows, by campaign id (one query). */
  getAllDailyRows(): Promise<Map<string, StoredDayRow[]>>
  /** When each campaign was last pulled through its window (recent runs' campaigns_pulled). */
  getLastPulls(): Promise<Map<string, string>>
  /** Upserts exactly these rows (the sync writes only rows that changed). */
  putDailyRows(campaignId: string, rows: readonly StoredDayRow[]): Promise<boolean>
  getPlacementRows(campaignId: string, since: string, until: string): Promise<PlacementDayRow[]>
  putPlacements(campaignId: string, rows: readonly PlacementDayRow[], fetchedAt: string): Promise<boolean>
  // Migration 0007, optional: a store without these never syncs conversions or assets.
  getConversionRows?(campaignId: string, since: string, until: string): Promise<ConversionDayRow[]>
  /** Upserts exactly these rows (false in --dry-run: nothing sent). */
  putConversions?(campaignId: string, rows: readonly ConversionDayRow[], fetchedAt: string): Promise<boolean>
  getAssetRows?(campaignId: string, since: string, until: string): Promise<AssetDayRow[]>
  /** Upserts the catalog rows these name FIRST, then the daily rows: a run cut short leaves the
   * daily rows unwritten, so the next run sees them as new and sends both again. */
  putAssets?(campaignId: string, rows: readonly AssetDayRow[], fetchedAt: string): Promise<boolean>
  /** The latest conversions-and-assets run's detail (parsed JSON), or null when there is none. */
  getLastExtrasRun?(): Promise<{ detail: unknown; finishedAt: string } | null>
  appendSyncRun(run: SyncRunRecord): Promise<boolean>
  /** The atomic claim (syncClaimStatement): true only for the one caller that inserted it. */
  claimSync(source: SyncSource, nowMs: number, windowMs: number): Promise<boolean>
}
/** Everything the reads use on top of the sync. */
export interface AdsStore extends AdsSyncStore {
  /** Thresholds already fired: the threshold-state rows plus any COMPLETE threshold reading
   * (so a state row lost to a partial write can never make a threshold fire twice). */
  getConsumedThresholds(campaignId: string): Promise<number[]>
  /** The two sources of getConsumedThresholds apart: `fromReadings` minus `state` are fired
   * thresholds whose state row is missing (to heal). */
  getThresholdLedger(campaignId: string): Promise<{ state: number[]; fromReadings: number[] }>
  getReadings(campaignId: string, limit?: number): Promise<ReadingRecord[]>
  /** The readings already stored for one campaign and ET day (the de-dup check). */
  getReadingsOn(campaignId: string, etDate: string): Promise<ReadingRecord[]>
  /** Sync runs that claimed and never finished (killed), for the reads to report (review I2). */
  getSyncAlerts(nowMs: number): Promise<SyncAlert[]>
  /** Appends records; a COMPLETE threshold record also marks its thresholds fired — always,
   * even when the reading itself was already stored (the state insert is idempotent). */
  appendReadings(records: readonly ReadingRecord[]): Promise<AppendOutcome>
  /** The idempotent threshold-state insert for COMPLETE threshold records already stored (a
   * same-day rerun that is not appended again, or a heal after a partial write). */
  ensureThresholdState(records: readonly ReadingRecord[]): Promise<boolean>
}

/** Statements createSqlAdsStore keeps back under `maxStatements` for the run row. */
export const STATEMENT_RESERVE = 2

export class QueryBudgetError extends Error {
  constructor(used: number) {
    super(`D1 query budget reached (${used} statements this run); the rest continues next run`)
    this.name = 'QueryBudgetError'
  }
}

/** The one SQL store, over any AdsDb. Every write passes assertAdsWriteSql; --dry-run sends
 * no write at all (reads still happen). `maxStatements` caps the statements one run may send
 * (D1 allows 50 per Worker invocation on Workers Free); the last two are kept for the sync-run
 * row, so a capped run still records itself. */
export function createSqlAdsStore(db: AdsDb, opts: { dryRun: boolean; kind?: string; maxStatements?: number }): AdsStore & { statementsUsed(): number } {
  let used = 0
  const RESERVE = STATEMENT_RESERVE
  const budget = (final = false) => {
    if (opts.maxStatements == null) return
    if (used >= opts.maxStatements - (final ? 0 : RESERVE)) throw new QueryBudgetError(used)
    used++
  }
  const count = () => {
    if (opts.maxStatements == null) used++
  }
  const select = async (sql: string, binds: unknown[]) => {
    assertAdsReadSql(sql)
    budget()
    count()
    return db.all({ sql, binds })
  }
  const exec = async (s: SqlStatement, final = false) => {
    assertAdsWriteSql(s.sql)
    budget(final)
    count()
    return db.run(s)
  }
  async function writeAll(stmts: readonly (SqlStatement | null)[]): Promise<boolean> {
    if (opts.dryRun) return false
    for (const s of stmts) if (s) await exec(s)
    return true
  }
  const readings = async (sql: string, binds: unknown[]) => (await select(sql, binds)).map(mapReadingRow).filter((r): r is ReadingRecord => r !== null)
  const stateFor = async (records: readonly ReadingRecord[]) => {
    for (const rec of records) {
      const th = thresholdStateInsert({ ...rec, entryKind: rec.entryKind ?? readingEntryKind(rec) })
      if (th) await exec(th)
    }
  }
  return {
    kind: opts.kind ?? 'd1',
    dryRun: opts.dryRun,
    statementsUsed: () => used,
    syncCampaigns: (campaigns, syncedAt) => writeAll(campaignSyncStatements(campaigns, syncedAt)),
    async getAllDailyRows() {
      const out = new Map<string, StoredDayRow[]>()
      for (const r of await select(ALL_DAILY_ROWS_SQL, [])) {
        const id = String(r.campaign_id)
        if (!out.has(id)) out.set(id, [])
        out.get(id)!.push(mapDailyRow(r))
      }
      return out
    },
    async getLastPulls() {
      const out = new Map<string, string>()
      for (const r of await select(LAST_PULLS_SQL, [])) {
        let ids: unknown = []
        try {
          ids = JSON.parse(String(r.campaigns_pulled ?? '[]'))
        } catch {
          ids = []
        }
        for (const id of Array.isArray(ids) ? ids : []) if (!out.has(String(id))) out.set(String(id), String(r.finished_at))
      }
      return out
    },
    putDailyRows: (campaignId, rows) => writeAll(dailyRowUpserts(campaignId, rows)),
    getPlacementRows: async (campaignId, since, until) => (await select(PLACEMENT_ROWS_SQL, [campaignId, since, until])).map(mapPlacementRow),
    putPlacements: (campaignId, rows, fetchedAt) => writeAll(placementDailyUpserts(campaignId, rows, fetchedAt)),
    getConversionRows: async (campaignId, since, until) => (await select(CONVERSION_ROWS_SQL, [campaignId, since, until])).map(mapConversionRow),
    putConversions: (campaignId, rows, fetchedAt) => writeAll(conversionDailyUpserts(campaignId, rows, fetchedAt)),
    getAssetRows: async (campaignId, since, until) => (await select(ASSET_ROWS_SQL, [campaignId, since, until])).map(mapAssetRow),
    putAssets: (campaignId, rows, fetchedAt) => writeAll([...assetCatalogUpserts(assetCatalogFrom(rows)), ...assetDailyUpserts(campaignId, rows, fetchedAt)]),
    async getLastExtrasRun() {
      const r = (await select(LAST_EXTRAS_RUN_SQL, []))[0]
      if (!r) return null
      let detail: unknown = null
      try {
        detail = JSON.parse(String(r.detail ?? '{}'))
      } catch {
        detail = null // unreadable: the pass starts over (its upserts are idempotent)
      }
      return { detail, finishedAt: String(r.finished_at) }
    },
    async appendSyncRun(run) {
      if (opts.dryRun) return false
      await exec(syncRunInsert(run), true)
      return true
    },
    async claimSync(source, nowMs, windowMs) {
      if (opts.dryRun) return true
      const res = await exec(syncClaimStatement(source, nowMs, windowMs), true)
      return res.changes === 1
    },
    async getThresholdLedger(campaignId) {
      const state = new Set<number>()
      for (const r of await select(THRESHOLD_STATE_SQL, [campaignId])) {
        const n = Number(r.threshold_usd)
        if (Number.isFinite(n)) state.add(n)
      }
      const fromReadings = new Set<number>()
      for (const r of await select(CONSUMED_FROM_READINGS_SQL, [campaignId])) {
        try {
          for (const t of JSON.parse(String(r.thresholds ?? '[]')) as unknown[]) if (Number.isFinite(Number(t))) fromReadings.add(Number(t))
        } catch {
          /* a malformed row consumes nothing */
        }
      }
      const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b)
      return { state: sorted(state), fromReadings: sorted(fromReadings) }
    },
    async getConsumedThresholds(campaignId) {
      const l = await this.getThresholdLedger(campaignId)
      return [...new Set([...l.state, ...l.fromReadings])].sort((a, b) => a - b)
    },
    getReadings: (campaignId, limit = 200) => readings(READINGS_SQL, [campaignId, Math.max(1, Math.min(500, Math.floor(limit)))]),
    getReadingsOn: (campaignId, etDate) => readings(READINGS_ON_DAY_SQL, [campaignId, etDate]),
    getSyncAlerts: async (nowMs) => toSyncAlerts(await select(UNFINISHED_SYNCS_SQL, unfinishedSyncBinds(nowMs))),
    async appendReadings(records) {
      const out: AppendOutcome = { written: !opts.dryRun, inserted: [], ignored: [] }
      if (opts.dryRun) return out
      for (const rec of records) {
        const withKey = { ...rec, entryKind: rec.entryKind ?? readingEntryKind(rec) }
        const res = await exec(readingInsert(withKey))
        if (res.changes === 0) out.ignored.push(rec.id)
        else out.inserted.push(rec.id)
        // Idempotent, and run even when the reading was already there: a state row lost to an
        // earlier partial write is restored instead of the threshold firing again.
        await stateFor([withKey])
      }
      return out
    },
    async ensureThresholdState(records) {
      if (opts.dryRun) return false
      await stateFor(records)
      return true
    },
  }
}

// ── GET /api/ads/readings — shape shared by the Function and the readings log card (MetricCard) ────
export interface AdsReadingsCampaign extends AdsFreshness {
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
  /** Sync runs that were killed mid-run in the last 7 days (review I2); absent = none. */
  syncAlerts?: SyncAlert[]
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

/** Finish time of the latest sync run of any source; null when none (or unreadable). */
export async function readLastSyncRun(db: D1Reader | undefined | null): Promise<string | null> {
  if (!db) return null
  try {
    const rows = await allRows(db, LAST_RUN_SQL, [])
    return str(rows[0]?.last)
  } catch {
    return null
  }
}

/** Killed sync runs for the dashboard (fail soft: none when unreadable). */
export async function readSyncAlerts(db: D1Reader | undefined | null, nowMs: number): Promise<SyncAlert[]> {
  if (!db) return []
  try {
    return toSyncAlerts(await allRows(db, UNFINISHED_SYNCS_SQL, unfinishedSyncBinds(nowMs)))
  } catch {
    return []
  }
}

/** spendThrough / lastSync / stale for every configured campaign. Fail soft: an unreadable
 * store yields "nothing stored" (and stale only for a campaign that should have data by now);
 * a missing ads_sync_runs table (before migration 0003) yields lastSync null. */
export async function readFreshness(db: D1Reader | undefined | null, nowMs: number, campaigns: readonly CampaignFlight[] = CAMPAIGNS): Promise<Map<string, AdsFreshness>> {
  let coverage: Record<string, unknown>[] = []
  let syncs: Record<string, unknown>[] = []
  if (db) {
    try {
      coverage = await allRows(db, COVERAGE_ROWS_SQL, [])
    } catch {
      coverage = []
    }
    try {
      syncs = await allRows(db, LAST_SYNC_SQL, [])
    } catch {
      syncs = []
    }
  }
  const lastSync = new Map(syncs.map((r) => [String(r.campaign_id), str(r.last_sync)]))
  const out = new Map<string, AdsFreshness>()
  for (const c of campaigns) {
    const rows = coverage.filter((r) => String(r.campaign_id) === c.id).map((r) => ({ date: String(r.date), fetchedAt: str(r.fetched_at) }))
    out.set(c.id, freshnessOf(c, spendThroughFromRows(c.flightStart, rows, c.flightEnd), lastSync.get(c.id) ?? null, nowMs))
  }
  return out
}
