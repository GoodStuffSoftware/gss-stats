/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/banks/items/:id/reconnected: the page calls it from an update-mode Link `onSuccess`. Owner only. D1 only.
// An Item that needs a reconnect, is about to disconnect, or is active goes to active with no error and a sync requested now;
// revoked and removed Items answer 409 item_not_active. If the bank still wants a login, the next sync's ITEM_LOGIN_REQUIRED
// puts it back to needs_reconnect (plan 4.2). Empty body.

import { budgetJson } from '../../../../../_lib/budgetAccess'
import { defineRoute } from '../../../../../_lib/budgetDb'
import { LIVE_ITEM_STATUSES, itemNotActive, requireBanks, requireOwnItem } from '../../../../../_lib/banks'

export const RECONNECTED_SQL = `UPDATE bank_items SET status = 'active', last_error = NULL, sync_requested_at = ?1, updated_at = ?1
        WHERE id = ?2 AND status IN ('needs_reconnect','pending_disconnect','active')`

export const onRequest = defineRoute({
  POST: async (ctx) => {
    requireBanks(ctx.env)
    const db = ctx.env.BUDGET_DB!
    const id = String(ctx.params.id ?? '')
    const item = await requireOwnItem(db, id, ctx.data.budgetEmail!)
    if (!(LIVE_ITEM_STATUSES as readonly string[]).includes(item.status)) throw itemNotActive()
    const now = new Date().toISOString()
    const r = await db.prepare(RECONNECTED_SQL).bind(now, id).run()
    if (!r.meta.changes) throw itemNotActive()
    return budgetJson(200, { ok: true })
  },
})
