// The gss-stats-sync Worker (workers/sync/src/index.ts) against a real SQLite with every
// migration applied, through the D1-binding adapter: on-demand sync and its rate limit, the
// cron gate, the read-only Ads client (no login-customer-id), and secret hygiene. The dashboard's
// "Refresh data" (src/lib/adsRefresh.ts) is exercised end to end through a fake Service Binding
// that calls the Worker's fetch handler.
import { afterEach, describe, expect, it } from 'vitest'
import { clearRegisteredSecrets } from '../../src/lib/adsRedact'
import { refreshAds } from '../../src/lib/adsRefresh'
import { cronShouldSync, liveFlightCampaigns } from '../../src/lib/adsSync'
import type { FetchLike } from '../../src/lib/adsApi'
import worker, { handleFetch, handleScheduled, type Env } from '../../workers/sync/src/index'
import { count, openMigratedSqlite, sqliteD1 } from './sqliteDb'

const SECRETS = { ADS_CLIENT_ID: 'cid-value-123456', ADS_CLIENT_SECRET: 'csecret-value-xyz', ADS_REFRESH_TOKEN: 'rtoken-value-xyz', ADS_DEVELOPER_TOKEN: 'devtoken-value-xyz' }
const secret = (v: string) => ({ get: async () => v })

function setup(opts: { tokenStatus?: number } = {}) {
  const sqlite = openMigratedSqlite()
  const env: Env = {
    gss_stats_ads: sqliteD1(sqlite),
    ADS_CLIENT_ID: secret(SECRETS.ADS_CLIENT_ID),
    ADS_CLIENT_SECRET: secret(SECRETS.ADS_CLIENT_SECRET),
    ADS_REFRESH_TOKEN: secret(SECRETS.ADS_REFRESH_TOKEN),
    ADS_DEVELOPER_TOKEN: secret(SECRETS.ADS_DEVELOPER_TOKEN),
  }
  const calls: { url: string; headers: Record<string, string>; body?: string }[] = []
  // A fake Google Ads API: two closed retest days, one placement row.
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body })
    if (url.includes('oauth2')) {
      const status = opts.tokenStatus ?? 200
      return { ok: status === 200, status, text: async () => (status === 200 ? JSON.stringify({ access_token: 'ya29.fake-access-token' }) : JSON.stringify({ error: 'invalid_grant', error_description: `bad ${SECRETS.ADS_REFRESH_TOKEN}` })) }
    }
    const q = JSON.parse(init.body!).query as string
    const results = !q.includes('campaign.id = 24279250691')
      ? [] // the closed campaigns: no delivery in this fake
      : q.includes('group_placement_view')
      ? [{ segments: { date: '2026-09-27' }, groupPlacementView: { placement: 'mobileapp::2-com.easybrain.sudoku.android' }, metrics: { costMicros: '13100000', impressions: '5100', clicks: '40' } }]
      : [
          { segments: { date: '2026-09-26' }, metrics: { costMicros: '4200000', impressions: '2600', clicks: '21' } },
          { segments: { date: '2026-09-27' }, metrics: { costMicros: '13100000', impressions: '5100', clicks: '40' } },
        ]
    return { ok: true, status: 200, text: async () => JSON.stringify({ results: results.filter((r) => q.includes('segments.date BETWEEN') && r.segments.date >= q.match(/BETWEEN '([\d-]+)'/)![1] && r.segments.date <= q.match(/AND '([\d-]+)'/)![1]) }) }
  }
  return { sqlite, env, calls, fetchImpl }
}
const at = (iso: string) => Date.parse(iso)
const post = () => new Request('https://gss-stats-sync/sync', { method: 'POST' })

afterEach(() => clearRegisteredSecrets())

