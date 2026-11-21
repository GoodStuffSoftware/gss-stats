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
    expect(sel.findAll('option').map((o) => o.text())).toEqual(['This month', 'Last month', 'Last 3 months', 'Year to date', 'Custom'])
    expect((sel.element as unknown as HTMLSelectElement).value).toBe('this-month')
  })

  it('picking a preset emits its range', async () => {
    const w = mountFilters()
    await w.get('[data-testid="budget-range"]').setValue('last-month')
    expect(w.emitted('range')).toEqual([[{ from: '2026-10-01', to: '2026-10-31' }]])
    await w.get('[data-testid="budget-range"]').setValue('ytd')
    expect(w.emitted('range')![1]).toEqual([{ from: '2026-01-01', to: '2026-11-20' }])
  })

  it('a range that matches no preset shows Custom with date inputs', () => {
    const w = mountFilters({ from: '2026-10-05', to: '2026-10-09' })
    expect((w.get('[data-testid="budget-range"]').element as unknown as HTMLSelectElement).value).toBe('custom')
    expect((w.get('[data-testid="budget-from"]').element as unknown as HTMLInputElement).value).toBe('2026-10-05')
  })

  it('choosing Custom opens the inputs without changing the range; a valid custom range emits', async () => {
    const w = mountFilters()
    expect(w.find('[data-testid="budget-from"]').exists()).toBe(false)
    await w.get('[data-testid="budget-range"]').setValue('custom')
    expect(w.emitted('range')).toBeUndefined()
    await w.get('[data-testid="budget-from"]').setValue('2026-10-05')
    await w.get('[data-testid="budget-to"]').setValue('2026-10-09')
    expect(w.emitted('range')!.at(-1)).toEqual([{ from: '2026-10-05', to: '2026-10-09' }])
  })

  it('an inverted or over-long custom range shows a message and emits nothing', async () => {
    const w = mountFilters({ from: '2026-10-05', to: '2026-10-09' })
    await w.get('[data-testid="budget-from"]').setValue('2026-10-20')
    expect(w.get('[role="alert"]').text()).toContain('after')
    await w.get('[data-testid="budget-from"]').setValue('2024-01-01')
    expect(w.get('[role="alert"]').text()).toContain('400')
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

  it('show group: only when `hidden` is given; pressed state follows it; the last chart shown cannot be hidden', async () => {
    expect(mountFilters().find('[data-testid="budget-show-spending"]').exists()).toBe(false)
    const both = mountFilters({ hidden: [] })
    const sp = both.get('[data-testid="budget-show-spending"]')
    const debts = both.get('[data-testid="budget-show-debts"]')
    expect([sp.attributes('aria-pressed'), debts.attributes('aria-pressed')]).toEqual(['true', 'true'])
    expect([sp.attributes('disabled'), debts.attributes('disabled')]).toEqual([undefined, undefined])
    await debts.trigger('click')
    expect(both.emitted('toggle-panel')).toEqual([['debts']])

    const one = mountFilters({ hidden: ['debts'] })
    expect(one.get('[data-testid="budget-show-debts"]').attributes('aria-pressed')).toBe('false')
    expect(one.get('[data-testid="budget-show-debts"]').attributes('disabled')).toBeUndefined() // the way back
    expect(one.get('[data-testid="budget-show-spending"]').attributes('disabled')).toBeDefined() // the last one shown
  })
})
