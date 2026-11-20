// @vitest-environment happy-dom
//
// The Budget section hooks in App.vue: the nav link (shown only when GET /api/budget/access says 200),
// `?section=budget` opening the section in place of the page, the page chrome that goes while it is open,
// `switchPage` / the link / popstate closing it, and every other query param (`?page=`, utm_*) surviving.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import App from './App.vue'
import NavBreadcrumb from './components/nav/NavBreadcrumb.vue'
import { stubAppFetch } from './testing/appFetch'
import { loadConfig, saveConfig } from './api'
import { resetAccessProbe } from './lib/budget/clientRead'
import { defaultConfig } from './lib/defaults'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    loadConfig: vi.fn(async () => null),
    saveConfig: vi.fn(async () => true),
    fetchStats: vi.fn(() => new Promise(() => {})),
    fetchSeriesStats: vi.fn(() => new Promise(() => {})),
  }
})
vi.mock('./sitesStore', async (importOriginal) => ({ ...(await importOriginal<typeof import('./sitesStore')>()), loadSites: vi.fn(async () => {}) }))
vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  loadIdentity: vi.fn(async () => {}),
  checkSessionExpired: vi.fn(async () => {}),
}))

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const META = {
  people: [{ id: 'p1', label: 'Person One' }],
  accounts: [],
  categories: [],
  range: { min: '2026-01-02', max: '2026-11-18' },
}
let fetchMock: ReturnType<typeof vi.fn>
let appFetch: ReturnType<typeof stubAppFetch>
/** The App's own stub plus the budget routes: `access` is what GET /api/budget/access answers. */
function stubBudget(access: () => Response | Promise<Response>) {
  appFetch = stubAppFetch()
  const base = appFetch.fetch
  fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    switch (url.split('?')[0]) {
      case '/api/budget/access': return access()
      case '/api/budget/meta': return json(META)
      case '/api/budget/summary': return json({ level: 'category', slices: [], totalCents: 0, reviewCount: 0 })
      case '/api/budget/debts': return json({ debts: [] })
      default: return base(input, init)
    }
  })
  vi.stubGlobal('fetch', fetchMock)
}
const budgetCalls = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/budget'))

