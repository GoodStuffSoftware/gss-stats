// migrations/gss-budget/0006_receipt_uploads.sql (receipts can hold photo uploads) against a real SQLite (node:sqlite, D1's dialect),
// made-up values only, fixtures built in code. The migration rebuilds `receipts`, which has foreign-key cascades, partial indexes
// and a trigger on a child table, so these tests prove: every row and value survives, the child tables and the trigger are
// byte-identical to 0004, foreign keys still act, the new CHECKs and indexes work, the 0.86.1 Worker SQL still runs, the guard
// really fails the file, and the rollback block in the file restores 0004's shape.
// The file must apply whether or not 0005 (the bank-link migration, which lands with its own release) is there, in either order:
// the suite runs 0001-0004 then 0006; 0001-0005 then 0006; and 0001-0004, 0006, then 0005. The 0005 used is the real file,
// vendored under fixtures/ (blob sha pinned below), so the "both orders" claim is tested over the real DDL.
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { INSERT_ITEMS_SQL, INSERT_RECEIPT_SQL, RETRY_SQL } from '../../workers/receipts/src/store'

const DIR = 'migrations/gss-budget'
const UP_FILE = '0006_receipt_uploads.sql'
// Windows checkouts turn migration files into CRLF (autocrlf), 0006 is written LF; compare text, not line endings.
const read = (f: string): string => readFileSync(`${DIR}/${f}`, 'utf8').replaceAll('\r\n', '\n')
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
const UP = read(UP_FILE)
const through4 = files.filter((f) => f < '0005_')

/** The real 0005_bank_links.sql from release/0.88.0 (it lands with its own release), CRLF normalised, pinned by git blob sha. */
const SQL_0005 = readFileSync('functions/_lib/fixtures/0005_bank_links.sql', 'utf8').replaceAll('\r\n', '\n')
/** git blob sha of text: sha1("blob <bytes>\0" + bytes), by Web Crypto (no node:crypto types in this tsconfig). */
async function blobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text)
  const head = new TextEncoder().encode(`blob ${body.length}\0`)
  const bytes = new Uint8Array(head.length + body.length)
  bytes.set(head)
  bytes.set(body, head.length)
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
}
const EXPECTED_SHA_0005 = '85c88a1f0e8cfa18816b33e943b5e5f26002efe4'

interface Variant { name: string; apply: (d: DatabaseSync) => void }
const VARIANTS: Variant[] = [
  { name: `over ${through4.join(', ')}`, apply: (d) => through4.forEach((f) => d.exec(read(f))) },
  { name: 'over 0001-0004 plus the real 0005', apply: (d) => { through4.forEach((f) => d.exec(read(f))); d.exec(SQL_0005) } },
]

const NOW = '2026-12-05T10:00:00.000Z'
const CONN = 'c0123456789abcdef'
const CONN2 = 'cfedcba9876543210'
const rid = (n: number): string => `r${n.toString(16).padStart(16, '0')}`
const tid = (n: number): string => `t${String(n).padStart(31, '0')}`
const HASH = (n: number): string => n.toString(16).padStart(64, 'a')
const KEY = (id: string): string => `img/${id}.jpg`

type Row = Record<string, unknown>
const all = (d: DatabaseSync, sql: string, ...p: (string | number | null)[]): Row[] => d.prepare(sql).all(...p) as Row[]
const get = (d: DatabaseSync, sql: string, ...p: (string | number | null)[]): Row => all(d, sql, ...p)[0]
const count = (d: DatabaseSync, table: string): number => get(d, `SELECT count(*) AS n FROM ${table}`).n as number

/** The 24 columns 0004 defined, in 0004's order. */
const R_COLS = ['id', 'connection_id', 'gmail_msg_id', 'email_date', 'status', 'attempts', 'error_code', 'kind', 'sender_domain', 'merchant',
  'payment_via', 'card_last4', 'order_ref', 'receipt_date', 'related_date', 'currency', 'total_cents', 'tax_cents', 'shipping_cents', 'charges_json',
  'extract_model', 'created_at', 'updated_at', 'updated_by']
const REBUILT = ['receipts', 'receipt_items', 'receipt_matches', 'idx_rcpt_review', 'idx_rcpt_open', 'idx_rcpt_order', 'idx_rcpt_retry', 'idx_match_txn', 'idx_match_applied', 'trg_match_applied_gone']
const NEW_INDEXES = ['idx_rcpt_up_day', 'idx_rcpt_up_hash', 'idx_rcpt_up_open', 'idx_rcpt_up_retry', 'idx_rcpt_up_review']

