/// <reference types="@cloudflare/workers-types" />
//
// GET /api/budget/email/receipts?status=suggested|unmatched|applied|photos&cursor=&limit=: the signed-in login's OWN receipts (plan
// section 4; the review list stays per person, whatever RECEIPTS_SHARE says). Newest first, keyset-paged on idx_rcpt_review.
// `{receipts: [{id, emailDate, status, kind, merchant, paymentVia, cardLast4, orderRef, receiptDate, relatedDate, currency,
// totalCents, taxCents, shippingCents, gmailMsgId, items: [{seq, description, amountCents, quantity, categoryHint}],
// matches: [{matchId, txnId, groupKey, rule, shareCents, score, status, proposedCategoryId, linkedOther, categoryProtectedBy,
// txn: {postedDate, amountCents, merchantName, accountLabel, categoryId, categorySource, needsReview, updatedAt}}]}], nextCursor}`.
// `photos` lists the caller's own photo receipts in every state, newest upload first, one page and no cursor.
// The URL carries a status word, a cursor and a count only.

import { budgetJson } from '../../../../_lib/budgetAccess'
import { badRequest, defineRoute } from '../../../../_lib/budgetDb'
import { DEFAULT_LIST, LIST_STATUSES, MAX_LIST, decodeReceiptCursor, loadOwnPhotos, loadReceiptList, type ListStatus } from '../../../../_lib/receiptsDb'

export const onRequest = defineRoute({
  GET: async (ctx) => {
    const sp = new URL(ctx.request.url).searchParams
    const status = sp.get('status') ?? 'suggested'
    if (status !== 'photos' && !(LIST_STATUSES as readonly string[]).includes(status)) throw badRequest('status: expected suggested, unmatched, applied or photos')
    const rawLimit = sp.get('limit')
    let limit = DEFAULT_LIST
    if (rawLimit !== null) {
      if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_LIST) throw badRequest(`limit: expected 1 to ${MAX_LIST}`)
      limit = Number(rawLimit)
    }
    if (status === 'photos') return budgetJson(200, await loadOwnPhotos(ctx.env.BUDGET_DB!, ctx.data.budgetEmail!, limit))
    const rawCursor = sp.get('cursor')
    const cursor = rawCursor ? decodeReceiptCursor(rawCursor) : null
    return budgetJson(200, await loadReceiptList(ctx.env.BUDGET_DB!, ctx.data.budgetEmail!, status as ListStatus, limit, cursor))
  },
})
