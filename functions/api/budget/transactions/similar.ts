/// <reference types="@cloudflare/workers-types" />
//
// /api/budget/transactions/similar: "apply this category to the merchant's other purchases" (ADR 0007, point 12).
//
// GET ?id=<transaction id>: the candidates for that row, from ONE statement (SIMILAR_SQL): same merchant, any month, same
//   kind group, not already in the row's category, newest first, at most MAX_SIMILAR. The URL carries only the opaque id.
//   `mixed` (a payment-service key, several display names, or 3+ categories) says the merchant is not one thing: the client then
//   defaults to same-amount rows and no rule is offered. Per row: `personSet` (a person chose it: never pre-ticked), `scriptSet`
//   (a data-fix script chose it), `sameAmount`, `suggestTick` (not person-set, and not script-set on a mixed merchant).
// POST {sourceId, categoryId, items: [{id, expectedUpdatedAt}], makeRule?}: one D1 batch changes the listed rows to the category
//   (manual, as the PATCH does) and writes one category_edits row per change under the signed-in person. Only other rows of the
//   source's merchant change; a row whose updated_at moved, or that is another merchant's, is left alone and comes back in
//   `conflicts` with its current state. `makeRule` (ordinary merchants only, else 409 rule_unsafe) also upserts the merchant-wide
//   rule in the same batch; it does not re-apply it.

import type { SimilarApplyResponse, SimilarResponse } from '../../../../src/lib/budget/types'
import { UNCATEGORIZED } from '../../../../src/lib/budget/types'
import { budgetJson } from '../../../_lib/budgetAccess'
import {
  BudgetHttpError, MAX_BODY, MAX_SIMILAR, SIMILAR_SQL, applySimilar, assertCategory, badRequest, buildSimilar, defineRoute, editRuleStmt, getTxn, isTxnId,
  merchantRuleId, notFound, readJsonObject, type SimilarItem,
} from '../../../_lib/budgetDb'

async function readSimilar(db: D1Database, id: string): Promise<SimilarResponse> {
  const { results } = await db.prepare(SIMILAR_SQL).bind(id).all<Record<string, unknown>>()
  const res = buildSimilar(results)
  if (!res) throw notFound()
  return res
}

export const onRequest = defineRoute({
  GET: async (ctx) => {
    const id = new URL(ctx.request.url).searchParams.get('id')
    if (!isTxnId(id)) throw badRequest('id: expected a transaction id')
    return budgetJson(200, await readSimilar(ctx.env.BUDGET_DB!, id))
  },

  POST: async (ctx) => {
    const db = ctx.env.BUDGET_DB!
    const body = await readJsonObject(ctx.request, MAX_BODY.similar)
    const sourceId = body.sourceId
    if (!isTxnId(sourceId)) throw badRequest('sourceId: expected a transaction id')
    if (!('categoryId' in body)) throw badRequest('categoryId: required (an id, or null = uncategorized)')
    const c = body.categoryId
    if (c !== null && typeof c !== 'string') throw badRequest('categoryId: expected a category id or null')
    const categoryId = c === UNCATEGORIZED || c === '' ? null : c
    if (body.makeRule !== undefined && typeof body.makeRule !== 'boolean') throw badRequest('makeRule: expected true or false')
    const makeRule = body.makeRule === true
    if (makeRule && categoryId === null) throw badRequest('makeRule: a rule needs a category')
    const raw = body.items
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_SIMILAR) throw badRequest(`items: expected 1 to ${MAX_SIMILAR} entries`)
    const items: SimilarItem[] = []
    const seen = new Set<string>()
    for (const it of raw) {
      if (typeof it !== 'object' || it === null || Array.isArray(it)) throw badRequest('items: each entry must be {id, expectedUpdatedAt}')
      const { id, expectedUpdatedAt } = it as Record<string, unknown>
      if (!isTxnId(id)) throw badRequest('items: id must be a transaction id')
      if (typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt === '' || expectedUpdatedAt.length > 40) throw badRequest('items: expectedUpdatedAt is required')
      if (id === sourceId) throw badRequest('items: the source row is not a candidate')
      if (seen.has(id)) throw badRequest('items: duplicate id')
      seen.add(id)
      items.push({ id, expectedUpdatedAt })
    }
    await assertCategory(db, categoryId, 'categoryId', true)

    const who = ctx.data.budgetEmail!
    let rule: D1PreparedStatement | null = null
    let ruleInfo: { id: string; created: boolean } | undefined
    if (makeRule) {
      const read = await readSimilar(db, sourceId)
      if (read.source.categoryId !== categoryId) throw badRequest('sourceId: its category is not categoryId')
      if (!read.ruleOffer.allowed) throw new BudgetHttpError(409, 'rule_unsafe', 'A rule on this merchant would reach other merchants. Edit the rows one at a time instead.')
      const ruleId = await merchantRuleId(read.source.merchantKey)
      const existed = await db.prepare('SELECT 1 AS x FROM merchant_rules WHERE id = ?').bind(ruleId).first()
      rule = editRuleStmt(db, { id: ruleId, merchantKey: read.source.merchantKey, storeNo: null, setCategoryId: categoryId, setKind: null }, who, new Date().toISOString())
      ruleInfo = { id: ruleId, created: !existed }
    } else if (!(await getTxn(db, sourceId))) {
      throw notFound()
    }

    const { changed, conflicts } = await applySimilar(db, sourceId, categoryId, items, who, rule)
    const res: SimilarApplyResponse = { changed, conflicts, ...(ruleInfo ? { rule: ruleInfo } : {}) }
    return budgetJson(200, res)
  },
})
