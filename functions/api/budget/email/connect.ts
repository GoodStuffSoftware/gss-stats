/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/email/connect  {consent: <version>}  ->  {url}: where to send the browser (Google's
// consent screen). The state cookie is set here. Logic: functions/_lib/gmailConnect.ts.

import { BUDGET_DENIED } from '../../../_lib/auth'
import { budgetJson, type BudgetData } from '../../../_lib/budgetAccess'
import { startConnect, type ReceiptsConnectEnv } from '../../../_lib/gmailConnect'

export const onRequest: PagesFunction<ReceiptsConnectEnv, any, BudgetData> = async (ctx) => {
  const email = ctx.data.budgetEmail
  if (!email) return budgetJson(403, BUDGET_DENIED)
  if (ctx.request.method.toUpperCase() !== 'POST') return budgetJson(405, { error: 'method_not_allowed' }, { Allow: 'POST' })
  return startConnect(ctx.request, ctx.env, email, Date.now())
}
