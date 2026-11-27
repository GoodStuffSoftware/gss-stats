// Receipts Worker store against the real budget schema in SQLite (node:sqlite, D1's dialect). Made-up rows only.
import { beforeEach, describe, expect, it } from 'vitest'
import { createBudgetDb, insertTxn, type FakeBudgetDb } from '../../../functions/_lib/testing/budgetDb'
import { isStale, matchReceipts, STALE_AFTER_DAYS, type MatchProposal } from '../../../src/lib/budget/receiptMatch'
import type { ExtractedReceipt } from '../src/extract'
import * as S from '../src/store'

const NOW = new Date('2026-12-05T10:00:00.000Z')
const CONN = 'c0123456789abcdef'
const CONN2 = 'cfedcba9876543210'
let db: FakeBudgetDb
const d1 = (): D1Database => db.d1

function conn(id = CONN, email = 'user-a@example.com'): void {
  db.sqlite.prepare(`INSERT INTO email_connections (id, owner_email, google_sub, status, token_ct, token_iv, key_id, scopes, consent_version, consented_at, created_at, updated_at)
    VALUES (?, ?, '1234567890', 'active', 'Y2lwaGVydGV4dA==', 'aXZpdml2aXZpaQ==', '0a1b2c3d', 'gmail.readonly', 1, '2026-12-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')`).run(id, email)
}

function extracted(over: Partial<ExtractedReceipt> = {}): ExtractedReceipt {
  return {
    status: 'ok', kind: 'purchase', merchant: 'Test Shop', paymentVia: 'card', cardLast4: null, orderRef: 'A-100', receiptDate: '2026-12-01', relatedDate: null,
    currency: 'USD', totalCents: 1234, taxCents: 100, shippingCents: 0, charges: [], chargesJson: '[]',
    items: [{ description: 'Widget', amountCents: 1134, quantity: 1, categoryHint: 'shopping' }, { description: 'Bad hint', amountCents: 100, quantity: null, categoryHint: 'no-such-category' }],
    ...over,
  }
}

let msgN = 0
const msg = (): string => (0x18c3f2a9b7d4e610n + BigInt(msgN++)).toString(16).padStart(16, '0')
async function put(over: Partial<Parameters<typeof S.insertReceipt>[1]> = {}, at = NOW) {
  return S.insertReceipt(d1(), { connectionId: CONN, gmailMsgId: msg(), emailDate: '2026-12-01', extracted: extracted(), senderDomain: 'shop.example.com', model: 'test-model', ...over }, at)
}
/** A made-up bank row written by a script (the seed's rows carry a person address, which the store treats as a person edit). */
function mk(o: Parameters<typeof insertTxn>[1] = {}): string {
  const id = insertTxn(db, o)
  db.exec(`UPDATE transactions SET updated_by = 'script:load' WHERE id = '${id}'`)
  return id
}
const rcptStatus = (id: string): string => (db.get<{ status: string }>('SELECT status FROM receipts WHERE id = ?', id) as { status: string }).status
const snapshotTxns = (): string => JSON.stringify(db.all('SELECT * FROM transactions ORDER BY id'))
const plan = (sql: string, v: unknown[] = []): string => db.explain(sql, v).join('\n')

beforeEach(async () => {
  db = await createBudgetDb()
  msgN = 0
  conn()
})

describe('reads', () => {
  it('loads the connection and its watermark; null for an unknown id', async () => {
    const c = await S.loadConnection(d1(), CONN)
    expect(c?.ownerEmail).toBe('user-a@example.com')
    expect(c?.status).toBe('active')
    expect(S.watermarkMs(c!)).toBeNull()
    await S.recordConnectionResult(d1(), CONN, { runAtIso: NOW.toISOString(), ok: true, watermarkAt: '2026-12-04T00:00:00.000Z' })
    expect(S.watermarkMs((await S.loadConnection(d1(), CONN))!)).toBe(Date.parse('2026-12-04T00:00:00.000Z'))
    expect(await S.loadConnection(d1(), 'c0000000000000000')).toBeNull()
    expect(await S.loadActiveConnectionIds(d1())).toEqual([CONN])
  })
  it('the watermark never moves backward; last_ok_at moves only on an ok run', async () => {
    await S.recordConnectionResult(d1(), CONN, { runAtIso: '2026-12-05T10:00:00.000Z', ok: true, watermarkAt: '2026-12-04T00:00:00.000Z' })
    await S.recordConnectionResult(d1(), CONN, { runAtIso: '2026-12-05T11:00:00.000Z', ok: false, watermarkAt: '2026-12-01T00:00:00.000Z', lastError: 'rate_limited' })
    const c = (await S.loadConnection(d1(), CONN))!
    expect(c.watermarkAt).toBe('2026-12-04T00:00:00.000Z')
    expect(c.lastOkAt).toBe('2026-12-05T10:00:00.000Z')
    expect(c.lastRunAt).toBe('2026-12-05T11:00:00.000Z')
  })
  it('loads only active receipt_queries, grouped', async () => {
    db.exec(`INSERT INTO receipt_queries (kind, value, active) VALUES ('from', 'shop.example.com', 1), ('from', 'off.example.com', 0), ('exclude_from', 'spam.example.com', 1)`)
    const q = await S.loadReceiptQueries(d1())
    expect(q.from).toEqual(['shop.example.com'])
    expect(q.excludeFrom).toEqual(['spam.example.com'])
    expect(q.subject).toContain('receipt')
  })
})

