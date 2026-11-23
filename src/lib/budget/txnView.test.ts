// Search, filter, sort and the prefs schema of the Transactions toolbar (synthetic rows).
import { describe, expect, it } from 'vitest'
import type { Account, Category, Txn } from './types'
import {
  anythingActive, applyTxnView, categoryChoices, defaultTxnViewPrefs, filterTxns, merchantChoices, parseTxnViewPrefs, sortTxns, withSameAmount, fitPrefs, txnPrefsBytes, TXN_PREFS_MAX_BYTES, type TxnViewPrefs,
} from './txnView'

const acct = (id: string, label: string, personId: string | null): Account =>
  ({ id, label, kind: 'checking', personId, last4: null, isDebt: false, inSpending: true, creditLimitCents: null, aprBp: null }) as Account
const accounts = [acct('a1', 'Checking A', 'pa'), acct('a2', 'Card B', 'pb'), acct('a3', 'Joint', null)]
const categories: Category[] = [
  { id: 'groceries', label: 'Groceries', color: null, sort: 1 },
  { id: 'fun', label: 'Fun', color: null, sort: 2 },
]
const ctx = { categories, accounts }
let n = 0
const txn = (o: Partial<Txn>): Txn =>
  ({ id: `t${++n}`, accountId: 'a1', postedDate: '2026-11-10', txnDate: null, amountCents: -1000, description: 'POS DEBIT', merchantKey: 'm1', merchantName: 'Merchant One',
    storeNo: null, kind: 'spend', kindSource: 'auto', categoryId: 'groceries', categorySource: 'auto', ruleId: null, confidence: 1, needsReview: false, reviewReason: null,
    pairId: null, debtAccountId: null, principalCents: null, interestCents: null, note: null, updatedAt: 'x', updatedBy: 'y', ...o }) as Txn

const rows = [
  txn({ id: 'r1', postedDate: '2026-11-12', merchantKey: 'acme', merchantName: 'Acme Market', amountCents: -2500, categoryId: 'groceries', accountId: 'a1', note: 'weekly Shop' }),
  txn({ id: 'r2', postedDate: '2026-11-05', merchantKey: 'zed', merchantName: 'Zed Cinema', amountCents: -1500, categoryId: 'fun', accountId: 'a2', description: 'ZED CINEMA #12' }),
  txn({ id: 'r3', postedDate: '2026-11-08', merchantKey: 'acme', merchantName: 'Acme Market', amountCents: -500, categoryId: null, accountId: 'a3' }),
  txn({ id: 'r4', postedDate: '2026-11-08', merchantKey: 'bob', merchantName: '', description: 'BOBS DINER', amountCents: 4000, categoryId: 'fun', accountId: 'a1' }),
]
const prefs = (o: Partial<TxnViewPrefs>): TxnViewPrefs => ({ ...defaultTxnViewPrefs(), ...o })
const ids = (r: Txn[]) => r.map((t) => t.id)

describe('search', () => {
  it('is case-insensitive over merchant, raw description and note', () => {
    expect(ids(filterTxns(rows, prefs({ search: 'ACME' }), ctx))).toEqual(['r1', 'r3'])
    expect(ids(filterTxns(rows, prefs({ search: 'cinema #12' }), ctx))).toEqual(['r2'])
    expect(ids(filterTxns(rows, prefs({ search: 'weekly shop' }), ctx))).toEqual(['r1'])
    expect(ids(filterTxns(rows, prefs({ search: 'diner' }), ctx))).toEqual(['r4'])
    expect(ids(filterTxns(rows, prefs({ search: 'nothing here' }), ctx))).toEqual([])
  })
  it('every typed word must match; blank search matches all', () => {
    expect(ids(filterTxns(rows, prefs({ search: 'acme weekly' }), ctx))).toEqual(['r1'])
    expect(filterTxns(rows, prefs({ search: '   ' }), ctx)).toHaveLength(4)
  })
})

