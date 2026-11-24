// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LoanRow, LoansResponse } from '../../lib/budget/types'

vi.mock('../../session', () => ({ checkSessionExpired: vi.fn(async () => {}) }))
vi.mock('./DebtDetail.vue', () => ({
  default: {
    name: 'DebtDetail',
    props: { accountId: String, canEdit: Boolean, dark: Boolean, hideBack: Boolean, recentPaymentsCents: Array },
    emits: ['close', 'saved'],
    template: '<div data-testid="debt-detail" :data-id="accountId"><button data-testid="dd-save" @click="$emit(\'saved\')">s</button></div>',
  },
}))
import DebtDetail from './DebtDetail.vue'
import LoansList from './LoansList.vue'
import LoansPage from './LoansPage.vue'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const row = (o: Partial<LoanRow>): LoanRow => ({
  accountId: 'x', label: 'X', kind: 'loan', last4: null, personId: 'p1', balanceCents: null, asOf: null, source: null,
  aprBp: null, creditLimitCents: null, terms: null, latest: null, promos: [], payments: [], ...o,
})
const DATA: LoansResponse = {
  months: ['2026-08', '2026-09', '2026-10'],
  debts: [
    row({ accountId: 'acct-1', label: 'Car loan', balanceCents: 100_000, payments: [
      { month: '2026-08', amountCents: 10_000 }, { month: '2026-09', amountCents: 20_000 }, { month: '2026-10', amountCents: 30_000 }] }),
    row({ accountId: 'acct-2', label: 'Other loan' }),
  ],
}
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async () => json(DATA))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('LoansPage', () => {
  it('shows the Loans list (one /loans call) when no loan is open, and passes open up', async () => {
    const w = mount(LoansPage, { props: { person: null, loanId: null } })
    await flushPromises()
    expect(w.find('h2').text()).toBe('Loans')
    expect(w.find('[data-testid="debt-detail"]').exists()).toBe(false)
    expect(w.attributes('data-person')).toBe('all')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/budget/loans?person=all')
    expect(w.findAll('[data-row-key]').length).toBeGreaterThan(0)
    w.findComponent(LoansList).vm.$emit('open', 'acct-2')
    expect(w.emitted('open')).toEqual([['acct-2']])
  })
  it('refetches for another person, and Retry asks again after a failure', async () => {
    const w = mount(LoansPage, { props: { person: null, loanId: null } })
    await flushPromises()
    fetchMock.mockImplementation(async () => json({ error: 'x' }, 500))
    await w.setProps({ person: 'p2' })
    await flushPromises()
    expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/budget/loans?person=p2')
    expect(w.find('[data-testid=loans-retry]').exists()).toBe(true)
    fetchMock.mockImplementation(async () => json(DATA))
    await w.get('[data-testid=loans-retry]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid=loans-retry]').exists()).toBe(false)
  })
  it('shows the open loan with the Loans trail whose first crumb emits close, and hands it its recent payment totals', async () => {
    const w = mount(LoansPage, { props: { person: 'p1', loanId: 'acct-1', canEdit: true } })
    await flushPromises()
    expect(w.find('[data-testid="debt-detail"]').attributes('data-id')).toBe('acct-1')
    expect(w.findComponent(DebtDetail).props()).toMatchObject({ hideBack: true, recentPaymentsCents: [10_000, 20_000, 30_000] })
    expect(w.attributes('data-person')).toBe('p1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(w.get('[data-testid="crumbs"]').attributes('aria-label')).toBe('Loan path')
    expect(w.findAll('.cr-item').map((i) => i.text())).toEqual(['Loans', '›Car loan'])
    expect(w.get('[aria-current="page"]').text()).toBe('Car loan')
    expect(w.text()).not.toContain('← Loans')
    await w.get('[data-testid="crumb-0"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    expect(w.emitted('leave')).toBeUndefined()
  })
  it('names the loan with its last 4 digits, and shows "Loan" until the list has loaded', async () => {
    fetchMock.mockImplementation(async () => json({ ...DATA, debts: [row({ accountId: 'acct-1', label: 'Home loan', last4: '1234' })] }))
    const w = mount(LoansPage, { props: { person: null, loanId: 'acct-1' } })
    expect(w.get('[aria-current="page"]').text()).toBe('Loan')
    await flushPromises()
    expect(w.get('[aria-current="page"]').text()).toBe('Home loan ••1234')
  })
  it('opened from the debt drill: All debts > name > Loan details; All debts leaves to the debt list, the name to the drill', async () => {
    const w = mount(LoansPage, { props: { person: null, loanId: 'acct-1', from: 'drill' } })
    await flushPromises()
    expect(w.findAll('.cr-item').map((i) => i.text())).toEqual(['All debts', '›Car loan', '›Loan details'])
    expect(w.get('[aria-current="page"]').text()).toBe('Loan details')
    await w.get('[data-testid="crumb-0"]').trigger('click')
    await w.get('[data-testid="crumb-1"]').trigger('click')
    expect(w.emitted('leave')).toEqual([[true], [false]])
    expect(w.emitted('close')).toBeUndefined()
  })
  it('opened from a Details button of the debt list: All debts > name, back to the debt list', async () => {
    const w = mount(LoansPage, { props: { person: null, loanId: 'acct-1', from: 'debts' } })
    await flushPromises()
    expect(w.findAll('.cr-item').map((i) => i.text())).toEqual(['All debts', '›Car loan'])
    await w.get('[data-testid="crumb-0"]').trigger('click')
    expect(w.emitted('leave')).toEqual([[false]])
  })
  it('every earlier crumb is a native button the keyboard can focus (no tabindex or key handler: the browser clicks a button on Enter and Space)', async () => {
    const w = mount(LoansPage, { props: { person: null, loanId: 'acct-1', from: 'drill' }, attachTo: document.body })
    await flushPromises()
    const buttons = w.findAll('.cr-item button')
    expect(buttons).toHaveLength(2)
    for (const b of buttons) {
      expect(b.element.tagName).toBe('BUTTON')
      expect(b.attributes('type')).toBe('button')
      expect(b.attributes('tabindex')).toBeUndefined()
    }
    ;(buttons[1].element as HTMLButtonElement).focus()
    expect(document.activeElement).toBe(buttons[1].element)
    w.unmount()
  })
  it('passes a saved edit up and reloads the loans', async () => {
    const w = mount(LoansPage, { props: { person: null, loanId: 'acct-1' } })
    await flushPromises()
    await w.find('[data-testid="dd-save"]').trigger('click')
    await flushPromises()
    expect(w.emitted('saved')).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
