/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/banks/link-token: a Plaid Link token for the signed-in person (plan 3.1).
// Body `{ consent, itemId?, accountSelection? }`, at most 1 KB.
//  - New link (no itemId): any listed person; `consent` must equal BANKS_CONSENT_VERSION (400 consent_required).
//  - Update mode (itemId): the Item's owner only; the Item must still hold a token (409 item_not_active). `accountSelection: true`
//    lets the owner pick more accounts (the new-accounts prompt) and needs an itemId (400 otherwise).
// The Worker does the Plaid call and the slot guard (409 slots_full). Answers `{ linkToken, expiration }` only.

import { BANKS_CONSENT_VERSION } from '../../../../src/lib/budget/types'
import { budgetJson } from '../../../_lib/budgetAccess'
import { BudgetHttpError, badRequest, defineRoute, readJsonObject } from '../../../_lib/budgetDb'
import { BANKS_TIMEOUT_MS, LIVE_ITEM_STATUSES, callBanks, isItemId, itemNotActive, requireBanks, requireOwnItem } from '../../../_lib/banks'

export const MAX_BODY_LINK_TOKEN = 1024

export const onRequest = defineRoute({
  POST: async (ctx) => {
    requireBanks(ctx.env)
    const db = ctx.env.BUDGET_DB!
    const email = ctx.data.budgetEmail!
    const body = await readJsonObject(ctx.request, MAX_BODY_LINK_TOKEN)

    const itemId = body.itemId
    if (itemId !== undefined && !isItemId(itemId)) throw badRequest('itemId: not a bank link id')
    const accountSelection = body.accountSelection
    if (accountSelection !== undefined && accountSelection !== true && accountSelection !== false) throw badRequest('accountSelection: expected true or false')
    if (accountSelection === true && itemId === undefined) throw badRequest('accountSelection: needs an itemId')

    const request: Record<string, unknown> = { ownerEmail: email.trim().toLowerCase() }
    if (itemId === undefined) {
      if (body.consent !== BANKS_CONSENT_VERSION) throw new BudgetHttpError(400, 'consent_required', 'Agree to the bank-link terms first.')
      request.consentVersion = BANKS_CONSENT_VERSION
    } else {
      const item = await requireOwnItem(db, itemId, email)
      if (!(LIVE_ITEM_STATUSES as readonly string[]).includes(item.status)) throw itemNotActive()
      request.consentVersion = BANKS_CONSENT_VERSION
      request.itemId = itemId
      if (accountSelection === true) request.accountSelection = true
    }

    const answer = await callBanks(ctx.env, '/link-token', request, BANKS_TIMEOUT_MS.linkToken)
    if (typeof answer.linkToken !== 'string' || answer.linkToken === '') throw new BudgetHttpError(502, 'banks_failed')
    return budgetJson(200, { linkToken: answer.linkToken, expiration: typeof answer.expiration === 'string' ? answer.expiration : null })
  },
})
