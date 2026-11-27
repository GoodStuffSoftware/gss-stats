// migrations/gss-budget/0004_receipts.sql against a real SQLite (node:sqlite, D1's dialect), made-up values only.
// Covers: every CHECK, the foreign keys and their cascades (foreign keys are ON, as in D1), the partial unique index
// that allows one applied match per bank row, that 0004 is purely additive over a database that already holds rows,
// the rollback batch (read from the file's own comment block), and applying it again from scratch.
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { createBudgetDb, insertTxn, syntheticSeedSql, type FakeBudgetDb } from './testing/budgetDb'
import { withoutBankGuard } from '../../src/lib/budget/__fixtures__/synthetic'

const M1 = readFileSync('migrations/gss-budget/0001_init.sql', 'utf8')
const M2 = readFileSync('migrations/gss-budget/0002_loans.sql', 'utf8')
const M3 = readFileSync('migrations/gss-budget/0003_included.sql', 'utf8')
const M4 = readFileSync('migrations/gss-budget/0004_receipts.sql', 'utf8')
const NOW = '2026-12-05T10:00:00.000Z'

const NEW_TABLES = ['email_connections', 'receipt_queries', 'receipts', 'receipt_items', 'receipt_matches', 'receipt_sync_runs']
const NEW_INDEXES = ['idx_rcpt_review', 'idx_rcpt_open', 'idx_rcpt_order', 'idx_rcpt_retry', 'idx_match_txn', 'idx_match_applied', 'idx_runs_conn']
const NEW_TRIGGERS = ['trg_match_applied_gone']

type Row = Record<string, unknown>
let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })

const CONN = 'c0123456789abcdef'
const CONN2 = 'cfedcba9876543210'

/** Inserts a row built from defaults plus overrides (a key set to undefined is left out). */
function put(d: { sqlite: DatabaseSync }, table: string, defaults: Row, over: Row = {}): void {
  const row = { ...defaults, ...over }
  const keys = Object.keys(row).filter((k) => row[k] !== undefined)
  d.sqlite.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k] as string | number | null))
}

const connDefaults = (id = CONN, email = 'user-a@example.com'): Row => ({
  id, owner_email: email, google_sub: '1234567890', status: 'active', token_ct: 'Y2lwaGVydGV4dA==', token_iv: 'aXZpdml2aXZpaQ==', key_id: '0a1b2c3d',
  scopes: 'gmail.readonly', consent_version: 1, consented_at: NOW, created_at: NOW, updated_at: NOW,
})
const conn = (over: Row = {}, id = CONN, email = 'user-a@example.com'): void => put(db, 'email_connections', connDefaults(id, email), over)

const rcptDefaults = (id = 'r0123456789abcdef', connection = CONN, msg = '18c3f2a9b7d4e610'): Row => ({
  id, connection_id: connection, gmail_msg_id: msg, email_date: '2026-11-10', status: 'pending', created_at: NOW, updated_at: NOW, updated_by: 'script:receipts',
})
const rcpt = (over: Row = {}, id = 'r0123456789abcdef', connection = CONN, msg = '18c3f2a9b7d4e610'): void => put(db, 'receipts', rcptDefaults(id, connection, msg), over)

const matchDefaults = (receipt: string, txn: string): Row => ({
  receipt_id: receipt, txn_id: txn, group_key: 'g1', rule: 'exact', share_cents: 500, score: 90, status: 'suggested', txn_updated_at: NOW, created_at: NOW,
})
const match = (receipt: string, txn: string, over: Row = {}): void => put(db, 'receipt_matches', matchDefaults(receipt, txn), over)

const runDefaults = (connection = CONN): Row => ({ connection_id: connection, run_trigger: 'cron', started_at: NOW })

const count = (d: { sqlite: DatabaseSync }, table: string): number => (d.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const firstTxn = (): string => (db.get<{ id: string }>('SELECT id FROM transactions ORDER BY id LIMIT 1') as { id: string }).id

/** Asserts the statement fails with a constraint error of the given kind (CHECK, UNIQUE, FOREIGN KEY, NOT NULL). */
function rejects(fn: () => void, kind: 'CHECK' | 'UNIQUE' | 'FOREIGN KEY' | 'NOT NULL' = 'CHECK'): void {
  let msg = ''
  try { fn() } catch (e) { msg = String((e as Error).message) }
  expect(msg, 'the statement should have been rejected').not.toBe('')
  expect(msg).toContain(`${kind} constraint failed`)
}

describe('foreign keys', () => {
  it('are enforced by the test database, as D1 does', () => {
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1)
    rejects(() => rcpt({}, 'r0123456789abcdef', 'c00000000000000ff'), 'FOREIGN KEY')
    rejects(() => conn({ person_id: 'nobody' }), 'FOREIGN KEY')
    conn({ person_id: 'pa' })
  })
})

