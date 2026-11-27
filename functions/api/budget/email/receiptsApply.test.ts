// /api/budget/email/receipts (list), receipts/<id> (dismiss) and /apply: keyset paging, per-owner scope, the one-applied-receipt-per-row
// rule, category protection, stale skips, split groups, 409 on a lost unique-index race, and EXPLAIN checks. Made-up data only.
import { beforeEach, describe, expect, it } from 'vitest'
import { createBudgetDb, callRoute, insertTxn, json, type FakeBudgetDb } from '../../../_lib/testing/budgetDb'
import { onRequest as apply } from './apply'
import { onRequest as list } from './receipts/index'
import { onRequest as byId } from './receipts/[id]'
import { APPLY_READ_SQL, APPLY_UPDATE_SQL, HAS_UPLOADS_SQL, listSql, PHOTOS_SQL, LIST_MATCHES_SQL, LIST_ITEMS_SQL, OWN_RECEIPT_SQL } from '../../../_lib/receiptsDb'

const A = 'user-a@example.com'
const B = 'user-b@example.com'
const NOW = '2026-12-05T10:00:00.000Z'
const CONN_A = 'c0123456789abcdef'
const CONN_B = 'cfedcba9876543210'

let db: FakeBudgetDb

function conn(id: string, owner: string): void {
  db.sqlite.prepare(
    `INSERT INTO email_connections (id, owner_email, google_sub, status, token_ct, token_iv, key_id, scopes, consent_version, consented_at, created_at, updated_at)
     VALUES (?, ?, ?, 'active', 'Q0lQSEVS', 'aXZpdml2aXZpaQ==', '0a1b2c3d', 'gmail.readonly', 1, ?, ?, ?)`,
  ).run(id, owner, `sub-${id}`, NOW, NOW, NOW)
}
function rid(n: number): string {
  return `r${n.toString(16).padStart(16, '0')}`
}
function receipt(n: number, connection: string, over: { status?: string; email_date?: string; merchant?: string } = {}): string {
  const id = rid(n)
  db.sqlite.prepare(
    `INSERT INTO receipts (id, connection_id, gmail_msg_id, email_date, status, kind, merchant, total_cents, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, 'purchase', ?, 500, ?, ?, 'import:test')`,
  ).run(id, connection, `ab${n.toString(16).padStart(8, '0')}`, over.email_date ?? '2026-11-20', over.status ?? 'suggested', over.merchant ?? 'Invented Shop', NOW, NOW)
  return id
}
function match(receiptId: string, txnId: string, over: { rule?: string; group?: string; status?: string; cat?: string | null; updated?: string } = {}): number {
  const r = db.sqlite.prepare(
    `INSERT INTO receipt_matches (receipt_id, txn_id, group_key, rule, share_cents, score, status, proposed_category_id, txn_updated_at, created_at)
     VALUES (?, ?, ?, ?, 500, 90, ?, ?, ?, ?)`,
  ).run(receiptId, txnId, over.group ?? 'g1', over.rule ?? 'exact', over.status ?? 'suggested', over.cat === undefined ? 'shopping' : over.cat, over.updated ?? NOW, NOW)
  return Number((r as { lastInsertRowid: number | bigint }).lastInsertRowid)
}
/** An auto row: insertTxn stamps updated_by 'seed@example.com' (a person edit), so reset it to a system value. */
function autoTxn(over: Parameters<typeof insertTxn>[1] = {}): string {
  const id = insertTxn(db, { category_source: 'auto', ...over })
  db.sqlite.prepare(`UPDATE transactions SET updated_by = 'import:test' WHERE id = ?`).run(id)
  return id
}
const txn = (id: string) => db.get<Record<string, unknown>>('SELECT * FROM transactions WHERE id = ?', id)!
const rcpt = (id: string) => db.get<{ status: string }>('SELECT status FROM receipts WHERE id = ?', id)!.status
const mstat = (id: number) => db.get<{ status: string }>('SELECT status FROM receipt_matches WHERE id = ?', id)!.status

