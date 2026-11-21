// The Budget table's logic with fake calls: helpers, category choices, paging, optimistic edit and revert, the rule.
// Made-up data only.
import { describe, expect, it, vi } from 'vitest'
import {
  budgetColumns, categoryOptions, createTxnTable, formatAmount, formatDate, leavesSlice, parseSelection, selectValueFor,
  type TableDeps,
} from './tableModel'
import { BudgetApiError } from './clientEdit'
import type { Account, BudgetEditedEvent, Category, Txn, TxnQuery } from './types'

const CATS: Category[] = [
  { id: 'groceries', label: 'Groceries', color: null, sort: 10 },
  { id: 'fuel', label: 'Fuel', color: '#112233', sort: 20 },
  { id: 'other', label: 'Other', color: null, sort: 990 },
]
const ACCOUNTS: Account[] = [{ id: 'a1', label: 'Checking A', kind: 'checking', personId: null, last4: '0001', isDebt: false, inSpending: true, creditLimitCents: null, aprBp: null }]
const Q: TxnQuery = { from: '2026-10-01', to: '2026-10-31', person: 'all', scope: 'spending' }

function txn(id: string, over: Partial<Txn> = {}): Txn {
  return {
    id, accountId: 'a1', postedDate: '2026-10-05', txnDate: null, amountCents: -1234, description: 'CHAIN X 0001', merchantKey: 'chain-x',
    merchantName: 'Chain X', storeNo: null, kind: 'spend', kindSource: 'auto', categoryId: 'groceries', categorySource: 'auto', ruleId: null,
    confidence: 50, needsReview: false, reviewReason: null, pairId: null, debtAccountId: null, principalCents: null, interestCents: null,
    note: null, updatedAt: '2026-10-06T00:00:00Z', updatedBy: 'user@example.com', ruleSafe: true, ...over,
  }
}

function setup(rows: Txn[], over: Partial<TableDeps> = {}, query: TxnQuery = Q) {
  const deps: TableDeps = {
    fetchPage: vi.fn(async () => ({ rows, nextCursor: null })),
    patch: vi.fn(async (id, p) => ({ txn: { ...rows.find((r) => r.id === id)!, ...(p.categoryId !== undefined ? { categoryId: p.categoryId } : {}), ...(p.kind ? { kind: p.kind } : {}), categorySource: 'manual' as const, updatedAt: '2026-10-07T00:00:00Z' } })),
    createRule: vi.fn(async () => ({ rule: { id: 'r' + 'a'.repeat(16), merchantKey: 'chain-x', storeNo: null, accountId: null, amountMinCents: null, amountMaxCents: null, setCategoryId: 'fuel', setKind: null, debtAccountId: null, displayName: null, confidence: 90, review: false, reviewReason: null, source: 'edit' as const, active: true }, reapplied: 1 })),
    ...over,
  }
  const edited: BudgetEditedEvent[] = []
  const model = createTxnTable(deps, () => CATS, (e) => edited.push(e))
  return { deps, model, edited, query }
}

