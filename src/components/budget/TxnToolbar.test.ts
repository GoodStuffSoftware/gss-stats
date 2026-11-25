// @vitest-environment happy-dom
// The Transactions toolbar row folds by measured width: lead -> dropdown, search -> icon with a pop-out; the Filters
// button always stays and its panel is a pop-out. Widths are faked (happy-dom has no layout). Made-up data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { h } from 'vue'
import TxnToolbar from './TxnToolbar.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import { defaultTxnViewPrefs } from '../../lib/budget/txnView'

let rootWidth = 0
let roCallback: (() => void) | null = null
let wrapper: VueWrapper | null = null

beforeEach(() => {
  rootWidth = 0
  roCallback = null
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { roCallback = cb } observe() {} disconnect() {} })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return (this as HTMLElement).classList.contains('txn-toolbar') ? rootWidth : 0 } })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      const c = (this as HTMLElement).classList
      if (c.contains('tt-lead')) return (this as HTMLElement).querySelector('select') ? 76 : 124
      return c.contains('tt-toggle') ? 90 : 0
    },
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth
})

const OPTS = [{ value: 'cards', label: 'Cards' }, { value: 'table', label: 'Table' }]
async function mountBar(opts: { lead?: boolean; search?: string; width?: number } = {}) {
  rootWidth = opts.width ?? 0
  wrapper = mount(TxnToolbar, {
    attachTo: document.body,
    props: { modelValue: { ...defaultTxnViewPrefs(), search: opts.search ?? '' }, rows: [], categories: [], accounts: [], people: [], shown: 0 },
    slots: opts.lead === false ? {} : { lead: (p: { collapsed: boolean }) => h(SegmentedControl, { options: OPTS, modelValue: 'cards', label: 'View', size: 'compact', collapsed: p.collapsed }) },
  })
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick()
  return wrapper
}
async function resize(w: VueWrapper, width: number) {
  rootWidth = width
  roCallback?.()
  await w.vm.$nextTick()
  await w.vm.$nextTick()
}

describe('TxnToolbar fold', () => {
  it('draws everything inline when the room is not known or is wide', async () => {
    const w = await mountBar()
    expect(w.find('[role="radiogroup"]').exists()).toBe(true)
    expect(w.find('[data-testid="txn-search"]').exists()).toBe(true)
    await resize(w, 1200)
    expect(w.find('[role="radiogroup"]').exists()).toBe(true)
    expect(w.find('[data-testid="txn-search-toggle"]').exists()).toBe(false)
  })
  it('folds the lead into one dropdown first, then the search into an icon; Filters always stays', async () => {
    const w = await mountBar({ width: 1200 })
    await resize(w, 320) // inline needs 124 + 120 + 90 + 16 = 350; folded lead needs 302
    expect(w.find('[role="radiogroup"]').exists()).toBe(false)
    expect(w.find('select[aria-label="View"]').exists()).toBe(true)
    expect(w.find('[data-testid="txn-search"]').exists()).toBe(true)
    await resize(w, 240)
    expect(w.find('[data-testid="txn-search-toggle"]').exists()).toBe(true)
    expect(w.find('[data-testid="txn-search"]').exists()).toBe(false)
    expect(w.find('[data-testid="txn-filters-toggle"]').exists()).toBe(true)
    await resize(w, 900) // and back
    expect(w.find('[role="radiogroup"]').exists()).toBe(true)
    expect(w.find('[data-testid="txn-search"]').exists()).toBe(true)
  })
  it('without a lead, only the search folds', async () => {
    const w = await mountBar({ lead: false, width: 1200 })
    await resize(w, 250)
    expect(w.find('[data-testid="txn-search-toggle"]').exists()).toBe(false)
    await resize(w, 200)
    expect(w.find('[data-testid="txn-search-toggle"]').exists()).toBe(true)
  })
})

describe('TxnToolbar pop-outs', () => {
  it('the search icon opens a labelled field, focuses it, and Escape closes it and returns focus', async () => {
    const w = await mountBar({ width: 240 })
    const btn = w.get('[data-testid="txn-search-toggle"]')
    expect(btn.attributes('aria-expanded')).toBe('false')
    expect(btn.attributes('aria-controls')).toBe('txn-tt-search')
    await btn.trigger('click')
    expect(btn.attributes('aria-expanded')).toBe('true')
    const input = w.get('#txn-tt-search [data-testid="txn-search"]')
    expect(input.attributes('aria-label')).toBe('Search transactions')
    expect(document.activeElement).toBe(input.element)
    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    document.dispatchEvent(esc)
    expect(esc.defaultPrevented).toBe(true) // so the browser does not also wipe the search text
    await w.vm.$nextTick()
    expect(w.find('#txn-tt-search').exists()).toBe(false)
    expect(document.activeElement).toBe(btn.element)
  })
  it('shows that a search is on while the field is closed', async () => {
    const w = await mountBar({ width: 240, search: 'rice' })
    const btn = w.get('[data-testid="txn-search-toggle"]')
    expect(btn.classes()).toContain('tt-icon-on')
    expect(btn.find('.tt-dot').exists()).toBe(true)
    expect(btn.attributes('aria-label')).toContain('a search is on')
  })
  it('Filters toggles its panel (aria-expanded), Escape closes it and returns focus; opening one pop-out closes the other', async () => {
    const w = await mountBar({ width: 240 })
    const toggle = w.get('[data-testid="txn-filters-toggle"]')
    expect(toggle.attributes('aria-controls')).toBe('txn-tt-panel')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(w.get('#txn-tt-panel').isVisible()).toBe(true)
    await w.get('[data-testid="txn-search-toggle"]').trigger('click') // search opens, the panel closes
    expect(w.get('#txn-tt-panel').isVisible()).toBe(false)
    expect(w.find('#txn-tt-search').exists()).toBe(true)
    await toggle.trigger('click') // panel opens, the search closes
    expect(w.find('#txn-tt-search').exists()).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await w.vm.$nextTick()
    expect(w.get('#txn-tt-panel').isVisible()).toBe(false)
    expect(document.activeElement).toBe(toggle.element)
  })
  it('a tap outside closes the panel', async () => {
    const w = await mountBar({ width: 240 })
    await w.get('[data-testid="txn-filters-toggle"]').trigger('click')
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await w.vm.$nextTick()
    expect(w.get('#txn-tt-panel').isVisible()).toBe(false)
  })
})