describe('insert and dedupe', () => {
  it('stores a receipt and its items; a bad category hint becomes null, not a failed batch', async () => {
    const r = await put()
    expect(r.inserted).toBe(true)
    expect(rcptStatus(r.id)).toBe('unmatched')
    const items = db.all<{ description: string; category_hint: string | null }>('SELECT description, category_hint FROM receipt_items WHERE receipt_id = ? ORDER BY seq', r.id)
    expect(items).toEqual([{ description: 'Widget', category_hint: 'shopping' }, { description: 'Bad hint', category_hint: null }])
  })
  it('the same gmail_msg_id twice stores one receipt and no second set of items', async () => {
    const id = msg()
    const a = await put({ gmailMsgId: id })
    const b = await put({ gmailMsgId: id })
    expect([a.inserted, b.inserted]).toEqual([true, false])
    expect(db.get<{ n: number }>('SELECT count(*) n FROM receipts')?.n).toBe(1)
    expect(db.get<{ n: number }>('SELECT count(*) n FROM receipt_items')?.n).toBe(2)
  })
  it('the same message id under another connection is a different receipt', async () => {
    conn(CONN2, 'user-b@example.com')
    const id = msg()
    expect((await put({ gmailMsgId: id })).inserted).toBe(true)
    expect((await put({ gmailMsgId: id, connectionId: CONN2 })).inserted).toBe(true)
  })
  it('filterNewMessageIds skips stored ids and counts malformed ones, never storing them', async () => {
    const id = msg()
    await put({ gmailMsgId: id })
    const fresh = msg()
    const out = await S.filterNewMessageIds(d1(), CONN, [id, fresh, fresh, 'NOT-HEX!', 'abc'])
    expect(out).toEqual({ fresh: [fresh], known: 1, invalid: 2 })
    expect(await S.filterNewMessageIds(d1(), CONN, [])).toEqual({ fresh: [], known: 0, invalid: 0 })
  })
  it('a skipped email is a stub with no fields and no items', async () => {
    const r = await put({ extracted: extracted({ status: 'skipped', merchant: 'Ignored', items: [{ description: 'x', amountCents: 1, quantity: 1, categoryHint: null }] }) })
    expect(rcptStatus(r.id)).toBe('skipped')
    expect(db.get<{ merchant: string | null; n: number }>('SELECT merchant, (SELECT count(*) FROM receipt_items) n FROM receipts WHERE id = ?', r.id)).toEqual({ merchant: null, n: 0 })
  })
  it('a failed extraction is pending with attempts 1; retries count up and the third failure makes it error', async () => {
    const r = await put({ extracted: null, failureCode: 'server_error' })
    expect(db.get<{ status: string; attempts: number; error_code: string }>('SELECT status, attempts, error_code FROM receipts WHERE id = ?', r.id)).toEqual({ status: 'pending', attempts: 1, error_code: 'server_error' })
    expect((await S.loadRetryReceipts(d1(), CONN, 10)).map((x) => x.id)).toEqual([r.id])
    await S.recordFailure(d1(), r.id, 'server_error', NOW)
    expect(rcptStatus(r.id)).toBe('pending')
    await S.recordFailure(d1(), r.id, 'server_error', NOW)
    expect(db.get<{ status: string; attempts: number }>('SELECT status, attempts FROM receipts WHERE id = ?', r.id)).toEqual({ status: 'error', attempts: 3 })
    expect(await S.loadRetryReceipts(d1(), CONN, 10)).toEqual([])
  })
  it('a retry that succeeds fills the row and replaces the items', async () => {
    const r = await put({ extracted: null, failureCode: 'server_error' })
    expect(await S.completeReceipt(d1(), r.id, extracted(), 'test-model', 'shop.example.com', NOW)).toBe(true)
    expect(db.get<{ status: string; total_cents: number; error_code: string | null }>('SELECT status, total_cents, error_code FROM receipts WHERE id = ?', r.id)).toEqual({ status: 'unmatched', total_cents: 1234, error_code: null })
    expect(db.get<{ n: number }>('SELECT count(*) n FROM receipt_items WHERE receipt_id = ?', r.id)?.n).toBe(2)
    // Already complete: a second completion changes nothing.
    expect(await S.completeReceipt(d1(), r.id, extracted({ merchant: 'Other' }), 'm', null, NOW)).toBe(false)
  })
})

describe('daily cap and runs', () => {
  it('counts today\'s model calls from the run rows and computes what is left', async () => {
    const a = await S.createRun(d1(), CONN, 'cron', new Date('2026-12-05T01:00:00.000Z'))
    // 9 emails fetched: 4 extracted, 3 skipped, 2 whose answer was invalid (still paid calls)
    await S.finishRun(d1(), a, { ...S.ZERO_COUNTS, fetched: 9, extracted: 4, skipped: 3 }, null, NOW)
    const old = await S.createRun(d1(), CONN, 'cron', new Date('2026-12-04T23:00:00.000Z'))
    await S.finishRun(d1(), old, { ...S.ZERO_COUNTS, fetched: 50, extracted: 50 }, null, NOW)
    expect(await S.modelCallsToday(d1(), CONN, NOW)).toBe(9)
    expect(S.capRemaining(10, 9)).toBe(1)
    expect(S.capRemaining(10, 7)).toBe(3)
    expect(S.capRemaining(10, 12)).toBe(0)
    expect(S.capRemaining(Number.NaN, 0)).toBe(0)
  })
  it('finishRun records counts, finished_at and the error code once; pruneRuns keeps the newest 200', async () => {
    const id = await S.createRun(d1(), CONN, 'manual', NOW)
    await S.finishRun(d1(), id, { ...S.ZERO_COUNTS, listed: 9, fetched: 5, matched: 2, modelInTokens: 1200 }, 'api_limited', NOW)
    await S.finishRun(d1(), id, { ...S.ZERO_COUNTS, listed: 99 }, null, NOW)
    expect(db.get('SELECT listed, fetched, matched, model_in_tokens, error_code, finished_at FROM receipt_sync_runs WHERE id = ?', id)).toEqual(
      { listed: 9, fetched: 5, matched: 2, model_in_tokens: 1200, error_code: 'api_limited', finished_at: NOW.toISOString() })
    for (let i = 0; i < 210; i++) await S.createRun(d1(), CONN, 'cron', NOW)
    await S.pruneRuns(d1(), CONN)
    expect(db.get<{ n: number }>('SELECT count(*) n FROM receipt_sync_runs')?.n).toBe(S.KEEP_RUNS)
    expect(db.get<{ n: number }>('SELECT count(*) n FROM receipt_sync_runs WHERE id = ?', id)?.n).toBe(0)
  })
  it('needs_reconnect with a stale token ciphertext leaves a freshly reconnected token alone', async () => {
    await S.setConnectionStatus(d1(), CONN, 'needs_reconnect', 'invalid_grant', NOW, 'b2xkLWNpcGhlcg==')
    expect(db.get<{ status: string }>('SELECT status FROM email_connections WHERE id = ?', CONN)?.status).toBe('active')
    await S.setConnectionStatus(d1(), CONN, 'needs_reconnect', 'invalid_grant', NOW, 'Y2lwaGVydGV4dA==')
    expect(db.get<{ status: string }>('SELECT status FROM email_connections WHERE id = ?', CONN)?.status).toBe('needs_reconnect')
  })
  it('a connection set to needs_reconnect holds no token', async () => {
    await S.setConnectionStatus(d1(), CONN, 'needs_reconnect', 'invalid_grant', NOW)
    expect(db.get('SELECT status, token_ct, token_iv, key_id, last_error FROM email_connections WHERE id = ?', CONN)).toEqual(
      { status: 'needs_reconnect', token_ct: null, token_iv: null, key_id: null, last_error: 'invalid_grant' })
  })
})

describe('stale', () => {
  it('dismisses open receipts older than 75 days (same boundary as isStale) and supersedes their suggestions', async () => {
    const today = '2026-12-05'
    const edge = new Date(Date.parse(`${today}T00:00:00Z`) - STALE_AFTER_DAYS * 86_400_000).toISOString().slice(0, 10) // exactly 75 days: not stale
    const past = new Date(Date.parse(`${today}T00:00:00Z`) - (STALE_AFTER_DAYS + 1) * 86_400_000).toISOString().slice(0, 10) // 76: stale
    expect(isStale({ emailDate: edge, receiptDate: null }, today)).toBe(false)
    expect(isStale({ emailDate: past, receiptDate: null }, today)).toBe(true)
    const keep = await put({ emailDate: edge, extracted: extracted({ receiptDate: null }) })
    const old = await put({ emailDate: past, extracted: extracted({ receiptDate: null }) })
    const t = mk({ posted_date: past, amount_cents: -1234 })
    db.exec(`INSERT INTO receipt_matches (receipt_id, txn_id, group_key, rule, share_cents, score, status, txn_updated_at, created_at)
      VALUES ('${old.id}', '${t}', 'g', 'exact', 1234, 80, 'suggested', '2026-12-05T10:00:00.000Z', '2026-12-05T10:00:00.000Z')`)
    expect(await S.markStale(d1(), CONN, NOW)).toBe(1)
    expect(rcptStatus(old.id)).toBe('dismissed')
    expect(rcptStatus(keep.id)).toBe('unmatched')
    expect(db.get<{ status: string }>('SELECT status FROM receipt_matches WHERE receipt_id = ?', old.id)?.status).toBe('superseded')
    expect(db.get<{ updated_by: string }>('SELECT updated_by FROM receipts WHERE id = ?', old.id)?.updated_by).toBe('script:receipts')
  })
})