const post = (body: unknown, email = A) => callRoute(apply, db, '/api/budget/email/apply', { method: 'POST', body, email })
const getList = (query: Record<string, string> = {}, email = A) => callRoute(list, db, '/api/budget/email/receipts', { query, email })
const patch = (id: string, body: unknown, email = A) =>
  callRoute(byId, db, `/api/budget/email/receipts/${id}`, { method: 'PATCH', body, params: { id }, email })

beforeEach(async () => {
  db = await createBudgetDb()
  conn(CONN_A, A)
  conn(CONN_B, B)
})

describe('review list', () => {
  it('pages newest first with a keyset cursor and returns matches and items', async () => {
    for (let i = 1; i <= 5; i++) {
      const id = receipt(i, CONN_A, { email_date: `2026-11-${10 + i}` })
      match(id, autoTxn())
      db.sqlite.prepare(`INSERT INTO receipt_items (receipt_id, seq, description, amount_cents) VALUES (?, 1, 'Invented item', 500)`).run(id)
    }
    const p1 = await json(await getList({ limit: '2' }))
    expect(p1.receipts.map((r: { id: string }) => r.id)).toEqual([rid(5), rid(4)])
    expect(p1.nextCursor).toBeTruthy()
    expect(p1.receipts[0].items).toHaveLength(1)
    expect(p1.receipts[0].matches[0]).toMatchObject({ rule: 'exact', categoryProtectedBy: null, linkedOther: false })
    const p2 = await json(await getList({ limit: '2', cursor: p1.nextCursor }))
    expect(p2.receipts.map((r: { id: string }) => r.id)).toEqual([rid(3), rid(2)])
    const p3 = await json(await getList({ limit: '2', cursor: p2.nextCursor }))
    expect(p3.receipts.map((r: { id: string }) => r.id)).toEqual([rid(1)])
    expect(p3.nextCursor).toBeNull()
  })

  it('breaks an email_date tie on id, and rejects a bad cursor or status', async () => {
    for (let i = 1; i <= 3; i++) receipt(i, CONN_A, { email_date: '2026-11-20' })
    const p1 = await json(await getList({ limit: '2' }))
    expect(p1.receipts.map((r: { id: string }) => r.id)).toEqual([rid(3), rid(2)])
    const p2 = await json(await getList({ limit: '2', cursor: p1.nextCursor }))
    expect(p2.receipts.map((r: { id: string }) => r.id)).toEqual([rid(1)])
    expect((await getList({ cursor: '!!bad' })).status).toBe(400)
    expect((await getList({ status: 'pending' })).status).toBe(400)
  })

  it('shows only the caller own receipts', async () => {
    const mine = receipt(1, CONN_A)
    receipt(2, CONN_B)
    expect((await json(await getList({}, A))).receipts.map((r: { id: string }) => r.id)).toEqual([mine])
    expect((await json(await getList({}, B))).receipts.map((r: { id: string }) => r.id)).toEqual([rid(2)])
    expect((await json(await getList({}, 'user-c@example.com'))).receipts).toEqual([])
  })

  it('flags a manual or person-edited row as protected and an already-linked row', async () => {
    const manual = insertTxn(db, { category_source: 'manual', category_id: 'dining' })
    const person = insertTxn(db, { category_source: 'auto' }) // updated_by contains '@'
    const plain = autoTxn()
    const r = receipt(1, CONN_A)
    match(r, manual, { group: 'g1' })
    match(r, person, { group: 'g2' })
    match(r, plain, { group: 'g3' })
    const by = Object.fromEntries((await json(await getList())).receipts[0].matches.map((m: { txnId: string; categoryProtectedBy: string | null }) => [m.txnId, m.categoryProtectedBy]))
    expect(by).toEqual({ [manual]: 'manual', [person]: 'person_edit', [plain]: null })
  })
})