function put(d: DatabaseSync, table: string, row: Row): void {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined)
  d.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k] as string | number | null))
}

/** Everything seeded is made up. Four bank rows, two connections, six receipts, three items, four matches (applied, suggested, rejected, superseded). */
function seed(d: DatabaseSync): void {
  d.exec(`INSERT INTO accounts (id, label, kind) VALUES ('acc-1', 'Checking', 'checking');
          INSERT INTO imports (id, source_label, created_at, created_by, rows_in) VALUES ('imp-1', 'test', '${NOW}', 'test', 4);`)
  for (let n = 1; n <= 4; n++) {
    put(d, 'transactions', { id: tid(n), account_id: 'acc-1', import_id: 'imp-1', posted_date: '2026-11-1' + n, amount_cents: -1000 * n, description: 'TEST SHOP', kind: 'spend', kind_source: 'auto', category_source: 'none', updated_at: NOW, updated_by: 'test' })
  }
  const conn = (id: string, email: string): void => put(d, 'email_connections', { id, owner_email: email, google_sub: '1', status: 'active', token_ct: 'Y2lwaGVydGV4dA==', token_iv: 'aXZpdml2aXZpaQ==', key_id: '0a1b2c3d', scopes: 'gmail.readonly', consent_version: 1, consented_at: NOW, created_at: NOW, updated_at: NOW })
  conn(CONN, 'user-a@example.com')
  conn(CONN2, 'user-b@example.com')
  const r = (n: number, over: Row): void => put(d, 'receipts', { id: rid(n), connection_id: CONN, gmail_msg_id: `18c3f2a9b7d4e60${n}`, email_date: '2026-11-10', status: 'pending', created_at: NOW, updated_at: NOW, updated_by: 'script:receipts', ...over })
  r(1, { status: 'applied', kind: 'purchase', sender_domain: 'shop.example.com', merchant: 'Test Shop', payment_via: 'card', card_last4: '0042', order_ref: '114-1234567-7654321', receipt_date: '2026-11-09', related_date: '2026-11-01', currency: 'USD', total_cents: 1999, tax_cents: 150, shipping_cents: 0, charges_json: '[{"cents":1000},{"cents":999}]', extract_model: 'test-model' })
  r(2, { status: 'suggested', total_cents: 2000, currency: 'USD', merchant: 'Other Shop' })
  r(3, { status: 'unmatched', total_cents: 3000 })
  r(4, { status: 'pending', attempts: 1, error_code: 'extract_invalid' })
  r(5, { connection_id: CONN2, status: 'skipped', kind: 'other' })
  r(6, { status: 'no_total', email_date: '2026-11-12' })
  d.exec(`INSERT INTO receipt_items (receipt_id, seq, description, amount_cents, quantity, category_hint) VALUES
    ('${rid(1)}', 1, 'Widget', 1000, 1, 'groceries'), ('${rid(1)}', 2, 'Gadget', 999, 2, 'shopping'), ('${rid(2)}', 1, 'Thing', NULL, NULL, NULL)`)
  const m = (id: number, receipt: number, txn: number, over: Row): void => put(d, 'receipt_matches', { id, receipt_id: rid(receipt), txn_id: tid(txn), group_key: 'g' + id, rule: 'exact', share_cents: 1000, score: 90, status: 'suggested', txn_updated_at: NOW, created_at: NOW, ...over })
  m(7, 1, 1, { status: 'applied', proposed_category_id: 'groceries', decided_at: NOW, decided_by: 'user-a@example.com' })
  m(9, 2, 2, {})
  m(12, 3, 3, { status: 'rejected', decided_at: NOW, decided_by: 'user-a@example.com' })
  m(15, 2, 3, { status: 'superseded', proposed_category_id: 'shopping' })
  if (d.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'bank_txns'`).get()) seedBank(d)
}

/** Made-up Plaid rows (real 0005 tables): one item, one account, two linked bank rows. Needs 0005 applied. */
function seedBank(d: DatabaseSync): void {
  d.exec(`INSERT INTO bank_items (id, owner_email, environment, plaid_item_id, status, token_ct, token_iv, key_id, consent_version, consented_at, created_at, updated_at)
            VALUES ('i0123456789abcdef', 'user-a@example.com', 'sandbox', 'item_test_1', 'active', 'Y2lwaGVydGV4dA==', 'aXZpdml2aXZpaXZp', '0a1b2c3d', 1, '${NOW}', '${NOW}', '${NOW}');
          INSERT INTO bank_accounts (id, item_id, plaid_account_id, account_id, name, type, sync, created_at, updated_at)
            VALUES ('b0123456789abcdef', 'i0123456789abcdef', 'acct_test_1', 'acc-1', 'Checking', 'depository', 'on', '${NOW}', '${NOW}');
          INSERT INTO bank_txns (plaid_txn_id, bank_account_id, txn_id, role, seen_at, updated_at) VALUES
            ('ptxn_test_4', 'b0123456789abcdef', '${tid(4)}', 'inserted', '${NOW}', '${NOW}'), ('ptxn_test_2', 'b0123456789abcdef', '${tid(2)}', 'matched', '${NOW}', '${NOW}')`)
}

/** A database at the state just before 0006, seeded, with foreign keys on (as D1 always has them). */
function before(v: Variant): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec('PRAGMA foreign_keys = ON')
  v.apply(d)
  seed(d)
  return d
}

/** Every table's rows (receipts: the 0004 columns only), plus the stored DDL of every object, as comparable JSON. */
function snapshot(d: DatabaseSync): { data: Record<string, string[]>; ddl: Record<string, string> } {
  const data: Record<string, string[]> = {}
  const ddl: Record<string, string> = {}
  for (const o of all(d, `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`)) {
    ddl[o.name as string] = String(o.sql)
    if (o.type === 'table') {
      const cols = o.name === 'receipts' ? R_COLS.join(', ') : '*'
      data[o.name as string] = all(d, `SELECT ${cols} FROM ${o.name}`).map((r) => JSON.stringify(r)).sort()
    }
  }
  return { data, ddl }
}

const uploadRow = (n: number, over: Row = {}): Row => ({
  id: rid(100 + n), source: 'upload', uploader_email: 'user-a@example.com', image_sha256: HASH(n), image_key: KEY(rid(100 + n)), image_bytes: 250000,
  email_date: '2026-12-01', status: 'pending', created_at: NOW, updated_at: NOW, updated_by: 'worker:upload', ...over,
})

function rejects(fn: () => void, kind: 'CHECK' | 'UNIQUE' | 'FOREIGN KEY' | 'NOT NULL' = 'CHECK'): void {
  let msg = ''
  try { fn() } catch (e) { msg = String((e as Error).message) }
  expect(msg, 'the statement should have been rejected').not.toBe('')
  expect(msg).toContain(`${kind} constraint failed`)
}

const plan = (d: DatabaseSync, sql: string, ...p: (string | number)[]): string => all(d, `EXPLAIN QUERY PLAN ${sql}`, ...p).map((r) => r.detail).join(' | ')

describe.each(VARIANTS)('0006 $name', (v) => {
  const migrated = (): DatabaseSync => { const d = before(v); d.exec(UP); return d }

  it('keeps every row and value, changes only the rebuilt objects, and leaves nothing behind', () => {
    const d = before(v)
    const snap = snapshot(d)
    expect(count(d, 'receipts')).toBe(6)
    expect(count(d, 'receipt_items')).toBe(3)
    expect(count(d, 'receipt_matches')).toBe(4)
    d.exec(UP)
    const after = snapshot(d)
    expect(after.data).toEqual(snap.data)
    for (const [name, sql] of Object.entries(snap.ddl)) {
      if (name === 'receipts') continue
      expect(after.ddl[name], name).toBe(sql)
    }
    expect(Object.keys(after.ddl).filter((n) => !(n in snap.ddl)).sort()).toEqual(NEW_INDEXES)
    expect(Object.keys(after.ddl).filter((n) => n.startsWith('_m6'))).toEqual([])
    expect(get(d, 'PRAGMA foreign_keys').foreign_keys).toBe(1)
    expect(all(d, 'PRAGMA foreign_key_check')).toEqual([])
    expect(get(d, `SELECT typeof(total_cents) AS t, typeof(attempts) AS a FROM receipts WHERE id = '${rid(1)}'`)).toEqual({ t: 'integer', a: 'integer' })
    expect(all(d, `SELECT DISTINCT source FROM receipts`)).toEqual([{ source: 'email' }])
    expect(get(d, `SELECT "notnull" AS n FROM pragma_table_info('receipts') WHERE name = 'id'`).n).toBe(1)
    expect(all(d, `SELECT name FROM pragma_table_info('receipts')`).map((r) => r.name)).toEqual([...R_COLS, 'source', 'uploader_email', 'image_key', 'image_sha256', 'image_bytes'])
  })

  it('stores receipt_items, receipt_matches, their indexes and the trigger exactly as 0004 wrote them', () => {
    const ref = new DatabaseSync(':memory:')
    through4.forEach((f) => ref.exec(read(f)))
    const d = migrated()
    for (const name of ['receipt_items', 'receipt_matches', 'idx_match_txn', 'idx_match_applied', 'trg_match_applied_gone', 'idx_rcpt_review', 'idx_rcpt_open', 'idx_rcpt_order', 'idx_rcpt_retry']) {
      expect(get(d, 'SELECT sql FROM sqlite_master WHERE name = ?', name).sql, name).toBe(get(ref, 'SELECT sql FROM sqlite_master WHERE name = ?', name).sql)
    }
    // the shape bank-link code relies on, spelled out
    expect(get(d, `SELECT sql FROM sqlite_master WHERE name = 'receipt_matches'`).sql).toContain('txn_id         TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE')
    expect(all(d, `SELECT name FROM pragma_index_info('idx_match_txn')`).map((r) => r.name)).toEqual(['txn_id', 'status'])
    expect(plan(d, 'SELECT 1 FROM receipt_matches WHERE txn_id = ?', tid(1))).toMatch(/idx_match_txn/)
  })

  it('still cascades: a bank row delete removes its matches, an applied one puts the receipt back to unmatched, a receipt delete removes items and matches', () => {
    const d = migrated()
    d.exec(`DELETE FROM categories WHERE id = 'groceries'`)                                        // ON DELETE SET NULL, on both child tables
    expect(all(d, `SELECT category_hint FROM receipt_items WHERE receipt_id = '${rid(1)}' ORDER BY seq`)).toEqual([{ category_hint: null }, { category_hint: 'shopping' }])
    expect(get(d, `SELECT proposed_category_id AS p FROM receipt_matches WHERE id = 7`).p).toBeNull()
    d.exec(`DELETE FROM transactions WHERE id = '${tid(2)}'`)
    expect(all(d, `SELECT id FROM receipt_matches WHERE txn_id = '${tid(2)}'`)).toEqual([])
    expect(get(d, `SELECT status FROM receipts WHERE id = '${rid(2)}'`).status).toBe('suggested')   // a suggested match leaves the receipt's status to the app
    d.exec(`DELETE FROM transactions WHERE id = '${tid(1)}'`)                                      // its match was applied: the trigger fires
    expect(all(d, `SELECT id FROM receipt_matches WHERE txn_id = '${tid(1)}'`)).toEqual([])
    expect(get(d, `SELECT status, updated_by FROM receipts WHERE id = '${rid(1)}'`)).toEqual({ status: 'unmatched', updated_by: 'db:match_deleted' })
    d.exec(`DELETE FROM receipts WHERE id = '${rid(2)}'`)
    expect(all(d, `SELECT 1 FROM receipt_items WHERE receipt_id = '${rid(2)}' UNION ALL SELECT 1 FROM receipt_matches WHERE receipt_id = '${rid(2)}'`)).toEqual([])
    d.exec(`DELETE FROM email_connections WHERE id = '${CONN2}'`)
    expect(get(d, `SELECT count(*) AS n FROM receipts WHERE connection_id = '${CONN2}'`).n).toBe(0)
    expect(all(d, 'PRAGMA foreign_key_check')).toEqual([])
  })

  it('accepts a valid upload row, with or without its image, and several uploads (NULL connection and message ids never collide)', () => {
    const d = migrated()
    put(d, 'receipts', uploadRow(1))
    put(d, 'receipts', uploadRow(2, { image_key: null }))
    put(d, 'receipts', uploadRow(3, { image_bytes: undefined }))
    put(d, 'receipts', uploadRow(4, { image_bytes: 3000000, kind: 'purchase', merchant: 'Test Shop', total_cents: 1234, receipt_date: '2026-11-30' }))
    expect(get(d, `SELECT count(*) AS n FROM receipts WHERE source = 'upload'`).n).toBe(4)
    expect(get(d, `SELECT connection_id AS c, gmail_msg_id AS g FROM receipts WHERE id = '${rid(101)}'`)).toEqual({ c: null, g: null })
  })

  it('rejects upload rows with no uploader, a Gmail id or connection, a missing or bad hash, a bad image key or size, or a bad source', () => {
    const d = migrated()
    const bad = (over: Row, kind: 'CHECK' | 'UNIQUE' | 'NOT NULL' = 'CHECK'): void => rejects(() => put(d, 'receipts', uploadRow(9, over)), kind)
    bad({ uploader_email: undefined })
    bad({ uploader_email: null })
    bad({ uploader_email: 'User-A@example.com' })
    bad({ uploader_email: 'nobody' })
    bad({ uploader_email: '@example.com' })
    bad({ uploader_email: `${'a'.repeat(250)}@example.com` })
    bad({ gmail_msg_id: '18c3f2a9b7d4e610' })
    bad({ connection_id: CONN })
    bad({ image_sha256: undefined })
    bad({ image_sha256: null })
    bad({ image_sha256: 'a'.repeat(63) })
    bad({ image_sha256: 'A'.repeat(64) })
    bad({ image_sha256: 'g'.repeat(64) })
    for (const k of [`img/${rid(109)}.png`, `img/${rid(109)}.JPG`, `img/R${rid(109).slice(1)}.jpg`, `img/${rid(109).slice(0, 16)}g.jpg`, `img/${rid(109).slice(0, 16)}.jpg`, `img/${rid(109)}0.jpg`,
      `tmp/${rid(109)}.jpg`, `../${rid(109)}.jpg`, `img/x${rid(109).slice(1)}.jpg`, `img/${rid(109).toUpperCase()}.jpg`, '', 'img/.jpg']) bad({ image_key: k })
    for (const b of [0, -1, 3000001, 12.5, 'big']) bad({ image_bytes: b })
    bad({ id: null, image_key: '../x.jpg' }, 'NOT NULL')        // a NULL id makes the image_key CHECK NULL, which would pass
    bad({ id: undefined, image_key: '../x.jpg' }, 'NOT NULL')   // id missing: the column would default to NULL
    bad({ image_key: KEY(rid(108)) })   // well formed, but names another receipt: the key must be built from the row's own id
    bad({ source: 'photo' })
    bad({ source: 'email' })
    bad({ source: undefined })   // the DEFAULT 'email' then fails the row-shape CHECK
    put(d, 'receipts', uploadRow(1))
    bad({ id: rid(150), image_sha256: HASH(1), image_key: KEY(rid(150)) }, 'UNIQUE')   // the same image twice, household-wide (own key, so the key CHECK does not fire first)
    expect(count(d, 'receipts')).toBe(7)
  })

  it('rejects email rows that carry upload data or miss email data, and keeps every email CHECK it had', () => {
    const d = migrated()
    const email = (over: Row, id = rid(200)): void => put(d, 'receipts', { id, connection_id: CONN, gmail_msg_id: '18c3f2a9b7d4e699', email_date: '2026-11-10', status: 'pending', created_at: NOW, updated_at: NOW, updated_by: 'x', ...over })
    email({})
    rejects(() => email({ uploader_email: 'user-a@example.com' }, rid(201)))
    rejects(() => email({ image_sha256: HASH(5) }, rid(201)))
    rejects(() => email({ image_key: KEY(rid(201)) }, rid(201)))
    rejects(() => email({ image_bytes: 5 }, rid(201)))
    rejects(() => email({ connection_id: null }, rid(201)))
    rejects(() => email({ connection_id: undefined }, rid(201)))
    rejects(() => email({ gmail_msg_id: null }, rid(201)))
    rejects(() => email({ gmail_msg_id: undefined }, rid(201)))
    rejects(() => email({}, rid(202)), 'UNIQUE')                                                  // same (connection, message)
    rejects(() => email({ connection_id: 'c00000000000000ff', gmail_msg_id: '18c3f2a9b7d4e698' }, rid(201)), 'FOREIGN KEY')
    for (const m of ['', '18c3f2a', '18c3f2a9b7d4e61g', '18C3F2A9B7D4E610', 'a'.repeat(33)]) rejects(() => email({ gmail_msg_id: m }, rid(201)))
    for (const id of ['c0123456789abcdef', 'r0123456789abcde', 'r0123456789ABCDEF', '']) rejects(() => email({ gmail_msg_id: '18c3f2a9b7d4e697' }, id))
    rejects(() => email({ id: null, gmail_msg_id: '18c3f2a9b7d4e695' }), 'NOT NULL')
    rejects(() => email({ id: undefined, gmail_msg_id: '18c3f2a9b7d4e694' }), 'NOT NULL')
    for (const dt of ['2026-02-30', '2026-19-01', '20261110', '']) rejects(() => email({ email_date: dt, gmail_msg_id: '18c3f2a9b7d4e696' }, rid(201)))
    rejects(() => email({ email_date: undefined, gmail_msg_id: '18c3f2a9b7d4e696' }, rid(201)), 'NOT NULL')
    rejects(() => email({ status: 'done', gmail_msg_id: '18c3f2a9b7d4e696' }, rid(201)))
    rejects(() => email({ attempts: 10, gmail_msg_id: '18c3f2a9b7d4e696' }, rid(201)))
    rejects(() => email({ card_last4: '12a4', gmail_msg_id: '18c3f2a9b7d4e696' }, rid(201)))
    rejects(() => email({ currency: 'usd', gmail_msg_id: '18c3f2a9b7d4e696' }, rid(201)))
    rejects(() => email({ total_cents: 12.5, gmail_msg_id: '18c3f2a9b7d4e696' }, rid(201)))
    rejects(() => email({ charges_json: '{"a":1}', gmail_msg_id: '18c3f2a9b7d4e696' }, rid(201)))
    rejects(() => email({ order_ref: 'has space', gmail_msg_id: '18c3f2a9b7d4e696' }, rid(201)))
    rejects(() => email({ updated_by: undefined, gmail_msg_id: '18c3f2a9b7d4e696' }, rid(201)), 'NOT NULL')
  })

  it('runs the 0.86.1 Worker receipt SQL unchanged: insert, dedupe, items, retry list', () => {
    const d = migrated()
    put(d, 'receipts', uploadRow(1, { status: 'error', attempts: 1 }))                            // an upload must never reach the email retry list
    const ins = (id: string, msg: string, conn = CONN): number => Number((d.prepare(INSERT_RECEIPT_SQL).run(id, conn, msg, '2026-11-10', 'error', 1, 'fetch_failed', null, 'shop.example.com', null, null, null, null, null, null, null, null, null, null, null, null, NOW) as { changes: number | bigint }).changes)
    expect(ins(rid(300), '18c3f2a9b7d4e777')).toBe(1)
    expect(ins(rid(301), '18c3f2a9b7d4e777')).toBe(0)                                           // INSERT OR IGNORE on (connection, message)
    expect(ins(rid(302), '18c3f2a9b7d4e778', 'cdeadbeefdeadbeef')).toBe(0)                       // no active connection with that id
    expect(get(d, `SELECT source, uploader_email AS u, image_sha256 AS h, updated_by FROM receipts WHERE id = '${rid(300)}'`)).toMatchObject({ source: 'email', u: null, h: null })
    d.prepare(INSERT_ITEMS_SQL).run(rid(300), JSON.stringify([{ d: 'Widget', a: 500, q: 1, c: 'groceries' }, { d: 'Bad hint', a: 1, q: 1, c: 'no-such-category' }]), NOW)
    expect(all(d, `SELECT seq, category_hint FROM receipt_items WHERE receipt_id = '${rid(300)}' ORDER BY seq`)).toEqual([{ seq: 1, category_hint: 'groceries' }, { seq: 2, category_hint: null }])
    expect((d.prepare(RETRY_SQL).all(CONN, 10) as Row[]).map((r) => r.id)).toEqual([rid(4), rid(300)])   // ORDER BY attempts, id: the upload row is not listed
  })

  it('serves the upload queries from the new partial indexes (and the old queries from the old ones)', () => {
    const d = migrated()
    const U = 'user-a@example.com'
    expect(plan(d, 'SELECT id FROM receipts WHERE uploader_email = ?1 AND status = ?2 AND (email_date, id) < (?3, ?4) ORDER BY email_date DESC, id DESC LIMIT 20', U, 'unmatched', '2026-12-31', 'rzzz')).toMatch(/idx_rcpt_up_review/)
    expect(plan(d, 'SELECT id FROM receipts WHERE uploader_email = ?1 AND status = ?2 ORDER BY email_date DESC, id DESC LIMIT 20', U, 'unmatched')).toMatch(/idx_rcpt_up_review(?!.*TEMP B-TREE)/)
    expect(plan(d, `SELECT id FROM receipts WHERE uploader_email = ?1 AND status IN ('unmatched','suggested') AND coalesce(receipt_date, email_date) >= ?2`, U, '2026-09-01')).toMatch(/idx_rcpt_up_open/)
    expect(plan(d, 'SELECT count(*) FROM receipts WHERE uploader_email = ?1 AND created_at >= ?2', U, '2026-12-05T00:00:00.000Z')).toMatch(/idx_rcpt_up_day/)
    expect(plan(d, `SELECT id FROM receipts WHERE uploader_email IS NOT NULL AND status IN ('pending','error') AND attempts < ?1 ORDER BY attempts, id LIMIT ?2`, 3, 10)).toMatch(/idx_rcpt_up_retry(?!.*TEMP B-TREE)/)
    expect(plan(d, 'SELECT id FROM receipts WHERE image_sha256 = ?1', HASH(1))).toMatch(/idx_rcpt_up_hash/)
    // 0.86.1 queries keep their 0004 indexes
    expect(plan(d, RETRY_SQL, CONN, 10)).toMatch(/idx_rcpt_retry/)
    expect(plan(d, 'SELECT id FROM receipts WHERE connection_id = ?1 AND status = ?2 ORDER BY email_date DESC, id DESC LIMIT 20', CONN, 'unmatched')).toMatch(/idx_rcpt_review/)
    expect(plan(d, 'SELECT 1 FROM receipt_matches WHERE txn_id = ?1', tid(1))).toMatch(/COVERING INDEX idx_match_txn/)
  })

  it('fails the whole file when the guard trips (a restore that loses a row), and leaves every original row in the _m6_ copies', () => {
    const d = before(v)
    const lossy = UP.replace('SELECT receipt_id, seq, description, amount_cents, quantity, category_hint FROM _m6_items;', 'SELECT receipt_id, seq, description, amount_cents, quantity, category_hint FROM _m6_items WHERE seq = 1;')
    expect(lossy).not.toBe(UP)
    expect(() => d.exec(lossy)).toThrow(/CHECK constraint failed/)
    expect(count(d, '_m6_items')).toBe(3)                                                       // exec() is not a transaction: the copies are the recovery source
    expect(count(d, '_m6_receipts')).toBe(6)
    expect(count(d, '_m6_matches')).toBe(4)
    expect(count(d, 'receipt_items')).toBe(2)
    // run inside one transaction, as D1 runs a migration file, the same failure leaves the database exactly as it was
    const e = before(v)
    const snap = snapshot(e)
    e.exec('BEGIN')
    expect(() => e.exec(lossy)).toThrow(/CHECK constraint failed/)
    e.exec('ROLLBACK')
    expect(snapshot(e)).toEqual(snap)
  })

  it('also trips the guard on a changed value, not only a lost row', () => {
    const d = before(v)
    const skewed = UP.replace('created_at, updated_at, updated_by FROM _m6_receipts;', "created_at, updated_at, 'someone-else' FROM _m6_receipts;")
    expect(skewed).not.toBe(UP)
    expect(() => d.exec(skewed)).toThrow(/CHECK constraint failed/)
  })

  it('fails the whole file, changing nothing, when receipts already holds a NULL id (0004 allowed one)', () => {
    const e = before(v)
    put(e, 'receipts', { id: null, connection_id: CONN, gmail_msg_id: 'feedfacecafe0001', email_date: '2026-11-10', status: 'pending', created_at: NOW, updated_at: NOW, updated_by: 'x' })
    const snap = snapshot(e)
    e.exec('BEGIN')
    expect(() => e.exec(UP)).toThrow(/NOT NULL constraint failed: receipts\.id/)
    e.exec('ROLLBACK')
    expect(snapshot(e)).toEqual(snap)
    expect(count(e, 'receipts')).toBe(7)
  })

  it('refuses to run a second time, before it changes anything, so upload rows can never be pushed through the email-only restore', () => {
    const d = migrated()
    put(d, 'receipts', uploadRow(1))
    const snap = snapshot(d)
    expect(() => d.exec(UP)).toThrow(/CHECK constraint failed/)
    d.exec('DROP TABLE _m6_check')
    expect(snapshot(d)).toEqual(snap)
    expect(count(d, 'receipts')).toBe(7)
  })

  describe('rollback block', () => {
    const lines = UP.split('\n')
    const begin = lines.indexOf('-- ROLLBACK-SQL-BEGIN')
    const end = lines.indexOf('-- ROLLBACK-SQL-END')
    const rollbackSql = lines.slice(begin + 1, end).map((l) => l.replace(/^-- ?/, '')).join('\n')

    it('restores 0004 exactly: upload rows gone, email rows and their children kept, 0006 un-recorded, DDL text equal to 0004, and 0006 applies again', () => {
      expect(begin).toBeGreaterThan(0)
      expect(end).toBeGreaterThan(begin)
      const ref = new DatabaseSync(':memory:')
      through4.forEach((f) => ref.exec(read(f)))
      const refDdl = all(ref, `SELECT name, sql FROM sqlite_master WHERE name IN (${REBUILT.map((n) => `'${n}'`).join(',')}) ORDER BY name`)
      expect(refDdl).toHaveLength(REBUILT.length)

      const d = migrated()
      d.exec(`CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
      d.exec(`INSERT INTO d1_migrations (name) VALUES ('0004_receipts.sql'), ('${UP_FILE}')`)
      const emailBefore = snapshot(d)
      // uploads with a suggested match, an applied match and an item; the rollback must delete them with their children
      put(d, 'receipts', uploadRow(1, { status: 'suggested' }))
      put(d, 'receipts', uploadRow(2, { status: 'applied' }))
      put(d, 'receipt_items', { receipt_id: rid(101), seq: 1, description: 'Photo item', amount_cents: 100 })
      put(d, 'receipt_matches', { receipt_id: rid(101), txn_id: tid(3), group_key: 'gu1', rule: 'exact', share_cents: 1, score: 50, status: 'suggested', txn_updated_at: NOW, created_at: NOW })
      put(d, 'receipt_matches', { receipt_id: rid(102), txn_id: tid(4), group_key: 'gu2', rule: 'exact', share_cents: 1, score: 50, status: 'applied', txn_updated_at: NOW, created_at: NOW })

      d.exec(`BEGIN;\n${rollbackSql}\nCOMMIT;`)

      expect(all(d, `SELECT name, sql FROM sqlite_master WHERE name IN (${REBUILT.map((n) => `'${n}'`).join(',')}) ORDER BY name`)).toEqual(refDdl)
      expect(all(d, `SELECT name FROM sqlite_master WHERE name LIKE 'idx_rcpt_up%' OR name LIKE '_m6%'`)).toEqual([])
      expect(all(d, `SELECT name FROM pragma_table_info('receipts')`).map((r) => r.name)).toEqual(R_COLS)
      const after = snapshot(d)
      expect(after.data.receipts).toEqual(emailBefore.data.receipts)
      expect(after.data.receipt_items).toEqual(emailBefore.data.receipt_items)
      expect(after.data.receipt_matches).toEqual(emailBefore.data.receipt_matches)
      expect(after.data.transactions).toEqual(emailBefore.data.transactions)
      expect(all(d, 'SELECT name FROM d1_migrations ORDER BY id')).toEqual([{ name: '0004_receipts.sql' }])
      expect(all(d, 'PRAGMA foreign_key_check')).toEqual([])
      // the trigger is live again and the migration applies again from there
      d.exec(`DELETE FROM transactions WHERE id = '${tid(1)}'`)
      expect(get(d, `SELECT status FROM receipts WHERE id = '${rid(1)}'`).status).toBe('unmatched')
      d.exec(UP)
      expect(all(d, `SELECT name FROM pragma_table_info('receipts')`)).toHaveLength(R_COLS.length + 5)
    })
  })
})

