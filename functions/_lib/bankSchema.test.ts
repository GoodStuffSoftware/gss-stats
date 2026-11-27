// migrations/gss-budget/0005_bank_links.sql against a real SQLite (node:sqlite, D1's dialect), made-up values only.
// Covers: every CHECK, the slot-log triggers, the foreign keys and their actions (foreign keys are ON, as in D1), the
// indexes the cron and the sync lean on (EXPLAIN QUERY PLAN), that 0005 is additive over a 0004 database that already
// holds rows, the rollback batch (read from the file's own comment block), and applying it again.
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { createBudgetDb, insertTxn, syntheticSeedSql, type FakeBudgetDb } from './testing/budgetDb'

const M1 = readFileSync('migrations/gss-budget/0001_init.sql', 'utf8')
const M2 = readFileSync('migrations/gss-budget/0002_loans.sql', 'utf8')
const M3 = readFileSync('migrations/gss-budget/0003_included.sql', 'utf8')
const M4 = readFileSync('migrations/gss-budget/0004_receipts.sql', 'utf8')
const M5 = readFileSync('migrations/gss-budget/0005_bank_links.sql', 'utf8')
const NOW = '2026-12-05T10:00:00.000Z'

/**
 * The synthetic load for a database that has only migrations 0001-0004. The load carries the bank load guard (a read of
 * bank_accounts per row, src/lib/budget/sqlFile.ts: "Needs migration 0005 applied"), so a 0004 database needs a stand-in
 * table while it runs; the stand-in is empty (no account is linked, every row loads) and dropped again, leaving a plain 0004 database.
 */
const seedFor0004 = async (): Promise<string> =>
  `CREATE TABLE bank_accounts (account_id TEXT, sync TEXT, sync_from TEXT);\n${await syntheticSeedSql()}DROP TABLE bank_accounts;\n`

const NEW_TABLES = ['bank_items', 'plaid_slot_log', 'bank_accounts', 'bank_txns', 'bank_liabilities', 'bank_sync_runs']
const NEW_INDEXES = [
  'idx_bank_items_due', 'idx_bank_acct_item', 'idx_bank_acct_budget', 'idx_bank_acct_on',
  'idx_bank_txn_txn', 'idx_bank_txn_acct', 'idx_bank_txn_dup', 'idx_bank_txn_dropped', 'idx_bank_runs_item',
]
const NEW_TRIGGERS = ['trg_slot_log_no_delete', 'trg_slot_log_no_replace', 'trg_slot_log_one_way']

type Row = Record<string, unknown>
let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })

const ITEM = 'i0123456789abcdef'
const ITEM2 = 'ifedcba9876543210'
const BA1 = 'b0123456789abcdef'
const BA2 = 'bfedcba9876543210'

/** Inserts a row built from defaults plus overrides (a key set to undefined is left out). */
function put(d: { sqlite: DatabaseSync }, table: string, defaults: Row, over: Row = {}): void {
  const row = { ...defaults, ...over }
  const keys = Object.keys(row).filter((k) => row[k] !== undefined)
  d.sqlite.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k] as string | number | null))
}

const itemDefaults = (id = ITEM, plaidId = 'item-sandbox-001'): Row => ({
  id, owner_email: 'user-a@example.com', environment: 'sandbox', plaid_item_id: plaidId, status: 'active',
  token_ct: 'Y2lwaGVydGV4dA==', token_iv: 'aXZpdml2aXZpaQ==', key_id: '0a1b2c3d', consent_version: 1, consented_at: NOW, created_at: NOW, updated_at: NOW,
})
const item = (over: Row = {}, id = ITEM, plaidId = 'item-sandbox-001'): void => put(db, 'bank_items', itemDefaults(id, plaidId), over)
const NO_TOKEN: Row = { token_ct: null, token_iv: null, key_id: null, sync_cursor: null }

const acctDefaults = (id = BA1, plaidId = 'acc-sandbox-001', itemId = ITEM): Row => ({
  id, item_id: itemId, plaid_account_id: plaidId, name: 'Everyday Checking', type: 'depository', created_at: NOW, updated_at: NOW,
})
const bacct = (over: Row = {}, id = BA1, plaidId = 'acc-sandbox-001', itemId = ITEM): void => put(db, 'bank_accounts', acctDefaults(id, plaidId, itemId), over)

const btxnDefaults = (txnId: string, plaidId = 'ptx-sandbox-001', acct = BA1): Row => ({
  plaid_txn_id: plaidId, bank_account_id: acct, txn_id: txnId, role: 'inserted', seen_at: NOW, updated_at: NOW,
})
const btxn = (txnId: string, over: Row = {}, plaidId = 'ptx-sandbox-001', acct = BA1): void => put(db, 'bank_txns', btxnDefaults(txnId, plaidId, acct), over)

const liab = (over: Row = {}, acct = BA1): void => put(db, 'bank_liabilities', { bank_account_id: acct, kind: 'credit', fetched_at: NOW }, over)
const run = (over: Row = {}, itemId = ITEM): void => put(db, 'bank_sync_runs', { item_id: itemId, run_trigger: 'cron', started_at: NOW }, over)
const slot = (over: Row = {}): void => put(db, 'plaid_slot_log', { environment: 'sandbox', status: 'pending', created_at: NOW, created_by: 'user-a@example.com' }, over)

/** A Budget account of the test database (the seeded ones are left alone). */
const budgetAccount = (d: { sqlite: DatabaseSync }, id: string): void => {
  d.sqlite.prepare(`INSERT INTO accounts (id, label, kind) VALUES (?, ?, 'checking')`).run(id, `Test ${id}`)
}