describe('re-match of open receipts', () => {
  async function runMatch(): Promise<{ counts: S.WriteCounts; ids: string[] }> {
    const open = await S.loadOpenReceipts(d1(), CONN, NOW)
    const { rows, takenTxnIds } = await S.loadCandidateRows(d1(), open)
    const results = matchReceipts(open, rows, {}, { takenTxnIds })
    return { counts: await S.writeMatchResults(d1(), results, NOW), ids: open.map((o) => o.id) }
  }

  it('a bank row that arrives later is matched on the next run; the receipt goes unmatched, then suggested', async () => {
    const r = await put({ extracted: extracted({ totalCents: 4321, merchant: 'Test Shop' }) })
    let out = await runMatch()
    expect(out.counts).toMatchObject({ suggested: 0, unmatched: 1 })
    expect(rcptStatus(r.id)).toBe('unmatched')
    const t = mk({ posted_date: '2026-12-02', amount_cents: -4321, merchant_name: 'Test Shop', merchant_key: 'test-shop' })
    out = await runMatch()
    expect(out.counts.suggested).toBe(1)
    expect(rcptStatus(r.id)).toBe('suggested')
    const m = db.all<{ txn_id: string; status: string; txn_updated_at: string; decided_by: string | null }>('SELECT txn_id, status, txn_updated_at, decided_by FROM receipt_matches WHERE receipt_id = ?', r.id)
    expect(m).toEqual([{ txn_id: t, status: 'suggested', txn_updated_at: '2026-12-05T10:00:00.000Z', decided_by: null }])
  })
  it('re-running is idempotent; a row that stops matching has its suggestion superseded', async () => {
    const r = await put({ extracted: extracted({ totalCents: 4321 }) })
    const t = mk({ posted_date: '2026-12-02', amount_cents: -4321, merchant_name: 'Test Shop' })
    await runMatch()
    await runMatch()
    expect(db.get<{ n: number }>('SELECT count(*) n FROM receipt_matches')?.n).toBe(1)
    db.exec(`UPDATE transactions SET amount_cents = -9999 WHERE id = '${t}'`)
    const out = await runMatch()
    expect(out.counts.suggested).toBe(0)
    expect(db.get<{ status: string }>('SELECT status FROM receipt_matches WHERE receipt_id = ?', r.id)?.status).toBe('superseded')
    expect(rcptStatus(r.id)).toBe('unmatched')
  })
  it('a pair a person rejected is never suggested again', async () => {
    const r = await put({ extracted: extracted({ totalCents: 4321 }) })
    const t = mk({ posted_date: '2026-12-02', amount_cents: -4321, merchant_name: 'Test Shop' })
    await runMatch()
    db.exec(`UPDATE receipt_matches SET status = 'rejected' WHERE receipt_id = '${r.id}'`)
    const out = await runMatch()
    expect(out.counts.suggested).toBe(0)
    expect(rcptStatus(r.id)).toBe('unmatched')
    expect(db.get<{ status: string }>('SELECT status FROM receipt_matches WHERE txn_id = ?', t)?.status).toBe('rejected')
  })
  it('a row already applied to another receipt is taken and not proposed', async () => {
    const a = await put({ extracted: extracted({ totalCents: 4321 }) })
    const b = await put({ extracted: extracted({ totalCents: 4321 }) })
    const t = mk({ posted_date: '2026-12-02', amount_cents: -4321, merchant_name: 'Test Shop' })
    db.exec(`UPDATE receipts SET status = 'applied' WHERE id = '${a.id}'`)
    db.exec(`INSERT INTO receipt_matches (receipt_id, txn_id, group_key, rule, share_cents, score, status, txn_updated_at, created_at)
      VALUES ('${a.id}', '${t}', 'g', 'exact', 4321, 90, 'applied', '2026-12-05T10:00:00.000Z', '2026-12-05T10:00:00.000Z')`)
    const rows = await S.loadCandidateRows(d1(), [{ kind: 'purchase', emailDate: '2026-12-01', receiptDate: '2026-12-01' }])
    expect(rows.takenTxnIds).toEqual([t])
    await runMatch()
    expect(rcptStatus(b.id)).toBe('unmatched')
  })
  it('a deleted transaction resets its applied receipt (trigger) and the next run re-matches it', async () => {
    const r = await put({ extracted: extracted({ totalCents: 4321 }) })
    const t = mk({ posted_date: '2026-12-02', amount_cents: -4321, merchant_name: 'Test Shop' })
    db.exec(`UPDATE receipts SET status = 'applied' WHERE id = '${r.id}'`)
    db.exec(`INSERT INTO receipt_matches (receipt_id, txn_id, group_key, rule, share_cents, score, status, txn_updated_at, created_at)
      VALUES ('${r.id}', '${t}', 'g', 'exact', 4321, 90, 'applied', '2026-12-05T10:00:00.000Z', '2026-12-05T10:00:00.000Z')`)
    expect(await S.loadOpenReceipts(d1(), CONN, NOW)).toEqual([])
    db.exec(`DELETE FROM transactions WHERE id = '${t}'`)
    expect(rcptStatus(r.id)).toBe('unmatched')
    expect((await S.loadOpenReceipts(d1(), CONN, NOW)).map((x) => x.id)).toEqual([r.id])
    const t2 = mk({ posted_date: '2026-12-03', amount_cents: -4321, merchant_name: 'Test Shop' })
    await runMatch()
    expect(rcptStatus(r.id)).toBe('suggested')
    expect(db.get<{ txn_id: string }>(`SELECT txn_id FROM receipt_matches WHERE receipt_id = ? AND status = 'suggested'`, r.id)?.txn_id).toBe(t2)
  })
  it('windows merge: two receipts a day apart are one range read', () => {
    const ws = S.mergedWindows([
      { kind: 'purchase', emailDate: '2026-12-01', receiptDate: null },
      { kind: 'purchase', emailDate: '2026-12-02', receiptDate: null },
      { kind: 'purchase', emailDate: '2026-06-01', receiptDate: null },
    ])
    expect(ws).toEqual([{ from: '2026-05-29', to: '2026-06-11' }, { from: '2026-11-28', to: '2026-12-12' }])
  })
  it('loads every candidate window with one query', async () => {
    mk({ posted_date: '2026-12-02', amount_cents: -100 })
    mk({ posted_date: '2026-03-02', amount_cents: -100 })
    const before = db.statements.length
    const out = await S.loadCandidateRows(d1(), [
      { kind: 'purchase', emailDate: '2026-12-01', receiptDate: null },
      { kind: 'refund', emailDate: '2026-12-03', receiptDate: null },
      { kind: 'purchase', emailDate: '2026-03-01', receiptDate: null },
    ])
    expect(db.statements.length - before).toBe(1)
    expect(out.rows.map((r) => r.postedDate)).toEqual(expect.arrayContaining(['2026-03-02', '2026-12-02']))
  })
  it('flags a row a person edited (manual category, person address, or newest edit by a person) as personEdited', async () => {
    const a = mk({ posted_date: '2026-12-02', amount_cents: -1 })
    const b = mk({ posted_date: '2026-12-02', amount_cents: -2 })
    const c = mk({ posted_date: '2026-12-02', amount_cents: -3 })
    const rule = mk({ posted_date: '2026-12-02', amount_cents: -4 })
    db.exec(`UPDATE transactions SET category_source = 'manual' WHERE id = '${a}'`)
    db.exec(`UPDATE transactions SET updated_by = 'person@example.com' WHERE id = '${b}'`)
    db.exec(`INSERT INTO category_edits (txn_id, new_category_id, edited_at, edited_by) VALUES ('${c}', 'fuel', '2026-12-04T00:00:00.000Z', 'person@example.com')`)
    // A person's older edit followed by a script edit is not "latest by a person"; a rule edit by a person address does not count either.
    db.exec(`INSERT INTO category_edits (txn_id, new_category_id, edited_at, edited_by) VALUES ('${rule}', 'fuel', '2026-12-04T00:00:00.000Z', 'person@example.com')`)
    db.exec(`INSERT INTO category_edits (txn_id, new_category_id, edited_at, edited_by) VALUES ('${rule}', 'dining', '2026-12-04T01:00:00.000Z', 'script:receipts')`)
    const out = await S.loadCandidateRows(d1(), [{ kind: 'purchase', emailDate: '2026-12-01', receiptDate: null }])
    const flag = (id: string) => out.rows.find((r) => r.id === id)?.personEdited
    expect([flag(a), flag(b), flag(c), flag(rule)]).toEqual([true, true, true, false])
  })
})

