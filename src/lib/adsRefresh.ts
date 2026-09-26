// The dashboard's "Refresh data" (POST /api/ads/refresh, functions/api/ads/refresh.ts): when a
// campaign's Ads data is stale, ask the gss-stats-sync Worker — through the Pages project's
// Service Binding, never a public URL — to run the shared sync. The Worker enforces the rate
// limit atomically (one sync per 10 minutes, claimed with a single INSERT); the check here only
// saves a call. The dashboard itself never holds Google Ads credentials or calls the Ads API.
// Pure over its inputs (a D1 reader and a Service-Binding-shaped fetcher), so it is unit-tested
// with stubs.

import type { AdsFreshness } from './adsFreshness'
import { readFreshness, readLastSyncRun, type D1Reader } from './adsStore'
import { campaignsConfigHash, rateLimit } from './adsSync'

/** A Service Binding (Fetcher) as far as this module needs it. */
export interface SyncService {
  fetch(input: string, init?: { method?: string }): Promise<{ status: number; json(): Promise<unknown> }>
}
export const SYNC_SERVICE_URL = 'https://gss-stats-sync/sync'

export type RefreshReason = 'synced' | 'up to date' | 'rate-limited' | 'sync failed' | 'not available'
export interface RefreshResult {
  refreshed: boolean
  reason: RefreshReason
  retryAfterSec?: number
  /** The Worker's summary (counts and ranges only). */
  sync?: unknown
  /** The sync Worker was built from different campaign definitions than this dashboard: it
   * needs a redeploy (npm run ads:worker-deploy). null = the Worker was not asked. */
  workerConfigDrift: boolean | null
  freshness: Record<string, AdsFreshness>
}

export async function refreshAds(i: { db: D1Reader | null | undefined; sync: SyncService | null | undefined; campaignIds: readonly string[]; nowMs: number; clock?: () => number }): Promise<RefreshResult> {
  const pick = (m: Map<string, AdsFreshness>) => Object.fromEntries(i.campaignIds.map((id) => [id, m.get(id)!]).filter(([, f]) => f)) as Record<string, AdsFreshness>
  const before = await readFreshness(i.db, i.nowMs)
  const base = { workerConfigDrift: null as boolean | null }
  if (!i.db || !i.sync) return { ...base, refreshed: false, reason: 'not available', freshness: pick(before) }
  if (!i.campaignIds.some((id) => before.get(id)?.stale)) return { ...base, refreshed: false, reason: 'up to date', freshness: pick(before) }
  const rl = rateLimit(await readLastSyncRun(i.db), i.nowMs)
  if (rl.limited) return { ...base, refreshed: false, reason: 'rate-limited', retryAfterSec: rl.retryAfterSec, freshness: pick(before) }
  let status = 0
  let body: Record<string, unknown> = {}
  try {
    const res = await i.sync.fetch(SYNC_SERVICE_URL, { method: 'POST' })
    status = res.status
    body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
  } catch {
    return { ...base, refreshed: false, reason: 'sync failed', freshness: pick(before) }
  }
  const worker = body.worker as { campaignsHash?: unknown } | undefined
  const drift = typeof worker?.campaignsHash === 'string' ? worker.campaignsHash !== campaignsConfigHash() : null
  const after = pick(await readFreshness(i.db, (i.clock ?? Date.now)()))
  if (status === 429) return { refreshed: false, reason: 'rate-limited', retryAfterSec: Number(body.retryAfterSec) || undefined, workerConfigDrift: drift, freshness: after }
  if (status === 200 && body.ran === false) return { refreshed: false, reason: 'up to date', workerConfigDrift: drift, freshness: after }
  if (status !== 200 || body.ran !== true) return { refreshed: false, reason: 'sync failed', workerConfigDrift: drift, freshness: after }
  return { refreshed: true, reason: body.status === 'failed' ? 'sync failed' : 'synced', sync: body, workerConfigDrift: drift, freshness: after }
}
