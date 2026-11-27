// Receipt photo routes: POST /uploads (type, Sec-Fetch-Site, size by header and by stream, relay), GET and DELETE /uploads/<id>
// and GET /uploads/<id>/image (owner, other person, stranger: 403/404 parity), imageUrl and mine on the links, the UNION list paging,
// and apply keeping a person-set category on an upload row. Made-up data; the RECEIPTS binding is a mock.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBudgetDb, insertTxn, type FakeBudgetDb } from '../../../_lib/testing/budgetDb'
import type { BudgetEnv } from '../../../_lib/budgetAccess'
import { onRequest as post } from './index'
import { onRequest as byId } from './[id]'
import { onRequest as image } from './[id]/image'
import { onRequest as links } from '../email/links'
import { onRequest as list } from '../email/receipts/index'
import { onRequest as apply } from '../email/apply'
import { onRequest as dismiss } from '../email/receipts/[id]'

const A = 'user-a@example.com'
const B = 'user-b@example.com'
const STRANGER = 'stranger@example.com'
const NOW = '2026-12-05T10:00:00.000Z'
const CONN_A = 'c0123456789abcdef'
const rid = (n: number): string => `r${n.toString(16).padStart(16, '0')}`
const sha = (n: number): string => n.toString(16).padStart(64, '0')

let db: FakeBudgetDb
let worker: ReturnType<typeof vi.fn>

beforeEach(async () => {
  db = await createBudgetDb()
  worker = vi.fn(async () => new Response(JSON.stringify({ id: rid(1) }), { status: 202 }))
})

function env(extra: Record<string, string> = {}, withBinding = true): BudgetEnv {
  return { BUDGET_DB: db.d1, ...(withBinding ? { RECEIPTS: { fetch: worker } } : {}), ...extra } as unknown as BudgetEnv
}
function call(h: unknown, path: string, who: string | null, o: { method?: string; headers?: Record<string, string>; body?: any; params?: Record<string, string>; env?: BudgetEnv } = {}): Promise<Response> {
  const request = new Request(`https://stats.goodstuff.software${path}`, { method: o.method ?? 'GET', headers: o.headers, body: o.body })
  return (h as (c: never) => Promise<Response>)({ request, env: o.env ?? env(), params: o.params ?? {}, data: who ? { budgetEmail: who } : {} } as never)
}
function upload(n: number, who: string, over: { status?: string; email_date?: string; image?: boolean } = {}): string {
  const id = rid(n)
  db.sqlite.prepare(
    `INSERT INTO receipts (id, source, uploader_email, image_key, image_sha256, image_bytes, email_date, status, kind, merchant, total_cents, created_at, updated_at, updated_by)
     VALUES (?, 'upload', ?, ?, ?, 1000, ?, ?, 'purchase', 'Invented Shop', 500, ?, ?, 'import:test')`,
  ).run(id, who, over.image === false ? null : `img/${id}.jpg`, sha(n), over.email_date ?? '2026-11-20', over.status ?? 'suggested', NOW, NOW)
  return id
}
function emailReceipt(n: number, date: string): string {
  const id = rid(n)
  db.sqlite.prepare(
    `INSERT INTO email_connections (id, owner_email, google_sub, status, token_ct, token_iv, key_id, scopes, consent_version, consented_at, created_at, updated_at)
     SELECT ?, ?, 'sub-a', 'active', 'Q0lQSEVS', 'aXZpdml2aXZpaQ==', '0a1b2c3d', 'gmail.readonly', 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM email_connections WHERE id = ?)`,
  ).run(CONN_A, A, NOW, NOW, NOW, CONN_A)
  db.sqlite.prepare(
    `INSERT INTO receipts (id, connection_id, gmail_msg_id, email_date, status, kind, merchant, total_cents, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, 'suggested', 'purchase', 'Mail Shop', 500, ?, ?, 'import:test')`,
  ).run(id, CONN_A, `ab${n.toString(16).padStart(8, '0')}`, date, NOW, NOW)
  return id
}
const jpeg = (n = 10): Uint8Array => new Uint8Array(n).fill(7)

