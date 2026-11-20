// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

vi.mock('../../session', () => ({ checkSessionExpired: vi.fn(async () => {}) }))
import { resetAccessProbe } from '../../lib/budget/clientRead'
import type { DebtSlice, MetaResponse, SummaryResponse } from '../../lib/budget/types'
import BudgetSection from './BudgetSection.vue'
import BudgetTable from './BudgetTable.vue'
import DebtDetail from './DebtDetail.vue'
import DebtPanel from './DebtPanel.vue'
import SpendingPanel from './SpendingPanel.vue'

const TODAY = '2026-11-20'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const META: MetaResponse = {
  people: [{ id: 'p1', label: 'Person One' }, { id: 'p2', label: 'Person Two' }],
  accounts: [{ id: 'acct-1', label: 'Card A', kind: 'card', personId: 'p1', last4: '0001', isDebt: true, inSpending: true, creditLimitCents: 500000, aprBp: 1999 }],
  categories: [{ id: 'groceries', label: 'Groceries', color: null, sort: 10 }],
  range: { min: '2026-01-02', max: '2026-11-18' },
}
const SUMMARY: SummaryResponse = {
  level: 'category',
  slices: [{ key: 'groceries', label: 'Groceries', netCents: 12000, count: 3 }, { key: 'fuel', label: 'Fuel', netCents: 5000, count: 2 }],
  totalCents: 17000,
  reviewCount: 2,
}
const EMPTY_PAGE = { rows: [], nextCursor: null }
const DEBTS: DebtSlice[] = [
  { accountId: 'acct-1', label: 'Card A', kind: 'card', last4: '0001', personId: 'p1', balanceCents: 90000, asOf: '2026-10-31', source: 'statement', aprBp: 1999, creditLimitCents: 500000 },
]

interface Routes {
  access?: () => Response
  meta?: () => Response
  summary?: (u: URL) => Response
  debts?: (u: URL) => Response
  transactions?: (u: URL) => Response
}
let fetchMock: ReturnType<typeof vi.fn>
function route(r: Routes = {}) {
  fetchMock = vi.fn(async (input: string) => {
    const u = new URL(input, 'http://x')
    switch (u.pathname) {
      case '/api/budget/access': return r.access ? r.access() : json({ ok: true, email: 'a@example.com' })
      case '/api/budget/meta': return r.meta ? r.meta() : json(META)
      case '/api/budget/summary': return r.summary ? r.summary(u) : json(SUMMARY)
      case '/api/budget/debts': return r.debts ? r.debts(u) : json({ debts: DEBTS })
      case '/api/budget/transactions': return r.transactions ? r.transactions(u) : json(EMPTY_PAGE)
      default: throw new Error(`unmocked ${input}`)
    }
  })
  vi.stubGlobal('fetch', fetchMock)
}
const callsTo = (path: string) => fetchMock.mock.calls.filter((c) => new URL(c[0], 'http://x').pathname === path)

const mounted: VueWrapper[] = []
async function mountSection(url = '/?section=budget') {
  history.replaceState(null, '', url)
  const w = mount(BudgetSection, { props: { dark: false, today: TODAY }, attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  return w
}
beforeEach(() => {
  resetAccessProbe()
  history.replaceState(null, '', '/?section=budget')
})
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.unstubAllGlobals()
})