const count = (d: { sqlite: DatabaseSync }, table: string): number => (d.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

/** Asserts the statement fails with a constraint error of the given kind (CHECK, UNIQUE, FOREIGN KEY, NOT NULL). */
function rejects(fn: () => void, kind: 'CHECK' | 'UNIQUE' | 'FOREIGN KEY' | 'NOT NULL' = 'CHECK'): void {
  let msg = ''
  try { fn() } catch (e) { msg = String((e as Error).message) }
  expect(msg, 'the statement should have been rejected').not.toBe('')
  expect(msg).toContain(`${kind} constraint failed`)
}
/** Asserts a trigger refused the statement (RAISE(ABORT, text)). */
function refused(fn: () => void, text: string): void {
  let msg = ''
  try { fn() } catch (e) { msg = String((e as Error).message) }
  expect(msg, 'the statement should have been refused').not.toBe('')
  expect(msg).toContain(text)
}

describe('foreign keys', () => {
  it('are enforced by the test database, as D1 does', () => {
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1)
    rejects(() => bacct(), 'FOREIGN KEY')
    item()
    bacct()
    rejects(() => bacct({ account_id: 'no-such-account' }, BA2, 'acc-sandbox-002'), 'FOREIGN KEY')
  })
})

describe('bank_items', () => {
  it('accepts a complete active row and the token-keeping and token-free states', () => {
    item()
    item({ status: 'needs_reconnect', sync_cursor: 'cursor-abc' }, ITEM2, 'item-sandbox-002')
    item({ status: 'pending_disconnect' }, 'i1111111111111111', 'item-sandbox-003')
    item({ status: 'revoked', ...NO_TOKEN }, 'i2222222222222222', 'item-sandbox-004')
    item({ status: 'removed', ...NO_TOKEN }, 'i3333333333333333', 'item-sandbox-005')
    item({ institution_id: 'ins_sandbox_1', institution_name: 'Pine Ridge Credit Union', last_error: 'item_login_required', sync_requested_at: NOW }, 'i4444444444444444', 'item-sandbox-006')
    expect(count(db, 'bank_items')).toBe(6)
  })

  it('defaults the progress flags to 0', () => {
    item()
    expect(db.get('SELECT initial_done, historical_done, new_accounts FROM bank_items')).toEqual({ initial_done: 0, historical_done: 0, new_accounts: 0 })
  })

  it('rejects bad ids: wrong prefix, wrong length, non-hex, uppercase', () => {
    for (const id of ['x0123456789abcdef', 'i0123456789abcde', 'i0123456789abcdef0', 'i0123456789abcdeg', 'i0123456789ABCDEF', 'i0123456789abc-ef', ''])
      rejects(() => item({}, id, 'item-sandbox-009'))
  })

  it('requires a lower-case owner address with a real @', () => {
    for (const email of ['User-A@example.com', 'user-a.example.com', '@example.com', 'user-a@', `${'a'.repeat(250)}@example.com`, ''])
      rejects(() => item({ owner_email: email }))
    rejects(() => item({ owner_email: undefined }), 'NOT NULL')
  })

  it('checks environment and status', () => {
    rejects(() => item({ environment: 'development' }))
    rejects(() => item({ status: 'paused' }))
    rejects(() => item({ status: undefined }), 'NOT NULL')
    item({ environment: 'production' })
  })

  it('makes plaid_item_id unique and opaque-id shaped', () => {
    item()
    rejects(() => item({}, ITEM2, 'item-sandbox-001'), 'UNIQUE')
    for (const p of ['', 'a'.repeat(65), 'has space', 'bad/char', 'semi;colon']) rejects(() => item({}, ITEM2, p))
    item({}, ITEM2, 'a'.repeat(64))
  })

  it('checks institution_id and institution_name shapes', () => {
    for (const v of ['', 'a'.repeat(33), 'ins-dash', 'ins space']) rejects(() => item({ institution_id: v }))
    rejects(() => item({ institution_name: '' }))
    rejects(() => item({ institution_name: 'n'.repeat(81) }))
    item({ institution_name: 'n'.repeat(80), institution_id: 'a'.repeat(32) })
  })

  it('requires token material for active, needs_reconnect and pending_disconnect, and none for revoked and removed', () => {
    for (const status of ['active', 'needs_reconnect', 'pending_disconnect']) {
      rejects(() => item({ status, token_ct: null }))
      rejects(() => item({ status, token_iv: null }))
      rejects(() => item({ status, key_id: null }))
    }
    for (const status of ['revoked', 'removed']) {
      rejects(() => item({ status, ...NO_TOKEN, token_ct: 'Y2lwaGVy' }))
      rejects(() => item({ status, ...NO_TOKEN, token_iv: 'aXZpdml2aXZpaQ==' }))
      rejects(() => item({ status, ...NO_TOKEN, key_id: '0a1b2c3d' }))
      rejects(() => item({ status, ...NO_TOKEN, sync_cursor: 'cursor-abc' }))
    }
  })

  it('checks the token columns: base64 alphabet, 16-character iv, 8 lower-case hex key id, ciphertext length', () => {
    rejects(() => item({ token_ct: 'not base64!' }))
    rejects(() => item({ token_ct: '' }))
    rejects(() => item({ token_ct: 'A'.repeat(2049) }))
    item({ token_ct: 'A'.repeat(2048) })
    rejects(() => item({ token_iv: 'aXZpdml2aXZp' }, ITEM2, 'item-sandbox-002'))
    rejects(() => item({ token_iv: 'aXZpdml2aXZpaQ=!' }, ITEM2, 'item-sandbox-002'))
    for (const k of ['0A1B2C3D', '0a1b2c3', '0a1b2c3d4', '0a1b2c3g']) rejects(() => item({ key_id: k }, ITEM2, 'item-sandbox-002'))
  })

  it('checks the cursor length and the 0/1 flags', () => {
    rejects(() => item({ sync_cursor: '' }))
    rejects(() => item({ sync_cursor: 'c'.repeat(257) }))
    item({ sync_cursor: 'c'.repeat(256) })
    for (const col of ['initial_done', 'historical_done', 'new_accounts']) rejects(() => item({ [col]: 2 }, ITEM2, 'item-sandbox-002'))
  })

  it('needs consent_version >= 1, consented_at and both stamps', () => {
    rejects(() => item({ consent_version: 0 }))
    rejects(() => item({ consent_version: undefined }), 'NOT NULL')
    rejects(() => item({ consented_at: undefined }), 'NOT NULL')
    rejects(() => item({ created_at: undefined }), 'NOT NULL')
    rejects(() => item({ updated_at: undefined }), 'NOT NULL')
  })

  it('stores last_error only as a code: lower-case letters, digits and underscores, at most 40, not starting with a digit', () => {
    for (const code of ['Item_Login', 'item login', 'item-login', '1abc', '', 'a'.repeat(41), 'item_login_required!']) rejects(() => item({ last_error: code }))
    item({ last_error: 'a'.repeat(40) })
  })
})