describe('currency and repeat emails reach the matcher', () => {
  it('loadOpenReceipts carries the stated currency, and a EUR receipt is not matched to an equal-cents USD row', async () => {
    const r = await put({ extracted: extracted({ totalCents: 4321, currency: 'EUR' }) })
    mk({ posted_date: '2026-12-02', amount_cents: -4321, merchant_name: 'Test Shop' })
    const open = await S.loadOpenReceipts(d1(), CONN, NOW)
    expect(open.map((o) => o.currency)).toEqual(['EUR'])
    const { rows, takenTxnIds } = await S.loadCandidateRows(d1(), open)
    const written = await S.writeMatchResults(d1(), matchReceipts(open, rows, { autoApply: true }, { takenTxnIds }), NOW)
    expect(written.suggested).toBe(0)
    expect(rcptStatus(r.id)).toBe('unmatched')
  })
  const sib = (orderRef: string | null, senderDomain: string | null = null) => ({ orderRef, senderDomain, emailDate: '2026-12-01', receiptDate: null })
  it('loadAppliedSiblings returns (order_ref, kind, charged amount) of applied receipts of this connection only', async () => {
    conn(CONN2, 'user-b@example.com')
    const applied = await put({ extracted: extracted({ orderRef: 'ORD-77', totalCents: 5000 }) })
    const other = await put({ connectionId: CONN2, extracted: extracted({ orderRef: 'ORD-77', totalCents: 5000 }) })
    const unrelated = await put({ extracted: extracted({ orderRef: 'ORD-88', totalCents: 700 }) })
    db.exec(`UPDATE receipts SET status = 'applied' WHERE id IN ('${applied.id}', '${other.id}')`)
    const open = [sib('ORD-77'), sib('ORD-88'), sib(null)]
    expect(await S.loadAppliedSiblings(d1(), CONN, open)).toEqual([
      { orderRef: 'ORD-77', amountCents: 5000, refund: false, baseDate: '2026-12-01', senderDomain: 'shop.example.com' },
    ])
    expect(await S.loadAppliedSiblings(d1(), CONN, [sib(null)])).toEqual([])
    expect(rcptStatus(unrelated.id)).not.toBe('applied')
  })
  it('loadAppliedSiblings uses the stated charges (not the total) and carries a refund as such', async () => {
    const charged = await put({ extracted: extracted({ orderRef: 'ORD-91', totalCents: 6000, charges: [{ amountCents: 5000, last4: null }], chargesJson: '[{"amountCents":5000}]' }) })
    const refund = await put({ extracted: extracted({ kind: 'refund', orderRef: 'ORD-92', totalCents: 800 }) })
    db.exec(`UPDATE receipts SET status = 'applied' WHERE id IN ('${charged.id}', '${refund.id}')`)
    const out = await S.loadAppliedSiblings(d1(), CONN, [sib('ORD-91'), sib('ORD-92')])
    expect(out.map((s) => [s.orderRef, s.amountCents, s.refund]).sort()).toEqual([['ORD-91', 5000, false], ['ORD-92', 800, true]])
  })
  it('loadAppliedSiblings reads order-less applied receipts only for the open sender domains, from a few days back', async () => {
    const same = await put({ extracted: extracted({ orderRef: null, totalCents: 900 }) })
    const otherSender = await put({ senderDomain: 'other.example.com', extracted: extracted({ orderRef: null, totalCents: 900 }) })
    const old = await put({ emailDate: '2026-11-01', extracted: extracted({ orderRef: null, receiptDate: '2026-11-01', totalCents: 900 }) })
    db.exec(`UPDATE receipts SET status = 'applied' WHERE id IN ('${same.id}', '${otherSender.id}', '${old.id}')`)
    const out = await S.loadAppliedSiblings(d1(), CONN, [sib(null, 'shop.example.com')])
    expect(out).toEqual([{ orderRef: null, amountCents: 900, refund: false, baseDate: '2026-12-01', senderDomain: 'shop.example.com' }])
  })
  it('a repeat email of an applied order stays unmatched next to a same-amount row', async () => {
    const applied = await put({ extracted: extracted({ orderRef: 'ORD-77', totalCents: 5000 }) })
    db.exec(`UPDATE receipts SET status = 'applied' WHERE id = '${applied.id}'`)
    const repeat = await put({ extracted: extracted({ orderRef: 'ORD-77', totalCents: 5000 }) })
    mk({ posted_date: '2026-12-02', amount_cents: -5000, merchant_name: 'Test Shop' })
    const open = await S.loadOpenReceipts(d1(), CONN, NOW)
    expect(open.map((o) => o.id)).toEqual([repeat.id])
    const { rows, takenTxnIds } = await S.loadCandidateRows(d1(), open)
    const appliedSiblings = await S.loadAppliedSiblings(d1(), CONN, open)
    const written = await S.writeMatchResults(d1(), matchReceipts(open, rows, { autoApply: true }, { takenTxnIds, appliedSiblings }), NOW)
    expect(written.suggested).toBe(0)
    expect(rcptStatus(repeat.id)).toBe('unmatched')
  })
  it('a full refund of an applied order still matches its refund row', async () => {
    const purchase = await put({ extracted: extracted({ orderRef: 'ORD-77', totalCents: 5000 }) })
    db.exec(`UPDATE receipts SET status = 'applied' WHERE id = '${purchase.id}'`)
    const refund = await put({ extracted: extracted({ kind: 'refund', orderRef: 'ORD-77', totalCents: 5000 }) })
    mk({ posted_date: '2026-12-03', amount_cents: 5000, kind: 'refund', merchant_name: 'Test Shop' })
    const open = await S.loadOpenReceipts(d1(), CONN, NOW)
    expect(open.map((o) => o.id)).toEqual([refund.id])
    const { rows, takenTxnIds } = await S.loadCandidateRows(d1(), open)
    const appliedSiblings = await S.loadAppliedSiblings(d1(), CONN, open)
    const written = await S.writeMatchResults(d1(), matchReceipts(open, rows, {}, { takenTxnIds, appliedSiblings }), NOW)
    expect(written.suggested).toBe(1)
  })
})

