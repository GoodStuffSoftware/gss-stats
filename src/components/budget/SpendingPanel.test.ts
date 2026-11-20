// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { Category, SummaryResponse } from '../../lib/budget/types'
import type { DrillStep } from '../../lib/budget/viewState'
import DrillPie from '../charts/DrillPie.vue'
import Crumbs from '../nav/Crumbs.vue'
import SpendingPanel from './SpendingPanel.vue'

const CATS: Category[] = [
  { id: 'groceries', label: 'Groceries', color: null, sort: 10 },
  { id: 'fuel', label: 'Fuel', color: null, sort: 20 },
]
const CATEGORY_LEVEL: SummaryResponse = {
  level: 'category',
  slices: [{ key: 'groceries', label: 'Groceries', netCents: 12000, count: 3 }, { key: 'fuel', label: 'Fuel', netCents: 5000, count: 2 }],
  totalCents: 17000,
  reviewCount: 2,
}
const MERCHANT_LEVEL: SummaryResponse = {
  level: 'merchant',
  slices: [{ key: 'chain-x', label: 'Chain X', netCents: 3000, count: 2 }, { key: 'shop-y', label: 'Shop Y', netCents: 2000, count: 1 }],
  totalCents: 5000,
  reviewCount: 0,
}
const PURCHASE_LEVEL: SummaryResponse = {
  level: 'purchase',
  slices: [{ key: 'txn-1', label: 'Nov 5', netCents: 2500, count: 1 }, { key: 'txn-2', label: 'Nov 9', netCents: 500, count: 1 }],
  totalCents: 3000,
  reviewCount: 0,
}
const FUEL: DrillStep = { level: 'category', key: 'fuel', label: 'Fuel' }
const CHAIN: DrillStep = { level: 'merchant', key: 'chain-x', label: 'Chain X' }

const ChartStub = defineComponent({ name: 'BaseChart', props: { config: Object, drillOpen: Boolean }, emits: ['point'], template: '<div />' })
const mounted: VueWrapper[] = []
function mountPanel(props: Partial<InstanceType<typeof SpendingPanel>['$props']> = {}) {
  const w = mount(SpendingPanel, {
    props: { summary: CATEGORY_LEVEL, categories: CATS, path: [], groupBy: 'merchant', reviewOnly: false, dark: false, refreshing: false, ...props },
    global: { stubs: { BaseChart: ChartStub } },
    attachTo: document.body,
  })
  mounted.push(w)
  return w
}
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.restoreAllMocks()
})

describe('SpendingPanel: pie and totals', () => {
  it('draws the slices of the summary and the total, with one crumb at the top', () => {
    const w = mountPanel()
    expect(w.findComponent(DrillPie).props('slices').map((s: { key: string }) => s.key)).toEqual(['groceries', 'fuel'])
    expect(w.get('[data-testid="spending-total"]').text()).toContain('All spending')
    expect(w.get('[data-testid="spending-total"]').text()).toContain('$170.00')
    expect(w.findComponent(Crumbs).props('items')).toEqual([{ key: '', label: 'All spending' }])
  })

  it('crumbs show the path; the total names where you are', () => {
    const w = mountPanel({ summary: PURCHASE_LEVEL, path: [FUEL, CHAIN] })
    expect(w.findComponent(Crumbs).props('items').map((i: { label: string }) => i.label)).toEqual(['All spending', 'Fuel', 'Chain X'])
    expect(w.get('[data-testid="spending-total"]').text()).toContain('Chain X')
  })

  it('refreshing dims the old pie and says it is busy', () => {
    const w = mountPanel({ refreshing: true })
    expect(w.classes()).toContain('refreshing')
    expect(w.attributes('aria-busy')).toBe('true')
  })

  it('when refunds cover everything there is nothing to draw and it says so', () => {
    const w = mountPanel({ summary: { ...MERCHANT_LEVEL, slices: [{ key: 'a', label: 'A', netCents: -100, count: 1 }] }, path: [FUEL] })
    expect(w.find('[data-testid="spending-none"]').exists()).toBe(true)
  })
})