describe('plaid_slot_log', () => {
  it('accepts plain inserts and prior rows', () => {
    slot()
    slot({ status: 'prior', plaid_item_id: 'item-prior-001', institution_id: 'ins_prior_1' })
    slot({ environment: 'production', status: 'prior' })
    expect(count(db, 'plaid_slot_log')).toBe(3)
  })

  it('checks environment, status, ids and created_by', () => {
    rejects(() => slot({ environment: 'development' }))
    rejects(() => slot({ status: 'finished' }))
    rejects(() => slot({ created_by: '' }))
    rejects(() => slot({ created_by: 'x'.repeat(255) }))
    rejects(() => slot({ created_by: undefined }), 'NOT NULL')
    rejects(() => slot({ created_at: undefined }), 'NOT NULL')
    rejects(() => slot({ plaid_item_id: 'bad id' }))
    rejects(() => slot({ plaid_item_id: 'a'.repeat(65) }))
    rejects(() => slot({ institution_id: 'ins-dash' }))
  })

  it('refuses every DELETE and leaves the row', () => {
    slot({ id: 1 })
    refused(() => db.sqlite.exec('DELETE FROM plaid_slot_log WHERE id = 1'), 'plaid_slot_log is append-only')
    refused(() => db.sqlite.exec('DELETE FROM plaid_slot_log'), 'plaid_slot_log is append-only')
    expect(count(db, 'plaid_slot_log')).toBe(1)
  })

  it('lets a row move from pending to done or failed, changing only status, plaid_item_id, institution_id and finished_at', () => {
    slot({ id: 1 })
    slot({ id: 2 })
    db.sqlite.exec(`UPDATE plaid_slot_log SET status = 'done', plaid_item_id = 'item-sandbox-001', institution_id = 'ins_sandbox_1', finished_at = '${NOW}' WHERE id = 1`)
    db.sqlite.exec(`UPDATE plaid_slot_log SET status = 'failed', finished_at = '${NOW}' WHERE id = 2`)
    expect(db.all('SELECT id, status, plaid_item_id, institution_id, finished_at, created_at, created_by FROM plaid_slot_log ORDER BY id')).toEqual([
      { id: 1, status: 'done', plaid_item_id: 'item-sandbox-001', institution_id: 'ins_sandbox_1', finished_at: NOW, created_at: NOW, created_by: 'user-a@example.com' },
      { id: 2, status: 'failed', plaid_item_id: null, institution_id: null, finished_at: NOW, created_at: NOW, created_by: 'user-a@example.com' },
    ])
  })

  it('refuses every other update: a finished row never moves, a pending row cannot stay pending or become prior, key fields are fixed', () => {
    const msg = 'rows only move from pending to done or failed'
    slot({ id: 1 })
    slot({ id: 2, status: 'prior' })
    slot({ id: 3 })
    db.sqlite.exec(`UPDATE plaid_slot_log SET status = 'done' WHERE id = 3`)
    slot({ id: 4 })
    db.sqlite.exec(`UPDATE plaid_slot_log SET status = 'failed' WHERE id = 4`)
    refused(() => db.sqlite.exec(`UPDATE plaid_slot_log SET status = 'failed' WHERE id = 3`), msg)
    refused(() => db.sqlite.exec(`UPDATE plaid_slot_log SET status = 'pending' WHERE id = 3`), msg)
    refused(() => db.sqlite.exec(`UPDATE plaid_slot_log SET status = 'done' WHERE id = 4`), msg)
    refused(() => db.sqlite.exec(`UPDATE plaid_slot_log SET status = 'done' WHERE id = 2`), msg)
    refused(() => db.sqlite.exec(`UPDATE plaid_slot_log SET finished_at = '${NOW}' WHERE id = 3`), msg)
    refused(() => db.sqlite.exec(`UPDATE plaid_slot_log SET status = 'pending' WHERE id = 1`), msg)
    refused(() => db.sqlite.exec(`UPDATE plaid_slot_log SET status = 'prior' WHERE id = 1`), msg)
    refused(() => db.sqlite.exec(`UPDATE plaid_slot_log SET status = 'done', environment = 'production' WHERE id = 1`), msg)
    refused(() => db.sqlite.exec(`UPDATE plaid_slot_log SET status = 'done', created_at = '2020-01-01T00:00:00.000Z' WHERE id = 1`), msg)
    refused(() => db.sqlite.exec(`UPDATE plaid_slot_log SET status = 'done', created_by = 'someone@example.com' WHERE id = 1`), msg)
    refused(() => db.sqlite.exec(`UPDATE plaid_slot_log SET status = 'done', id = 99 WHERE id = 1`), msg)
    expect(db.get('SELECT status, environment, created_at, created_by FROM plaid_slot_log WHERE id = 1')).toEqual({ status: 'pending', environment: 'sandbox', created_at: NOW, created_by: 'user-a@example.com' })
  })

  it('refuses REPLACE, INSERT OR REPLACE and INSERT OR IGNORE on an existing id, with the row unchanged', () => {
    slot({ id: 7, created_by: 'first@example.com' })
    const before = db.all('SELECT * FROM plaid_slot_log')
    const msg = 'plaid_slot_log ids are never reused'
    const vals = `(7, 'production', 'done', '${NOW}', 'second@example.com')`
    const cols = '(id, environment, status, created_at, created_by)'
    refused(() => db.sqlite.exec(`REPLACE INTO plaid_slot_log ${cols} VALUES ${vals}`), msg)
    refused(() => db.sqlite.exec(`INSERT OR REPLACE INTO plaid_slot_log ${cols} VALUES ${vals}`), msg)
    refused(() => db.sqlite.exec(`INSERT OR IGNORE INTO plaid_slot_log ${cols} VALUES ${vals}`), msg)
    refused(() => db.sqlite.exec(`INSERT INTO plaid_slot_log ${cols} VALUES ${vals}`), msg)
    expect(db.all('SELECT * FROM plaid_slot_log')).toEqual(before)
  })

  it('still takes new ids: plain inserts (auto id) and prior rows after other rows exist', () => {
    slot({ id: 1 })
    slot()
    slot({ status: 'prior' })
    slot({ id: 50 })
    expect(db.all<{ id: number }>('SELECT id FROM plaid_slot_log ORDER BY id').map((r) => r.id)).toEqual([1, 2, 3, 50])
  })
})

