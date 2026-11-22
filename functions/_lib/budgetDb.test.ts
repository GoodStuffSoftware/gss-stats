// The Budget database layer on the node:sqlite D1 fake with SYNTHETIC data (functions/_lib/testing/budgetDb.ts):
// validation, cursor, mappers, person -> account ids, the query builders (EXPLAIN QUERY PLAN: every shape
// uses an index), the rule engine's write path, and the route wrapper.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APPLY_CANDIDATES_SQL, BudgetHttpError, CHUNK_BYTES, DEBT_PAYMENTS_SQL, LATEST_ONE_SQL, LOAN_LATEST_SQL, LOAN_PAYMENTS_SQL, LOAN_PROMOS_SQL, LOAN_TERMS_SQL, PROMOS_ONE_SQL, RANGE_SQL, TERMS_SQL, applyRules, accountIdsFor, assertCategory, buildSummary, buildTxnList, chunkBySize, decodeCursor, defineRoute,
  encodeCursor, getTxn, isIsoDate, loadDebts, mapAccount, mapRule, mapTxn, nextStamp, parseManualBalance, parseRange, parseSummaryQuery,
  parseTxnQuery, readJsonObject, runSummary, runTxnList,
} from './budgetDb'
import { addPersonB, createBudgetDb, insertTxn, testTxnId, type FakeBudgetDb } from './testing/budgetDb'
import type { SummaryQuery, TxnQuery } from '../../src/lib/budget/types'

const sp = (o: Record<string, string>) => new URLSearchParams(o)
const RANGE = { from: '2026-11-01', to: '2026-12-31' }
const NOV = { from: '2026-11-01', to: '2026-11-30' }

let db: FakeBudgetDb
beforeEach(async () => { db = await createBudgetDb() })

async function expectBad(fn: () => unknown, field: string): Promise<void> {
  let err: unknown
  try { await fn() } catch (e) { err = e }
  expect(err).toBeInstanceOf(BudgetHttpError)
  expect((err as BudgetHttpError).status).toBe(400)
  expect((err as BudgetHttpError).message.startsWith(field)).toBe(true)
}

describe('dates and range', () => {
  it('accepts real dates only', () => {
    expect(isIsoDate('2026-02-28')).toBe(true)
    for (const bad of ['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', '', '2026-01-01T00:00:00Z', 20260101, null]) expect(isIsoDate(bad)).toBe(false)
  })
  it('rejects missing, bad, reversed and over-400-day ranges, naming the field', async () => {
    await expectBad(() => parseRange(sp({ to: '2026-01-01' })), 'from')
    await expectBad(() => parseRange(sp({ from: '2026-01-01' })), 'to')
    await expectBad(() => parseRange(sp({ from: '2026-02-30', to: '2026-03-01' })), 'from')
    await expectBad(() => parseRange(sp({ from: '2026-03-01', to: '2026-02-01' })), 'from')
    await expectBad(() => parseRange(sp({ from: '2025-01-01', to: '2026-02-06' })), 'to')
  })
  it('allows exactly 400 days and a single day', () => {
    expect(parseRange(sp({ from: '2025-01-01', to: '2026-02-05' }))).toEqual({ from: '2025-01-01', to: '2026-02-05' }) // 400 days apart
    expect(parseRange(sp({ from: '2026-05-05', to: '2026-05-05' })).to).toBe('2026-05-05')
  })
})

describe('query parsing', () => {
  it('summary: merchant or account needs a category; groupBy is merchant or account', async () => {
    await expectBad(() => parseSummaryQuery(sp({ ...NOV, merchant: 'x' })), 'category')
    await expectBad(() => parseSummaryQuery(sp({ ...NOV, account: 'chk-a' })), 'category')
    await expectBad(() => parseSummaryQuery(sp({ ...NOV, category: 'fuel', groupBy: 'bogus' })), 'groupBy')
    await expectBad(() => parseSummaryQuery(sp({ ...NOV, category: 'Fuel!' })), 'category')
    await expectBad(() => parseSummaryQuery(sp({ ...NOV, person: 'A B' })), 'person')
    expect(parseSummaryQuery(sp({ ...NOV, category: 'fuel', groupBy: 'account', account: 'chk-a', ignored: 'yes' })))
      .toEqual({ ...NOV, person: 'all', category: 'fuel', groupBy: 'account', account: 'chk-a' })
  })
  it('transactions: limit 1-200, scope, review, cursor', async () => {
    for (const limit of ['0', '201', '-1', '1.5', 'abc', '99999']) await expectBad(() => parseTxnQuery(sp({ ...NOV, limit })), 'limit')
    await expectBad(() => parseTxnQuery(sp({ ...NOV, scope: 'everything' })), 'scope')
    await expectBad(() => parseTxnQuery(sp({ ...NOV, review: 'maybe' })), 'review')
    await expectBad(() => parseTxnQuery(sp({ ...NOV, cursor: '!!!' })), 'cursor')
    const q = parseTxnQuery(sp({ ...NOV, limit: '200', review: '1', scope: 'all' }))
    expect(q).toMatchObject({ limit: 200, review: true, scope: 'all', person: 'all' })
    expect(parseTxnQuery(sp(NOV))).toMatchObject({ limit: 100, scope: 'spending' })
  })
  it('manual balance: whole cents >= 0, real date, apr 0-10000', async () => {
    expect(parseManualBalance({ asOf: '2026-11-30', balanceCents: 0 })).toEqual({ asOf: '2026-11-30', balanceCents: 0, aprBp: null })
    await expectBad(() => parseManualBalance({ asOf: '2026-11-31', balanceCents: 5 }), 'asOf')
    await expectBad(() => parseManualBalance({ asOf: '2026-11-30', balanceCents: -1 }), 'balanceCents')
    await expectBad(() => parseManualBalance({ asOf: '2026-11-30', balanceCents: 1.5 }), 'balanceCents')
    await expectBad(() => parseManualBalance({ asOf: '2026-11-30', balanceCents: 5, aprBp: 10_001 }), 'aprBp')
  })
})