describe('email_connections', () => {
  it('accepts a complete active row and a paused one', () => {
    conn()
    conn({ status: 'paused' }, CONN2, 'user-b@example.com')
    expect(count(db, 'email_connections')).toBe(2)
  })

  it('rejects bad ids: wrong prefix, wrong length, non-hex characters, uppercase', () => {
    for (const id of ['x0123456789abcdef', 'c0123456789abcde', 'c0123456789abcdef0', 'c0123456789abcdeg', 'c0123456789ABCDEF', 'c0123456789abc-ef', '']) {
      rejects(() => conn({}, id))
    }
  })

  it('rejects an owner_email that is not lower case, has no usable @, or is too long', () => {
    for (const e of ['User-A@example.com', 'nobody', '@example.com', `${'a'.repeat(250)}@example.com`, 'a@']) rejects(() => conn({}, CONN, e))
  })

  it('google_email is NULL or a lower-case address with a usable @ and at most 254 characters', () => {
    conn({ google_email: null })
    conn({ google_email: 'a@example.com' }, CONN2, 'user-b@example.com')
    expect(count(db, 'email_connections')).toBe(2)
    for (const e of ['A@example.com', '@example.com', 'a@', 'nobody', `${'a'.repeat(250)}@example.com`]) {
      rejects(() => conn({ google_email: e }, 'c1111111111111111', 'user-c@example.com'))
    }
  })

  it('rejects a second connection for the same owner_email', () => {
    conn()
    rejects(() => conn({}, CONN2), 'UNIQUE')
  })

  it('bounds google_sub, status, consent_version, scopes and the token field shapes', () => {
    rejects(() => conn({ google_sub: '' }))
    rejects(() => conn({ google_sub: 'x'.repeat(256) }))
    conn({ google_sub: 'x'.repeat(255) }, CONN, 'long-sub@example.com')
    rejects(() => conn({ status: 'gone' }, CONN2, 'u2@example.com'))
    rejects(() => conn({ consent_version: 0 }, CONN2, 'u2@example.com'))
    rejects(() => conn({ scopes: 'x'.repeat(513) }, CONN2, 'u2@example.com'))
    rejects(() => conn({ token_iv: 'short' }, CONN2, 'u2@example.com'))
    rejects(() => conn({ token_ct: '' }, CONN2, 'u2@example.com'))
    rejects(() => conn({ scopes: '' }, CONN2, 'u2@example.com'))
    // base64 only: a plaintext refresh token (with - or _) cannot be written into either column
    rejects(() => conn({ token_ct: '1//0gFakeRefresh-Token_xyz' }, CONN2, 'u2@example.com'))
    rejects(() => conn({ token_iv: 'aXZpdml2aXZpa-==' }, CONN2, 'u2@example.com'))
    rejects(() => conn({ token_ct: 'x'.repeat(2049) }, CONN2, 'u2@example.com'))
    rejects(() => conn({ key_id: '0a1b2c3' }, CONN2, 'u2@example.com'))
    rejects(() => conn({ key_id: '0A1B2C3D' }, CONN2, 'u2@example.com'))
    rejects(() => conn({ key_id: '0a1b2c3z' }, CONN2, 'u2@example.com'))
    rejects(() => conn({ google_sub: undefined }, CONN2, 'u2@example.com'), 'NOT NULL')
  })

  it('pairs status with token material: active and paused hold all three, needs_reconnect and revoked hold none', () => {
    for (const status of ['active', 'paused']) {
      rejects(() => conn({ status, token_ct: null }, CONN2, `${status}1@example.com`))
      rejects(() => conn({ status, token_iv: null }, CONN2, `${status}2@example.com`))
      rejects(() => conn({ status, key_id: null }, CONN2, `${status}3@example.com`))
    }
    const none = { token_ct: null, token_iv: null, key_id: null }
    conn({ status: 'needs_reconnect', ...none }, CONN, 'a@example.com')
    conn({ status: 'revoked', ...none }, CONN2, 'b@example.com')
    for (const status of ['needs_reconnect', 'revoked']) {
      rejects(() => conn({ status, ...none, token_ct: 'Y2lwaGVy' }, 'c1111111111111111', `${status}1@example.com`))
      rejects(() => conn({ status, ...none, token_iv: 'aXZpdml2aXZpaQ==' }, 'c2222222222222222', `${status}2@example.com`))
      rejects(() => conn({ status, ...none, key_id: '0a1b2c3d' }, 'c3333333333333333', `${status}3@example.com`))
    }
    // a live connection cannot be flipped to unusable without clearing the token, and back without restoring it
    conn({}, 'c4444444444444444', 'live@example.com')
    rejects(() => db.sqlite.exec("UPDATE email_connections SET status = 'revoked' WHERE id = 'c4444444444444444'"))
    db.sqlite.exec("UPDATE email_connections SET status = 'revoked', token_ct = NULL, token_iv = NULL, key_id = NULL WHERE id = 'c4444444444444444'")
    rejects(() => db.sqlite.exec("UPDATE email_connections SET status = 'active' WHERE id = 'c4444444444444444'"))
  })

  it('keeps last_error to a short lower-case code', () => {
    for (const e of ['Bad Text', 'Upper', '9digit', 'has space', 'x'.repeat(41), '']) rejects(() => conn({ last_error: e }))
    conn({ last_error: 'token_revoked' })
  })
})

