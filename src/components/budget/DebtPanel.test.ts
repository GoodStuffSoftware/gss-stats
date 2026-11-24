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
type Hist = ReadonlyArray<{ asOf: string; balanceCents: number }>
function mountPanel(props: Partial<{ debts: DebtSlice[]; canEdit: boolean; selected: DebtSlice | null; history: Hist | null; historyFailed: boolean }> = {}) {
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

  it('a slice (or its list row) drills into that debt, in place', async () => {
    const w = mountPanel()
    await w.get('[data-testid="pie-row-a"]').trigger('click')
    w.findComponent(ChartStub).vm.$emit('point', { index: 0, datasetIndex: 0, x: 0, y: 0 })
    expect(w.emitted('drill')).toEqual([['a'], ['b']])
    expect(w.emitted('open')).toBeUndefined()
  })

  describe('drilled', () => {
    const HIST: Hist = [{ asOf: '2026-08-31', balanceCents: 100000 }, { asOf: '2026-09-30', balanceCents: 95000 }]

    it('shows the crumb "All debts" then the debt, its balance and its line chart; no pie', () => {
      const w = mountPanel({ selected: DEBTS[0], history: HIST })
      expect(w.findComponent(DrillPie).exists()).toBe(false)
      expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(true)
      const crumbs = w.get('nav').text()
      expect(crumbs).toContain('All debts')
      expect(crumbs).toContain('Debt a ••0001')
      expect(w.get('[data-testid="debt-drilled-balance"]').text()).toBe('$900.00')
      expect(w.find('[data-testid="debt-chart"]').exists()).toBe(true)
    })

    it('the "All debts" crumb goes back to the pie', async () => {
      const w = mountPanel({ selected: DEBTS[0], history: HIST })
      await w.findAll('nav button').find((b) => b.text() === 'All debts')!.trigger('click')
      expect(w.emitted('back')).toHaveLength(1)
    })

    it('"Loan details" opens the Loans page for that debt', async () => {
      const w = mountPanel({ selected: DEBTS[0], history: HIST })
      await w.get('[data-testid="debt-drilled-open"]').trigger('click')
      expect(w.emitted('open')).toEqual([['a']])
    })

    it('while the history loads there is a skeleton, and a failure offers Retry', async () => {
      const w = mountPanel({ selected: DEBTS[0], history: null })
      expect(w.find('[data-testid="debt-chart"]').exists()).toBe(false)
      expect(w.find('.dp-line-sk').exists()).toBe(true)
      await w.setProps({ historyFailed: true })
      await w.get('[data-testid="debt-drilled-retry"]').trigger('click')
      expect(w.emitted('retry')).toHaveLength(1)
    })

    it('a debt with no history says so', () => {
      const w = mountPanel({ selected: DEBTS[1], history: [] })
      expect(w.get('[data-testid="debt-chart-none"]').text()).toBe('No balance history yet.')
    })
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

describe('debts legend side', () => {
  afterEach(() => window.localStorage.clear())
  it('starts on the right, offers the picker, and keeps a pressed side for this device', async () => {
    const w = mountPanel()
    const pie = () => w.findComponent(DrillPie)
    expect(pie().props('legendSide')).toBe('right')
    expect(pie().props('legendPicker')).toBe(true)
    pie().vm.$emit('update:legendSide', 'bottom')
    await w.vm.$nextTick()
    expect(pie().props('legendSide')).toBe('bottom')
    expect(window.localStorage.getItem('gss-stats-budget-legend:debts')).toBe('bottom')
    expect(mountPanel().findComponent(DrillPie).props('legendSide')).toBe('bottom') // a later visit restores it
  })
  it('in Both the picker is hidden and the donut takes the shared Both size key', () => {
    const pie = mountPanel({ both: true } as never).findComponent(DrillPie)
    expect(pie.props('legendPicker')).toBe(false)
    expect(pie.props('sizeKey')).toBe('gss-stats-budget-donut:both')
  })
  it('on its own the donut keeps its own size key', () => {
    expect(mountPanel().findComponent(DrillPie).props('sizeKey')).toBe('gss-stats-budget-donut:debts:solo')
  })
  it('an invalid saved value is the right side', () => {
    window.localStorage.setItem('gss-stats-budget-legend:debts', 'sideways')
    expect(mountPanel().findComponent(DrillPie).props('legendSide')).toBe('right')
  })
})