describe('bank_accounts', () => {
  beforeEach(() => item())

  it('accepts a bare row, a fully described one and a mapped one', () => {
    bacct()
    budgetAccount(db, 'acct-bank-1')
    bacct({ mask: '0001', subtype: 'credit card', sync: 'on', account_id: 'acct-bank-1', sync_from: '2026-11-01', balance_cents: -12345, available_cents: 50000, limit_cents: 100000, balance_as_of: NOW }, BA2, 'acc-sandbox-002')
    expect(db.get('SELECT sync FROM bank_accounts WHERE id = ?', BA1)).toEqual({ sync: 'unmapped' })
    expect(count(db, 'bank_accounts')).toBe(2)
  })

  it('rejects bad ids and bad plaid_account_id, and makes plaid_account_id unique', () => {
    for (const id of ['x0123456789abcdef', 'b0123456789abcde', 'b0123456789abcdef0', 'b0123456789abcdeg', 'b0123456789ABCDEF', '']) rejects(() => bacct({}, id))
    for (const p of ['', 'a'.repeat(65), 'has space', 'bad/char']) rejects(() => bacct({}, BA1, p))
    bacct()
    rejects(() => bacct({}, BA2, 'acc-sandbox-001'), 'UNIQUE')
  })

  it('requires a name of 1 to 80 characters', () => {
    rejects(() => bacct({ name: '' }))
    rejects(() => bacct({ name: 'n'.repeat(81) }))
    rejects(() => bacct({ name: undefined }), 'NOT NULL')
    bacct({ name: 'n'.repeat(80) })
  })

  it('keeps the mask to exactly 4 digits or NULL', () => {
    for (const m of ['12345', '123', 'abcd', '12a4', '', ' 123']) rejects(() => bacct({ mask: m }))
    bacct({ mask: '0001' })
    bacct({ mask: null }, BA2, 'acc-sandbox-002')
  })

  it('checks type, subtype and sync', () => {
    rejects(() => bacct({ type: 'brokerage' }))
    rejects(() => bacct({ type: undefined }), 'NOT NULL')
    ;['depository', 'credit', 'loan', 'investment', 'other'].forEach((t, i) => bacct({ type: t }, `b${String(i).repeat(16)}`, `acc-type-${t}`))
    for (const s of ['Checking', 'credit*card', '', 's'.repeat(41)]) rejects(() => bacct({ subtype: s }, BA2, 'acc-sandbox-002'))
    rejects(() => bacct({ sync: 'maybe' }, BA2, 'acc-sandbox-002'))
  })

  it("requires an account_id when sync = 'on'", () => {
    rejects(() => bacct({ sync: 'on' }))
    rejects(() => bacct({ sync: 'on', account_id: null }))
    budgetAccount(db, 'acct-bank-1')
    bacct({ sync: 'on', account_id: 'acct-bank-1' })
    bacct({ sync: 'off', account_id: 'acct-bank-1' }, BA2, 'acc-sandbox-002')
    bacct({ sync: 'off' }, 'b1111111111111111', 'acc-sandbox-003')
  })

  it('allows one feed per Budget account: a second sync = on mapping is a UNIQUE violation', () => {
    budgetAccount(db, 'acct-bank-1')
    budgetAccount(db, 'acct-bank-2')
    bacct({ sync: 'on', account_id: 'acct-bank-1' })
    rejects(() => bacct({ sync: 'on', account_id: 'acct-bank-1' }, BA2, 'acc-sandbox-002'), 'UNIQUE')
    bacct({ sync: 'on', account_id: 'acct-bank-2' }, BA2, 'acc-sandbox-002')
    // an off row on a taken account is fine, and so is turning it on only after the other is off
    bacct({ sync: 'off', account_id: 'acct-bank-1' }, 'b1111111111111111', 'acc-sandbox-003')
    rejects(() => db.sqlite.exec(`UPDATE bank_accounts SET sync = 'on' WHERE id = 'b1111111111111111'`), 'UNIQUE')
    db.sqlite.exec(`UPDATE bank_accounts SET sync = 'off' WHERE id = '${BA1}'`)
    db.sqlite.exec(`UPDATE bank_accounts SET sync = 'on' WHERE id = 'b1111111111111111'`)
  })

  it('checks sync_from as a real calendar date', () => {
    for (const d of ['2026-13-01', '2026-02-30', '26-01-01', '2026-1-01', '2026/01/01', '2026-01-01T00:00:00Z', '']) rejects(() => bacct({ sync_from: d }))
    bacct({ sync_from: '2028-02-29' })
  })

  it('stores balances as integer cents within range, and a limit that is not negative', () => {
    for (const col of ['balance_cents', 'available_cents', 'limit_cents']) {
      rejects(() => bacct({ [col]: 1.5 }))
      rejects(() => bacct({ [col]: 'abc' }))
      rejects(() => bacct({ [col]: 10000000001 }))
    }
    rejects(() => bacct({ balance_cents: -10000000001 }))
    rejects(() => bacct({ available_cents: -10000000001 }))
    rejects(() => bacct({ limit_cents: -1 }))
    bacct({ balance_cents: -10000000000, available_cents: 10000000000, limit_cents: 0 })
  })
})

