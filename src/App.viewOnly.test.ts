// @vitest-environment happy-dom
//
// View-only access (README "Auth → View-only access"; src/lib/viewOnly.ts). For a viewer every
// edit control is on screen but greyed out, inert, with the tooltip "View-only access", the grid
// can't be dragged or resized, and nothing the viewer does on screen is ever saved. The owner is
// unaffected. The server refuses a viewer's writes either way (functions/_lib/auth.viewer.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref, withDirectives, nextTick } from 'vue'
import { GridLayout } from 'grid-layout-plus'
import App from './App.vue'
import { stubAppFetch } from './testing/appFetch'
import Dashboard from './components/Dashboard.vue'
import FilterBar from './components/FilterBar.vue'
import ChartEditor from './components/ChartEditor.vue'
import AdsRefreshButton from './components/AdsRefreshButton.vue'
import { saveConfig, loadConfig, refreshAdsData } from './api'
import { viewOnly, vEdit, VIEW_ONLY_TITLE } from './lib/viewOnly'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    loadConfig: vi.fn(async () => null),
    saveConfig: vi.fn(async () => true),
    refreshAdsData: vi.fn(async () => ({ reason: 'up to date' })),
    fetchStats: vi.fn(() => new Promise(() => {})),
    fetchSeriesStats: vi.fn(() => new Promise(() => {})),
  }
})
vi.mock('./sitesStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sitesStore')>()
  return { ...actual, loadSites: vi.fn(async () => {}) }
})
vi.mock('./session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session')>()
  return { ...actual, loadIdentity: vi.fn(async () => {}), checkSessionExpired: vi.fn(async () => {}) }
})

beforeEach(() => {
  stubAppFetch()
  localStorage.clear()
  vi.mocked(saveConfig).mockClear()
  vi.mocked(refreshAdsData).mockClear()
  vi.mocked(loadConfig).mockImplementation(async () => null)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  viewOnly.value = false
  vi.useRealTimers()
  document.body.innerHTML = ''
})

const pastDebounce = () => vi.advanceTimersByTimeAsync(800)
async function mountApp() {
  const w = mount(App, { attachTo: document.body })
  await flushPromises()
  return w
}
const isViewOnlyDisabled = (el: Element) =>
  el.hasAttribute('disabled') && el.getAttribute('aria-disabled') === 'true' && el.getAttribute('title') === VIEW_ONLY_TITLE && el.classList.contains('view-only-disabled')

// Every edit the viewer could try, through the components the App listens to.
async function tryEverything(w: any) {
  const dash = w.findComponent(Dashboard)
  const first = (dash.props('widgets') as { id: string }[])[0]
  dash.vm.$emit('remove', first.id)
  dash.vm.$emit('duplicate', first)
  dash.vm.$emit('edit', first)
  await flushPromises()
  w.find('[data-testid="add-chart"]').element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
  // A filter change is the one thing a viewer may do: it shows, but stays in this tab.
  const bar = w.findComponent(FilterBar)
  bar.vm.$emit('change', { ...bar.props('filters'), rangeRel: '7d' })
  bar.vm.$emit('toggle-sync', true)
  await flushPromises()
}