describe('POST /uploads', () => {
  const ok = (extra: Record<string, string> = {}) => ({ method: 'POST', headers: { 'Content-Type': 'image/jpeg', ...extra }, body: jpeg() })

  it('relays 202 {id} and sends the bytes, the email header and the upload path', async () => {
    const res = await call(post, '/api/budget/uploads', A, ok({ 'Sec-Fetch-Site': 'same-origin' }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ id: rid(1) })
    const [url, init] = worker.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://receipts.internal/upload')
    expect(new Headers(init.headers).get('X-Budget-Email')).toBe(A)
    expect((init.body as Uint8Array).byteLength).toBe(10)
  })
  it('relays a duplicate and the Worker error codes, and drops unknown keys', async () => {
    worker.mockResolvedValueOnce(new Response(JSON.stringify({ duplicate: true, id: rid(2), extra: 'x' }), { status: 200 }))
    expect(await (await call(post, '/api/budget/uploads', A, ok())).json()).toEqual({ duplicate: true, id: rid(2) })
    for (const [status, code] of [[415, 'convert_first'], [422, 'bad_image'], [429, 'daily_cap'], [503, 'unavailable'], [413, 'too_large']] as const) {
      worker.mockResolvedValueOnce(new Response(JSON.stringify({ code }), { status }))
      const res = await call(post, '/api/budget/uploads', A, ok())
      expect([res.status, await res.json()]).toEqual([status, { code }])
    }
  })
  it('wrong content types are 415 and never reach the Worker', async () => {
    for (const ct of ['image/png', 'application/pdf', 'image/jpeg; charset=x', 'text/plain']) {
      const res = await call(post, '/api/budget/uploads', A, { method: 'POST', headers: { 'Content-Type': ct }, body: jpeg() })
      expect(res.status, ct).toBe(415)
    }
    expect(worker).not.toHaveBeenCalled()
  })
  it('a missing Sec-Fetch-Site header is allowed (older Safari; the non-simple Content-Type is the guard, ADR 0010)', async () => {
    const res = await call(post, '/api/budget/uploads', A, ok())
    expect(res.status).toBe(202)
    expect(worker).toHaveBeenCalledTimes(1)
  })
  it('Sec-Fetch-Site other than same-origin is 403', async () => {
    for (const v of ['cross-site', 'same-site', 'none']) expect((await call(post, '/api/budget/uploads', A, ok({ 'Sec-Fetch-Site': v }))).status, v).toBe(403)
    expect(worker).not.toHaveBeenCalled()
  })
  it('over 2,000,000 bytes is 413: by Content-Length, and by counting the stream', async () => {
    expect((await call(post, '/api/budget/uploads', A, ok({ 'Content-Length': '2000001' }))).status).toBe(413)
    const big = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(600_000)) } })
    const req = new Request('https://stats.goodstuff.software/api/budget/uploads', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: big, duplex: 'half' } as RequestInit)
    const res = await (post as unknown as (c: never) => Promise<Response>)({ request: req, env: env(), params: {}, data: { budgetEmail: A } } as never)
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ code: 'too_large' })
    expect(worker).not.toHaveBeenCalled()
    // exactly at the cap is accepted
    expect((await call(post, '/api/budget/uploads', A, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array(2_000_000) })).status).toBe(202)
  })
  it('a binding failure, a missing binding or an odd Worker answer is 502 unavailable; a stranger is 403', async () => {
    worker.mockRejectedValueOnce(new Error('boom'))
    expect([(await call(post, '/api/budget/uploads', A, ok())).status]).toEqual([502])
    expect((await call(post, '/api/budget/uploads', A, { ...ok(), env: env({}, false) })).status).toBe(502)
    worker.mockResolvedValueOnce(new Response('<html>', { status: 500 }))
    expect((await call(post, '/api/budget/uploads', A, ok())).status).toBe(502)
    expect((await call(post, '/api/budget/uploads', null, ok())).status).toBe(403)
  })
})

