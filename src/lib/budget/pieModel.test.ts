import { describe, expect, it } from 'vitest'
import { CATEGORY_PALETTE, NONE_COLOR, OTHER_COLOR, shadeOf } from './colors'
import { debtSlices, foldSlices, formatApr, MAX_SLICES, OTHER_KEY, purchaseLabel, shortDate, spendingSlices } from './pieModel'
import { rowDotColor } from './tableModel'
import { UNCATEGORIZED, type Category, type DebtSlice, type SummaryResponse, type Txn } from './types'

const CATS: Category[] = [
  { id: 'groceries', label: 'Groceries', color: null, sort: 10 },
  { id: 'fuel', label: 'Fuel', color: null, sort: 20 },
]
const sum = (level: SummaryResponse['level'], slices: Array<[string, number, number?]>): SummaryResponse => ({
  level,
  slices: slices.map(([key, netCents, count]) => ({ key, label: key.toUpperCase(), netCents, count: count ?? 1 })),
  totalCents: slices.reduce((n, s) => n + s[1], 0),
  reviewCount: 0,
})

describe('spendingSlices', () => {
  it('category level: biggest first, each slice in its category colour, refunds above spend dropped', () => {
    const s = spendingSlices(sum('category', [['fuel', 5000, 2], ['groceries', 12000, 3], ['dining', -400]]), CATS, [])
    expect(s.map((x) => [x.key, x.value])).toEqual([['groceries', 12000], ['fuel', 5000]])
    expect(s[0].color).toBe(CATEGORY_PALETTE[0])
    expect(s[1].color).toBe(CATEGORY_PALETTE[1])
    expect(s[0].detail).toBe('3 purchases')
    expect(s[1].detail).toBe('2 purchases')
    expect(spendingSlices(sum('category', [['fuel', 100, 1]]), CATS, [])[0].detail).toBe('1 purchase')
  })
  it('the uncategorized slice is the neutral grey', () => {
    const s = spendingSlices(sum('category', [[UNCATEGORIZED, 900]]), CATS, [])
    expect(s[0].color).toBe(NONE_COLOR)
  })
  it('PARITY: a category slice has exactly the colour of the table dot for a row of that category', () => {
    const row = (categoryId: string | null) => ({ kind: 'spend', categoryId }) as Txn
    for (const c of CATS) {
      const slice = spendingSlices(sum('category', [[c.id, 100]]), CATS, [])[0]
      expect(slice.color).toBe(rowDotColor(CATS, row(c.id)))
    }
    expect(spendingSlices(sum('category', [[UNCATEGORIZED, 100]]), CATS, [])[0].color).toBe(rowDotColor(CATS, row(null)))
  })
  it('deeper levels are shades of the category being looked into', () => {
    const path = [{ level: 'category' as const, key: 'fuel', label: 'Fuel' }]
    const m = spendingSlices(sum('merchant', [['a', 300], ['b', 200], ['c', 100]]), CATS, path)
    expect(m.map((x) => x.color)).toEqual([0, 1, 2].map((i) => shadeOf(CATEGORY_PALETTE[1], i)))
    const p = spendingSlices(sum('purchase', [['t1', 300]]), CATS, [...path, { level: 'merchant', key: 'a', label: 'A' }])
    expect(p[0].detail).toBeUndefined()
  })
  it('more than MAX_SLICES fold into one bucket (never called "Other") holding the sum of the rest', () => {
    const rows: Array<[string, number]> = Array.from({ length: 15 }, (_, i) => [`m${String(i).padStart(2, '0')}`, 1000 - i * 10])
    const s = spendingSlices(sum('merchant', rows), CATS, [{ level: 'category', key: 'fuel', label: 'Fuel' }])
    expect(s).toHaveLength(MAX_SLICES)
    const other = s.at(-1)!
    expect(other).toMatchObject({ key: OTHER_KEY, color: OTHER_COLOR })
    expect(other.inert).toBeUndefined()
    expect(other.members?.map((m) => m.key)).toEqual(['m11', 'm12', 'm13', 'm14'])
    expect(other.members?.reduce((n, m) => n + m.value, 0)).toBe(other.value)
    const keptSum = s.slice(0, -1).reduce((n, x) => n + x.value, 0)
    expect(keptSum + other.value).toBe(rows.reduce((n, r) => n + r[1], 0))
    expect(other.label).toBe('4 smaller stores')
    expect(s.slice(0, -1).every((x) => !x.inert && !x.members)).toBe(true)
  })
  it('the bucket names what it holds: categories, accounts, purchases', () => {
    const rows: Array<[string, number]> = Array.from({ length: 5 }, (_, i) => [`m${i}`, 100 - i])
    expect(spendingSlices(sum('category', rows), CATS, [], 3).at(-1)!.label).toBe('3 smaller categories')
    expect(spendingSlices(sum('merchant', rows), CATS, [{ level: 'category', key: 'fuel', label: 'Fuel' }], 3, 'account').at(-1)!.label).toBe('3 smaller accounts')
    expect(spendingSlices(sum('purchase', rows), CATS, [], 3).at(-1)!.label).toBe('3 smaller purchases')
  })
})