describe('dismiss', () => {
  it('dismisses and undoes (back to suggested when a suggestion is left, else unmatched)', async () => {
    const r = receipt(1, CONN_A)
    match(r, autoTxn())
    expect(await json(await patch(r, { dismissed: true }))).toEqual({ id: r, status: 'dismissed' })
    expect(await json(await patch(r, { dismissed: false }))).toEqual({ id: r, status: 'suggested' })
    const u = receipt(2, CONN_A, { status: 'unmatched' })
    await patch(u, { dismissed: true })
    expect(await json(await patch(u, { dismissed: false }))).toEqual({ id: u, status: 'unmatched' })
  })

  it('answers 404 for another person receipt, exactly as for a missing one, and changes nothing', async () => {
    const theirs = receipt(1, CONN_B)
    expect((await patch(theirs, { dismissed: true }, A)).status).toBe(404)
    expect((await patch(rid(99), { dismissed: true }, A)).status).toBe(404)
    expect(rcpt(theirs)).toBe('suggested')
    expect((await patch(theirs, { dismissed: true }, 'user-c@example.com')).status).toBe(404)
  })

  it('answers 409 for an applied receipt and 400 for a bad body', async () => {
    const r = receipt(1, CONN_A, { status: 'applied' })
    expect((await patch(r, { dismissed: true })).status).toBe(409)
    expect((await patch(r, { dismissed: 'yes' })).status).toBe(400)
  })
})

