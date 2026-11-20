/// <reference types="@cloudflare/workers-types" />
//
// Catch-all for /api/budget/*: any path no specific budget route claims answers 404 here, so the
// scoped middleware (functions/api/budget/_middleware.ts) runs for every budget URL and an unknown
// one never falls through to the static assets. Specific routes win over this one.

import { BUDGET_DENIED } from '../../_lib/auth'
import { budgetJson, type BudgetData, type BudgetEnv } from '../../_lib/budgetAccess'

export const onRequest: PagesFunction<BudgetEnv, any, BudgetData> = async (ctx) => {
  if (!ctx.data.budgetEmail) return budgetJson(403, BUDGET_DENIED)
  return budgetJson(404, { error: 'not_found' })
}
