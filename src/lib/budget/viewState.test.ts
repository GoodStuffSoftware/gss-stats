// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import {
  defaultViewState, presetOf, rangeForPreset, rangeValid, searchWithState, stateFromSearch, summaryQueryOf, todayIso, txnQueryOf,
  useBudgetViewState, type BudgetViewState,
} from './viewState'

const TODAY = '2026-11-20'

describe('range presets', () => {
  it('computes each preset from today', () => {
    expect(rangeForPreset('this-month', TODAY)).toEqual({ from: '2026-11-01', to: '2026-11-20' })
    expect(rangeForPreset('last-month', TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(rangeForPreset('3-months', TODAY)).toEqual({ from: '2026-09-01', to: '2026-11-20' })
    expect(rangeForPreset('ytd', TODAY)).toEqual({ from: '2026-01-01', to: '2026-11-20' })
    expect(rangeForPreset('custom', TODAY)).toBeNull()
  })
  it('wraps the year in January and takes leap February', () => {
    expect(rangeForPreset('last-month', '2026-01-15')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(rangeForPreset('3-months', '2026-02-10')).toEqual({ from: '2025-12-01', to: '2026-02-10' })
    expect(rangeForPreset('last-month', '2028-03-05')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })
  it('names the preset a range is on, else custom', () => {
    expect(presetOf('2026-10-01', '2026-10-31', TODAY)).toBe('last-month')
    expect(presetOf('2026-11-01', '2026-11-20', TODAY)).toBe('this-month')
    expect(presetOf('2026-11-02', '2026-11-20', TODAY)).toBe('custom')
  })
  it('todayIso uses the local calendar date', () => {
    expect(todayIso(new Date(2026, 10, 5, 23, 59))).toBe('2026-11-05')
  })
})

describe('rangeValid', () => {
  it('accepts real ranges up to 400 days and refuses the rest', () => {
    expect(rangeValid('2026-11-01', '2026-11-01')).toBe(true)
    expect(rangeValid('2026-01-01', '2027-02-04')).toBe(true) // 400 days
    expect(rangeValid('2026-01-01', '2027-02-05')).toBe(false) // 401 days
    expect(rangeValid('2026-11-20', '2026-11-01')).toBe(false)
    expect(rangeValid('2026-02-30', '2026-03-01')).toBe(false)
    expect(rangeValid('nope', '2026-03-01')).toBe(false)
  })
})

describe('URL round trip', () => {
  it('{from,to,person,path,groupBy,reviewOnly,tab} survives state -> search -> state', () => {
    const s: BudgetViewState = {
      from: '2026-09-01',
      to: '2026-10-31',
      person: 'p2',
      path: [
        { level: 'category', key: 'groceries', label: 'Groceries' },
        { level: 'merchant', key: 'chain-x', label: 'Chain X & "Sons"' },
      ],
      groupBy: 'merchant',
      reviewOnly: true,
      tab: 'debts',
    }
    expect(stateFromSearch(searchWithState('', s), TODAY)).toEqual(s)
    const acct: BudgetViewState = { ...s, groupBy: 'account', reviewOnly: false, tab: 'spending', person: 'all' }
    expect(stateFromSearch(searchWithState('', acct), TODAY)).toEqual(acct)
  })

  it('writes defaults out except the range, keeps other params, replaces old b_* params', () => {
    const d = defaultViewState(TODAY)
    const p = new URLSearchParams(searchWithState('?page=p1&section=budget&utm_source=x&b_person=old&b_tab=debts', d))
    expect(p.get('page')).toBe('p1')
    expect(p.get('section')).toBe('budget')
    expect(p.get('utm_source')).toBe('x')
    expect(p.get('b_from')).toBe('2026-11-01')
    expect(p.get('b_to')).toBe('2026-11-20')
    expect([...p.keys()].filter((k) => k.startsWith('b_')).sort()).toEqual(['b_from', 'b_to'])
  })

  it('malformed values fall back to the defaults', () => {
    const d = defaultViewState(TODAY)
    expect(stateFromSearch('?b_from=2026-13-01&b_to=2026-11-02', TODAY)).toEqual(d)
    expect(stateFromSearch('?b_from=2026-11-05&b_to=2026-11-01', TODAY)).toEqual(d)
    expect(stateFromSearch('?b_person=%3Cscript%3E', TODAY).person).toBe('all')
    expect(stateFromSearch('?b_path=notjson', TODAY).path).toEqual([])
    // wrong level order, too deep, wrong shapes
    expect(stateFromSearch(`?b_path=${encodeURIComponent(JSON.stringify([['merchant', 'a', 'A']]))}`, TODAY).path).toEqual([])
    expect(stateFromSearch(`?b_path=${encodeURIComponent(JSON.stringify([['category', 'a', 'A'], ['merchant', 'b', 'B'], ['x', 'c', 'C']]))}`, TODAY).path).toEqual([])
    expect(stateFromSearch(`?b_path=${encodeURIComponent(JSON.stringify([['category', 5, 'A']]))}`, TODAY).path).toEqual([])
    expect(stateFromSearch('?b_tab=weird&b_group=weird&b_review=yes', TODAY)).toEqual(d)
  })
})

describe('queries derived from the state', () => {
  const base = defaultViewState(TODAY)
  it('top level: range and person only', () => {
    expect(summaryQueryOf(base)).toEqual({ from: base.from, to: base.to, person: 'all' })
    expect(txnQueryOf(base)).toEqual({ from: base.from, to: base.to, person: 'all', scope: 'spending' })
  })
  it('category and merchant steps feed both queries identically', () => {
    const s: BudgetViewState = {
      ...base,
      person: 'p1',
      path: [{ level: 'category', key: 'fuel', label: 'Fuel' }, { level: 'merchant', key: 'chain-x', label: 'Chain X' }],
      reviewOnly: true,
    }
    expect(summaryQueryOf(s)).toEqual({ from: s.from, to: s.to, person: 'p1', category: 'fuel', groupBy: 'merchant', merchant: 'chain-x' })
    expect(txnQueryOf(s)).toEqual({ from: s.from, to: s.to, person: 'p1', scope: 'all', category: 'fuel', merchant: 'chain-x', review: true })
  })
  it('grouped by account, the second-level key is an account id: `account` (not `merchant`) in both queries', () => {
    const s: BudgetViewState = {
      ...base,
      groupBy: 'account',
      path: [{ level: 'category', key: 'fuel', label: 'Fuel' }, { level: 'merchant', key: 'acct-1', label: 'Card' }],
    }
    expect(summaryQueryOf(s)).toEqual({ from: s.from, to: s.to, person: 'all', category: 'fuel', groupBy: 'account', account: 'acct-1' })
    expect(txnQueryOf(s)).toEqual({ from: s.from, to: s.to, person: 'all', scope: 'spending', category: 'fuel', account: 'acct-1' })
    expect(txnQueryOf(s).merchant).toBeUndefined()
    expect(summaryQueryOf(s).merchant).toBeUndefined()
  })
  it('pie and table queries always agree on category / merchant / account, at every depth and grouping', () => {
    const steps = [
      { level: 'category', key: 'fuel', label: 'Fuel' },
      { level: 'merchant', key: 'k2', label: 'K2' },
    ] as const
    for (const groupBy of ['merchant', 'account'] as const) {
      for (let depth = 0; depth <= 2; depth++) {
        const s: BudgetViewState = { ...base, groupBy, path: steps.slice(0, depth).map((x) => ({ ...x })) }
        const a = summaryQueryOf(s)
        const b = txnQueryOf(s)
        expect([a.category, a.merchant, a.account]).toEqual([b.category, b.merchant, b.account])
      }
    }
  })
})

describe('useBudgetViewState', () => {
  beforeEach(() => history.replaceState(null, '', '/?section=budget&page=p1'))
  afterEach(() => history.replaceState(null, '', '/'))

  it('mirrors changes to the URL with replaceState, keeping other params', async () => {
    const len = history.length
    const v = useBudgetViewState(TODAY)
    v.setPerson('p2')
    v.pushStep({ level: 'category', key: 'dining', label: 'Dining' })
    v.setTab('debts')
    await nextTick()
    const p = new URLSearchParams(location.search)
    expect(p.get('section')).toBe('budget')
    expect(p.get('page')).toBe('p1')
    expect(p.get('b_person')).toBe('p2')
    expect(p.get('b_tab')).toBe('debts')
    expect(JSON.parse(p.get('b_path')!)).toEqual([['category', 'dining', 'Dining']])
    expect(history.length).toBe(len)
  })

  it('starts from the URL it opens on', () => {
    history.replaceState(null, '', '/?section=budget&b_from=2026-01-01&b_to=2026-02-01&b_person=p2&b_tab=debts')
    const v = useBudgetViewState(TODAY)
    expect(v.state).toMatchObject({ from: '2026-01-01', to: '2026-02-01', person: 'p2', tab: 'debts' })
  })

  it('pushStep follows the level order; popTo goes back; groupBy change drops the second step', () => {
    const v = useBudgetViewState(TODAY)
    v.pushStep({ level: 'merchant', key: 'x', label: 'X' }) // wrong level first: ignored
    expect(v.state.path).toEqual([])
    v.pushStep({ level: 'category', key: 'fuel', label: 'Fuel' })
    v.pushStep({ level: 'merchant', key: 'chain-x', label: 'Chain X' })
    v.pushStep({ level: 'merchant', key: 'deeper', label: 'Deeper' }) // bottom: ignored
    expect(v.state.path.map((s) => s.key)).toEqual(['fuel', 'chain-x'])
    v.setGroupBy('account')
    expect(v.state.path.map((s) => s.key)).toEqual(['fuel'])
    v.pushStep({ level: 'merchant', key: 'acct-1', label: 'Card' })
    v.popTo(0)
    expect(v.state.path).toEqual([])
  })

  it('setRange refuses a range the server would refuse', () => {
    const v = useBudgetViewState(TODAY)
    expect(v.setRange('2026-11-10', '2026-11-01')).toBe(false)
    expect(v.setRange('2024-01-01', '2026-11-01')).toBe(false)
    expect(v.setRange('2026-10-01', '2026-10-31')).toBe(true)
    expect(v.state.from).toBe('2026-10-01')
  })

  it('does not write the URL once the section is no longer the open one', async () => {
    const v = useBudgetViewState(TODAY)
    history.replaceState(null, '', '/?page=p1') // App closed the section
    v.setPerson('p2')
    await nextTick()
    expect(location.search).toBe('?page=p1')
  })

  it('readUrl re-reads the address bar (back/forward)', () => {
    const v = useBudgetViewState(TODAY)
    history.replaceState(null, '', '/?section=budget&b_person=p2&b_from=2026-10-01&b_to=2026-10-31')
    v.readUrl()
    expect(v.state).toMatchObject({ person: 'p2', from: '2026-10-01', to: '2026-10-31' })
  })
})