describe('filters', () => {
  it('merchant, category (incl. uncategorized), account and person are multi-select and combine', () => {
    expect(ids(filterTxns(rows, prefs({ merchants: ['acme', 'zed'] }), ctx))).toEqual(['r1', 'r2', 'r3'])
    expect(ids(filterTxns(rows, prefs({ categories: ['fun'] }), ctx))).toEqual(['r2', 'r4'])
    expect(ids(filterTxns(rows, prefs({ categories: ['__none__'] }), ctx))).toEqual(['r3'])
    expect(ids(filterTxns(rows, prefs({ accounts: ['a1', 'a3'] }), ctx))).toEqual(['r1', 'r3', 'r4'])
    expect(ids(filterTxns(rows, prefs({ people: ['pa'] }), ctx))).toEqual(['r1', 'r4'])
    expect(ids(filterTxns(rows, prefs({ people: ['pa', 'pb'], categories: ['fun'] }), ctx))).toEqual(['r2', 'r4'])
  })
  it('date range is inclusive', () => {
    expect(ids(filterTxns(rows, prefs({ from: '2026-11-08', to: '2026-11-08' }), ctx))).toEqual(['r3', 'r4'])
    expect(ids(filterTxns(rows, prefs({ from: '2026-11-09' }), ctx))).toEqual(['r1'])
    expect(ids(filterTxns(rows, prefs({ to: '2026-11-05' }), ctx))).toEqual(['r2'])
  })
  it('activity flags: sort alone counts as something active', () => {
    expect(anythingActive(defaultTxnViewPrefs())).toBe(false)
    expect(anythingActive(prefs({ sortKey: 'amount' }))).toBe(true)
    expect(anythingActive(prefs({ search: 'x' }))).toBe(true)
  })
})

describe('sort', () => {
  it('sorts by each key, both directions', () => {
    expect(ids(sortTxns(rows, prefs({ sortKey: 'date', sortDir: 'asc' }), ctx))).toEqual(['r2', 'r3', 'r4', 'r1'])
    expect(ids(sortTxns(rows, prefs({ sortKey: 'amount', sortDir: 'asc' }), ctx))).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(ids(sortTxns(rows, prefs({ sortKey: 'amount', sortDir: 'desc' }), ctx))).toEqual(['r4', 'r3', 'r2', 'r1'])
    expect(ids(sortTxns(rows, prefs({ sortKey: 'merchant', sortDir: 'asc' }), ctx))).toEqual(['r1', 'r3', 'r4', 'r2'])
    expect(ids(sortTxns(rows, prefs({ sortKey: 'category', sortDir: 'asc' }), ctx))).toEqual(['r2', 'r4', 'r1', 'r3'])
    expect(ids(sortTxns(rows, prefs({ sortKey: 'account', sortDir: 'asc' }), ctx))).toEqual(['r2', 'r1', 'r4', 'r3'])
  })
  it('default view keeps the server order; ties keep it too', () => {
    expect(ids(applyTxnView(rows, defaultTxnViewPrefs(), ctx))).toEqual(['r1', 'r2', 'r3', 'r4'])
    expect(ids(applyTxnView(rows, prefs({ sortKey: 'date', sortDir: 'asc' }), ctx))).toEqual(['r2', 'r3', 'r4', 'r1'])
  })
  it('filters then sorts', () => {
    expect(ids(applyTxnView(rows, prefs({ categories: ['fun'], sortKey: 'amount', sortDir: 'asc' }), ctx))).toEqual(['r2', 'r4'])
  })
})

describe('choices', () => {
  it('lists the merchants and categories present, A to Z, one each', () => {
    expect(merchantChoices(rows).map((c) => c.label)).toEqual(['Acme Market', 'BOBS DINER', 'Zed Cinema'])
    expect(categoryChoices(rows, ctx)).toEqual([{ value: 'fun', label: 'Fun' }, { value: 'groceries', label: 'Groceries' }, { value: '__none__', label: 'Uncategorized' }])
  })
})