describe('cursor', () => {
  it('round-trips and rejects anything else', async () => {
    const id = 'a'.repeat(32)
    const c = encodeCursor('2026-11-03', id)
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(c)).toEqual({ postedDate: '2026-11-03', id })
    for (const bad of ['', 'abc', btoa('2026-11-03|short'), btoa(`2026-13-03|${id}`), btoa(`x|${id}`), btoa(`2026-11-03|${id}|more`)]) {
      await expectBad(() => decodeCursor(bad.replace(/=+$/, '')), 'cursor')
    }
  })
})

describe('row mappers', () => {
  it('map every stored column to the contract shape', async () => {
    const acct = mapAccount(db.get('SELECT * FROM accounts WHERE id = ?', 'card-a')!)
    expect(acct).toEqual({ id: 'card-a', label: 'Card A', kind: 'card', personId: 'pa', last4: '0003', isDebt: true, inSpending: true, creditLimitCents: 500_000, aprBp: 2199 })
    const rule = mapRule(db.get("SELECT * FROM merchant_rules WHERE merchant_key = 'chain-x' AND store_no IS NULL")!)
    expect(rule).toMatchObject({ merchantKey: 'chain-x', storeNo: null, setCategoryId: 'groceries', review: true, reviewReason: 'ambiguous_store', source: 'seed', active: true })
    const txn = await getTxn(db.d1, (db.get<{ id: string }>("SELECT id FROM transactions WHERE store_no = '1001'")!).id)
    expect(txn).toMatchObject({ accountId: 'chk-a', amountCents: -6200, merchantKey: 'chain-x', storeNo: '1001', kind: 'spend', categoryId: 'fuel', categorySource: 'rule', needsReview: false })
    expect(Object.keys(mapTxn(db.get('SELECT * FROM transactions LIMIT 1')!)).sort()).toEqual([
      'accountId', 'amountCents', 'categoryId', 'categorySource', 'confidence', 'debtAccountId', 'description', 'id', 'interestCents', 'kind', 'kindSource',
      'merchantKey', 'merchantName', 'needsReview', 'note', 'pairId', 'postedDate', 'principalCents', 'reviewReason', 'ruleId', 'storeNo', 'txnDate',
      'updatedAt', 'updatedBy',
    ])
  })
})

describe('person -> account ids', () => {
  it('all = every active account; a person = theirs plus the shared ones', async () => {
    expect((await accountIdsFor(db.d1, 'all')).sort()).toEqual(['card-a', 'chk-a', 'loan-a', 'loc-a', 'mtg', 'sav-a', 'store-card'].sort())
    expect(await accountIdsFor(db.d1, 'pb')).toEqual(['mtg'])
    addPersonB(db)
    expect((await accountIdsFor(db.d1, 'pb')).sort()).toEqual(['chk-b', 'mtg'])
    expect(await accountIdsFor(db.d1, 'pa')).toContain('chk-a')
    expect(await accountIdsFor(db.d1, 'pa')).not.toContain('chk-b')
  })
  it('leaves archived accounts out and rejects an unknown person', async () => {
    db.exec("UPDATE accounts SET archived = 1 WHERE id = 'sav-a'")
    expect(await accountIdsFor(db.d1, 'all')).not.toContain('sav-a')
    await expectBad(() => accountIdsFor(db.d1, 'nobody'), 'person')
  })
  it('checks categories', async () => {
    await expect(assertCategory(db.d1, 'fuel')).resolves.toBeUndefined()
    await expect(assertCategory(db.d1, '__none__')).resolves.toBeUndefined()
    await expect(assertCategory(db.d1, null)).resolves.toBeUndefined()
    await expectBad(() => assertCategory(db.d1, 'nonesuch'), 'category')
  })
  it('refuses an archived category for a write but still lets a read filter by it', async () => {
    db.exec("UPDATE categories SET archived = 1 WHERE id = 'fuel'")
    await expect(assertCategory(db.d1, 'fuel')).resolves.toBeUndefined()
    await expectBad(() => assertCategory(db.d1, 'fuel', 'categoryId', true), 'categoryId')
    await expect(assertCategory(db.d1, 'dining', 'categoryId', true)).resolves.toBeUndefined()
  })
})

