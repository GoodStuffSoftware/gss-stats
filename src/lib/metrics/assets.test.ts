// Ad assets per campaign (asset.impressions / asset.clicks / asset.conversions and the RepeatSpec
// axis over 'assets'), data path first: the engine on a node:sqlite ads store built from the real
// migrations (0001..0007), the way adsInstalls.test.ts runs the installs side. Counts only: Google's
// own per-asset aggregates per ET day, no user-level value. All ids below are made up.
//   scoping           an asset's figures are its rows in the requested campaign only
//   sum over ads      one asset served by two ads on a day is one daily point (the sum)
//   gap, not zero     a day the asset has no row is no series point
//   fail soft         no ads database: nothing is read, and a stub that throws gives null, never an error
import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { CAMPAIGNS } from '../campaigns'
import { etDateFast } from '../etTime'
import { CAMPAIGN_ASSETS_SQL, readCampaignAssets, type D1Reader } from '../adsStore'
import { buildFact, deriveBatch, newSideMemo, planBatch, type FactResult } from './engine'
import { FACTS } from './facts'
import { METRICS } from './metrics'
import { assetScopeOf } from './readingsScope'
import { resolveBinding, resolveRepeat, sortAssets, usesAssets, type AssetScope, type RepeatContext } from './scope'
import { assetSeries, seriesTwin } from './series'
import { ASSET_SORT_FIELDS, type CardSpec, type MetricValue } from './types'
import { validateCard, validateMetricsRequest } from './validate'
import { UNITS } from './units'

const CAMP = CAMPAIGNS[0].id // a registered campaign
const OTHER = CAMPAIGNS[1].id // another registered campaign
const A = '9200000001' // headline, two ads in CAMP
const B = '9200000002' // description, text missing: falls back to its name
const C = '9200000003' // image: neither text nor name, no catalog row at all
const D = '9200000004' // headline, only in OTHER
const NOW = Date.parse('2026-10-28T16:00:00Z')
const CTX = { since: '2026-10-26', until: '2026-10-28', sites: ['bestsudoku-web'] }

interface AssetRow {
  campaign: string
  ad: string
  asset: string
  field: string
  date: string
  imp: number
  clicks: number
  conv: number
}
const row = (campaign: string, ad: string, asset: string, field: string, date: string, imp: number, clicks: number, conv: number): AssetRow => ({ campaign, ad, asset, field, date, imp, clicks, conv })

/** The real ads schema (every migration, in order), with only the rows the case needs. */
function adsDb(rows: AssetRow[], catalog: { id: string; type: string; text: string | null; name: string | null }[] = []): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  const dir = 'migrations/gss-stats-ads'
  for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) db.exec(readFileSync(`${dir}/${f}`, 'utf8'))
  for (const id of new Set(rows.map((r) => r.campaign))) {
    db.prepare(
      "INSERT INTO ads_campaigns (id, name, uc_values, kind, flight_start, flight_end, status, measurement, synced_at) VALUES (?, 'x', '[]', 'web', '2026-10-26', '2026-11-02', 'active', 'spend-only', '2026-10-28T00:00:00Z')",
    ).run(id)
  }
  for (const r of rows) {
    db.prepare(
      "INSERT INTO ads_daily_assets (campaign_id, ad_group_id, ad_id, asset_id, field_type, date, impressions, clicks, conversions, source, fetched_at) VALUES (?, '5100000001', ?, ?, ?, ?, ?, ?, ?, 'google-ads-api', '2026-10-28T00:00:00Z')",
    ).run(r.campaign, r.ad, r.asset, r.field, r.date, r.imp, r.clicks, r.conv)
  }
  for (const c of catalog) {
    db.prepare("INSERT INTO ads_assets (asset_id, type, text, name, first_seen, last_seen) VALUES (?, ?, ?, ?, '2026-10-26', '2026-10-28')").run(c.id, c.type, c.text, c.name)
  }
  return db
}

