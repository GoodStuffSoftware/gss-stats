/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/banks/items/:id/unlink `{ confirm: true }` (at most 1 KB): stops a bank link for good. Owner only. The Worker
// tells Plaid to drop the Item and wipes the token; Budget rows stay, the Item leaves the list, and its slot stays used (Plaid never
// gives one back). A Worker failure leaves the Item as it was.

import { budgetJson } from '../../../../../_lib/budgetAccess'
import { badRequest, defineRoute, readJsonObject } from '../../../../../_lib/budgetDb'
import { BANKS_TIMEOUT_MS, callBanks, requireBanks, requireOwnItem } from '../../../../../_lib/banks'

export const MAX_BODY_UNLINK = 1024

export const onRequest = defineRoute({
  POST: async (ctx) => {
    requireBanks(ctx.env)
    const db = ctx.env.BUDGET_DB!
    const id = String(ctx.params.id ?? '')
    const email = ctx.data.budgetEmail!
    const body = await readJsonObject(ctx.request, MAX_BODY_UNLINK)
    if (body.confirm !== true) throw badRequest('confirm: send { "confirm": true } to unlink')
    await requireOwnItem(db, id, email)
    await callBanks(ctx.env, '/unlink', { ownerEmail: email.trim().toLowerCase(), itemId: id }, BANKS_TIMEOUT_MS.unlink)
    return budgetJson(200, { ok: true })
  },
})