describe('never writes transactions', () => {
  it('a full receipt run with auto-apply off leaves transactions byte-identical and runs no transactions write', async () => {
    const r = await put({ extracted: extracted({ totalCents: 4321, merchant: 'Test Shop' }) })
    mk({ posted_date: '2026-12-02', amount_cents: -4321, merchant_name: 'Test Shop' })
    const before = snapshotTxns()
    const edits = db.get<{ n: number }>('SELECT count(*) n FROM category_edits')?.n
    db.statements.length = 0
    await S.markStale(d1(), CONN, NOW)
    const open = await S.loadOpenReceipts(d1(), CONN, NOW)
    const { rows, takenTxnIds } = await S.loadCandidateRows(d1(), open)
    const counts = await S.writeMatchResults(d1(), matchReceipts(open, rows, { autoApply: true }, { takenTxnIds }), NOW)
    expect(counts.proposals.some((p) => p.autoEligible)).toBe(true)
    expect(await S.autoApplyMatches(d1(), counts.proposals, NOW, { enabled: S.autoApplyEnabled('0') })).toBe(0)
    expect(await S.autoApplyMatches(d1(), counts.proposals, NOW, { enabled: S.autoApplyEnabled(undefined) })).toBe(0)
    expect(snapshotTxns()).toBe(before)
    expect(db.get<{ n: number }>('SELECT count(*) n FROM category_edits')?.n).toBe(edits)
    expect(rcptStatus(r.id)).toBe('suggested')
    expect(db.statements.filter((s) => /\b(insert\s+(or\s+\w+\s+)?into|update|delete\s+from|replace\s+into)\s+(transactions|category_edits)\b/i.test(s))).toEqual([])
  })
})

describe('auto-apply (off at launch)', () => {
  const eligible = async (cat: string | null = 'fuel', txnOver: Parameters<typeof insertTxn>[1] = {}) => {
    const r = await put({ extracted: extracted({ totalCents: 4321, items: cat ? [{ description: 'Gas', amountCents: 4321, quantity: 1, categoryHint: cat }] : [] }) })
    const t = mk({ posted_date: '2026-12-02', amount_cents: -4321, merchant_name: 'Test Shop', ...txnOver })
    const open = await S.loadOpenReceipts(d1(), CONN, NOW)
    const { rows } = await S.loadCandidateRows(d1(), open)
    const w = await S.writeMatchResults(d1(), matchReceipts(open, rows, { autoApply: true }), NOW)
    return { r, t, proposals: w.proposals }
  }
  const txn = (id: string) => db.get<{ category_id: string | null; category_source: string; updated_by: string; note: string | null }>('SELECT category_id, category_source, updated_by, note FROM transactions WHERE id = ?', id)!

  it('with the flag on: links the receipt, sets a missing category, writes an audit row, never the note', async () => {
    const { r, t, proposals } = await eligible()
    expect(proposals[0]?.autoEligible).toBe(true)
    const noteBefore = txn(t).note
    expect(await S.autoApplyMatches(d1(), proposals, NOW, { enabled: S.autoApplyEnabled('1') })).toBe(1)
    expect(txn(t)).toMatchObject({ category_id: 'fuel', category_source: 'auto', updated_by: 'script:receipts', note: noteBefore })
    expect(rcptStatus(r.id)).toBe('applied')
    expect(db.get('SELECT status, decided_by FROM receipt_matches WHERE receipt_id = ?', r.id)).toEqual({ status: 'applied', decided_by: 'script:receipts' })
    expect(db.get('SELECT new_category_id, edited_by FROM category_edits WHERE txn_id = ?', t)).toEqual({ new_category_id: 'fuel', edited_by: 'script:receipts' })
    expect(S.AUTO_CATEGORY_SQL + S.AUTO_LINK_SQL + S.AUTO_AUDIT_SQL).not.toMatch(/\bnote\b/)
  })
  it('a row that already has a category is linked but its category is kept', async () => {
    const { r, t, proposals } = await eligible('fuel', { category_id: 'dining', category_source: 'auto' })
    expect(await S.autoApplyMatches(d1(), proposals, NOW, { enabled: true })).toBe(1)
    expect(txn(t).category_id).toBe('dining')
    expect(rcptStatus(r.id)).toBe('applied')
  })
  it.each([
    ['a manual category', { category_source: 'manual', category_id: 'dining' }],
    ['a manual kind', { kind_source: 'manual' }],
    ['a person address on the row', { updated_by: 'person@example.com' }],
  ])('leaves a row with %s alone', async (_n, over) => {
    const { r, t, proposals } = await eligible('fuel')
    if ('updated_by' in over) db.exec(`UPDATE transactions SET updated_by = 'person@example.com' WHERE id = '${t}'`)
    else db.exec(`UPDATE transactions SET ${Object.entries(over).map(([k, v]) => `${k} = '${v}'`).join(', ')} WHERE id = '${t}'`)
    const before = snapshotTxns()
    expect(await S.autoApplyMatches(d1(), proposals, NOW, { enabled: true })).toBe(0)
    expect(snapshotTxns()).toBe(before)
    expect(rcptStatus(r.id)).toBe('suggested')
  })
  it('leaves a row whose newest category edit was made by a person, but not one whose edit was a rule\'s', async () => {
    const a = await eligible('fuel')
    db.exec(`INSERT INTO category_edits (txn_id, new_category_id, edited_at, edited_by) VALUES ('${a.t}', 'fuel', '2026-12-04T00:00:00.000Z', 'person@example.com')`)
    expect(await S.autoApplyMatches(d1(), a.proposals, NOW, { enabled: true })).toBe(0)
  })
  it('an updated_at that changed since the proposal blocks the apply', async () => {
    const { t, proposals } = await eligible('fuel')
    db.exec(`UPDATE transactions SET updated_at = '2026-12-05T10:00:01.000Z' WHERE id = '${t}'`)
    expect(await S.autoApplyMatches(d1(), proposals, NOW, { enabled: true })).toBe(0)
    expect(txn(t).category_id).toBeNull()
  })
  it('only an exact, unique, high-score, auto-eligible proposal is applied', async () => {
    const { proposals } = await eligible('fuel')
    const weak = proposals.map((p): MatchProposal => ({ ...p, score: 70 }))
    const notEligible = proposals.map((p): MatchProposal => ({ ...p, autoEligible: false }))
    const split = proposals.map((p): MatchProposal => ({ ...p, rule: 'split_charges' }))
    for (const set of [weak, notEligible, split]) expect(await S.autoApplyMatches(d1(), set, NOW, { enabled: true })).toBe(0)
  })
})