describe('foldSlices', () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `K${i}`, value: 100 - i, color: '#000000' }))
  it('leaves max or fewer slices alone, and folds the smallest when there are more', () => {
    expect(foldSlices(mk(12), 12)).toHaveLength(12)
    const f = foldSlices(mk(5), 3)
    expect(f.map((x) => x.key)).toEqual(['k0', 'k1', OTHER_KEY])
    expect(f[2].value).toBe(98 + 97 + 96)
    expect(f[2].label).toBe('3 smaller slices')
    expect(f[2].members?.map((m) => m.key)).toEqual(['k2', 'k3', 'k4'])
  })
})

describe('debtSlices', () => {
  const debt = (id: string, balance: number | null, extra: Partial<DebtSlice> = {}): DebtSlice => ({
    accountId: id, label: `Debt ${id}`, kind: 'loan', last4: null, personId: null, balanceCents: balance, asOf: null, source: null,
    aprBp: null, creditLimitCents: null, ...extra,
  })
  it('one slice per debt with a balance, biggest first; no balance and paid off are listed apart', () => {
    const r = debtSlices([debt('a', 100000, { last4: '0001', aprBp: 1999 }), debt('b', null), debt('c', 0), debt('d', 250000)])
    expect(r.slices.map((s) => [s.key, s.value])).toEqual([['d', 250000], ['a', 100000]])
    expect(r.slices.find((s) => s.key === 'a')!.detail).toBe('••0001 · 19.99% APR')
    expect(r.noBalance.map((d) => d.accountId)).toEqual(['b'])
    expect(r.settled.map((d) => d.accountId)).toEqual(['c'])
  })
  it('a debt keeps its colour by its place in the list', () => {
    const all = debtSlices([debt('a', 100), debt('b', 200)]).slices
    expect(all.find((s) => s.key === 'b')!.color).toBe(CATEGORY_PALETTE[1])
  })
  it('formats a rate from basis points', () => {
    expect(formatApr(1999)).toBe('19.99%')
    expect(formatApr(0)).toBe('0.00%')
  })
})

describe('purchase legend labels', () => {
  const slice = { key: 't1', label: '2026-08-11 Maple Mart', netCents: 300, count: 1, date: '2026-08-11', merchant: 'Maple Mart' }
  it('shortDate: a short month and day, the year only when it is not this year, bad input untouched', () => {
    expect(shortDate('2026-08-11', 2026)).toBe('Aug 11')
    expect(shortDate('2026-01-05', 2026)).toBe('Jan 5')
    expect(shortDate('2025-12-31', 2026)).toBe('Dec 31, 2025')
    expect(shortDate('2026-13-01', 2026)).toBe('2026-13-01')
    expect(shortDate('soon', 2026)).toBe('soon')
  })
  it('purchaseLabel: the date alone under a store; the store too when the pie is grouped by account', () => {
    expect(purchaseLabel(slice, false, 2026)).toBe('Aug 11')
    expect(purchaseLabel(slice, true, 2026)).toBe('Aug 11 · Maple Mart')
    expect(purchaseLabel({ ...slice, merchant: undefined }, true, 2026)).toBe('Aug 11')
  })
  it('purchaseLabel falls back to the server label when the slice has no date', () => {
    const { date: _d, merchant: _m, ...bare } = slice
    expect(purchaseLabel(bare, false)).toBe('2026-08-11 Maple Mart')
  })
  it('spendingSlices uses it at the purchase level only', () => {
    const res: SummaryResponse = { level: 'purchase', slices: [slice], totalCents: 300, reviewCount: 0 }
    const path = [{ level: 'category' as const, key: 'groceries', label: 'Groceries' }]
    expect(spendingSlices(res, CATS, path, undefined, 'merchant')[0].label).toBe(purchaseLabel(slice, false))
    expect(spendingSlices(res, CATS, path, undefined, 'account')[0].label).toBe(purchaseLabel(slice, true))
    expect(spendingSlices({ ...res, level: 'merchant' }, CATS, path)[0].label).toBe('2026-08-11 Maple Mart')
  })
})
