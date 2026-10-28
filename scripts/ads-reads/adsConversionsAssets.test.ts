// Migration 0007 (ads_daily_conversions, ads_daily_assets, ads_assets), the two read-only fetchers
// that fill it (lib/adsApi.ts fetchDailyConversions, fetchDailyAssets) and the store's upserts
// (lib/adsStore.ts). Real migrated SQLite and a fake Ads client: no network, no credential, never
// the production database. Every customer, conversion-action, ad group, ad and asset id here is
// made up; the response rows have the probe's shape (REST JSON, camelCase), not its values.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  conversionActionIdOf,
  createAdsClient,
  dailyAssetsQuery,
  dailyConversionsQuery,
  fetchDailyAssets,
  fetchDailyConversions,
  maskCustomerId,
  type AdsClient,
  type FetchLike,
} from '../../src/lib/adsApi'
import { etDateRange } from '../../src/lib/adsFreshness'
import { ADS_CUSTOMER_ID } from '../../src/lib/adsRules'
import {
  ASSET_NAME_MAX,
  ASSET_TEXT_MAX,
  assertAdsWriteSql,
  assetCatalogFrom,
  assetCatalogUpserts,
  assetDailyUpserts,
  conversionDailyUpserts,
  createSqlAdsStore,
  LAST_EXTRAS_RUN_SQL,
  LAST_RUN_SQL,
  LAST_SYNC_SQL,
  MAX_BINDS,
  mergeAssetRows,
  mergeConversionRows,
  readLastSyncRun,
  type AssetDayRow,
  type AssetRecord,
  type ConversionDayRow,
  type SyncRunRecord,
} from '../../src/lib/adsStore'
import {
  extrasWindow,
  RESTATEMENT_RECHECK_MS,
  syncableCampaigns,
  syncAdsExtras,
  type AdsExtrasSource,
  type ExtrasKind,
  type ExtrasOptions,
} from '../../src/lib/adsSync'
import { campaignById } from '../../src/lib/campaigns'
import { count, migrationFiles, openMigratedSqlite, sqliteAdsDb, sqliteD1 } from './sqliteDb'

const F4 = '24392866056' // F4 Android (app campaign)
const F3S = '24358792551' // F3 Search
const CUSTOMER = '1234567890' // made up: never the account's id
const action = (id: string) => `customers/${CUSTOMER}/conversionActions/${id}`
const NEW_TABLES = ['ads_daily_conversions', 'ads_daily_assets', 'ads_assets']

// ── Probe-shaped response rows (made-up ids) ──────────────────────────────────────────────
const convRow = (date: string, actionId: string, conversions: unknown, allConversions: unknown, name: unknown = 'Android installs (test)') => ({
  campaign: { resourceName: `customers/${CUSTOMER}/campaigns/${F4}` },
  segments: { date, conversionAction: action(actionId), conversionActionName: name },
  metrics: { conversions, allConversions },
})
const assetRow = (o: {
  date: string
  adGroup?: unknown
  ad?: unknown
  asset?: unknown
  type?: unknown
  text?: string
  name?: string
  field?: unknown
  label?: unknown
  impressions?: unknown
  clicks?: unknown
  conversions?: unknown
  campaign?: string
}) => ({
  segments: { date: o.date },
  campaign: { resourceName: `customers/${CUSTOMER}/campaigns/${o.campaign ?? F3S}`, id: o.campaign ?? F3S },
  adGroup: { resourceName: `customers/${CUSTOMER}/adGroups/${String(o.adGroup ?? '501')}`, id: o.adGroup ?? '501' },
  adGroupAd: { resourceName: `customers/${CUSTOMER}/adGroupAds/501~601`, ad: { resourceName: `customers/${CUSTOMER}/ads/601`, id: o.ad ?? '601' } },
  asset: {
    resourceName: `customers/${CUSTOMER}/assets/${String(o.asset ?? '701')}`,
    id: o.asset ?? '701',
    type: o.type ?? 'TEXT',
    ...(o.name != null ? { name: o.name } : {}),
    ...(o.text != null ? { textAsset: { text: o.text } } : {}),
  },
  adGroupAdAssetView: { resourceName: `customers/${CUSTOMER}/adGroupAdAssetViews/501~601~701~HEADLINE`, fieldType: o.field ?? 'HEADLINE', performanceLabel: o.label ?? 'NOT_APPLICABLE' },
  metrics: { impressions: o.impressions ?? '120', clicks: o.clicks ?? '3', conversions: o.conversions ?? 0 },
})
function fakeClient(rows: unknown[]): AdsClient & { queries: string[] } {
  const queries: string[] = []
  return {
    queries,
    async search(q: string) {
      queries.push(q)
      return rows
    },
  }
}

function setup(opts: { dryRun?: boolean } = {}) {
  const sqlite = openMigratedSqlite()
  const adapter = sqliteAdsDb(sqlite)
  const store = createSqlAdsStore(adapter, { dryRun: !!opts.dryRun, kind: 'sqlite' })
  return { sqlite, adapter, store }
}
async function seeded(opts: { dryRun?: boolean } = {}) {
  const s = setup()
  await s.store.syncCampaigns([campaignById(F4)!, campaignById(F3S)!], '2026-10-28T00:00:00Z')
  if (!opts.dryRun) return s
  return { ...s, store: createSqlAdsStore(s.adapter, { dryRun: true, kind: 'sqlite' }) }
}
const all = (sqlite: ReturnType<typeof openMigratedSqlite>, table: string, order: string) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Record<string, unknown>[]
const convDay = (date: string, conversionActionId: string, conversions: number, allConversions = conversions, conversionActionName: string | null = 'Installs'): ConversionDayRow => ({ date, conversionActionId, conversionActionName, conversions, allConversions })
const assetDay = (o: Partial<AssetDayRow> & { date: string }): AssetDayRow => ({
  adGroupId: '501',
  adId: '601',
  assetId: '701',
  fieldType: 'HEADLINE',
  impressions: 100,
  clicks: 2,
  conversions: 0,
  performanceLabel: null,
  assetType: 'TEXT',
  text: 'Sudoku with no ads',
  name: null,
  ...o,
})
const isoDay = (i: number) => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10)