describe('bank_txns', () => {
  let t1: string
  let t2: string
  beforeEach(() => {
    item(); bacct(); bacct({}, BA2, 'acc-sandbox-002')
    t1 = insertTxn(db); t2 = insertTxn(db)
  })

  it('accepts an inserted row, a matched row, and inserted rows that are dropped or kept', () => {
    const t3 = insertTxn(db); const t4 = insertTxn(db)
    btxn(t1)
    btxn(t2, { role: 'matched' }, 'ptx-sandbox-002')
    btxn(t3, { state: 'dropped' }, 'ptx-sandbox-003')
    btxn(t4, { state: 'kept' }, 'ptx-sandbox-004')
    expect(db.all('SELECT role, state FROM bank_txns ORDER BY plaid_txn_id')).toEqual([
      { role: 'inserted', state: 'live' }, { role: 'matched', state: 'live' }, { role: 'inserted', state: 'dropped' }, { role: 'inserted', state: 'kept' },
    ])
  })

  it('checks the Plaid id shape and that it is unique', () => {
    for (const p of ['', 'a'.repeat(65), 'has space', 'bad/char']) rejects(() => btxn(t1, {}, p))
    btxn(t1)
    rejects(() => btxn(t2, {}), 'UNIQUE')
  })

  it('checks role and state, and that only an inserted row can be dropped or kept', () => {
    rejects(() => btxn(t1, { role: 'claimed' }))
    rejects(() => btxn(t1, { state: 'gone' }))
    rejects(() => btxn(t1, { role: 'matched', state: 'dropped' }))
    rejects(() => btxn(t1, { role: 'matched', state: 'kept' }))
    rejects(() => btxn(t1, { seen_at: undefined }), 'NOT NULL')
    rejects(() => btxn(t1, { updated_at: undefined }), 'NOT NULL')
  })

  it('allows dup_of only on an inserted row, and never on its own transaction', () => {
    btxn(t1, { dup_of: t2 })
    rejects(() => btxn(t2, { dup_of: t1, role: 'matched' }, 'ptx-sandbox-002'))
    rejects(() => btxn(t2, { dup_of: t2 }, 'ptx-sandbox-002'))
    rejects(() => btxn(t2, { dup_of: testNoTxn() }, 'ptx-sandbox-002'), 'FOREIGN KEY')
  })

  it('makes a Budget row claimable once (idx_bank_txn_txn) and needs real parents', () => {
    btxn(t1)
    rejects(() => btxn(t1, {}, 'ptx-sandbox-002', BA2), 'UNIQUE')
    rejects(() => btxn(testNoTxn(), {}, 'ptx-sandbox-002'), 'FOREIGN KEY')
    rejects(() => btxn(t2, {}, 'ptx-sandbox-002', 'b9999999999999999'), 'FOREIGN KEY')
  })
})

/** A syntactically fine transaction id that is not in the table. */
const testNoTxn = (): string => 'f'.repeat(32)

describe('bank_liabilities', () => {
  beforeEach(() => { item(); bacct() })

  it('accepts a bare row and a fully described one, one per bank account', () => {
    liab()
    bacct({}, BA2, 'acc-sandbox-002')
    liab({
      kind: 'mortgage', apr_bp: 625, min_due_cents: 0, next_due_date: '2026-12-01', last_statement_date: '2026-11-01', last_statement_balance_cents: -1500000,
      last_payment_cents: 90000, last_payment_date: '2026-11-03', is_overdue: 0, past_due_cents: 0, next_monthly_payment_cents: 90000, escrow_cents: 40000,
      origination_date: '2020-01-15', origination_cents: 20000000, maturity_date: '2050-01-15', expected_payoff_date: '2049-12-01', ytd_interest_cents: 100000, ytd_principal_cents: 50000,
    }, BA2)
    expect(count(db, 'bank_liabilities')).toBe(2)
  })

  it('checks kind, the rate range, the dates and the 0/1 flag, and takes one row per account', () => {
    rejects(() => liab({ kind: 'auto' }))
    rejects(() => liab({ apr_bp: -1 }))
    rejects(() => liab({ apr_bp: 10001 }))
    for (const col of ['next_due_date', 'last_statement_date', 'last_payment_date', 'origination_date', 'maturity_date', 'expected_payoff_date']) {
      rejects(() => liab({ [col]: '2026-02-30' }))
      rejects(() => liab({ [col]: '26-01-01' }))
    }
    rejects(() => liab({ is_overdue: 2 }))
    rejects(() => liab({ fetched_at: undefined }), 'NOT NULL')
    liab({ apr_bp: 10000, is_overdue: 1 })
    rejects(() => liab({}), 'UNIQUE')
  })

  it('stores money as non-negative integer cents (the statement balance may be negative)', () => {
    for (const col of ['min_due_cents', 'last_payment_cents', 'past_due_cents', 'next_monthly_payment_cents', 'escrow_cents', 'origination_cents', 'ytd_interest_cents', 'ytd_principal_cents']) {
      rejects(() => liab({ [col]: -1 }))
      rejects(() => liab({ [col]: 1.5 }))
      rejects(() => liab({ [col]: 10000000001 }))
    }
    rejects(() => liab({ last_statement_balance_cents: 1.5 }))
    rejects(() => liab({ last_statement_balance_cents: -10000000001 }))
    liab({ last_statement_balance_cents: -10000000000 })
  })
})

describe('bank_sync_runs', () => {
  beforeEach(() => item())

  it('accepts a run and checks run_trigger, counters, error_code and the parent', () => {
    run()
    for (const t of ['webhook', 'cron', 'manual', 'initial', 'resync']) run({ run_trigger: t })
    run({ finished_at: NOW, pages: 3, added: 12, modified: 2, removed: 1, inserted: 9, matched: 2, flagged: 1, posted: 1, dropped: 0, skipped: 3, error_code: 'sync_failed' })
    rejects(() => run({ run_trigger: 'hand' }))
    for (const col of ['pages', 'added', 'modified', 'removed', 'inserted', 'matched', 'flagged', 'posted', 'dropped', 'skipped']) rejects(() => run({ [col]: -1 }))
    for (const code of ['Bad Code', '', '1abc', 'a'.repeat(41), 'code-x']) rejects(() => run({ error_code: code }))
    rejects(() => run({ item_id: 'i9999999999999999' }), 'FOREIGN KEY')
    rejects(() => run({ started_at: undefined }), 'NOT NULL')
    expect(count(db, 'bank_sync_runs')).toBe(7)
  })
})