// ---------- EXPLAIN QUERY PLAN: every summary and list shape uses an index ------------------------

const ALL = JSON.stringify(['chk-a', 'sav-a', 'card-a', 'mtg'])
const SUMMARY_SHAPES: Array<[string, SummaryQuery]> = [
  ['category level', { ...RANGE, person: 'all' }],
  ['merchant level', { ...RANGE, person: 'pa', category: 'fuel' }],
  ['merchant level, uncategorized', { ...RANGE, person: 'all', category: '__none__' }],
  ['account level', { ...RANGE, person: 'all', category: 'fuel', groupBy: 'account' }],
  ['purchase level by merchant', { ...RANGE, person: 'all', category: 'fuel', merchant: 'Chain X' }],
  ['purchase level by merchant, uncategorized', { ...RANGE, person: 'all', category: '__none__', merchant: 'Paypal' }],
  ['purchase level by account', { ...RANGE, person: 'all', category: 'dining', groupBy: 'account', account: 'chk-a' }],
]
const TXN_BASE: TxnQuery & { limit: number } = { ...RANGE, person: 'all', scope: 'spending', limit: 100 }
const CURSOR = encodeCursor('2026-11-20', 'f'.repeat(32))
const TXN_SHAPES: Array<[string, TxnQuery & { limit: number }]> = [
  ['spending, no filter', TXN_BASE],
  ['scope all', { ...TXN_BASE, scope: 'all' }],
  ['category', { ...TXN_BASE, category: 'fuel' }],
  ['uncategorized', { ...TXN_BASE, category: '__none__' }],
  ['category + merchant', { ...TXN_BASE, category: 'fuel', merchant: 'Chain X' }],
  ['category + account', { ...TXN_BASE, category: 'dining', account: 'chk-a' }],
  ['merchant only', { ...TXN_BASE, merchant: 'Chain X' }],
  ['review', { ...TXN_BASE, review: true }],
  ['review, scope all', { ...TXN_BASE, scope: 'all', review: true }],
  ['category + review', { ...TXN_BASE, category: 'groceries', review: true }],
  ['cursor', { ...TXN_BASE, cursor: CURSOR }],
  ['cursor + category + merchant', { ...TXN_BASE, category: 'fuel', merchant: 'Chain X', cursor: CURSOR }],
]

function assertIndexed(plan: string[]): void {
  const text = plan.join('\n')
  expect(text, text).not.toMatch(/SCAN transactions/)
  expect(text, text).toMatch(/USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY/)
}