describe('receipt_queries', () => {
  it('is seeded with ten generic subject keywords and no merchant names', () => {
    const rows = db.all<{ kind: string; value: string; active: number }>('SELECT kind, value, active FROM receipt_queries ORDER BY id')
    expect(rows).toHaveLength(10)
    expect(rows.every((r) => r.kind === 'subject' && r.active === 1)).toBe(true)
    expect(rows.map((r) => r.value)).toEqual([
      'receipt', 'order confirmation', 'your order', 'invoice', 'payment received', 'you paid', 'you sent', 'refund', 'has shipped', 'payment declined',
    ])
  })

  it('checks kind, value shape, active and uniqueness', () => {
    const q = (o: Row): void => put(db, 'receipt_queries', { kind: 'from', value: 'shop.example.com', active: 1 }, o)
    q({})
    rejects(() => q({}), 'UNIQUE')
    q({ kind: 'exclude_from' })
    rejects(() => q({ kind: 'body', value: 'x' }))
    rejects(() => q({ value: '' }))
    rejects(() => q({ value: 'x'.repeat(101) }))
    for (const v of ['a(b', 'a)b', 'a{b', 'a}b', 'a"b']) rejects(() => q({ value: v }))
    rejects(() => q({ value: 'ok', active: 2 }))
  })
})