describe('helpers', () => {
  it('formats dates without time zones, adding the year when it is not this year', () => {
    expect(formatDate('2026-11-05', 2026)).toBe('Nov 5')
    expect(formatDate('2025-12-31', 2026)).toBe('Dec 31, 2025')
    expect(formatDate('garbage')).toBe('garbage')
  })
  it('formats cents with the sign kept', () => {
    expect(formatAmount(-1234)).toBe('-$12.34')
    expect(formatAmount(500)).toBe('$5.00')
  })
  it('category choices: categories by sort, Uncategorized, then the Not spending group', () => {
    const o = categoryOptions(CATS)
    expect(o.map((x) => x.label)).toEqual(['Groceries', 'Fuel', 'Other', 'Uncategorized', 'Transfer', 'Income', 'Exclude'])
    expect(o.filter((x) => x.group).map((x) => x.group)).toEqual(['Not spending', 'Not spending', 'Not spending'])
  })
  it('a row of another non-spending kind keeps a (disabled) choice of its own', () => {
    const row = txn('t1', { kind: 'card_payment' })
    expect(selectValueFor(row)).toBe('kind:card_payment')
    expect(categoryOptions(CATS, row).find((x) => x.value === 'kind:card_payment')).toMatchObject({ label: 'Card payment', disabled: true })
  })
  it('select values: category id, "" for none, kind choices', () => {
    expect(selectValueFor(txn('t1'))).toBe('groceries')
    expect(selectValueFor(txn('t1', { categoryId: null }))).toBe('')
    expect(selectValueFor(txn('t1', { kind: 'transfer' }))).toBe('kind:transfer')
    expect(selectValueFor(txn('t1', { kind: 'other' }))).toBe('kind:exclude')
    expect(parseSelection('fuel')).toEqual({ categoryId: 'fuel' })
    expect(parseSelection('')).toEqual({ categoryId: null })
    expect(parseSelection('kind:income')).toEqual({ kind: 'income' })
    expect(parseSelection('kind:exclude')).toEqual({ kind: 'other' })
    expect(parseSelection('kind:card_payment')).toEqual({})
  })
  it('columns: the category is the only editor; the account shows on the card (line 2, above the category)', () => {
    const cols = budgetColumns(CATS, ACCOUNTS)
    expect(cols.filter((c) => c.editor).map((c) => c.key)).toEqual(['category'])
    expect(cols.find((c) => c.key === 'account')?.cardLine).toBe(2)
    expect(cols.map((c) => c.key).indexOf('account')).toBeLessThan(cols.map((c) => c.key).indexOf('category'))
    expect(cols.find((c) => c.key === 'account')?.value?.(txn('t1'))).toBe('Checking A')
  })
  it('leavesSlice: category, scope and review', () => {
    expect(leavesSlice({ ...Q, category: 'groceries' }, txn('t1'), CATS)).toBeNull()
    expect(leavesSlice({ ...Q, category: 'groceries' }, txn('t1', { categoryId: 'fuel' }), CATS)).toBe('Moved to Fuel')
    expect(leavesSlice({ ...Q, category: '__none__' }, txn('t1', { categoryId: null }), CATS)).toBeNull()
    expect(leavesSlice(Q, txn('t1', { kind: 'transfer' }), CATS)).toBe('Moved to Transfer')
    expect(leavesSlice({ ...Q, scope: 'all' }, txn('t1', { kind: 'transfer' }), CATS)).toBeNull()
    expect(leavesSlice({ ...Q, review: true }, txn('t1', { needsReview: false }), CATS)).toMatch(/Reviewed/)
  })
})

