// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent } from 'vue'
import type { DebtDetail as DebtDetailData } from '../../lib/budget/types'
import { todayIso } from '../../lib/budget/viewState'
import DebtDetail from './DebtDetail.vue'

vi.mock('../../session', () => ({ checkSessionExpired: vi.fn(async () => {}) }))

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const DETAIL: DebtDetailData = {
  account: { id: 'acct-9', label: 'Card A', kind: 'card', personId: 'p1', last4: '0001', isDebt: true, inSpending: true, creditLimitCents: 500000, aprBp: null },
  history: [
    { asOf: '2026-09-30', balanceCents: 120000, source: 'statement' },
    { asOf: '2026-10-31', balanceCents: 90000, source: 'statement' },
  ],
  periods: [
    { periodEnd: '2026-09-30', aprBp: 1999, interestCents: 2100, principalPaidCents: 5000, advancesCents: null },
    { periodEnd: '2026-10-31', aprBp: 1999, interestCents: 1800, principalPaidCents: 30000, advancesCents: 0 },
  ],
  payments: [{ id: 'pay-1', postedDate: '2026-10-05', amountCents: 30000, principalCents: 28200, interestCents: 1800 }],
}
const EMPTY: DebtDetailData = {
  account: { ...DETAIL.account, id: 'acct-7', label: 'Loan B', kind: 'external_debt', last4: null, creditLimitCents: null, aprBp: 650 },
  history: [], periods: [], payments: [],
}

const ChartStub = defineComponent({ name: 'BaseChart', props: { config: Object, drillOpen: Boolean }, emits: ['point'], template: '<div class="chart-stub" />' })
let fetchMock: ReturnType<typeof vi.fn>
function route(detail: DebtDetailData | 'fail' = DETAIL, put?: (body: unknown) => Response) {
  fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const u = new URL(input, 'http://x')
    if (u.pathname.endsWith('/balance') && init?.method === 'PUT') return put ? put(JSON.parse(String(init.body))) : json({ ok: true })
    if (u.pathname.startsWith('/api/budget/debts/')) return detail === 'fail' ? json({ error: 'not_found' }, 404) : json(detail)
    throw new Error(`unmocked ${input}`)
  })
  vi.stubGlobal('fetch', fetchMock)
}
const mounted: VueWrapper[] = []
async function mountDetail(props: Partial<{ accountId: string; canEdit: boolean }> = {}) {
  const w = mount(DebtDetail, {
    props: { accountId: 'acct-9', canEdit: true, dark: false, ...props },
    global: { stubs: { BaseChart: ChartStub } },
    attachTo: document.body,
  })
  mounted.push(w)
  await flushPromises()
  return w
}
const puts = () => fetchMock.mock.calls.filter((c) => c[1]?.method === 'PUT')
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.unstubAllGlobals()
})

describe('DebtDetail: what it shows', () => {
  beforeEach(() => route())

  it('loads the debt by id and shows the balance now, the rate (from the newest statement) and the limit', async () => {
    const w = await mountDetail()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/budget/debts/acct-9')
    expect(w.get('h2').text()).toBe('Card A ••0001')
    expect(w.get('[data-testid="debt-balance"]').text()).toBe('$900.00')
    expect(w.text()).toContain('as of Oct 31')
    expect(w.get('[data-testid="debt-rate"]').text()).toBe('19.99% APR')
    expect(w.text()).toContain('$5,000.00')
  })

  it('draws the balance history as a line, oldest first, in dollars', async () => {
    const w = await mountDetail()
    const cfg = w.findComponent(ChartStub).props('config') as any
    expect(cfg.type).toBe('line')
    expect(cfg.data.datasets[0].data).toEqual([1200, 900])
    expect(cfg.data.labels).toHaveLength(2)
  })

  it('lists interest per statement (newest first) and the payments', async () => {
    const w = await mountDetail()
    const text = w.text()
    expect(text).toContain('Interest by statement')
    expect(text).toContain('$18.00')
    expect(text).toContain('$21.00')
    expect(text.indexOf('Oct 31')).toBeLessThan(text.indexOf('Sep 30'))
    expect(text).toContain('$300.00')
    expect(text).toContain('$282.00')
  })

  it('back goes to the debts', async () => {
    const w = await mountDetail()
    await w.get('[data-testid="debt-back"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('a debt with no history says so, keeps its own rate, and has no chart', async () => {
    route(EMPTY)
    const w = await mountDetail({ accountId: 'acct-7' })
    expect(w.get('[data-testid="debt-balance"]').text()).toBe('No balance yet')
    expect(w.get('[data-testid="debt-rate"]').text()).toBe('6.50% APR')
    expect(w.find('[data-testid="debt-chart"]').exists()).toBe(false)
    expect(w.find('[data-testid="debt-no-payments"]').exists()).toBe(true)
  })

  it('a failed load shows a message with Retry that asks again', async () => {
    route('fail')
    const w = await mountDetail()
    expect(w.text()).toContain('Couldn’t load this debt.')
    route()
    await w.get('[data-testid="debt-retry"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-testid="debt-balance"]').text()).toBe('$900.00')
  })
})