/** The batch the way functions/api/metrics.ts runs it (the ads side only). */
function run(db: DatabaseSync | null, requests: Record<string, unknown>[], context: Record<string, unknown> = CTX) {
  const batch = validateMetricsRequest(JSON.stringify({ v: 1, context, requests }))
  if (!batch.ok) throw new Error(batch.error)
  const env = { context: batch.context, nowMs: NOW, todayEt: etDateFast(NOW), hasAdsDb: db !== null }
  const memo = newSideMemo()
  const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env, memo)
  const facts = new Map<string, FactResult>()
  for (const f of plan.facts) {
    if (!db) continue
    const stmt = buildFact(f, NOW)
    if (stmt.db !== 'gss_stats_ads') throw new Error(`unexpected geo fact ${f.id}`)
    const raw = db.prepare(stmt.sql).all(...(stmt.binds as never[])) as Record<string, unknown>[]
    facts.set(f.key, { ok: true, rows: FACTS[f.id].parse(raw), asOfMs: NOW })
  }
  return { results: deriveBatch(batch.requests, { ...env, facts }, memo), plan }
}
const asset = (metric: string, assetId: string, campaignId = CAMP, extra: Record<string, unknown> = {}) => ({ key: `${metric}:${assetId}:${campaignId}`, metric, window: 'attribution', params: { campaignId, assetId }, ...extra })

const ROWS: AssetRow[] = [
  row(CAMP, '7100000001', A, 'HEADLINE', '2026-10-26', 100, 5, 1),
  row(CAMP, '7100000001', A, 'HEADLINE', '2026-10-27', 200, 12, 2.5),
  row(CAMP, '7100000002', A, 'HEADLINE', '2026-10-27', 50, 3, 0.5), // the same asset in a second ad: one daily point, the sum
  row(CAMP, '7100000001', B, 'DESCRIPTION', '2026-10-27', 80, 2, 0),
  row(CAMP, '7100000001', C, 'MARKETING_IMAGE', '2026-10-26', 30, 1, 0),
  row(OTHER, '7100000009', A, 'HEADLINE', '2026-10-27', 5000, 1000, 40), // the same asset in ANOTHER campaign: never in CAMP's figures
  row(OTHER, '7100000009', D, 'HEADLINE', '2026-10-27', 70, 7, 0),
]
const CATALOG = [
  { id: A, type: 'TEXT', text: 'Free daily sudoku', name: null },
  { id: B, type: 'TEXT', text: null, name: 'Long description one' },
  { id: D, type: 'TEXT', text: 'Other campaign headline', name: null },
]

describe('registry', () => {
  it('registers the three metrics on the adsAssetDaily fact, per campaign and asset, and they have a daily series', () => {
    for (const [id, unit] of [
      ['asset.impressions', 'impression'],
      ['asset.clicks', 'click'],
      ['asset.conversions', 'conversion'],
    ] as const) {
      const def = METRICS.get(id)!
      expect(def).toMatchObject({ unit, params: ['campaignId', 'assetId'], windows: { attribution: 'adsAssetDaily' } })
      expect(def.caveats).toContain('ads-assets-google')
      expect(seriesTwin(def, 'attribution')).toBe('adsAssetDaily')
      expect(UNITS).toContain(unit)
    }
  })
  it('the fact reads the ads database only, keyed by campaign', () => {
    expect(FACTS.adsAssetDaily.db).toBe('gss_stats_ads')
    expect(FACTS.adsAssetDaily.keyParams).toEqual(['campaignId'])
  })
})

