/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/banks/items/:id/sync: "Sync now". D1 only: marks the Item as wanting a sync; the Worker's cron picks it up
// within 10 minutes. Any listed person, active Items only (409 item_not_active). Empty body.

import { budgetJson } from '../../../../../_lib/budgetAccess'
import { BudgetHttpError, defineRoute } from '../../../../../_lib/budgetDb'
import { itemNotActive, itemOwner, requireBanks } from '../../../../../_lib/banks'

export const SYNC_REQUEST_SQL = "UPDATE bank_items SET sync_requested_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'active'"

export const onRequest = defineRoute({
  POST: async (ctx) => {
    requireBanks(ctx.env)
    const db = ctx.env.BUDGET_DB!
    const id = String(ctx.params.id ?? '')
    const item = await itemOwner(db, id)
    if (!item) throw new BudgetHttpError(404, 'item_not_found')
    const now = new Date().toISOString()
    const r = await db.prepare(SYNC_REQUEST_SQL).bind(now, id).run()
    if (!r.meta.changes) throw itemNotActive()
    return budgetJson(200, { ok: true })
  },
})
