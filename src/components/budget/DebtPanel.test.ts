// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { DebtSlice } from '../../lib/budget/types'
import DrillPie from '../charts/DrillPie.vue'
import DebtPanel from './DebtPanel.vue'

const debt = (id: string, balance: number | null, extra: Partial<DebtSlice> = {}): DebtSlice => ({
  accountId: id, label: `Debt ${id}`, kind: 'loan', last4: null, personId: null, balanceCents: balance, asOf: balance === null ? null : '2026-10-31',
  source: balance === null ? null : 'statement', aprBp: null, creditLimitCents: null, ...extra,
})
const DEBTS = [debt('a', 90000, { last4: '0001', aprBp: 1999 }), debt('b', 250000), debt('c', null), debt('d', 0)]

const ChartStub = defineComponent({ name: 'BaseChart', props: { config: Object, drillOpen: Boolean }, emits: ['point'], template: '<div />' })
const mounted: VueWrapper[] = []
function mountPanel(props: Partial<{ debts: DebtSlice[]; canEdit: boolean }> = {}) {
  const w = mount(DebtPanel, { props: { debts: DEBTS, dark: false, canEdit: true, ...props }, global: { stubs: { BaseChart: ChartStub } }, attachTo: document.body })
  mounted.push(w)
  return w
}
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('DebtPanel', () => {
  it('a pie of the balances, biggest first, and the total owed', () => {
    const w = mountPanel()
    expect(w.findComponent(DrillPie).props('slices').map((s: { key: string; value: number }) => [s.key, s.value])).toEqual([['b', 250000], ['a', 90000]])
    expect(w.get('[data-testid="debt-total"]').text()).toContain('$3,400.00')
  })

  it('a slice (or its list row) opens that debt', async () => {
    const w = mountPanel()
    await w.get('[data-testid="pie-row-a"]').trigger('click')
    w.findComponent(ChartStub).vm.$emit('point', { index: 0, datasetIndex: 0, x: 0, y: 0 })
    expect(w.emitted('open')).toEqual([['a'], ['b']])
  })

  it('a debt with no balance is listed under the pie with "Add balance" when editing is allowed', async () => {
    const w = mountPanel()
    const add = w.get('[data-testid="debt-add-c"]')
    expect(add.text()).toBe('Add balance')
    await add.trigger('click')
    expect(w.emitted('open')).toEqual([['c']])
    expect(w.text()).toContain('No balance yet')
  })

  it('without edit rights there is no "Add balance", only Details', () => {
    const w = mountPanel({ canEdit: false })
    expect(w.find('[data-testid="debt-add-c"]').exists()).toBe(false)
    expect(w.find('[data-testid="debt-open-c"]').text()).toBe('Details')
  })

  it('a debt at zero is listed as paid off, not drawn', () => {
    const w = mountPanel()
    expect(w.findComponent(DrillPie).props('slices').some((s: { key: string }) => s.key === 'd')).toBe(false)
    expect(w.text()).toContain('Paid off')
  })

  it('with no balance anywhere there is no pie, only the list', () => {
    const w = mountPanel({ debts: [debt('c', null)] })
    expect(w.findComponent(DrillPie).exists()).toBe(false)
    expect(w.get('[data-testid="debt-none"]').text()).toBe('No balances yet.')
    expect(w.get('[data-testid="debt-total"]').text()).toContain('$0.00')
  })

  it('a cosigned debt stays out of the pie and the total, shows its own line, and still lists with a badge', async () => {
    const w = mountPanel({ debts: [debt('a', 90000), debt('b', 400000, { cosigned: true })] })
    expect(w.findComponent(DrillPie).props('slices').map((s: { key: string }) => s.key)).toEqual(['a'])
    expect(w.get('[data-testid="debt-total"]').text()).toContain('$900.00')
    expect(w.get('[data-testid="debt-cosigned"]').text()).toBe('+ $4,000.00 cosigned')
    expect(w.get('[data-testid="cosigned-badge"]').text()).toBe('Cosigned')
    await w.get('[data-testid="debt-open-b"]').trigger('click')
    expect(w.emitted('open')).toEqual([['b']])
  })
})
