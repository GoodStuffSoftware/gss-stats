// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import BudgetFilters from './BudgetFilters.vue'

const people = [{ id: 'p1', label: 'Person One' }, { id: 'p2', label: 'Person Two' }]
const TODAY = '2026-11-20'
function mountFilters(over: Record<string, unknown> = {}) {
  return mount(BudgetFilters, { props: { from: '2026-11-01', to: '2026-11-20', person: 'all', people, today: TODAY, ...over } })
}

describe('BudgetFilters', () => {
  it('lists the five presets and marks the matching one', () => {
    const w = mountFilters()
    const sel = w.get('[data-testid="budget-range"]')
    expect(sel.findAll('option').map((o) => o.text())).toEqual(['This month · November 2026', 'Last month · October 2026', 'Last 3 months · Sep – Nov 2026', 'Year to date · Jan – Nov 2026', 'Custom'])
    expect((sel.element as unknown as HTMLSelectElement).value).toBe('this-month')
  })

  it('says the months covered under the picker, with to date when it runs to today', async () => {
    const w = mountFilters()
    expect(w.get('[data-testid="budget-range-months"]').text()).toBe('Covers November 2026 (to date)')
    const past = mountFilters({ from: '2026-10-01', to: '2026-10-31' })
    expect(past.get('[data-testid="budget-range-months"]').text()).toBe('Covers October 2026')
    const custom = mountFilters({ from: '2025-12-15', to: '2026-02-03' })
    expect(custom.get('[data-testid="budget-range-months"]').text()).toBe('Covers Dec 2025 – Feb 2026')
  })

  it('picking a preset emits its range', async () => {
    const w = mountFilters()
    await w.get('[data-testid="budget-range"]').setValue('last-month')
    expect(w.emitted('range')).toEqual([[{ from: '2026-10-01', to: '2026-10-31' }]])
    await w.get('[data-testid="budget-range"]').setValue('ytd')
    expect(w.emitted('range')![1]).toEqual([{ from: '2026-01-01', to: '2026-11-20' }])
  })

  it('the smart date field shows the range as text; a range that matches no preset shows Custom', () => {
    const w = mountFilters({ from: '2026-10-05', to: '2026-10-09' })
    expect((w.get('[data-testid="budget-range"]').element as unknown as HTMLSelectElement).value).toBe('custom')
    expect((w.get('[data-testid="budget-date-input"]').element as unknown as HTMLInputElement).value).toBe('Oct 5 – Oct 9, 2026')
    expect(mountFilters().find('[data-testid="budget-date-input"]').exists()).toBe(true)
  })

  it('typing words in the smart field emits the range', async () => {
    const w = mountFilters()
    await w.get('[data-testid="budget-date-input"]').setValue('Oct 1 to Oct 9')
    await w.get('[data-testid="budget-date-input"]').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('range')).toEqual([[{ from: '2026-10-01', to: '2026-10-09' }]])
  })

  it('a pick in the calendar emits a single date or a range', async () => {
    const w = mountFilters()
    await w.get('[data-testid="budget-date-calendar"]').trigger('click')
    await w.get('button[data-date="2026-11-10"]').trigger('click')
    await w.get('button[data-date="2026-11-10"]').trigger('click')
    expect(w.emitted('range')).toEqual([[{ from: '2026-11-10', to: '2026-11-10' }]])
    await w.get('[data-testid="budget-date-calendar"]').trigger('click')
    await w.get('button[data-date="2026-11-03"]').trigger('click')
    await w.get('button[data-date="2026-11-12"]').trigger('click')
    expect(w.emitted('range')!.at(-1)).toEqual([{ from: '2026-11-03', to: '2026-11-12' }])
  })

  it('choosing Custom changes nothing; a range longer than the server accepts shows a hint and emits nothing', async () => {
    const w = mountFilters()
    await w.get('[data-testid="budget-range"]').setValue('custom')
    expect(w.emitted('range')).toBeUndefined()
    await w.get('[data-testid="budget-date-input"]').setValue('since 2024')
    await w.get('[data-testid="budget-date-input"]').trigger('keydown', { key: 'Enter' })
    expect(w.get('[data-testid="budget-date-hint"]').text()).toContain('400')
    expect(w.emitted('range')).toBeUndefined()
  })

  it('person control: All plus people from meta; clicking emits the id', async () => {
    const w = mountFilters({ person: 'p1' })
    const radios = w.findAll('[role="radio"]')
    expect(radios.map((r) => r.text())).toEqual(['All', 'Person One', 'Person Two'])
    expect(radios.map((r) => r.attributes('aria-checked'))).toEqual(['false', 'true', 'false'])
    await w.get('[data-testid="budget-person-p2"]').trigger('click')
    await w.get('[data-testid="budget-person-all"]').trigger('click')
    expect(w.emitted('person')).toEqual([['p2'], ['all']])
  })
})
