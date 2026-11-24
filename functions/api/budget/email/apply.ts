/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/email/apply {items: [{matchId, expectedUpdatedAt, categoryId?}], reject?: [matchId]}, at most 50 items and 50
// rejects, one D1 batch for the whole request. Only the caller's own receipts (anything else is `not_found`, the same answer as a
// missing id). Sets the CATEGORY only, never the note. A stale `expectedUpdatedAt` is skipped, never forced. A manual or
// person-edited row keeps its category: the receipt is linked and `categoryKept` says why. One applied receipt per bank row
// (decision (l)): the other receipts of a split_receipts group stay suggestions; split_charges parts apply together or not at all.
// Answers `{applied: [{matchId, txnId, categorySet, categoryKept, updatedAt}], rejected: [matchId],
// skipped: [{matchId, reason, currentUpdatedAt?}]}`; reason is not_found, not_suggested, stale, txn_linked, incomplete_group,
// group_blocked or conflict.

import { budgetJson } from '../../../_lib/budgetAccess'
import { BudgetHttpError, assertCategory, badRequest, defineRoute, readJsonObject } from '../../../_lib/budgetDb'
import { MAX_APPLY, applyReceipts, type ApplyItem } from '../../../_lib/receiptsDb'

const matchId = (v: unknown, where: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw badRequest(`${where}: expected a match id`)
  return v
}

export const onRequest = defineRoute({
  POST: async (ctx) => {
    const db = ctx.env.BUDGET_DB!
    const body = await readJsonObject(ctx.request, 16_384)
    const raw = body.items ?? []
    const rej = body.reject ?? []
    if (!Array.isArray(raw) || !Array.isArray(rej)) throw badRequest('items and reject: expected lists')
    if (raw.length > MAX_APPLY || rej.length > MAX_APPLY) throw badRequest(`items and reject: at most ${MAX_APPLY} entries each`)
    if (raw.length + rej.length === 0) throw badRequest('items: expected 1 to 50 entries')
    const seen = new Set<number>()
    const items: ApplyItem[] = raw.map((it) => {
      if (typeof it !== 'object' || it === null || Array.isArray(it)) throw badRequest('items: each entry must be {matchId, expectedUpdatedAt}')
      const { matchId: m, expectedUpdatedAt, categoryId } = it as Record<string, unknown>
      const id = matchId(m, 'items.matchId')
      if (typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt === '' || expectedUpdatedAt.length > 40) throw badRequest('items: expectedUpdatedAt is required')
      if (categoryId !== undefined && categoryId !== null && typeof categoryId !== 'string') throw badRequest('items: categoryId must be a category id or null')
      if (seen.has(id)) throw badRequest('items: duplicate matchId')
      seen.add(id)
      return { matchId: id, expectedUpdatedAt, ...(categoryId !== undefined ? { categoryId } : {}) }
    })
    const reject = rej.map((m) => {
      const id = matchId(m, 'reject')
      if (seen.has(id)) throw badRequest('reject: duplicate matchId')
      seen.add(id)
      return id
    })
    try {
      return budgetJson(200, await applyReceipts(db, ctx.data.budgetEmail!, items, reject, (c) => assertCategory(db, c, 'categoryId', true)))
    } catch (err) {
      if (err instanceof BudgetHttpError) throw err
      // The one-applied-receipt-per-row unique index lost a race: the batch wrote nothing. A retry reads fresh state.
      if (/UNIQUE constraint failed/i.test(String((err as Error)?.message))) throw new BudgetHttpError(409, 'conflict', 'A receipt was applied to one of these rows meanwhile. Reload and try again.')
      throw err
    }
  },
})