describe('SpendingPanel: drilling', () => {
  it('a category slice drills to a category step carrying its label', async () => {
    const w = mountPanel()
    await w.get('[data-testid="pie-row-fuel"]').trigger('click')
    expect(w.emitted('drill')).toEqual([[{ level: 'category', key: 'fuel', label: 'Fuel' }]])
    expect(w.emitted('select-purchase')).toBeUndefined()
  })

  it('a merchant slice (or an account slice) drills to a merchant-level step', async () => {
    const w = mountPanel({ summary: MERCHANT_LEVEL, path: [FUEL] })
    await w.get('[data-testid="pie-row-chain-x"]').trigger('click')
    expect(w.emitted('drill')).toEqual([[{ level: 'merchant', key: 'chain-x', label: 'Chain X' }]])
  })

  it('a purchase slice selects the row instead of drilling', async () => {
    const w = mountPanel({ summary: PURCHASE_LEVEL, path: [FUEL, CHAIN] })
    await w.get('[data-testid="pie-row-txn-2"]').trigger('click')
    expect(w.emitted('select-purchase')).toEqual([['txn-2']])
    expect(w.emitted('drill')).toBeUndefined()
  })

  it('a click on the chart itself drills the same way as the list', () => {
    const w = mountPanel()
    w.findComponent(ChartStub).vm.$emit('point', { index: 0, datasetIndex: 0, x: 0, y: 0 })
    expect(w.emitted('drill')).toEqual([[{ level: 'category', key: 'groceries', label: 'Groceries' }]])
  })

  it('crumbs go back: the top is depth 0, the first step depth 1', async () => {
    const w = mountPanel({ summary: PURCHASE_LEVEL, path: [FUEL, CHAIN] })
    await w.get('[data-testid="crumb-1"]').trigger('click')
    await w.get('[data-testid="crumb-0"]').trigger('click')
    expect(w.emitted('crumb')).toEqual([[1], [0]])
  })

  it('the folded "Other" slice does not drill', async () => {
    const many: SummaryResponse = {
      level: 'merchant',
      slices: Array.from({ length: 14 }, (_, i) => ({ key: `m${i}`, label: `M${i}`, netCents: 1000 - i, count: 1 })),
      totalCents: 14000,
      reviewCount: 0,
    }
    const w = mountPanel({ summary: many, path: [FUEL] })
    const other = w.findComponent(DrillPie).props('slices').find((s: { inert?: boolean }) => s.inert)
    expect(other).toBeTruthy()
    await w.get(`[data-testid="pie-row-${other!.key}"]`).trigger('click')
    expect(w.emitted('drill')).toBeUndefined()
  })
})

describe('SpendingPanel: controls', () => {
  it('"Needs review (n)" toggles and shows the count; hidden when nothing needs review', async () => {
    const w = mountPanel()
    const btn = w.get('[data-testid="review-toggle"]')
    expect(btn.text()).toBe('Needs review (2)')
    expect(btn.attributes('aria-pressed')).toBe('false')
    await btn.trigger('click')
    expect(w.emitted('review-only')).toEqual([[true]])
    const on = mountPanel({ reviewOnly: true })
    await on.get('[data-testid="review-toggle"]').trigger('click')
    expect(on.get('[data-testid="review-toggle"]').attributes('aria-pressed')).toBe('true')
    expect(on.emitted('review-only')).toEqual([[false]])
    expect(mountPanel({ summary: MERCHANT_LEVEL, path: [FUEL] }).find('[data-testid="review-toggle"]').exists()).toBe(false)
  })

  it('the Stores / Accounts switch appears once inside a category and reports the choice', async () => {
    expect(mountPanel().find('[data-testid="group-account"]').exists()).toBe(false)
    const w = mountPanel({ summary: MERCHANT_LEVEL, path: [FUEL] })
    expect(w.get('[data-testid="group-merchant"]').attributes('aria-checked')).toBe('true')
    await w.get('[data-testid="group-account"]').trigger('click')
    expect(w.emitted('group-by')).toEqual([['account']])
  })
})

describe('SpendingPanel colours', () => {
  it('category slices use the same colours as the table dots (one function)', async () => {
    const { rowDotColor } = await import('../../lib/budget/tableModel')
    const w = mountPanel()
    for (const s of w.findComponent(DrillPie).props('slices') as Array<{ key: string; color: string }>) {
      expect(s.color).toBe(rowDotColor(CATS, { kind: 'spend', categoryId: s.key } as never))
    }
  })
})