describe('every query shape is index-backed (EXPLAIN QUERY PLAN)', () => {
  it.each(SUMMARY_SHAPES)('summary: %s', (_name, q) => {
    const plan = buildSummary(q, ALL)
    assertIndexed(db.explain(plan.main.sql, plan.main.params))
    assertIndexed(db.explain(plan.review.sql, plan.review.params))
    if (plan.total) assertIndexed(db.explain(plan.total.sql, plan.total.params))
  })
  it.each(TXN_SHAPES)('transactions: %s', (_name, q) => {
    const built = buildTxnList(q, ALL)
    assertIndexed(db.explain(built.sql, built.params))
  })
  it('meta and detail reads are index-backed too', () => {
    assertIndexed(db.explain(RANGE_SQL))
    assertIndexed(db.explain(APPLY_CANDIDATES_SQL, ['["chain-x"]'])) // the statement applyRules runs, per slice of keys
  })
  it('the debt payment lists read the newest rows only: an index walk in order, no sort, no scan of the account', () => {
    for (const [sql, id, index] of [[DEBT_PAYMENTS_SQL.external, 'mtg', 'idx_txn_debt'], [DEBT_PAYMENTS_SQL.account, 'card-a', 'idx_txn_pay']] as const) {
      const plan = db.explain(sql, [id])
      assertIndexed(plan)
      expect(plan.join('\n'), plan.join('\n')).toContain(index)
      expect(plan.join('\n'), plan.join('\n')).not.toMatch(/TEMP B-TREE/)
    }
  })
  it('the loan payment sums are bounded index range reads (idx_txn_debt, idx_txn_pay), never a scan of transactions', () => {
    for (const [sql, index] of [[LOAN_PAYMENTS_SQL.external, 'idx_txn_debt'], [LOAN_PAYMENTS_SQL.account, 'idx_txn_pay']] as const) {
      const plan = db.explain(sql, ['all', '2026-09-01', '2026-12-01'])
      assertIndexed(plan)
      expect(plan.join('\n'), plan.join('\n')).toContain(index)
    }
  })
  it('the debt detail terms, latest statement and promos reads are key lookups', () => {
    for (const sql of [TERMS_SQL, LATEST_ONE_SQL, PROMOS_ONE_SQL]) {
      const plan = db.explain(sql, ['card-a'])
      expect(plan.join('\n'), plan.join('\n')).not.toMatch(/SCAN (transactions|statements|statement_promos|debt_terms)/)
    }
  })
  it('the /loans batch terms, latest and promos reads never scan statements, statement_promos or debt_terms', () => {
    for (const sql of [LOAN_TERMS_SQL, LOAN_LATEST_SQL, LOAN_PROMOS_SQL]) {
      const plan = db.explain(sql, ['all'])
      expect(plan.join('
'), plan.join('
')).not.toMatch(/SCAN (s|s2|p|statements|statement_promos|debt_terms)/)
    }
  })
  it('a rule re-apply reads only the keyed merchants rows, through idx_txn_merchant', () => {
    const plan = db.explain(APPLY_CANDIDATES_SQL, ['["chain-x"]']).join('\n')
    expect(plan).toContain('idx_txn_merchant')
    expect(plan).not.toMatch(/SCAN transactions/)
  })
  it('binds every value: a hostile merchant or category never reaches the SQL text', () => {
    const evil = "x'; DROP TABLE transactions; --"
    const s = buildSummary({ ...RANGE, person: 'all', category: 'fuel', merchant: evil }, ALL)
    expect(s.main.sql).not.toContain('DROP')
    expect(s.main.params).toContain(evil)
    const t = buildTxnList({ ...TXN_BASE, merchant: evil, category: 'fuel' }, ALL)
    expect(t.sql).not.toContain('DROP')
    expect(t.params.length).toBeLessThan(100)
  })
})

// ---------- summary and list agree ---------------------------------------------------------------

describe('summary runner', () => {
  it('level 1: spend + refund + fee by category; interest, transfers and payments are not spending', async () => {
    const r = await runSummary(db.d1, { ...NOV, to: '2026-12-31', person: 'all' })
    expect(r.level).toBe('category')
    const by = Object.fromEntries(r.slices.map((s) => [s.key, s.netCents]))
    expect(by.fuel).toBe(6200 + 9000)
    expect(by.groceries).toBe(8400 + 1850 + 300)
    expect(by.housing).toBe(120_000)
    expect(by.fees).toBe(1500)
    expect(by.dining).toBe(450 + 450 + 7800)
    // uncategorized: market (-4500, -1200 spend; +2300 refund), paypal -9900
    expect(by.__none__).toBe(4500 + 1200 + 9900 - 2300)
    expect(r.totalCents).toBe(r.slices.reduce((s, x) => s + x.netCents, 0))
    expect(r.slices.find((s) => s.key === '__none__')?.label).toBe('Uncategorized')
    expect(r.slices.find((s) => s.key === 'fuel')?.label).toBe('Fuel')
    // sorted by size
    expect(r.slices.map((s) => s.netCents)).toEqual([...r.slices.map((s) => s.netCents)].sort((a, b) => b - a))
  })
  it('refunds net: a refund bigger than the spend gives a negative net, returned as is', async () => {
    insertTxn(db, { kind: 'refund', amount_cents: 99_999, category_id: 'travel', category_source: 'manual', merchant_key: 'air-z', merchant_name: 'Air Z' })
    const r = await runSummary(db.d1, { ...RANGE, person: 'all' })
    expect(r.slices.find((s) => s.key === 'travel')?.netCents).toBe(-99_999)
  })
  it('levels agree with the sum of the matching transactions pages', async () => {
    const sumList = async (q: Partial<TxnQuery>) => {
      let cursor: string | undefined
      let total = 0
      let n = 0
      do {
        const page = await runTxnList(db.d1, { ...TXN_BASE, limit: 3, cursor, ...q })
        for (const row of page.rows) { total -= row.amountCents; n++ }
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return { total, n }
    }
    const cats = await runSummary(db.d1, { ...RANGE, person: 'all' })
    for (const s of cats.slices) {
      const l = await sumList({ category: s.key })
      expect(l, `category ${s.key}`).toEqual({ total: s.netCents, n: s.count })
      const merchants = await runSummary(db.d1, { ...RANGE, person: 'all', category: s.key })
      expect(merchants.level).toBe('merchant')
      expect(merchants.totalCents).toBe(s.netCents)
      for (const m of merchants.slices) {
        const lm = await sumList({ category: s.key, merchant: m.key })
        expect(lm, `${s.key}/${m.key}`).toEqual({ total: m.netCents, n: m.count })
        const purchases = await runSummary(db.d1, { ...RANGE, person: 'all', category: s.key, merchant: m.key })
        expect(purchases.level).toBe('purchase')
        expect(purchases.totalCents).toBe(m.netCents)
        expect(purchases.slices.reduce((t, x) => t + x.netCents, 0)).toBe(m.netCents)
      }
      const accounts = await runSummary(db.d1, { ...RANGE, person: 'all', category: s.key, groupBy: 'account' })
      expect(accounts.totalCents).toBe(s.netCents)
      for (const a of accounts.slices) {
        const la = await sumList({ category: s.key, account: a.key })
        expect(la, `${s.key}@${a.key}`).toEqual({ total: a.netCents, n: a.count })
      }
    }
  })
  it('account level names accounts; purchases are sorted by size and labelled by date and merchant', async () => {
    const acc = await runSummary(db.d1, { ...RANGE, person: 'all', category: 'dining', groupBy: 'account' })
    expect(acc.slices.map((s) => [s.key, s.label, s.netCents])).toEqual([['card-a', 'Card A', 7800], ['chk-a', 'Checking A', 900]])
    const purchases = await runSummary(db.d1, { ...RANGE, person: 'all', category: 'dining', merchant: 'Quillfeather Cafe' })
    expect(purchases.slices.map((s) => s.netCents)).toEqual([7800, 450, 450])
    expect(purchases.slices[0].label).toBe('2026-11-20 Quillfeather Cafe')
  })
  it('person filter: a person sees their accounts plus shared ones', async () => {
    addPersonB(db)
    insertTxn(db, { account_id: 'chk-b', amount_cents: -1234, category_id: 'fuel', category_source: 'manual', merchant_key: 'pump-q', merchant_name: 'Pump Q', posted_date: '2026-11-09' })
    const a = await runSummary(db.d1, { ...RANGE, person: 'pa' })
    const b = await runSummary(db.d1, { ...RANGE, person: 'pb' })
    const all = await runSummary(db.d1, { ...RANGE, person: 'all' })
    expect(b.slices).toEqual([{ key: 'fuel', label: 'Fuel', netCents: 1234, count: 1 }])
    expect(a.slices.find((s) => s.key === 'fuel')?.netCents).toBe(15_200)
    expect(all.slices.find((s) => s.key === 'fuel')?.netCents).toBe(15_200 + 1234)
  })
  it('reviewCount counts flagged rows in range and person filter', async () => {
    const r = await runSummary(db.d1, { ...RANGE, person: 'all' })
    expect(r.reviewCount).toBe(db.get<{ n: number }>('SELECT COUNT(*) n FROM transactions WHERE needs_review = 1')!.n)
    expect((await runSummary(db.d1, { from: '2026-11-03', to: '2026-11-04', person: 'all' })).reviewCount).toBe(0)
    addPersonB(db)
    expect((await runSummary(db.d1, { ...RANGE, person: 'pb' })).reviewCount).toBe(0)
  })
  it('empty range -> no slices, zero total', async () => {
    expect(await runSummary(db.d1, { from: '2020-01-01', to: '2020-01-31', person: 'all' })).toEqual({ level: 'category', slices: [], totalCents: 0, reviewCount: 0 })
  })
  it('unknown category is a 400', async () => {
    await expectBad(() => runSummary(db.d1, { ...RANGE, person: 'all', category: 'nonesuch' }), 'category')
  })
})

describe('transactions runner: keyset paging', () => {
  it('pages newest first, every row once, stable cursors', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await runTxnList(db.d1, { ...TXN_BASE, scope: 'all', limit: 4, cursor })
      expect(page.rows.length).toBeLessThanOrEqual(4)
      seen.push(...page.rows.map((r) => r.id))
      cursor = page.nextCursor ?? undefined
      pages++
    } while (cursor)
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.length).toBe(db.get<{ n: number }>('SELECT COUNT(*) n FROM transactions')!.n)
    expect(pages).toBeGreaterThan(5)
    const dates = (await runTxnList(db.d1, { ...TXN_BASE, scope: 'all', limit: 200 })).rows.map((r) => r.postedDate)
    expect(dates).toEqual([...dates].sort().reverse())
  })
  it('a cursor stays valid when the row it points at is edited or removed', async () => {
    const first = await runTxnList(db.d1, { ...TXN_BASE, scope: 'all', limit: 5 })
    const lastId = first.rows[4].id
    const rest = await runTxnList(db.d1, { ...TXN_BASE, scope: 'all', limit: 200, cursor: first.nextCursor! })
    db.exec(`UPDATE transactions SET category_id = 'other', updated_at = '2027-01-01T00:00:00.000Z' WHERE id = '${lastId}'`)
    expect((await runTxnList(db.d1, { ...TXN_BASE, scope: 'all', limit: 200, cursor: first.nextCursor! })).rows.map((r) => r.id)).toEqual(rest.rows.map((r) => r.id))
    db.exec(`DELETE FROM transactions WHERE id = '${lastId}'`)
    expect((await runTxnList(db.d1, { ...TXN_BASE, scope: 'all', limit: 200, cursor: first.nextCursor! })).rows.map((r) => r.id)).toEqual(rest.rows.map((r) => r.id))
  })
  it('same-day rows order by id desc and never repeat across a page edge', async () => {
    for (let i = 0; i < 7; i++) insertTxn(db, { id: testTxnId(0xa0 + i), posted_date: '2026-11-21', amount_cents: -100 - i })
    const got: string[] = []
    let cursor: string | undefined
    do {
      const p = await runTxnList(db.d1, { ...TXN_BASE, from: '2026-11-21', to: '2026-11-21', limit: 2, cursor })
      got.push(...p.rows.map((r) => r.id))
      cursor = p.nextCursor ?? undefined
    } while (cursor)
    expect(got).toEqual([...got].sort().reverse())
    expect(got.length).toBe(7)
  })
  it('last page has no cursor; exactly-full last page has none either', async () => {
    const total = (await runTxnList(db.d1, { ...TXN_BASE, scope: 'all', limit: 200 })).rows.length
    expect((await runTxnList(db.d1, { ...TXN_BASE, scope: 'all', limit: total })).nextCursor).toBeNull()
    expect((await runTxnList(db.d1, { ...TXN_BASE, scope: 'all', limit: total - 1 })).nextCursor).not.toBeNull()
  })
  it('filters: scope, review, category, uncategorized, merchant, account, person', async () => {
    const ids = async (q: Partial<TxnQuery>) => (await runTxnList(db.d1, { ...TXN_BASE, limit: 200, ...q })).rows
    expect((await ids({})).every((r) => ['spend', 'refund', 'fee'].includes(r.kind))).toBe(true)
    expect((await ids({ scope: 'all' })).some((r) => r.kind === 'card_payment')).toBe(true)
    expect((await ids({ review: true })).every((r) => r.needsReview)).toBe(true)
    expect((await ids({ category: 'fuel' })).map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([-9000, -6200])
    expect((await ids({ category: '__none__' })).every((r) => r.categoryId === null)).toBe(true)
    expect((await ids({ merchant: 'Chain X' })).length).toBe(3)
    expect((await ids({ account: 'card-a' })).every((r) => r.accountId === 'card-a')).toBe(true)
    addPersonB(db)
    expect(await ids({ person: 'pb' })).toEqual([])
    expect((await ids({ from: '2026-11-03', to: '2026-11-03' })).length).toBe(1)
  })
})

// ---------- rule engine --------------------------------------------------------------------------

const txnRow = (id: string) => db.get<Record<string, unknown>>('SELECT * FROM transactions WHERE id = ?', id)!

describe('applyRules', () => {
  it('never changes a manual category or kind; leaves rows with no matching rule alone', async () => {
    const manual = insertTxn(db, { merchant_key: 'paws-and-claws', category_id: 'gifts', category_source: 'manual', kind_source: 'manual', kind: 'spend' })
    const catOnly = insertTxn(db, { merchant_key: 'paws-and-claws', category_id: 'gifts', category_source: 'manual' })
    const auto = insertTxn(db, { merchant_key: 'paws-and-claws', category_id: 'shopping', category_source: 'auto' })
    const noRule = insertTxn(db, { merchant_key: 'no-such-merchant', category_id: 'shopping', category_source: 'auto' })
    const before = { manual: txnRow(manual), catOnly: txnRow(catOnly), noRule: txnRow(noRule) }
    const changed = await applyRules(db.d1, ['paws-and-claws', 'no-such-merchant'], 'user-a@example.com')
    expect(txnRow(manual)).toEqual(before.manual)
    expect(txnRow(catOnly)).toEqual(before.catOnly)
    expect(txnRow(noRule)).toEqual(before.noRule)
    expect(txnRow(auto)).toMatchObject({ category_id: 'pets', category_source: 'rule' })
    expect(changed).toBe(1)
    expect(await applyRules(db.d1, ['paws-and-claws'], 'user-a@example.com')).toBe(0) // idempotent
  })
  it('a row with only a manual kind is not touched either; a rule kind reaches the others', async () => {
    const manualKind = insertTxn(db, { merchant_key: 'homestead-lending-pmt', kind: 'transfer', kind_source: 'manual', category_id: null, category_source: 'none' })
    const auto = insertTxn(db, { merchant_key: 'homestead-lending-pmt', kind: 'transfer', kind_source: 'auto', category_id: null, category_source: 'none' })
    const before = txnRow(manualKind)
    expect(await applyRules(db.d1, ['homestead-lending-pmt'], 'user-a@example.com')).toBe(1)
    expect(txnRow(manualKind)).toEqual(before)
    expect(txnRow(auto)).toMatchObject({ kind: 'spend', kind_source: 'rule', category_id: 'housing', category_source: 'rule' })
  })
  it('the most specific rule wins; a store-less rule never overrides a store rule', async () => {
    const pump = insertTxn(db, { merchant_key: 'chain-x', store_no: '1001', category_id: 'groceries', category_source: 'auto' })
    const unknownStore = insertTxn(db, { merchant_key: 'chain-x', store_no: '7777', category_id: 'dining', category_source: 'auto' })
    await applyRules(db.d1, ['chain-x'], 'user-a@example.com')
    expect(txnRow(pump)).toMatchObject({ category_id: 'fuel', category_source: 'rule' })
    expect(txnRow(unknownStore)).toMatchObject({ category_id: 'groceries', category_source: 'rule', needs_review: 1, review_reason: 'ambiguous_store' })
  })
  it('writes category_edits and bumps updated_at / updated_by; skips a row edited meanwhile', async () => {
    const id = insertTxn(db, { merchant_key: 'paws-and-claws', category_id: 'shopping', category_source: 'auto' })
    const stale = insertTxn(db, { merchant_key: 'paws-and-claws', category_id: 'shopping', category_source: 'auto', updated_at: '2026-12-06T00:00:00.000Z' })
    await applyRules(db.d1, ['paws-and-claws'], 'user-b@example.com', Date.parse('2026-12-07T00:00:00.000Z'))
    const row = txnRow(id)
    expect(row.updated_by).toBe('user-b@example.com')
    expect(String(row.updated_at) > '2026-12-05T10:00:00.000Z').toBe(true)
    expect(db.all('SELECT old_category_id, new_category_id, edited_by FROM category_edits WHERE txn_id = ?', id))
      .toEqual([{ old_category_id: 'shopping', new_category_id: 'pets', edited_by: 'user-b@example.com' }])
    expect(txnRow(stale)).toMatchObject({ category_id: 'pets' })
    // a concurrent edit: change a row between read and write -> the guard skips it
    const raced = insertTxn(db, { merchant_key: 'paws-and-claws', category_id: 'shopping', category_source: 'auto' })
    const real = db.d1.prepare.bind(db.d1)
    let injected = false
    ;(db.d1 as unknown as { prepare: (s: string) => unknown }).prepare = (sql: string) => {
      if (!injected && sql.startsWith('INSERT INTO category_edits')) {
        injected = true
        db.exec(`UPDATE transactions SET category_id = 'gifts', category_source = 'manual', updated_at = '2030-01-01T00:00:00.000Z' WHERE id = '${raced}'`)
      }
      return real(sql)
    }
    expect(await applyRules(db.d1, ['paws-and-claws'], 'user-b@example.com')).toBe(0)
    expect(txnRow(raced)).toMatchObject({ category_id: 'gifts', category_source: 'manual' })
  })
  it('null merchant list = every merchant that has an active rule; inactive rules do nothing', async () => {
    const a = insertTxn(db, { merchant_key: 'paws-and-claws', category_id: null, category_source: 'none' })
    const b = insertTxn(db, { merchant_key: 'depot-y', amount_cents: -2000, category_id: null, category_source: 'none' })
    expect(await applyRules(db.d1, null, 'user-a@example.com')).toBe(2)
    expect(txnRow(a).category_id).toBe('pets')
    expect(txnRow(b).category_id).toBe('shopping')
    db.exec("UPDATE merchant_rules SET active = 0 WHERE merchant_key = 'paws-and-claws'")
    const c = insertTxn(db, { merchant_key: 'paws-and-claws', category_id: null, category_source: 'none' })
    expect(await applyRules(db.d1, ['paws-and-claws'], 'user-a@example.com')).toBe(0)
    expect(txnRow(c).category_id).toBeNull()
  })
  it('chunks big applies by size, inside one batch (a failure leaves nothing written)', async () => {
    const ids: string[] = []
    for (let i = 0; i < 700; i++) ids.push(insertTxn(db, { id: testTxnId(0x1000 + i), description: 'BULK', merchant_key: 'paws-and-claws', category_id: null, category_source: 'none' }))
    db.statements.length = 0
    db.failNextBatch()
    await expect(applyRules(db.d1, ['paws-and-claws'], 'user-a@example.com')).rejects.toThrow('simulated')
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM transactions WHERE category_id = 'pets' AND description = 'BULK'")!.n).toBe(0)
    expect(await applyRules(db.d1, ['paws-and-claws'], 'user-a@example.com')).toBe(700)
    const writes = db.statements.filter((s) => s.startsWith('WITH ch AS'))
    expect(writes.length).toBeGreaterThanOrEqual(3) // 700 rows / 300 per chunk
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM transactions WHERE category_id = 'pets' AND description = 'BULK'")!.n).toBe(700)
    expect(ids.length).toBe(700)
  })
})

describe('chunkBySize and nextStamp', () => {
  it('keeps every chunk under the byte and row caps and loses nothing', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: String(i).padStart(32, 'x'), pad: 'p'.repeat(100) }))
    const chunks = chunkBySize(items)
    expect(chunks.flat()).toEqual(items)
    for (const c of chunks) { expect(JSON.stringify(c).length).toBeLessThanOrEqual(CHUNK_BYTES); expect(c.length).toBeLessThanOrEqual(300) }
    expect(chunkBySize([])).toEqual([])
    expect(chunkBySize([{ big: 'x'.repeat(70_000) }]).length).toBe(1)
  })
  it('nextStamp is always strictly after the previous stamp', () => {
    const t = Date.parse('2026-12-05T10:00:00.000Z')
    expect(nextStamp('2026-12-05T10:00:00.000Z', t)).toBe('2026-12-05T10:00:00.001Z')
    expect(nextStamp('2026-12-05T09:00:00.000Z', t)).toBe('2026-12-05T10:00:00.000Z')
    expect(nextStamp(null, t)).toBe('2026-12-05T10:00:00.000Z')
    expect(nextStamp('garbage', t)).toBe('2026-12-05T10:00:00.000Z')
  })
})