describe('receipts', () => {
  beforeEach(() => conn())

  it('accepts a fully filled row and a bare pending row', () => {
    rcpt({}, 'r0000000000000001', CONN, '18c3f2a9b7d4e611')
    rcpt({
      status: 'unmatched', attempts: 1, error_code: 'extract_invalid', kind: 'purchase', sender_domain: 'shop.example.com', merchant: 'Test Shop',
      payment_via: 'card', card_last4: '0042', order_ref: '114-1234567-7654321', receipt_date: '2026-11-09', related_date: '2026-11-01', currency: 'USD',
      total_cents: 1999, tax_cents: 150, shipping_cents: 0, charges_json: '[{"cents":1000},{"cents":999}]', extract_model: 'test-model',
    })
    expect(count(db, 'receipts')).toBe(2)
  })

  it('rejects bad ids: wrong prefix or length, non-hex, uppercase', () => {
    for (const id of ['c0123456789abcdef', 'r0123456789abcde', 'r0123456789abcdef0', 'r0123456789abcdeg', 'r0123456789ABCDEF', '']) rejects(() => rcpt({}, id))
  })

  it('requires gmail_msg_id to be 8 to 32 lower-case hex characters', () => {
    for (const m of ['', '18c3f2a', '18c3f2a9b7d4e61g', '18C3F2A9B7D4E610', '18c3f2a9 b7d4e610', `${'a'.repeat(33)}`]) rejects(() => rcpt({}, 'r0000000000000002', CONN, m))
    rcpt({}, 'r0000000000000002', CONN, 'a'.repeat(8))
    rcpt({}, 'r0000000000000003', CONN, 'a'.repeat(32))
  })

  it('dedupes on (connection, gmail_msg_id) but allows the same message id on another connection', () => {
    conn({}, CONN2, 'user-b@example.com')
    rcpt()
    rejects(() => rcpt({}, 'r0000000000000009'), 'UNIQUE')
    rcpt({}, 'r0000000000000009', CONN2)
    expect(count(db, 'receipts')).toBe(2)
  })

  it('requires real calendar dates in email_date, receipt_date and related_date', () => {
    for (const col of ['email_date', 'receipt_date', 'related_date']) {
      for (const d of ['2026-02-30', '2026-19-01', '2026-1-1', '2026-11-10T00:00', '20261110', '', '2026-04-31']) rejects(() => rcpt({ [col]: d }, 'r0000000000000004', CONN, '18c3f2a9b7d4e620'))
      rcpt({ [col]: '2028-02-29' }, 'r0000000000000004', CONN, '18c3f2a9b7d4e620')
      db.sqlite.exec('DELETE FROM receipts')
    }
    rejects(() => rcpt({ email_date: undefined }), 'NOT NULL')
  })

  it('limits status, attempts, error_code, kind and payment_via to their sets', () => {
    rejects(() => rcpt({ status: 'done' }))
    ;['pending', 'skipped', 'error', 'no_total', 'unmatched', 'suggested', 'applied', 'dismissed'].forEach((s, i) => {
      const n = (i + 1).toString(16).padStart(16, '0')
      rcpt({ status: s }, `r${n}`, CONN, n)
    })
    expect(count(db, 'receipts')).toBe(8)
    rejects(() => rcpt({ attempts: 10 }))
    rejects(() => rcpt({ attempts: -1 }))
    for (const e of ['Bad', '1x', 'has space', 'x'.repeat(41), '']) rejects(() => rcpt({ error_code: e }))
    rejects(() => rcpt({ kind: 'gift' }))
    rejects(() => rcpt({ payment_via: 'cash' }))
  })

  it('checks card_last4, currency, amounts and text lengths', () => {
    for (const v of ['123', '12345', '12a4', '    ', '']) rejects(() => rcpt({ card_last4: v }))
    for (const v of ['usd', 'US', 'USDX', 'U$D', '']) rejects(() => rcpt({ currency: v }))
    rejects(() => rcpt({ total_cents: -1 }))
    for (const c of ['total_cents', 'tax_cents', 'shipping_cents']) rejects(() => rcpt({ [c]: 12.5 }))
    rejects(() => rcpt({ total_cents: 100000001 }))
    rejects(() => rcpt({ tax_cents: -1 }))
    rejects(() => rcpt({ tax_cents: 100000001 }))
    rejects(() => rcpt({ shipping_cents: -5 }))
    rejects(() => rcpt({ sender_domain: 'x'.repeat(81) }))
    rejects(() => rcpt({ merchant: 'x'.repeat(81) }))
    rejects(() => rcpt({ extract_model: 'x'.repeat(65) }))
    rcpt({ total_cents: 0, tax_cents: 0, shipping_cents: 0, merchant: 'x'.repeat(80), extract_model: 'x'.repeat(64) })
  })

  it('limits order_ref to letters, digits, # and -, 1 to 64 characters', () => {
    for (const v of ['', 'has space', 'a/b', 'a.b', 'a_b', 'a#b!', 'x'.repeat(65), "o'rder", 'ord\ner']) rejects(() => rcpt({ order_ref: v }))
    rcpt({ order_ref: '114-1234567-7654321' }, 'r0000000000000005', CONN, '18c3f2a9b7d4e630')
    rcpt({ order_ref: '#AB-12cd' }, 'r0000000000000006', CONN, '18c3f2a9b7d4e631')
    rcpt({ order_ref: 'x'.repeat(64) }, 'r0000000000000007', CONN, '18c3f2a9b7d4e632')
  })

  it('requires charges_json to be a valid JSON array of at most 400 characters', () => {
    // json_valid works inside a CHECK (and json_type never runs on text that is not JSON)
    for (const v of ['not json', '{"a":1}', '"text"', '12', 'null', '[1,', '', '[1] [2]']) rejects(() => rcpt({ charges_json: v }), 'CHECK')
    rejects(() => rcpt({ charges_json: `[${'1,'.repeat(200)}1]` }))
    rcpt({ charges_json: '[]' }, 'r0000000000000008', CONN, '18c3f2a9b7d4e640')
    rcpt({ charges_json: '[{"cents":1000}]' }, 'r000000000000000a', CONN, '18c3f2a9b7d4e641')
  })

  it('requires updated_by and created_at', () => {
    rejects(() => rcpt({ updated_by: undefined }), 'NOT NULL')
    rejects(() => rcpt({ created_at: undefined }), 'NOT NULL')
  })

  it('serves the review list, the open window and the retry sweep from their indexes', () => {
    const plan = (sql: string, ...v: unknown[]): string => db.explain(sql, v).join(' | ')
    expect(plan('SELECT id FROM receipts WHERE connection_id = ? AND status = ? ORDER BY email_date DESC, id DESC LIMIT 20', CONN, 'suggested')).toContain('idx_rcpt_review')
    // the keyset page reads the index backward: no temp b-tree sort
    const keyset = plan('SELECT id FROM receipts WHERE connection_id = ? AND status = ? AND (email_date, id) < (?, ?) ORDER BY email_date DESC, id DESC LIMIT 21', CONN, 'suggested', '2026-11-10', 'r9')
    expect(keyset).toContain('idx_rcpt_review')
    expect(keyset).not.toContain('TEMP B-TREE')
    // the open window uses the coalesce expression, so a NULL receipt_date still falls inside it
    expect(plan(`SELECT id FROM receipts WHERE connection_id = ? AND status IN ('unmatched','suggested') AND coalesce(receipt_date, email_date) >= ?`, CONN, '2026-11-01')).toContain('idx_rcpt_open')
    expect(plan('SELECT id FROM receipts WHERE connection_id = ? AND order_ref = ?', CONN, '112-1234567-1234567')).toContain('idx_rcpt_order')
    expect(plan(`SELECT id FROM receipts WHERE connection_id = ? AND status IN ('pending','error') AND attempts < 3`, CONN)).toContain('idx_rcpt_retry')
    expect(plan('SELECT id FROM receipts WHERE connection_id = ? AND gmail_msg_id = ?', CONN, 'abcdef01')).toContain('USING INDEX')
  })
})