describe('view-only access: a viewer', () => {
  beforeEach(() => {
    viewOnly.value = true
  })

  it('sees the header edit controls greyed out with the "View-only access" tooltip', async () => {
    const w = await mountApp()
    const add = w.find('[data-testid="add-chart"]').element
    expect(isViewOnlyDisabled(add)).toBe(true)
    expect(add.textContent).toContain('Add chart') // shown, not hidden
    expect(isViewOnlyDisabled(w.find('.page-menu-btn').element)).toBe(true)
    expect(w.find('.save-state').text()).toBe('View only')
    w.unmount()
  })

  it('cannot drag or resize the grid', async () => {
    const w = await mountApp()
    const grid = w.findComponent(GridLayout)
    expect(grid.props('isDraggable')).toBe(false)
    expect(grid.props('isResizable')).toBe(false)
    w.unmount()
  })

  it('sees every chart menu item disabled, and the chart filter button too', async () => {
    const w = await mountApp()
    const card = w.find('.chart-card')
    await card.find('button[title="Options"]').trigger('click')
    const items = card.findAll('.menu button')
    expect(items.map((b) => b.text())).toEqual(['Edit', 'Duplicate', expect.stringMatching(/default/), 'Delete'])
    for (const b of items) expect(isViewOnlyDisabled(b.element)).toBe(true)
    const filter = card.findAll('.revealed-controls button').find((b) => b.attributes('title') === VIEW_ONLY_TITLE && b.classes('icon'))
    expect(filter).toBeTruthy()
    w.unmount()
  })

  it('never saves, and no edit takes effect, whatever reaches the app', async () => {
    const w = await mountApp()
    const before = (w.findComponent(Dashboard).props('widgets') as { id: string }[]).map((x) => x.id)
    await tryEverything(w)
    await pastDebounce()
    await flushPromises()
    expect(saveConfig).not.toHaveBeenCalled()
    expect(w.findComponent(ChartEditor).exists()).toBe(false)
    expect((w.findComponent(Dashboard).props('widgets') as { id: string }[]).map((x) => x.id)).toEqual(before)
    // the filter change still shows on screen
    expect(w.findComponent(FilterBar).props('filters').rangeRel).toBe('7d')
    w.unmount()
  })

  it('cannot open the page menu', async () => {
    const w = await mountApp()
    w.find('.page-menu-btn').element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(document.querySelector('#page-menu [role="menuitem"]')).toBeNull()
    w.unmount()
  })

  it('sees the ads "Refresh data" button greyed out, and it sends nothing', async () => {
    const b = mount(AdsRefreshButton, { props: { campaignIds: ['c1'] } })
    const btn = b.find('[data-testid="ads-refresh"]')
    expect(isViewOnlyDisabled(btn.element)).toBe(true)
    expect(btn.text()).toBe('Refresh data')
    btn.element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(refreshAdsData).not.toHaveBeenCalled()
  })
})

describe('view-only access: the owner', () => {
  it('keeps every control live, and a change saves', async () => {
    const w = await mountApp()
    const add = w.find('[data-testid="add-chart"]').element
    expect(add.hasAttribute('disabled')).toBe(false)
    expect(add.classList.contains('view-only-disabled')).toBe(false)
    expect(w.findComponent(GridLayout).props('isDraggable')).toBe(true)
    const dash = w.findComponent(Dashboard)
    const first = (dash.props('widgets') as { id: string }[])[0]
    dash.vm.$emit('remove', first.id)
    await pastDebounce()
    await flushPromises()
    expect(saveConfig).toHaveBeenCalledTimes(1)
    await w.find('[data-testid="add-chart"]').trigger('click')
    expect(w.findComponent(ChartEditor).exists()).toBe(true)
    w.unmount()
  })

  it('sees the ads "Refresh data" button live', async () => {
    const b = mount(AdsRefreshButton, { props: { campaignIds: ['c1'] } })
    const btn = b.find('[data-testid="ads-refresh"]')
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    await flushPromises()
    expect(refreshAdsData).toHaveBeenCalledTimes(1)
  })
})

describe('v-edit', () => {
  it("stays disabled when the control's own :disabled binding turns false, and restores its title for the owner", async () => {
    const busy = ref(true)
    const C = defineComponent(() => () => withDirectives(h('button', { disabled: busy.value, title: 'Own title' }, 'Go'), [[vEdit]]))
    viewOnly.value = true
    const w = mount(C)
    const el = w.element as HTMLButtonElement
    expect(isViewOnlyDisabled(el)).toBe(true)
    busy.value = false
    await nextTick()
    expect(isViewOnlyDisabled(el)).toBe(true)
    viewOnly.value = false
    await nextTick()
    expect(el.hasAttribute('disabled')).toBe(false)
    expect(el.getAttribute('title')).toBe('Own title')
    w.unmount()
  })
})