describe('debts loader', () => {
  it('the newer of statement and typed balance wins; a tie goes to the statement', async () => {
    let debts = await loadDebts(db.d1, 'all')
    const card = debts.find((d) => d.accountId === 'card-a')!
    expect(card).toMatchObject({ balanceCents: 18_000, asOf: '2026-12-04', source: 'statement', aprBp: 2199, creditLimitCents: 500_000 })
    expect(debts.find((d) => d.accountId === 'mtg')).toMatchObject({ balanceCents: null, asOf: null, source: null, aprBp: 450 })
    db.exec("INSERT INTO debt_balances VALUES ('card-a', '2026-12-04', 99, NULL, 'x', 'y'), ('card-a', '2026-12-05', 20000, 1999, 'x', 'y')")
    debts = await loadDebts(db.d1, 'all')
    expect(debts.find((d) => d.accountId === 'card-a')).toMatchObject({ balanceCents: 20_000, asOf: '2026-12-05', source: 'manual', aprBp: 1999 })
    db.exec("DELETE FROM debt_balances WHERE as_of = '2026-12-05'")
    expect((await loadDebts(db.d1, 'all')).find((d) => d.accountId === 'card-a')).toMatchObject({ balanceCents: 18_000, source: 'statement' })
  })
  it('person filter keeps shared debts, drops archived ones, rejects an unknown person', async () => {
    expect((await loadDebts(db.d1, 'pb')).map((d) => d.accountId)).toEqual(['mtg'])
    db.exec("UPDATE accounts SET person_id = NULL WHERE id = 'card-a'")
    expect((await loadDebts(db.d1, 'pb')).map((d) => d.accountId).sort()).toEqual(['card-a', 'mtg'].sort())
    db.exec("UPDATE accounts SET archived = 1 WHERE id = 'mtg'")
    expect((await loadDebts(db.d1, 'all')).map((d) => d.accountId)).not.toContain('mtg')
    await expectBad(() => loadDebts(db.d1, 'nobody'), 'person')
  })
})

