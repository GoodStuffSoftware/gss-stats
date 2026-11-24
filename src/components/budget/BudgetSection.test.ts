// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

vi.mock('../../session', () => ({ checkSessionExpired: vi.fn(async () => {}) }))
import { resetAccessProbe } from '../../lib/budget/clientRead'
import { LAYOUT_KEY, panelsKey } from '../../lib/budget/panelVisibility'
import { defaultSavedView, type SavedView } from '../../lib/budget/savedView'
import type { DebtSlice, MetaResponse, SummaryResponse } from '../../lib/budget/types'
import BudgetFilters from './BudgetFilters.vue'
import BudgetSection from './BudgetSection.vue'
import BudgetTable from './BudgetTable.vue'
import DebtDetail from './DebtDetail.vue'
import DrillPie from '../charts/DrillPie.vue'
import DebtPanel from './DebtPanel.vue'
import LoansList from './LoansList.vue'
import LoansPage from './LoansPage.vue'
import SpendingPanel from './SpendingPanel.vue'
import { installHistoryStub, type HistoryStub } from '../../testing/historyStub'

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
  debtDetail?: (id: string) => Response
  loans?: (u: URL) => Response
  prefs?: (init: RequestInit | undefined) => Response | Promise<Response>
}
let fetchMock: ReturnType<typeof vi.fn>
function route(r: Routes = {}) {
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const u = new URL(input, 'http://x')
    switch (u.pathname) {
      case '/api/budget/prefs':
        if (r.prefs) return r.prefs(init)
        throw new Error(`unmocked ${input}`) // the saved view is simply not there
      case '/api/budget/access': return r.access ? r.access() : json({ ok: true, email: 'a@example.com' })
      case '/api/budget/meta': return r.meta ? r.meta() : json(META)
      case '/api/budget/summary': return r.summary ? r.summary(u) : json(SUMMARY)
      case '/api/budget/debts': return r.debts ? r.debts(u) : json({ debts: DEBTS })
      case '/api/budget/loans': return r.loans ? r.loans(u) : json({ debts: [], months: [] })
      case '/api/budget/transactions': return r.transactions ? r.transactions(u) : json(EMPTY_PAGE)
      default:
        if (r.debtDetail && u.pathname.startsWith('/api/budget/debts/')) return r.debtDetail(decodeURIComponent(u.pathname.slice('/api/budget/debts/'.length)))
        throw new Error(`unmocked ${input}`)
    }
  })
  vi.stubGlobal('fetch', fetchMock)
}
const callsTo = (path: string) => fetchMock.mock.calls.filter((c) => new URL(c[0], 'http://x').pathname === path)

