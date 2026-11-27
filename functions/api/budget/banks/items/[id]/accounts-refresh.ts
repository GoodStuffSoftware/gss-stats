/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/banks/items/:id/accounts-refresh: the page calls it after an update-mode Link with account selection
// succeeds. Owner only (403 not_owner, no Worker call). The Worker adds the accounts the owner just shared as unmapped rows
// (plan 4.5). Answers `{ added }`, a count only. Empty body.

import { budgetJson } from '../../../../../_lib/budgetAccess'
import { BudgetHttpError, defineRoute } from '../../../../../_lib/budgetDb'
import { BANKS_TIMEOUT_MS, callBanks, requireBanks, requireOwnItem } from '../../../../../_lib/banks'

export const onRequest = defineRoute({
  POST: async (ctx) => {
    requireBanks(ctx.env)
    const db = ctx.env.BUDGET_DB!
    const id = String(ctx.params.id ?? '')
    const email = ctx.data.budgetEmail!
    await requireOwnItem(db, id, email)
    const answer = await callBanks(ctx.env, '/accounts-refresh', { ownerEmail: email.trim().toLowerCase(), itemId: id }, BANKS_TIMEOUT_MS.accounts)
    if (typeof answer.added !== 'number') throw new BudgetHttpError(502, 'banks_failed')
    return budgetJson(200, { added: answer.added })
  },
})