describe('GET and DELETE /uploads/<id>', () => {
  it('owner reads status and row; pending has no row; other person and stranger and missing all 404', async () => {
    const id = upload(1, A)
    const pend = upload(2, A, { status: 'pending' })
    const mine = await (await call(byId, `/api/budget/uploads/${id}`, A, { params: { id } })).json() as any
    expect(mine).toMatchObject({ id, status: 'suggested', row: { id, source: 'upload', hasImage: true, mine: true, imageUrl: `/api/budget/uploads/${id}/image` } })
    expect('gmailMsgId' in mine.row).toBe(false)
    expect(await (await call(byId, `/api/budget/uploads/${pend}`, A, { params: { id: pend } })).json()).toEqual({ id: pend, status: 'pending' })
    for (const who of [B, STRANGER]) expect((await call(byId, `/api/budget/uploads/${id}`, who, { params: { id } })).status).toBe(404)
    expect((await call(byId, `/api/budget/uploads/${rid(99)}`, A, { params: { id: rid(99) } })).status).toBe(404)
    expect((await call(byId, '/api/budget/uploads/bad', A, { params: { id: 'bad' } })).status).toBe(404)
    expect((await call(byId, `/api/budget/uploads/${id}`, null, { params: { id } })).status).toBe(403)
  })
  it('delete: the uploader gets 204 via the Worker; other and missing are the same 404 with no Worker call', async () => {
    const id = upload(1, A)
    for (const [who, i] of [[B, id], [STRANGER, id], [A, rid(99)]] as const) {
      const res = await call(byId, `/api/budget/uploads/${i}`, who, { method: 'DELETE', params: { id: i } })
      expect([res.status, await res.json()]).toEqual([404, { error: 'not_found' }])
    }
    expect(worker).not.toHaveBeenCalled()
    worker.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const res = await call(byId, `/api/budget/uploads/${id}`, A, { method: 'DELETE', params: { id } })
    expect(res.status).toBe(204)
    const [url, init] = worker.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://receipts.internal/upload-delete')
    expect(JSON.parse(String(init.body))).toEqual({ id, email: A })
    worker.mockRejectedValueOnce(new Error('x'))
    expect((await call(byId, `/api/budget/uploads/${id}`, A, { method: 'DELETE', params: { id } })).status).toBe(502)
  })
})

describe('GET /uploads/<id>/image', () => {
  const get = (id: string, who: string | null, e: Record<string, string> = {}) => call(image, `/api/budget/uploads/${id}/image`, who, { params: { id }, env: env(e) })
  beforeEach(() => { worker.mockImplementation(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { 'Content-Type': 'text/html' } })) })

  it('the uploader gets the JPEG with the inert headers', async () => {
    const id = upload(1, A)
    const res = await get(id, A)
    expect(res.status).toBe(200)
    expect(Object.fromEntries(['Content-Type', 'X-Content-Type-Options', 'Content-Security-Policy', 'Content-Disposition', 'Cross-Origin-Resource-Policy', 'Cache-Control'].map((h) => [h, res.headers.get(h)]))).toEqual({
      'Content-Type': 'image/jpeg', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline; filename="receipt.jpg"', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'private, no-store',
    })
    expect(new Uint8Array(await res.arrayBuffer()).byteLength).toBe(3)
    expect(String((worker.mock.calls[0] as [string])[0])).toBe(`https://receipts.internal/image?id=${id}`)
  })
  it('other person: only when applied, RECEIPTS_SHARE is not none and RECEIPTS_IMAGE_SHARE is both (default)', async () => {
    const id = upload(1, A, { status: 'applied' })
    expect((await get(id, B, { RECEIPTS_SHARE: 'fields' })).status).toBe(200)
    expect((await get(id, B, { RECEIPTS_SHARE: 'fields', RECEIPTS_IMAGE_SHARE: 'both' })).status).toBe(200)
    expect((await get(id, B, { RECEIPTS_SHARE: 'fields', RECEIPTS_IMAGE_SHARE: 'owner' })).status).toBe(404)
    expect((await get(id, B, { RECEIPTS_SHARE: 'none' })).status).toBe(404)
    expect((await get(id, B)).status).toBe(404)
    const open = upload(2, A)
    expect((await get(open, B, { RECEIPTS_SHARE: 'fields' })).status).toBe(404)
    expect((await get(id, A, { RECEIPTS_IMAGE_SHARE: 'owner', RECEIPTS_SHARE: 'none' })).status).toBe(200)
  })
  it('after the retention sweep cleared image_key, the image is 404 and the Worker is not asked', async () => {
    const id = upload(1, A, { status: 'applied' })
    expect((await get(id, A)).status).toBe(200)
    worker.mockClear()
    db.sqlite.prepare('UPDATE receipts SET image_key = NULL WHERE id = ?').run(id)
    for (const who of [A, B]) expect((await get(id, who, { RECEIPTS_SHARE: 'fields' })).status).toBe(404)
    expect(worker).not.toHaveBeenCalled()
  })
  it('no image, missing, a bad id and a stranger without access are 404 (403 off the list); a Worker 404 or failure is passed on', async () => {
    const gone = upload(3, A, { image: false })
    expect((await get(gone, A)).status).toBe(404)
    expect((await get(rid(99), A)).status).toBe(404)
    expect((await get('nope', A)).status).toBe(404)
    expect((await get(rid(3), null)).status).toBe(403)
    const id = upload(1, A)
    worker.mockResolvedValueOnce(new Response(null, { status: 404 }))
    expect((await get(id, A)).status).toBe(404)
    worker.mockRejectedValueOnce(new Error('x'))
    expect((await get(id, A)).status).toBe(502)
  })
})