describe('indexes the cron and the sync rely on', () => {
  const plan = (sql: string, values: unknown[] = []): string => db.explain(sql, values).join(' | ')

  it('the due pick (4.1) searches idx_bank_items_due', () => {
    const p = plan(
      `SELECT id FROM bank_items WHERE status IN ('active','pending_disconnect') AND (sync_requested_at IS NOT NULL OR last_ok_at IS NULL OR last_ok_at < ?) ORDER BY sync_requested_at IS NULL, sync_requested_at LIMIT 3`,
      ['2026-12-04T14:00:00.000Z'],
    )
    expect(p).toContain('idx_bank_items_due')
  })

  it('the daily needs_reconnect check (4.1) searches idx_bank_items_due', () => {
    const p = plan(`SELECT id FROM bank_items WHERE status = 'needs_reconnect' AND (last_sync_at IS NULL OR last_sync_at < ?) LIMIT 3`, ['2026-12-04T10:00:00.000Z'])
    expect(p).toContain('idx_bank_items_due')
  })

  it('bank_txns by the Budget row, by Plaid id, and by account use an index', () => {
    expect(plan('SELECT plaid_txn_id FROM bank_txns WHERE txn_id = ?', [testNoTxn()])).toContain('idx_bank_txn_txn')
    expect(plan('SELECT txn_id FROM bank_txns WHERE plaid_txn_id IN (?, ?)', ['a', 'b'])).toMatch(/SEARCH bank_txns USING (INDEX sqlite_autoindex_bank_txns_1|PRIMARY KEY)/)
    expect(plan('SELECT plaid_txn_id FROM bank_txns WHERE bank_account_id = ?', [BA1])).toContain('idx_bank_txn_acct')
    expect(plan('SELECT plaid_txn_id FROM bank_txns WHERE dup_of = ?', [testNoTxn()])).toContain('idx_bank_txn_dup')
  })

  it('the dropped list uses the partial idx_bank_txn_dropped', () => {
    expect(plan(`SELECT plaid_txn_id, txn_id FROM bank_txns WHERE state = 'dropped' AND bank_account_id IN (?, ?)`, [BA1, BA2])).toContain('idx_bank_txn_dropped')
  })

  it('the on-account lookup searches an index (the partial idx_bank_acct_on, or the plain account index)', () => {
    expect(plan(`SELECT id FROM bank_accounts WHERE account_id = ? AND sync = 'on'`, ['acct-bank-1'])).toMatch(/idx_bank_acct_(on|budget)/)
    expect(plan('SELECT id FROM bank_accounts WHERE item_id = ?', [ITEM])).toContain('idx_bank_acct_item')
  })

  it('the 4.4 boundary-candidate query searches idx_txn_account', () => {
    const p = plan(
      `SELECT id, posted_date, amount_cents FROM transactions t WHERE account_id = ? AND posted_date BETWEEN date(?,'-3 days') AND date(?,'+3 days') AND NOT EXISTS (SELECT 1 FROM bank_txns b WHERE b.txn_id = t.id)`,
      ['chk-a', '2026-11-10', '2026-11-10'],
    )
    expect(p).toContain('idx_txn_account')
    expect(p).toContain('idx_bank_txn_txn')
  })

  it('the newest runs of an item read idx_bank_runs_item without a sort', () => {
    const p = plan('SELECT * FROM bank_sync_runs WHERE item_id = ? ORDER BY id DESC LIMIT 200', [ITEM])
    expect(p).toContain('idx_bank_runs_item')
    expect(p).not.toContain('TEMP B-TREE')
  })
})

