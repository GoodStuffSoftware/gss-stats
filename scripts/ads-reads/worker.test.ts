// The gss-stats-sync Worker (workers/sync/src/index.ts) against a real SQLite with every
// migration applied, through the D1-binding adapter: the nothing-due short circuit (no secret
// read, no token refresh, no write), the atomic claim (429 for the loser), the per-run caps,
// the cron gate, the read-only Ads client (no login-customer-id), build identity, and secret
// hygiene. The dashboard's "Refresh data" (src/lib/adsRefresh.ts) is exercised end to end
// through a fake Service Binding that calls the Worker's fetch handler.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { etDateRange } from '../../src/lib/adsFreshness'
import { addDays } from '../../src/lib/etTime'
import { clearRegisteredSecrets } from '../../src/lib/adsRedact'
import { refreshAds } from '../../src/lib/adsRefresh'
import { LAST_SYNC_SQL, readFreshness, readLastSyncRun } from '../../src/lib/adsStore'
import { campaignsConfigHash, cronShouldSync, extrasWindow, liveFlightCampaigns, syncableCampaigns, syncWindow, type ExtrasResult } from '../../src/lib/adsSync'
import { CAMPAIGNS } from '../../src/lib/campaigns'
import type { FetchLike } from '../../src/lib/adsApi'
import worker, {
  EXTRAS_CRON,
  handleExtrasScheduled,
  handleFetch,
  handleScheduled,
  resetClientCache,
  WORKER_EXTRAS_MAX_ROWS,
  WORKER_MAX_DAYS,
  type Env,
} from '../../workers/sync/src/index'
import { count, openMigratedSqlite, sqliteD1 } from './sqliteDb'

const RETEST = '24279250691'
const F3S = '24358792551' // F3 Search
const FAKE_CUSTOMER = '1234567890' // made up: never the account's id
const SECRETS = { ADS_CLIENT_ID: 'cid-value-123456', ADS_CLIENT_SECRET: 'csecret-value-xyz', ADS_REFRESH_TOKEN: 'rtoken-value-xyz', ADS_DEVELOPER_TOKEN: 'devtoken-value-xyz' }

