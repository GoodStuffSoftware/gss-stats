/// <reference types="@cloudflare/workers-types" />
//
// PATCH /api/budget/email/receipts/<id> {dismissed: boolean}: dismiss a receipt (suggested or unmatched) or undo it. Owner only:
// a receipt that is not the caller's answers 404, exactly like one that does not exist. A wrong state (dismissing an applied
// receipt) is 409. Answers `{id, status}`.

import { budgetJson } from '../../../../_lib/budgetAccess'
import { BudgetHttpError, badRequest, defineRoute, notFound, readJsonObject } from '../../../../_lib/budgetDb'
import { RECEIPT_ID_RE, setDismissed } from '../../../../_lib/receiptsDb'

export const onRequest = defineRoute({
  PATCH: async (ctx) => {
    const id = String((ctx.params as Record<string, unknown>).id ?? '')
    if (!RECEIPT_ID_RE.test(id)) throw notFound()
    const body = await readJsonObject(ctx.request, 1024)
    if (typeof body.dismissed !== 'boolean') throw badRequest('dismissed: expected true or false')
    const r = await setDismissed(ctx.env.BUDGET_DB!, id, ctx.data.budgetEmail!, body.dismissed)
    if (!r.found) throw notFound()
    if (r.status === null) throw new BudgetHttpError(409, 'bad_state', 'This receipt cannot change that way.')
    return budgetJson(200, { id, status: r.status })
  },
})