describe('apply', () => {
  it('sets the category, clears needs_review and review_reason, links, and never touches the note', async () => {
    const t = autoTxn({ needs_review: 1, review_reason: 'low_confidence' })
    db.sqlite.prepare(`UPDATE transactions SET note = 'my private note' WHERE id = ?`).run(t)
    const r = receipt(1, CONN_A)
    const m = match(r, t, { cat: 'shopping' })
    const res = await post({ items: [{ matchId: m, expectedUpdatedAt: NOW }] })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.applied).toHaveLength(1)
    expect(body.applied[0]).toMatchObject({ matchId: m, txnId: t, categorySet: true, categoryKept: null })
    expect(body.skipped).toEqual([])
    const row = txn(t)
    expect(row).toMatchObject({ category_id: 'shopping', category_source: 'manual', needs_review: 0, review_reason: null, note: 'my private note', updated_by: A })
    expect(row.updated_at).toBe(body.applied[0].updatedAt)
    expect(row.updated_at).not.toBe(NOW)
    expect(mstat(m)).toBe('applied')
    expect(rcpt(r)).toBe('applied')
    expect(db.get('SELECT COUNT(*) AS n FROM category_edits WHERE txn_id = ?', t)).toEqual({ n: 1 })
  })

  it('an explicit categoryId overrides the proposal; an unknown one is 400', async () => {
    const t = autoTxn()
    const m = match(receipt(1, CONN_A), t, { cat: 'shopping' })
    expect((await post({ items: [{ matchId: m, expectedUpdatedAt: NOW, categoryId: 'nope' }] })).status).toBe(400)
    const res = await json(await post({ items: [{ matchId: m, expectedUpdatedAt: NOW, categoryId: 'dining' }] }))
    expect(res.applied[0].categorySet).toBe(true)
    expect(txn(t).category_id).toBe('dining')
  })

  it('category checks are one read for the whole request, not one per item', async () => {
    const items: Array<{ matchId: number; expectedUpdatedAt: string; categoryId?: string }> = []
    const txns: string[] = []
    for (let n = 1; n <= 30; n++) {
      const t = autoTxn()
      txns.push(t)
      items.push({ matchId: match(receipt(n, CONN_A), t, { group: `e${n}` }), expectedUpdatedAt: NOW, ...(n % 2 === 0 ? { categoryId: 'dining' } : {}) })
    }
    db.statements.length = 0
    const body = await json(await post({ items }))
    expect(body.applied.length).toBe(30)
    expect(txn(txns[0]).category_id).toBe('shopping')
    expect(txn(txns[1]).category_id).toBe('dining')
    const reads = db.statements.filter((q) => /\bFROM categories\b/i.test(q))
    expect(reads.length).toBe(1) // 15 of the 30 items carry a category: one read for all of them
  })

  it('an archived category on a planned item is still 400, and a skipped item never trips the check', async () => {
    db.exec("UPDATE categories SET archived = 1 WHERE id = 'dining'")
    const t1 = autoTxn()
    const t2 = autoTxn()
    const m1 = match(receipt(1, CONN_A), t1, { group: 'e1' })
    const stale = match(receipt(2, CONN_A), t2, { group: 'e2' })
    expect((await post({ items: [{ matchId: m1, expectedUpdatedAt: NOW, categoryId: 'dining' }] })).status).toBe(400)
    expect(mstat(m1)).toBe('suggested')
    // a stale item is skipped before any category check, so its bad category does not fail the request
    const body = await json(await post({ items: [{ matchId: stale, expectedUpdatedAt: '2020-01-01T00:00:00.000Z', categoryId: 'nope' }] }))
    expect(body.skipped).toEqual([{ matchId: stale, reason: 'stale', currentUpdatedAt: NOW }])
  })

  it('a manual category is kept: link only, categoryKept manual', async () => {
    const t = insertTxn(db, { category_source: 'manual', category_id: 'dining', needs_review: 1, review_reason: 'x' })
    const r = receipt(1, CONN_A)
    const m = match(r, t, { cat: 'shopping' })
    const body = await json(await post({ items: [{ matchId: m, expectedUpdatedAt: NOW }] }))
    expect(body.applied[0]).toMatchObject({ categorySet: false, categoryKept: 'manual', updatedAt: NOW })
    expect(txn(t)).toMatchObject({ category_id: 'dining', category_source: 'manual', updated_at: NOW })
    expect(mstat(m)).toBe('applied')
    expect(rcpt(r)).toBe('applied')
    expect(db.get('SELECT COUNT(*) AS n FROM category_edits WHERE txn_id = ?', t)).toEqual({ n: 0 })
  })

  it('a category a person set last (updated_by has an @) is kept: categoryKept person_edit', async () => {
    const t = insertTxn(db, { category_source: 'auto', category_id: 'groceries' }) // updated_by seed@example.com
    const m = match(receipt(1, CONN_A), t, { cat: 'shopping' })
    const body = await json(await post({ items: [{ matchId: m, expectedUpdatedAt: NOW }] }))
    expect(body.applied[0]).toMatchObject({ categorySet: false, categoryKept: 'person_edit' })
    expect(txn(t).category_id).toBe('groceries')
    expect(mstat(m)).toBe('applied')
  })

  it('a rule-set category is not person-protected (the rule engine edit is the last one)', async () => {
    const t = insertTxn(db, { category_source: 'rule', category_id: 'groceries' })
    db.sqlite.prepare(`UPDATE transactions SET updated_by = 'rule@example.com' WHERE id = ?`).run(t)
    db.sqlite.prepare(`INSERT INTO merchant_rules (id, merchant_key, set_category_id, source, active, created_at, created_by) VALUES ('rl1234567890abcde', 'test-shop', 'groceries', 'edit', 1, ?, 'x')`).run(NOW)
    db.sqlite.prepare(`INSERT INTO category_edits (txn_id, old_category_id, new_category_id, old_kind, new_kind, rule_id, edited_at, edited_by) VALUES (?, NULL, 'groceries', 'spend', 'spend', 'rl1234567890abcde', ?, 'rule@example.com')`).run(t, NOW)
    const m = match(receipt(1, CONN_A), t, { cat: 'shopping' })
    const body = await json(await post({ items: [{ matchId: m, expectedUpdatedAt: NOW }] }))
    expect(body.applied[0]).toMatchObject({ categorySet: true, categoryKept: null })
    expect(txn(t).category_id).toBe('shopping')
  })

  it('skips a stale expectedUpdatedAt with currentUpdatedAt and changes nothing', async () => {
    const t = autoTxn()
    const r = receipt(1, CONN_A)
    const m = match(r, t)
    const body = await json(await post({ items: [{ matchId: m, expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }] }))
    expect(body.applied).toEqual([])
    expect(body.skipped).toEqual([{ matchId: m, reason: 'stale', currentUpdatedAt: NOW }])
    expect(txn(t).category_id).toBeNull()
    expect(mstat(m)).toBe('suggested')
    expect(rcpt(r)).toBe('suggested')
  })

  it('one applied receipt per transaction: a second receipt on the same row is skipped, not an error', async () => {
    const t = autoTxn()
    const r1 = receipt(1, CONN_A)
    const r2 = receipt(2, CONN_A)
    const m1 = match(r1, t, { cat: 'shopping' })
    const m2 = match(r2, t, { cat: 'dining' })
    // same request: the first wins, the second is txn_linked
    const same = await post({ items: [{ matchId: m1, expectedUpdatedAt: NOW }, { matchId: m2, expectedUpdatedAt: NOW }] })
    expect(same.status).toBe(200)
    const b1 = await json(same)
    expect(b1.applied.map((a: { matchId: number }) => a.matchId)).toEqual([m1])
    expect(b1.skipped).toEqual([{ matchId: m2, reason: 'txn_linked' }])
    expect(mstat(m2)).toBe('suggested')
    expect(rcpt(r2)).toBe('suggested')
    // later request: the row is already linked
    const later = await post({ items: [{ matchId: m2, expectedUpdatedAt: txn(t).updated_at }] })
    expect(later.status).toBe(200)
    expect((await json(later)).skipped).toEqual([{ matchId: m2, reason: 'txn_linked' }])
    expect(txn(t).category_id).toBe('shopping')
  })

  it('a double apply of the same match is skipped as not_suggested', async () => {
    const t = autoTxn()
    const m = match(receipt(1, CONN_A), t)
    await post({ items: [{ matchId: m, expectedUpdatedAt: NOW }] })
    const again = await post({ items: [{ matchId: m, expectedUpdatedAt: txn(t).updated_at }] })
    expect(again.status).toBe(200)
    expect((await json(again)).skipped).toEqual([{ matchId: m, reason: 'not_suggested' }])
  })

  it('a receipt applied to the row between the read and the batch is skipped as conflict, nothing written', async () => {
    const t = autoTxn()
    const m = match(receipt(1, CONN_A), t)
    const realBatch = db.d1.batch.bind(db.d1)
    ;(db.d1 as unknown as { batch: unknown }).batch = async (stmts: never[]) => {
      db.sqlite.prepare(`INSERT INTO receipts (id, connection_id, gmail_msg_id, email_date, status, created_at, updated_at, updated_by) VALUES (?, ?, 'abcdef0123', '2026-11-01', 'applied', ?, ?, 'x')`).run(rid(50), CONN_A, NOW, NOW)
      match(rid(50), t, { status: 'applied', group: 'g9' })
      return realBatch(stmts)
    }
    const res = await post({ items: [{ matchId: m, expectedUpdatedAt: NOW }] })
    expect(res.status).toBe(200)
    expect((await json(res)).skipped).toEqual([{ matchId: m, reason: 'conflict' }])
    expect(txn(t).category_id).toBeNull()
    expect(mstat(m)).toBe('suggested')
  })

  it('a UNIQUE failure from the batch answers 409 conflict', async () => {
    const m = match(receipt(1, CONN_A), autoTxn())
    ;(db.d1 as unknown as { batch: unknown }).batch = async () => { throw new Error('D1_ERROR: UNIQUE constraint failed: receipt_matches.txn_id') }
    const res = await post({ items: [{ matchId: m, expectedUpdatedAt: NOW }] })
    expect(res.status).toBe(409)
  })

  it('is per owner: another person receipts are not_found and unchanged; dismiss and reject do not cross either', async () => {
    const t = autoTxn()
    const r = receipt(1, CONN_B)
    const m = match(r, t)
    const body = await json(await post({ items: [{ matchId: m, expectedUpdatedAt: NOW }], reject: [] }, A))
    expect(body.skipped).toEqual([{ matchId: m, reason: 'not_found' }])
    const rej = await json(await post({ reject: [m] }, A))
    expect(rej.rejected).toEqual([])
    expect(rej.skipped).toEqual([{ matchId: m, reason: 'not_found' }])
    expect(mstat(m)).toBe('suggested')
    expect(txn(t).category_id).toBeNull()
  })

  it('reject marks the match rejected and the receipt unmatched when nothing else is open', async () => {
    const r = receipt(1, CONN_A)
    const m = match(r, autoTxn())
    const body = await json(await post({ reject: [m] }))
    expect(body.rejected).toEqual([m])
    expect(mstat(m)).toBe('rejected')
    expect(rcpt(r)).toBe('unmatched')
  })

  it('split_charges parts apply all or none: a missing part skips the group', async () => {
    const r = receipt(1, CONN_A)
    const t1 = autoTxn()
    const t2 = autoTxn()
    const m1 = match(r, t1, { rule: 'split_charges', group: 'sc' })
    const m2 = match(r, t2, { rule: 'split_charges', group: 'sc' })
    const part = await json(await post({ items: [{ matchId: m1, expectedUpdatedAt: NOW }] }))
    expect(part.applied).toEqual([])
    expect(part.skipped).toEqual([{ matchId: m1, reason: 'incomplete_group' }])
    expect(mstat(m1)).toBe('suggested')
    // a stale sibling blocks the whole group
    const blocked = await json(await post({ items: [{ matchId: m1, expectedUpdatedAt: NOW }, { matchId: m2, expectedUpdatedAt: 'stale' }] }))
    expect(blocked.applied).toEqual([])
    expect(blocked.skipped.map((s: { matchId: number; reason: string }) => `${s.matchId}:${s.reason}`).sort()).toEqual([`${m1}:group_blocked`, `${m2}:stale`].sort())
    expect(txn(t1).category_id).toBeNull()
    // both parts together apply
    const all = await json(await post({ items: [{ matchId: m1, expectedUpdatedAt: NOW }, { matchId: m2, expectedUpdatedAt: NOW }] }))
    expect(all.applied.map((a: { matchId: number }) => a.matchId).sort()).toEqual([m1, m2].sort())
    expect(rcpt(r)).toBe('applied')
  })

  it('one receipt never lands on two rows: two suggested matches of it in one request apply one and skip the other as conflict', async () => {
    const r = receipt(1, CONN_A)
    const t1 = autoTxn()
    const t2 = autoTxn()
    const m1 = match(r, t1, { group: 'e1' })
    const m2 = match(r, t2, { group: 'e2' })
    const body = await json(await post({ items: [{ matchId: m1, expectedUpdatedAt: NOW }, { matchId: m2, expectedUpdatedAt: NOW }] }))
    expect(body.applied.map((a: { matchId: number }) => a.matchId)).toEqual([m1])
    expect(body.skipped).toEqual([{ matchId: m2, reason: 'conflict' }])
    expect(txn(t1).category_id).toBe('shopping')
    expect(txn(t2).category_id).toBeNull()
    expect(rcpt(r)).toBe('applied')
    // the leftover suggestion is superseded, so a later try is not_suggested
    expect(mstat(m2)).toBe('superseded')
    const again = await json(await post({ items: [{ matchId: m2, expectedUpdatedAt: NOW }] }))
    expect(again.skipped).toEqual([{ matchId: m2, reason: 'not_suggested' }])
  })

  it('one receipt never lands on two rows across requests: a match of the receipt applied after the read makes this one a conflict that writes nothing', async () => {
    const r = receipt(1, CONN_A)
    const t1 = autoTxn()
    const t2 = autoTxn()
    const m1 = match(r, t1, { group: 'e1' })
    const m2 = match(r, t2, { group: 'e2' })
    // another request applies m1 between this one's read and its batch (the receipt row still reads suggested here)
    const realBatch = db.d1.batch.bind(db.d1)
    ;(db.d1 as unknown as { batch: unknown }).batch = async (stmts: never[]) => {
      db.sqlite.prepare(`UPDATE receipt_matches SET status = 'applied' WHERE id = ?`).run(m1)
      return realBatch(stmts)
    }
    const res = await json(await post({ items: [{ matchId: m2, expectedUpdatedAt: NOW }] }))
    expect(res.applied).toEqual([])
    expect(res.skipped).toEqual([{ matchId: m2, reason: 'conflict' }])
    expect(txn(t2).category_id).toBeNull()
    expect(mstat(m2)).toBe('suggested')
    expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM receipt_matches WHERE receipt_id = ? AND status = 'applied'`, r)!.n).toBe(1)
  })

  it('a split_charges group still applies as one, and an alternative suggestion for the same receipt is superseded', async () => {
    const r = receipt(1, CONN_A)
    const t1 = autoTxn()
    const t2 = autoTxn()
    const t3 = autoTxn()
    const s1 = match(r, t1, { rule: 'split_charges', group: 'sc' })
    const s2 = match(r, t2, { rule: 'split_charges', group: 'sc' })
    const alt = match(r, t3, { rule: 'exact', group: 'e1' })
    const body = await json(await post({ items: [{ matchId: s1, expectedUpdatedAt: NOW }, { matchId: s2, expectedUpdatedAt: NOW }] }))
    expect(body.applied.map((a: { matchId: number }) => a.matchId).sort()).toEqual([s1, s2].sort())
    expect(body.skipped).toEqual([])
    expect(mstat(alt)).toBe('superseded')
    expect(txn(t3).category_id).toBeNull()
    expect(rcpt(r)).toBe('applied')
  })

  it('split_receipts: several receipts on one row, only one applies', async () => {
    const t = autoTxn()
    const r1 = receipt(1, CONN_A)
    const r2 = receipt(2, CONN_A)
    const m1 = match(r1, t, { rule: 'split_receipts', group: 'sr' })
    const m2 = match(r2, t, { rule: 'split_receipts', group: 'sr' })
    const body = await json(await post({ items: [{ matchId: m1, expectedUpdatedAt: NOW }, { matchId: m2, expectedUpdatedAt: NOW }] }))
    expect(body.applied.map((a: { matchId: number }) => a.matchId)).toEqual([m1])
    expect(body.skipped).toEqual([{ matchId: m2, reason: 'txn_linked' }])
    expect(mstat(m2)).toBe('suggested')
  })

  it('validates the body: empty, over the 50 cap, duplicates and bad ids are 400', async () => {
    expect((await post({})).status).toBe(400)
    const many = Array.from({ length: 51 }, (_, i) => ({ matchId: i + 1, expectedUpdatedAt: NOW }))
    expect((await post({ items: many })).status).toBe(400)
    expect((await post({ reject: Array.from({ length: 51 }, (_, i) => i + 1) })).status).toBe(400)
    expect((await post({ items: [{ matchId: 1, expectedUpdatedAt: NOW }, { matchId: 1, expectedUpdatedAt: NOW }] })).status).toBe(400)
    expect((await post({ items: [{ matchId: 'x', expectedUpdatedAt: NOW }] })).status).toBe(400)
    expect((await post({ items: [{ matchId: 1 }] })).status).toBe(400)
    expect((await post({ items: [{ matchId: 1, expectedUpdatedAt: NOW }], reject: [1] })).status).toBe(400)
  })

  it('applies exactly 50 items in one request', async () => {
    const items: Array<{ matchId: number; expectedUpdatedAt: string }> = []
    for (let i = 1; i <= 50; i++) {
      const m = match(receipt(i, CONN_A), autoTxn(), { group: `g${i}` })
      items.push({ matchId: m, expectedUpdatedAt: NOW })
    }
    const res = await post({ items })
    expect(res.status).toBe(200)
    expect((await json(res)).applied).toHaveLength(50)
  })
})

describe('access', () => {
  it('an unlisted identity (none set) gets 403 on every method', async () => {
    for (const h of [list, apply, byId]) {
      for (const method of ['GET', 'POST', 'PATCH']) {
        const res = await callRoute(h, db, '/api/budget/email/receipts/r0123456789abcdef', { method, email: null, params: { id: 'r0123456789abcdef' }, body: {} })
        expect(res.status, `${method}`).toBe(403)
      }
    }
  })
})

describe('query plans (the D1 read budget)', () => {
  const noScan = (plan: string[]) => expect(plan.filter((l) => /^SCAN /.test(l) && !/json_each/.test(l)), plan.join(' | ')).toEqual([])
  beforeEach(() => {
    const t = autoTxn()
    match(receipt(1, CONN_A), t)
  })
  it('the list and its cursor page search idx_rcpt_review and idx_rcpt_up_review', () => {
    for (const [withCursor, vals] of [[false, [A, 'suggested', 11]], [true, [A, 'suggested', 11, '2026-11-20', rid(1)]]] as const) {
      const plan = db.explain(listSql(withCursor), [...vals])
      expect(plan.join(' | ')).toMatch(/idx_rcpt_review/)
      expect(plan.join(' | ')).toMatch(/idx_rcpt_up_review/)
      noScan(plan.filter((l) => !/^SCAN \(subquery-\d+\)$/.test(l))) // the merge reads the two LIMITed arms, not a table
    }
  })
  it('each arm is ordered by its index (no sort inside a co-routine); only the final merge sorts', () => {
    for (const [withCursor, vals] of [[false, [A, 'suggested', 11]], [true, [A, 'suggested', 11, '2026-11-20', rid(1)]]] as const) {
      const rows = db.all<{ id: number; parent: number; detail: string }>(`EXPLAIN QUERY PLAN ${listSql(withCursor)}`, ...vals)
      const byId = new Map(rows.map((r) => [r.id, r]))
      const insideArm = (r: { parent: number }): boolean => {
        for (let p = byId.get(r.parent); p; p = byId.get(p.parent)) if (/^CO-ROUTINE/.test(p.detail)) return true
        return false
      }
      const sorts = rows.filter((r) => /TEMP B-TREE FOR ORDER BY/.test(r.detail))
      expect(sorts.filter(insideArm), rows.map((r) => r.detail).join(' | ')).toEqual([])
      expect(sorts.length).toBeLessThanOrEqual(2) // the merge's two sides, nothing else
    }
  })
  it('the photo list and the has-uploads probe use idx_rcpt_up_day and never sort or scan a table', () => {
    for (const [sql, vals] of [[PHOTOS_SQL, [A, 100]], [HAS_UPLOADS_SQL, [A]]] as const) {
      const plan = db.explain(sql, [...vals])
      expect(plan.join(' | ')).toMatch(/idx_rcpt_up_/)
      expect(plan.join(' | ')).not.toMatch(/TEMP B-TREE/)
      noScan(plan.filter((l) => l !== 'SCAN CONSTANT ROW'))
    }
  })
  it('the match, item, own-receipt and apply read statements never scan a table', () => {
    const ids = JSON.stringify([rid(1)])
    noScan(db.explain(LIST_MATCHES_SQL, [ids]))
    noScan(db.explain(LIST_ITEMS_SQL, [ids]))
    noScan(db.explain(OWN_RECEIPT_SQL, [rid(1), A]))
    noScan(db.explain(APPLY_READ_SQL, [JSON.stringify([1]), A]))
    noScan(db.explain(APPLY_UPDATE_SQL, [JSON.stringify([{ id: 'x', prev: NOW, stamp: NOW, cat: 'dining', mid: 1 }]), A]))
  })
})
