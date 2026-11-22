// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { LoanRow, LoansResponse } from '../../lib/budget/types'
import { addDays } from '../../lib/budget/dates'
import { todayIso } from '../../lib/budget/viewState'
import LoansList from './LoansList.vue'

const base = (o: Partial<LoanRow>): LoanRow => ({
  accountId: 'x', label: 'X', kind: 'loan', last4: null, personId: 'p1', balanceCents: null, asOf: null, source: null,
  aprBp: null, creditLimitCents: null, terms: null, latest: null, promos: [], payments: [], ...o,
})
const terms = (o: object) => ({ accountId: 'x', originalCents: null, openedOn: null, maturityOn: null, termMonths: null,
  paymentCents: null, paymentEvery: null, cosigned: false, updatedAt: '', updatedBy: '', ...o })
const soon = addDays(todayIso(), 20)
const DATA: LoansResponse = {
  months: ['2026-08', '2026-09', '2026-10'],
  debts: [
    base({ accountId: 'car', label: 'Car loan', last4: '1111', balanceCents: 1_000_000, asOf: '2026-10-31', aprBp: 600,
      terms: terms({ paymentCents: 50_000, paymentEvery: 'monthly' }), latest: { periodEnd: '2026-10-31', minDueCents: 50_000, dueDate: '2026-11-15', payoffCents: null, escrowCents: null, interestCents: 5000 } }),
    base({ accountId: 'line', label: 'HELOC', kind: 'line_of_credit', balanceCents: 500_000, asOf: '2026-10-31', aprBp: 800,
      payments: [{ month: '2026-08', amountCents: 20_000 }, { month: '2026-09', amountCents: 20_000 }, { month: '2026-10', amountCents: 20_000 }] }),
    base({ accountId: 'co', label: 'Cosigned loan', balanceCents: 300_000, asOf: '2026-10-31', aprBp: 500, terms: terms({ cosigned: true, paymentCents: 10_000, paymentEvery: 'monthly' }) }),
    base({ accountId: 'nobal', label: 'Mystery loan' }),
    base({ accountId: 'visa', label: 'Visa', kind: 'card', last4: '2222', balanceCents: 100_000, asOf: '2026-10-31', aprBp: 2000,
      terms: terms({ paymentCents: 1000, paymentEvery: 'monthly' }),
      promos: [{ accountId: 'visa', periodEnd: '2026-10-31', seq: 1, balanceCents: 50_000, aprBp: 0, endsOn: soon, deferredInterestCents: null }] }),
  ],
}
function mountIt(props: { data?: LoansResponse | null; loading?: boolean; failed?: boolean } = {}) {
  return mount(LoansList, { props: { data: DATA, loading: false, failed: false, ...props } })
}

describe('LoansList', () => {
  it('shows facts without cosigned in the total', () => {
    const w = mountIt()
    expect(w.get('[data-testid=fact-owed]').text()).toBe('$16,000.00') // 10,000 + 5,000 + 1,000
    expect(w.get('[data-testid=fact-cosigned]').text()).toBe('+ $3,000.00 cosigned')
    expect(w.get('[data-testid=fact-missing]').text()).toBe('1 debt without a balance')
    expect(w.get('[data-testid=fact-payments]').text()).toBe('$710.00') // 500 + 200 + 10
    expect(w.get('[data-testid=fact-last]').text()).toMatch(/^[A-Z][a-z]{2} \d{4}$/)
  })
  it('groups Loans then Cards and shows dashes for missing values', () => {
    const w = mountIt()
    const groups = w.findAll('section.ll-group')
    expect(groups.map((g) => g.attributes('data-testid'))).toEqual(['group-loans', 'group-cards'])
    const mystery = w.get('[data-row-key=nobal]').text()
    expect(mystery).toContain('Mystery loan')
    expect(mystery).toContain('—')
    expect(w.get('[data-testid=group-cards]').text()).toContain('Visa ••2222')
    expect(w.get('[data-testid=group-loans]').text()).not.toContain('Visa')
  })
  it('labels the payment source, flags open-end draws and the cosigned badge', () => {
    const w = mountIt()
    expect(w.get('[data-row-key=car]').text()).toContain('(scheduled)')
    expect(w.get('[data-row-key=line]').text()).toContain('(from payments)')
    expect(w.get('[data-row-key=line]').text()).toContain('new draws not counted')
    expect(w.get('[data-row-key=co]').find('[data-testid=cosigned-badge]').exists()).toBe(true)
  })
  it('says when the payment does not beat the interest', () => {
    const w = mountIt()
    expect(w.get('[data-row-key=visa]').text()).toContain('Not paid off at this payment')
  })
  it('marks a promo ending within 60 days', () => {
    const w = mountIt()
    expect(w.get('[data-row-key=visa]').find('[data-testid=promo-soon]').exists()).toBe(true)
    expect(w.get('[data-row-key=car]').find('[data-testid=promo-soon]').exists()).toBe(false)
  })
  it('emits open on a row click and on the name button, once each', async () => {
    const w = mountIt()
    await w.get('[data-row-key=car]').trigger('click')
    await w.get('[data-row-key=visa] button.ll-open').trigger('click')
    expect(w.emitted('open')).toEqual([['car'], ['visa']])
  })
  it('shows a skeleton while loading, and Retry (emitting retry) on failure', async () => {
    expect(mountIt({ data: null, loading: true }).find('[aria-busy=true]').exists()).toBe(true)
    const w = mountIt({ data: null, failed: true })
    await w.get('[data-testid=loans-retry]').trigger('click')
    expect(w.emitted('retry')).toHaveLength(1)
  })
})