describe('links: imageUrl and mine', () => {
  async function linkFor(who: string, e: Record<string, string>): Promise<any> {
    const id = upload(1, A, { status: 'applied' })
    const t = insertTxn(db)
    db.sqlite.prepare(`INSERT INTO receipt_matches (receipt_id, txn_id, group_key, rule, share_cents, score, status, txn_updated_at, created_at) VALUES (?, ?, 'g', 'exact', 500, 90, 'applied', ?, ?)`).run(id, t, NOW, NOW)
    const request = new Request('https://stats.goodstuff.software/api/budget/email/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txnIds: [t] }) })
    const res = await (links as unknown as (c: never) => Promise<Response>)({ request, env: env(e), params: {}, data: { budgetEmail: who } } as never)
    return ((await res.json()) as any).links[t]
  }
  it('both: uploader and other person get imageUrl; owner: only the uploader', async () => {
    const url = `/api/budget/uploads/${rid(1)}/image`
    expect((await linkFor(A, { RECEIPTS_SHARE: 'fields', RECEIPTS_IMAGE_SHARE: 'both' })).imageUrl).toBe(url)
    db = await createBudgetDb()
    const b = await linkFor(B, { RECEIPTS_SHARE: 'fields', RECEIPTS_IMAGE_SHARE: 'both' })
    expect(b).toMatchObject({ imageUrl: url, source: 'upload', hasImage: true, merchant: 'Invented Shop' })
    expect('gmailMsgId' in b).toBe(false)
    db = await createBudgetDb()
    const bOwner = await linkFor(B, { RECEIPTS_SHARE: 'fields', RECEIPTS_IMAGE_SHARE: 'owner' })
    expect(bOwner.hasImage).toBe(true)
    expect('imageUrl' in bOwner).toBe(false)
    db = await createBudgetDb()
    expect((await linkFor(A, { RECEIPTS_SHARE: 'none', RECEIPTS_IMAGE_SHARE: 'owner' })).imageUrl).toBe(url)
    db = await createBudgetDb()
    expect(await linkFor(B, { RECEIPTS_SHARE: 'none' })).toBeUndefined()
  })
})

describe('links: fields_and_link on an upload row', () => {
  it('shows the fields to the other person but never a gmailMsgId, since an upload has no email', async () => {
    const id = upload(1, A, { status: 'applied' })
    const t = insertTxn(db)
    db.sqlite.prepare(`INSERT INTO receipt_matches (receipt_id, txn_id, group_key, rule, share_cents, score, status, txn_updated_at, created_at) VALUES (?, ?, 'g', 'exact', 500, 90, 'applied', ?, ?)`).run(id, t, NOW, NOW)
    for (const who of [A, B]) {
      const request = new Request('https://stats.goodstuff.software/api/budget/email/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txnIds: [t] }) })
      const res = await (links as unknown as (c: never) => Promise<Response>)({ request, env: env({ RECEIPTS_SHARE: 'fields_and_link' }), params: {}, data: { budgetEmail: who } } as never)
      const link = ((await res.json()) as any).links[t]
      expect(link, who).toMatchObject({ source: 'upload', hasImage: true, merchant: 'Invented Shop', imageUrl: `/api/budget/uploads/${id}/image` })
      expect('gmailMsgId' in link, who).toBe(false)
    }
  })
})

describe('dismiss and undo on an upload row', () => {
  const patch = (id: string, who: string, dismissed: boolean) => call(dismiss, `/api/budget/email/receipts/${id}`, who, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dismissed }), params: { id } })
  const status = (id: string) => (db.sqlite.prepare('SELECT status FROM receipts WHERE id = ?').get(id) as { status: string }).status

  it('the uploader dismisses a suggested upload and undoes it; undo with no open match is unmatched', async () => {
    const id = upload(1, A)
    let res = await patch(id, A, true)
    expect([res.status, await res.json()]).toEqual([200, { id, status: 'dismissed' }])
    expect(status(id)).toBe('dismissed')
    res = await patch(id, A, false)
    expect([res.status, await res.json()]).toEqual([200, { id, status: 'unmatched' }])
  })
  it('undo returns to suggested while a suggested match exists', async () => {
    const id = upload(1, A)
    const t = insertTxn(db)
    db.sqlite.prepare(`INSERT INTO receipt_matches (receipt_id, txn_id, group_key, rule, share_cents, score, status, txn_updated_at, created_at) VALUES (?, ?, 'g', 'exact', 500, 90, 'suggested', ?, ?)`).run(id, t, NOW, NOW)
    expect((await patch(id, A, true)).status).toBe(200)
    const res = await patch(id, A, false)
    expect(await res.json()).toEqual({ id, status: 'suggested' })
  })
  it('the other person and a stranger get 404 and change nothing; an applied upload is 409', async () => {
    const id = upload(1, A)
    for (const who of [B, STRANGER]) expect((await patch(id, who, true)).status, who).toBe(404)
    expect(status(id)).toBe('suggested')
    const done = upload(2, A, { status: 'applied' })
    expect((await patch(done, A, true)).status).toBe(409)
    expect(status(done)).toBe('applied')
  })
})

