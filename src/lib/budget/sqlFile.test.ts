import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import { MAX_STATEMENT_BYTES, bankSyncsRowSql, pairUpdateSql, planStatements, renderPlanSql, sqlInt, sqlStr } from './sqlFile'
import { extendContext, planImport } from './import'
import { SEED, emptyContext, row, syntheticRequest, withoutBankGuard } from './__fixtures__/synthetic'
import type { ImportPlan, ImportRequest } from './types'

// Every migration in order: the load's insert reads bank_accounts (the bank-link guard, migration 0005).
const MIGRATION = readdirSync('migrations/gss-budget').filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(`migrations/gss-budget/${f}`, 'utf8')).join('\n')
const NOW = '2026-12-05T10:00:00.000Z'

const freshDb = (): DatabaseSync => {
  const db = new DatabaseSync(':memory:')
  db.exec(MIGRATION)
  return db
}
const count = (db: DatabaseSync, table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const plan = (req: ImportRequest = syntheticRequest(), ctx = emptyContext()): Promise<ImportPlan> => planImport(req, ctx, 'tool:test', NOW)

let full: ImportPlan
beforeAll(async () => { full = await plan() })

describe('sqlStr and sqlInt', () => {
  it('doubles quotes and keeps everything else literal', () => {
    expect(sqlStr("O'Brien's")).toBe("'O''Brien''s'")
    expect(sqlStr("x'; DROP TABLE transactions; --")).toBe("'x''; DROP TABLE transactions; --'")
    expect(sqlStr(null)).toBe('NULL')
    expect(sqlStr('')).toBe("''")
  })
  it('rejects a NUL character and non-strings', () => {
    expect(() => sqlStr('a\u0000b')).toThrow(RangeError)
    expect(() => sqlStr(5 as never)).toThrow(TypeError)
  })
  it('accepts safe integers only', () => {
    expect(sqlInt(-12_345)).toBe('-12345')
    expect(sqlInt(null)).toBe('NULL')
    for (const bad of [1.5, NaN, Infinity, 2 ** 53, '5' as never]) expect(() => sqlInt(bad)).toThrow(RangeError)
  })
})

describe('renderPlanSql', () => {
  it('keeps every statement under the 100 KB limit', () => {
    const enc = new TextEncoder()
    for (const s of planStatements(full)) expect(enc.encode(s).length).toBeLessThan(MAX_STATEMENT_BYTES)
  })
  it('throws on a statement over the limit', async () => {
    const big = { ...full, txns: [{ ...full.txns[0], description: 'x'.repeat(MAX_STATEMENT_BYTES) }] }
    expect(() => renderPlanSql(big)).toThrow(/100 KB/)
  })
  it('escapes a quote in a description so the SQL still runs and stores it intact', async () => {
    const req: ImportRequest = { importId: 'imp-q', sourceLabel: "label's", seed: SEED, statements: [
      { accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [row('2026-11-03', -500, "JOE'S DINER; DROP TABLE people")] }] }
    const p = await plan(req)
    const db = freshDb()
    db.exec(renderPlanSql(p))
    const r = db.prepare('SELECT description FROM transactions').get() as { description: string }
    expect(r.description).toBe("JOE'S DINER; DROP TABLE people")
    expect(count(db, 'people')).toBe(2)
    expect((db.prepare('SELECT source_label AS s FROM imports').get() as { s: string }).s).toBe("label's")
  })
  it('refuses an unsafe amount', () => {
    const bad = { ...full, txns: [{ ...full.txns[0], amountCents: 2 ** 60 }] }
    expect(() => renderPlanSql(bad)).toThrow(RangeError)
  })
  it('is empty for an empty plan', async () => {
    const p = await plan({ importId: 'imp-e', sourceLabel: 's', statements: [] })
    expect(renderPlanSql(p)).toBe('')
  })
})

describe('the SQL against the real migration (local SQLite)', () => {
  it('applies cleanly and writes the expected rows', () => {
    const db = freshDb()
    db.exec(renderPlanSql(full))
    expect(count(db, 'people')).toBe(SEED.people!.length)
    expect(count(db, 'accounts')).toBeGreaterThanOrEqual(SEED.accounts!.length)
    expect(count(db, 'merchant_rules')).toBe(SEED.rules!.length)
    expect(count(db, 'imports')).toBe(1)
    expect(count(db, 'statements')).toBe(full.statements.length)
    expect(count(db, 'transactions')).toBe(full.txns.length)
    const paired = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE pair_id IS NOT NULL').get() as { n: number }
    expect(paired.n).toBe(full.pairs.length * 2)
    // Each pair points back at its partner.
    const broken = db.prepare('SELECT COUNT(*) AS n FROM transactions a JOIN transactions b ON a.pair_id = b.id WHERE b.pair_id IS NOT a.id').get() as { n: number }
    expect(broken.n).toBe(0)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    // A paired row ends up in the DB exactly as the plan has it (insert unpaired, then pair in SQL).
    expect(full.txns.some((t) => t.unpaired)).toBe(true)
    const get = db.prepare('SELECT kind, category_id AS c, category_source AS cs, confidence AS conf, needs_review AS nr, review_reason AS rr, pair_id AS p FROM transactions WHERE id = ?')
    for (const t of full.txns) {
      expect(get.get(t.id), t.id).toEqual({ kind: t.kind, c: t.categoryId, cs: t.categorySource, conf: t.confidence, nr: t.needsReview ? 1 : 0, rr: t.reviewReason, p: t.pairId })
    }
  })

  it('running the same SQL again inserts no new rows', () => {
    const db = freshDb()
    const sql = renderPlanSql(full)
    db.exec(sql)
    const before = ['people', 'accounts', 'categories', 'merchant_rules', 'imports', 'statements', 'transactions'].map((t) => count(db, t))
    db.exec(sql)
    expect(['people', 'accounts', 'categories', 'merchant_rules', 'imports', 'statements', 'transactions'].map((t) => count(db, t))).toEqual(before)
  })

  it('a re-run leaves an edited row alone', () => {
    const db = freshDb()
    const sql = renderPlanSql(full)
    db.exec(sql)
    const target = full.txns.find((t) => t.kind === 'spend' && t.pairId === null)!
    db.prepare("UPDATE transactions SET category_id = 'gifts', category_source = 'manual', note = 'mine' WHERE id = ?").run(target.id)
    db.exec(sql)
    const r = db.prepare('SELECT category_id AS c, category_source AS s, note FROM transactions WHERE id = ?').get(target.id) as { c: string; s: string; note: string }
    expect(r).toEqual({ c: 'gifts', s: 'manual', note: 'mine' })
  })

  it('a re-import never deletes, renames or recolours a category made in the app, and never re-points a row edited to it', () => {
    const db = freshDb()
    const sql = renderPlanSql(full)
    db.exec(sql)
    // What POST /api/budget/categories writes, then a manual edit of one row to it.
    db.exec("INSERT INTO categories (id, label, color, sort, archived) VALUES ('u-hobbies', 'Hobbies', '#123456', 1000, 0), ('u-pet-food', 'Pet food', NULL, 1010, 0)")
    const target = full.txns.find((t) => t.kind === 'spend' && t.pairId === null)!
    db.prepare("UPDATE transactions SET category_id = 'u-hobbies', category_source = 'manual', rule_id = NULL, confidence = 100 WHERE id = ?").run(target.id)
    const snapshot = () => db.prepare("SELECT id, label, color, sort, archived FROM categories WHERE id LIKE 'u-%' ORDER BY id").all()
    const before = snapshot()
    // Re-applying the same seed, and a changed one (a seed category renamed and recoloured), touches only seed ids.
    db.exec(sql)
    const changed = renderPlanSql({ ...full, categories: full.categories.map((c) => ({ ...c, label: c.label + ' v2', color: '#abcdef' })) })
    db.exec(changed)
    expect(snapshot()).toEqual(before)
    expect(before).toHaveLength(2)
    expect(db.prepare('SELECT label FROM categories WHERE id = ?').get(full.categories[0].id)).toEqual({ label: full.categories[0].label + ' v2' })
    expect(db.prepare('SELECT category_id AS c, category_source AS s FROM transactions WHERE id = ?').get(target.id)).toEqual({ c: 'u-hobbies', s: 'manual' })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })

  it('refuses a seed category whose id is in the range reserved for categories made in the app', () => {
    const bad = { ...full, categories: [...full.categories, { id: 'u-hobbies', label: 'Hobbies', color: null, sort: 5 }] }
    expect(() => renderPlanSql(bad)).toThrow(/reserved/)
  })

  it('a seed re-run refreshes seed rules but never overwrites a rule made from an edit', () => {
    const db = freshDb()
    const sql = renderPlanSql(full)
    db.exec(sql)
    const seedRule = full.rules[0]
    db.prepare("UPDATE merchant_rules SET source = 'edit', set_category_id = 'gifts' WHERE id = ?").run(seedRule.id)
    db.exec(sql)
    const r = db.prepare('SELECT set_category_id AS c, source FROM merchant_rules WHERE id = ?').get(seedRule.id) as { c: string | null; source: string }
    expect(r).toEqual({ c: 'gifts', source: 'edit' })
  })

  it('a pair update never touches a manual or rule row, or one already paired', () => {
    const db = freshDb()
    db.exec(renderPlanSql({ ...full, pairs: [] }))
    const spend = full.txns.find((t) => t.kind === 'spend' && t.pairId === null && t.kindSource === 'auto')!
    const other = full.txns.find((t) => t.id !== spend.id && t.kind === 'spend' && t.pairId === null)!
    for (const src of ['manual', 'rule']) {
      db.prepare('UPDATE transactions SET kind_source = ?, pair_id = NULL WHERE id = ?').run(src, spend.id)
      db.exec(pairUpdateSql(spend.id, other.id, NOW, 'u'))
      const r = db.prepare('SELECT pair_id AS p, kind FROM transactions WHERE id = ?').get(spend.id) as { p: string | null; kind: string }
      expect(r).toEqual({ p: null, kind: 'spend' })
    }
    db.prepare("UPDATE transactions SET kind_source = 'auto' WHERE id = ?").run(spend.id)
    db.exec(pairUpdateSql(spend.id, other.id, NOW, 'u'))
    const done = db.prepare('SELECT pair_id AS p, kind, category_id AS c, category_source AS cs, confidence FROM transactions WHERE id = ?').get(spend.id) as Record<string, unknown>
    expect(done).toEqual({ p: other.id, kind: 'transfer', c: null, cs: 'none', confidence: 85 })
    db.exec(pairUpdateSql(spend.id, 'another', NOW, 'u')) // already paired: no change
    expect((db.prepare('SELECT pair_id AS p FROM transactions WHERE id = ?').get(spend.id) as { p: string }).p).toBe(other.id)
  })

  it('a pair update skips a row, or a partner, last written by a signed-in person (updated_by holds an @)', () => {
    const spend = full.txns.find((t) => t.kind === 'spend' && t.pairId === null && t.kindSource === 'auto')!
    const other = full.txns.find((t) => t.id !== spend.id && t.kind === 'spend' && t.pairId === null)!
    for (const who of [spend.id, other.id]) {
      const db = freshDb()
      db.exec(renderPlanSql({ ...full, pairs: [] }))
      db.prepare("UPDATE transactions SET kind_source = 'auto', category_source = 'auto', pair_id = NULL, updated_by = 'person@example.com' WHERE id = ?").run(who)
      db.exec(pairUpdateSql(spend.id, other.id, NOW, 'u'))
      expect((db.prepare('SELECT pair_id AS p FROM transactions WHERE id = ?').get(spend.id) as { p: string | null }).p).toBeNull()
    }
  })

  it('a later load never pairs away a hand-edited category: loaded unpaired, edited, partner arrives later', async () => {
    const first: ImportRequest = { importId: 'imp-1', sourceLabel: 's', seed: SEED, statements: [
      { accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [row('2026-11-14', -50_000, 'SOME SHOP PURCHASE')] }] }
    const both: ImportRequest = { importId: 'imp-2', sourceLabel: 's', seed: SEED, statements: [
      ...first.statements,
      { accountId: 'sav-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [row('2026-11-14', 50_000, 'TRANSFER FROM CHECKING X0001')] }] }
    const p1 = await plan(first)
    const db = freshDb()
    db.exec(renderPlanSql(p1))
    const id = p1.txns[0].id
    // A person sets the category in the table: category_source 'manual', kind_source untouched ('auto').
    db.prepare("UPDATE transactions SET category_id = 'gifts', category_source = 'manual', note = 'mine' WHERE id = ?").run(id)
    const before = db.prepare('SELECT kind, kind_source AS ks, category_id AS c, category_source AS cs, pair_id AS p, note FROM transactions WHERE id = ?').get(id)
    expect(before).toMatchObject({ ks: 'auto', c: 'gifts', cs: 'manual', p: null })
    // The next load re-plans every file from an empty context, so it now pairs the edited row.
    const p2 = await plan(both)
    expect(p2.pairs).toHaveLength(1)
    db.exec(renderPlanSql(p2))
    expect(db.prepare('SELECT kind, kind_source AS ks, category_id AS c, category_source AS cs, pair_id AS p, note FROM transactions WHERE id = ?').get(id)).toEqual(before)
    // The partner row is new, and the pair was skipped, so it is unpaired too: no pair_id pointing at the
    // edited row, and the classification it would have had without pairing (not 'transfer' by a pair that is not there).
    const partnerId = p2.pairs[0].find((x) => x !== id)!
    const partnerPlan = p2.txns.find((t) => t.id === partnerId)!
    expect(partnerPlan.pairId).toBe(id) // the plan pairs them; the load did not
    expect(partnerPlan.unpaired).toBeDefined()
    expect(db.prepare('SELECT kind, category_id AS c, category_source AS cs, confidence AS conf, needs_review AS nr, review_reason AS rr, pair_id AS p FROM transactions WHERE id = ?').get(partnerId))
      .toEqual({ kind: partnerPlan.unpaired!.kind, c: partnerPlan.unpaired!.categoryId, cs: partnerPlan.unpaired!.categorySource,
        conf: partnerPlan.unpaired!.confidence, nr: partnerPlan.unpaired!.needsReview ? 1 : 0, rr: partnerPlan.unpaired!.reviewReason, p: null })
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE pair_id IS NOT NULL').get() as { n: number }).n).toBe(0)
    // The same row with an untouched category still pairs (the guard is the edit, not the row), and
    // now the partner pairs with it, with the pair pointing both ways.
    db.prepare("UPDATE transactions SET category_source = 'auto' WHERE id = ?").run(id)
    db.exec(renderPlanSql(p2))
    expect(db.prepare('SELECT kind, category_id AS c FROM transactions WHERE id = ?').get(partnerId)).toEqual({ kind: 'transfer', c: null })
    expect((db.prepare('SELECT pair_id AS p FROM transactions WHERE id = ?').get(partnerId) as { p: string }).p).toBe(id)
    expect(db.prepare('SELECT kind, category_id AS c, category_source AS cs, pair_id AS p FROM transactions WHERE id = ?').get(id))
      .toEqual({ kind: 'transfer', c: null, cs: 'none', p: p2.pairs[0].find((x) => x !== id) })
  })

  it('pairs a new row with a row loaded earlier, and the second file leaves the first alone', async () => {
    const first: ImportRequest = { importId: 'imp-1', sourceLabel: 's', seed: SEED, statements: [
      { accountId: 'sav-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [row('2026-11-14', 50_000, 'TRANSFER FROM CHECKING X0001')] }] }
    const second: ImportRequest = { importId: 'imp-2', sourceLabel: 's', statements: [
      { accountId: 'chk-a', periodStart: '2026-11-01', periodEnd: '2026-11-30', rows: [row('2026-11-14', -50_000, 'TRANSFER TO SAVINGS X0002')] }] }
    const p1 = await plan(first)
    const p2 = await plan(second, extendContext(emptyContext(), p1))
    expect(p2.pairs).toHaveLength(1)
    const db = freshDb()
    db.exec(renderPlanSql(p1))
    db.exec(renderPlanSql(p2))
    const rows = db.prepare('SELECT id, pair_id AS p, kind FROM transactions ORDER BY account_id').all() as Array<{ id: string; p: string; kind: string }>
    expect(rows).toHaveLength(2)
    expect(rows[0].p).toBe(rows[1].id)
    expect(rows[1].p).toBe(rows[0].id)
    expect(rows.every((r) => r.kind === 'transfer')).toBe(true)
  })

  it('a unique statement per account and period: a second load of a changed statement updates it', async () => {
    const p = await plan()
    const db = freshDb()
    db.exec(renderPlanSql(p))
    const changed = { ...p, statements: p.statements.map((s) => (s.accountId === 'card-a' ? { ...s, closingBalanceCents: 1 } : s)), txns: [], pairs: [] }
    db.exec(renderPlanSql(changed))
    expect(count(db, 'statements')).toBe(p.statements.length)
    expect((db.prepare("SELECT closing_balance_cents AS c FROM statements WHERE account_id = 'card-a'").get() as { c: number }).c).toBe(1)
  })
})