// ---------- route wrapper ------------------------------------------------------------------------

describe('defineRoute and readJsonObject', () => {
  const ok = defineRoute({ GET: async () => new Response('{"hi":1}', { status: 200 }), POST: async () => { throw new BudgetHttpError(409, 'conflict', 'nope', { current: { a: 1 } }) } })
  const ctx = (method: string, over: Record<string, unknown> = {}) => ({ request: new Request('https://x.test/api/budget/z', { method }), env: { BUDGET_DB: db.d1 }, data: { budgetEmail: 'a@example.com' }, params: {}, ...over }) as never

  it('403 without the middleware identity, 405 with Allow, HEAD runs the GET handler, 503 without the database', async () => {
    expect((await ok(ctx('GET', { data: {} }))).status).toBe(403)
    const bad = await ok(ctx('DELETE'))
    expect(bad.status).toBe(405)
    expect(bad.headers.get('Allow')).toBe('GET, POST, HEAD')
    expect((await ok(ctx('HEAD'))).status).toBe(200)
    expect((await ok(ctx('GET', { env: {} }))).status).toBe(503)
  })
  it('turns a BudgetHttpError into its status, code, message and extras; every answer is private, no-store', async () => {
    const res = await ok(ctx('POST'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'conflict', message: 'nope', current: { a: 1 } })
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })
  it('an unexpected throw is a 500 that never echoes the message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = defineRoute({ GET: async () => { throw new Error('secret detail 4111') } })
    const res = await boom(ctx('GET'))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret')
    expect(spy.mock.calls.join(' ')).not.toContain('4111')
    spy.mockRestore()
  })
  it('readJsonObject: 413 by header and by size, 400 for bad JSON, arrays and scalars', async () => {
    const req = (body: string, headers: Record<string, string> = {}) => new Request('https://x.test/', { method: 'POST', body, headers })
    await expect(readJsonObject(req('{"a":1}'), 100)).resolves.toEqual({ a: 1 })
    await expect(readJsonObject(req('{"a":"' + 'x'.repeat(200) + '"}'), 100)).rejects.toMatchObject({ status: 413, code: 'too_large' })
    await expect(readJsonObject(req('{}', { 'Content-Length': '5000' }), 100)).rejects.toMatchObject({ status: 413 })
    await expect(readJsonObject(req('é'.repeat(80)), 100)).rejects.toMatchObject({ status: 413 }) // bytes, not characters
    for (const bad of ['', '{nope', '[]', '5', 'null']) await expect(readJsonObject(req(bad), 100)).rejects.toMatchObject({ status: 400 })
  })
})