describe('the per-asset fact on the real schema', () => {
  it('one row per (asset, field type, day) for the requested campaign: ads summed, the other campaign left out', () => {
    const stmt = buildFact({ id: 'adsAssetDaily', params: { campaignId: CAMP } } as never, NOW)
    expect(stmt.db).toBe('gss_stats_ads')
    expect(stmt.binds).toEqual([CAMP])
    const raw = adsDb(ROWS).prepare(stmt.sql).all(...(stmt.binds as never[])) as Record<string, unknown>[]
    const rows = FACTS.adsAssetDaily.parse(raw)
    expect(rows).toMatchObject({ kind: 'assetDaily' })
    const list = (rows as { rows: { assetId: string; fieldType: string; date: string; impressions: number; clicks: number; conversions: number }[] }).rows
    expect(list.filter((r) => r.assetId === A)).toEqual([
      { assetId: A, fieldType: 'HEADLINE', date: '2026-10-26', impressions: 100, clicks: 5, conversions: 1 },
      { assetId: A, fieldType: 'HEADLINE', date: '2026-10-27', impressions: 250, clicks: 15, conversions: 3 },
    ])
    expect(list.some((r) => r.assetId === D)).toBe(false) // D only runs in OTHER
    expect(list.reduce((a, r) => a + r.clicks, 0)).toBe(5 + 15 + 2 + 1) // not the 1000 + 7 of the other campaign
  })
})

describe('asset metrics', () => {
  const db = () => adsDb(ROWS, CATALOG)
  it('per asset and per day: the asset total is the sum of its days across its ads, and the series is those days', () => {
    const { results: r } = run(db(), [
      asset('asset.clicks', A, CAMP, { series: 'daily' }),
      asset('asset.impressions', A, CAMP, { series: 'daily' }),
      asset('asset.conversions', A, CAMP, { series: 'daily' }),
    ])
    const clicks = r[`asset.clicks:${A}:${CAMP}`] as MetricValue
    expect(clicks.value).toBe(20)
    expect(clicks.series).toEqual([
      { day: '2026-10-26', value: 5 },
      { day: '2026-10-27', value: 15 },
    ])
    expect(clicks.noteIds).toContain('ads-assets-google')
    const imp = r[`asset.impressions:${A}:${CAMP}`] as MetricValue
    expect(imp.value).toBe(350)
    expect(imp.series).toEqual([
      { day: '2026-10-26', value: 100 },
      { day: '2026-10-27', value: 250 },
    ])
    const conv = r[`asset.conversions:${A}:${CAMP}`] as MetricValue
    expect(conv.value).toBe(4) // 1 + 2.5 + 0.5, fractional credit kept
    expect(conv.series!.map((p) => p.value)).toEqual([1, 3])
  })
  it('two assets in one batch stay apart (the request keys carry the asset id)', () => {
    const { results: r } = run(db(), [asset('asset.clicks', A), asset('asset.clicks', B), asset('asset.clicks', C)])
    expect([A, B, C].map((id) => (r[`asset.clicks:${id}:${CAMP}`] as MetricValue).value)).toEqual([20, 2, 1])
  })
  it('scoped by campaign: the same asset id in another campaign is that campaign\'s figure, and an asset the campaign never ran has none', () => {
    const { results: r } = run(db(), [asset('asset.clicks', A, OTHER), asset('asset.clicks', D, CAMP), asset('asset.clicks', D, OTHER)])
    expect((r[`asset.clicks:${A}:${OTHER}`] as MetricValue).value).toBe(1000)
    expect(r[`asset.clicks:${D}:${CAMP}`]).toMatchObject({ value: null })
    expect((r[`asset.clicks:${D}:${OTHER}`] as MetricValue).value).toBe(7)
  })
  it('a day the asset has no row is a gap, never a zero (B has only 10-27)', () => {
    const { results: r } = run(db(), [asset('asset.clicks', B, CAMP, { series: 'daily' })])
    expect((r[`asset.clicks:${B}:${CAMP}`] as MetricValue).series).toEqual([{ day: '2026-10-27', value: 2 }])
  })
  it('fail soft: with no ads database nothing is read and the metric has no value, never an error', () => {
    const { results: r, plan } = run(null, [asset('asset.clicks', A)])
    expect(plan.statements).toBe(0)
    expect(r[`asset.clicks:${A}:${CAMP}`]).toMatchObject({ status: 'error' })
  })
  it('a failed statement is a not-ok fact: no value, the rest of the batch unaffected', () => {
    const batch = validateMetricsRequest(JSON.stringify({ v: 1, context: CTX, requests: [asset('asset.clicks', A), { key: 'p', metric: 'bsk.pageviews', window: 'attribution' }] }))
    if (!batch.ok) throw new Error(batch.error)
    const env = { context: batch.context, nowMs: NOW, todayEt: etDateFast(NOW), hasAdsDb: true }
    const memo = newSideMemo()
    const plan = planBatch(batch.requests.flatMap((r) => (r.ok ? [r.req] : [])), env, memo)
    const facts = new Map<string, FactResult>()
    for (const f of plan.facts) if (f.id === 'adsAssetDaily') facts.set(f.key, { ok: false, error: 'no such table: ads_daily_assets' } as FactResult)
    const r = deriveBatch(batch.requests, { ...env, facts }, memo)
    expect(r[`asset.clicks:${A}:${CAMP}`]).toMatchObject({ status: 'error' })
  })
})

