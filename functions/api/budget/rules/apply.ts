/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/rules/apply: re-run the active rules over stored rows.
// Body: `{ merchantKeys?: string[] }` (at most 200; omitted = every merchant that has an active rule).
// Precedence manual > rule > auto per field: a manual category or kind is never changed, and rows that
// match no rule are left alone. Answers `{ changed }`, the number of rows that changed.

import { budgetJson } from '../../../_lib/budgetAccess'
import { MAX_BODY, MAX_MERCHANT_KEYS, applyRules, badRequest, defineRoute, readJsonObject } from '../../../_lib/budgetDb'

export const onRequest = defineRoute({
  POST: async (ctx) => {
    const body = await readJsonObject(ctx.request, MAX_BODY.apply)
    let keys: string[] | null = null
    if (body.merchantKeys !== undefined) {
      const k = body.merchantKeys
      if (!Array.isArray(k)) throw badRequest('merchantKeys: expected a list of merchant keys')
      if (k.length > MAX_MERCHANT_KEYS) throw badRequest(`merchantKeys: at most ${MAX_MERCHANT_KEYS}`)
      for (const m of k) if (typeof m !== 'string' || m.length < 1 || m.length > 80 || m.includes('\u0000')) throw badRequest('merchantKeys: each key is 1-80 characters')
      keys = [...new Set(k as string[])]
    }
    return budgetJson(200, { changed: await applyRules(ctx.env.BUDGET_DB!, keys, ctx.data.budgetEmail!) })
  },
})
