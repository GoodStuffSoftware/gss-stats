// POST /api/budget/email/links: owner vs other listed person, each RECEIPTS_SHARE mode, 403/405, the 200 cap, applied
// matches only, no secrets in the answer, and the query plan. Made-up rows (example.com), the in-memory D1 stand-in.
import { beforeEach, describe, expect, it } from 'vitest'
import type { BudgetEnv } from '../../../_lib/budgetAccess'
import { createBudgetDb, insertTxn, testTxnId, type FakeBudgetDb } from '../../../_lib/testing/budgetDb'
import { LINKS_SQL, MAX_LINK_TXNS, onRequest } from './links'

const A = 'user-a@example.com'
const B = 'user-b@example.com'
const NOW = '2026-12-05T10:00:00.000Z'
const CONN_A = 'c0123456789abcdef'
const CONN_B = 'cfedcba9876543210'
const MSG_A = '18c3f2a9b7d4e601'
const MSG_B = '28c3f2a9b7d4e602'
const SECRET_SUB = 'sub-secret-aaaa-111'
const KEY_ID = '0a1b2c3d'

let db: FakeBudgetDb
beforeEach(async () => {
  db = await createBudgetDb()
})

function conn(id: string, owner: string, sub: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO email_connections (id, owner_email, google_sub, status, token_ct, token_iv, key_id, scopes, consent_version, consented_at, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'Q0lQSEVS', 'aXZpdml2aXZpaQ==', ?, 'gmail.readonly', 1, ?, ?, ?)`,
    )
    .run(id, owner, sub, KEY_ID, NOW, NOW, NOW)
}
function receipt(id: string, connection: string, msg: string, merchant: string): void {
  db.sqlite
    .prepare(
      `INSERT INTO receipts (id, connection_id, gmail_msg_id, email_date, status, merchant, receipt_date, total_cents, tax_cents, currency, order_ref, card_last4, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, '2026-11-10', 'applied', ?, '2026-11-09', 1234, 100, 'USD', '111-222', '4242', ?, ?, 'test')`,
    )
    .run(id, connection, msg, merchant, NOW, NOW)
  db.sqlite.prepare('INSERT INTO receipt_items (receipt_id, seq, description, amount_cents, quantity, category_hint) VALUES (?, 2, ?, 300, 1, NULL)').run(id, 'second item')
  db.sqlite.prepare("INSERT INTO receipt_items (receipt_id, seq, description, amount_cents, quantity, category_hint) VALUES (?, 1, ?, 934, 2, 'groceries')").run(id, 'first item')
}
function match(receiptId: string, txn: string, status = 'applied'): void {
  db.sqlite
    .prepare(
      `INSERT INTO receipt_matches (receipt_id, txn_id, group_key, rule, share_cents, score, status, txn_updated_at, created_at) VALUES (?, ?, ?, 'exact', 1234, 90, ?, ?, ?)`,
    )
    .run(receiptId, txn, `g-${receiptId}-${txn.slice(-4)}`, status, NOW, NOW)
}

function seed(): { ta: string; tb: string } {
  conn(CONN_A, A, SECRET_SUB)
  conn(CONN_B, B, 'sub-bbbb')
  const ta = insertTxn(db)
  const tb = insertTxn(db)
  receipt('r0000000000000001', CONN_A, MSG_A, 'Shop A')
  receipt('r0000000000000002', CONN_B, MSG_B, 'Shop B')
  match('r0000000000000001', ta)
  match('r0000000000000002', tb)
  return { ta, tb }
}

async function post(who: string | null, body: unknown, share?: string, method = 'POST'): Promise<Response> {
  const env = { BUDGET_DB: db.d1, ...(share === undefined ? {} : { RECEIPTS_SHARE: share }) } as unknown as BudgetEnv
  const request = new Request('https://stats.goodstuff.software/api/budget/email/links', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  })
  return onRequest({ request, env, data: who ? { budgetEmail: who } : {}, params: {} } as never)
}
type Links = { links: Record<string, Record<string, any>> }
const j = async (res: Response): Promise<Links> => (await res.json()) as Links

describe('email/links: sharing', () => {
  it('fields mode: the owner sees fields and gmailMsgId; the other person sees fields and no gmailMsgId', async () => {
    const { ta, tb } = seed()
    const own = await j(await post(A, { txnIds: [ta, tb] }, 'fields'))
    expect(Object.keys(own.links).sort()).toEqual([ta, tb].sort())
    expect(own.links[ta]).toEqual({
      merchant: 'Shop A', date: '2026-11-09', totalCents: 1234, taxCents: 100, currency: 'USD', orderRef: '111-222', cardLast4: '4242', gmailMsgId: MSG_A,
      items: [
        { description: 'first item', quantity: 2, amountCents: 934, categoryId: 'groceries', category: 'Groceries' },
        { description: 'second item', quantity: 1, amountCents: 300, categoryId: null, category: null },
      ],
    })
    expect(own.links[tb].merchant).toBe('Shop B')
    expect('gmailMsgId' in own.links[tb]).toBe(false)
    const other = await j(await post(B, { txnIds: [ta, tb] }, 'fields'))
    expect(other.links[ta].merchant).toBe('Shop A')
    expect('gmailMsgId' in other.links[ta]).toBe(false)
    expect(other.links[tb].gmailMsgId).toBe(MSG_B)
  })

  it('none mode (and unset or unknown values): only the caller\'s own receipts', async () => {
    const { ta, tb } = seed()
    for (const share of [undefined, 'none', 'bogus', '']) {
      const r = await j(await post(A, { txnIds: [ta, tb] }, share))
      expect(Object.keys(r.links), String(share)).toEqual([ta])
      expect(r.links[ta].gmailMsgId).toBe(MSG_A)
    }
  })

  it('fields_and_link mode: both people get the link', async () => {
    const { ta, tb } = seed()
    const r = await j(await post(B, { txnIds: [ta, tb] }, 'fields_and_link'))
    expect(r.links[ta].gmailMsgId).toBe(MSG_A)
    expect(r.links[tb].gmailMsgId).toBe(MSG_B)
  })

  it('leaks no token, key, sub, email address or connection id', async () => {
    const { ta, tb } = seed()
    const text = await (await post(B, { txnIds: [ta, tb] }, 'fields_and_link')).text()
    for (const secret of [SECRET_SUB, 'sub-bbbb', KEY_ID, 'Q0lQSEVS', 'example.com', CONN_A, CONN_B, 'token', 'key_id', 'google_sub']) expect(text).not.toContain(secret)
  })

  it('returns applied matches only (suggested, rejected, superseded stay out)', async () => {
    conn(CONN_A, A, SECRET_SUB)
    const t = [insertTxn(db), insertTxn(db), insertTxn(db), insertTxn(db)]
    receipt('r0000000000000001', CONN_A, MSG_A, 'Shop A')
    receipt('r0000000000000002', CONN_A, MSG_B, 'Shop B')
    receipt('r0000000000000003', CONN_A, '38c3f2a9b7d4e603', 'Shop C')
    receipt('r0000000000000004', CONN_A, '48c3f2a9b7d4e604', 'Shop D')
    match('r0000000000000001', t[0], 'suggested')
    match('r0000000000000002', t[1], 'rejected')
    match('r0000000000000003', t[2], 'superseded')
    match('r0000000000000004', t[3], 'applied')
    const r = await j(await post(A, { txnIds: t }, 'fields'))
    expect(Object.keys(r.links)).toEqual([t[3]])
  })

  it('a receipt with no items comes back with an empty items list', async () => {
    conn(CONN_A, A, SECRET_SUB)
    const t = insertTxn(db)
    receipt('r0000000000000001', CONN_A, MSG_A, 'Shop A')
    db.exec('DELETE FROM receipt_items')
    match('r0000000000000001', t)
    expect((await j(await post(A, { txnIds: [t] }, 'fields'))).links[t].items).toEqual([])
  })
})

describe('email/links: access and validation', () => {
  it('403 with no identity, for every method', async () => {
    seed()
    for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await post(null, { txnIds: [] }, 'fields', m)
      expect(res.status, m).toBe(403)
    }
  })
  it('unsupported methods are 405 with Allow: POST', async () => {
    for (const m of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const res = await post(A, {}, 'fields', m)
      expect(res.status, m).toBe(405)
      expect(res.headers.get('Allow')).toBe('POST')
    }
  })
  it('the 200 cap holds: 200 ids pass, 201 get 400', async () => {
    seed()
    const ids = (n: number): string[] => Array.from({ length: n }, (_, k) => testTxnId(5000 + k))
    expect(MAX_LINK_TXNS).toBe(200)
    expect((await post(A, { txnIds: ids(200) }, 'fields')).status).toBe(200)
    expect((await post(A, { txnIds: ids(201) }, 'fields')).status).toBe(400)
  })
  it('bad shapes are 400', async () => {
    const good = 'a'.repeat(32)
    for (const body of [{}, { txnIds: 'x' }, { txnIds: [1] }, { txnIds: ['nothex'] }, { txnIds: [good.toUpperCase()] }, { txnIds: [good, null] }, '[]', 'not json']) {
      expect((await post(A, body, 'fields')).status, JSON.stringify(body)).toBe(400)
    }
  })
  it('an empty list is an empty answer', async () => {
    const res = await post(A, { txnIds: [] }, 'fields')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ links: {} })
  })
  it('duplicate ids collapse', async () => {
    const { ta } = seed()
    const r = await j(await post(A, { txnIds: [ta, ta] }, 'fields'))
    expect(r.links[ta].items).toHaveLength(2)
  })
})

describe('email/links: query plan', () => {
  it('is a keyed lookup: no scan of the receipt tables, the connection table, categories or the match table', () => {
    const plan = db.explain(LINKS_SQL, [A, JSON.stringify([testTxnId(1)]), 1, A]).join('\n')
    expect(plan, plan).not.toMatch(/SCAN (receipt_matches|receipts|receipt_items|email_connections|categories)/)
    expect(plan, plan).toMatch(/USING (COVERING )?INDEX (idx_match_applied|idx_match_txn)|USING INDEX idx_match/)
  })
})
