/// <reference types="@cloudflare/workers-types" />
//
// GET /api/budget/transactions: one page of transactions, newest first (posted_date DESC, id DESC).
// `from`, `to`, `person`, `scope` (spending | all), optional `category` ('__none__' = uncategorized),
// `merchant`, `account`, `review=1`, `limit` (1-200, default 100) and `cursor` (the previous page's
// nextCursor: keyset paging, stable while rows are edited).

import { budgetJson } from '../../../_lib/budgetAccess'
import { defineRoute, parseTxnQuery, runTxnList } from '../../../_lib/budgetDb'

export const onRequest = defineRoute({
  GET: async (ctx) => {
    const q = parseTxnQuery(new URL(ctx.request.url).searchParams)
    return budgetJson(200, await runTxnList(ctx.env.BUDGET_DB!, q))
  },
})
