// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import Crumbs from './Crumbs.vue'
import source from './Crumbs.vue?raw'

const ITEMS = [{ key: '', label: 'Top' }, { key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }]

describe('Crumbs', () => {
  it('every item but the last is a button; the last marks where you are', () => {
    const w = mount(Crumbs, { props: { items: ITEMS } })
    expect(w.findAll('button').map((b) => b.text())).toEqual(['Top', 'Alpha'])
    const here = w.get('[aria-current="location"]')
    expect(here.text()).toBe('Beta')
    expect(here.element.tagName).toBe('SPAN')
  })

  it('picking an earlier item reports its index; the current one cannot be picked', async () => {
    const w = mount(Crumbs, { props: { items: ITEMS } })
    await w.get('[data-testid="crumb-0"]').trigger('click')
    await w.get('[data-testid="crumb-1"]').trigger('click')
    expect(w.emitted('go')).toEqual([[0], [1]])
    expect(w.find('[data-testid="crumb-2"]').exists()).toBe(false)
  })

  it('a single item is just the current place', () => {
    const w = mount(Crumbs, { props: { items: [ITEMS[0]] } })
    expect(w.findAll('button')).toHaveLength(0)
    expect(w.text()).toBe('Top')
  })

  it('names its nav for screen readers (default and given)', () => {
    expect(mount(Crumbs, { props: { items: ITEMS } }).get('nav').attributes('aria-label')).toBe('Breadcrumb')
    expect(mount(Crumbs, { props: { items: ITEMS, label: 'Spending path' } }).get('nav').attributes('aria-label')).toBe('Spending path')
  })

  it('below 360 px only the current place shows: the earlier items and the separator are hidden (CSS, so the items stay in the DOM)', () => {
    const w = mount(Crumbs, { props: { items: ITEMS } })
    expect(w.findAll('.cr-item')).toHaveLength(3)
    expect(w.findAll('.cr-sep')).toHaveLength(2)
    const rule = /@media \(max-width: 359px\) \{([^}]*)\}/.exec(source)
    expect(rule, 'a max-width: 359px media rule').not.toBeNull()
    expect(rule![1]).toContain('.cr-item:not(:last-child)')
    expect(rule![1]).toContain('.cr-sep')
    expect(rule![1]).toMatch(/display:\s*none/)
  })

  it('is generic (ADR 0005: no one-off widgets)', () => {
    expect(source).not.toMatch(/budget|categor|merchant|transaction|cents|account|debt|spend/i)
  })
})