const mounted: VueWrapper[] = []
async function mountSection(url = '/?section=budget', state: unknown = null) {
  history.replaceState(state, '', url)
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
    expect(new URLSearchParams(location.search).has('b_path')).toBe(false)
    expect(location.search).not.toMatch(/groceries/i)
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
    // reload: the address carries the range and grouping, the tab's history.state carries the drill path
    const url = location.pathname + location.search
    expect(url).not.toMatch(/groceries|acct-1/)
    const again = await mountSection(url, history.state)
    const q2 = new URL(callsTo('/api/budget/summary').at(-1)![0], 'http://x').searchParams
    expect([q2.get('category'), q2.get('account'), q2.get('groupBy')]).toEqual(['groceries', 'acct-1', 'account'])
    expect(again.findComponent(BudgetTable).props('query')).toMatchObject({ category: 'groceries', account: 'acct-1' })
  })

  it('a reload with no drill path in history.state (a pasted or old link) starts at the top, and an old b_path is dropped from the address', async () => {
    route()
    const old = `/?section=budget&b_path=${encodeURIComponent(JSON.stringify([['category', 'groceries', 'Groceries']]))}`
    const w = await mountSection(old)
    const q = new URL(callsTo('/api/budget/summary').at(-1)![0], 'http://x').searchParams
    expect(q.has('category')).toBe(false)
    expect(w.findComponent(SpendingPanel).props('path')).toEqual([])
    expect(location.search).not.toContain('b_path')
    expect(new URLSearchParams(location.search).get('section')).toBe('budget')
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

  it('a debt pick goes to the Loans page with that loan open; saving refetches debts; close shows the Loans shell', async () => {
    route()
    const w = await mountSection()
    expect(w.findComponent(LoansPage).exists()).toBe(false)
    w.findComponent(DebtPanel).vm.$emit('open', 'acct-1')
    await flushPromises()
    expect(w.findComponent(DebtPanel).exists()).toBe(false)
    expect(w.findComponent(LoansPage).props()).toMatchObject({ loanId: 'acct-1', person: null, canEdit: true })
    expect(w.findComponent(DebtDetail).props()).toMatchObject({ accountId: 'acct-1', canEdit: true, hideBack: true })
    expect(new URLSearchParams(location.search).get('b_page')).toBe('loans')
    expect(location.href).not.toContain('acct-1')
    expect(w.emitted('page')?.at(-1)).toEqual(['loans'])
    w.findComponent(DebtDetail).vm.$emit('saved')
    await flushPromises()
    expect(callsTo('/api/budget/debts')).toHaveLength(1) // Overview's /debts is not read on the Loans page
    w.findComponent(LoansPage).vm.$emit('close')
    await flushPromises()
    expect(w.findComponent(LoansPage).props('loanId')).toBeNull()
    expect(w.findComponent(DebtDetail).exists()).toBe(false)
  })

  it('opens on the Loans page from b_page=loans: no range, no chart toggles, no panels or table; person is passed', async () => {
    route()
    const w = await mountSection('/?section=budget&b_page=loans&b_person=p1')
    expect(w.findComponent(LoansPage).props('person')).toBe('p1')
    expect(w.find('[data-testid="budget-range"]').exists()).toBe(false)
    expect(w.find('.bf-show').exists()).toBe(false)
    expect(w.findComponent(SpendingPanel).exists()).toBe(false)
    expect(w.findComponent(BudgetTable).exists()).toBe(false)
    expect(w.emitted('page')?.[0]).toEqual(['loans'])
  })

  it('goPage switches page both ways and reports it', async () => {
    route()
    const w = await mountSection()
    expect(w.emitted('page')?.[0]).toEqual(['overview'])
    const vm = w.vm as unknown as { goPage: (p: 'overview' | 'loans') => void }
    vm.goPage('loans')
    await flushPromises()
    expect(w.findComponent(LoansPage).exists()).toBe(true)
    expect(w.find('[data-testid="budget-range"]').exists()).toBe(false)
    expect(w.emitted('page')?.at(-1)).toEqual(['loans'])
    vm.goPage('overview')
    await flushPromises()
    expect(w.findComponent(LoansPage).exists()).toBe(false)
    expect(w.find('[data-testid="budget-range"]').exists()).toBe(true)
    expect(w.emitted('page')?.at(-1)).toEqual(['overview'])
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
    expect(new URLSearchParams(location.search).has('b_path')).toBe(false)
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
    await w.get('[data-testid="budget-tab-spending"]').trigger('click')
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

describe('BudgetSection: three tabs (Spending, Debts, Both)', () => {
  beforeEach(() => localStorage.clear())
  // A matchMedia whose width the test sets (the section asks `(max-width: 1023.98px)`); `setNarrow` fires the `change`
  // event a browser sends when the width crosses 1024 px. Every test names its width: none leans on happy-dom's default.
  let listeners: Array<() => void> = []
  let isNarrow = false
  const setWidth = (narrow: boolean) => {
    isNarrow = narrow
    listeners = []
    vi.stubGlobal('matchMedia', (q: string) => ({
      get matches() {
        return q.includes('max-width') && isNarrow
      },
      media: q,
      addEventListener: (_t: string, fn: () => void) => {
        if (q.includes('max-width')) listeners.push(fn)
      },
      removeEventListener: (_t: string, fn: () => void) => {
        listeners = listeners.filter((l) => l !== fn)
      },
      addListener: () => {},
      removeListener: () => {},
    }))
  }
  const crossTo = async (narrow: boolean) => {
    isNarrow = narrow
    for (const fn of [...listeners]) fn()
    await flushPromises()
  }
  const narrowMedia = () => setWidth(true)
  const wideMedia = () => setWidth(false)
  beforeEach(wideMedia)

  it('the bar has Spending, Debts and Both, and there are no Show toggles or layout picker', async () => {
    route()
    const w = await mountSection()
    expect(w.findAll('[role="tab"]').map((t) => t.text())).toEqual(['Spending', 'Debts', 'Both'])
    expect(w.find('[data-testid="budget-show-debts"]').exists()).toBe(false)
    expect(w.find('[data-testid="budget-layout-side"]').exists()).toBe(false)
  })

  it('opens on Both at 1024 px and wider: both panes and the table, one shared donut size key', async () => {
    route()
    const w = await mountSection()
    expect(w.get('[data-testid="budget-section"]').classes()).toContain('is-both')
    expect(w.get('[data-testid="budget-tab-both"]').attributes('aria-selected')).toBe('true')
    expect(w.get('[data-pane="spending"]').classes()).toContain('active')
    expect(w.get('[data-pane="debts"]').classes()).toContain('active')
    expect(w.get('[data-pane="table"]').classes()).toContain('active')
    expect(w.findComponent(SpendingPanel).props('both')).toBe(true)
    expect(w.findComponent(DebtPanel).props('both')).toBe(true)
    expect(w.findComponent(SpendingPanel).props('solo')).toBe(false)
  })

  it('Both: both donuts use the one shared Both size key (a drag resizes both) and hide the legend side picker', async () => {
    route()
    const w = await mountSection()
    const pies = w.findAllComponents(DrillPie)
    expect(pies).toHaveLength(2)
    for (const pie of pies) {
      expect(pie.props('sizeKey')).toBe('gss-stats-budget-donut:both')
      expect(pie.props('legendPicker')).toBe(false)
    }
  })

  it('one chart (Spending tab, Debts tab): its own size key and the legend side picker', async () => {
    route()
    const w = await mountSection()
    await w.get('[data-testid="budget-tab-spending"]').trigger('click')
    let pie = w.findComponent(SpendingPanel).findComponent(DrillPie)
    expect(pie.props('sizeKey')).toBe('gss-stats-budget-donut:spending:solo')
    expect(pie.props('legendPicker')).toBe(true)
    await w.get('[data-testid="budget-tab-debts"]').trigger('click')
    pie = w.findComponent(DebtPanel).findComponent(DrillPie)
    expect(pie.props('sizeKey')).toBe('gss-stats-budget-donut:debts:solo')
    expect(pie.props('legendPicker')).toBe(true)
  })

  it('opens on Spending below 1024 px', async () => {
    narrowMedia()
    route()
    const w = await mountSection()
    expect(w.get('[data-testid="budget-tab-spending"]').attributes('aria-selected')).toBe('true')
    expect(w.get('[data-pane="spending"]').classes()).toContain('active')
    expect(w.get('[data-pane="debts"]').classes()).not.toContain('active')
    expect(w.get('[data-testid="budget-section"]').classes()).not.toContain('is-both')
  })

  it('Spending shows its pane and the table; Debts shows its pane and no table', async () => {
    route()
    const w = await mountSection()
    await w.get('[data-testid="budget-tab-spending"]').trigger('click')
    expect(w.get('[data-pane="spending"]').classes()).toContain('active')
    expect(w.get('[data-pane="debts"]').classes()).not.toContain('active')
    expect(w.get('[data-pane="table"]').classes()).toContain('active')
    expect(w.findComponent(SpendingPanel).props('both')).toBe(false)
    expect(w.findComponent(SpendingPanel).props('solo')).toBe(true)
    await w.get('[data-testid="budget-tab-debts"]').trigger('click')
    expect(w.get('[data-pane="debts"]').classes()).toContain('active')
    expect(w.get('[data-pane="spending"]').classes()).not.toContain('active')
    expect(w.get('[data-pane="table"]').classes()).not.toContain('active')
    expect(new URLSearchParams(location.search).get('b_tab')).toBe('debts')
    await w.get('[data-testid="budget-tab-both"]').trigger('click')
    expect(w.get('[data-pane="table"]').classes()).toContain('active')
    expect(new URLSearchParams(location.search).get('b_tab')).toBe('both')
  })

  it('a narrow Both stacks: both panes, the wide (solo) donut layout, the shared Both size key', async () => {
    narrowMedia()
    route()
    const w = await mountSection('/?section=budget&b_tab=both')
    expect(w.get('[data-pane="spending"]').classes()).toContain('active')
    expect(w.get('[data-pane="debts"]').classes()).toContain('active')
    expect(w.findComponent(SpendingPanel).props('solo')).toBe(true)
    expect(w.findComponent(DebtPanel).props('solo')).toBe(true)
    expect(w.findComponent(SpendingPanel).props('both')).toBe(true)
    expect(w.findComponent(DebtPanel).props('both')).toBe(true)
  })

  it('crossing 1024 px on Both stacks it (solo) and back: the tab stays Both', async () => {
    route()
    const w = await mountSection()
    expect(w.findComponent(SpendingPanel).props('solo')).toBe(false)
    await crossTo(true)
    expect(w.get('[data-testid="budget-tab-both"]').attributes('aria-selected')).toBe('true')
    expect(w.findComponent(SpendingPanel).props('solo')).toBe(true)
    expect(w.findComponent(DebtPanel).props('solo')).toBe(true)
    expect(w.findComponent(SpendingPanel).props('both')).toBe(true)
    await crossTo(false)
    expect(w.get('[data-testid="budget-tab-both"]').attributes('aria-selected')).toBe('true')
    expect(w.findComponent(SpendingPanel).props('solo')).toBe(false)
  })

  it('a bare open stamps the width default, and a click on Spending writes it so a reload keeps it', async () => {
    route()
    const w = await mountSection('/?section=budget') // no b_tab
    expect(w.get('[data-testid="budget-tab-both"]').attributes('aria-selected')).toBe('true')
    await w.get('[data-testid="budget-tab-spending"]').trigger('click')
    expect(new URLSearchParams(location.search).get('b_tab')).toBe('spending')
    w.unmount()
    mounted.pop()
    resetAccessProbe()
    narrowMedia() // the reload happens on a narrow window: the written tab, not the width default
    const again = await mountSection(`/${location.search}`)
    expect(again.get('[data-testid="budget-tab-spending"]').attributes('aria-selected')).toBe('true')
    wideMedia()
    again.unmount()
    mounted.pop()
    resetAccessProbe()
    const wideAgain = await mountSection(`/${location.search}`) // still Spending on a wide window
    expect(wideAgain.get('[data-testid="budget-tab-spending"]').attributes('aria-selected')).toBe('true')
  })

  it('a link names the tab, and a reload keeps it (the address always carries b_tab)', async () => {
    route()
    const w = await mountSection('/?section=budget&b_tab=debts')
    expect(w.get('[data-testid="budget-tab-debts"]').attributes('aria-selected')).toBe('true')
    w.unmount()
    mounted.pop()
    resetAccessProbe()
    const again = await mountSection(`/${location.search}`) // what a reload opens on
    expect(again.get('[data-testid="budget-tab-debts"]').attributes('aria-selected')).toBe('true')
  })

  it('works when localStorage throws', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      route()
      const w = await mountSection()
      await w.get('[data-testid="budget-tab-debts"]').trigger('click')
      expect(w.get('[data-pane="debts"]').classes()).toContain('active')
    } finally {
      set.mockRestore()
      get.mockRestore()
    }
  })
})

describe('BudgetSection: debt drill in place', () => {
  const DETAIL = {
    account: META.accounts[0],
    history: [
      { asOf: '2026-09-30', balanceCents: 120000, source: 'statement', aprBp: 1999 },
      { asOf: '2026-10-31', balanceCents: 90000, source: 'statement', aprBp: 1999 },
    ],
    periods: [], payments: [], terms: null, latest: null, promos: [],
  }
  const detailCalls = () => callsTo('/api/budget/debts/acct-1')

  it('a slice opens its balance line in place: one detail fetch, the crumb, no jump to Loans', async () => {
    route({ debtDetail: () => json(DETAIL) })
    const w = await mountSection()
    w.findComponent(DebtPanel).vm.$emit('drill', 'acct-1')
    await flushPromises()
    expect(detailCalls()).toHaveLength(1)
    expect(w.findComponent(LoansPage).exists()).toBe(false)
    expect(w.findComponent(DebtPanel).props('selected')).toMatchObject({ accountId: 'acct-1' })
    expect(w.findComponent(DebtPanel).props('history')).toHaveLength(2)
    expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(true)
    expect(w.get('[data-testid="debt-drilled-balance"]').text()).toContain('900')
    expect(location.href).not.toContain('acct-1') // the id lives in history.state only
    expect(new URLSearchParams(location.search).get('b_page')).toBeNull()
  })

  it('the crumb returns to the pie; opening the same debt again uses the cache', async () => {
    route({ debtDetail: () => json(DETAIL) })
    const w = await mountSection()
    w.findComponent(DebtPanel).vm.$emit('drill', 'acct-1')
    await flushPromises()
    await w.get('[data-testid="crumb-0"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(false)
    expect(w.find('[data-testid="debt-total"]').exists()).toBe(true)
    w.findComponent(DebtPanel).vm.$emit('drill', 'acct-1')
    await flushPromises()
    expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(true)
    expect(detailCalls()).toHaveLength(1)
  })

  it('popstate with no drill mark in history.state returns to the pie', async () => {
    route({ debtDetail: () => json(DETAIL) })
    const w = await mountSection()
    w.findComponent(DebtPanel).vm.$emit('drill', 'acct-1')
    await flushPromises()
    expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(true)
    history.replaceState(null, '', location.href)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushPromises()
    expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(false)
    expect(w.find('[data-testid="debt-total"]').exists()).toBe(true)
  })

  it('a failed history load shows Retry, and Retry asks again', async () => {
    let fail = true
    route({ debtDetail: () => (fail ? json({ error: 'boom' }, 500) : json(DETAIL)) })
    const w = await mountSection()
    w.findComponent(DebtPanel).vm.$emit('drill', 'acct-1')
    await flushPromises()
    expect(detailCalls()).toHaveLength(1)
    fail = false
    await w.get('[data-testid="debt-drilled-retry"]').trigger('click')
    await flushPromises()
    expect(detailCalls()).toHaveLength(2)
    expect(w.find('[data-testid="debt-drilled-retry"]').exists()).toBe(false)
  })

  it('"Loan details" goes to the Loans page with that loan open', async () => {
    route({ debtDetail: () => json(DETAIL) })
    const w = await mountSection()
    w.findComponent(DebtPanel).vm.$emit('drill', 'acct-1')
    await flushPromises()
    await w.get('[data-testid="debt-drilled-open"]').trigger('click')
    await flushPromises()
    expect(w.findComponent(LoansPage).props()).toMatchObject({ loanId: 'acct-1' })
    expect(new URLSearchParams(location.search).get('b_page')).toBe('loans')
  })

  it('a person change that keeps the drilled debt reloads its balance line (no stuck skeleton)', async () => {
    route({ debtDetail: () => json(DETAIL) })
    const w = await mountSection()
    w.findComponent(DebtPanel).vm.$emit('drill', 'acct-1')
    await flushPromises()
    expect(w.findComponent(DebtPanel).props('history')).toHaveLength(2)
    w.findComponent(BudgetFilters).vm.$emit('person', 'p1') // acct-1 stays in the new person's debts
    await flushPromises()
    expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(true)
    expect(w.findComponent(DebtPanel).props('history')).toHaveLength(2)
    expect(w.find('[data-testid="debt-chart"]').exists()).toBe(true)
  })

  it('recording a balance on the Loans page, then back to Overview, reloads the drilled balance line', async () => {
    route({ debtDetail: () => json(DETAIL) })
    const w = await mountSection()
    w.findComponent(DebtPanel).vm.$emit('drill', 'acct-1')
    await flushPromises()
    await w.get('[data-testid="debt-drilled-open"]').trigger('click') // Loans page, state.debt stays acct-1
    await flushPromises()
    w.findComponent(LoansPage).vm.$emit('saved')
    await flushPromises()
    history.back()
    await flushPromises()
    window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }))
    await flushPromises()
    expect(w.findComponent(LoansPage).exists()).toBe(false)
    expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(true)
    expect(w.findComponent(DebtPanel).props('history')).toHaveLength(2)
  })

  it('works in Tabs mode too, on the Debts tab', async () => {
    localStorage.setItem(LAYOUT_KEY, 'tabs')
    route({ debtDetail: () => json(DETAIL) })
    const w = await mountSection()
    await w.get('[data-testid="budget-tab-debts"]').trigger('click')
    w.findComponent(DebtPanel).vm.$emit('drill', 'acct-1')
    await flushPromises()
    expect(w.get('[data-pane="debts"]').classes()).toContain('active')
    expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(true)
    localStorage.clear()
  })
})

