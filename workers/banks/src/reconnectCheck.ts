// The daily reconnect check (plan 4.1, recovery path 2 of 3): an Item in needs_reconnect is looked at once in 24 h, at most
// 3 per tick. Claim with the 24 h window (0 changes = skip), then /item/get; `item.error` null means the bank login is
// good again, so markRepaired (active, last_error NULL, sync_requested_at = now; the next tick syncs it). An error still
// there, or a failed call, changes nothing: the claim already moved last_sync_at, so the next look is in 24 h.
// Active items never get an /item/get here. No bank_sync_runs row. Logs: counts and codes only.
import type { Env } from './env'
import { log } from './log'
import type { PlaidClient } from './plaid'
import { getItem, openAndRefreshToken, type Keys } from './store'
import { RECONNECT_WINDOW_MS, claim, pickReconnect } from './sync'
import { markRepaired } from './webhook'

export async function reconnectCheck(db: D1Database, env: Env, client: PlaidClient, keys: Keys, now: Date): Promise<{ checked: number; repaired: number }> {
  let checked = 0
  let repaired = 0
  for (const id of await pickReconnect(db, now)) {
    if (!(await claim(db, id, now, RECONNECT_WINDOW_MS))) continue
    try {
      const item = await getItem(db, id)
      if (!item || item.status !== 'needs_reconnect' || item.environment !== (env.PLAID_ENV ?? '')) continue
      checked++
      const token = await openAndRefreshToken(db, item, keys)
      const res = await client.post<{ item?: { error?: unknown } }>('/item/get', { access_token: token })
      if (res.item && res.item.error === null && (await markRepaired(db, id, now)) > 0) repaired++
    } catch {
      log('reconnect_check_failed', {}, 'item_get_failed') // no change; checked again in 24 h
    }
  }
  if (checked > 0) log('reconnect_check', { checked, repaired })
  return { checked, repaired }
}