describe('query plans use an index (D1 read budget)', () => {
  const scan = (p: string) => expect(p).not.toMatch(/SCAN (transactions|receipts|receipt_matches|receipt_items|category_edits|email_connections|receipt_sync_runs)\b/)

  it('connection, active list, queries', () => {
    expect(plan(S.CONNECTION_SQL, [CONN])).toMatch(/SEARCH email_connections USING (INTEGER )?PRIMARY KEY|sqlite_autoindex_email_connections_1/)
    expect(plan(S.ACTIVE_CONNECTIONS_SQL)).toMatch(/^SCAN email_connections$/) // two rows (one per login): no index needed
    expect(plan(S.QUERIES_SQL)).toMatch(/SEARCH receipt_queries USING (COVERING )?INDEX sqlite_autoindex_receipt_queries_1/)
  })
  it('the dedupe pre-check uses the (connection_id, gmail_msg_id) unique index', () => {
    const p = plan(S.KNOWN_IDS_SQL, [CONN, '["18c3f2a9b7d4e610"]'])
    expect(p).toMatch(/SEARCH receipts USING (COVERING )?INDEX sqlite_autoindex_receipts_\d/)
    scan(p)
  })
  it('retry list uses idx_rcpt_retry; open list and stale updates use idx_rcpt_open', () => {
    expect(plan(S.RETRY_SQL, [CONN, 5])).toMatch(/idx_rcpt_retry/)
    const open = plan(S.OPEN_RECEIPTS_SQL, [CONN, '2026-10-01'])
    expect(open).toMatch(/idx_rcpt_open/)
    expect(open).not.toMatch(/TEMP B-TREE/)
    expect(plan(S.STALE_DISMISS_SQL, [CONN, '2026-09-01', 'x'])).toMatch(/idx_rcpt_open/)
    const sup = plan(S.STALE_SUPERSEDE_SQL, [CONN, '2026-09-01', 'x'])
    expect(sup).toMatch(/idx_rcpt_open/)
    scan(sup)
  })
  it('the candidate read ranges idx_txn_date per window and looks edits up by idx_edits_txn and applied matches by idx_match_applied', () => {
    const p = plan(S.CANDIDATE_ROWS_SQL, ['[["2026-12-01","2026-12-10"]]'])
    expect(p).toMatch(/SEARCH t USING (COVERING )?INDEX idx_txn_date \(posted_date>\? AND posted_date<\?\)/)
    expect(p).toMatch(/idx_edits_txn/)
    expect(p).toMatch(/idx_match_(applied|txn)/)
    scan(p)
  })
  it('items, rejected pairs, supersede and upsert are key lookups', () => {
    expect(plan(S.ITEMS_SQL, ['["r1"]'])).toMatch(/SEARCH receipt_items USING PRIMARY KEY \(receipt_id=\?\)|SEARCH receipt_items USING (COVERING )?INDEX/)
    const rej = plan(S.REJECTED_SQL, ['["r1"]'])
    expect(rej).toMatch(/sqlite_autoindex_receipt_matches_1/)
    scan(rej)
    const sup = plan(S.SUPERSEDE_SQL, ['r1', 'x', '[]'])
    expect(sup).toMatch(/sqlite_autoindex_receipt_matches_1 \(receipt_id=\?\)/)
    scan(sup)
    scan(plan(S.UPSERT_MATCH_SQL, ['r1', 't1', 'g', 'exact', 1, 90, null, 'x', 'x']))
    scan(plan(S.SET_RECEIPT_STATUS_SQL, ['r1', 'suggested', 'x']))
  })
  it('run rows: the daily count, prune and finish use idx_runs_conn or the primary key', () => {
    const d = plan(S.DAILY_CALLS_SQL, [CONN, '2026-12-05T00:00:00.000Z'])
    expect(d).toMatch(/idx_runs_conn/)
    scan(d)
    const pr = plan(S.PRUNE_RUNS_SQL, [CONN])
    expect(pr).toMatch(/idx_runs_conn/)
    scan(pr)
    scan(plan(S.FINISH_RUN_SQL, [1, 'x', 0, 0, 0, 0, 0, 0, 0, 0, null]))
  })
  it('the auto-apply statements are key lookups (transactions by primary key, edits by idx_edits_txn)', () => {
    const cat = plan(S.AUTO_CATEGORY_SQL, ['fuel', 'x', 't1', 'y', 'r1', 'z'])
    expect(cat).toMatch(/idx_edits_txn/)
    scan(cat)
    scan(plan(S.AUTO_LINK_SQL, ['x', 'r1', 't1', 'y']))
    scan(plan(S.AUTO_AUDIT_SQL, ['fuel', 'x', 't1']))
    scan(plan(S.AUTO_RECEIPT_SQL, ['r1', 't1', 'x']))
  })
})

// ---------- photo uploads (stage 2) ----------
const UP_A = 'user-a@example.com'
const UP_B = 'user-b@example.com'
const hex = (n: number): string => n.toString(16).padStart(64, '0')
let upN = 0
async function putUpload(over: { email?: string; sha?: string; at?: Date } = {}) {
  const id = S.newUploadId()
  upN++
  const r = await S.insertUploadReceipt(d1(), { id, uploaderEmail: over.email ?? UP_A, imageSha256: over.sha ?? hex(upN), imageBytes: 1234 }, over.at ?? NOW)
  return { id, r }
}
/** Make an upload row look read: the fields the matcher needs. */
function readUp(id: string, over: { status?: string; total?: number; orderRef?: string | null; receiptDate?: string } = {}): void {
  db.sqlite.prepare(`UPDATE receipts SET status = ?, kind = 'purchase', merchant = 'Photo Shop', currency = 'USD', total_cents = ?, order_ref = ?, receipt_date = ? WHERE id = ?`)
    .run(over.status ?? 'unmatched', over.total ?? 2500, over.orderRef ?? null, over.receiptDate ?? '2026-12-01', id)
}