describe('validation of the asset param and the repeat fields', () => {
  const bad = (params: Record<string, unknown>) => {
    const b = validateMetricsRequest(JSON.stringify({ v: 1, context: CTX, requests: [{ key: 'x', metric: 'asset.clicks', window: 'attribution', params }] }))
    if (!b.ok) throw new Error(b.error)
    return b.requests[0].ok ? null : 'refused'
  }
  it('an asset id is digits only; anything else (or an unconfigured campaign) is refused', () => {
    expect(bad({ campaignId: CAMP, assetId: A })).toBeNull()
    expect(bad({ campaignId: CAMP, assetId: "1' OR 1=1" })).toBe('refused')
    expect(bad({ campaignId: CAMP, assetId: '' })).toBe('refused')
    expect(bad({ campaignId: CAMP, assetId: '1'.repeat(21) })).toBe('refused')
    expect(bad({ campaignId: '123', assetId: A })).toBe('refused')
  })
  const card = (repeat: CardSpec['repeat'], data = { metric: 'asset.clicks' } as never): CardSpec => ({
    v: 1,
    repeat,
    sections: [{ layout: 'rows', items: [{ id: 'x', label: { bind: 'asset.label' }, data, display: { as: 'number' } }] }],
  })
  it('an assets repeat provides assetId and campaignId; sortBy, limit and campaignId are checked', () => {
    expect(validateCard(card({ over: 'assets', campaignId: CAMP, sortBy: 'clicks', limit: 5 }))).toEqual([])
    expect(validateCard(card({ over: 'assets', ids: [A] })).join()).toMatch(/campaignId/) // a standalone assets repeat names its campaign
    expect(validateCard(card({ over: 'assets', sortBy: 'spend' as never })).join()).toMatch(/sortBy/)
    expect(validateCard(card({ over: 'assets', limit: 0 })).join()).toMatch(/limit/)
    expect(validateCard(card({ over: 'assets', ids: ['abc'] })).join()).toMatch(/not an asset id/)
    expect(validateCard(card({ over: 'assets', campaignId: '123' })).join()).toMatch(/campaignId/)
    expect(validateCard(card({ over: 'campaigns', sortBy: 'clicks' })).join()).toMatch(/sortBy/)
    expect(validateCard(card({ over: 'campaigns', campaignId: CAMP })).join()).toMatch(/campaignId/)
  })
  it('inside a campaign repeat, a section repeat over assets needs no pinned campaign', () => {
    const spec: CardSpec = {
      v: 1,
      repeat: { over: 'campaigns', ids: [CAMP] },
      sections: [{ layout: 'rows', repeat: { over: 'assets', sortBy: 'clicks', limit: 3 }, items: [{ id: 'x', label: { bind: 'asset.label' }, data: { metric: 'asset.clicks' }, display: { as: 'number' } }] }],
    }
    expect(validateCard(spec)).toEqual([])
    expect(usesAssets(spec)).toBe(true)
    expect(usesAssets(card({ over: 'campaigns' }))).toBe(false)
  })
})