describe('gss-stats-sync Worker: on-demand sync (Service Binding only)', () => {
  it('POST /sync runs the shared sync through the D1 binding and records a worker-on-demand run', async () => {
    const { sqlite, env, fetchImpl } = setup()
    const res = await handleFetch(post(), env, at('2026-09-28T14:00:00Z'), { fetchImpl })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body).toMatchObject({ ran: true, status: 'ok' })
    expect(body.campaigns.find((c: any) => c.campaignId === '24279250691')).toMatchObject({ daysChanged: 2, spendThrough: '2026-09-27' })
    expect(count(sqlite, 'ads_daily_metrics', "campaign_id = '24279250691'")).toBe(2)
    expect(count(sqlite, 'ads_sync_runs', "source = 'worker-on-demand'")).toBe(1)
  })
  it('a second immediate request is rate-limited and changes nothing', async () => {
    const { sqlite, env, fetchImpl, calls } = setup()
    const now = at('2026-09-28T14:00:00Z')
    await handleFetch(post(), env, now, { fetchImpl })
    const n = calls.length
    const again = await handleFetch(post(), env, now + 30_000, { fetchImpl })
    expect(again.status).toBe(429)
    expect(await again.json()).toMatchObject({ ran: false, reason: 'rate-limited' })
    expect(calls.length).toBe(n) // no Ads call
    expect(count(sqlite, 'ads_sync_runs')).toBe(1)
  })
  it('after the interval a new sync runs and is a no-op on the data', async () => {
    const { sqlite, env, fetchImpl } = setup()
    const now = at('2026-09-28T14:00:00Z')
    await handleFetch(post(), env, now, { fetchImpl })
    const res = await handleFetch(post(), env, now + 11 * 60_000, { fetchImpl })
    expect(await res.json()).toMatchObject({ ran: true, daysChanged: 0, placementRowsChanged: 0 })
    expect(count(sqlite, 'ads_sync_runs')).toBe(2)
  })
  it('{"full": true} re-pulls every day in the window and still changes nothing when nothing moved', async () => {
    const { env, fetchImpl, calls } = setup()
    const now = at('2026-09-28T14:00:00Z')
    await handleFetch(post(), env, now, { fetchImpl })
    calls.length = 0
    const res = await handleFetch(new Request('https://gss-stats-sync/sync', { method: 'POST', body: JSON.stringify({ full: true }) }), env, now + 11 * 60_000, { fetchImpl })
    const body = (await res.json()) as Record<string, any>
    expect(body).toMatchObject({ ran: true, full: true, daysChanged: 0, placementRowsChanged: 0 })
    expect(body.daysFetched).toBe(2 + 11 + 8) // retest 09-26..09-27, and both closed windows
    expect(calls.filter((c) => c.url.includes('googleAds:search')).length).toBe(6)
  })
  it('unusable credentials are reported even when nothing needed pulling', async () => {
    const { env, fetchImpl } = setup({ tokenStatus: 400 })
    // 09-26 20:00 ET-ish: nothing closed for the retest; closed campaigns fully covered would need no pull either
    const res = await handleFetch(post(), env, at('2026-09-26T20:00:00Z'), { fetchImpl })
    const body = (await res.json()) as Record<string, any>
    expect(body.status).not.toBe('ok')
    expect(body.error).toMatch(/OAuth refresh failed/)
  })
  it('only POST /sync exists', async () => {
    const { env } = setup()
    expect((await handleFetch(new Request('https://gss-stats-sync/sync'), env)).status).toBe(405)
    expect((await handleFetch(new Request('https://gss-stats-sync/', { method: 'POST' }), env)).status).toBe(404)
    expect(typeof worker.fetch).toBe('function')
    expect(typeof worker.scheduled).toBe('function')
  })
  it('the Ads client sends authorization + developer-token only (never login-customer-id), SELECTs only', async () => {
    const { env, fetchImpl, calls } = setup()
    await handleFetch(post(), env, at('2026-09-28T14:00:00Z'), { fetchImpl })
    const searches = calls.filter((c) => c.url.includes('googleAds:search'))
    expect(searches.length).toBeGreaterThan(0)
    for (const c of searches) {
      expect(Object.keys(c.headers).map((k) => k.toLowerCase()).sort()).toEqual(['authorization', 'content-type', 'developer-token'])
      expect(JSON.parse(c.body!).query).toMatch(/^SELECT /)
    }
  })
  it('a credential failure is recorded redacted: no secret value in the run row or the response', async () => {
    const { sqlite, env, fetchImpl } = setup({ tokenStatus: 400 })
    const res = await handleFetch(post(), env, at('2026-09-28T14:00:00Z'), { fetchImpl })
    const text = await res.text()
    const row = sqlite.prepare('SELECT status, error, detail FROM ads_sync_runs').get() as Record<string, string>
    expect(row.status).toBe('failed')
    expect(row.error).toMatch(/OAuth refresh failed/)
    for (const v of Object.values(SECRETS)) {
      expect(text).not.toContain(v)
      expect(JSON.stringify(row)).not.toContain(v)
    }
  })
})

