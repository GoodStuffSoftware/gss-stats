// gss-stats-sync — a Cloudflare Worker that runs the SAME shared Google Ads sync as the local
// routines (src/lib/adsSync.ts) against gss-stats' own D1 database, gss-stats-ads.
// Decision and trade-offs: docs/adr/0001-ads-read-store.md ("The sync Worker").
//
// Built for a small CPU budget (Workers Free: 10 ms per invocation). Every path does the least
// work first and stops as soon as it can:
//  - scheduled(): the cron gate is plain arithmetic; then ONE plan (two D1 reads) decides whether
//    anything is due. Nothing due → return: no claim, no secret read, no token refresh, no write.
//  - fetch(): POST /sync, the dashboard's "Refresh data", reachable ONLY through the gss-stats
//    Pages Service Binding (no workers.dev URL, no route). Nothing due → 200 "up to date".
//  - Only when something is due: an atomic claim (one INSERT … WHERE NOT EXISTS a run inside the
//    last 10 minutes; a concurrent request loses and gets 429), then the Ads client (secrets +
//    OAuth, cached for 45 minutes in the isolate), then the pull — at most WORKER_MAX_DAYS
//    closed days and WORKER_MAX_STATEMENTS D1 statements per run; the rest continues next run.
//  - Conversions and per-asset results (src/lib/adsSync.ts syncAdsExtras) run on a cron trigger
//    of their OWN, EXTRAS_CRON, a few ticks after the 03:00 ET close: scheduled() dispatches on
//    event.cron, so a cost tick never does extras work and an extras tick never touches cost
//    rows, claims or the cost run rows. One state read decides; nothing due → return. Each run is
//    planned BEFORE it fetches to about WORKER_EXTRAS_MAX_ROWS rows (CPU) and the D1 statements
//    WORKER_MAX_STATEMENTS leaves; the rest continues next tick.
//
// Google Ads credentials come from Cloudflare Secrets Store bindings (Bitwarden stays the source
// of truth; rotation: README "The sync Worker"). They live in memory only, are registered with
// redact() so no error or log line can carry one, and the Ads client never sends a
// login-customer-id header (src/lib/adsApi.ts buildHeaders). READ-ONLY toward Google Ads.
//
// Deliberately free of Workers ambient types (minimal local interfaces instead), so the same
// file typechecks under the dashboard's config and the Node test config.

import {
  createAdsClient,
  fetchDailyAssets,
  fetchDailyConversions,
  fetchDailySpend,
  fetchPlacementDaily,
  fetchRangeTotal,
  type AdsClient,
  type AdsCredentials,
  type FetchLike,
} from '../../../src/lib/adsApi'
import { redact, registerSecret } from '../../../src/lib/adsRedact'
import { createSqlAdsStore, d1BindingAdsDb, readLastSyncRun, STATEMENT_RESERVE, type D1Like, type SyncSource } from '../../../src/lib/adsStore'
import {
  cronShouldSync,
  ON_DEMAND_MIN_INTERVAL_MS,
  planSync,
  rateLimit,
  extrasResultSummary,
  setBuildSha,
  syncableCampaigns,
  syncAdsData,
  syncAdsExtras,
  syncResultSummary,
  workerInfo,
  type AdsExtrasSource,
  type AdsMetricsSource,
  type ExtrasResult,
  type SyncOptions,
  type SyncResult,
} from '../../../src/lib/adsSync'

/** Closed days one run may pull (all campaigns together): a normal flight tick needs 1-4. */
export const WORKER_MAX_DAYS = 7
/** D1 statements one run may send (the Free limit is 50 per invocation). */
export const WORKER_MAX_STATEMENTS = 40
/** The conversions-and-assets pass's own trigger (UTC): eight ticks, 08:20-11:50, after the 03:00
 * ET close in both EDT and EST, and inside 6 h, so each restatement window is re-checked once a
 * day. One trigger (2 of the Free plan's 5). Must match workers/sync/wrangler.toml [triggers]. */
export const EXTRAS_CRON = '20,50 8-11 * * *'
/** Rows one extras run plans to fetch (estimated per kind from the most rows one day has
 * returned). It bounds the run's CPU against the Free plan's 10 ms: 120 rows parse, diff and
 * build in about 3 ms on a cold isolate, planning adds about 1.5 ms (README, "Daily conversions
 * and per-asset results"). */
