// migrations/gss-budget/0002_loans.sql against a real SQLite (node:sqlite, D1's dialect), with made-up values only.
// Covers: it applies on top of 0001 AND on top of a database that already holds rows (the shared Preview/Production
// file), it changes nothing that exists, every new constraint rejects bad values, and the rollback block in the file works.
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import { planImport } from './import'
import { renderPlanSql } from './sqlFile'
import { emptyContext, syntheticRequest, withoutBankGuard } from './__fixtures__/synthetic'

const M1 = readFileSync('migrations/gss-budget/0001_init.sql', 'utf8')
const M2 = readFileSync('migrations/gss-budget/0002_loans.sql', 'utf8')
const NOW = '2026-12-05T10:00:00.000Z'

let seedSql: string
beforeAll(async () => {
  seedSql = withoutBankGuard(renderPlanSql(await planImport(syntheticRequest('imp-loans-1', true), emptyContext(), 'tester@example.com', NOW)))
})

/** D1 enforces foreign keys, so the fake does too. */
const fresh = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}
const migrated = (): DatabaseSync => {
  const db = fresh()
  db.exec(M1)
  db.exec(M2)
  return db
}
/** Every row of every table, as text, in a stable order (a before/after fingerprint of existing data). */
const dump = (db: DatabaseSync, tables: string[]): Record<string, string> =>
  Object.fromEntries(tables.map((t) => [t, JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all())]))
const tableNames = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
const cols = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all() as { name: string }[]).map((r) => r.name)

const T = '2026-12-05T10:00:00.000Z'
const TERMS = `INSERT INTO debt_terms (account_id, updated_at, updated_by) VALUES ('loan-a', '${T}', 't@example.com')`
/** One valid debt_terms row with overrides, as `INSERT ... (cols) VALUES (...)`. */
const terms = (over: Record<string, string | number | null> = {}): string => {
  const row: Record<string, string | number | null> = { account_id: 'loan-a', updated_at: T, updated_by: 't@example.com', ...over }
  const vals = Object.values(row).map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`))
  return `INSERT INTO debt_terms (${Object.keys(row).join(', ')}) VALUES (${vals.join(', ')})`
}
const promo = (over: Record<string, string | number | null> = {}): string => {
  const row: Record<string, string | number | null> = { account_id: 'card-a', period_end: '2026-12-04', seq: 1, balance_cents: 12_345, ...over }
  const vals = Object.values(row).map((v) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v}'`))
  return `INSERT INTO statement_promos (${Object.keys(row).join(', ')}) VALUES (${vals.join(', ')})`
}
const stmtUpdate = (col: string, v: number | string | null): string =>
  `UPDATE statements SET ${col} = ${v === null ? 'NULL' : typeof v === 'number' ? v : `'${v}'`} WHERE account_id = 'card-a' AND period_end = '2026-12-04'`