describe('gss-stats-sync Worker: the cron gate', () => {
  it('syncs every hour while a flight is live (through the day after the flight)', () => {
    expect(liveFlightCampaigns(at('2026-09-27T17:05:00Z')).map((c) => c.id)).toEqual(['24279250691'])
    expect(cronShouldSync(at('2026-09-27T17:05:00Z')).run).toBe(true)
    expect(cronShouldSync(at('2026-10-03T17:05:00Z')).run).toBe(true) // 10-03 ET: the day after the flight
  })
  it('outside a flight, only the daily pass at 01:xx ET runs', () => {
    expect(cronShouldSync(at('2026-10-05T17:05:00Z'))).toMatchObject({ run: false })
    expect(cronShouldSync(at('2026-10-05T05:05:00Z'))).toMatchObject({ run: true, reason: 'daily pass' }) // 01:05 EDT
    expect(cronShouldSync(at('2026-12-05T06:05:00Z'))).toMatchObject({ run: true, reason: 'daily pass' }) // 01:05 EST
  })
  it('a skipped tick does no I/O; a live tick records a worker-cron run', async () => {
    const { sqlite, env, fetchImpl, calls } = setup()
    expect(await handleScheduled({ scheduledTime: at('2026-10-05T17:05:00Z'), cron: '5 * * * *' }, env, { fetchImpl, nowMs: at('2026-10-05T17:05:00Z') })).toBeNull()
    expect(calls).toEqual([])
    const r = await handleScheduled({ scheduledTime: at('2026-09-28T14:05:00Z'), cron: '5 * * * *' }, env, { fetchImpl, nowMs: at('2026-09-28T14:05:00Z') })
    expect(r!.status).toBe('ok')
    expect(count(sqlite, 'ads_sync_runs', "source = 'worker-cron'")).toBe(1)
  })
})

describe('dashboard "Refresh data" → Service Binding → Worker', () => {
  function binding(env: Env, fetchImpl: FetchLike, clock: { now: number }) {
    return { fetch: (url: string, init?: { method?: string }) => handleFetch(new Request(url, { method: init?.method ?? 'GET' }), env, clock.now, { fetchImpl }) }
  }
  it('syncs when stale, then reports fresh; a second click is rate-limited or already up to date', async () => {
    const { env, fetchImpl } = setup()
    const clock = { now: at('2026-09-28T14:00:00Z') } // 10:00 ET: 09-27 is due and missing -> stale
    const first = await refreshAds({ db: env.gss_stats_ads, sync: binding(env, fetchImpl, clock), campaignIds: ['24279250691'], nowMs: clock.now, clock: () => clock.now })
    expect(first).toMatchObject({ refreshed: true, reason: 'synced' })
    expect(first.freshness['24279250691']).toMatchObject({ spendThrough: '2026-09-27', stale: false })
    expect(first.freshness['24279250691'].lastSync).not.toBeNull()
    const second = await refreshAds({ db: env.gss_stats_ads, sync: binding(env, fetchImpl, clock), campaignIds: ['24279250691'], nowMs: clock.now + 5_000, clock: () => clock.now })
    expect(second).toMatchObject({ refreshed: false, reason: 'up to date' })
  })
  it('never calls the Worker when nothing is stale, and says so when no binding exists', async () => {
    const { env, fetchImpl, calls } = setup()
    const clock = { now: at('2026-09-26T20:00:00Z') } // first flight day, nothing due yet
    expect(await refreshAds({ db: env.gss_stats_ads, sync: binding(env, fetchImpl, clock), campaignIds: ['24279250691'], nowMs: clock.now })).toMatchObject({ refreshed: false, reason: 'up to date' })
    expect(calls).toEqual([])
    expect(await refreshAds({ db: env.gss_stats_ads, sync: null, campaignIds: ['24279250691'], nowMs: clock.now })).toMatchObject({ refreshed: false, reason: 'not available' })
  })
})