describe('review list: UNION of email and upload rows', () => {
  async function page(who: string, query: string): Promise<any> {
    return (await call(list, `/api/budget/email/receipts?${query}`, who)).json()
  }
  it('merges both arms newest first, pages by cursor without gaps, and keeps rows per person', async () => {
    emailReceipt(1, '2026-11-20')
    upload(2, A, { email_date: '2026-11-22' })
    emailReceipt(3, '2026-11-22')
    upload(4, A, { email_date: '2026-11-18' })
    upload(5, B, { email_date: '2026-11-30' })
    const p1 = await page(A, 'limit=2')
    expect(p1.receipts.map((r: any) => r.id)).toEqual([rid(3), rid(2)])
    expect(p1.receipts.map((r: any) => [r.source, r.mine, r.hasImage])).toEqual([['email', true, false], ['upload', true, true]])
    expect('gmailMsgId' in p1.receipts[1]).toBe(false)
    expect(typeof p1.receipts[0].gmailMsgId).toBe('string')
    const p2 = await page(A, `limit=2&cursor=${p1.nextCursor}`)
    expect(p2.receipts.map((r: any) => r.id)).toEqual([rid(1), rid(4)])
    expect(p2.nextCursor).toBeNull()
    expect((await page(B, 'limit=5')).receipts.map((r: any) => r.id)).toEqual([rid(5)])
    expect((await page(STRANGER, 'limit=5')).receipts).toEqual([])
  })
})

describe('apply on an upload row', () => {
  it('owner applies; a person-set category is kept; the other person cannot touch it', async () => {
    const id = upload(1, A)
    const t = insertTxn(db, { category_id: 'dining', category_source: 'manual' })
    const m = Number((db.sqlite.prepare(`INSERT INTO receipt_matches (receipt_id, txn_id, group_key, rule, share_cents, score, status, proposed_category_id, txn_updated_at, created_at) VALUES (?, ?, 'g', 'exact', 500, 90, 'suggested', 'shopping', ?, ?)`).run(id, t, NOW, NOW) as { lastInsertRowid: number | bigint }).lastInsertRowid)
    const body = { items: [{ matchId: m, expectedUpdatedAt: NOW }] }
    const other = await (await call(apply, '/api/budget/email/apply', B, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as any
    expect(other.skipped).toEqual([{ matchId: m, reason: 'not_found' }])
    const res = await (await call(apply, '/api/budget/email/apply', A, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json() as any
    expect(res.applied).toHaveLength(1)
    expect(res.applied[0]).toMatchObject({ categorySet: false, categoryKept: 'manual' })
    expect(db.sqlite.prepare('SELECT category_id FROM transactions WHERE id = ?').get(t)).toEqual({ category_id: 'dining' })
    expect(db.sqlite.prepare('SELECT status FROM receipts WHERE id = ?').get(id)).toEqual({ status: 'applied' })
  })
})
