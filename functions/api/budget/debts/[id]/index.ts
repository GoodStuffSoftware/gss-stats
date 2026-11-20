/// <reference types="@cloudflare/workers-types" />
//
// GET /api/budget/debts/:id: one debt's detail: balance history (statements plus typed balances, oldest
// first, at most 24 of each), per-period rate and interest, and the newest 60 payments (positive amounts:
// what was paid toward the debt). 404 for an id that is not a debt account.

import { budgetJson } from '../../../../_lib/budgetAccess'
import { defineRoute, isAccountId, loadDebtDetail, notFound } from '../../../../_lib/budgetDb'

export const onRequest = defineRoute({
  GET: async (ctx) => {
    const id = String(ctx.params.id ?? '')
    if (!isAccountId(id)) throw notFound()
    const detail = await loadDebtDetail(ctx.env.BUDGET_DB!, id)
    if (!detail) throw notFound()
    return budgetJson(200, detail)
  },
})