describe('BudgetSection: access first', () => {
  it('without access: the message, and no request beyond the probe', async () => {
    route({ access: () => json({ error: 'budget_denied' }, 403) })
    const w = await mountSection()
    expect(w.get('[data-testid="budget-unavailable"]').text()).toBe("Budget isn't available for this account")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(callsTo('/api/budget/access')).toHaveLength(1)
  })

  it('never fetches data before the probe has answered', async () => {
    let release!: (r: Response) => void
    route({ access: () => { throw new Error('replaced') } })
    // Every other route answers with its own shape (the real table reads `rows` from /transactions).
    fetchMock.mockImplementation((input: string) => {
      if (input === '/api/budget/access') return new Promise<Response>((res) => (release = res))
      const path = new URL(input, 'http://x').pathname
      const body = path === '/api/budget/meta' ? META : path === '/api/budget/debts' ? { debts: DEBTS } : path === '/api/budget/transactions' ? EMPTY_PAGE : SUMMARY
      return Promise.resolve(json(body))
    })
    vi.stubGlobal('fetch', fetchMock)
    const w = mount(BudgetSection, { props: { dark: false, today: TODAY }, attachTo: document.body })
    mounted.push(w)
    await flushPromises()
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['/api/budget/access'])
    release(json({ ok: true, email: 'a@example.com' }))
    await flushPromises()
    expect(callsTo('/api/budget/meta')).toHaveLength(1)
    expect(callsTo('/api/budget/summary')).toHaveLength(1)
  })

  it('a network error on the probe shows a Retry that asks again', async () => {
    route({ access: () => { throw new TypeError('Failed to fetch') } })
    const w = await mountSection()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    route()
    await w.get('[data-testid="budget-retry-access"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="spending-panel"]').exists()).toBe(true)
  })

  it('401 shows the sign-in message', async () => {
    route({ access: () => json({}, 401) })
    const w = await mountSection()
    expect(w.text()).toContain('Sign in again')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('BudgetSection: data', () => {
  it('loads meta once, then summary and debts once; panels get their props', async () => {
    route()
    const w = await mountSection()
    expect(callsTo('/api/budget/meta')).toHaveLength(1)
    expect(callsTo('/api/budget/summary')).toHaveLength(1)
    expect(callsTo('/api/budget/debts')).toHaveLength(1)
    const u = new URL(callsTo('/api/budget/summary')[0][0], 'http://x')
    expect(Object.fromEntries(u.searchParams)).toEqual({ from: '2026-11-01', to: '2026-11-20', person: 'all' })
    expect(w.findComponent(SpendingPanel).props('summary')).toEqual(SUMMARY)
    expect(w.findComponent(DebtPanel).props()).toMatchObject({ debts: DEBTS, canEdit: true, dark: false })
    expect(w.findComponent(BudgetTable).props()).toMatchObject({
      query: { from: '2026-11-01', to: '2026-11-20', person: 'all', scope: 'spending' },
      canEdit: true,
      refreshKey: 0,
    })
  })

  it('a person change refetches /summary once (and /debts); the range change refetches /summary once', async () => {
    route()
    const w = await mountSection()
    await w.get('[data-testid="budget-person-p2"]').trigger('click')
    await flushPromises()
    expect(callsTo('/api/budget/summary')).toHaveLength(2)
    expect(new URL(callsTo('/api/budget/summary')[1][0], 'http://x').searchParams.get('person')).toBe('p2')
    expect(callsTo('/api/budget/debts')).toHaveLength(2)
    await w.get('[data-testid="budget-range"]').setValue('last-month')
    await flushPromises()
    expect(callsTo('/api/budget/summary')).toHaveLength(3)
    expect(callsTo('/api/budget/debts')).toHaveLength(2)
    const last = new URL(callsTo('/api/budget/summary')[2][0], 'http://x').searchParams
    expect([last.get('from'), last.get('to')]).toEqual(['2026-10-01', '2026-10-31'])
    // the same value again changes nothing
    await w.get('[data-testid="budget-person-p2"]').trigger('click')
    await flushPromises()
    expect(callsTo('/api/budget/summary')).toHaveLength(3)
  })

  it('drilling and crumbs go through the state: query, URL and table agree', async () => {
    route()
    const w = await mountSection()
    const panel = w.findComponent(SpendingPanel)
    panel.vm.$emit('drill', { level: 'category', key: 'groceries', label: 'Groceries' })
    await flushPromises()
    const q = new URL(callsTo('/api/budget/summary').at(-1)![0], 'http://x').searchParams
    expect(q.get('category')).toBe('groceries')
    expect(q.get('groupBy')).toBe('merchant')
    expect(w.findComponent(BudgetTable).props('query')).toMatchObject({ category: 'groceries', scope: 'spending' })
    expect(new URLSearchParams(location.search).get('b_path')).toBe(JSON.stringify([['category', 'groceries', 'Groceries']]))
    expect(new URLSearchParams(location.search).get('section')).toBe('budget')
    w.findComponent(SpendingPanel).vm.$emit('crumb', 0)
    await flushPromises()
    expect(new URL(callsTo('/api/budget/summary').at(-1)![0], 'http://x').searchParams.has('category')).toBe(false)
    expect(new URLSearchParams(location.search).has('b_path')).toBe(false)
  })

  it('drilling to purchases and back: the pie and the table always ask for the same slice', async () => {
    route()
    const w = await mountSection()
    const lastSummary = () => new URL(callsTo('/api/budget/summary').at(-1)![0], 'http://x').searchParams
    const spending = () => w.findComponent(SpendingPanel)
    const sameSlice = () => {
      const s = lastSummary()
      const t = w.findComponent(BudgetTable).props("query") as unknown as Record<string, unknown>
      for (const k of ['category', 'merchant', 'account']) expect(t[k] ?? null).toBe(s.get(k))
      expect([t.from, t.to, t.person]).toEqual([s.get('from'), s.get('to'), s.get('person')])
    }
    sameSlice()
    spending().vm.$emit('drill', { level: 'category', key: 'groceries', label: 'Groceries' })
    await flushPromises()
    sameSlice()
    spending().vm.$emit('drill', { level: 'merchant', key: 'chain-x', label: 'Chain X' })
    await flushPromises()
    expect(lastSummary().get('merchant')).toBe('chain-x')
    sameSlice()
    spending().vm.$emit('select-purchase', 'txn-1')
    await flushPromises()
    expect(w.findComponent(BudgetTable).props('highlightId')).toBe('txn-1')
    // one step back: the highlight clears, the slice widens to the category
    spending().vm.$emit('crumb', 1)
    await flushPromises()
    expect(w.findComponent(BudgetTable).props('highlightId')).toBeNull()
    expect(lastSummary().has('merchant')).toBe(false)
    sameSlice()
    spending().vm.$emit('crumb', 0)
    await flushPromises()
    expect(lastSummary().has('category')).toBe(false)
    sameSlice()
  })

  it('by account: the account id goes to the summary and the table, and survives the URL round trip', async () => {
    route()
    const w = await mountSection()
    const spending = () => w.findComponent(SpendingPanel)
    spending().vm.$emit('drill', { level: 'category', key: 'groceries', label: 'Groceries' })
    await flushPromises()
    spending().vm.$emit('group-by', 'account')
    await flushPromises()
    expect(new URL(callsTo('/api/budget/summary').at(-1)![0], 'http://x').searchParams.get('groupBy')).toBe('account')
    spending().vm.$emit('drill', { level: 'merchant', key: 'acct-1', label: 'Card A' })
    await flushPromises()
    const q = new URL(callsTo('/api/budget/summary').at(-1)![0], 'http://x').searchParams
    expect(q.get('account')).toBe('acct-1')
    expect(q.has('merchant')).toBe(false)
    expect(w.findComponent(BudgetTable).props('query')).toMatchObject({ category: 'groceries', account: 'acct-1' })
    expect(w.findComponent(BudgetTable).props('query')).not.toHaveProperty('merchant', expect.anything())
    // the table's own requests carry it too
    const tx = callsTo('/api/budget/transactions').map((c) => new URL(c[0], 'http://x').searchParams)
    expect(tx.at(-1)!.get('account')).toBe('acct-1')
    // reload from the address bar: same slice on both sides
    const url = location.pathname + location.search
    const again = await mountSection(url)
    const q2 = new URL(callsTo('/api/budget/summary').at(-1)![0], 'http://x').searchParams
    expect([q2.get('category'), q2.get('account'), q2.get('groupBy')]).toEqual(['groceries', 'acct-1', 'account'])
    expect(again.findComponent(BudgetTable).props('query')).toMatchObject({ category: 'groceries', account: 'acct-1' })
  })

  it('review-only goes to the table query without refetching the summary', async () => {
    route()
    const w = await mountSection()
    w.findComponent(SpendingPanel).vm.$emit('review-only', true)
    await flushPromises()
    expect(w.findComponent(BudgetTable).props('query')).toMatchObject({ review: true })
    expect(callsTo('/api/budget/summary')).toHaveLength(1)
  })

  it('an edit in the table bumps refreshKey and refetches /summary once', async () => {
    route()
    const w = await mountSection()
    w.findComponent(BudgetTable).vm.$emit('edited', { txnId: 't1', ruleApplied: false, reapplied: 0 })
    await flushPromises()
    expect(callsTo('/api/budget/summary')).toHaveLength(2)
    expect(w.findComponent(BudgetTable).props('refreshKey')).toBe(1)
  })

  it('a purchase pick highlights the table row', async () => {
    route()
    const w = await mountSection()
    w.findComponent(SpendingPanel).vm.$emit('select-purchase', 'txn-9')
    await flushPromises()
    expect(w.findComponent(BudgetTable).props('highlightId')).toBe('txn-9')
  })

  it('a debt pick swaps the panel for the detail; saving refetches debts; close goes back', async () => {
    route()
    const w = await mountSection()
    w.findComponent(DebtPanel).vm.$emit('open', 'acct-1')
    await flushPromises()
    expect(w.findComponent(DebtPanel).exists()).toBe(false)
    expect(w.findComponent(DebtDetail).props()).toMatchObject({ accountId: 'acct-1', canEdit: true })
    w.findComponent(DebtDetail).vm.$emit('saved')
    await flushPromises()
    expect(callsTo('/api/budget/debts')).toHaveLength(2)
    w.findComponent(DebtDetail).vm.$emit('close')
    await flushPromises()
    expect(w.findComponent(DebtPanel).exists()).toBe(true)
  })

  it('edit rights come from the access probe, not the site view-only flag', async () => {
    const { viewOnly } = await import('../../lib/viewOnly')
    viewOnly.value = true
    try {
      route()
      const w = await mountSection()
      expect(w.findComponent(BudgetTable).props('canEdit')).toBe(true)
      expect(w.findComponent(DebtPanel).props('canEdit')).toBe(true)
    } finally {
      viewOnly.value = false
    }
  })
})

describe('BudgetSection: states', () => {
  it('empty database: "No statements loaded yet" and no data fetches', async () => {
    route({ meta: () => json({ ...META, range: { min: null, max: null } }) })
    const w = await mountSection()
    expect(w.get('[data-testid="budget-empty-db"]').text()).toBe('No statements loaded yet')
    expect(callsTo('/api/budget/summary')).toHaveLength(0)
    expect(callsTo('/api/budget/debts')).toHaveLength(0)
  })

  it('empty range: "No spending in this range", filters stay', async () => {
    route({ summary: () => json({ level: 'category', slices: [], totalCents: 0, reviewCount: 0 }) })
    const w = await mountSection()
    expect(w.get('[data-testid="budget-empty-range"]').text()).toBe('No spending in this range')
    expect(w.find('[data-testid="budget-range"]').exists()).toBe(true)
    expect(w.find('[data-testid="spending-panel"]').exists()).toBe(false)
  })

  it('loading: a skeleton shows until the summary lands', async () => {
    let release!: (r: Response) => void
    route()
    const base = fetchMock.getMockImplementation() as (input: string) => Promise<Response>
    fetchMock.mockImplementation((input: string) =>
      new URL(input, 'http://x').pathname === '/api/budget/summary' ? new Promise<Response>((res) => (release = res)) : base(input))
    const w = await mountSection()
    expect(w.find('[aria-label="Loading spending"]').exists()).toBe(true)
    expect(w.findAll('.sk-row').length).toBeGreaterThanOrEqual(6)
    release(json(SUMMARY))
    await flushPromises()
    expect(w.find('[aria-label="Loading spending"]').exists()).toBe(false)
    expect(w.find('[data-testid="spending-panel"]').exists()).toBe(true)
  })

  it('drilling keeps the old pie (no skeleton) until the next level lands, then shows it with its own path', async () => {
    let release!: (r: Response) => void
    route()
    const base = fetchMock.getMockImplementation() as (input: string) => Promise<Response>
    fetchMock.mockImplementation((input: string) => {
      const u = new URL(input, 'http://x')
      return u.pathname === '/api/budget/summary' && u.searchParams.get('category') === 'groceries' ? new Promise<Response>((res) => (release = res)) : base(input)
    })
    const w = await mountSection()
    const pie = w.findComponent(SpendingPanel).vm.$.uid
    const groceries = { level: 'category', key: 'groceries', label: 'Groceries' }
    w.findComponent(SpendingPanel).vm.$emit('drill', groceries)
    await flushPromises()
    // loading: still the old pie and its crumbs, dimmed; no skeleton
    expect(w.find('[aria-label="Loading spending"]').exists()).toBe(false)
    expect(w.findComponent(SpendingPanel).vm.$.uid).toBe(pie)
    expect(w.findComponent(SpendingPanel).props('path')).toEqual([])
    expect(w.findComponent(SpendingPanel).props('refreshing')).toBe(true)
    // a second drill on the old pie is ignored: its slices are not the ones of the position asked for
    w.findComponent(SpendingPanel).vm.$emit('drill', { level: 'merchant', key: 'chain-x', label: 'Chain X' })
    await flushPromises()
    expect(new URLSearchParams(location.search).get('b_path')).toBe(JSON.stringify([['category', 'groceries', 'Groceries']]))
    release(json({ level: 'merchant', slices: [{ key: 'chain-x', label: 'Chain X', netCents: 3000, count: 2 }], totalCents: 3000, reviewCount: 0 }))
    await flushPromises()
    expect(w.findComponent(SpendingPanel).vm.$.uid).toBe(pie)
    expect(w.findComponent(SpendingPanel).props('path')).toEqual([groceries])
    expect(w.findComponent(SpendingPanel).props('refreshing')).toBe(false)
  })

  it('summary error: message with Retry that refetches', async () => {
    let fail = true
    route({ summary: () => (fail ? json({ error: 'bad_request' }, 500) : json(SUMMARY)) })
    const w = await mountSection()
    expect(w.text()).toContain("Couldn't load spending.")
    fail = false
    await w.get('[data-testid="budget-retry-summary"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="spending-panel"]').exists()).toBe(true)
  })

  it('meta error: message with Retry', async () => {
    let fail = true
    route({ meta: () => (fail ? json({}, 503) : json(META)) })
    const w = await mountSection()
    expect(w.text()).toContain("Couldn't load Budget.")
    fail = false
    await w.get('[data-testid="budget-retry-meta"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="budget-range"]').exists()).toBe(true)
  })

  it('debts: error with Retry, and "No debts recorded" when empty', async () => {
    let mode: 'fail' | 'empty' = 'fail'
    route({ debts: () => (mode === 'fail' ? json({}, 500) : json({ debts: [] })) })
    const w = await mountSection()
    expect(w.text()).toContain("Couldn't load debts.")
    mode = 'empty'
    await w.get('[data-testid="budget-retry-debts"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="budget-empty-debts"]').text()).toBe('No debts recorded')
  })

  it('an unknown person in the URL falls back to All', async () => {
    route()
    const w = await mountSection('/?section=budget&b_person=nobody')
    expect(callsTo('/api/budget/summary')).toHaveLength(1)
    expect(new URL(callsTo('/api/budget/summary')[0][0], 'http://x').searchParams.get('person')).toBe('all')
    expect(w.get('[data-testid="budget-person-all"]').attributes('aria-checked')).toBe('true')
  })
})