describe('0002_loans.sql applied after 0001', () => {
  it('creates the new tables and the two statements columns, in file order after 0001', () => {
    const db = migrated()
    expect(tableNames(db)).toEqual(expect.arrayContaining(['debt_terms', 'statement_promos']))
    expect(cols(db, 'debt_terms')).toEqual(['account_id', 'original_cents', 'opened_on', 'maturity_on', 'term_months', 'payment_cents',
      'payment_every', 'cosigned', 'updated_at', 'updated_by'])
    expect(cols(db, 'statement_promos')).toEqual(['account_id', 'period_end', 'seq', 'balance_cents', 'apr_bp', 'ends_on', 'deferred_interest_cents'])
    const s = cols(db, 'statements')
    expect(s.slice(-2)).toEqual(['escrow_cents', 'payoff_cents'])
    const base = fresh()
    base.exec(M1)
    expect(s).toHaveLength(cols(base, 'statements').length + 2)
  })

  it('is additive: nothing 0001 made changes (tables, other columns, indexes)', () => {
    const base = fresh()
    base.exec(M1)
    const after = migrated()
    const sch = (db: DatabaseSync): { name: string; sql: string }[] =>
      db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('debt_terms','statement_promos','statements') ORDER BY name").all() as never
    expect(sch(after)).toEqual(sch(base))
    // statements gained exactly two columns; every older column keeps its position and type.
    const info = (db: DatabaseSync): unknown[] => db.prepare("SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('statements') ORDER BY cid").all()
    expect(info(after).slice(0, info(base).length)).toEqual(info(base))
    expect(info(after).slice(info(base).length)).toEqual([
      { cid: info(base).length, name: 'escrow_cents', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      { cid: info(base).length + 1, name: 'payoff_cents', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
    ])
  })

  it('applies to a database that already holds rows: every old row is unchanged, the new columns are NULL, no FK problem', () => {
    const db = fresh()
    db.exec(M1)
    db.exec(seedSql)
    const names = ['people', 'accounts', 'categories', 'imports', 'merchant_rules', 'transactions', 'category_edits', 'debt_balances']
    const before = dump(db, names)
    const stmtBefore = db.prepare('SELECT * FROM statements ORDER BY account_id, period_end').all() as Record<string, unknown>[]
    expect(stmtBefore.length).toBeGreaterThan(0)
    db.exec(M2)
    expect(dump(db, names)).toEqual(before)
    const stmtAfter = db.prepare('SELECT * FROM statements ORDER BY account_id, period_end').all() as Record<string, unknown>[]
    expect(stmtAfter).toHaveLength(stmtBefore.length)
    stmtAfter.forEach((r, i) => {
      const { escrow_cents, payoff_cents, ...old } = r
      expect(old).toEqual(stmtBefore[i])
      expect(escrow_cents).toBeNull()
      expect(payoff_cents).toBeNull()
    })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }])
    expect((db.prepare('SELECT COUNT(*) AS n FROM debt_terms').get() as { n: number }).n).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM statement_promos').get() as { n: number }).n).toBe(0)
  })

  it('the existing statement upsert (as the deployed code writes it) still works and leaves the new columns alone', () => {
    const db = migrated()
    db.exec(seedSql)
    db.exec(stmtUpdate('escrow_cents', 25_000))
    db.exec(stmtUpdate('payoff_cents', 480_000))
    // Re-running the same load (ON CONFLICT DO UPDATE of the 0001 columns only) must not touch them.
    db.exec(seedSql)
    const r = db.prepare("SELECT escrow_cents AS e, payoff_cents AS p FROM statements WHERE account_id = 'card-a' AND period_end = '2026-12-04'").get() as { e: number; p: number }
    expect(r).toEqual({ e: 25_000, p: 480_000 })
  })
})

describe('statements.escrow_cents and payoff_cents', () => {
  it('accept NULL, zero and a positive value; reject a negative one', () => {
    const db = migrated()
    db.exec(seedSql)
    for (const col of ['escrow_cents', 'payoff_cents']) {
      expect(() => db.exec(stmtUpdate(col, null))).not.toThrow()
      expect(() => db.exec(stmtUpdate(col, 0))).not.toThrow()
      expect(() => db.exec(stmtUpdate(col, 1_234_567))).not.toThrow()
      expect(() => db.exec(stmtUpdate(col, -1))).toThrow(/CHECK constraint failed/)
    }
  })
})