describe('the assets repeat', () => {
  const mk = (id: string, label: string, imp: number, clicks: number, conv = 0, campaignId = CAMP): AssetScope => ({ id, campaignId, label, impressions: imp, clicks, conversions: conv })
  const list = [mk('1', 'Headline: b', 100, 5), mk('2', 'Headline: a', 100, 9), mk('3', 'Description: z', 400, 1, 3), mk('4', 'Image: q', 50, 9)]
  const ctx = (assets: AssetScope[], campaignId = CAMP): RepeatContext => ({
    todayEt: '2026-10-28',
    ads: { [campaignId]: { spendThrough: null, lastSync: null, stale: false, storeBound: false, thresholdsFired: [], loadedAtMs: NOW, hasActivity: false, assets } as never },
  })
  const ids = (out: ReturnType<typeof resolveRepeat>) => out.map((s) => (s.kind === 'asset' ? s.asset.id : s.kind))
  it('sorted by impressions unless sortBy says otherwise, highest first, ties by label then id', () => {
    expect(ids(resolveRepeat({ over: 'assets', campaignId: CAMP }, ctx(list)))).toEqual(['3', '2', '1', '4'])
    expect(ids(resolveRepeat({ over: 'assets', campaignId: CAMP, sortBy: 'clicks' }, ctx(list)))).toEqual(['2', '4', '1', '3'])
    expect(ids(resolveRepeat({ over: 'assets', campaignId: CAMP, sortBy: 'conversions' }, ctx(list)))[0]).toBe('3')
    expect(sortAssets(list, 'clicks').map((a) => a.id)).toEqual(['2', '4', '1', '3'])
    expect(ASSET_SORT_FIELDS).toEqual(['impressions', 'clicks', 'conversions'])
  })
  it('the limit keeps the top N after the sort; ids narrows first', () => {
    expect(ids(resolveRepeat({ over: 'assets', campaignId: CAMP, sortBy: 'clicks', limit: 2 }, ctx(list)))).toEqual(['2', '4'])
    expect(ids(resolveRepeat({ over: 'assets', campaignId: CAMP, ids: ['1', '3'], sortBy: 'clicks' }, ctx(list)))).toEqual(['1', '3'])
  })
  it('the campaign comes from the enclosing campaign instance, else the repeat\'s own; neither or none loaded gives nothing', () => {
    const c = CAMPAIGNS.find((x) => x.id === CAMP)!
    const outer = resolveRepeat({ over: 'campaigns', ids: [CAMP] }, ctx(list))[0]
    expect(outer.kind).toBe('campaign')
    expect(ids(resolveRepeat({ over: 'assets' }, ctx(list), outer))).toHaveLength(4)
    expect(c.id).toBe(CAMP)
    expect(resolveRepeat({ over: 'assets' }, ctx(list))).toEqual([]) // no campaign in scope
    expect(resolveRepeat({ over: 'assets', campaignId: OTHER }, ctx(list))).toEqual([]) // that campaign's assets were not loaded
    expect(resolveRepeat({ over: 'assets', campaignId: CAMP }, { todayEt: '2026-10-28' })).toEqual([])
  })
  it('an asset instance binds the campaign and asset params to a metric, and its label to the title', () => {
    const [inst] = resolveRepeat({ over: 'assets', campaignId: CAMP }, ctx(list))
    const b = resolveBinding({ metric: 'asset.clicks' }, inst)
    expect(b).toMatchObject({ params: { campaignId: CAMP, assetId: '3' } })
  })
})

describe('labels', () => {
  const asScope = (a: Partial<Parameters<typeof assetScopeOf>[1]>) => assetScopeOf(CAMP, { assetId: A, fieldType: 'HEADLINE', text: null, name: null, impressions: 1, clicks: 2, conversions: 3, ...a })
  it('the field type, then the text; with no text the name; with neither the asset id', () => {
    expect(asScope({ text: 'Free daily sudoku' }).label).toBe('Headline: Free daily sudoku')
    expect(asScope({ fieldType: 'DESCRIPTION', name: 'Long description one' }).label).toBe('Description: Long description one')
    expect(asScope({ fieldType: 'MARKETING_IMAGE' }).label).toBe(`Marketing image: ${A}`)
    expect(asScope({ text: 'T', name: 'N' }).label).toBe('Headline: T') // text wins over name
  })
  it('the scope carries the campaign and the totals for the sort', () => {
    expect(asScope({})).toMatchObject({ id: A, campaignId: CAMP, impressions: 1, clicks: 2, conversions: 3 })
  })
})

