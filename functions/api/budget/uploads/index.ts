/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/uploads: a receipt photo (one JPEG, at most 2,000,000 bytes) handed to the receipts Worker, which strips,
// stores and reads it (docs/adr/0010-receipt-photo-uploads.md). The budget middleware already 403s anyone off the allowlist.
//   Content-Type must be exactly image/jpeg (a non-simple type: a cross-site form cannot send it without a preflight);
//   Sec-Fetch-Site, when present, must be same-origin. The size is checked by Content-Length AND by counting the stream.
//   Answers the Worker's status and `{code}` / `{id}` / `{duplicate}` (202 {id} | 200 {duplicate, id?} | 400/403/413/415/422/429/503 {code});
//   no Worker (or it fails or times out) -> 502 {code: 'unavailable'}. No D1 write here.

import { budgetJson } from '../../../_lib/budgetAccess'
import { defineRoute } from '../../../_lib/budgetDb'
import { UPLOAD_MAX_BYTES, callWorker, readCapped, type UploadsEnv } from '../../../_lib/receiptUploads'

const RELAYED = new Set([200, 202, 400, 403, 413, 415, 422, 429, 503])

export const onRequest = defineRoute({
  POST: async (ctx) => {
    const env = ctx.env as UploadsEnv
    const req = ctx.request
    const site = req.headers.get('Sec-Fetch-Site')
    if (site !== null && site !== 'same-origin') return budgetJson(403, { code: 'forbidden' })
    if (req.headers.get('Content-Type') !== 'image/jpeg') return budgetJson(415, { code: 'convert_first' })
    const declared = req.headers.get('Content-Length')
    if (declared !== null && Number(declared) > UPLOAD_MAX_BYTES) return budgetJson(413, { code: 'too_large' })
    const bytes = await readCapped(req.body, UPLOAD_MAX_BYTES)
    if (bytes === null) return budgetJson(413, { code: 'too_large' })
    if (bytes.byteLength === 0) return budgetJson(400, { code: 'bad_image' })

    let res: Response
    let out = null as { code?: unknown; id?: unknown; duplicate?: unknown } | null
    try {
      res = await callWorker(env, '/upload', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: bytes as unknown as BodyInit }, ctx.data.budgetEmail!)
      if (!RELAYED.has(res.status)) return budgetJson(502, { code: 'unavailable' })
      out = (await res.json().catch(() => null)) as { code?: unknown; id?: unknown; duplicate?: unknown } | null
    } catch {
      return budgetJson(502, { code: 'unavailable' })
    }
    const body: Record<string, unknown> = {}
    if (typeof out?.code === 'string' && /^[a-z_]{1,40}$/.test(out.code)) body.code = out.code
    if (typeof out?.id === 'string' && /^r[0-9a-f]{16}$/.test(out.id)) body.id = out.id
    if (typeof out?.duplicate === 'boolean') body.duplicate = out.duplicate
    if (res.status >= 400 && body.code === undefined) return budgetJson(502, { code: 'unavailable' })
    return budgetJson(res.status, body)
  },
})