describe('foreign key actions', () => {
  /** Two items, each with an account, a mapping, a liability snapshot and a run, plus a second mapping that points at the first via dup_of. */
  function populate(): { t1: string; t2: string; t3: string } {
    item(); item({}, ITEM2, 'item-sandbox-002')
    budgetAccount(db, 'acct-bank-1')
    bacct({ account_id: 'acct-bank-1', sync: 'off' }); bacct({}, BA2, 'acc-sandbox-002', ITEM2)
    const t1 = insertTxn(db); const t2 = insertTxn(db); const t3 = insertTxn(db)
    btxn(t1, { dup_of: t3 }); btxn(t2, {}, 'ptx-sandbox-002', BA2); btxn(t3, { role: 'matched' }, 'ptx-sandbox-003')
    liab({}, BA1); liab({}, BA2)
    run({}, ITEM); run({}, ITEM2)
    return { t1, t2, t3 }
  }
  const counts = (): Record<string, number> => Object.fromEntries(['bank_items', 'bank_accounts', 'bank_txns', 'bank_liabilities', 'bank_sync_runs'].map((t) => [t, count(db, t)]))

  it('deleting an item removes its accounts, mappings, liabilities and runs, and nothing else', () => {
    const { t1, t2 } = populate()
    const txnsBefore = count(db, 'transactions')
    db.sqlite.exec(`DELETE FROM bank_items WHERE id = '${ITEM}'`)
    expect(counts()).toEqual({ bank_items: 1, bank_accounts: 1, bank_txns: 1, bank_liabilities: 1, bank_sync_runs: 1 })
    expect(count(db, 'transactions')).toBe(txnsBefore)
    expect(db.get('SELECT 1 AS x FROM transactions WHERE id = ?', t1)).toEqual({ x: 1 })
    expect(db.get('SELECT txn_id FROM bank_txns')).toEqual({ txn_id: t2 })
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])
  })

  it('deleting a transaction removes its mapping and clears dup_of on mappings that pointed at it', () => {
    const { t1, t3 } = populate()
    db.sqlite.prepare('DELETE FROM transactions WHERE id = ?').run(t3)
    expect(db.get('SELECT 1 AS x FROM bank_txns WHERE txn_id = ?', t3)).toBeUndefined()
    expect(db.get('SELECT dup_of FROM bank_txns WHERE txn_id = ?', t1)).toEqual({ dup_of: null })
    db.sqlite.prepare('DELETE FROM transactions WHERE id = ?').run(t1)
    expect(db.get('SELECT 1 AS x FROM bank_txns WHERE txn_id = ?', t1)).toBeUndefined()
    expect(count(db, 'bank_txns')).toBe(1)
  })

  it('deleting a Budget account clears account_id on a bank account that is not syncing into it', () => {
    populate()
    expect(db.get('SELECT account_id FROM bank_accounts WHERE id = ?', BA1)).toEqual({ account_id: 'acct-bank-1' })
    db.sqlite.exec(`DELETE FROM accounts WHERE id = 'acct-bank-1'`)
    expect(db.get('SELECT account_id, sync FROM bank_accounts WHERE id = ?', BA1)).toEqual({ account_id: null, sync: 'off' })
    expect(count(db, 'bank_accounts')).toBe(2)
  })

  it("deleting a Budget account that a bank account syncs into is refused (SET NULL would break CHECK sync <> 'on' OR account_id IS NOT NULL)", () => {
    populate()
    db.sqlite.exec(`UPDATE bank_accounts SET sync = 'on' WHERE id = '${BA1}'`)
    rejects(() => db.sqlite.exec(`DELETE FROM accounts WHERE id = 'acct-bank-1'`))
    expect(db.get('SELECT account_id, sync FROM bank_accounts WHERE id = ?', BA1)).toEqual({ account_id: 'acct-bank-1', sync: 'on' })
    expect(db.get('SELECT 1 AS x FROM accounts WHERE id = ?', 'acct-bank-1')).toEqual({ x: 1 })
  })

  it('deleting a bank account removes its mappings and liability but not its Budget rows', () => {
    const { t1 } = populate()
    db.sqlite.exec(`DELETE FROM bank_accounts WHERE id = '${BA1}'`)
    expect(counts()).toMatchObject({ bank_accounts: 1, bank_txns: 1, bank_liabilities: 1, bank_sync_runs: 2 })
    expect(db.get('SELECT 1 AS x FROM transactions WHERE id = ?', t1)).toEqual({ x: 1 })
  })

  it('the slot log has no foreign key: deleting an item leaves its slot row', () => {
    item()
    slot({ status: 'done', plaid_item_id: 'item-sandbox-001' })
    db.sqlite.exec(`DELETE FROM bank_items WHERE id = '${ITEM}'`)
    expect(count(db, 'plaid_slot_log')).toBe(1)
  })
})

