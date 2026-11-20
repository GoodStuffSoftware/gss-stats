/// <reference types="@cloudflare/workers-types" />
//
// GET /api/budget/summary: the spending pie, one level per call (docs/adr/0007-budget-section.md).
// `from`, `to` (<= 400 days apart), `person`, then by which params are present: none -> categories;
// `category` -> merchants (or accounts with `groupBy=account`); `category` + `merchant` or `account` ->
// the purchases. Spending = kinds spend, refund, fee (refunds net against spend). `reviewCount` is the
// rows flagged for review in the range and person filter.

import { budgetJson } from '../../_lib/budgetAccess'
import { defineRoute, parseSummaryQuery, runSummary } from '../../_lib/budgetDb'

export const onRequest = defineRoute({
  GET: async (ctx) => {
    const q = parseSummaryQuery(new URL(ctx.request.url).searchParams)
    return budgetJson(200, await runSummary(ctx.env.BUDGET_DB!, q))
  },
})
