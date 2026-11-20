/// <reference types="@cloudflare/workers-types" />
//
// PUT /api/budget/debts/:id/balance: a typed balance for a debt (the way a payment-only debt gets one, or
// an override for any debt). Body (ManualBalance): `asOf` (a real date), `balanceCents` (integer >= 0),
// optional `aprBp` (0-10000). Keyed (account, asOf): sending the same day again replaces it.
// 404 for an unknown account, 400 for an account that is not a debt.

import { budgetJson } from '../../../../_lib/budgetAccess'
import { MAX_BODY, badRequest, defineRoute, isAccountId, notFound, parseManualBalance, readJsonObject } from '../../../../_lib/budgetDb'

export const onRequest = defineRoute({
  PUT: async (ctx) => {
    const db = ctx.env.BUDGET_DB!
    const id = String(ctx.params.id ?? '')
    const body = parseManualBalance(await readJsonObject(ctx.request, MAX_BODY.balance))
    if (!isAccountId(id)) throw notFound()
    const acct = await db.prepare('SELECT is_debt FROM accounts WHERE id = ?').bind(id).first<{ is_debt: number }>()
    if (!acct) throw notFound()
    if (Number(acct.is_debt) !== 1) throw badRequest('account: not a debt account')
    await db.prepare(
      `INSERT INTO debt_balances (account_id, as_of, balance_cents, apr_bp, entered_at, entered_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, as_of) DO UPDATE SET balance_cents = excluded.balance_cents, apr_bp = excluded.apr_bp,
         entered_at = excluded.entered_at, entered_by = excluded.entered_by`,
    ).bind(id, body.asOf, body.balanceCents, body.aprBp, new Date().toISOString(), ctx.data.budgetEmail!).run()
    return budgetJson(200, { ok: true })
  },
})
