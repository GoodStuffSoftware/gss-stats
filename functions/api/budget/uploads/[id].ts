/// <reference types="@cloudflare/workers-types" />
//
// GET /api/budget/uploads/<id> -> {id, status, row?}: one primary-key read. Same visibility as the review list (the uploader's own
// receipts); anything else, missing or not yours, is the same 404. `row` is the review-list row shape, present once the receipt is read.
// DELETE /api/budget/uploads/<id>: the uploader only; the Worker removes the photo, then the row. 204, or 404 (missing and
// not yours answer alike). A Worker failure is 502 `unavailable`.

import { budgetJson } from '../../../_lib/budgetAccess'
import { BudgetHttpError, defineRoute, notFound } from '../../../_lib/budgetDb'
import { RECEIPT_ID_RE, isUploader, loadOwnUpload } from '../../../_lib/receiptsDb'
import { callWorker, type UploadsEnv } from '../../../_lib/receiptUploads'

const idOf = (params: unknown): string => {
  const id = String((params as Record<string, unknown>).id ?? '')
  if (!RECEIPT_ID_RE.test(id)) throw notFound()
  return id
}

export const onRequest = defineRoute({
  GET: async (ctx) => {
    const id = idOf(ctx.params)
    const r = await loadOwnUpload(ctx.env.BUDGET_DB!, id, ctx.data.budgetEmail!)
    if (!r) throw notFound()
    return budgetJson(200, { id, status: r.status, ...(r.row ? { row: r.row } : {}) })
  },
  DELETE: async (ctx) => {
    const id = idOf(ctx.params)
    const email = ctx.data.budgetEmail!
    if (!(await isUploader(ctx.env.BUDGET_DB!, id, email))) throw notFound()
    try {
      const res = await callWorker(
        ctx.env as UploadsEnv, '/upload-delete',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, email: email.toLowerCase() }) }, email,
      )
      if (res.status === 204) return new Response(null, { status: 204 })
      if (res.status === 404) throw notFound()
    } catch (err) {
      if (err instanceof BudgetHttpError) throw err
    }
    return budgetJson(502, { code: 'unavailable' })
  },
})