const mounted: VueWrapper[] = []
beforeEach(() => {
  resetAccessProbe()
  localStorage.clear()
  vi.mocked(saveConfig).mockClear()
  vi.mocked(loadConfig).mockImplementation(async () => JSON.parse(JSON.stringify(defaultConfig())))
})
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.unstubAllGlobals()
})
async function mountAt(url: string) {
  history.replaceState(null, '', url)
  const w = mount(App, { attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  if (url.includes('section=budget')) await sectionShown(w)
  return w
}
/** The section's chunk is an async component: wait for its first render. */
const sectionShown = (w: VueWrapper) => vi.waitFor(() => expect(w.find('[data-testid="budget-section"]').exists()).toBe(true))
const params = () => new URLSearchParams(location.search)
const link = (w: VueWrapper) => w.find('[data-testid="budget-nav-link"]')

describe('App: Budget nav link', () => {
  it('is absent when the probe says 403, 401 or fails, and a normal page shows', async () => {
    for (const answer of [() => json({ error: 'budget_denied' }, 403), () => json({}, 401), () => Promise.reject(new TypeError('Failed to fetch'))]) {
      resetAccessProbe()
      stubBudget(answer)
      const w = await mountAt('/')
      expect(link(w).exists()).toBe(false)
      expect(w.find('main.grid-area').exists()).toBe(true)
      expect(budgetCalls()).toEqual(['/api/budget/access'])
      w.unmount()
      mounted.pop()
      vi.unstubAllGlobals()
    }
  })

  it('is shown on 200, probed exactly once, with no other budget request while the section is closed', async () => {
    stubBudget(() => json({ ok: true, email: 'a@example.com' }))
    const w = await mountAt('/')
    expect(link(w).exists()).toBe(true)
    expect(w.findComponent(NavBreadcrumb).exists()).toBe(true)
    expect(budgetCalls()).toEqual(['/api/budget/access'])
  })
})

describe('App: ?section=budget', () => {
  it('without access: the message, and no request beyond the probe', async () => {
    stubBudget(() => json({ error: 'budget_denied' }, 403))
    const w = await mountAt('/?section=budget')
    expect(w.get('[data-testid="budget-unavailable"]').text()).toBe("Budget isn't available for this account")
    expect(budgetCalls()).toEqual(['/api/budget/access'])
  })

  it('with access: the section replaces the page chrome, filter bar and charts', async () => {
    stubBudget(() => json({ ok: true, email: 'a@example.com' }))
    const w = await mountAt('/?section=budget&page=bsk-features&utm_source=x')
    expect(w.find('[data-testid="budget-section"]').exists()).toBe(true)
    expect(w.get('[data-testid="budget-label"]').text()).toBe('Budget')
    expect(w.findComponent(NavBreadcrumb).exists()).toBe(false)
    expect(w.find('[data-testid="add-chart"]').exists()).toBe(false)
    expect(w.find('.page-menu-btn').exists()).toBe(false)
    expect(w.find('.filterbar-inflow').exists()).toBe(false)
    expect(w.find('.fb-anchor').exists()).toBe(false)
    expect(w.find('main.grid-area').exists()).toBe(false)
    expect(w.find('.drawer-btn').exists()).toBe(true)
    // one probe, then data
    expect(budgetCalls().filter((u) => u === '/api/budget/access')).toHaveLength(1)
    expect(budgetCalls().some((u) => u.startsWith('/api/budget/summary'))).toBe(true)
    // the page and other params stay in the address bar
    expect(params().get('section')).toBe('budget')
    expect(params().get('page')).toBe('bsk-features')
    expect(params().get('utm_source')).toBe('x')
    expect(saveConfig).not.toHaveBeenCalled()
  })
})

describe('App: opening and closing', () => {
  beforeEach(() => stubBudget(() => json({ ok: true, email: 'a@example.com' })))

  it('the link opens the section (new history entry) and the link again closes it; other params survive both ways', async () => {
    const w = await mountAt('/?utm_source=x&page=bsk-features')
    const len = history.length
    await link(w).trigger('click')
    await sectionShown(w)
    expect(history.length).toBe(len + 1)
    expect(params().get('section')).toBe('budget')
    expect(params().get('page')).toBe('bsk-features')
    expect(params().get('utm_source')).toBe('x')
    expect(link(w).attributes('aria-current')).toBe('page')

    await link(w).trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="budget-section"]').exists()).toBe(false)
    expect(w.find('main.grid-area').exists()).toBe(true)
    expect(w.find('[data-testid="add-chart"]').exists()).toBe(true)
    expect(params().has('section')).toBe(false)
    expect([...params().keys()].some((k) => k.startsWith('b_'))).toBe(false)
    expect(params().get('page')).toBe('bsk-features')
    expect(params().get('utm_source')).toBe('x')
    expect(history.length).toBe(len + 1) // closing replaced, did not add
    expect(budgetCalls().filter((u) => u === '/api/budget/access')).toHaveLength(1)
  })

  it('switching page (the drawer) closes the section and lands on that page', async () => {
    const w = await mountAt('/?section=budget&b_person=p1&utm_source=x')
    await w.find('.drawer-btn').trigger('click')
    await flushPromises()
    const row = Array.from(document.querySelectorAll<HTMLElement>('#nav-drawer .dr-page')).find((r) => r.querySelector('.nm')!.textContent!.trim() === 'Campaigns')!
    row.click()
    await flushPromises()
    expect(w.find('[data-testid="budget-section"]').exists()).toBe(false)
    expect(w.find('main.grid-area').exists()).toBe(true)
    expect(params().has('section')).toBe(false)
    expect(params().has('b_person')).toBe(false)
    expect(params().get('page')).toBe('bsk-campaigns')
    expect(params().get('utm_source')).toBe('x')
  })

  it('popstate re-reads the section from the address bar', async () => {
    const w = await mountAt('/')
    history.pushState(null, '', '/?section=budget')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await sectionShown(w)
    history.replaceState(null, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushPromises()
    expect(w.find('[data-testid="budget-section"]').exists()).toBe(false)
    expect(w.find('main.grid-area').exists()).toBe(true)
  })

  it('a view-only site viewer still gets edit controls in the section (rights come from the probe)', async () => {
    const { viewOnly } = await import('./lib/viewOnly')
    viewOnly.value = true
    try {
      const w = await mountAt('/?section=budget')
      const { default: BudgetTable } = await import('./components/budget/BudgetTable.vue')
      expect(w.findComponent(BudgetTable).props('canEdit')).toBe(true)
    } finally {
      viewOnly.value = false
    }
  })
})