describe('prefs schema', () => {
  it('round-trips a valid value', () => {
    const p = prefs({ search: 'x', merchants: ['a'], from: '2026-11-01', sortKey: 'amount', sortDir: 'asc' })
    expect(parseTxnViewPrefs(JSON.parse(JSON.stringify(p)), true)).toEqual(p)
  })
  it('strict mode rejects unknown fields, missing fields, bad types, bad enums, long lists and bad dates', () => {
    const ok = defaultTxnViewPrefs()
    expect(parseTxnViewPrefs({ ...ok, extra: 1 }, true)).toBeNull()
    const { search: _s, ...missing } = ok
    expect(parseTxnViewPrefs(missing, true)).toBeNull()
    expect(parseTxnViewPrefs({ ...ok, merchants: 'a' }, true)).toBeNull()
    expect(parseTxnViewPrefs({ ...ok, merchants: [1] }, true)).toBeNull()
    expect(parseTxnViewPrefs({ ...ok, sortKey: 'nope' }, true)).toBeNull()
    expect(parseTxnViewPrefs({ ...ok, sortDir: 'up' }, true)).toBeNull()
    expect(parseTxnViewPrefs({ ...ok, from: '11/01/2026' }, true)).toBeNull()
    expect(parseTxnViewPrefs({ ...ok, search: 'x'.repeat(101) }, true)).toBeNull()
    expect(parseTxnViewPrefs({ ...ok, categories: Array.from({ length: 101 }, (_, i) => `c${i}`) }, true)).toBeNull()
    expect(parseTxnViewPrefs([], true)).toBeNull()
    expect(parseTxnViewPrefs(null, true)).toBeNull()
  })
  it('lenient mode (the browser cache) falls back per field', () => {
    const p = parseTxnViewPrefs({ search: 5, merchants: ['a', 3], sortKey: 'amount', junk: true })
    expect(p).toEqual(prefs({ merchants: ['a'], sortKey: 'amount' }))
  })
})

const { sameAmount: _gone, ...oldBlob } = defaultTxnViewPrefs()
describe('sameAmount choices', () => {
  it('an old blob without the field parses to an empty map', () => {
    expect(parseTxnViewPrefs(oldBlob, true)?.sameAmount).toEqual({})
  })
  it('strict parse rejects bad values, long keys, an empty key and more than 30 entries', () => {
    expect(parseTxnViewPrefs({ sameAmount: { acme: 'yes' } }, true)).toBeNull()
    expect(parseTxnViewPrefs({ sameAmount: { '': true } }, true)).toBeNull()
    expect(parseTxnViewPrefs({ sameAmount: { ['k'.repeat(81)]: true } }, true)).toBeNull()
    expect(parseTxnViewPrefs({ sameAmount: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`m${i}`, true])) }, true)).toBeNull()
    expect(parseTxnViewPrefs({ ...oldBlob, sameAmount: { acme: false } }, true)?.sameAmount).toEqual({ acme: false })
  })
  it('lenient parse drops bad entries', () => {
    expect(parseTxnViewPrefs({ sameAmount: { acme: true, bad: 3 } })?.sameAmount).toEqual({ acme: true })
  })
  it('withSameAmount replaces a key and keeps at most 30, newest last', () => {
    let p = defaultTxnViewPrefs()
    for (let i = 0; i < 31; i++) p = withSameAmount(p, `m${i}`, true)
    expect(Object.keys(p.sameAmount)).toHaveLength(30)
    expect(p.sameAmount.m0).toBeUndefined()
    p = withSameAmount(p, 'm5', false)
    expect(p.sameAmount.m5).toBe(false)
    expect(Object.keys(p.sameAmount).at(-1)).toBe('m5')
  })
})

describe('the 4 KB prefs budget', () => {
  const list = (t: string, n: number) => Array.from({ length: n }, (_, i) => `${t}${i}`.padEnd(100, 'x'))
  it('the strict parse refuses a blob that serialises over the cap, whatever the per-field caps allow', () => {
    const big = { ...defaultTxnViewPrefs(), merchants: list('m', 25), categories: list('c', 25), accounts: list('a', 25) }
    expect(txnPrefsBytes(big as TxnViewPrefs)).toBeGreaterThan(TXN_PREFS_MAX_BYTES)
    expect(parseTxnViewPrefs(big, true)).toBeNull()
    expect(parseTxnViewPrefs(big)).not.toBeNull() // the cache still reads it
  })
  it('fitPrefs drops the oldest same-amount choices first, and gives up (null) when the filters alone are too big', () => {
    const same = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`.padEnd(80, 'y'), true]))
    const p = { ...defaultTxnViewPrefs(), merchants: list('m', 28), sameAmount: same }
    const fit = fitPrefs(p)!
    expect(txnPrefsBytes(fit)).toBeLessThanOrEqual(TXN_PREFS_MAX_BYTES)
    expect(Object.keys(fit.sameAmount).length).toBeLessThan(30)
    expect(Object.keys(fit.sameAmount)).toEqual(Object.keys(same).slice(30 - Object.keys(fit.sameAmount).length))
    expect(fitPrefs({ ...defaultTxnViewPrefs(), merchants: list('m', 100) })).toBeNull()
    expect(fitPrefs(defaultTxnViewPrefs())).toEqual(defaultTxnViewPrefs())
  })
})