export const WORKER_EXTRAS_MAX_ROWS = 120
/** Reuse an access token this long (Google's last an hour). */
const TOKEN_REUSE_MS = 45 * 60_000

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
  /** The deploying commit (npm run ads:worker-deploy passes it as a var). */
  GIT_SHA?: string
}
interface ScheduledEventLike {
  scheduledTime: number
  cron: string
}

let cachedClient: { client: AdsClient; atMs: number } | null = null
/** For tests. */
export function resetClientCache(): void {
  cachedClient = null
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

/** The Ads client, cached in the isolate for TOKEN_REUSE_MS (a test's fetchImpl always builds a
 * fresh one). Shared by the cost and the extras pass. */
async function adsClient(env: Env, nowMs: number, fetchImpl?: FetchLike): Promise<AdsClient> {
  if (!cachedClient || nowMs - cachedClient.atMs > TOKEN_REUSE_MS || fetchImpl) {
    cachedClient = { client: await createAdsClient(await credentials(env), { fetchImpl, timeoutMs: 25_000 }), atMs: nowMs }
  }
  return cachedClient.client
}

/** The Ads source, built only when the sync has something to pull. */
function adsFactory(env: Env, nowMs: number, fetchImpl?: FetchLike): () => Promise<AdsMetricsSource> {
  return async () => {
    const client = await adsClient(env, nowMs, fetchImpl)
    return {
      daily: (id, since, until) => fetchDailySpend(client, id, since, until),
      placements: (id, since, until) => fetchPlacementDaily(client, id, since, until),
      rangeTotal: (id, since, until) => fetchRangeTotal(client, id, since, until),
    }
  }
}

/** The extras pass's Ads source (two read-only SELECTs), built only when something is due. */
function extrasAdsFactory(env: Env, nowMs: number, fetchImpl?: FetchLike): () => Promise<AdsExtrasSource> {
  return async () => {
    const client = await adsClient(env, nowMs, fetchImpl)
    return {
      conversions: (id, since, until) => fetchDailyConversions(client, id, since, until),
      assets: (id, since, until) => fetchDailyAssets(client, id, since, until),
    }
  }
}

function storeFor(env: Env) {
  return createSqlAdsStore(d1BindingAdsDb(env.gss_stats_ads), { dryRun: false, kind: 'd1-binding', maxStatements: WORKER_MAX_STATEMENTS })
}

export type RunOutcome =
  | { ran: false; reason: 'nothing due' | 'claimed by another run' | 'store unreadable'; error?: string | null }
  | { ran: true; result: SyncResult }

/** Plan → (nothing due: stop) → claim → sync. `force` (an operator's full re-pull) skips the
 * nothing-due stop but never the claim. */
export async function runSync(env: Env, source: SyncSource, nowMs: number, o: { fetchImpl?: FetchLike; full?: boolean; campaignIds?: string[]; maxDays?: number } = {}): Promise<RunOutcome> {
  setBuildSha(env.GIT_SHA)
  const store = storeFor(env)
  const opts: SyncOptions = { now: nowMs, dryRun: false, source, full: !!o.full, campaignIds: o.campaignIds, maxDays: o.maxDays ?? WORKER_MAX_DAYS }
  const snap = await planSync(store, opts)
  if (snap.error) return { ran: false, reason: 'store unreadable', error: redact(snap.error) }
  if (!snap.due) return { ran: false, reason: 'nothing due' }
  if (!(await store.claimSync(source, nowMs, ON_DEMAND_MIN_INTERVAL_MS))) return { ran: false, reason: 'claimed by another run' }
  const result = await syncAdsData({ adsFactory: adsFactory(env, nowMs, o.fetchImpl), store }, opts, snap)
  return { ran: true, result }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

/** POST /sync — on demand. Optional operator body: {"full": true, "campaignIds": [...],
 * "maxDays": n} (a full re-pull still writes only changed rows). A full re-pull is capped like
 * any run (maxDays, default WORKER_MAX_DAYS, at most 31) and keeps the newest days; it is not
 * resumed by later runs, so give a maxDays that covers the window, or run npm run
 * ads:backfill locally (uncapped). Anything else is 404/405. */
export async function handleFetch(request: Request, env: Env, nowMs: number = Date.now(), opts: { fetchImpl?: FetchLike } = {}): Promise<Response> {
  const url = new URL(request.url)
  if (url.pathname !== '/sync') return json(404, { error: 'not found' })
  if (request.method !== 'POST') return json(405, { error: 'POST only' })
  let body: { full?: unknown; campaignIds?: unknown; maxDays?: unknown } = {}
  try {
    body = ((await request.json()) ?? {}) as typeof body
  } catch {
    body = {} // no or non-JSON body: an ordinary sync
  }
  const full = body.full === true
  let campaignIds: string[] | undefined
  if (Array.isArray(body.campaignIds)) {
    campaignIds = body.campaignIds.filter((x): x is string => typeof x === 'string')
    try {
      syncableCampaigns(campaignIds)
    } catch (e) {
      return json(400, { error: redact(e) })
    }
  }
  const maxDays = Number.isInteger(body.maxDays) && (body.maxDays as number) > 0 && (body.maxDays as number) <= 31 ? (body.maxDays as number) : undefined
  const out = await runSync(env, 'worker-on-demand', nowMs, { ...opts, full, campaignIds, maxDays })
  if (!out.ran) {
    if (out.reason === 'claimed by another run') {
      const rl = rateLimit(await readLastSyncRun(env.gss_stats_ads), nowMs)
      return json(429, { ran: false, reason: 'rate-limited', retryAfterSec: rl.retryAfterSec || Math.ceil(ON_DEMAND_MIN_INTERVAL_MS / 1000), worker: workerInfo() })
    }
    return json(out.reason === 'store unreadable' ? 503 : 200, { ran: false, reason: out.reason === 'nothing due' ? 'up to date' : out.reason, error: out.error ?? null, worker: workerInfo() })
  }
  return json(200, { ran: true, full, worker: workerInfo(), ...syncResultSummary(out.result) })
}

export async function handleScheduled(event: ScheduledEventLike, env: Env, opts: { fetchImpl?: FetchLike; nowMs?: number } = {}): Promise<SyncResult | null> {
  const gate = cronShouldSync(event.scheduledTime)
  if (!gate.run) {
    console.log(JSON.stringify({ event: 'skip', cron: event.cron, reason: gate.reason }))
    return null
  }
  const out = await runSync(env, 'worker-cron', opts.nowMs ?? Date.now(), opts)
  if (!out.ran) {
    console.log(JSON.stringify({ event: 'skip', cron: event.cron, reason: out.reason, error: out.error ?? null }))
    return null
  }
  console.log(JSON.stringify({ event: 'sync', cron: event.cron, reason: gate.reason, worker: workerInfo(), ...syncResultSummary(out.result) }))
  return out.result
}

/** The EXTRAS_CRON tick: conversions and per-asset results only (src/lib/adsSync.ts
 * syncAdsExtras). No cost gate, no claim, no cost row: nothing due → one D1 read and return. */
export async function handleExtrasScheduled(event: ScheduledEventLike, env: Env, opts: { fetchImpl?: FetchLike; nowMs?: number } = {}): Promise<ExtrasResult> {
  setBuildSha(env.GIT_SHA)
  const nowMs = opts.nowMs ?? Date.now()
  const result = await syncAdsExtras(
    { adsFactory: extrasAdsFactory(env, nowMs, opts.fetchImpl), store: storeFor(env) },
    { now: nowMs, dryRun: false, source: 'worker-cron', maxRows: WORKER_EXTRAS_MAX_ROWS, statementBudget: WORKER_MAX_STATEMENTS - STATEMENT_RESERVE },
  )
  const head = result.nothingDue ? { event: 'skip', cron: event.cron, reason: 'nothing due' } : { event: 'extras', cron: event.cron, worker: workerInfo() }
  console.log(JSON.stringify({ ...head, ...extrasResultSummary(result) }))
  return result
}

export default {
  fetch: (request: Request, env: Env) => handleFetch(request, env),
  // One handler per trigger: only the EXTRAS_CRON tick runs the extras pass; every other tick is
  // the cost sync, unchanged.
  scheduled: async (event: ScheduledEventLike, env: Env) => {
    if (event.cron === EXTRAS_CRON) await handleExtrasScheduled(event, env)
    else await handleScheduled(event, env)
  },
}
