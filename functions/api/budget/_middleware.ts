/// <reference types="@cloudflare/workers-types" />
//
// Scoped middleware for every /api/budget/* Function: the second auth layer behind the root gate
// (functions/_middleware.ts), see functions/_lib/budgetAccess.ts and docs/adr/0007-budget-section.md.
// It sets `context.data.budgetEmail` (the one identity every budget route reads; a route that finds
// it missing answers 403) and stamps every response `private, no-store` + `Vary: Cookie`.

import { authorizeBudget, budgetJson, noStore, type BudgetData, type BudgetEnv } from '../../_lib/budgetAccess'

export const onRequest: PagesFunction<BudgetEnv, any, BudgetData> = async (ctx) => {
  const access = await authorizeBudget(ctx.request, ctx.env)
  if (!access.ok) return access.response
  ctx.data.budgetEmail = access.email
  try {
    return noStore(await ctx.next())
  } catch (err) {
    console.error(`budget: unhandled error: ${String((err as Error)?.message ?? err)}`)
    return budgetJson(500, { error: 'internal_error' })
  }
}