describe('BudgetSection: tabs and URL', () => {
  it('Spending and Debts tabs mark the active pane and the URL', async () => {
    route()
    const w = await mountSection()
    expect(w.get('[data-pane="spending"]').classes()).toContain('active')
    expect(w.get('[data-pane="debts"]').classes()).not.toContain('active')
    await w.get('[data-testid="budget-tab-debts"]').trigger('click')
    expect(w.get('[data-pane="debts"]').classes()).toContain('active')
    expect(w.get('[data-pane="spending"]').classes()).not.toContain('active')
    expect(w.get('[data-testid="budget-tab-debts"]').attributes('aria-selected')).toBe('true')
    expect(new URLSearchParams(location.search).get('b_tab')).toBe('debts')
  })

  it('opens on the state in the URL', async () => {
    route()
    const w = await mountSection('/?section=budget&b_person=p2&b_from=2026-10-01&b_to=2026-10-31&b_tab=debts&b_review=1')
    const q = new URL(callsTo('/api/budget/summary')[0][0], 'http://x').searchParams
    expect(Object.fromEntries(q)).toEqual({ from: '2026-10-01', to: '2026-10-31', person: 'p2' })
    expect(w.get('[data-pane="debts"]').classes()).toContain('active')
    expect(w.findComponent(BudgetTable).props('query')).toMatchObject({ review: true, person: 'p2' })
  })

  it('popstate re-reads the state from the address bar', async () => {
    route()
    const w = await mountSection()
    history.replaceState(null, '', '/?section=budget&b_person=p2&b_from=2026-10-01&b_to=2026-10-31')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushPromises()
    expect(new URL(callsTo('/api/budget/summary').at(-1)![0], 'http://x').searchParams.get('person')).toBe('p2')
    expect(w.get('[data-testid="budget-person-p2"]').attributes('aria-checked')).toBe('true')
  })
})