describe('upload helpers', () => {
  it('inserts a pending upload row with its image key, hash and size, and no connection', async () => {
    const { id, r } = await putUpload()
    expect(r).toEqual({ ok: true, id })
    const row = db.get<Record<string, unknown>>('SELECT * FROM receipts WHERE id = ?', id)!
    expect(row).toMatchObject({ source: 'upload', status: 'pending', attempts: 0, connection_id: null, gmail_msg_id: null, uploader_email: UP_A, image_key: S.imageKeyOf(id), image_bytes: 1234, email_date: '2026-12-05' })
    expect(S.imageKeyOf(id)).toBe(`img/${id}.jpg`)
  })
  it("the same image twice answers with the existing row (own upload and someone else's)", async () => {
    const first = await putUpload({ sha: hex(900) })
    const own = await S.insertUploadReceipt(d1(), { id: S.newUploadId(), uploaderEmail: UP_A, imageSha256: hex(900), imageBytes: 5 }, NOW)
    expect(own).toMatchObject({ ok: false, duplicate: { id: first.id, uploaderEmail: UP_A } })
    const other = await S.insertUploadReceipt(d1(), { id: S.newUploadId(), uploaderEmail: UP_B, imageSha256: hex(900), imageBytes: 5 }, NOW)
    expect(other).toMatchObject({ ok: false, duplicate: { id: first.id, uploaderEmail: UP_A } })
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM receipts')!.n).toBe(1)
    expect((await S.findUploadByHash(d1(), hex(900)))?.id).toBe(first.id)
    expect(await S.findUploadByHash(d1(), hex(901))).toBeNull()
  })
  it('a non-unique database error is not swallowed', async () => {
    await expect(S.insertUploadReceipt(d1(), { id: 'bad', uploaderEmail: UP_A, imageSha256: hex(5), imageBytes: 5 }, NOW)).rejects.toThrow()
  })
  it('loadUpload finds uploads only, not email receipts', async () => {
    const { id } = await putUpload()
    expect(await S.loadUpload(d1(), id)).toMatchObject({ id, uploaderEmail: UP_A, status: 'pending', imageKey: `img/${id}.jpg`, attempts: 0 })
    const e = await put()
    expect(await S.loadUpload(d1(), (e as unknown as { id: string }).id)).toBeNull()
    expect(await S.loadUpload(d1(), 'r0000000000000000')).toBeNull()
  })
  it('uploadsToday counts one person since the start of the UTC day', async () => {
    await putUpload({ at: new Date('2026-12-04T23:59:59.000Z') })
    await putUpload({ at: new Date('2026-12-05T00:00:00.000Z') })
    await putUpload({ at: NOW })
    await putUpload({ email: UP_B, at: NOW })
    expect(await S.uploadsToday(d1(), UP_A, NOW)).toBe(2)
    expect(await S.uploadsToday(d1(), UP_B, NOW)).toBe(1)
    expect(await S.uploadsToday(d1(), 'nobody@example.com', NOW)).toBe(0)
  })
  it('loadUploadRetries lists pending and error uploads under the attempt limit, fewest attempts first, never email rows', async () => {
    const a = await putUpload()
    const b = await putUpload()
    const c = await putUpload()
    const d = await putUpload()
    db.exec(`UPDATE receipts SET attempts = 2, status = 'error' WHERE id = '${b.id}'`)
    db.exec(`UPDATE receipts SET attempts = 3, status = 'error' WHERE id = '${c.id}'`)
    db.exec(`UPDATE receipts SET status = 'unmatched' WHERE id = '${d.id}'`)
    await put({ extracted: { ...extracted(), status: 'ok' } })
    const rows = await S.loadUploadRetries(d1(), 10)
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id])
    expect(await S.loadUploadRetries(d1(), 1)).toHaveLength(1)
  })
  it("deleteUploadReceipt removes only the uploader's own row, with its items", async () => {
    const { id } = await putUpload()
    db.exec(`INSERT INTO receipt_items (receipt_id, seq, description, amount_cents) VALUES ('${id}', 1, 'Thing', 100)`)
    expect(await S.deleteUploadReceipt(d1(), id, UP_B)).toBe(false)
    expect(await S.deleteUploadReceipt(d1(), 'r0000000000000000', UP_A)).toBe(false)
    expect(db.get('SELECT 1 FROM receipts WHERE id = ?', id)).toBeTruthy()
    expect(await S.deleteUploadReceipt(d1(), id, UP_A)).toBe(true)
    expect(db.get('SELECT 1 FROM receipts WHERE id = ?', id)).toBeFalsy()
    expect(db.get('SELECT 1 FROM receipt_items WHERE receipt_id = ?', id)).toBeFalsy()
  })
  it('an email receipt is never deleted through the upload helper', async () => {
    const e = (await put()) as unknown as { id: string }
    expect(await S.deleteUploadReceipt(d1(), e.id, UP_A)).toBe(false)
    expect(db.get('SELECT 1 FROM receipts WHERE id = ?', e.id)).toBeTruthy()
  })
  it('the retention sweep reads images older than the cutoff and clearing keeps the row and its hash', async () => {
    const old = await putUpload({ at: new Date('2026-08-01T00:00:00.000Z'), sha: hex(700) })
    const fresh = await putUpload({ at: NOW })
    const cutoff = new Date('2026-09-01T00:00:00.000Z')
    expect(await S.loadExpiredImages(d1(), UP_A, cutoff, 50)).toEqual([{ id: old.id, imageKey: `img/${old.id}.jpg` }])
    await S.clearImageKey(d1(), old.id, NOW)
    const row = db.get<Record<string, unknown>>('SELECT image_key, image_sha256 FROM receipts WHERE id = ?', old.id)!
    expect(row.image_key).toBeNull()
    expect(row.image_sha256).toBe(hex(700))
    expect(await S.loadExpiredImages(d1(), UP_A, cutoff, 50)).toEqual([])
    expect(await S.loadExpiredImages(d1(), UP_B, cutoff, 50)).toEqual([])
    expect((await S.loadUpload(d1(), fresh.id))?.imageKey).toBe(`img/${fresh.id}.jpg`)
  })
})

describe('upload scope twins', () => {
  it("loadOpenReceipts for an upload scope returns only that person's open uploads, never email receipts", async () => {
    const a = await putUpload(); readUp(a.id)
    const b = await putUpload({ email: UP_B }); readUp(b.id)
    await putUpload() // still pending: not open
    await put()
    const open = await S.loadOpenReceipts(d1(), { kind: 'upload', email: UP_A }, NOW)
    expect(open.map((r) => r.id)).toEqual([a.id])
    const emailOpen = await S.loadOpenReceipts(d1(), CONN, NOW)
    expect(emailOpen.map((r) => r.id)).not.toContain(a.id)
    expect(emailOpen).toHaveLength(1)
  })
  it("markStale in upload scope dismisses only that person's old open uploads", async () => {
    const a = await putUpload(); readUp(a.id, { receiptDate: '2026-08-01' })
    const b = await putUpload({ email: UP_B }); readUp(b.id, { receiptDate: '2026-08-01' })
    const fresh = await putUpload(); readUp(fresh.id)
    expect(await S.markStale(d1(), { kind: 'upload', email: UP_A }, NOW)).toBe(1)
    expect(rcptStatus(a.id)).toBe('dismissed')
    expect(rcptStatus(b.id)).toBe('unmatched')
    expect(rcptStatus(fresh.id)).toBe('unmatched')
  })
  it("loadAppliedSiblings in upload scope uses the order ref arm over that person's applied uploads only", async () => {
    const a = await putUpload(); readUp(a.id, { status: 'applied', orderRef: 'UP-1' })
    const b = await putUpload({ email: UP_B }); readUp(b.id, { status: 'applied', orderRef: 'UP-1' })
    const sib = await S.loadAppliedSiblings(d1(), { kind: 'upload', email: UP_A }, [{ orderRef: 'UP-1', senderDomain: null, emailDate: '2026-12-05', receiptDate: '2026-12-01' }])
    expect(sib).toHaveLength(1)
    expect(sib[0].orderRef).toBe('UP-1')
    expect(await S.loadAppliedSiblings(d1(), { kind: 'upload', email: UP_A }, [{ orderRef: null, senderDomain: null, emailDate: '2026-12-05', receiptDate: null }])).toEqual([])
  })
  it('a bare string scope is still a connection id', async () => {
    await put()
    expect(await S.loadOpenReceipts(d1(), CONN, NOW)).toHaveLength(1)
    expect(await S.loadOpenReceipts(d1(), { kind: 'connection', connectionId: CONN }, NOW)).toHaveLength(1)
  })
})