function setup(opts: { tokenStatus?: number } = {}) {
  const sqlite = openMigratedSqlite()
  const secretReads = { n: 0 }
  const secret = (v: string) => ({ get: async () => (secretReads.n++, v) })
  const env: Env = {
    gss_stats_ads: sqliteD1(sqlite),
    ADS_CLIENT_ID: secret(SECRETS.ADS_CLIENT_ID),
    ADS_CLIENT_SECRET: secret(SECRETS.ADS_CLIENT_SECRET),
    ADS_REFRESH_TOKEN: secret(SECRETS.ADS_REFRESH_TOKEN),
    ADS_DEVELOPER_TOKEN: secret(SECRETS.ADS_DEVELOPER_TOKEN),
    GIT_SHA: 'abc1234',
  }
  const calls: { url: string; headers: Record<string, string>; body?: string }[] = []
  // The conversions-and-assets queries: response rows per campaign id (none by default); a
  // failing kind answers HTTP 500 with a customers/<id> path in Google's message.
  const extras = { conversions: {} as Record<string, ExtrasRow[]>, assets: {} as Record<string, ExtrasRow[]>, fail: { conversions: false, assets: false } }
  // A fake Google Ads API: two closed retest days, one placement row; nothing for the closed campaigns.
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body })
    if (url.includes('oauth2')) {
      const status = opts.tokenStatus ?? 200
      return { ok: status === 200, status, text: async () => (status === 200 ? JSON.stringify({ access_token: 'ya29.fake-access-token' }) : JSON.stringify({ error: 'invalid_grant', error_description: `bad ${SECRETS.ADS_REFRESH_TOKEN}` })) }
    }
    const q = JSON.parse(init.body!).query as string
    const since = q.match(/BETWEEN '([\d-]+)'/)![1]
    const until = q.match(/AND '([\d-]+)'/)![1]
    const kind = extrasKindOf(q)
    if (kind) {
      if (extras.fail[kind]) return { ok: false, status: 500, text: async () => JSON.stringify({ error: { message: `backend error reading customers/${FAKE_CUSTOMER}/campaigns/${RETEST}` } }) }
      const rows = extras[kind][q.match(/campaign\.id = (\d+)/)![1]] ?? []
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: rows.filter((r) => r.segments.date >= since && r.segments.date <= until) }) }
    }
    const results = !q.includes(`campaign.id = ${RETEST}`)
      ? []
      : q.includes('group_placement_view')
        ? [{ segments: { date: '2026-09-27' }, groupPlacementView: { placement: 'mobileapp::2-com.easybrain.sudoku.android' }, metrics: { costMicros: '13100000', impressions: '5100', clicks: '40' } }]
        : [
            { segments: { date: '2026-09-26' }, metrics: { costMicros: '4200000', impressions: '2600', clicks: '21' } },
            { segments: { date: '2026-09-27' }, metrics: { costMicros: '13100000', impressions: '5100', clicks: '40' } },
          ]
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: results.filter((r) => r.segments.date >= since && r.segments.date <= until) }) }
  }
  return { sqlite, env, calls, fetchImpl, secretReads, extras }
}
type ExtrasRow = { segments: { date: string } & Record<string, unknown> } & Record<string, unknown>
/** Which extras query a GAQL string is (null: a cost query). */
const extrasKindOf = (q: string): 'conversions' | 'assets' | null => (q.includes('ad_group_ad_asset_view') ? 'assets' : q.includes('segments.conversion_action') ? 'conversions' : null)
// Probe-shaped extras rows (REST JSON, camelCase); every id but the campaign's is made up.
const convRow = (date: string, conversions: number, actionId = '9000000001'): ExtrasRow => ({
  segments: { date, conversionAction: `customers/${FAKE_CUSTOMER}/conversionActions/${actionId}`, conversionActionName: 'Sign-ups (test)' },
  metrics: { conversions, allConversions: conversions },
})
const assetRow = (date: string, impressions: number, clicks: number): ExtrasRow => ({
  segments: { date },
  campaign: { id: RETEST },
  adGroup: { id: '501' },
  adGroupAd: { ad: { id: '601' } },
  asset: { id: '701', type: 'TEXT', textAsset: { text: 'Sudoku with no ads' } },
  adGroupAdAssetView: { fieldType: 'HEADLINE', performanceLabel: 'PENDING' },
  metrics: { impressions: String(impressions), clicks: String(clicks), conversions: 0 },
})
/** The GAQL bodies of the search calls from index `from` on. */
const queriesOf = (calls: { url: string; body?: string }[], from = 0) => calls.slice(from).filter((c) => c.url.includes('googleAds:search')).map((c) => JSON.parse(c.body!).query as string)
const at = (iso: string) => Date.parse(iso)
const post = (body?: unknown) => new Request('https://gss-stats-sync/sync', { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const searches = (calls: { url: string }[]) => calls.filter((c) => c.url.includes('googleAds:search')).length
const RETEST_ONLY = { campaignIds: [RETEST] }

afterEach(() => {
  clearRegisteredSecrets()
  resetClientCache()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('gss-stats-sync Worker: on-demand sync (Service Binding only)', () => {
  it('POST /sync runs the shared sync through the D1 binding: a claim row, then the finished run', async () => {
    const { sqlite, env, fetchImpl } = setup()
    const res = await handleFetch(post(RETEST_ONLY), env, at('2026-09-28T14:00:00Z'), { fetchImpl })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body).toMatchObject({ ran: true, status: 'ok', worker: { gitSha: 'abc1234', campaignsHash: campaignsConfigHash() } })
    expect(body.campaigns[0]).toMatchObject({ campaignId: RETEST, daysChanged: 2, spendThrough: '2026-09-27' })
    expect(count(sqlite, 'ads_daily_metrics', 'campaign_id = ?', RETEST)).toBe(2)
    expect((sqlite.prepare('SELECT status, source FROM ads_sync_runs ORDER BY id').all() as Record<string, string>[]).map((r) => `${r.source}:${r.status}`)).toEqual(['worker-on-demand:running', 'worker-on-demand:ok'])
  })
  it('nothing due: 200 "up to date" with no claim, no secret read, no token refresh, no Google call, no write', async () => {
    const { sqlite, env, fetchImpl, calls, secretReads } = setup()
    const now = at('2026-09-28T14:00:00Z')
    await handleFetch(post(RETEST_ONLY), env, now, { fetchImpl })
    const [c0, s0, runs0] = [calls.length, secretReads.n, count(sqlite, 'ads_sync_runs')]
    const res = await handleFetch(post(RETEST_ONLY), env, now + 30_000, { fetchImpl })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ran: false, reason: 'up to date' })
    expect([calls.length, secretReads.n, count(sqlite, 'ads_sync_runs')]).toEqual([c0, s0, runs0])
  })
  it('two concurrent requests with work due: exactly one claims and syncs, the other gets 429', async () => {
    const { sqlite, env, fetchImpl } = setup()
    const now = at('2026-09-28T14:00:00Z')
    const [a, b] = await Promise.all([handleFetch(post(RETEST_ONLY), env, now, { fetchImpl }), handleFetch(post(RETEST_ONLY), env, now + 1, { fetchImpl })])
    expect([a.status, b.status].sort()).toEqual([200, 429])
    const loser = (await (a.status === 429 ? a : b).json()) as Record<string, unknown>
    expect(loser).toMatchObject({ ran: false, reason: 'rate-limited' })
    expect(count(sqlite, 'ads_sync_runs', "status = 'running'")).toBe(1)
    expect(count(sqlite, 'ads_sync_runs', "status <> 'running'")).toBe(1)
  })
  it('a forced full re-pull inside the claim window loses the claim (429); after it, it runs and changes nothing', async () => {
    const { env, fetchImpl, calls } = setup()
    const now = at('2026-09-28T14:00:00Z')
    await handleFetch(post(RETEST_ONLY), env, now, { fetchImpl })
    const n = calls.length
    const early = await handleFetch(post({ ...RETEST_ONLY, full: true }), env, now + 30_000, { fetchImpl })
    expect(early.status).toBe(429)
    expect(calls.length).toBe(n) // no Ads call
    const later = await handleFetch(post({ ...RETEST_ONLY, full: true }), env, now + 11 * 60_000, { fetchImpl })
    expect(await later.json()).toMatchObject({ ran: true, full: true, daysChanged: 0, placementRowsChanged: 0 })
  })
  it(`the Worker pulls at most ${WORKER_MAX_DAYS} closed days per run, live campaigns first; later runs finish`, async () => {
    const { sqlite, env, fetchImpl } = setup()
    const now = at('2026-09-28T14:00:00Z')
    const first = (await (await handleFetch(post(), env, now, { fetchImpl })).json()) as Record<string, any>
    expect(first).toMatchObject({ ran: true, status: 'partial', daysFetched: WORKER_MAX_DAYS })
    expect(first.error).toMatch(/^work cap: /)
    expect(first.campaigns.find((c: any) => c.campaignId === RETEST)).toMatchObject({ daysChanged: 2 })
    let t = now
    for (let i = 0; i < 5; i++) {
      t += 11 * 60_000
      const r = (await (await handleFetch(post(), env, t, { fetchImpl })).json()) as Record<string, any>
      if (r.ran === false) break
    }
    // everything inside the three flights is stored, nothing past a flight end is zero-filled
    expect(count(sqlite, 'ads_daily_metrics')).toBe(2 + 8 + 5)
  })
  it('only POST /sync exists, and campaign ids are validated', async () => {
    const { env } = setup()
    expect((await handleFetch(new Request('https://gss-stats-sync/sync'), env)).status).toBe(405)
    expect((await handleFetch(new Request('https://gss-stats-sync/', { method: 'POST' }), env)).status).toBe(404)
    expect((await handleFetch(post({ campaignIds: ['111'] }), env)).status).toBe(400)
    expect(typeof worker.fetch).toBe('function')
    expect(typeof worker.scheduled).toBe('function')
  })
  it('the Ads client sends authorization + developer-token only (never login-customer-id), SELECTs only', async () => {
    const { env, fetchImpl, calls } = setup()
    await handleFetch(post(RETEST_ONLY), env, at('2026-09-28T14:00:00Z'), { fetchImpl })
    expect(searches(calls)).toBeGreaterThan(0)
    for (const c of calls.filter((x) => x.url.includes('googleAds:search'))) {
      expect(Object.keys(c.headers).map((k) => k.toLowerCase()).sort()).toEqual(['authorization', 'content-type', 'developer-token'])
      expect(JSON.parse(c.body!).query).toMatch(/^SELECT /)
    }
  })
  it('a credential failure (when something is due) is recorded redacted: no secret value in the run row or the response', async () => {
    const { sqlite, env, fetchImpl } = setup({ tokenStatus: 400 })
    const res = await handleFetch(post(RETEST_ONLY), env, at('2026-09-28T14:00:00Z'), { fetchImpl })
    const text = await res.text()
    const row = sqlite.prepare("SELECT status, error, detail FROM ads_sync_runs WHERE status <> 'running'").get() as Record<string, string>
    expect(row.status).toBe('failed')
    expect(row.error).toMatch(/OAuth refresh failed/)
    for (const v of Object.values(SECRETS)) {
      expect(text).not.toContain(v)
      expect(JSON.stringify(row)).not.toContain(v)
    }
  })
})

describe('build identity: the campaigns hash (review I1)', () => {
  it('changes with every field the sync writes to ads_campaigns, not only the flight', () => {
    const base = campaignsConfigHash(CAMPAIGNS)
    const c = CAMPAIGNS.find((x) => x.id === RETEST)!
    const other = (over: Partial<typeof c>) => campaignsConfigHash(CAMPAIGNS.map((x) => (x.id === RETEST ? { ...x, ...over } : x)))
    for (const over of [{ label: 'renamed' }, { kind: 'play-direct' as const }, { dailyBudgetUsd: (c.dailyBudgetUsd ?? 0) + 1 }, { hardCapUsd: (c.hardCapUsd ?? 0) + 1 }, { measurement: 'spend-only' as const }, { flightEnd: '2026-10-03' }, { ucValues: ['x'] }])
      expect(other(over)).not.toBe(base)
    expect(other({ notes: 'notes are not synced' })).toBe(base)
  })
})

describe('gss-stats-sync Worker: the cron', () => {
  it('the gate: every hour while a flight is live (through the day after the flight), 03:xx ET otherwise', () => {
    expect(liveFlightCampaigns(at('2026-09-27T17:05:00Z')).map((c) => c.id)).toEqual([RETEST])
    expect(cronShouldSync(at('2026-09-27T17:05:00Z')).run).toBe(true)
    expect(cronShouldSync(at('2026-10-03T17:05:00Z')).run).toBe(true) // 10-03 ET: the day after the flight
    // flight 2's two arms (2026-10-04 .. 2026-10-10) are live through 10-11 ET, the day after the flight
    const f2 = ['24316608605', '24311309184']
    expect(liveFlightCampaigns(at('2026-10-03T17:05:00Z')).map((c) => c.id)).toEqual([RETEST])
    expect(liveFlightCampaigns(at('2026-10-04T17:05:00Z')).map((c) => c.id)).toEqual(f2)
    expect(liveFlightCampaigns(at('2026-10-11T17:05:00Z')).map((c) => c.id)).toEqual(f2)
    expect(cronShouldSync(at('2026-10-11T17:05:00Z')).run).toBe(true)
    expect(cronShouldSync(at('2026-10-12T17:05:00Z'))).toMatchObject({ run: false })
    expect(cronShouldSync(at('2026-10-12T05:05:00Z'))).toMatchObject({ run: false }) // 01:05 EDT: yesterday not closed yet
    expect(cronShouldSync(at('2026-10-12T07:05:00Z'))).toMatchObject({ run: true, reason: 'daily pass' }) // 03:05 EDT
    expect(cronShouldSync(at('2026-12-05T08:05:00Z'))).toMatchObject({ run: true, reason: 'daily pass' }) // 03:05 EST
  })
  it('a gated tick does no I/O; a due tick claims and syncs; the next tick finds nothing due and writes nothing', async () => {
    const { sqlite, env, fetchImpl, calls, secretReads } = setup()
    expect(await handleScheduled({ scheduledTime: at('2026-10-12T17:05:00Z'), cron: '5 * * * *' }, env, { fetchImpl, nowMs: at('2026-10-12T17:05:00Z') })).toBeNull()
    expect(calls).toEqual([])
    // cover the closed campaigns first (as in production), then the cron ticks
    for (let i = 0; i < 4; i++) await handleFetch(post(), env, at('2026-09-28T10:00:00Z') + i * 11 * 60_000, { fetchImpl })
    const tick = at('2026-09-28T14:05:00Z')
    const r = await handleScheduled({ scheduledTime: tick, cron: '5 * * * *' }, env, { fetchImpl, nowMs: tick })
    expect(r).toBeNull() // the on-demand runs already pulled everything within the recheck interval
    const [c0, s0, runs0] = [calls.length, secretReads.n, count(sqlite, 'ads_sync_runs')]
    const next = await handleScheduled({ scheduledTime: tick + 3_600_000, cron: '5 * * * *' }, env, { fetchImpl, nowMs: tick + 3_600_000 })
    expect(next).toBeNull()
    expect([calls.length, secretReads.n, count(sqlite, 'ads_sync_runs')]).toEqual([c0, s0, runs0])
    // after midnight ET the restatement window is 6 h old, so the tick claims and re-checks it,
    // but not yesterday: before 03:00 ET it cannot close (Google still adds late data), so it is
    // not due yet and spend-through stays put (final review Low-1)
    const afterMidnight = at('2026-09-29T04:05:00Z')
    const due = await handleScheduled({ scheduledTime: afterMidnight, cron: '5 * * * *' }, env, { fetchImpl, nowMs: afterMidnight })
    expect(due).not.toBeNull()
    expect(due!.campaigns.find((c) => c.campaignId === RETEST)).toMatchObject({ spendThrough: '2026-09-27' })
    expect(count(sqlite, 'ads_sync_runs', "source = 'worker-cron' AND status = 'running'")).toBe(1)
    // the 03:05 ET tick pulls yesterday once and closes it
    const closing = at('2026-09-29T07:05:00Z')
    const closed = await handleScheduled({ scheduledTime: closing, cron: '5 * * * *' }, env, { fetchImpl, nowMs: closing })
    expect(closed!.campaigns.find((c) => c.campaignId === RETEST)).toMatchObject({ spendThrough: '2026-09-28' })
  })
})

describe('gss-stats-sync Worker: the conversions-and-assets cron (EXTRAS_CRON)', () => {
  const EXTRAS_RUNS = "run_key LIKE 'extras:%'"
  /** Everything the cost sync owns: its rows, its placement rows, its claims and run rows. */
  const costState = (sqlite: ReturnType<typeof setup>['sqlite']) => ({
    metrics: sqlite.prepare('SELECT * FROM ads_daily_metrics ORDER BY campaign_id, date').all(),
    placements: sqlite.prepare('SELECT * FROM ads_placement_daily ORDER BY campaign_id, date, placement').all(),
    costRuns: sqlite.prepare(`SELECT * FROM ads_sync_runs WHERE NOT (${EXTRAS_RUNS}) ORDER BY id`).all(),
  })
  const campaignOf = (q: string) => q.match(/campaign\.id = (\d+)/)![1]

  it('scheduled() dispatches on event.cron: a cost tick does no extras work, an EXTRAS_CRON tick no cost work', async () => {
    const { sqlite, env, fetchImpl, calls, extras } = setup()
    extras.conversions[RETEST] = [convRow('2026-09-27', 2)]
    extras.assets[RETEST] = [assetRow('2026-09-27', 120, 3)]
    // the default export takes no test hooks: fake its clock and its global fetch
    vi.stubGlobal('fetch', (url: string, init: Parameters<FetchLike>[1]) => fetchImpl(url, init))
    vi.useFakeTimers({ now: at('2026-09-28T14:05:00Z'), toFake: ['Date'] })
    await worker.scheduled({ scheduledTime: Date.now(), cron: '5 * * * *' }, env)
    const costQueries = queriesOf(calls)
    expect(costQueries.length).toBeGreaterThan(0)
    expect(costQueries.filter((q) => extrasKindOf(q))).toEqual([])
    expect(count(sqlite, 'ads_daily_metrics', 'campaign_id = ?', RETEST)).toBe(2)
    for (const t of ['ads_daily_conversions', 'ads_daily_assets', 'ads_assets']) expect(count(sqlite, t)).toBe(0)
    expect(count(sqlite, 'ads_sync_runs', EXTRAS_RUNS)).toBe(0)

    const before = costState(sqlite)
    const from = calls.length
    vi.setSystemTime(at('2026-09-29T09:35:00Z')) // 05:35 EDT, an EXTRAS_CRON tick
    await worker.scheduled({ scheduledTime: Date.now(), cron: EXTRAS_CRON }, env)
    const extrasQueries = queriesOf(calls, from)
    expect(new Set(extrasQueries.map(extrasKindOf))).toEqual(new Set(['conversions', 'assets'])) // and no cost query (null)
    expect(costState(sqlite)).toEqual(before) // no cost row, no claim, no cost run row
    expect(count(sqlite, 'ads_sync_runs', EXTRAS_RUNS)).toBe(1)
    expect([count(sqlite, 'ads_daily_conversions', 'campaign_id = ?', RETEST), count(sqlite, 'ads_daily_assets', 'campaign_id = ?', RETEST)]).toEqual([1, 1])
  })

  it('a failed extras query leaves the cost rows, freshness, rate limit and claim untouched; only that kind goes stale', async () => {
    const { sqlite, env, fetchImpl, extras } = setup()
    for (let i = 0; i < 4; i++) await handleFetch(post(), env, at('2026-09-28T10:00:00Z') + i * 11 * 60_000, { fetchImpl })
    const now = at('2026-09-29T09:35:00Z')
    const freshness = async () => ({
      ...costState(sqlite),
      lastSync: sqlite.prepare(LAST_SYNC_SQL).all(),
      lastRun: await readLastSyncRun(env.gss_stats_ads),
      byCampaign: [...(await readFreshness(env.gss_stats_ads, now)).entries()],
    })
    const before = await freshness()
    expect(before.lastSync.length).toBeGreaterThan(0)
    extras.fail.conversions = true
    extras.assets[RETEST] = [assetRow('2026-09-26', 90, 1), assetRow('2026-09-27', 120, 3)]
    const r = await handleExtrasScheduled({ scheduledTime: now, cron: EXTRAS_CRON }, env, { fetchImpl, nowMs: now })
    expect(r.status).toBe('partial')
    const retest = r.campaigns.find((c) => c.campaignId === RETEST)!
    expect(retest.conversions).toMatchObject({ ok: false, stale: true })
    expect(retest.conversions.error).toMatch(/HTTP 500/)
    expect(retest.assets).toMatchObject({ ok: true, stale: false, through: '2026-09-28', rowsChanged: 2 })
    expect([count(sqlite, 'ads_daily_conversions'), count(sqlite, 'ads_daily_assets')]).toEqual([0, 2])
    expect(await freshness()).toEqual(before)
    const row = sqlite.prepare(`SELECT status, error, detail FROM ads_sync_runs WHERE ${EXTRAS_RUNS}`).get() as Record<string, string>
    expect(row.status).toBe('partial')
    expect(JSON.stringify([row, r])).not.toContain(FAKE_CUSTOMER)
    // the extras run finished inside the claim window, yet a forced cost re-pull a minute later
    // claims and runs (no 429): the claim and the rate limit skip extras rows
    const res = await handleFetch(post({ full: true, campaignIds: [RETEST] }), env, now + 60_000, { fetchImpl })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ran: true })
  })

  it(`each run is planned to ${WORKER_EXTRAS_MAX_ROWS} rows and the D1 budget before it fetches; no stored day is pulled twice; ended flights stop at flight end + 3`, async () => {
    const { env, fetchImpl, calls, extras } = setup()
    const t0 = at('2026-10-28T08:20:00Z') // 04:20 EDT: closed days through 10-27
    const todayEt = '2026-10-28'
    const windows = new Map(syncableCampaigns().flatMap((c) => { const w = extrasWindow(c, todayEt, t0); return w ? [[c.id, w] as const] : [] }))
    // every campaign: one conversion row and 30 asset rows a day, every day of its flight and a
    // week either side (more than the window: the pass must not ask for them)
    for (const c of syncableCampaigns()) {
      if (!c.flightStart) continue
      const days = etDateRange(addDays(c.flightStart, -7), addDays(c.flightEnd < todayEt ? c.flightEnd : todayEt, 7))
      extras.conversions[c.id] = days.map((d) => convRow(d, 2))
      extras.assets[c.id] = days.flatMap((d) => Array.from({ length: 30 }, (_, i) => ({ ...assetRow(d, 50, 1), campaign: { id: c.id }, asset: { id: String(7000 + i), type: 'TEXT', textAsset: { text: `Headline ${i} (test)` } } })))
    }
    const results: ExtrasResult[] = []
    const pulls: Map<string, string[]>[] = [] // per run: "<campaign> <kind>" -> the days pulled
    for (let i = 0; i < 60; i++) {
      const now = t0 + i * 5 * 60_000 // inside the 6 h restatement re-check
      const from = calls.length
      const r = await handleExtrasScheduled({ scheduledTime: now, cron: EXTRAS_CRON }, env, { fetchImpl, nowMs: now })
      results.push(r)
      if (r.nothingDue) break
      const run = new Map<string, string[]>()
      for (const q of queriesOf(calls, from)) {
        const key = `${campaignOf(q)} ${extrasKindOf(q)}`
        run.set(key, [...(run.get(key) ?? []), ...etDateRange(q.match(/BETWEEN '([\d-]+)'/)![1], q.match(/AND '([\d-]+)'/)![1])])
      }
      pulls.push(run)
    }
    expect(results.at(-1)!.nothingDue).toBe(true)
    expect(pulls.length).toBeGreaterThan(5) // the caps split the work
    const seen = new Set<string>()
    pulls.forEach((run, i) => {
      const r = results[i]
      expect(r.conversionRowsFetched + r.assetRowsFetched, `run ${i}`).toBeLessThanOrEqual(WORKER_EXTRAS_MAX_ROWS)
      expect(JSON.stringify(r), `run ${i}`).not.toContain('D1 query budget')
      expect(r.runRecorded, `run ${i}`).toBe(true)
      for (const [key, days] of run) {
        const [id, kind] = key.split(' ') as [string, 'conversions' | 'assets']
        // everything fetched is stored by the same run
        const stored = r.campaigns.find((c) => c.campaignId === id)![kind].ranges.flatMap((x) => etDateRange(x.since, x.until))
        expect(stored.sort(), `run ${i} ${key}`).toEqual([...days].sort())
        const w = windows.get(id)!
        for (const d of days) {
          expect(d >= w.since && d <= w.until, `run ${i} ${key} ${d}`).toBe(true)
          expect(seen.has(`${key} ${d}`), `run ${i} ${key} ${d} pulled again`).toBe(false)
          seen.add(`${key} ${d}`)
        }
      }
    })
    // the first run starts with a campaign in flight (the registry's dates, not its status)
    expect(CAMPAIGNS.find((c) => c.id === campaignOf(queriesOf(calls)[0]))!.flightEnd >= '2026-10-27').toBe(true)
    // the stale 'active' retest (flight 09-26 .. 10-02) is pulled through 10-05 only
    expect(windows.get(RETEST)).toEqual({ since: '2026-09-26', until: '2026-10-05' })
    // the end: every window pulled once, stored through its required days, nothing stale or waiting
    const end = results.at(-1)!
    expect(end.waiting).toEqual([])
    for (const [id, w] of windows) {
      const c = CAMPAIGNS.find((x) => x.id === id)!
      for (const kind of ['conversions', 'assets']) expect([...seen].filter((k) => k.startsWith(`${id} ${kind} `)).length, `${id} ${kind}`).toBe(etDateRange(w.since, w.until).length)
      const required = w.until < c.flightEnd ? w.until : c.flightEnd
      const r = end.campaigns.find((x) => x.campaignId === id)!
      expect([r.conversions.through, r.conversions.stale, r.assets.through, r.assets.stale], id).toEqual([required, false, required, false])
    }
  })
})