describe('paging', () => {
  it('load starts at the first page; loadMore appends the next page and drops repeats', async () => {
    const fetchPage = vi.fn()
      .mockResolvedValueOnce({ rows: [txn('t1'), txn('t2')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ rows: [txn('t2'), txn('t3')], nextCursor: null })
    const { model } = setup([], { fetchPage })
    await model.load(Q)
    expect(model.rows.value.map((r) => r.id)).toEqual(['t1', 't2'])
    await model.loadMore()
    expect(fetchPage).toHaveBeenLastCalledWith({ ...Q, cursor: 'c1' })
    expect(model.rows.value.map((r) => r.id)).toEqual(['t1', 't2', 't3'])
    expect(model.nextCursor.value).toBeNull()
    await model.loadMore() // no cursor: nothing to do
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('a new load resets paging and ignores a slower answer to the old query', async () => {
    let finishOld: (v: unknown) => void = () => {}
    const fetchPage = vi.fn()
      .mockImplementationOnce(() => new Promise((res) => { finishOld = res }))
      .mockResolvedValueOnce({ rows: [txn('new')], nextCursor: null })
    const { model } = setup([], { fetchPage: fetchPage as never })
    const first = model.load(Q)
    await model.load({ ...Q, category: 'fuel' })
    finishOld({ rows: [txn('old')], nextCursor: 'stale' })
    await first
    expect(model.rows.value.map((r) => r.id)).toEqual(['new'])
    expect(model.nextCursor.value).toBeNull()
    expect(fetchPage).toHaveBeenLastCalledWith({ ...Q, category: 'fuel', cursor: undefined })
  })

  it('a load error is kept for Retry', async () => {
    const { model } = setup([], { fetchPage: vi.fn().mockRejectedValue(new Error('boom')) })
    await model.load(Q)
    expect(model.loadError.value).toBe('boom')
    expect(model.loading.value).toBe(false)
  })
})

describe('edits', () => {
  it('shows the new category at once, sends expectedUpdatedAt, then emits edited and offers the rule', async () => {
    const rows = [txn('t1')]
    let release: () => void = () => {}
    const patch = vi.fn((id: string) => new Promise<{ txn: Txn }>((res) => {
      release = () => res({ txn: txn(id, { categoryId: 'fuel', categorySource: 'manual', updatedAt: 'NEW' }) })
    }))
    const { model, edited } = setup(rows, { patch: patch as never })
    await model.load(Q)
    const pending = model.setSelection('t1', 'fuel')
    expect(model.rows.value[0].categoryId).toBe('fuel')
    expect(model.rowState.t1.pending).toBe(true)
    expect(patch).toHaveBeenCalledWith('t1', { categoryId: 'fuel', expectedUpdatedAt: '2026-10-06T00:00:00Z' })
    expect(edited).toEqual([])
    release()
    await pending
    expect(model.rows.value[0].updatedAt).toBe('NEW')
    expect(model.rowState.t1.pending).toBeFalsy()
    expect(model.rowState.t1.action?.label).toBe('Use for all Chain X')
    expect(edited).toEqual([{ txnId: 't1', ruleApplied: false, reapplied: 0 }])
    expect(model.status.value).toContain('Fuel')
  })

  it('a second edit of a row waits while the first is in flight', async () => {
    const patch = vi.fn(() => new Promise(() => {}))
    const { model } = setup([txn('t1')], { patch: patch as never })
    await model.load(Q)
    void model.setSelection('t1', 'fuel')
    await model.setSelection('t1', 'other')
    expect(patch).toHaveBeenCalledTimes(1)
  })

  it('409: the row takes the server value and says so; nothing is emitted', async () => {
    const current = txn('t1', { categoryId: 'other', updatedAt: 'SERVER' })
    const { model, edited } = setup([txn('t1')], { patch: vi.fn().mockRejectedValue(new BudgetApiError(409, 'conflict', 'row changed', current)) })
    await model.load(Q)
    await model.setSelection('t1', 'fuel')
    expect(model.rows.value[0].categoryId).toBe('other')
    expect(model.rows.value[0].updatedAt).toBe('SERVER')
    expect(model.rowState.t1.error).toBe('Changed by someone else. It is now Other.')
    expect(edited).toEqual([])
  })

  it('a network failure puts the row back', async () => {
    const { model, edited } = setup([txn('t1')], { patch: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) })
    await model.load(Q)
    await model.setSelection('t1', 'fuel')
    expect(model.rows.value[0].categoryId).toBe('groceries')
    expect(model.rowState.t1.pending).toBeFalsy()
    expect(model.rowState.t1.error).toMatch(/Couldn’t save/)
    expect(edited).toEqual([])
  })

  it('another server error also reverts, naming the status', async () => {
    const { model } = setup([txn('t1')], { patch: vi.fn().mockRejectedValue(new BudgetApiError(500, null, 'x')) })
    await model.load(Q)
    await model.setSelection('t1', 'fuel')
    expect(model.rows.value[0].categoryId).toBe('groceries')
    expect(model.rowState.t1.error).toContain('500')
  })

  it('"Not spending" sets the kind and leaves the category; a spending row there is dimmed "moved to"', async () => {
    const { model, deps } = setup([txn('t1')])
    await model.load(Q)
    await model.setSelection('t1', 'kind:transfer')
    expect(deps.patch).toHaveBeenCalledWith('t1', { kind: 'transfer', expectedUpdatedAt: '2026-10-06T00:00:00Z' })
    expect(model.rows.value[0].categoryId).toBe('groceries')
    expect(model.rowState.t1).toMatchObject({ dimmed: true, message: 'Moved to Transfer' })
    expect(model.rowState.t1.action).toBeUndefined() // a kind change offers no category rule
  })

  it('a row edited out of the slice stays, dimmed "moved to X", until the next query', async () => {
    const { model } = setup([txn('t1')])
    await model.load({ ...Q, category: 'groceries' })
    await model.setSelection('t1', 'fuel')
    expect(model.rows.value.map((r) => r.id)).toEqual(['t1'])
    expect(model.rowState.t1).toMatchObject({ dimmed: true, message: 'Moved to Fuel' })
    await model.load({ ...Q, category: 'fuel' })
    expect(model.rowState.t1).toBeUndefined()
  })

  it('giving a category to a row that was not spending also sets kind spend', async () => {
    const { model, deps } = setup([txn('t1', { kind: 'transfer' })])
    await model.load({ ...Q, scope: 'all' })
    await model.setSelection('t1', 'fuel')
    expect(deps.patch).toHaveBeenCalledWith('t1', { categoryId: 'fuel', kind: 'spend', expectedUpdatedAt: '2026-10-06T00:00:00Z' })
  })

  it('choosing what the row already has does nothing', async () => {
    const { model, deps } = setup([txn('t1')])
    await model.load(Q)
    await model.setSelection('t1', 'groceries')
    expect(deps.patch).not.toHaveBeenCalled()
  })
})

describe('use for all', () => {
  it('posts the rule, reports the count, updates the page\'s other rows of that merchant and emits edited', async () => {
    const rows = [txn('t1'), txn('t2'), txn('t3', { categorySource: 'manual' }), txn('t4', { merchantKey: 'other-shop', merchantName: 'Other Shop' })]
    const { model, deps, edited } = setup(rows)
    await model.load({ ...Q, category: 'groceries' })
    await model.setSelection('t1', 'fuel')
    await model.useForAll('t1')
    expect(deps.createRule).toHaveBeenCalledWith({ txnId: 't1', scope: 'merchant' })
    expect(model.rowState.t1.message).toBe('Rule saved. 1 other row changed.')
    expect(model.rowState.t1.action).toBeUndefined()
    expect(model.rows.value.find((r) => r.id === 't2')).toMatchObject({ categoryId: 'fuel', categorySource: 'rule' })
    expect(model.rowState.t2.message).toBe('Moved to Fuel')
    expect(model.rows.value.find((r) => r.id === 't3')?.categoryId).toBe('groceries') // manual rows are never touched
    expect(model.rows.value.find((r) => r.id === 't4')?.categoryId).toBe('groceries')
    expect(edited.at(-1)).toEqual({ txnId: 't1', ruleApplied: true, reapplied: 1 })
  })

  it('offers no rule when the server says a rule on this key would reach other merchants (ruleSafe false)', async () => {
    const { model, deps } = setup([txn('t1', { merchantKey: 'shared-key', merchantName: 'Merchant One', ruleSafe: false })])
    await model.load(Q)
    await model.setSelection('t1', 'fuel')
    expect(model.rowState.t1?.action).toBeUndefined()
    expect(model.status.value).toContain('Fuel') // the edit itself still saves
    await model.useForAll('t1')
    expect(deps.createRule).not.toHaveBeenCalled()
  })

  it('a row without the flag gets no offer either', async () => {
    const { model } = setup([txn('t1', { ruleSafe: undefined })])
    await model.load(Q)
    await model.setSelection('t1', 'fuel')
    expect(model.rowState.t1?.action).toBeUndefined()
  })

  it('a failed rule keeps the offer and says why', async () => {
    const { model, edited } = setup([txn('t1')], { createRule: vi.fn().mockRejectedValue(new BudgetApiError(400, 'bad_request', 'x')) })
    await model.load(Q)
    await model.setSelection('t1', 'fuel')
    await model.useForAll('t1')
    expect(model.rowState.t1.error).toContain('400')
    expect(model.rowState.t1.action?.busy).toBe(false)
    expect(edited).toHaveLength(1) // only the edit
  })
})