describe('receipt_items', () => {
  beforeEach(() => { conn(); rcpt() })
  const item = (over: Row = {}): void => put(db, 'receipt_items', { receipt_id: 'r0123456789abcdef', seq: 1, description: 'Widget', amount_cents: 500, quantity: 1 }, over)

  it('accepts line items and enforces the primary key (receipt, seq)', () => {
    item()
    item({ seq: 2, amount_cents: null, quantity: null })
    item({ seq: 3, amount_cents: -250 })
    rejects(() => item(), 'UNIQUE')
  })

  it('checks seq, description, amount, quantity and the parent', () => {
    rejects(() => item({ seq: 0 }))
    rejects(() => item({ seq: 21 }))
    rejects(() => item({ description: '' }))
    rejects(() => item({ description: 'x'.repeat(121) }))
    rejects(() => item({ amount_cents: 100000001 }))
    rejects(() => item({ quantity: 0 }))
    rejects(() => item({ amount_cents: 12.5 }))
    rejects(() => item({ quantity: 1.5 }))
    rejects(() => item({ quantity: 1000 }))
    rejects(() => item({ receipt_id: 'r0000000000000fff' }), 'FOREIGN KEY')
    rejects(() => item({ category_hint: 'no-such-category' }), 'FOREIGN KEY')
    item({ seq: 20, category_hint: 'groceries', description: 'x'.repeat(120) })
  })
})