describe('upload query plans use the 0006 partial indexes', () => {
  const scan = (p: string) => expect(p).not.toMatch(/SCAN (receipts|receipt_matches|receipt_items)\b/)
  it('open list and stale updates use idx_rcpt_up_open', () => {
    const open = plan(S.UP_OPEN_RECEIPTS_SQL, [UP_A, '2026-10-01'])
    expect(open).toMatch(/idx_rcpt_up_open/)
    expect(open).not.toMatch(/TEMP B-TREE/)
    expect(plan(S.UP_STALE_DISMISS_SQL, [UP_A, '2026-09-01', 'x'])).toMatch(/idx_rcpt_up_open/)
    const sup = plan(S.UP_STALE_SUPERSEDE_SQL, [UP_A, '2026-09-01', 'x'])
    expect(sup).toMatch(/idx_rcpt_up_open/)
    scan(sup)
  })
  it('applied siblings use idx_rcpt_up_review', () => {
    const p = plan(S.UP_APPLIED_SIBLINGS_SQL, [UP_A, '["A-1"]'])
    expect(p).toMatch(/idx_rcpt_up_review/)
    scan(p)
  })
  it('the daily count uses idx_rcpt_up_day; the retry list uses idx_rcpt_up_retry', () => {
    expect(plan(S.UPLOADS_TODAY_SQL, [UP_A, '2026-12-05T00:00:00.000Z'])).toMatch(/idx_rcpt_up_day/)
    const retry = plan(S.UPLOAD_RETRY_SQL, [5])
    expect(retry).toMatch(/idx_rcpt_up_retry/)
    expect(retry).not.toMatch(/TEMP B-TREE/)
  })
  it('the hash lookup uses idx_rcpt_up_hash; id lookup, delete and clear use the primary key', () => {
    expect(plan(S.UPLOAD_BY_HASH_SQL, [hex(1)])).toMatch(/idx_rcpt_up_hash/)
    scan(plan(S.UPLOAD_BY_ID_SQL, ['r1']))
    scan(plan(S.DELETE_UPLOAD_SQL, ['r1', UP_A]))
    scan(plan(S.CLEAR_IMAGE_KEY_SQL, ['r1', 'x']))
  })
  it('the retention read is a seek on idx_rcpt_up_day with no sort; the open-uploaders read uses idx_rcpt_up_open', () => {
    const p = plan(S.EXPIRED_IMAGES_SQL, ['2026-09-01T00:00:00.000Z', 50, UP_A])
    expect(p).toMatch(/idx_rcpt_up_day \(uploader_email=\? AND created_at<\?\)/)
    expect(p).not.toMatch(/TEMP B-TREE/)
    expect(plan(S.OPEN_UPLOADERS_SQL, [])).toMatch(/idx_rcpt_up_open/)
  })
})

describe('email SQL stays byte-identical', () => {
  const sha = async (s: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('')
  it('the email statements keep the text they had before uploads', async () => {
    expect({
      STALE_SUPERSEDE_SQL: await sha(S.STALE_SUPERSEDE_SQL), STALE_DISMISS_SQL: await sha(S.STALE_DISMISS_SQL), OPEN_RECEIPTS_SQL: await sha(S.OPEN_RECEIPTS_SQL),
      APPLIED_SIBLINGS_SQL: await sha(S.APPLIED_SIBLINGS_SQL), RETRY_SQL: await sha(S.RETRY_SQL), KNOWN_IDS_SQL: await sha(S.KNOWN_IDS_SQL),
    }).toEqual(EMAIL_SQL_HASHES)
  })
})

describe('uploads are never auto-applied', () => {
  it('the auto-apply SQL is restricted to source = email receipts', () => {
    expect(S.AUTO_LINK_SQL).toContain("r.source = 'email'")
    expect(S.AUTO_RECEIPT_SQL).toContain("source = 'email'")
  })
  it('with the flag on, an upload proposal is not linked and the upload stays suggested', async () => {
    const t = mk({ posted_date: '2026-12-02', amount_cents: -2500, merchant_name: 'Photo Shop' })
    const u = await putUpload()
    readUp(u.id, { total: 2500, receiptDate: '2026-12-01' })
    db.exec(`INSERT INTO receipt_items (receipt_id, seq, description, amount_cents, category_hint) VALUES ('${u.id}', 1, 'Gas', 2500, 'fuel')`)
    const open = await S.loadOpenReceipts(d1(), { kind: 'upload', email: UP_A }, NOW)
    const { rows } = await S.loadCandidateRows(d1(), open)
    const w = await S.writeMatchResults(d1(), matchReceipts(open, rows, { autoApply: true }), NOW)
    expect(w.proposals.length).toBeGreaterThan(0)
    const applied = await S.autoApplyMatches(d1(), w.proposals, NOW, { enabled: true })
    expect(applied).toBe(0)
    expect(rcptStatus(u.id)).toBe('suggested')
    expect(db.get<{ n: number }>("SELECT count(*) AS n FROM receipt_matches WHERE status = 'applied'")!.n).toBe(0)
    expect(db.get<{ category_id: string | null }>('SELECT category_id FROM transactions WHERE id = ?', t)!.category_id).toBeNull()
  })
})

// sha256 of each statement as it was before photo uploads (a989a83)
const EMAIL_SQL_HASHES: Record<string, string> = {
  APPLIED_SIBLINGS_SQL: '8e77e20354db9dfce76ad4b549dc965e4f3405dc9748f998beb4122e0571442e',
  KNOWN_IDS_SQL: '27e087b7c3af844e81f2a28ea875702708553261c94e678a183682a840058aad',
  OPEN_RECEIPTS_SQL: '47021f41ec73dfc8f19da7ba159cc16d5a460da6a01e6f447fd21907194a1b11',
  RETRY_SQL: '39ada5646fbb66cc52f7db0d9c9890e5557639d2d6cade505fe9ec074090c782',
  STALE_DISMISS_SQL: 'e487c9925446d6a3ed3f31f53e73d2f244c1a6bb52c39bc3448a52b81848deda',
  STALE_SUPERSEDE_SQL: '938669d0ffb5be968d3da22c5b78a2c18fb864f0cc7d9a8ced10765e022faa5a',
}