describe('DebtDetail: manual balance form', () => {
  beforeEach(() => route(EMPTY))

  async function fill(w: VueWrapper, v: { date?: string; amount?: string; rate?: string }) {
    if (v.date !== undefined) await w.get('[data-testid="bal-date"]').setValue(v.date)
    if (v.amount !== undefined) await w.get('[data-testid="bal-amount"]').setValue(v.amount)
    if (v.rate !== undefined) await w.get('[data-testid="bal-rate"]').setValue(v.rate)
    await w.get('[data-testid="balance-form"]').trigger('submit')
    await flushPromises()
  }

  it('is only there when editing is allowed', async () => {
    expect((await mountDetail({ canEdit: false })).find('[data-testid="balance-form"]').exists()).toBe(false)
    expect((await mountDetail({ canEdit: true })).find('[data-testid="balance-form"]').exists()).toBe(true)
  })

  it('PUTs the typed balance in cents, then reloads, tells the section, and shows what was saved', async () => {
    const w = await mountDetail()
    const loads = fetchMock.mock.calls.length
    await fill(w, { date: '2026-11-01', amount: '$1,250.5', rate: '19.99%' })
    expect(puts()).toHaveLength(1)
    expect(puts()[0][0]).toBe('/api/budget/debts/acct-9/balance'.replace('acct-9', 'acct-9'))
    expect(JSON.parse(puts()[0][1].body)).toEqual({ asOf: '2026-11-01', balanceCents: 125050, aprBp: 1999 })
    expect(w.emitted('saved')).toHaveLength(1)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(loads + 1) // the PUT, then a reload of the detail
    expect(w.get('[data-testid="bal-saved"]').text()).toBe('Saved $1,250.50 as of Nov 1.')
    expect((w.get('[data-testid="bal-amount"]').element as HTMLInputElement).value).toBe('')
  })

  it('the rate is optional: left blank it is not sent; zero balance is allowed', async () => {
    const w = await mountDetail()
    await fill(w, { date: '2026-11-01', amount: '0' })
    expect(JSON.parse(puts()[0][1].body)).toEqual({ asOf: '2026-11-01', balanceCents: 0 })
  })

  it.each([
    ['', 'Enter the balance as dollars'],
    ['abc', 'Enter the balance as dollars'],
    ['-5', 'Enter the balance as dollars'],
    ['12.345', 'Enter the balance as dollars'],
    ['1,23', 'Enter the balance as dollars'],
    ['9999999999', 'Enter the balance as dollars'],
  ])('refuses the balance %j without calling the server', async (amount, msg) => {
    const w = await mountDetail()
    await fill(w, { date: '2026-11-01', amount })
    expect(w.get('[data-testid="bal-error"]').text()).toContain(msg)
    expect(puts()).toHaveLength(0)
    expect(w.emitted('saved')).toBeUndefined()
  })

  it.each(['abc', '101', '-1', '19.999'])('refuses the rate %j', async (rate) => {
    const w = await mountDetail()
    await fill(w, { date: '2026-11-01', amount: '100', rate })
    expect(w.get('[data-testid="bal-error"]').text()).toContain('rate')
    expect(puts()).toHaveLength(0)
  })

  it('refuses a missing, impossible or future date', async () => {
    const w = await mountDetail()
    await fill(w, { date: '', amount: '100' })
    expect(w.get('[data-testid="bal-error"]').text()).toContain('real date')
    await fill(w, { date: '2026-02-30', amount: '100' })
    expect(w.get('[data-testid="bal-error"]').text()).toContain('real date')
    const t = todayIso()
    const next = `${Number(t.slice(0, 4)) + 1}${t.slice(4)}`
    await fill(w, { date: next, amount: '100' })
    expect(w.get('[data-testid="bal-error"]').text()).toContain('future')
    expect(puts()).toHaveLength(0)
  })

  it('a server error keeps what was typed and says so; nothing is announced as saved', async () => {
    route(EMPTY, () => json({ error: 'bad_request' }, 400))
    const w = await mountDetail()
    await fill(w, { date: '2026-11-01', amount: '100' })
    expect(w.get('[data-testid="bal-error"]').text()).toBe('Couldn’t save the balance (400).')
    expect((w.get('[data-testid="bal-amount"]').element as HTMLInputElement).value).toBe('100')
    expect(w.emitted('saved')).toBeUndefined()
    expect(w.find('[data-testid="bal-saved"]').exists()).toBe(false)
  })

  it('a network failure gets its own message', async () => {
    route(EMPTY, () => {
      throw new TypeError('Failed to fetch')
    })
    const w = await mountDetail()
    await fill(w, { date: '2026-11-01', amount: '100' })
    expect(w.get('[data-testid="bal-error"]').text()).toContain('Check your connection')
  })
})
