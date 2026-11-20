/// <reference types="@cloudflare/workers-types" />
//
// GET /api/budget/access: "may this account open Budget?" The scoped middleware has already decided
// (403 for an account off the list), so reaching this handler is the answer. The SPA calls it once
// per load to show or hide the Budget link. No database read.

import type { AccessResponse } from '../../../src/lib/budget/types'
import { BUDGET_DENIED } from '../../_lib/auth'
import { budgetJson, type BudgetData, type BudgetEnv } from '../../_lib/budgetAccess'

export const onRequest: PagesFunction<BudgetEnv, any, BudgetData> = async (ctx) => {
  const email = ctx.data.budgetEmail
  if (!email) return budgetJson(403, BUDGET_DENIED)
  const method = ctx.request.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    return budgetJson(405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' })
  }
  const body: AccessResponse = { ok: true, email }
  return budgetJson(200, body)
}
