/// <reference types="@cloudflare/workers-types" />
//
// GET /api/budget/email/callback: Google returns here with ?code&state. Always answers a 302 to the
// Receipts page carrying a status code only. Logic: functions/_lib/gmailConnect.ts.

import { BUDGET_DENIED } from '../../../_lib/auth'
import { budgetJson, type BudgetData } from '../../../_lib/budgetAccess'
import { finishConnect, type ReceiptsConnectEnv } from '../../../_lib/gmailConnect'

export const onRequest: PagesFunction<ReceiptsConnectEnv, any, BudgetData> = async (ctx) => {
  const email = ctx.data.budgetEmail
  if (!email) return budgetJson(403, BUDGET_DENIED)
  if (ctx.request.method.toUpperCase() !== 'GET') return budgetJson(405, { error: 'method_not_allowed' }, { Allow: 'GET' })
  return finishConnect(ctx.request, ctx.env, email, Date.now())
}
