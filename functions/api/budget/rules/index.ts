/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/rules: turn a manual edit into a merchant rule ("use for all <merchant>").
// Body (RuleFromEdit): `txnId` and `scope` ('merchant' = every store, 'merchant_store' = this store only;
// the row must have a store number). The row must carry a manual category (and/or a manual kind): that is
// what the rule teaches. The rule id is deterministic (ruleIdFor), so repeating the call upserts. The rule
// is then re-applied to the merchant's rows with the engine (manual rows never change, a more specific
// existing rule still wins); `reapplied` is how many rows changed. Refused with 409 when the key is a payment-service
// key or its rows carry more than one display name (the rule would reach other merchants).

import type { RuleResponse } from '../../../../src/lib/budget/types'
import { budgetJson } from '../../../_lib/budgetAccess'
import {
  BudgetHttpError, MAX_BODY, RULE_COLUMNS, applyRules, assertCategory, badRequest, defineRoute, getTxn, isTxnId, mapRule, notFound, readJsonObject,
  ruleFromTxn, ruleUnsafeReasons,
} from '../../../_lib/budgetDb'

export const onRequest = defineRoute({
  POST: async (ctx) => {
    const db = ctx.env.BUDGET_DB!
    const body = await readJsonObject(ctx.request, MAX_BODY.rule)
    if (typeof body.txnId !== 'string' || body.txnId === '') throw badRequest('txnId: required')
    if (body.scope !== 'merchant' && body.scope !== 'merchant_store') throw badRequest("scope: expected 'merchant' or 'merchant_store'")
    if (!isTxnId(body.txnId)) throw notFound('transaction not found')
    const txn = await getTxn(db, body.txnId)
    if (!txn) throw notFound('transaction not found')
    if (txn.merchantKey === '') throw badRequest('txnId: this row has no merchant to make a rule for')
    if (body.scope === 'merchant_store' && !txn.storeNo) throw badRequest('scope: this row has no store number')

    // A category archived after the edit must not become a rule's category (same refusal as the PATCH).
    if (txn.categorySource === 'manual') await assertCategory(db, txn.categoryId, 'txnId', true)
    const learned = await ruleFromTxn({ ...txn, categoryId: txn.categorySource === 'manual' ? txn.categoryId : null }, body.scope)
    if (!learned.setCategoryId && !learned.setKind) throw badRequest('txnId: this row has no manual category or kind to learn from')

    // A key shared by several merchants (or a payment service's key) would make the rule reach merchants the row does not name.
    const unsafe = (await ruleUnsafeReasons(db, [txn.merchantKey])).get(txn.merchantKey)
    if (unsafe) throw new BudgetHttpError(409, 'rule_unsafe', `A rule on this row's merchant key would reach other merchants (${unsafe}). Edit the rows one at a time instead.`)
    const who = ctx.data.budgetEmail!
    const now = new Date().toISOString()
    await db.prepare(
      `INSERT INTO merchant_rules (id, merchant_key, store_no, account_id, amount_min_cents, amount_max_cents, set_category_id, set_kind,
         debt_account_id, display_name, confidence, review, review_reason, source, active, created_at, created_by)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, 90, 0, NULL, 'edit', 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET set_category_id = COALESCE(excluded.set_category_id, merchant_rules.set_category_id),
         set_kind = COALESCE(excluded.set_kind, merchant_rules.set_kind), review = 0, review_reason = NULL, active = 1, source = 'edit'`,
    ).bind(learned.id, txn.merchantKey, learned.storeNo, learned.setCategoryId, learned.setKind, now, who).run()

    const reapplied = await applyRules(db, [txn.merchantKey], who)
    const stored = await db.prepare(`SELECT ${RULE_COLUMNS} FROM merchant_rules WHERE id = ?`).bind(learned.id).first<Record<string, unknown>>()
    const res: RuleResponse = { rule: mapRule(stored!), reapplied }
    return budgetJson(200, res)
  },
})