describe('debt_terms', () => {
  it('takes a minimal row, defaults cosigned to 0, and a full row', () => {
    const db = migrated()
    db.exec(seedSql)
    db.exec(TERMS)
    expect(db.prepare("SELECT cosigned AS c, payment_every AS e FROM debt_terms WHERE account_id = 'loan-a'").get()).toEqual({ c: 0, e: null })
    db.exec(terms({ account_id: 'mtg', original_cents: 30_000_000, opened_on: '2020-01-15', maturity_on: '2050-02-01', term_months: 360,
      payment_cents: 150_000, payment_every: 'biweekly', cosigned: 1 }))
    expect((db.prepare('SELECT COUNT(*) AS n FROM debt_terms').get() as { n: number }).n).toBe(2)
  })

  it('is one row per account (primary key)', () => {
    const db = migrated()
    db.exec(seedSql)
    db.exec(TERMS)
    expect(() => db.exec(TERMS)).toThrow(/UNIQUE constraint failed/)
  })

  it('needs a known account (foreign key) and a writer stamp (NOT NULL)', () => {
    const db = migrated()
    db.exec(seedSql)
    expect(() => db.exec(terms({ account_id: 'no-such' }))).toThrow(/FOREIGN KEY constraint failed/)
    expect(() => db.exec(`INSERT INTO debt_terms (account_id, updated_by) VALUES ('loan-a', 't')`)).toThrow(/NOT NULL constraint failed: debt_terms.updated_at/)
    expect(() => db.exec(`INSERT INTO debt_terms (account_id, updated_at) VALUES ('loan-a', '${T}')`)).toThrow(/NOT NULL constraint failed: debt_terms.updated_by/)
  })

  it('refuses an account that still has terms being deleted (foreign key, no cascade)', () => {
    const db = migrated()
    db.exec(seedSql)
    db.exec(TERMS)
    db.exec('PRAGMA foreign_keys = ON')
    expect(() => db.exec("DELETE FROM accounts WHERE id = 'loan-a'")).toThrow(/FOREIGN KEY constraint failed/)
  })

  it.each([
    ['original_cents', -1],
    ['term_months', 0],
    ['term_months', 481],
    ['payment_cents', -5],
    ['cosigned', 2],
    ['cosigned', -1],
    ['payment_every', 'weekly'],
    ['opened_on', '2020-1-5'],
    ['opened_on', 'yesterday'],
    ['maturity_on', '2050/02/01'],
  ] as Array<[string, string | number]>)('rejects %s = %s', (col, v) => {
    const db = migrated()
    db.exec(seedSql)
    const over: Record<string, string | number | null> = { [col]: v }
    if (col === 'payment_cents') over.payment_every = 'monthly'
    expect(() => db.exec(terms(over))).toThrow(/CHECK constraint failed/)
  })

  it('accepts the boundaries: term 1 and 480, payment 0, the three cadences', () => {
    const db = migrated()
    db.exec(seedSql)
    expect(() => db.exec(terms({ account_id: 'loan-a', term_months: 1 }))).not.toThrow()
    expect(() => db.exec(terms({ account_id: 'mtg', term_months: 480, payment_cents: 0, payment_every: 'monthly' }))).not.toThrow()
    expect(() => db.exec(terms({ account_id: 'store-card', payment_cents: 100, payment_every: 'semimonthly' }))).not.toThrow()
    expect(() => db.exec(terms({ account_id: 'card-a', payment_cents: 100, payment_every: 'biweekly' }))).not.toThrow()
  })

  it('a payment needs its cadence; a cadence alone is fine', () => {
    const db = migrated()
    db.exec(seedSql)
    expect(() => db.exec(terms({ payment_cents: 10_000 }))).toThrow(/CHECK constraint failed/)
    expect(() => db.exec(terms({ payment_every: 'monthly' }))).not.toThrow()
  })

  it('maturity is not before the opening date (equal is fine; either one alone is fine)', () => {
    const db = migrated()
    db.exec(seedSql)
    expect(() => db.exec(terms({ opened_on: '2030-01-02', maturity_on: '2030-01-01' }))).toThrow(/CHECK constraint failed/)
    expect(() => db.exec(terms({ opened_on: '2030-01-02', maturity_on: '2030-01-02' }))).not.toThrow()
    expect(() => db.exec(terms({ account_id: 'mtg', maturity_on: '2030-01-01' }))).not.toThrow()
    expect(() => db.exec(terms({ account_id: 'card-a', opened_on: '2030-01-01' }))).not.toThrow()
  })
})