describe('dashboard "Refresh data" → Service Binding → Worker', () => {
  function binding(env: Env, fetchImpl: FetchLike, clock: { now: number }) {
    return { fetch: (url: string, init?: { method?: string }) => handleFetch(new Request(url, { method: init?.method ?? 'GET' }), env, clock.now, { fetchImpl }) }
  }
  it('syncs when stale, then reports fresh; a second click is "up to date"; no config drift', async () => {
    const { env, fetchImpl } = setup()
    const clock = { now: at('2026-09-28T14:00:00Z') } // 10:00 ET: 09-27 is due and missing -> stale
    const first = await refreshAds({ db: env.gss_stats_ads, sync: binding(env, fetchImpl, clock), campaignIds: [RETEST], nowMs: clock.now, clock: () => clock.now })
    expect(first).toMatchObject({ refreshed: true, reason: 'synced', workerConfigDrift: false })
    expect(first.freshness[RETEST]).toMatchObject({ spendThrough: '2026-09-27', stale: false })
    expect(first.freshness[RETEST].lastSync).not.toBeNull()
    const second = await refreshAds({ db: env.gss_stats_ads, sync: binding(env, fetchImpl, clock), campaignIds: [RETEST], nowMs: clock.now + 5_000, clock: () => clock.now })
    expect(second).toMatchObject({ refreshed: false, reason: 'up to date' })
  })
  it('flags a Worker built from other campaign definitions', async () => {
    const stub = { fetch: async () => ({ status: 200, json: async () => ({ ran: true, status: 'ok', worker: { gitSha: 'old', campaignsHash: 'deadbeef' } }) }) }
    const { env } = setup()
    const r = await refreshAds({ db: env.gss_stats_ads, sync: stub, campaignIds: [RETEST], nowMs: at('2026-09-28T14:00:00Z') })
    expect(r).toMatchObject({ refreshed: true, workerConfigDrift: true })
  })
  it('never calls the Worker when nothing is stale, and says so when no binding exists', async () => {
    const { env, fetchImpl, calls } = setup()
    const clock = { now: at('2026-09-26T20:00:00Z') } // first flight day, nothing due yet
    expect(await refreshAds({ db: env.gss_stats_ads, sync: binding(env, fetchImpl, clock), campaignIds: [RETEST], nowMs: clock.now })).toMatchObject({ refreshed: false, reason: 'up to date' })
    expect(calls).toEqual([])
    expect(await refreshAds({ db: env.gss_stats_ads, sync: null, campaignIds: [RETEST], nowMs: clock.now })).toMatchObject({ refreshed: false, reason: 'not available' })
  })
})
