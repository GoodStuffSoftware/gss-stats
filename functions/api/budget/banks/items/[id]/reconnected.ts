/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/banks/items/:id/reconnected: the page calls it from an update-mode Link `onSuccess`. Owner only. D1 only.
// An Item that needs a reconnect, is about to disconnect, or is active goes to active with no error and a sync requested now;
// revoked and removed Items answer 409 item_not_active. If the bank still wants a login, the next sync's ITEM_LOGIN_REQUIRED
// puts it back to needs_reconnect (plan 4.2). Empty body.

import { budgetJson } from '../../../../../_lib/budgetAccess'
import { defineRoute } from '../../../../../_lib/budgetDb'
import { LIVE_ITEM_STATUSES, itemNotActive, requireBanks, requireOwnItem } from '../../../../../_lib/banks'

// The failed sync's claim stamp (last_sync_at) would keep the Item out of the next tick's due pick for the 15-minute claim window.
// Reconnecting releases it the way the Worker's releasedStamp does (now - window - 1 ms; keep in step with workers/banks/src/sync.ts),
// so the first tick after the reconnect syncs. An older stamp is left alone (it still orders the pick).
const CLAIM_WINDOW_MS = 15 * 60_000

export const RECONNECTED_SQL = `UPDATE bank_items SET status = 'active', last_error = NULL, sync_requested_at = ?1, updated_at = ?1,
          last_sync_at = CASE WHEN last_sync_at > ?3 THEN ?3 ELSE last_sync_at END
        WHERE id = ?2 AND status IN ('needs_reconnect','pending_disconnect','active')`

export const onRequest = defineRoute({
  POST: async (ctx) => {
    requireBanks(ctx.env)
    const db = ctx.env.BUDGET_DB!
    const id = String(ctx.params.id ?? '')
    const item = await requireOwnItem(db, id, ctx.data.budgetEmail!)
    if (!(LIVE_ITEM_STATUSES as readonly string[]).includes(item.status)) throw itemNotActive()
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()
    const r = await db.prepare(RECONNECTED_SQL).bind(now, id, new Date(nowMs - CLAIM_WINDOW_MS - 1).toISOString()).run()
    if (!r.meta.changes) throw itemNotActive()
    return budgetJson(200, { ok: true })
  },
})
