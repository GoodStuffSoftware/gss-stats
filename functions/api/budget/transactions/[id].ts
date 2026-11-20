/// <reference types="@cloudflare/workers-types" />
//
// PATCH /api/budget/transactions/:id: one manual edit (category, kind, note).
// Body (TxnPatch): `expectedUpdatedAt` (the row's updated_at as the client last saw it; required) and at
// least one of `categoryId` (an id, or null = uncategorized), `kind`, `note`. Sending a category makes
// category_source 'manual', sending a kind makes kind_source 'manual' (manual beats rule beats auto, so no
// rule re-apply or re-import changes the field again), and either clears the review flag. The edit lands
// in category_edits in the same batch (one transaction). A stale expectedUpdatedAt answers 409 with the
// row as it is now (`current`); nothing is written.

import type { TxnPatchResponse } from '../../../../src/lib/budget/types'
import { UNCATEGORIZED } from '../../../../src/lib/budget/types'
import { budgetJson } from '../../../_lib/budgetAccess'
import {
  BudgetHttpError, MAX_BODY, TXN_COLUMNS, assertCategory, badRequest, defineRoute, getTxn, isKind, isTxnId, mapTxn, nextStamp, notFound,
  readJsonObject,
} from '../../../_lib/budgetDb'

const conflict = (current: unknown) => new BudgetHttpError(409, 'conflict', 'the row changed since you loaded it', { current })

export const onRequest = defineRoute({
  PATCH: async (ctx) => {
    const db = ctx.env.BUDGET_DB!
    const id = String(ctx.params.id ?? '')
    const body = await readJsonObject(ctx.request, MAX_BODY.patch)

    const expected = body.expectedUpdatedAt
    if (typeof expected !== 'string' || expected === '' || expected.length > 40) throw badRequest('expectedUpdatedAt: required (the row\'s updated_at)')
    const hasCategory = 'categoryId' in body
    let categoryId: string | null = null
    if (hasCategory) {
      const c = body.categoryId
      if (c !== null && typeof c !== 'string') throw badRequest('categoryId: expected a category id or null')
      categoryId = c === UNCATEGORIZED || c === '' ? null : c
    }
    const hasKind = body.kind !== undefined
    if (hasKind && !isKind(body.kind)) throw badRequest('kind: not a known kind')
    const hasNote = 'note' in body
    let note: string | null = null
    if (hasNote) {
      const n = body.note
      if (n !== null && typeof n !== 'string') throw badRequest('note: expected text or null')
      if (typeof n === 'string' && (n.length > 500 || n.includes('\u0000'))) throw badRequest('note: over 500 characters')
      note = n === '' ? null : n
    }
    if (!hasCategory && !hasKind && !hasNote) throw badRequest('body: nothing to change (send categoryId, kind or note)')
    await assertCategory(db, categoryId, 'categoryId', true)

    if (!isTxnId(id)) throw notFound()
    const before = await getTxn(db, id)
    if (!before) throw notFound()
    if (before.updatedAt !== expected) throw conflict(before)

    const who = ctx.data.budgetEmail!
    const stamp = nextStamp(before.updatedAt)
    const sets = ['updated_at = ?', 'updated_by = ?']
    const params: Array<string | number | null> = [stamp, who]
    if (hasCategory) { sets.push('category_id = ?', "category_source = 'manual'", 'rule_id = NULL'); params.push(categoryId) }
    if (hasKind) { sets.push('kind = ?', "kind_source = 'manual'"); params.push(body.kind as string) }
    if (hasCategory || hasKind) sets.push('needs_review = 0', 'review_reason = NULL', 'confidence = 100')
    if (hasNote) { sets.push('note = ?'); params.push(note) }

    const stmts = [db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ? AND updated_at = ?`).bind(...params, id, before.updatedAt)]
    if (hasCategory || hasKind) {
      stmts.push(db.prepare(
        `INSERT INTO category_edits (txn_id, old_category_id, new_category_id, old_kind, new_kind, rule_id, edited_at, edited_by)
         SELECT id, ?, category_id, ?, kind, NULL, updated_at, updated_by FROM transactions WHERE id = ? AND updated_at = ?`,
      ).bind(before.categoryId, before.kind, id, stamp))
    }
    stmts.push(db.prepare(`SELECT ${TXN_COLUMNS} FROM transactions WHERE id = ?`).bind(id))
    const results = await db.batch(stmts)
    const row = results[results.length - 1].results[0] as Record<string, unknown> | undefined
    if (Number(results[0].meta?.changes ?? 0) === 0) throw conflict(row ? mapTxn(row) : before)
    const body200: TxnPatchResponse = { txn: mapTxn(row!) }
    return budgetJson(200, body200)
  },
})
