/// <reference types="@cloudflare/workers-types" />
//
// GET /api/budget/uploads/<id>/image: the stored photo, behind the image-share rule. The uploader always may; another listed person
// only when RECEIPTS_SHARE is not `none`, RECEIPTS_IMAGE_SHARE is `both` (the default) and the receipt is applied. Anything else,
// missing or not allowed, is the same 404. The bytes are served only as an inert image (headers below), never as a page.

import { budgetJson } from '../../../../_lib/budgetAccess'
import { BudgetHttpError, defineRoute, notFound } from '../../../../_lib/budgetDb'
import { RECEIPT_ID_RE, mayViewImage } from '../../../../_lib/receiptsDb'
import { callWorker, imageShareBoth, type UploadsEnv } from '../../../../_lib/receiptUploads'
import { shareMode } from '../../email/links'

export const IMAGE_HEADERS = {
  'Content-Type': 'image/jpeg',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Content-Disposition': 'inline; filename="receipt.jpg"',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'private, no-store',
} as const

export const onRequest = defineRoute({
  GET: async (ctx) => {
    const env = ctx.env as UploadsEnv
    const id = String((ctx.params as Record<string, unknown>).id ?? '')
    if (!RECEIPT_ID_RE.test(id)) throw notFound()
    const email = ctx.data.budgetEmail!
    if (!(await mayViewImage(env.BUDGET_DB!, id, email, shareMode(env.RECEIPTS_SHARE) !== 'none', imageShareBoth(env.RECEIPTS_IMAGE_SHARE)))) throw notFound()
    try {
      const res = await callWorker(env, `/image?id=${id}`, { method: 'GET' }, email)
      if (res.status === 200 && res.body) return new Response(res.body, { status: 200, headers: IMAGE_HEADERS })
      if (res.status === 404) throw notFound()
    } catch (err) {
      if (err instanceof BudgetHttpError) throw err
    }
    return budgetJson(502, { code: 'unavailable' })
  },
})