describe('statement_promos', () => {
  it('takes a promo on an existing statement, minimal and full', () => {
    const db = migrated()
    db.exec(seedSql)
    db.exec(promo())
    db.exec(promo({ seq: 2, apr_bp: 0, ends_on: '2027-03-31', deferred_interest_cents: 4_200 }))
    expect(db.prepare('SELECT seq FROM statement_promos ORDER BY seq').all()).toEqual([{ seq: 1 }, { seq: 2 }])
  })

  it('its composite foreign key needs an existing (account, period_end) statement, and the primary key is (account, period_end, seq)', () => {
    const db = migrated()
    db.exec(seedSql)
    expect(() => db.exec(promo({ period_end: '2099-01-31' }))).toThrow(/FOREIGN KEY constraint failed/)
    // The account exists and has a statement, but not for that period_end: both columns must match one statement.
    expect(() => db.exec(promo({ account_id: 'card-a', period_end: '2026-11-30' }))).toThrow(/FOREIGN KEY constraint failed/)
    expect(() => db.exec(promo({ account_id: 'chk-a', period_end: '2026-12-04' }))).toThrow(/FOREIGN KEY constraint failed/)
    expect(() => db.exec(promo({ account_id: 'chk-a', period_end: '2026-11-30' }))).not.toThrow()
  })

  it('rejects a duplicate seq on one statement', () => {
    const db = migrated()
    db.exec(seedSql)
    db.exec(promo())
    expect(() => db.exec(promo())).toThrow(/UNIQUE constraint failed/)
  })

  it('refuses to delete a statement that has promos (NO ACTION), and an INSERT OR REPLACE of it keeps them (the key is back at statement end)', () => {
    const db = migrated()
    db.exec(seedSql)
    db.exec(promo())
    expect(() => db.exec("DELETE FROM statements WHERE account_id = 'card-a' AND period_end = '2026-12-04'")).toThrow(/FOREIGN KEY constraint failed/)
    db.exec(`INSERT OR REPLACE INTO statements (account_id, period_end, period_start) VALUES ('card-a', '2026-12-04', '2026-11-05')`)
    expect((db.prepare('SELECT COUNT(*) AS n FROM statement_promos').get() as { n: number }).n).toBe(1)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    // After the promos are deleted first (what the load does), the statement can go.
    db.exec("DELETE FROM statement_promos WHERE account_id = 'card-a'")
    expect(() => db.exec("DELETE FROM statements WHERE account_id = 'card-a' AND period_end = '2026-12-04'")).not.toThrow()
  })

  it.each([
    ['seq', 0],
    ['seq', 51],
    ['balance_cents', -1],
    ['apr_bp', -1],
    ['apr_bp', 10_001],
    ['deferred_interest_cents', -1],
    ['ends_on', '2027-3-1'],
    ['ends_on', 'soon'],
  ] as Array<[string, string | number]>)('rejects %s = %s', (col, v) => {
    const db = migrated()
    db.exec(seedSql)
    expect(() => db.exec(promo({ [col]: v }))).toThrow(/CHECK constraint failed/)
  })

  it('accepts the boundaries: seq 1 and 50, balance 0, apr 0 and 10000', () => {
    const db = migrated()
    db.exec(seedSql)
    expect(() => db.exec(promo({ seq: 1, balance_cents: 0, apr_bp: 0 }))).not.toThrow()
    expect(() => db.exec(promo({ seq: 50, apr_bp: 10_000 }))).not.toThrow()
  })

  it('needs a balance (NOT NULL)', () => {
    const db = migrated()
    db.exec(seedSql)
    expect(() => db.exec("INSERT INTO statement_promos (account_id, period_end, seq) VALUES ('card-a', '2026-12-04', 1)")).toThrow(/NOT NULL constraint failed/)
  })

  it('reads one statement\'s promos in seq order straight off the primary key (no extra index, no sort)', () => {
    const db = migrated()
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT * FROM statement_promos WHERE account_id = ? AND period_end = ? ORDER BY seq").all('card-a', '2026-11-30') as { detail: string }[])
      .map((r) => r.detail).join(' | ')
    expect(plan).toMatch(/SEARCH statement_promos USING PRIMARY KEY \(account_id=\? AND period_end=\?\)/)
    expect(plan).not.toMatch(/TEMP B-TREE/)
  })
})

describe('the rollback block in the file', () => {
  it('lists the four statements in an order that works, leaves a database equal to 0001 plus its data, and is safe to run on loaded data', () => {
    const rollback = M2.split(/\r?\n/).filter((l) => /^--\s{3}(DROP|ALTER)/.test(l)).map((l) => l.replace(/^--\s{3}/, ''))
    expect(rollback).toEqual([
      'DROP TABLE statement_promos;',
      'DROP TABLE debt_terms;',
      'ALTER TABLE statements DROP COLUMN payoff_cents;',
      'ALTER TABLE statements DROP COLUMN escrow_cents;',
    ])
    const db = migrated()
    db.exec(seedSql)
    db.exec(TERMS)
    db.exec(promo())
    db.exec(stmtUpdate('escrow_cents', 1))
    db.exec(rollback.join('\n'))
    const base = fresh()
    base.exec(M1)
    base.exec(seedSql)
    const sch = (d: DatabaseSync): string => JSON.stringify(d.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all())
    expect(sch(db)).toBe(sch(base))
    expect(cols(db, 'statements')).toEqual(cols(base, 'statements'))
    expect(dump(db, ['statements', 'accounts', 'transactions'])).toEqual(dump(base, ['statements', 'accounts', 'transactions']))
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('the migration can be re-applied only once (it is not idempotent by design: a second run fails cleanly, before changing anything)', () => {
    const db = migrated()
    expect(() => db.exec(M2)).toThrow(/already exists/)
  })
})