describe('0005 over an existing database', () => {
  const objects = (d: DatabaseSync): Row[] =>
    d.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as Row[]
  const dump = (d: DatabaseSync, tables: string[]): Record<string, unknown[]> =>
    Object.fromEntries(tables.map((t) => [t, d.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]))

  async function upTo4(): Promise<DatabaseSync> {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    d.exec(M1); d.exec(M2); d.exec(M3); d.exec(M4)
    d.exec(await seedFor0004())
    return d
  }

  it('is additive: six tables, nine indexes, three triggers, one defaulted column; every existing row gets pending = 0 and nothing else changes', async () => {
    const d = await upTo4()
    const before = objects(d)
    const beforeNames = new Set(before.map((o) => o.name))
    const tables = before.filter((o) => o.type === 'table').map((o) => String(o.name))
    const rows = dump(d, tables.filter((t) => t !== 'transactions'))
    const txnRows = d.prepare('SELECT * FROM transactions ORDER BY id').all() as Row[]
    expect(txnRows.length).toBeGreaterThan(0)
    d.exec(M5)
    const after = objects(d)
    // existing objects are identical except the transactions table text, which gains the column
    expect(after.filter((o) => beforeNames.has(o.name as string) && o.name !== 'transactions')).toEqual(before.filter((o) => o.name !== 'transactions'))
    const txnSql = String(after.find((o) => o.name === 'transactions')?.sql)
    expect(txnSql).toContain('pending INTEGER NOT NULL DEFAULT 0')
    const added = after.filter((o) => !beforeNames.has(o.name as string))
    expect(added.filter((o) => o.type === 'table').map((o) => o.name).sort()).toEqual([...NEW_TABLES].sort())
    expect(added.filter((o) => o.type === 'index').map((o) => o.name).sort()).toEqual([...NEW_INDEXES].sort())
    expect(added.filter((o) => o.type === 'trigger').map((o) => o.name).sort()).toEqual([...NEW_TRIGGERS].sort())
    expect(added).toHaveLength(NEW_TABLES.length + NEW_INDEXES.length + NEW_TRIGGERS.length)
    expect(dump(d, tables.filter((t) => t !== 'transactions'))).toEqual(rows)
    const txnAfter = d.prepare('SELECT * FROM transactions ORDER BY id').all() as Row[]
    expect(txnAfter).toHaveLength(txnRows.length)
    expect(txnAfter.every((r) => r.pending === 0)).toBe(true)
    expect(txnAfter.map(({ pending: _p, ...rest }) => rest)).toEqual(txnRows)
    expect(d.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('an insert that names its columns without pending (the deployed load) still works and lands pending = 0', async () => {
    const d = await upTo4()
    d.exec(M5)
    const tdb = { sqlite: d } as unknown as FakeBudgetDb
    const id = insertTxn(tdb)
    expect(d.prepare('SELECT pending FROM transactions WHERE id = ?').get(id)).toEqual({ pending: 0 })
    expect(() => d.exec(`UPDATE transactions SET pending = 2 WHERE id = '${id}'`)).toThrow(/CHECK constraint failed/)
    d.exec(`UPDATE transactions SET pending = 1 WHERE id = '${id}'`)
  })

  it('refuses a second apply on top of itself (nothing is silently skipped)', async () => {
    const d = await upTo4()
    d.exec(M5)
    expect(() => d.exec(M5)).toThrow(/already exists/)
  })

  it('names no private data: no addresses or merchant names in the file outside comments', () => {
    const code = M5.replace(/--.*$/gm, '')
    expect(code).not.toMatch(/@[a-z0-9-]+\./i)
    expect(code).not.toMatch(/\b(walmart|target|costco|netflix|spotify|uber|doordash)\b/i)
  })
})

describe('rollback and re-apply', () => {
  /** The rollback statements, taken from the migration's own comment block (the "ONE batch" list) so the two cannot drift apart. */
  function rollbackStatements(): string[] {
    const lines = M5.split('\n')
    const start = lines.findIndex((l) => l.includes('ONE batch'))
    expect(start).toBeGreaterThan(0)
    const stmts = lines.slice(start).filter((l) => /^--\s+(DROP|ALTER|DELETE) /.test(l)).map((l) => l.replace(/^--\s+/, '').trim())
    expect(stmts.length).toBeGreaterThan(0)
    return stmts
  }

  const bankObjects = (d: DatabaseSync): string[] =>
    (d.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'bank\\_%' ESCAPE '\\' OR name LIKE 'idx\\_bank\\_%' ESCAPE '\\' OR name LIKE 'plaid\\_%' ESCAPE '\\' OR name LIKE 'trg\\_slot\\_%' ESCAPE '\\'`).all() as { name: string }[]).map((r) => r.name)
  const hasPending = (d: DatabaseSync): boolean => (d.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('transactions') WHERE name = 'pending'`).get() as { n: number }).n === 1

  it('drops exactly the six tables (indexes and triggers go with them) and the column, children first, as one batch, and un-records the migration', async () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    d.exec(M1); d.exec(M2); d.exec(M3); d.exec(M4)
    d.exec(await seedFor0004())
    const base = d.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all()
    const tx = (d.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n
    d.exec(M5)
    d.exec(`CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`)
    d.exec(`INSERT INTO d1_migrations (name) VALUES ('0004_receipts.sql'), ('0005_bank_links.sql')`)
    // populate every new table so each DROP meets real rows and live foreign keys
    const txn = (d.prepare('SELECT id FROM transactions LIMIT 1').get() as { id: string }).id
    d.exec(`INSERT INTO bank_items (id, owner_email, environment, plaid_item_id, status, token_ct, token_iv, key_id, consent_version, consented_at, created_at, updated_at)
            VALUES ('${ITEM}', 'user-a@example.com', 'sandbox', 'item-sandbox-001', 'active', 'Y2lwaGVy', 'aXZpdml2aXZpaQ==', '0a1b2c3d', 1, '${NOW}', '${NOW}', '${NOW}')`)
    d.exec(`INSERT INTO bank_accounts (id, item_id, plaid_account_id, name, type, created_at, updated_at) VALUES ('${BA1}', '${ITEM}', 'acc-sandbox-001', 'Everyday Checking', 'depository', '${NOW}', '${NOW}')`)
    d.exec(`INSERT INTO bank_txns (plaid_txn_id, bank_account_id, txn_id, role, seen_at, updated_at) VALUES ('ptx-sandbox-001', '${BA1}', '${txn}', 'matched', '${NOW}', '${NOW}')`)
    d.exec(`INSERT INTO bank_liabilities (bank_account_id, kind, fetched_at) VALUES ('${BA1}', 'credit', '${NOW}')`)
    d.exec(`INSERT INTO bank_sync_runs (item_id, run_trigger, started_at) VALUES ('${ITEM}', 'cron', '${NOW}')`)
    d.exec(`INSERT INTO plaid_slot_log (environment, status, created_at, created_by) VALUES ('sandbox', 'pending', '${NOW}', 'user-a@example.com')`)
    expect(bankObjects(d).length).toBe(NEW_TABLES.length + NEW_INDEXES.length + NEW_TRIGGERS.length)
    expect(hasPending(d)).toBe(true)

    const stmts = rollbackStatements()
    expect(stmts.filter((s) => s.startsWith('DROP TABLE')).map((s) => s.replace(/^DROP TABLE |;$/g, ''))).toEqual(
      ['bank_sync_runs', 'bank_liabilities', 'bank_txns', 'bank_accounts', 'plaid_slot_log', 'bank_items'],
    )
    expect(stmts).toContain('ALTER TABLE transactions DROP COLUMN pending;')
    expect(stmts.at(-1)).toContain(`DELETE FROM d1_migrations WHERE name = '0005_bank_links.sql'`)
    d.exec(`BEGIN;\n${stmts.join('\n')}\nCOMMIT;`)

    expect(bankObjects(d)).toEqual([])
    expect(hasPending(d)).toBe(false)
    expect(d.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY type, name`).all()).toEqual(base)
    expect((d.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(tx)
    expect(d.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).toEqual([{ name: '0004_receipts.sql' }])
    expect(d.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('applies again after a rollback, with every constraint and trigger live', () => {
    const d = new DatabaseSync(':memory:')
    d.exec('PRAGMA foreign_keys = ON')
    d.exec(M1); d.exec(M2); d.exec(M3); d.exec(M4)
    d.exec(M5)
    d.exec(`CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE)`)
    d.exec(`INSERT INTO d1_migrations (name) VALUES ('0005_bank_links.sql')`)
    d.exec(`BEGIN;\n${rollbackStatements().join('\n')}\nCOMMIT;`)
    expect(bankObjects(d)).toEqual([])
    d.exec(M5)
    expect(bankObjects(d).length).toBe(NEW_TABLES.length + NEW_INDEXES.length + NEW_TRIGGERS.length)
    expect(hasPending(d)).toBe(true)
    expect(() => d.exec(`INSERT INTO bank_items (id, owner_email, environment, plaid_item_id, status, consent_version, consented_at, created_at, updated_at)
      VALUES ('bad', 'a@example.com', 'sandbox', 'x', 'revoked', 1, '${NOW}', '${NOW}', '${NOW}')`)).toThrow(/CHECK constraint failed/)
    d.exec(`INSERT INTO plaid_slot_log (id, environment, status, created_at, created_by) VALUES (1, 'sandbox', 'pending', '${NOW}', 'x')`)
    expect(() => d.exec('DELETE FROM plaid_slot_log')).toThrow(/append-only/)
  })
})
