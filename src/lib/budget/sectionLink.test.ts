import { describe, expect, it } from 'vitest'
import { budgetSectionOpen, searchWithSection } from './sectionLink'

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