describe('receipt_matches', () => {
  let t1: string
  let t2: string
  beforeEach(() => {
    conn()
    rcpt({}, 'r0000000000000001', CONN, '18c3f2a9b7d4e601')
    rcpt({}, 'r0000000000000002', CONN, '18c3f2a9b7d4e602')
    t1 = firstTxn()
    t2 = insertTxn(db)
  })

  it('accepts a proposal and checks rule, status, score, share, group_key and the parents', () => {
    match('r0000000000000001', t1)
    rejects(() => match('r0000000000000001', t1, { group_key: 'other' }), 'UNIQUE')
    rejects(() => match('r0000000000000001', t2, { rule: 'guess' }))
    rejects(() => match('r0000000000000001', t2, { status: 'maybe' }))
    rejects(() => match('r0000000000000001', t2, { score: 101 }))
    rejects(() => match('r0000000000000001', t2, { score: -1 }))
    rejects(() => match('r0000000000000001', t2, { score: 50.5 }))
    rejects(() => match('r0000000000000001', t2, { share_cents: 5.5 }))
    rejects(() => match('r0000000000000001', t2, { share_cents: 100000001 }))
    rejects(() => match('r0000000000000001', t2, { group_key: '' }))
    rejects(() => match('r0000000000000001', t2, { group_key: 'x'.repeat(41) }))
    rejects(() => match('r0000000000000001', t2, { txn_updated_at: undefined }), 'NOT NULL')
    rejects(() => match('r0000000000000fff', t2), 'FOREIGN KEY')
    rejects(() => match('r0000000000000001', testTxnLike()), 'FOREIGN KEY')
    rejects(() => match('r0000000000000001', t2, { proposed_category_id: 'no-such-category' }), 'FOREIGN KEY')
    match('r0000000000000001', t2, { rule: 'split_charges', share_cents: -500, proposed_category_id: 'groceries', decided_at: NOW, decided_by: 'user-a@example.com' })
  })

  it('allows one applied match per bank row (partial unique index), but any number of other statuses', () => {
    match('r0000000000000001', t1, { status: 'applied' })
    // a second receipt cannot also be applied to the same bank row
    rejects(() => match('r0000000000000002', t1, { status: 'applied' }), 'UNIQUE')
    // suggestions, rejections and superseded rows may share it, even next to the applied one
    match('r0000000000000002', t1, { status: 'suggested' })
    db.sqlite.exec(`DELETE FROM receipt_matches WHERE receipt_id = 'r0000000000000002'`)
    match('r0000000000000002', t1, { status: 'rejected' })
    // promoting one to applied is refused while another is applied, and allowed once that one is superseded
    rejects(() => db.sqlite.exec(`UPDATE receipt_matches SET status = 'applied' WHERE receipt_id = 'r0000000000000002'`), 'UNIQUE')
    db.sqlite.exec(`UPDATE receipt_matches SET status = 'superseded' WHERE receipt_id = 'r0000000000000001'`)
    db.sqlite.exec(`UPDATE receipt_matches SET status = 'applied' WHERE receipt_id = 'r0000000000000002'`)
    // one receipt may be applied to several rows (one order, several charges)
    match('r0000000000000002', t2, { status: 'applied', rule: 'split_charges' })
    expect(count(db, 'receipt_matches')).toBe(3)
  })

  it('looks up by receipt, and by bank row through indexes', () => {
    const plan = (sql: string, ...v: unknown[]): string => db.explain(sql, v).join(' | ')
    expect(plan('SELECT * FROM receipt_matches WHERE receipt_id = ? AND status = ?', 'r0000000000000001', 'suggested')).toContain('sqlite_autoindex_receipt_matches_1 (receipt_id=?)')
    expect(plan('SELECT * FROM receipt_matches WHERE txn_id = ? AND status = ?', t1, 'suggested')).toContain('idx_match_txn')
    // the planner may pick idx_match_txn or the partial idx_match_applied for this query; both are a keyed lookup on txn_id (never a scan)
    expect(plan(`SELECT receipt_id FROM receipt_matches WHERE txn_id IN (SELECT value FROM json_each(?)) AND status = 'applied'`, JSON.stringify([t1, t2]))).toMatch(/SEARCH receipt_matches USING INDEX idx_match_(txn|applied) \(txn_id=\?/)
  })
})

/** A syntactically fine transaction id that is not in the table. */
const testTxnLike = (): string => 'f'.repeat(32)

describe('receipt_sync_runs', () => {
  beforeEach(() => conn())
  const run = (over: Row = {}): void => put(db, 'receipt_sync_runs', runDefaults(), over)

  it('accepts a run and checks run_trigger, counters, error_code and the parent', () => {
    run()
    run({ run_trigger: 'backfill', finished_at: NOW, listed: 40, fetched: 12, extracted: 9, skipped: 3, matched: 4, auto_applied: 0, model_in_tokens: 5000, model_out_tokens: 800, error_code: 'gmail_429' })
    rejects(() => run({ run_trigger: 'hand' }))
    for (const col of ['listed', 'fetched', 'extracted', 'skipped', 'matched', 'auto_applied', 'model_in_tokens', 'model_out_tokens']) rejects(() => run({ [col]: -1 }))
    rejects(() => run({ error_code: 'Bad Code' }))
    rejects(() => run({ connection_id: 'c0000000000000fff' }), 'FOREIGN KEY')
    rejects(() => run({ started_at: undefined }), 'NOT NULL')
    expect(count(db, 'receipt_sync_runs')).toBe(2)
  })

  it('reads the newest runs of a connection from idx_runs_conn', () => {
    const plan = db.explain('SELECT * FROM receipt_sync_runs WHERE connection_id = ? ORDER BY id DESC LIMIT 200', [CONN]).join(' | ')
    expect(plan).toContain('idx_runs_conn')
    expect(plan).not.toContain('TEMP B-TREE')
  })
})

describe('foreign key cascades', () => {
  /** Two connections, each with a receipt, an item, a match and a run; a third receipt on the first for the txn case. */
  function populate(): { t1: string; t2: string } {
    conn()
    conn({}, CONN2, 'user-b@example.com')
    const t1 = firstTxn()
    const t2 = insertTxn(db)
    rcpt({}, 'r0000000000000001', CONN, '18c3f2a9b7d4e601')
    rcpt({}, 'r0000000000000002', CONN2, '18c3f2a9b7d4e602')
    put(db, 'receipt_items', { receipt_id: 'r0000000000000001', seq: 1, description: 'Widget', category_hint: 'groceries' })
    put(db, 'receipt_items', { receipt_id: 'r0000000000000002', seq: 1, description: 'Gadget' })
    match('r0000000000000001', t1, { proposed_category_id: 'groceries' })
    match('r0000000000000002', t2)
    put(db, 'receipt_sync_runs', runDefaults(CONN))
    put(db, 'receipt_sync_runs', runDefaults(CONN2))
    return { t1, t2 }
  }
  const counts = (): Record<string, number> => Object.fromEntries(NEW_TABLES.map((t) => [t, count(db, t)]))

  it('a deleted connection removes its receipts, items, matches and runs, and nothing of the other connection', () => {
    populate()
    const tx = count(db, 'transactions')
    db.sqlite.exec(`DELETE FROM email_connections WHERE id = '${CONN}'`)
    expect(counts()).toMatchObject({ email_connections: 1, receipts: 1, receipt_items: 1, receipt_matches: 1, receipt_sync_runs: 1 })
    expect(db.get('SELECT 1 AS x FROM receipts WHERE connection_id = ?', CONN)).toBeUndefined()
    expect(db.get('SELECT 1 AS x FROM receipt_items WHERE receipt_id = ?', 'r0000000000000001')).toBeUndefined()
    expect(db.get('SELECT 1 AS x FROM receipt_matches WHERE receipt_id = ?', 'r0000000000000001')).toBeUndefined()
    expect(db.get('SELECT 1 AS x FROM receipt_sync_runs WHERE connection_id = ?', CONN)).toBeUndefined()
    expect(count(db, 'transactions')).toBe(tx)
  })

  it('a deleted transaction removes its matches but leaves the receipt and its items', () => {
    const { t2 } = populate()
    db.sqlite.prepare('DELETE FROM transactions WHERE id = ?').run(t2)
    expect(db.get('SELECT 1 AS x FROM receipt_matches WHERE receipt_id = ?', 'r0000000000000002')).toBeUndefined()
    expect(count(db, 'receipt_matches')).toBe(1)
    expect(count(db, 'receipts')).toBe(2)
    expect(count(db, 'receipt_items')).toBe(2)
  })

  it('a deleted transaction resets a receipt whose applied match it took, and only that one', () => {
    const { t1, t2 } = populate()
    db.sqlite.exec(`UPDATE receipt_matches SET status = 'applied'`)
    db.sqlite.exec(`UPDATE receipts SET status = 'applied'`)
    db.sqlite.prepare('DELETE FROM transactions WHERE id = ?').run(t2)
    expect(db.get('SELECT status, updated_by FROM receipts WHERE id = ?', 'r0000000000000002')).toEqual({ status: 'unmatched', updated_by: 'db:match_deleted' })
    expect(db.get('SELECT status FROM receipts WHERE id = ?', 'r0000000000000001')).toEqual({ status: 'applied' })
    expect(t1).not.toBe(t2)
  })

  it('a receipt with another applied match stays applied when one of its rows goes; a suggested match changes nothing', () => {
    const { t1 } = populate()
    const t3 = insertTxn(db)
    db.sqlite.exec(`UPDATE receipt_matches SET status = 'applied' WHERE receipt_id = 'r0000000000000001'`)
    db.sqlite.exec(`UPDATE receipts SET status = 'applied' WHERE id = 'r0000000000000001'`)
    match('r0000000000000001', t3, { status: 'applied', rule: 'split_charges' })
    db.sqlite.prepare('DELETE FROM transactions WHERE id = ?').run(t3)
    expect(db.get('SELECT status FROM receipts WHERE id = ?', 'r0000000000000001')).toEqual({ status: 'applied' })
    db.sqlite.exec(`UPDATE receipt_matches SET status = 'suggested' WHERE receipt_id = 'r0000000000000001'`)
    db.sqlite.prepare('DELETE FROM transactions WHERE id = ?').run(t1)
    expect(db.get('SELECT status FROM receipts WHERE id = ?', 'r0000000000000001')).toEqual({ status: 'applied' })
  })

  it('a deleted receipt removes its items and matches only', () => {
    populate()
    db.sqlite.exec(`DELETE FROM receipts WHERE id = 'r0000000000000001'`)
    expect(counts()).toMatchObject({ email_connections: 2, receipts: 1, receipt_items: 1, receipt_matches: 1, receipt_sync_runs: 2 })
  })

  it('a deleted category clears the hint and the proposal instead of blocking or cascading', () => {
    populate()
    db.sqlite.exec(`INSERT INTO categories (id, label, sort) VALUES ('u-test', 'Test', 5000)`)
    db.sqlite.exec(`UPDATE receipt_items SET category_hint = 'u-test' WHERE receipt_id = 'r0000000000000001'`)
    db.sqlite.exec(`UPDATE receipt_matches SET proposed_category_id = 'u-test' WHERE receipt_id = 'r0000000000000001'`)
    db.sqlite.exec(`DELETE FROM categories WHERE id = 'u-test'`)
    expect(db.get('SELECT category_hint AS h FROM receipt_items WHERE receipt_id = ?', 'r0000000000000001')).toEqual({ h: null })
    expect(db.get('SELECT proposed_category_id AS p FROM receipt_matches WHERE receipt_id = ?', 'r0000000000000001')).toEqual({ p: null })
    expect(count(db, 'receipt_items')).toBe(2)
  })

  it('a person cannot be deleted while a connection names them', () => {
    conn({ person_id: 'pa' })
    rejects(() => db.sqlite.exec(`DELETE FROM people WHERE id = 'pa'`), 'FOREIGN KEY')
  })
})

describe('0004 over an existing database', () => {
  const objects = (d: DatabaseSync): Row[] =>
    d.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as Row[]
  const dump = (d: DatabaseSync, tables: string[]): Record<string, unknown[]> =>
    Object.fromEntries(tables.map((t) => [t, d.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]))

  async function upTo3(): Promise<DatabaseSync> {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    d.exec(M1); d.exec(M2); d.exec(M3)
    d.exec(withoutBankGuard(await syntheticSeedSql()))
    return d
  }

  it('is additive: it adds exactly the six tables, seven indexes and one trigger and changes no existing object or row', async () => {
    const d = await upTo3()
    const before = objects(d)
    const beforeNames = new Set(before.map((o) => o.name))
    const tables = before.filter((o) => o.type === 'table').map((o) => String(o.name))
    const rows = dump(d, tables)
    d.exec(M4)
    const after = objects(d)
    expect(after.filter((o) => beforeNames.has(o.name as string))).toEqual(before)
    const added = after.filter((o) => !beforeNames.has(o.name as string))
    expect(added.filter((o) => o.type === 'table').map((o) => o.name).sort()).toEqual([...NEW_TABLES].sort())
    expect(added.filter((o) => o.type === 'index').map((o) => o.name).sort()).toEqual([...NEW_INDEXES].sort())
    expect(added.filter((o) => o.type === 'trigger').map((o) => o.name).sort()).toEqual([...NEW_TRIGGERS].sort())
    expect(added.filter((o) => o.type === 'index' || o.type === 'trigger').every((o) => NEW_TABLES.includes(o.tbl_name as string))).toBe(true)
    expect(added).toHaveLength(NEW_TABLES.length + NEW_INDEXES.length + NEW_TRIGGERS.length)
    expect(dump(d, tables)).toEqual(rows)
  })

  it('names no private data: no addresses or merchant names in the file outside comments', () => {
    const code = M4.replace(/--.*$/gm, '')
    expect(code).not.toMatch(/@[a-z0-9-]+\./i)
    expect(code).not.toMatch(/\b(walmart|target|costco|netflix|spotify|uber|doordash)\b/i)
  })
})

describe('rollback and re-apply', () => {
  /** The rollback statements, taken from the migration's own comment block so the two cannot drift apart. */
  function rollbackStatements(): string[] {
    const lines = M4.split('\n')
    const start = lines.findIndex((l) => l.startsWith('-- ROLLBACK'))
    expect(start).toBeGreaterThan(0)
    const stmts = lines.slice(start).filter((l) => /^--\s+(DROP|DELETE) /.test(l)).map((l) => l.replace(/^--\s+/, '').trim())
    expect(stmts.length).toBeGreaterThan(0)
    return stmts
  }

  const dropped = (d: DatabaseSync): string[] =>
    (d.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'receipt%' OR name LIKE 'email_%' OR name LIKE 'idx_rcpt%' OR name LIKE 'idx_match%' OR name LIKE 'idx_runs%' OR name LIKE 'trg_match%'`).all() as { name: string }[]).map((r) => r.name)

  it('drops exactly the six tables (their indexes and the trigger go with them), in an order the foreign keys allow, as one batch, and un-records the migration', async () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    d.exec(M1); d.exec(M2); d.exec(M3)
    d.exec(withoutBankGuard(await syntheticSeedSql()))
    const base = d.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all()
    const tx = (d.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n
    d.exec(M4)
    d.exec(`CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
    d.exec(`INSERT INTO d1_migrations (name) VALUES ('0003_included.sql'), ('0004_receipts.sql')`)
    // populate every new table so each DROP meets real rows and live foreign keys
    const txn = (d.prepare('SELECT id FROM transactions LIMIT 1').get() as { id: string }).id
    d.exec(`INSERT INTO email_connections (id, owner_email, google_sub, status, token_ct, token_iv, key_id, scopes, consent_version, consented_at, created_at, updated_at)
            VALUES ('${CONN}', 'user-a@example.com', '1', 'active', 'Y2lwaGVy', 'aXZpdml2aXZpaQ==', '0a1b2c3d', 'gmail.readonly', 1, '${NOW}', '${NOW}', '${NOW}')`)
    d.exec(`INSERT INTO receipts (id, connection_id, gmail_msg_id, email_date, status, created_at, updated_at, updated_by) VALUES ('r0000000000000001', '${CONN}', '18c3f2a9b7d4e601', '2026-11-10', 'applied', '${NOW}', '${NOW}', 'x')`)
    d.exec(`INSERT INTO receipt_items (receipt_id, seq, description) VALUES ('r0000000000000001', 1, 'Widget')`)
    d.exec(`INSERT INTO receipt_matches (receipt_id, txn_id, group_key, rule, share_cents, score, status, txn_updated_at, created_at) VALUES ('r0000000000000001', '${txn}', 'g', 'exact', 1, 1, 'applied', '${NOW}', '${NOW}')`)
    d.exec(`INSERT INTO receipt_sync_runs (connection_id, run_trigger, started_at) VALUES ('${CONN}', 'cron', '${NOW}')`)
    expect(dropped(d).length).toBe(NEW_TABLES.length + NEW_INDEXES.length + NEW_TRIGGERS.length)

    const stmts = rollbackStatements()
    expect(stmts.filter((s) => s.startsWith('DROP TABLE')).map((s) => s.replace(/^DROP TABLE |;$/g, ''))).toEqual(
      ['receipt_sync_runs', 'receipt_matches', 'receipt_items', 'receipts', 'receipt_queries', 'email_connections'],
    )
    expect(stmts.at(-1)).toContain(`DELETE FROM d1_migrations WHERE name = '0004_receipts.sql'`)
    d.exec(`BEGIN;\n${stmts.join('\n')}\nCOMMIT;`)

    expect(dropped(d)).toEqual([])
    expect(d.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY type, name`).all()).toEqual(base)
    expect((d.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(tx)
    expect(d.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).toEqual([{ name: '0003_included.sql' }])
    expect(d.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('applies again from scratch after a rollback, with the seed back and every constraint live', async () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    d.exec(M1); d.exec(M2); d.exec(M3)
    d.exec(M4)
    d.exec(`CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE)`)
    d.exec(`INSERT INTO d1_migrations (name) VALUES ('0004_receipts.sql')`)
    d.exec(`BEGIN;\n${rollbackStatements().join('\n')}\nCOMMIT;`)
    expect(dropped(d)).toEqual([])
    d.exec(M4)
    expect(dropped(d).filter((n) => NEW_TABLES.includes(n))).toHaveLength(NEW_TABLES.length)
    expect((d.prepare('SELECT COUNT(*) AS n FROM receipt_queries').get() as { n: number }).n).toBe(10)
    expect(() => d.exec(`INSERT INTO email_connections (id, owner_email, google_sub, status, scopes, consent_version, consented_at, created_at, updated_at)
      VALUES ('bad', 'a@example.com', '1', 'revoked', 'x', 1, '${NOW}', '${NOW}', '${NOW}')`)).toThrow(/CHECK constraint failed/)
  })

  it('refuses a second apply on top of itself (nothing is silently skipped)', () => {
    const d = new DatabaseSync(':memory:')
    d.exec(M1); d.exec(M2); d.exec(M3); d.exec(M4)
    expect(() => d.exec(M4)).toThrow(/already exists/)
  })
})
