/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/banks/dropped/:txnId `{ action: 'delete' | 'keep' }` (at most 1 KB): settles a row the bank removed after a person
// had edited it (plan 3.1). Any listed person, like a row edit. The row must still be `dropped` (404 otherwise).
//   delete: removes the Budget row. Its category edits, receipt matches and bank mapping go with it (ON DELETE CASCADE; an applied
//           receipt match puts its receipt back to unmatched through the 0004 trigger).
//   keep:   the mapping becomes `kept`: the row stays as an ordinary row and the bank never touches it again.
// One guarded statement each, so a second click (or two people at once) finds nothing to do and answers 404.

import { budgetJson } from '../../../../_lib/budgetAccess'
import { badRequest, defineRoute, isTxnId, notFound, readJsonObject } from '../../../../_lib/budgetDb'
import { requireBanks } from '../../../../_lib/banks'

export const MAX_BODY_DROPPED = 1024

const STILL_DROPPED = "EXISTS (SELECT 1 FROM bank_txns b WHERE b.txn_id = ?1 AND b.state = 'dropped')"
export const DELETE_DROPPED_SQL = `DELETE FROM transactions WHERE id = ?1 AND ${STILL_DROPPED}`
export const UNPAIR_PARTNER_SQL = `UPDATE transactions SET pair_id = NULL
  WHERE id = (SELECT pair_id FROM transactions WHERE id = ?1) AND pair_id = ?1 AND ${STILL_DROPPED}`

export const onRequest = defineRoute({
  POST: async (ctx) => {
    requireBanks(ctx.env)
    const db = ctx.env.BUDGET_DB!
    const id = String(ctx.params.txnId ?? '')
    const body = await readJsonObject(ctx.request, MAX_BODY_DROPPED)
    const action = body.action
    if (action !== 'delete' && action !== 'keep') throw badRequest("action: expected 'delete' or 'keep'")
    if (!isTxnId(id)) throw notFound()

    if (action === 'delete') {
      // One batch: first clear the transfer partner's pair_id (it has no foreign key, so it would point at a missing row; the
      // sync's own delete does the same), then delete. Both are guarded by the same "still dropped" test, so a second click
      // finds nothing to do. The partner is found by primary key through this row's own pair_id.
      const [, r] = await db.batch([
        db.prepare(UNPAIR_PARTNER_SQL).bind(id),
        db.prepare(DELETE_DROPPED_SQL).bind(id),
      ])
      if (!r.meta.changes) throw notFound()
      return budgetJson(200, { ok: true })
    }
    const r = await db.prepare("UPDATE bank_txns SET state = 'kept', updated_at = ? WHERE txn_id = ? AND state = 'dropped'").bind(new Date().toISOString(), id).run()
    if (!r.meta.changes) throw notFound()
    return budgetJson(200, { ok: true })
  },
})