// ── The migration ────────────────────────────────────────────────────────────────────────
describe('migration 0007 (ads_daily_conversions, ads_daily_assets, ads_assets)', () => {
  it('adds three counts-only tables and changes nothing that already exists', () => {
    expect(migrationFiles()).toContain('0007_daily_conversions_assets.sql')
    const before = openMigratedSqlite('0006_readings_f3.sql')
    const after = openMigratedSqlite('0007_daily_conversions_assets.sql')
    const schema = (db: ReturnType<typeof openMigratedSqlite>) =>
      db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name NOT IN (${NEW_TABLES.map(() => '?').join(', ')}) ORDER BY name`).all(...NEW_TABLES)
    expect(schema(after)).toEqual(schema(before))
    const cols = (t: string) => (after.prepare(`PRAGMA table_info('${t}')`).all() as { name: string }[]).map((c) => c.name)
    // No resource name, customer id, user, device, place or hour column anywhere.
    expect(cols('ads_daily_conversions')).toEqual(['campaign_id', 'date', 'conversion_action_id', 'conversion_action_name', 'conversions', 'all_conversions', 'source', 'fetched_at'])
    expect(cols('ads_daily_assets')).toEqual(['campaign_id', 'ad_group_id', 'ad_id', 'asset_id', 'field_type', 'date', 'impressions', 'clicks', 'conversions', 'performance_label', 'source', 'fetched_at'])
    expect(cols('ads_assets')).toEqual(['asset_id', 'type', 'text', 'name', 'first_seen', 'last_seen'])
  })
  it('ads_daily_conversions refuses a bad date, a non-digit action id, a non-numeric, negative or infinite count, and an unknown campaign', async () => {
    const { sqlite } = await seeded()
    const ins = sqlite.prepare("INSERT INTO ads_daily_conversions (campaign_id, date, conversion_action_id, conversion_action_name, conversions, all_conversions, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?, 'google-ads-api', 'x')")
    expect(() => ins.run(F4, '10/26/2026', '111', 'n', 1, 1)).toThrow(/CHECK/)
    expect(() => ins.run(F4, '2026-10-26', action('111'), 'n', 1, 1)).toThrow(/CHECK/) // the resource name itself
    expect(() => ins.run(F4, '2026-10-26', '', 'n', 1, 1)).toThrow(/CHECK/)
    expect(() => ins.run(F4, '2026-10-26', '111', 'n', 'abc', 1)).toThrow(/CHECK/)
    expect(() => ins.run(F4, '2026-10-26', '111', 'n', -1, 1)).toThrow(/CHECK/)
    expect(() => ins.run(F4, '2026-10-26', '111', 'n', 1, Infinity)).toThrow(/CHECK/)
    expect(() => ins.run(F4, '2026-10-26', '111', '', 1, 1)).toThrow(/CHECK/)
    expect(() => ins.run('111111111', '2026-10-26', '111', 'n', 1, 1)).toThrow(/FOREIGN KEY/)
    expect(() => sqlite.prepare("INSERT INTO ads_daily_conversions (campaign_id, date, conversion_action_id, conversions, all_conversions, source, fetched_at) VALUES (?, '2026-10-26', '111', 1, 1, 'manual', 'x')").run(F4)).toThrow(/CHECK/)
    // A whole number reads back as REAL; a null name is allowed.
    ins.run(F4, '2026-10-26', '111', null, 4, 4.5)
    expect(sqlite.prepare('SELECT typeof(conversions) AS t, conversion_action_name AS n FROM ads_daily_conversions').get()).toEqual({ t: 'real', n: null })
    expect(() => ins.run(F4, '2026-10-26', '111', null, 1, 1)).toThrow(/UNIQUE|PRIMARY/)
  })
  it('ads_daily_assets refuses a lowercase field type, an empty or non-digit id, a fractional or text count, and takes a null label', async () => {
    const { sqlite } = await seeded()
    const ins = sqlite.prepare(
      "INSERT INTO ads_daily_assets (campaign_id, ad_group_id, ad_id, asset_id, field_type, date, impressions, clicks, conversions, performance_label, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'google-ads-api', 'x')",
    )
    const ok = [F3S, '501', '601', '701', 'HEADLINE', '2026-10-26', 100, 2, 0, null] as const
    const withAt = (i: number, v: string | number | null) => ok.map((x, j) => (j === i ? v : x)) as (string | number | null)[]
    expect(() => ins.run(...withAt(4, 'headline'))).toThrow(/CHECK/)
    expect(() => ins.run(...withAt(1, ''))).toThrow(/CHECK/)
    expect(() => ins.run(...withAt(3, `customers/${CUSTOMER}/assets/701`))).toThrow(/CHECK/)
    expect(() => ins.run(...withAt(6, 1.5))).toThrow(/CHECK/)
    expect(() => ins.run(...withAt(7, 'abc'))).toThrow(/CHECK/)
    expect(() => ins.run(...withAt(7, -1))).toThrow(/CHECK/)
    expect(() => ins.run(...withAt(8, 'abc'))).toThrow(/CHECK/)
    expect(() => ins.run(...withAt(9, 'learning'))).toThrow(/CHECK/)
    expect(() => ins.run(...withAt(5, '2026-1-26'))).toThrow(/CHECK/)
    expect(() => ins.run(...withAt(0, '111111111'))).toThrow(/FOREIGN KEY/)
    // More clicks than impressions on a day is allowed (a click on another day's impression).
    expect(() => ins.run(...withAt(7, 101))).not.toThrow()
    expect(() => ins.run(...withAt(4, 'DESCRIPTION'))).not.toThrow()
    expect(sqlite.prepare("SELECT performance_label AS l FROM ads_daily_assets WHERE field_type = 'DESCRIPTION'").get()).toEqual({ l: null })
  })
  it('ads_assets refuses first_seen after last_seen and a malformed type, and takes a null text and name', () => {
    const sqlite = openMigratedSqlite()
    const ins = sqlite.prepare('INSERT INTO ads_assets (asset_id, type, text, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
    expect(() => ins.run('701', 'TEXT', 't', null, '2026-10-27', '2026-10-26')).toThrow(/CHECK/)
    expect(() => ins.run('701', 'text', 't', null, '2026-10-26', '2026-10-26')).toThrow(/CHECK/)
    expect(() => ins.run('701', 'TEXT', '', null, '2026-10-26', '2026-10-26')).toThrow(/CHECK/)
    expect(() => ins.run('', 'TEXT', 't', null, '2026-10-26', '2026-10-26')).toThrow(/CHECK/)
    expect(() => ins.run('701', 'TEXT', 'x'.repeat(ASSET_TEXT_MAX + 1), null, '2026-10-26', '2026-10-26')).toThrow(/CHECK/)
    expect(() => ins.run('702', 'IMAGE', null, null, '2026-10-26', '2026-10-27')).not.toThrow()
  })
})

// ── The fetchers ─────────────────────────────────────────────────────────────────────────
describe('fetchDailyConversions (read-only GAQL)', () => {
  it('runs the one SELECT on campaign, per ET day and conversion action', async () => {
    const client = fakeClient([])
    await fetchDailyConversions(client, F4, '2026-10-26', '2026-10-27')
    expect(client.queries).toEqual([dailyConversionsQuery(F4, '2026-10-26', '2026-10-27')])
    expect(client.queries[0]).toBe(
      `SELECT segments.date, segments.conversion_action, segments.conversion_action_name, metrics.conversions, metrics.all_conversions FROM campaign WHERE campaign.id = ${F4} AND segments.date BETWEEN '2026-10-26' AND '2026-10-27'`,
    )
  })
  it('keeps only the trailing numeric action id: no row carries the resource name or the customer id', async () => {
    const client = fakeClient([convRow('2026-10-26', '111', 4, 4), convRow('2026-10-27', '111', 20, 20.5), convRow('2026-10-27', '222', '1.5', '2', 'First open (test)')])
    const rows = await fetchDailyConversions(client, F4, '2026-10-26', '2026-10-27')
    expect(rows).toEqual([
      { date: '2026-10-26', conversionActionId: '111', conversionActionName: 'Android installs (test)', conversions: 4, allConversions: 4 },
      { date: '2026-10-27', conversionActionId: '111', conversionActionName: 'Android installs (test)', conversions: 20, allConversions: 20.5 },
      { date: '2026-10-27', conversionActionId: '222', conversionActionName: 'First open (test)', conversions: 1.5, allConversions: 2 },
    ])
    const text = JSON.stringify(rows)
    expect(text).not.toContain('customers/')
    expect(text).not.toContain(CUSTOMER)
  })
  it('drops a malformed row and sums two rows for one (day, action)', async () => {
    const client = fakeClient([
      convRow('2026-10-26', '111', 1, 1),
      convRow('2026-10-26', '111', 2, 3, null),
      { segments: { date: '2026-10-26', conversionAction: 'customers/1/campaigns/9' }, metrics: { conversions: 1, allConversions: 1 } }, // not an action
      { segments: { date: '2026-10-26' }, metrics: { conversions: 1, allConversions: 1 } }, // no action
      convRow('26-10-2026', '111', 1, 1),
      convRow('2026-10-26', '333', 'abc', 1),
      convRow('2026-10-26', '444', -1, 1),
      convRow('2026-10-26', '555', undefined, undefined), // absent metrics read as 0 (proto3 JSON)
    ])
    expect(await fetchDailyConversions(client, F4, '2026-10-26', '2026-10-26')).toEqual([
      { date: '2026-10-26', conversionActionId: '111', conversionActionName: 'Android installs (test)', conversions: 3, allConversions: 4 },
      { date: '2026-10-26', conversionActionId: '555', conversionActionName: 'Android installs (test)', conversions: 0, allConversions: 0 },
    ])
  })
  it('conversionActionIdOf takes the trailing digits of an action resource name and nothing else', () => {
    expect(conversionActionIdOf(action('7000000001'))).toBe('7000000001')
    expect(conversionActionIdOf('conversionActions/42')).toBe('42')
    for (const bad of [undefined, null, 42, '', '111', 'customers/1/conversionActions/', 'customers/1/conversionActions/1x', 'customers/1/campaigns/111', `${action('1')}/x`, 'customers/1/conversionActions/123456789012345678901'])
      expect(conversionActionIdOf(bad)).toBeNull()
  })
})

describe('fetchDailyAssets (read-only GAQL)', () => {
  it('runs the one SELECT on ad_group_ad_asset_view, per ET day', async () => {
    const client = fakeClient([])
    await fetchDailyAssets(client, F3S, '2026-10-17', '2026-10-27')
    expect(client.queries).toEqual([dailyAssetsQuery(F3S, '2026-10-17', '2026-10-27')])
    expect(client.queries[0]).toMatch(/^SELECT segments\.date, campaign\.id, ad_group\.id, ad_group_ad\.ad\.id, asset\.id, asset\.type, asset\.name, asset\.text_asset\.text, ad_group_ad_asset_view\.field_type, ad_group_ad_asset_view\.performance_label, metrics\.impressions, metrics\.clicks, metrics\.conversions FROM ad_group_ad_asset_view WHERE /)
    expect(client.queries[0]).toContain(`campaign.id = ${F3S} AND segments.date BETWEEN '2026-10-17' AND '2026-10-27'`)
  })
  it('maps the probe shape: digit-string ids, int64 strings as numbers, the label, text and image name', async () => {
    const client = fakeClient([
      assetRow({ date: '2026-10-26', asset: '701', text: 'Sudoku with no ads', impressions: '120', clicks: '3', conversions: 1.5, label: 'LEARNING' }),
      assetRow({ date: '2026-10-26', asset: '702', type: 'IMAGE', name: 'hero-1200x628.png', field: 'MARKETING_IMAGE', impressions: '40', clicks: '0', label: 'UNKNOWN' }),
      assetRow({ date: '2026-10-26', asset: 703, adGroup: 501, ad: 601, field: 'DESCRIPTION', impressions: '0', clicks: '0' }), // numbers too
    ])
    const rows = await fetchDailyAssets(client, F3S, '2026-10-26', '2026-10-26')
    expect(rows).toEqual([
      { date: '2026-10-26', adGroupId: '501', adId: '601', assetId: '701', fieldType: 'HEADLINE', impressions: 120, clicks: 3, conversions: 1.5, performanceLabel: 'LEARNING', assetType: 'TEXT', text: 'Sudoku with no ads', name: null },
      { date: '2026-10-26', adGroupId: '501', adId: '601', assetId: '702', fieldType: 'MARKETING_IMAGE', impressions: 40, clicks: 0, conversions: 0, performanceLabel: 'UNKNOWN', assetType: 'IMAGE', text: null, name: 'hero-1200x628.png' },
      { date: '2026-10-26', adGroupId: '501', adId: '601', assetId: '703', fieldType: 'DESCRIPTION', impressions: 0, clicks: 0, conversions: 0, performanceLabel: 'NOT_APPLICABLE', assetType: 'TEXT', text: null, name: null },
    ])
    const text = JSON.stringify(rows)
    expect(text).not.toContain('customers/')
    expect(text).not.toContain(CUSTOMER)
  })
  it("drops a malformed row, ignores another campaign's row, and sums two rows for one key", async () => {
    const client = fakeClient([
      assetRow({ date: '2026-10-26', impressions: '10', clicks: '1' }),
      assetRow({ date: '2026-10-26', impressions: '5', clicks: '0', label: 'GOOD' }), // same key: summed, first label kept
      assetRow({ date: '2026-10-26', asset: '' }),
      assetRow({ date: '2026-10-26', asset: '7x' }),
      assetRow({ date: '2026-10-26', field: 'headline' }),
      assetRow({ date: '2026-10-26', field: 'BAD;FIELD' }),
      assetRow({ date: '2026-10-26', impressions: 'many' }),
      assetRow({ date: '2026-10-26', clicks: '-1' }),
      assetRow({ date: '2026/10/26' }),
      assetRow({ date: '2026-10-26', campaign: F4 }),
      { segments: { date: '2026-10-26' }, metrics: { impressions: '9' } }, // no ids at all
    ])
    const rows = await fetchDailyAssets(client, F3S, '2026-10-26', '2026-10-26')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ assetId: '701', impressions: 15, clicks: 1, performanceLabel: 'NOT_APPLICABLE' })
  })
})

describe('the fetchers refuse before any request, and never leak the customer id', () => {
  it('refuses an unknown campaign, a malformed id and a bad or empty range', async () => {
    const client = fakeClient([])
    for (const f of [fetchDailyConversions, fetchDailyAssets]) {
      await expect(f(client, '111111111', '2026-10-26', '2026-10-27')).rejects.toThrow(/not in lib\/campaigns/)
      await expect(f(client, `${F4} OR 1=1`, '2026-10-26', '2026-10-27')).rejects.toThrow(/invalid campaign id/)
      await expect(f(client, F4, "2026-10-26' OR '1'='1", '2026-10-27')).rejects.toThrow(/YYYY-MM-DD/)
      await expect(f(client, F4, '2026-10-27', '2026-10-26')).rejects.toThrow(/empty date range/)
    }
    expect(client.queries).toEqual([])
  })
  it("a failed search is rethrown with every customers/<id> path and the account's id masked", async () => {
    const failing: AdsClient = {
      async search() {
        throw new Error(`Google Ads search failed, HTTP 400: bad field on ${action('111')} for ${ADS_CUSTOMER_ID}`)
      },
    }
    for (const f of [fetchDailyConversions, fetchDailyAssets]) {
      const err = String(await f(failing, F4, '2026-10-26', '2026-10-27').catch((e) => e))
      expect(err).toMatch(/HTTP 400/)
      expect(err).not.toContain(CUSTOMER)
      expect(err).not.toContain(ADS_CUSTOMER_ID)
      expect(err).toContain('customers/<customer>/conversionActions/111')
    }
    expect(maskCustomerId('id 123-456-7890 and 1234567890', CUSTOMER)).toBe('id <customer> and <customer>')
  })
  it('over the real client: SELECT only, no login-customer-id header, no mutate endpoint', async () => {
    const calls: { url: string; headers: Record<string, string>; body?: string }[] = []
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body })
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [convRow('2026-10-26', '111', 4, 4)] }) }
    }
    const client = await createAdsClient({ developerToken: 'dev-token-made-up', accessToken: async () => 'access-token-made-up' }, { customerId: CUSTOMER, fetchImpl })
    expect(await fetchDailyConversions(client, F4, '2026-10-26', '2026-10-26')).toHaveLength(1)
    await fetchDailyAssets(client, F4, '2026-10-26', '2026-10-26')
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.url).toMatch(/\/googleAds:search$/)
      expect(c.url).not.toMatch(/mutate/i)
      expect(Object.keys(c.headers).map((k) => k.toLowerCase()).sort()).toEqual(['authorization', 'content-type', 'developer-token'])
      expect(JSON.parse(c.body!).query).toMatch(/^SELECT /)
    }
    await expect(client.search('UPDATE campaign SET status = PAUSED')).rejects.toThrow(/only runs GAQL SELECT/)
  })
})

// ── Merges and statement builders ────────────────────────────────────────────────────────
describe('merges and statement builders', () => {
  it('every statement passes the write guard and stays under the bind cap: 14 conversion, 9 asset, 16 catalog rows a statement', () => {
    const convs = Array.from({ length: 30 }, (_, i) => convDay(isoDay(i % 15), String(100 + Math.floor(i / 15)), i))
    const assets = Array.from({ length: 20 }, (_, i) => assetDay({ date: isoDay(0), assetId: String(800 + i) }))
    const catalog: AssetRecord[] = assets.map((a) => ({ assetId: a.assetId, type: 'TEXT', text: 't', name: null, firstSeen: a.date, lastSeen: a.date }))
    const sets = [
      { stmts: conversionDailyUpserts(F4, convs, 'now'), perRow: 7, sizes: [14, 14, 2] },
      { stmts: assetDailyUpserts(F3S, assets, 'now'), perRow: 11, sizes: [9, 9, 2] },
      { stmts: assetCatalogUpserts(catalog), perRow: 6, sizes: [16, 4] },
    ]
    for (const { stmts, perRow, sizes } of sets) {
      expect(stmts.map((s) => s.binds.length / perRow)).toEqual(sizes)
      for (const s of stmts) {
        expect(s.binds.length).toBeLessThanOrEqual(MAX_BINDS)
        expect(() => assertAdsWriteSql(s.sql)).not.toThrow()
        expect(s.sql).toMatch(/ON CONFLICT \([a-z_, ]+\) DO UPDATE SET .+ WHERE /)
      }
    }
    expect(conversionDailyUpserts(F4, [], 'now')).toEqual([])
    expect(assetDailyUpserts(F4, [], 'now')).toEqual([])
    expect(assetCatalogUpserts([])).toEqual([])
  })
  it('mergeConversionRows clips a long name and sorts by day, then action', () => {
    const merged = mergeConversionRows([convDay('2026-10-27', '2', 1), convDay('2026-10-26', '9', 1, 1, `  ${'n'.repeat(300)}  `), convDay('2026-10-26', '10', 1, 1, '   ')])
    expect(merged.map((r) => `${r.date}/${r.conversionActionId}`)).toEqual(['2026-10-26/10', '2026-10-26/9', '2026-10-27/2'])
    expect(merged[0].conversionActionName).toBeNull()
    expect(merged[1].conversionActionName).toHaveLength(200)
  })
  it('mergeAssetRows rounds counts, drops an unknown label or type, clips text and name', () => {
    const [r] = mergeAssetRows([assetDay({ date: '2026-10-26', impressions: 10.4, clicks: 1.6, performanceLabel: 'not a label', assetType: 'bad type', text: 'x'.repeat(ASSET_TEXT_MAX + 5), name: 'y'.repeat(ASSET_NAME_MAX + 5) })])
    expect(r).toMatchObject({ impressions: 10, clicks: 2, performanceLabel: null, assetType: null })
    expect(r.text).toHaveLength(ASSET_TEXT_MAX)
    expect(r.name).toHaveLength(ASSET_NAME_MAX)
  })
  it('assetCatalogFrom keeps one record per typed asset with its first and last day', () => {
    const catalog = assetCatalogFrom([
      assetDay({ date: '2026-10-27', assetId: '701', text: null }),
      assetDay({ date: '2026-10-25', assetId: '701', fieldType: 'DESCRIPTION', text: 'Ad-free sudoku' }),
      assetDay({ date: '2026-10-26', assetId: '702', assetType: 'IMAGE', text: null, name: 'hero.png', fieldType: 'MARKETING_IMAGE' }),
      assetDay({ date: '2026-10-26', assetId: '703', assetType: null }),
    ])
    expect(catalog).toEqual([
      { assetId: '701', type: 'TEXT', text: 'Ad-free sudoku', name: null, firstSeen: '2026-10-25', lastSeen: '2026-10-27' },
      { assetId: '702', type: 'IMAGE', text: null, name: 'hero.png', firstSeen: '2026-10-26', lastSeen: '2026-10-26' },
    ])
  })
  it('no statement binds a resource name or the customer id', async () => {
    const convs = await fetchDailyConversions(fakeClient([convRow('2026-10-26', '111', 4, 4)]), F4, '2026-10-26', '2026-10-26')
    const assets = await fetchDailyAssets(fakeClient([assetRow({ date: '2026-10-26', text: 'Sudoku with no ads' })]), F3S, '2026-10-26', '2026-10-26')
    const text = JSON.stringify([...conversionDailyUpserts(F4, convs, 'now'), ...assetCatalogUpserts(assetCatalogFrom(assets)), ...assetDailyUpserts(F3S, assets, 'now')])
    expect(text).not.toContain('customers/')
    expect(text).not.toContain(CUSTOMER)
  })
})

// ── The store: idempotent upserts against real migrated SQLite ────────────────────────────
describe('store upserts (migration 0007)', () => {
  it('putConversions is idempotent: an unchanged re-pull changes nothing, a restated day updates in place', async () => {
    const { sqlite, adapter, store } = await seeded()
    const rows = [convDay('2026-10-26', '111', 4), convDay('2026-10-27', '111', 20), convDay('2026-10-27', '222', 1.5, 2)]
    expect(await store.putConversions!(F4, rows, 't1')).toBe(true)
    const first = all(sqlite, 'ads_daily_conversions', 'date, conversion_action_id')
    expect(first).toHaveLength(3)
    expect(first.map((r) => r.fetched_at)).toEqual(['t1', 't1', 't1'])

    const mark = adapter.writes.length
    await store.putConversions!(F4, rows, 't2')
    expect(adapter.writes.slice(mark).map((w) => w.changes)).toEqual([0])
    expect(all(sqlite, 'ads_daily_conversions', 'date, conversion_action_id')).toEqual(first)

    // Ads restates 10-27 (20 -> 21), and a later pull has no name for 10-26: that keeps its name.
    const mark2 = adapter.writes.length
    await store.putConversions!(F4, [convDay('2026-10-26', '111', 4, 4, null), convDay('2026-10-27', '111', 21), convDay('2026-10-27', '222', 1.5, 2)], 't3')
    expect(adapter.writes.slice(mark2).map((w) => w.changes)).toEqual([1])
    const after = all(sqlite, 'ads_daily_conversions', 'date, conversion_action_id')
    expect(after.map((r) => [r.date, r.conversion_action_id, r.conversion_action_name, r.conversions, r.fetched_at])).toEqual([
      ['2026-10-26', '111', 'Installs', 4, 't1'],
      ['2026-10-27', '111', 'Installs', 21, 't3'],
      ['2026-10-27', '222', 'Installs', 1.5, 't1'],
    ])
    expect(await store.getConversionRows!(F4, '2026-10-27', '2026-10-27')).toEqual([convDay('2026-10-27', '111', 21), convDay('2026-10-27', '222', 1.5, 2)])
    expect(await store.getConversionRows!(F3S, '2026-10-01', '2026-10-31')).toEqual([])
  })
  it('putAssets writes the catalog before the daily rows and is idempotent', async () => {
    const { sqlite, adapter, store } = await seeded()
    const rows = [
      assetDay({ date: '2026-10-26', assetId: '701', performanceLabel: 'LEARNING' }),
      assetDay({ date: '2026-10-26', assetId: '702', assetType: 'IMAGE', text: null, name: 'hero.png', fieldType: 'MARKETING_IMAGE' }),
      assetDay({ date: '2026-10-27', assetId: '701', impressions: 50 }),
    ]
    const mark = adapter.writes.length
    await store.putAssets!(F3S, rows, 't1')
    expect(adapter.writes.slice(mark).map((w) => /^INSERT INTO (\w+)/.exec(w.sql)![1])).toEqual(['ads_assets', 'ads_daily_assets'])
    expect(count(sqlite, 'ads_daily_assets')).toBe(3)
    expect(all(sqlite, 'ads_assets', 'asset_id')).toEqual([
      { asset_id: '701', type: 'TEXT', text: 'Sudoku with no ads', name: null, first_seen: '2026-10-26', last_seen: '2026-10-27' },
      { asset_id: '702', type: 'IMAGE', text: null, name: 'hero.png', first_seen: '2026-10-26', last_seen: '2026-10-26' },
    ])
    const first = all(sqlite, 'ads_daily_assets', 'date, asset_id')
    const mark2 = adapter.writes.length
    await store.putAssets!(F3S, rows, 't2')
    expect(adapter.writes.slice(mark2).map((w) => w.changes)).toEqual([0, 0])
    expect(all(sqlite, 'ads_daily_assets', 'date, asset_id')).toEqual(first)
    expect(await store.getAssetRows!(F3S, '2026-10-27', '2026-10-27')).toEqual([{ ...assetDay({ date: '2026-10-27', assetId: '701', impressions: 50 }), assetType: null, text: null }])
  })
  it("keeps a day's first stored label, fills a blank one, and updates restated counts", async () => {
    const { sqlite, store } = await seeded()
    await store.putAssets!(F3S, [assetDay({ date: '2026-10-26', assetId: '701', performanceLabel: 'LEARNING' }), assetDay({ date: '2026-10-26', assetId: '702' })], 't1')
    await store.putAssets!(F3S, [assetDay({ date: '2026-10-26', assetId: '701', performanceLabel: 'GOOD', clicks: 3 }), assetDay({ date: '2026-10-26', assetId: '702', performanceLabel: 'LOW' })], 't2')
    expect(all(sqlite, 'ads_daily_assets', 'asset_id').map((r) => [r.asset_id, r.performance_label, r.clicks, r.fetched_at])).toEqual([
      ['701', 'LEARNING', 3, 't2'],
      ['702', 'LOW', 2, 't2'],
    ])
  })
  it('the catalog only widens its first and last day, and a blank text or name keeps the stored one', async () => {
    const { sqlite, adapter, store } = await seeded()
    await store.putAssets!(F3S, [assetDay({ date: '2026-10-20', assetId: '701' })], 't1')
    await store.putAssets!(F3S, [assetDay({ date: '2026-10-26', assetId: '701', text: null })], 't2')
    await store.putAssets!(F3S, [assetDay({ date: '2026-10-18', assetId: '701', text: 'Edited copy' })], 't3')
    expect(all(sqlite, 'ads_assets', 'asset_id')).toEqual([{ asset_id: '701', type: 'TEXT', text: 'Edited copy', name: null, first_seen: '2026-10-18', last_seen: '2026-10-26' }])
    const mark = adapter.writes.length
    await store.putAssets!(F3S, [assetDay({ date: '2026-10-22', assetId: '701', text: null })], 't4') // inside the span, nothing new
    expect(adapter.writes.slice(mark).map((w) => [/^INSERT INTO (\w+)/.exec(w.sql)![1], w.changes])).toEqual([
      ['ads_assets', 0],
      ['ads_daily_assets', 1],
    ])
  })
  it('a dry run writes nothing (reads still work)', async () => {
    const { sqlite, store } = await seeded({ dryRun: true })
    expect(await store.putConversions!(F4, [convDay('2026-10-26', '111', 4)], 't1')).toBe(false)
    expect(await store.putAssets!(F3S, [assetDay({ date: '2026-10-26' })], 't1')).toBe(false)
    for (const t of NEW_TABLES) expect(count(sqlite, t)).toBe(0)
    expect(await store.getConversionRows!(F4, '2026-10-01', '2026-10-31')).toEqual([])
  })
  it('a 280-row asset backfill splits into 9-row statements, all under the bind cap', async () => {
    const { sqlite, adapter, store } = await seeded()
    const rows = Array.from({ length: 280 }, (_, i) => assetDay({ date: isoDay(i % 11), assetId: String(700 + Math.floor(i / 11)) }))
    const mark = adapter.writes.length
    await store.putAssets!(F3S, rows, 't1')
    const daily = adapter.writes.slice(mark).filter((w) => w.sql.startsWith('INSERT INTO ads_daily_assets'))
    expect(daily).toHaveLength(Math.ceil(280 / 9))
    expect(count(sqlite, 'ads_daily_assets')).toBe(280)
    expect(count(sqlite, 'ads_assets')).toBe(Math.ceil(280 / 11))
  })
})

// ── The pass itself (lib/adsSync.ts syncAdsExtras) over a fake AdsExtrasSource ───────────
describe('syncAdsExtras: restatement, the spend-only arm, run rows and the backfill', () => {
  const t0 = Date.parse('2026-10-28T13:00:00Z') // 09:00 EDT: closed days through 10-27
  const iso = (ms: number) => new Date(ms).toISOString()
  const A = '9000000001'
  const B = '9000000002'
  const F4_ACTION = '9000000003'
  const opts = (now: number, o: Partial<ExtrasOptions> = {}): ExtrasOptions => ({ now, dryRun: false, source: 'worker-cron', ...o })
  /** A fake source over mutable per-campaign rows; it records every pull. */
  function fakeExtras(data: { conversions: Record<string, ConversionDayRow[]>; assets: Record<string, AssetDayRow[]> }) {
    const calls: { kind: ExtrasKind; id: string; since: string; until: string }[] = []
    const pick = <T extends { date: string }>(rows: T[] | undefined, since: string, until: string) => (rows ?? []).filter((r) => r.date >= since && r.date <= until).map((r) => ({ ...r }))
    const source: AdsExtrasSource = {
      conversions: async (id, since, until) => (calls.push({ kind: 'conversions', id, since, until }), pick(data.conversions[id], since, until)),
      assets: async (id, since, until) => (calls.push({ kind: 'assets', id, since, until }), pick(data.assets[id], since, until)),
    }
    const pulls = (from = 0, id?: string) => fake.calls.slice(from).filter((c) => !id || c.id === id).map((c) => `${c.kind} ${c.since}..${c.until}`).sort()
    const fake = { source, calls, data, pulls }
    return fake
  }
  /** Every syncable campaign in ads_campaigns (the default campaign set). */
  async function seededAll(o: { dryRun?: boolean } = {}) {
    const s = setup()
    await s.store.syncCampaigns(syncableCampaigns(), '2026-10-28T00:00:00Z')
    return o.dryRun ? { ...s, store: createSqlAdsStore(s.adapter, { dryRun: true, kind: 'sqlite' }) } : s
  }
  const rows = (sqlite: ReturnType<typeof openMigratedSqlite>, sql: string, ...binds: string[]) => sqlite.prepare(sql).all(...binds).map((r) => ({ ...r }))

  it('after the 6 h re-check it re-pulls only the restatement window: a restated count updates in place, a dropped action zero-fills, older days stay', async () => {
    const { sqlite, store } = await seeded()
    const f3sDays = etDateRange('2026-10-17', '2026-10-27')
    const fake = fakeExtras({
      conversions: { [F3S]: [...f3sDays.map((d) => convDay(d, A, 1)), convDay('2026-10-27', B, 2)] },
      assets: { [F3S]: f3sDays.map((d) => assetDay({ date: d, impressions: 100, clicks: 2 })) },
    })
    const run = (now: number) => syncAdsExtras({ ads: fake.source, store }, opts(now, { campaignIds: [F3S] }))
    const conv = (date: string, actionId: string) => ({ ...sqlite.prepare('SELECT conversions, all_conversions, fetched_at FROM ads_daily_conversions WHERE campaign_id = ? AND date = ? AND conversion_action_id = ?').get(F3S, date, actionId) })
    const asset = (date: string) => ({ ...sqlite.prepare('SELECT impressions, fetched_at FROM ads_daily_assets WHERE campaign_id = ? AND date = ?').get(F3S, date) })

    const r1 = await run(t0)
    expect(r1.status).toBe('ok')
    expect(fake.pulls()).toEqual(['assets 2026-10-17..2026-10-24', 'assets 2026-10-25..2026-10-27', 'conversions 2026-10-17..2026-10-24', 'conversions 2026-10-25..2026-10-27'])
    expect([count(sqlite, 'ads_daily_conversions'), count(sqlite, 'ads_daily_assets')]).toEqual([12, 11])

    // an hour later: everything stored, the re-check not due -> one state read, no pull
    let from = fake.calls.length
    const r2 = await run(t0 + 3_600_000)
    expect([r2.nothingDue, fake.calls.length - from]).toEqual([true, 0])

    // Google restates 10-26 and drops action B from 10-27 (A stays); 10-20 changes too, outside the window
    const convs = fake.data.conversions[F3S]
    convs[convs.findIndex((r) => r.date === '2026-10-26')] = convDay('2026-10-26', A, 3)
    convs.splice(convs.findIndex((r) => r.conversionActionId === B), 1)
    convs[convs.findIndex((r) => r.date === '2026-10-20')] = convDay('2026-10-20', A, 9)
    const assets = fake.data.assets[F3S]
    assets[assets.findIndex((r) => r.date === '2026-10-25')] = assetDay({ date: '2026-10-25', impressions: 150, clicks: 2 })
    assets[assets.findIndex((r) => r.date === '2026-10-20')] = assetDay({ date: '2026-10-20', impressions: 999, clicks: 2 })

    from = fake.calls.length
    const r3 = await run(t0 + RESTATEMENT_RECHECK_MS)
    expect(r3.status).toBe('ok')
    expect(fake.pulls(from)).toEqual(['assets 2026-10-25..2026-10-27', 'conversions 2026-10-25..2026-10-27'])
    expect(conv('2026-10-26', A)).toEqual({ conversions: 3, all_conversions: 3, fetched_at: r3.startedAt })
    expect(conv('2026-10-27', B)).toEqual({ conversions: 0, all_conversions: 0, fetched_at: r3.startedAt }) // zero-filled, kept
    expect(conv('2026-10-27', A)).toEqual({ conversions: 1, all_conversions: 1, fetched_at: r1.startedAt }) // unchanged: not rewritten
    expect(conv('2026-10-20', A)).toEqual({ conversions: 1, all_conversions: 1, fetched_at: r1.startedAt }) // outside the window
    expect(asset('2026-10-25')).toEqual({ impressions: 150, fetched_at: r3.startedAt })
    expect(asset('2026-10-20')).toEqual({ impressions: 100, fetched_at: r1.startedAt })
    expect([count(sqlite, 'ads_daily_conversions'), count(sqlite, 'ads_daily_assets')]).toEqual([12, 11])
    const f3s3 = r3.campaigns.find((c) => c.campaignId === F3S)!
    expect([f3s3.conversions.rowsChanged, f3s3.assets.rowsChanged]).toEqual([2, 1])

    // six hours on, Google answers no conversion rows over stored days: an error, nothing deleted
    fake.data.conversions[F3S] = []
    const before = all(sqlite, 'ads_daily_conversions', 'date, conversion_action_id').map((r) => ({ ...r }))
    const r4 = await run(t0 + 2 * RESTATEMENT_RECHECK_MS)
    const f3s4 = r4.campaigns.find((c) => c.campaignId === F3S)!
    expect(r4.status).toBe('partial')
    expect(f3s4.conversions).toMatchObject({ ok: false, stale: true })
    expect(f3s4.conversions.error).toBeTruthy()
    expect(f3s4.assets).toMatchObject({ ok: true, stale: false, rowsChanged: 0 })
    expect(all(sqlite, 'ads_daily_conversions', 'date, conversion_action_id').map((r) => ({ ...r }))).toEqual(before)
  })

  it('includes the spend-only arm (F4): both kinds are pulled for it and its rows stored', async () => {
    expect(campaignById(F4)!.measurement).toBe('spend-only')
    const { sqlite, store } = await seededAll()
    const fake = fakeExtras({
      conversions: { [F4]: [convDay('2026-10-26', F4_ACTION, 4), convDay('2026-10-27', F4_ACTION, 20)] },
      assets: { [F4]: [assetDay({ date: '2026-10-27', impressions: 40, clicks: 1 })] },
    })
    const r = await syncAdsExtras({ ads: fake.source, store }, opts(t0)) // the default campaign set, no caps
    expect(fake.pulls(0, F4)).toEqual(['assets 2026-10-26..2026-10-27', 'conversions 2026-10-26..2026-10-27'])
    const f4 = r.campaigns.find((c) => c.campaignId === F4)!
    expect([f4.conversions.ok, f4.conversions.through, f4.assets.ok, f4.assets.through]).toEqual([true, '2026-10-27', true, '2026-10-27'])
    expect(rows(sqlite, 'SELECT date, conversion_action_id, conversions FROM ads_daily_conversions WHERE campaign_id = ? ORDER BY date', F4)).toEqual([
      { date: '2026-10-26', conversion_action_id: F4_ACTION, conversions: 4 },
      { date: '2026-10-27', conversion_action_id: F4_ACTION, conversions: 20 },
    ])
    expect(count(sqlite, 'ads_daily_assets', 'campaign_id = ?', F4)).toBe(1)
  })

  it('extras run rows never count as a cost sync (LAST_SYNC_SQL, LAST_RUN_SQL, the claim); LAST_EXTRAS_RUN_SQL reads only them', async () => {
    const { sqlite, store } = await seeded()
    const fake = fakeExtras({ conversions: { [F4]: [convDay('2026-10-27', F4_ACTION, 1)] }, assets: {} })
    const r = await syncAdsExtras({ ads: fake.source, store }, opts(t0, { campaignIds: [F4] }))
    expect(r.runRecorded).toBe(true)
    const extrasRows = rows(sqlite, "SELECT * FROM ads_sync_runs WHERE run_key LIKE 'extras:%'")
    expect(extrasRows).toHaveLength(1)
    expect(extrasRows[0]).toMatchObject({ campaigns_ok: '[]', campaigns_pulled: '[]', days_fetched: 0, days_changed: 0, placement_rows_fetched: 0, placement_rows_changed: 0 })

    // one cost run at T1, then 60 newer extras rows (more than LAST_SYNC_SQL's 50-run scan) that,
    // read as cost runs, would claim a sync of F3S
    const T1 = t0 + 60_000
    const record = (runKey: string, at: number, campaignsOk: string[]): SyncRunRecord => ({
      runKey, source: 'worker-cron', startedAt: iso(at - 1000), finishedAt: iso(at), campaigns: campaignsOk, campaignsOk, campaignsPulled: campaignsOk,
      daysFetched: 1, daysChanged: 1, placementRowsFetched: 0, placementRowsChanged: 0, status: 'ok', error: null, detail: {},
    })
    await store.appendSyncRun(record(`sync:worker-cron:${iso(T1)}:${F4}`, T1, [F4]))
    const newest = T1 + 60 * 60_000
    for (let i = 1; i <= 60; i++) await store.appendSyncRun(record(`extras:worker-cron:${iso(T1 + i * 60_000)}:${F3S}`, T1 + i * 60_000, [F3S]))
    expect(rows(sqlite, LAST_SYNC_SQL)).toEqual([{ campaign_id: F4, last_sync: iso(T1) }])
    expect(rows(sqlite, LAST_RUN_SQL)).toEqual([{ last: iso(T1) }])
    expect(await readLastSyncRun(sqliteD1(sqlite))).toBe(iso(T1))
    // a claim a minute after the newest extras row: the cost window only sees T1, an hour back
    expect(await store.claimSync('worker-cron', newest + 60_000, 15 * 60_000)).toBe(true)
    expect(await store.claimSync('worker-cron', newest + 120_000, 15 * 60_000)).toBe(false) // its own claim does block
    // and the pass's own state read skips a newer cost row
    await store.appendSyncRun(record(`sync:worker-cron:${iso(newest + 180_000)}:${F4}`, newest + 180_000, [F4]))
    expect(rows(sqlite, LAST_EXTRAS_RUN_SQL)[0].finished_at).toBe(iso(newest))
    expect((await store.getLastExtrasRun!())!.finishedAt).toBe(iso(newest))
  })

  it('a re-check too big for one run is split, newest days first, and stays due until all 3 days are in', async () => {
    const days = etDateRange('2026-10-17', '2026-10-27')
    const fake = fakeExtras({
      conversions: { [F3S]: days.map((d) => convDay(d, A, 1)) },
      assets: { [F3S]: days.flatMap((d) => Array.from({ length: 80 }, (_, i) => assetDay({ date: d, assetId: String(700 + i) }))) },
    })
    const { store } = await seededAll()
    const caps = { campaignIds: [F3S], maxRows: 120, statementBudget: 38 }
    const drain = async (start: number) => {
      const runs: Awaited<ReturnType<typeof syncAdsExtras>>[] = []
      for (let i = 0; i < 40; i++) {
        const r = await syncAdsExtras({ ads: fake.source, store }, opts(start + i * 60_000, caps))
        if (r.nothingDue) return runs
        expect(JSON.stringify(r)).not.toContain('D1 query budget')
        runs.push(r)
      }
      throw new Error('never caught up')
    }
    const fill = await drain(t0)
    // the first run plans with the default 40 asset rows a day; later runs with the 80 learned
    for (const r of fill.slice(1)) expect(r.conversionRowsFetched + r.assetRowsFetched).toBeLessThanOrEqual(120)
    expect(fill.at(-1)!.campaigns.find((c) => c.campaignId === F3S)!.assets).toMatchObject({ through: '2026-10-27', stale: false })
    // 7 h later the re-check is due: a day per run (80 rows each), newest first, each day once
    const from = fake.calls.length
    const recheck = await drain(t0 + 7 * 3_600_000)
    const pulled = fake.calls.slice(from).filter((x) => x.kind === 'assets').flatMap((x) => etDateRange(x.since, x.until))
    expect(pulled).toEqual(['2026-10-27', '2026-10-26', '2026-10-25'])
    expect(recheck).toHaveLength(3)
    for (const r of recheck) expect(r.conversionRowsFetched + r.assetRowsFetched).toBeLessThanOrEqual(120)
    expect(recheck.at(-1)!.status).toBe('ok')
  })

  it('the backfill (full, no caps) pulls every campaign whole in one run; a rerun changes nothing; --dry-run writes nothing', async () => {
    // scripts/ads-reads/backfill.ts calls the pass with full and no cap
    const src = readFileSync(fileURLToPath(new URL('./backfill.ts', import.meta.url)), 'utf8')
    const call = src.match(/syncAdsExtras\(([^\n]*)\)/)![1]
    expect(call).toContain('full: true')
    expect(call).toContain("source: 'backfill'")
    expect(call).not.toMatch(/maxRows|statementBudget/)

    const f3sDays = etDateRange('2026-10-17', '2026-10-27')
    const data = () => ({
      conversions: { [F3S]: f3sDays.map((d) => convDay(d, A, 1)), [F4]: [convDay('2026-10-26', F4_ACTION, 4), convDay('2026-10-27', F4_ACTION, 20)] },
      assets: { [F3S]: f3sDays.flatMap((d) => Array.from({ length: 25 }, (_, i) => assetDay({ date: d, assetId: String(700 + i) }))) },
    })
    const backfill = { source: 'backfill' as const, full: true }
    const { sqlite, store } = await seededAll()
    const fake = fakeExtras(data())
    const r = await syncAdsExtras({ ads: fake.source, store }, opts(t0, backfill))
    expect(r.status).toBe('ok')
    expect(r.waiting).toEqual([])
    expect(r.campaigns.filter((c) => c.conversions.deferred || c.assets.deferred)).toEqual([])
    for (const c of syncableCampaigns()) {
      const w = extrasWindow(c, '2026-10-28', t0)
      if (!w) continue
      for (const kind of ['conversions', 'assets'] as const) {
        const pulled = new Set(fake.calls.filter((x) => x.id === c.id && x.kind === kind).flatMap((x) => etDateRange(x.since, x.until)))
        expect([...pulled].sort(), `${c.id} ${kind}`).toEqual(etDateRange(w.since, w.until))
      }
    }
    expect([count(sqlite, 'ads_daily_conversions'), count(sqlite, 'ads_daily_assets', 'campaign_id = ?', F3S), count(sqlite, 'ads_assets')]).toEqual([13, 275, 25])

    // a rerun re-pulls everything and changes nothing
    const first = fake.calls.length
    const again = await syncAdsExtras({ ads: fake.source, store }, opts(t0 + 60_000, backfill))
    expect(fake.calls.length - first).toBe(first)
    expect([again.conversionRowsFetched, again.assetRowsFetched]).toEqual([r.conversionRowsFetched, r.assetRowsFetched])
    expect([again.conversionRowsChanged, again.assetRowsChanged]).toEqual([0, 0])

    // --dry-run: the same pulls, no row and no run row written
    const dry = await seededAll({ dryRun: true })
    const runsBefore = count(dry.sqlite, 'ads_sync_runs')
    const dr = await syncAdsExtras({ ads: fakeExtras(data()).source, store: dry.store }, opts(t0, { ...backfill, dryRun: true }))
    expect(dr.runRecorded).toBe(false)
    expect(NEW_TABLES.map((t) => count(dry.sqlite, t))).toEqual([0, 0, 0])
    expect(count(dry.sqlite, 'ads_sync_runs')).toBe(runsBefore)
  })
})
