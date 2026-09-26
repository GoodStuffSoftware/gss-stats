// gss-stats-sync — a Cloudflare Worker that runs the SAME shared Google Ads sync as the local
// routines (src/lib/adsSync.ts syncAdsData) against gss-stats' own D1 database, gss-stats-ads.
// Decision and trade-offs: docs/adr/0001-ads-read-store.md ("The sync Worker").
//
//  - scheduled(): the cron fires hourly at :05 (wrangler.toml). cronShouldSync() decides:
//    every tick while a flight is live, one daily pass (01:xx ET) otherwise; a skipped tick
//    does no I/O.
//  - fetch(): POST /sync, the dashboard's on-demand "Refresh data". Reachable ONLY through the
//    gss-stats Pages project's Service Binding (ADS_SYNC): workers.dev and preview URLs are off
//    and the Worker has no route. At most one sync per ON_DEMAND_MIN_INTERVAL_MS (any source).
//
// Google Ads credentials come from Cloudflare Secrets Store bindings (Bitwarden stays the source
// of truth; rotation: README "Ads data freshness"). They live in memory only, are registered
// with redact() so no error or log line can carry one, and the Ads client never sends a
// login-customer-id header (src/lib/adsApi.ts buildHeaders). READ-ONLY toward Google Ads.
//
// Deliberately free of Workers ambient types (minimal local interfaces instead), so the same
// file typechecks under the dashboard's config and the Node test config.

import { createAdsClient, fetchDailySpend, fetchPlacementDaily, type AdsCredentials, type FetchLike } from '../../../src/lib/adsApi'
import { redact, registerSecret } from '../../../src/lib/adsRedact'
import { createSqlAdsStore, d1BindingAdsDb, readLastSyncRun, type D1Like, type SyncSource } from '../../../src/lib/adsStore'
import { cronShouldSync, rateLimit, syncAdsData, syncResultSummary, type AdsMetricsSource, type SyncResult } from '../../../src/lib/adsSync'

/** A Secrets Store binding (SecretsStoreSecret). */
export interface SecretBinding {
  get(): Promise<string>
}
export interface Env {
  gss_stats_ads: D1Like
  ADS_CLIENT_ID: SecretBinding
  ADS_CLIENT_SECRET: SecretBinding
  ADS_REFRESH_TOKEN: SecretBinding
  ADS_DEVELOPER_TOKEN: SecretBinding
}
interface ScheduledEventLike {
  scheduledTime: number
  cron: string
}

async function credentials(env: Env): Promise<AdsCredentials> {
  const names = ['ADS_CLIENT_ID', 'ADS_CLIENT_SECRET', 'ADS_REFRESH_TOKEN', 'ADS_DEVELOPER_TOKEN'] as const
  const values = await Promise.all(
    names.map(async (n) => {
      if (!env[n]) throw new Error(`secret binding ${n} is missing`)
      const v = (await env[n].get()).trim()
      if (!v) throw new Error(`secret ${n} is empty`)
      registerSecret(v)
      return v
    }),
  )
  return { clientId: values[0], clientSecret: values[1], refreshToken: values[2], developerToken: values[3] }
}

/** One sync run through the shared code path. Never throws for a data problem. */
export async function runSync(env: Env, source: SyncSource, nowMs: number, opts: { fetchImpl?: FetchLike; full?: boolean } = {}): Promise<SyncResult> {
  let ads: AdsMetricsSource | null = null
  let adsInitError: string | null = null
  try {
    const client = await createAdsClient(await credentials(env), { fetchImpl: opts.fetchImpl, timeoutMs: 25_000 })
    ads = {
      daily: (id, since, until) => fetchDailySpend(client, id, since, until),
      placements: (id, since, until) => fetchPlacementDaily(client, id, since, until),
    }
  } catch (e) {
    adsInitError = redact(e)
  }
  const store = createSqlAdsStore(d1BindingAdsDb(env.gss_stats_ads), { dryRun: false, kind: 'd1-binding' })
  return syncAdsData({ ads, adsInitError, store }, { now: nowMs, dryRun: false, source, full: !!opts.full })
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

/** POST /sync — on demand, rate-limited. Body `{"full": true}` re-pulls every day in each
 * campaign's window instead of gaps + the restatement window (an operator check; still writes
 * only changed rows). Anything else is 404/405. */
export async function handleFetch(request: Request, env: Env, nowMs: number = Date.now(), opts: { fetchImpl?: FetchLike } = {}): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname !== '/sync') return json(404, { error: 'not found' })
  if (request.method !== 'POST') return json(405, { error: 'POST only' })
  let full = false
  try {
    const body = (await request.json()) as { full?: unknown }
    full = body?.full === true
  } catch {
    full = false // no or non-JSON body: an ordinary sync
  }
  const rl = rateLimit(await readLastSyncRun(env.gss_stats_ads), nowMs)
  if (rl.limited) return json(429, { ran: false, reason: 'rate-limited', retryAfterSec: rl.retryAfterSec })
  const r = await runSync(env, 'worker-on-demand', nowMs, { ...opts, full })
  return json(200, { ran: true, full, ...syncResultSummary(r) })
}

export async function handleScheduled(event: ScheduledEventLike, env: Env, opts: { fetchImpl?: FetchLike; nowMs?: number } = {}): Promise<SyncResult | null> {
  const gate = cronShouldSync(event.scheduledTime)
  if (!gate.run) {
    console.log(JSON.stringify({ event: 'skip', cron: event.cron, reason: gate.reason }))
    return null
  }
  const r = await runSync(env, 'worker-cron', opts.nowMs ?? Date.now(), opts)
  console.log(JSON.stringify({ event: 'sync', cron: event.cron, reason: gate.reason, ...syncResultSummary(r) }))
  return r
}

export default {
  fetch: (request: Request, env: Env) => handleFetch(request, env),
  scheduled: async (event: ScheduledEventLike, env: Env) => {
    await handleScheduled(event, env)
  },
}
