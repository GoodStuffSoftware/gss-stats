// migrations/gss-budget/0003_included.sql against a real SQLite (node:sqlite, D1's dialect), with made-up values only.
// Covers: it applies on top of 0001 + 0002 and on a database that already holds rows, new rows default to included,
// the deployed code's old-shape INSERTs still work, the constraints, a re-import never resets an exclusion, and the rollback block
// (including un-recording the migration).
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import { planImport } from './import'
import { renderPlanSql } from './sqlFile'
import { emptyContext, syntheticRequest } from './__fixtures__/synthetic'

const M1 = readFileSync('migrations/gss-budget/0001_init.sql', 'utf8')
const M2 = readFileSync('migrations/gss-budget/0002_loans.sql', 'utf8')
const M3 = readFileSync('migrations/gss-budget/0003_included.sql', 'utf8')
const NOW = '2026-12-05T10:00:00.000Z'

let seedSql: string
beforeAll(async () => {
  seedSql = renderPlanSql(await planImport(syntheticRequest('imp-incl-1', true), emptyContext(), 'tool:test', NOW))
})

const fresh = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}
const upTo2 = (): DatabaseSync => {
  const db = fresh()
  db.exec(M1)
  db.exec(M2)
  return db
}
const migrated = (): DatabaseSync => {
  const db = upTo2()
  db.exec(M3)
  return db
}
const cols = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all() as { name: string }[]).map((r) => r.name)
const firstId = (db: DatabaseSync): string => (db.prepare('SELECT id FROM transactions ORDER BY id LIMIT 1').get() as { id: string }).id

describe('0003_included.sql applied after 0001 and 0002', () => {
  it('adds the included column last on transactions and the two audit columns last on category_edits', () => {
    const base = upTo2()
    const db = migrated()
    expect(cols(db, 'transactions')).toEqual([...cols(base, 'transactions'), 'included'])
    expect(cols(db, 'category_edits')).toEqual([...cols(base, 'category_edits'), 'old_included', 'new_included'])
  })

  it('applies to a database that already holds rows: every row becomes included, nothing else changes', () => {
    const db = upTo2()
    db.exec(seedSql)
    const n = (db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n
    expect(n).toBeGreaterThan(0)
    const before = JSON.stringify(db.prepare('SELECT * FROM transactions ORDER BY id').all())
    db.exec(M3)
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE included = 1').get() as { n: number }).n).toBe(n)
    const after = (db.prepare('SELECT * FROM transactions ORDER BY id').all() as Record<string, unknown>[]).map((r) => {
      const { included, ...rest } = r
      expect(included).toBe(1)
      return rest
    })
    expect(JSON.stringify(after)).toBe(before)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('the load as the deployed code writes it (no included column named) still works and defaults to included', () => {
    const db = migrated()
    db.exec(seedSql)
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE included = 1').get() as { n: number }).n)
      .toBe((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n)
    // An old-shape audit INSERT (no include columns) leaves them NULL.
    const id = firstId(db)
    db.exec(`INSERT INTO category_edits (txn_id, old_category_id, new_category_id, edited_at, edited_by) VALUES ('${id}', NULL, 'groceries', '${NOW}', 't@example.com')`)
    expect(db.prepare('SELECT old_included, new_included FROM category_edits').all()).toEqual([{ old_included: null, new_included: null }])
  })

  it('accepts 0 and 1 only, and never NULL', () => {
    const db = migrated()
    db.exec(seedSql)
    const id = firstId(db)
    for (const v of ['0', '1']) expect(() => db.exec(`UPDATE transactions SET included = ${v} WHERE id = '${id}'`)).not.toThrow()
    for (const v of ['2', '-1', 'NULL']) expect(() => db.exec(`UPDATE transactions SET included = ${v} WHERE id = '${id}'`)).toThrow(/constraint failed/)
    expect(() => db.exec(`INSERT INTO category_edits (txn_id, edited_at, edited_by, new_included) VALUES ('${id}', '${NOW}', 't@example.com', 2)`)).toThrow(/CHECK constraint failed/)
    expect(() => db.exec(`INSERT INTO category_edits (txn_id, edited_at, edited_by, old_included, new_included) VALUES ('${id}', '${NOW}', 't@example.com', 1, 0)`)).not.toThrow()
  })

  it('a re-import never resets an exclusion (ON CONFLICT DO NOTHING leaves the row alone)', () => {
    const db = migrated()
    db.exec(seedSql)
    const id = firstId(db)
    db.exec(`UPDATE transactions SET included = 0, updated_by = 'person@example.com' WHERE id = '${id}'`)
    db.exec(seedSql)
    expect(db.prepare('SELECT included FROM transactions WHERE id = ?').get(id)).toEqual({ included: 0 })
  })

  it('can be re-applied only once (a second run fails cleanly)', () => {
    const db = migrated()
    expect(() => db.exec(M3)).toThrow(/duplicate column name|already exists/)
  })
})

describe('the rollback block in the file', () => {
  it('lists its statements in an order that works and leaves a database equal to 0002 plus its data', () => {
    const rollback = M3.split(/\r?\n/).filter((l) => /^--\s{3}(DROP|ALTER|DELETE)/.test(l)).map((l) => l.replace(/^--\s{3}/, ''))
    expect(rollback).toEqual([
      'ALTER TABLE category_edits DROP COLUMN new_included;',
      'ALTER TABLE category_edits DROP COLUMN old_included;',
      'ALTER TABLE transactions DROP COLUMN included;',
      "DELETE FROM d1_migrations WHERE name = '0003_included.sql';",
    ])
    // wrangler's own bookkeeping table: the rollback un-records 0003 so a later apply re-adds the columns.
    const ledger = (d: DatabaseSync, names: string[]): void => {
      d.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)')
      for (const n of names) d.exec(`INSERT INTO d1_migrations (name) VALUES ('${n}')`)
    }
    const db = migrated()
    ledger(db, ['0001_init.sql', '0002_loans.sql', '0003_included.sql'])
    db.exec(seedSql)
    db.exec(`UPDATE transactions SET included = 0 WHERE id = '${firstId(db)}'`)
    db.exec(rollback.join('\n'))
    const base = upTo2()
    ledger(base, ['0001_init.sql', '0002_loans.sql'])
    base.exec(seedSql)
    expect(db.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).toEqual([{ name: '0001_init.sql' }, { name: '0002_loans.sql' }])
    const sch = (d: DatabaseSync): string => JSON.stringify(d.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all())
    expect(sch(db)).toBe(sch(base))
    expect(cols(db, 'transactions')).toEqual(cols(base, 'transactions'))
    expect(cols(db, 'category_edits')).toEqual(cols(base, 'category_edits'))
    expect(JSON.stringify(db.prepare('SELECT * FROM transactions ORDER BY id').all())).toBe(JSON.stringify(base.prepare('SELECT * FROM transactions ORDER BY id').all()))
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