describe('0006 and the real 0005, in both orders', () => {
  it('uses the pinned 0005 file', async () => {
    const sha = await blobSha(SQL_0005)
    console.log(`0005 fixture blob sha: ${sha}`)
    expect(sha).toBe(EXPECTED_SHA_0005)
  })

  it('0001-0004, 0006, then 0005 ends with the same DDL and rows as 0001-0005 then 0006', () => {
    const through5Then6 = new DatabaseSync(':memory:')
    through5Then6.exec('PRAGMA foreign_keys = ON')
    through4.forEach((f) => through5Then6.exec(read(f)))
    through5Then6.exec(SQL_0005)
    seed(through5Then6)
    through5Then6.exec(UP)

    const sixThenFive = new DatabaseSync(':memory:')
    sixThenFive.exec('PRAGMA foreign_keys = ON')
    through4.forEach((f) => sixThenFive.exec(read(f)))
    seed(sixThenFive)
    sixThenFive.exec(UP)
    sixThenFive.exec(SQL_0005)
    seedBank(sixThenFive)

    expect(all(sixThenFive, 'PRAGMA foreign_key_check')).toEqual([])
    expect(get(sixThenFive, 'PRAGMA foreign_keys').foreign_keys).toBe(1)
    const a = snapshot(through5Then6)
    const b = snapshot(sixThenFive)
    expect(b.ddl).toEqual(a.ddl)
    expect(b.data).toEqual(a.data)
    // the Plaid foreign keys into transactions still act on both
    for (const d of [through5Then6, sixThenFive]) {
      d.exec(`DELETE FROM transactions WHERE id = '${tid(4)}'`)
      expect(all(d, `SELECT plaid_txn_id FROM bank_txns`)).toEqual([{ plaid_txn_id: 'ptxn_test_2' }])
    }
  })
})

describe('0006 file', () => {
  it('is the next number after the files before it and is applied in name order', () => {
    expect(files.at(-1)).toBe(UP_FILE)
  })

  it('names no private data: no addresses or merchant names in the code outside comments', () => {
    const code = UP.replace(/--.*$/gm, '')
    expect(code).not.toMatch(/@[a-z0-9-]+\./i)
    expect(code).not.toMatch(/\b(walmart|target|costco|netflix|spotify|uber|doordash)\b/i)
  })

  it('never turns foreign keys off or renames a table (neither works on D1)', () => {
    const code = UP.replace(/--.*$/gm, '')
    expect(code).not.toMatch(/PRAGMA|RENAME|BEGIN TRANSACTION|COMMIT/i)
  })
})