describe('the readings-load reader', () => {
  it('sums per asset and field type for the campaign, with the catalog text or name (a missing catalog row lists with null text and name)', () => {
    const db = adsDb(ROWS, CATALOG)
    const stub: D1Reader = {
      prepare: (sql) => ({ bind: (...b) => ({ all: async () => ({ results: db.prepare(sql).all(...(b as never[])) }) }) }),
    }
    return readCampaignAssets(stub, CAMP).then((out) => {
      expect(out).toEqual([
        { assetId: B, fieldType: 'DESCRIPTION', text: null, name: 'Long description one', impressions: 80, clicks: 2, conversions: 0 },
        { assetId: A, fieldType: 'HEADLINE', text: 'Free daily sudoku', name: null, impressions: 350, clicks: 20, conversions: 4 },
        { assetId: C, fieldType: 'MARKETING_IMAGE', text: null, name: null, impressions: 30, clicks: 1, conversions: 0 },
      ])
      expect(CAMPAIGN_ASSETS_SQL).toMatch(/WHERE d\.campaign_id = \?/)
    })
  })
  it('one asset under two field types is ONE row (summed), so a leaderboard row agrees with its tile', async () => {
    const db = adsDb(
      [row(CAMP, '7100000001', A, 'HEADLINE', '2026-10-27', 100, 10, 1), row(CAMP, '7100000001', A, 'LONG_HEADLINE', '2026-10-27', 40, 4, 0)],
      CATALOG,
    )
    const stub: D1Reader = {
      prepare: (sql) => ({ bind: (...b) => ({ all: async () => ({ results: db.prepare(sql).all(...(b as never[])) }) }) }),
    }
    const out = await readCampaignAssets(stub, CAMP)
    expect(out).toEqual([{ assetId: A, fieldType: 'HEADLINE', text: 'Free daily sudoku', name: null, impressions: 140, clicks: 14, conversions: 1 }])
    const tile = run(db, [asset('asset.clicks', A)]).results[`asset.clicks:${A}:${CAMP}`] as MetricValue
    expect(tile.value).toBe(14)
  })
  it('no binding or a throwing database is null, never an error', async () => {
    expect(await readCampaignAssets(undefined, CAMP)).toBeNull()
    expect(await readCampaignAssets(null, CAMP)).toBeNull()
    const throwing: D1Reader = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error('no such table: ads_daily_assets')
          },
        }),
      }),
    }
    expect(await readCampaignAssets(throwing, CAMP)).toBeNull()
  })
})

describe('assetSeries', () => {
  const rows = [
    { assetId: A, fieldType: 'HEADLINE', date: '2026-10-27', impressions: 9, clicks: 4, conversions: 0 },
    { assetId: A, fieldType: 'HEADLINE', date: '2026-10-26', impressions: 3, clicks: 1, conversions: 0 },
    { assetId: B, fieldType: 'DESCRIPTION', date: '2026-10-26', impressions: 7, clicks: 6, conversions: 0 },
    { assetId: A, fieldType: 'HEADLINE', date: '2026-10-30', impressions: 1, clicks: 1, conversions: 0 },
  ]
  it('sorted by day, one asset, a gap is no point, and nothing past the cap day', () => {
    expect(assetSeries({ rows, assetId: A, field: 'clicks', capDay: '2026-10-28' })).toEqual([
      { day: '2026-10-26', value: 1 },
      { day: '2026-10-27', value: 4 },
    ])
  })
})

describe('counts only', () => {
  it('the asset fact selects aggregates by asset and day, no user, device or place column', () => {
    const sql = buildFact({ id: 'adsAssetDaily', params: { campaignId: CAMP } } as never, NOW).sql
    expect(sql).toMatch(/GROUP BY asset_id, field_type, date/)
    expect(sql).not.toMatch(/country|device|visitor|user|ip|session/i)
    expect(CAMPAIGN_ASSETS_SQL).not.toMatch(/country|device|visitor|user|session/i)
  })
})