describe('BudgetSection: remembers where you left off (saved view per login)', () => {
  let stored: SavedView | null
  let puts: Array<{ view: SavedView; keepalive: boolean | undefined }>
  let viewLegacy = false // the server says the stored block is a 0.82.0 one that hid nothing
  const prefs = (init: RequestInit | undefined) => {
    if (init?.method === 'PUT') {
      const view = (JSON.parse(String(init.body)) as { view: SavedView }).view
      stored = view
      puts.push({ view, keepalive: init.keepalive })
      return json({ ok: true })
    }
    return json({ view: stored, ...(viewLegacy ? { viewLegacy: true } : {}) })
  }
  const saved = (over: Partial<SavedView>): SavedView => ({ ...defaultSavedView(), ...over })
  const summaryParams = (i: number) => new URL(callsTo('/api/budget/summary')[i][0], 'http://x').searchParams
  const MERCHANTS: SummaryResponse = { level: 'merchant', slices: [{ key: 'store-one', label: 'Store One', netCents: 9000, count: 2 }], totalCents: 9000, reviewCount: 0 }
  const byLevel = (u: URL) => json(u.searchParams.has('category') ? MERCHANTS : SUMMARY)

  beforeEach(() => {
    localStorage.clear()
    stored = null
    viewLegacy = false
    puts = []
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    while (mounted.length) mounted.pop()!.unmount()
    vi.useRealTimers()
    localStorage.clear()
  })

  it('a plain open puts the saved view back: tab, range, person and drill, with one summary fetch', async () => {
    stored = saved({ tab: 'spending', person: 'p1', range: { preset: 'last-month' }, path: [{ level: 'category', key: 'groceries', label: 'Groceries' }] })
    route({ prefs, summary: byLevel })
    const w = await mountSection()
    expect(w.get('[data-pane="debts"]').classes()).not.toContain('active')
    expect(w.get('[data-testid="budget-tab-spending"]').attributes('aria-selected')).toBe('true')
    expect(callsTo('/api/budget/summary')).toHaveLength(1)
    const q = summaryParams(0)
    expect([q.get('category'), q.get('person'), q.get('from'), q.get('to')]).toEqual(['groceries', 'p1', '2026-10-01', '2026-10-31'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(puts).toHaveLength(0) // nothing changed: nothing to save
  })

  it('the toolbar waits for the saved view, so a choice made while it is pending cannot be overwritten', async () => {
    stored = saved({ tab: 'spending', person: 'p1' })
    let release: (r: Response) => void = () => {}
    const gate = new Promise<Response>((resolve) => {
      release = resolve
    })
    route({ prefs: (init) => (init?.method === 'PUT' ? prefs(init) : gate) })
    const w = await mountSection()
    expect(w.find('[data-testid="budget-person-p2"]').exists()).toBe(false) // nothing to click yet
    expect(callsTo('/api/budget/summary')).toHaveLength(0)
    release(json({ view: stored }))
    await flushPromises()
    expect(w.find('[data-testid="budget-person-p2"]').exists()).toBe(true)
    expect(w.get('[data-pane="debts"]').classes()).not.toContain('active')
    expect(summaryParams(0).get('person')).toBe('p1')
  })

  it('restores the second drill step and an open debt once their data is there', async () => {
    stored = saved({
      path: [{ level: 'category', key: 'groceries', label: 'Groceries' }, { level: 'merchant', key: 'store-one', label: 'Store One' }],
      debt: 'acct-1',
    })
    route({ prefs, summary: byLevel, debtDetail: () => json({ account: META.accounts[0], history: [], periods: [], payments: [], terms: null, latest: null, promos: [] }) })
    const w = await mountSection()
    const last = summaryParams(callsTo('/api/budget/summary').length - 1)
    expect([last.get('category'), last.get('merchant')]).toEqual(['groceries', 'store-one'])
    expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(true)
  })

  it('a link wins over the saved view (a link with no b_tab opens on the width\'s default tab, Both here)', async () => {
    stored = saved({ tab: 'spending', person: 'p1', path: [{ level: 'category', key: 'groceries', label: 'Groceries' }] })
    route({ prefs, summary: byLevel })
    const w = await mountSection('/?section=budget&b_person=p2&b_from=2026-10-01&b_to=2026-10-31')
    const q = summaryParams(0)
    expect([q.get('person'), q.get('category'), q.get('from')]).toEqual(['p2', null, '2026-10-01'])
    expect(w.get('[data-testid="budget-tab-both"]').attributes('aria-selected')).toBe('true')
    await vi.advanceTimersByTimeAsync(2000)
    expect(puts.at(-1)!.view).toMatchObject({ person: 'p2', path: [], range: { preset: 'last-month' } })
  })

  it('Back/Forward state wins over the saved view', async () => {
    stored = saved({ path: [{ level: 'category', key: 'groceries', label: 'Groceries' }] })
    route({ prefs, summary: byLevel })
    await mountSection('/?section=budget', { gssBudgetDrill: { s: 'earlier-visit', d: 0 } })
    expect(summaryParams(0).has('category')).toBe(false)
  })

  it('stale parts fall back quietly: a deleted category goes to the top, an unknown debt to the pie, an unknown second step is dropped', async () => {
    stored = saved({ person: 'gone', path: [{ level: 'category', key: 'deleted', label: 'Deleted' }], debt: 'no-such-debt' })
    route({ prefs, summary: byLevel })
    const w = await mountSection()
    const q = summaryParams(0)
    expect([q.get('category'), q.get('person')]).toEqual([null, 'all'])
    expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(false)
    expect(w.find('[data-testid="debt-total"]').exists()).toBe(true)
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })

  it('a second step that is not among the first level\'s slices is dropped, the first stays', async () => {
    stored = saved({ path: [{ level: 'category', key: 'groceries', label: 'Groceries' }, { level: 'merchant', key: 'gone-store', label: 'Gone' }] })
    route({ prefs, summary: byLevel })
    await mountSection()
    const last = summaryParams(callsTo('/api/budget/summary').length - 1)
    expect([last.get('category'), last.get('merchant')]).toEqual(['groceries', null])
  })

  it('migrates the old per-device Show choice once: nothing saved on the server, so one write; then no more', async () => {
    localStorage.setItem(panelsKey('a@example.com'), JSON.stringify({ hidden: ['spending'] }))
    route({ prefs })
    const w = await mountSection()
    expect(w.get('[data-testid="budget-tab-debts"]').attributes('aria-selected')).toBe('true')
    expect(w.get('[data-pane="debts"]').classes()).toContain('active')
    expect(w.get('[data-pane="spending"]').classes()).not.toContain('active')
    expect(localStorage.getItem(panelsKey('a@example.com'))).toBeNull() // read once, then gone
    expect(puts).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2000)
    expect(puts).toHaveLength(1)
    expect(puts[0].view).toMatchObject({ tab: 'debts', person: 'all', path: [] })
    expect('hidden' in puts[0].view).toBe(false)
    await vi.advanceTimersByTimeAsync(10000)
    expect(puts).toHaveLength(1)
  })

  describe('the old Side by side / Show choices carry over once', () => {
    const SIDE = () => localStorage.setItem(LAYOUT_KEY, 'side')

    it('Side by side over a 0.82.0 view that hid nothing lands on Both, with one write and the old key gone', async () => {
      SIDE()
      stored = saved({ tab: 'debts' })
      viewLegacy = true
      route({ prefs })
      const w = await mountSection()
      expect(w.get('[data-testid="budget-tab-both"]').attributes('aria-selected')).toBe('true')
      expect(w.get('[data-pane="spending"]').classes()).toContain('active')
      expect(w.get('[data-pane="debts"]').classes()).toContain('active')
      expect(localStorage.getItem(LAYOUT_KEY)).toBeNull()
      await vi.advanceTimersByTimeAsync(2000)
      expect(puts).toHaveLength(1)
      expect(puts[0].view.tab).toBe('both')
      await vi.advanceTimersByTimeAsync(10000)
      expect(puts).toHaveLength(1)
    })

    it('Tabs layout over that same legacy view keeps the saved tab and writes nothing', async () => {
      localStorage.setItem(LAYOUT_KEY, 'tabs')
      stored = saved({ tab: 'debts' })
      viewLegacy = true
      route({ prefs })
      const w = await mountSection()
      expect(w.get('[data-testid="budget-tab-debts"]').attributes('aria-selected')).toBe('true')
      await vi.advanceTimersByTimeAsync(5000)
      expect(puts).toHaveLength(0)
    })

    it('a legacy view that hid a chart (the server folded it into its single tab) keeps that tab even on Side by side', async () => {
      SIDE()
      stored = saved({ tab: 'spending' }) // viewLegacy stays false: only hidden:null blocks carry the flag
      route({ prefs })
      const w = await mountSection()
      expect(w.get('[data-testid="budget-tab-spending"]').attributes('aria-selected')).toBe('true')
      expect(w.get('[data-pane="debts"]').classes()).not.toContain('active')
      await vi.advanceTimersByTimeAsync(5000)
      expect(puts).toHaveLength(0)
    })

    it('a new view (no legacy flag) keeps its saved tab over Side by side', async () => {
      SIDE()
      stored = saved({ tab: 'debts' })
      route({ prefs })
      const w = await mountSection()
      expect(w.get('[data-testid="budget-tab-debts"]').attributes('aria-selected')).toBe('true')
      await vi.advanceTimersByTimeAsync(5000)
      expect(puts).toHaveLength(0)
    })

    it('a b_tab link beats the Side by side carry-over', async () => {
      SIDE()
      stored = saved({ tab: 'debts' })
      viewLegacy = true
      route({ prefs })
      const w = await mountSection('/?section=budget&b_tab=spending')
      expect(w.get('[data-testid="budget-tab-spending"]').attributes('aria-selected')).toBe('true')
      expect(w.get('[data-pane="debts"]').classes()).not.toContain('active')
    })

    it('Side by side with nothing saved lands on Both (the wide default, so nothing to write) and removes the old key', async () => {
      SIDE()
      route({ prefs })
      const w = await mountSection()
      expect(w.get('[data-testid="budget-tab-both"]').attributes('aria-selected')).toBe('true')
      expect(localStorage.getItem(LAYOUT_KEY)).toBeNull()
      await vi.advanceTimersByTimeAsync(5000)
      expect(puts).toHaveLength(0)
    })
  })

  it('nothing hidden and nothing changed: no write at all', async () => {
    route({ prefs })
    await mountSection()
    await vi.advanceTimersByTimeAsync(10000)
    expect(puts).toHaveLength(0)
  })

  it('a change is saved after a quiet two seconds, as one write', async () => {
    stored = saved({})
    route({ prefs })
    const w = await mountSection()
    await w.get('[data-testid="budget-person-p2"]').trigger('click')
    await w.get('[data-testid="budget-tab-debts"]').trigger('click')
    await vi.advanceTimersByTimeAsync(1900)
    expect(puts).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(puts).toHaveLength(1)
    expect(puts[0].view).toMatchObject({ person: 'p2', tab: 'debts' })
  })

  it('leaving the page (pagehide) sends a queued change now, kept alive', async () => {
    stored = saved({})
    route({ prefs })
    const w = await mountSection()
    await w.get('[data-testid="budget-person-p2"]').trigger('click')
    expect(puts).toHaveLength(0)
    window.dispatchEvent(new Event('pagehide'))
    await flushPromises()
    expect(puts).toHaveLength(1)
    expect(puts[0].keepalive).toBe(true)
    expect(puts[0].view.person).toBe('p2')
    w.unmount()
    mounted.pop()
    expect(puts).toHaveLength(1) // nothing left queued
  })

  it('unmounting flushes a queued change', async () => {
    stored = saved({})
    route({ prefs })
    const w = await mountSection()
    await w.get('[data-testid="budget-person-p2"]').trigger('click')
    w.unmount()
    mounted.pop()
    await flushPromises()
    expect(puts).toHaveLength(1)
    expect(puts[0].view.person).toBe('p2')
  })

  it('a server that never answers does not hold the page: data loads after three seconds, nothing is overwritten', async () => {
    route({ prefs: () => new Promise<Response>(() => {}) })
    const w = mount(BudgetSection, { props: { dark: false, today: TODAY }, attachTo: document.body })
    mounted.push(w)
    await flushPromises()
    expect(callsTo('/api/budget/summary')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(callsTo('/api/budget/summary')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10000)
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(0)
  })
})

describe('BudgetSection: one breadcrumb trail, in the drill and on the loan page', () => {
  const DETAIL = {
    account: META.accounts[0],
    history: [{ asOf: '2026-10-31', balanceCents: 90000, source: 'statement', aprBp: 1999 }],
    periods: [], payments: [], terms: null, latest: null, promos: [],
  }
  const LOANS = { months: [], debts: DEBTS.map((d) => ({ ...d, terms: null, latest: null, promos: [], payments: [] })) }
  const NAME = 'Card A ••0001'
  // Timers are fake (setTimeout only), so no real clock decides: the stub's traversal fires its popstate on a timer, then the
  // section's settle timers; each is advanced by hand.
  const go = async (fn: () => void) => {
    fn()
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
  }
  const trailOf = (w: VueWrapper) => w.findAll('[data-testid="crumbs"] .cr-item').map((i) => i.text().replace('›', '').trim())
  const trail = (w: VueWrapper) => trailOf(w.findComponent(LoansPage) as unknown as VueWrapper)
  const here = (w: VueWrapper) => w.find('[aria-current="page"]').text()
  const noPersonalData = () => expect(location.href).not.toMatch(/acct-1|Card|0001/)
  async function openFromDrill(w: VueWrapper) {
    w.findComponent(DebtPanel).vm.$emit('drill', 'acct-1')
    await flushPromises()
    await w.get('[data-testid="debt-drilled-open"]').trigger('click')
    await flushPromises()
  }
  // Back and Forward walk a real entry list (happy-dom's history does not: see the helper).
  let stub: HistoryStub
  beforeEach(() => {
    sessionStorage.clear()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    route({ debtDetail: () => json(DETAIL), loans: () => json(LOANS) })
    stub = installHistoryStub()
  })
  afterEach(() => {
    stub.restore()
    vi.useRealTimers()
  })

  it('pie > drill > the All debts crumb back; Back and Forward match', async () => {
    const w = await mountSection()
    w.findComponent(DebtPanel).vm.$emit('drill', 'acct-1')
    await flushPromises()
    await w.get('[data-testid="crumb-0"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(false)
    await go(() => history.forward()) // Forward re-opens the debt the crumb left
    expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(true)
    await go(() => history.back())
    expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(false)
    noPersonalData()
  })

  it('drill > Loan details: the trail is All debts > name > Loan details, with no personal data in the address', async () => {
    const w = await mountSection()
    await openFromDrill(w)
    expect(trail(w)).toEqual(['All debts', NAME, 'Loan details'])
    expect(here(w)).toBe('Loan details')
    expect(w.text()).not.toContain('← Loans')
    noPersonalData()
  })

  it('drill > Loan details > the name crumb lands on that debt open; Back and Forward match', async () => {
    const w = await mountSection()
    await openFromDrill(w)
    await go(() => w.get('[data-testid="crumb-1"]').trigger('click'))
    expect(w.findComponent(LoansPage).exists()).toBe(false)
    expect(w.findComponent(DebtPanel).props('selected')).toMatchObject({ accountId: 'acct-1' })
    expect(new URLSearchParams(location.search).get('b_page')).toBeNull()
    await go(() => history.forward()) // the detail page again, same trail
    expect(trail(w)).toEqual(['All debts', NAME, 'Loan details'])
    await go(() => history.back())
    expect(w.findComponent(DebtPanel).props('selected')).toMatchObject({ accountId: 'acct-1' })
    noPersonalData()
  })

  it('drill > Loan details > All debts lands on the debt list with no debt open; Back and Forward match', async () => {
    const w = await mountSection()
    await openFromDrill(w)
    await go(() => w.get('[data-testid="crumb-0"]').trigger('click'))
    expect(w.findComponent(LoansPage).exists()).toBe(false)
    expect(w.findComponent(DebtPanel).props('selected')).toBeNull()
    expect(w.find('[data-testid="debt-drilled"]').exists()).toBe(false)
    await go(() => history.forward()) // the debt, as it was one step in
    expect(w.findComponent(DebtPanel).props('selected')).toMatchObject({ accountId: 'acct-1' })
    await go(() => history.forward()) // and the detail page
    expect(trail(w)).toEqual(['All debts', NAME, 'Loan details'])
    noPersonalData()
  })

  it('a Details button of the debt list (no drill) gives All debts > name, and All debts goes back to the list', async () => {
    const w = await mountSection()
    w.findComponent(DebtPanel).vm.$emit('open', 'acct-1')
    await flushPromises()
    expect(trail(w)).toEqual(['All debts', NAME])
    await go(() => w.get('[data-testid="crumb-0"]').trigger('click'))
    expect(w.findComponent(LoansPage).exists()).toBe(false)
    expect(w.findComponent(DebtPanel).props('selected')).toBeNull()
  })

  it('Loans list > detail: Loans > name; the Loans crumb returns to the list; Back and Forward match', async () => {
    const w = await mountSection('/?section=budget&b_page=loans')
    w.findComponent(LoansList).vm.$emit('open', 'acct-1')
    await flushPromises()
    expect(trail(w)).toEqual(['Loans', NAME])
    expect(here(w)).toBe(NAME)
    await go(() => w.get('[data-testid="crumb-0"]').trigger('click'))
    expect(w.findComponent(LoansPage).props('loanId')).toBeNull()
    expect(w.find('[data-testid="crumbs"]').exists()).toBe(false)
    await go(() => history.forward())
    expect(w.findComponent(LoansPage).props('loanId')).toBe('acct-1')
    expect(trail(w)).toEqual(['Loans', NAME])
    await go(() => history.back())
    expect(w.findComponent(LoansPage).props('loanId')).toBeNull()
    noPersonalData()
  })

  it('the header knows where the loan came from: a loan from the drill says so, one from the Loans list does not', async () => {
    let w = await mountSection()
    await openFromDrill(w)
    expect(w.emitted('fromOverview')?.at(-1)).toEqual([true])
    w.unmount()
    mounted.pop()
    w = await mountSection('/?section=budget&b_page=loans')
    w.findComponent(LoansList).vm.$emit('open', 'acct-1')
    await flushPromises()
    expect(w.emitted('fromOverview')?.at(-1)).toEqual([false])
  })

  it('a double click on the All debts crumb goes back once: still on Budget, no debt open', async () => {
    const w = await mountSection()
    await openFromDrill(w)
    const back = vi.spyOn(history, 'back')
    const crumb = w.get('[data-testid="crumb-0"]')
    const first = crumb.trigger('click')
    const second = crumb.trigger('click') // before the first Back has landed
    await Promise.all([first, second])
    await go(() => {})
    await vi.advanceTimersByTimeAsync(1100) // past the lock: nothing queued a second Back
    await flushPromises()
    expect(w.findComponent(LoansPage).exists()).toBe(false)
    expect(w.findComponent(DebtPanel).props('selected')).toBeNull()
    expect(new URLSearchParams(location.search).get('section')).toBe('budget')
    // two clicks, one history.back() (the lock holds); the debt close is its own step, not another crumb Back
    expect(back).toHaveBeenCalledTimes(1)
    expect(stub.index).toBe(0)
    back.mockRestore()
  })

  it('a reload keeps the trail: the drill origin and the Loans origin each come back as they were; Back and Forward after it match', async () => {
    let w = await mountSection()
    await openFromDrill(w)
    const keptUrl = location.pathname + location.search
    const keptState = history.state
    w.unmount()
    mounted.pop()
    w = await mountSection(keptUrl, keptState)
    expect(trail(w)).toEqual(['All debts', NAME, 'Loan details'])
    await go(() => history.back())
    expect(w.findComponent(LoansPage).exists()).toBe(false)
    expect(new URLSearchParams(location.search).get('section')).toBe('budget')
    await go(() => history.forward())
    expect(trail(w)).toEqual(['All debts', NAME, 'Loan details'])
    w.unmount()
    mounted.pop()

    w = await mountSection('/?section=budget&b_page=loans')
    w.findComponent(LoansList).vm.$emit('open', 'acct-1')
    await flushPromises()
    const loansUrl = location.pathname + location.search
    const loansState = history.state
    w.unmount()
    mounted.pop()
    w = await mountSection(loansUrl, loansState)
    expect(trail(w)).toEqual(['Loans', NAME])
    await go(() => history.back())
    expect(w.findComponent(LoansPage).props('loanId')).toBeNull()
    await go(() => history.forward())
    expect(trail(w)).toEqual(['Loans', NAME])
    noPersonalData()
  })

  it('a deep link names no loan (no account id in an address), so it shows the Loans list; with its entry state it shows the Loans trail', async () => {
    let w = await mountSection('/?section=budget&b_page=loans')
    expect(w.findComponent(LoansPage).props('loanId')).toBeNull()
    expect(w.find('[data-testid="crumbs"]').exists()).toBe(false)
    w.findComponent(LoansList).vm.$emit('open', 'acct-1')
    await flushPromises()
    const state = history.state
    w.unmount()
    mounted.pop()
    w = await mountSection('/?section=budget&b_page=loans', state)
    expect(trail(w)).toEqual(['Loans', NAME])
    const at = stub.index
    await go(() => history.back()) // the deep link is the first entry of this visit: Back leaves it cleanly
    expect(stub.index).toBeLessThanOrEqual(at)
    await go(() => history.forward())
    expect(stub.index).toBeLessThanOrEqual(stub.entries.length - 1)
  })

  it('the crumbs are native buttons: focus reaches them, and activating one (what Enter and Space do) goes there', async () => {
    const w = await mountSection()
    await openFromDrill(w)
    const buttons = w.findAll('[data-testid="crumbs"] button')
    expect(buttons.map((b) => b.text())).toEqual(['All debts', NAME])
    ;(buttons[1].element as HTMLButtonElement).focus()
    expect(document.activeElement).toBe(buttons[1].element)
    await go(() => (document.activeElement as HTMLButtonElement).click())
    expect(w.findComponent(LoansPage).exists()).toBe(false)
    expect(w.findComponent(DebtPanel).props('selected')).toMatchObject({ accountId: 'acct-1' })
  })
})
