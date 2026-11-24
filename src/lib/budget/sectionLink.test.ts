import { describe, expect, it } from 'vitest'
import { budgetPageOf, budgetSectionOpen, parseBudgetPage, searchWithSection } from './sectionLink'

describe('budgetSectionOpen', () => {
  it('is true only for section=budget', () => {
    expect(budgetSectionOpen('?section=budget')).toBe(true)
    expect(budgetSectionOpen('?page=x&section=budget&utm_source=a')).toBe(true)
    expect(budgetSectionOpen('')).toBe(false)
    expect(budgetSectionOpen('?section=other')).toBe(false)
    expect(budgetSectionOpen('?section=Budget')).toBe(false)
    expect(budgetSectionOpen('?page=budget')).toBe(false)
  })
})

describe('searchWithSection', () => {
  it('opens: adds section=budget and keeps every other param', () => {
    const s = searchWithSection('?page=bsk-features&utm_source=x', true)
    const p = new URLSearchParams(s)
    expect(p.get('section')).toBe('budget')
    expect(p.get('page')).toBe('bsk-features')
    expect(p.get('utm_source')).toBe('x')
    expect(searchWithSection('', true)).toBe('?section=budget')
  })

  it('closes: drops section and the b_* params, keeps the rest', () => {
    const s = searchWithSection('?page=p1&section=budget&b_from=2026-11-01&b_to=2026-11-20&b_tab=debts&utm_source=x', false)
    const p = new URLSearchParams(s)
    expect(p.has('section')).toBe(false)
    expect([...p.keys()].filter((k) => k.startsWith('b_'))).toEqual([])
    expect(p.get('page')).toBe('p1')
    expect(p.get('utm_source')).toBe('x')
    expect(searchWithSection('?section=budget', false)).toBe('')
  })
})

describe('the Budget page param', () => {
  it('parseBudgetPage keeps only loans; budgetPageOf reads b_page', () => {
    expect(parseBudgetPage('loans')).toBe('loans')
    for (const v of ['overview', 'Loans', '', null, undefined, 3]) expect(parseBudgetPage(v)).toBe('overview')
    expect(budgetPageOf('?section=budget&b_page=loans')).toBe('loans')
    expect(budgetPageOf('?b_page=nope')).toBe('overview')
    expect(budgetPageOf('')).toBe('overview')
  })
  it('receipts is a page: parsed, read from b_page, written when opening; an unknown page is still Overview', () => {
    expect(parseBudgetPage('receipts')).toBe('receipts')
    expect(budgetPageOf('?section=budget&b_page=receipts&email=connected')).toBe('receipts')
    expect(budgetPageOf('?section=budget&b_page=Receipts')).toBe('overview')
    expect(searchWithSection('?page=p1', true, 'receipts')).toBe('?page=p1&section=budget&b_page=receipts')
    expect(searchWithSection('?section=budget&b_page=receipts&email=connected', false)).toBe('?email=connected')
  })
  it('opening on Loans writes b_page=loans; Overview writes nothing; closing drops it', () => {
    expect(searchWithSection('?page=p1', true, 'loans')).toBe('?page=p1&section=budget&b_page=loans')
    expect(searchWithSection('', true)).toBe('?section=budget')
    expect(searchWithSection('?section=budget&b_page=loans&utm_source=x', false)).toBe('?utm_source=x')
  })
})
