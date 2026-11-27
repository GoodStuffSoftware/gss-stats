// Receipt photo upload routes (service binding only): POST /upload, POST /upload-delete, GET /image?id=.
// Identity is the signed-in address the Pages leg sends in X-Budget-Email (lower-cased), re-checked here against the
// Worker's own allowlist. Pages decides who may see an image; this Worker only checks the allowlist for /image.
// Never logs an address, a hash or image bytes. Plan: receipt photo upload section 3.
import { readSecret } from './disconnect'
import { sanitizeJpeg } from './imageSanitize'
import { selectImageStore } from './imageStore'
import { log } from './log'
import { CATEGORIES_SQL, allowedEmails, jsonResponse, readUpload, rematch, type Env } from './run'
import * as S from './store'

type Handler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>

export const MAX_UPLOAD_BYTES = 2_000_000
const DEFAULT_UPLOAD_CAP = 20
const EMAIL_HEADER = 'x-budget-email'
const UPLOAD_ID = /^r[0-9a-f]{16}$/

const fail = (status: number, code: string): Response => jsonResponse(status, { ok: false, code })
const empty = (status: number): Response => new Response(null, { status, headers: { 'cache-control': 'no-store' } })

/** The header address if it is on the allowlist; otherwise a ready 403 (503 when the list is missing). */
async function caller(request: Request, env: Env): Promise<{ email: string } | { res: Response }> {
  const email = (request.headers.get(EMAIL_HEADER) ?? '').trim().toLowerCase()
  if (email.length < 3 || email.length > 254) return { res: fail(403, 'not_allowed') }
  const allowed = await allowedEmails(env)
  if (allowed === null) return { res: fail(503, 'secrets_missing') }
  return allowed.has(email) ? { email } : { res: fail(403, 'not_allowed') }
}

const hex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Read the new upload with the model and match it (suggestions only). Never throws: the cron retries what this leaves. */
async function readNow(env: Env, id: string): Promise<void> {
  try {
    const row = await S.loadUpload(env.BUDGET_DB, id)
    if (!row || row.status !== 'pending') return
    const apiKey = await readSecret(env.RECEIPTS_ANTHROPIC_KEY)
    if (!apiKey) return
    const categoryIds = (await env.BUDGET_DB.prepare(CATEGORIES_SQL).all<{ id: string }>()).results.map((c) => c.id)
    const r = await readUpload(env, row, { apiKey, categoryIds, fetch, now: () => new Date() })
    if (r.outcome === 'read') await rematch(env, { kind: 'upload', email: row.uploaderEmail }, new Date())
  } catch {
    log('upload_read_failed')
  }
}

export const handleUpload: Handler = async (request, env, ctx) => {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed')
  const who = await caller(request, env)
  if ('res' in who) return who.res
  const store = selectImageStore(env)
  if (!store) return fail(503, 'unavailable')
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return fail(413, 'too_large')
  let input: Uint8Array
  try {
    input = new Uint8Array(await request.arrayBuffer())
  } catch {
    return fail(400, 'bad_request')
  }
  if (input.length === 0) return fail(400, 'bad_request')
  if (input.length > MAX_UPLOAD_BYTES) return fail(413, 'too_large')
  const clean = sanitizeJpeg(input)
  if (!clean.ok) return clean.code === 'bad_type' ? fail(415, 'convert_first') : fail(422, 'bad_image')
  const sha = hex(await crypto.subtle.digest('SHA-256', clean.bytes))
  const db = env.BUDGET_DB
  const dup = await S.findUploadByHash(db, sha)
  if (dup) return jsonResponse(200, dup.uploaderEmail === who.email ? { duplicate: true, id: dup.id } : { duplicate: true })
  const capRaw = Number(env.RECEIPTS_UPLOAD_DAILY_CAP)
  const capSet = env.RECEIPTS_UPLOAD_DAILY_CAP !== undefined && env.RECEIPTS_UPLOAD_DAILY_CAP.trim() !== '' && Number.isFinite(capRaw) && capRaw >= 0
  const now = new Date()
  if ((await S.uploadsToday(db, who.email, now)) >= (capSet ? capRaw : DEFAULT_UPLOAD_CAP)) return fail(429, 'daily_cap')
  const id = S.newUploadId()
  const key = S.imageKeyOf(id)
  await store.put(key, clean.bytes)
  try {
    const ins = await S.insertUploadReceipt(db, { id, uploaderEmail: who.email, imageSha256: sha, imageBytes: clean.bytes.length }, now)
    if (!ins.ok) {
      await store.delete(key).catch(() => {})
      const d = ins.duplicate
      return jsonResponse(200, d && d.uploaderEmail === who.email ? { duplicate: true, id: d.id } : { duplicate: true })
    }
  } catch {
    await store.delete(key).catch(() => {})
    return fail(500, 'server_error')
  }
  ctx.waitUntil(readNow(env, id))
  return jsonResponse(202, { id })
}

export const handleUploadDelete: Handler = async (request, env) => {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed')
  const who = await caller(request, env)
  if ('res' in who) return who.res
  let body: { id?: unknown; email?: unknown }
  try {
    const text = await request.text()
    if (text.length > 2048) return fail(413, 'too_large')
    body = JSON.parse(text)
  } catch {
    return fail(400, 'bad_request')
  }
  const { id, email } = body ?? {}
  if (typeof id !== 'string' || !UPLOAD_ID.test(id) || typeof email !== 'string' || email.trim().toLowerCase() !== who.email) return fail(400, 'bad_request')
  const db = env.BUDGET_DB
  const row = await S.loadUpload(db, id)
  if (!row || row.uploaderEmail !== who.email) return fail(404, 'not_found') // one answer for missing and not yours
  if (row.imageKey) {
    const store = selectImageStore(env)
    if (!store) return fail(503, 'unavailable')
    try { await store.delete(row.imageKey) } catch { return fail(500, 'server_error') } // keep the row so the delete can be retried
  }
  await S.deleteUploadReceipt(db, id, who.email)
  return empty(204)
}

export const handleImage: Handler = async (request, env) => {
  if (request.method !== 'GET') return fail(405, 'method_not_allowed')
  const who = await caller(request, env)
  if ('res' in who) return who.res
  const id = new URL(request.url).searchParams.get('id') ?? ''
  if (!UPLOAD_ID.test(id)) return fail(404, 'not_found')
  const row = await S.loadUpload(env.BUDGET_DB, id)
  const store = selectImageStore(env)
  if (!row || !row.imageKey || !store) return fail(404, 'not_found')
  let bytes: Uint8Array | null
  try { bytes = await store.get(row.imageKey) } catch { return fail(404, 'not_found') }
  if (!bytes) return fail(404, 'not_found')
  return new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, no-store', 'content-length': String(bytes.length) } })
}
