// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./DebtDetail.vue', () => ({
  default: {
    name: 'DebtDetail',
    props: ['accountId', 'canEdit', 'dark', 'hideBack'],
    emits: ['close', 'saved'],
    template: '<div data-testid="debt-detail" :data-id="accountId"><button data-testid="dd-save" @click="$emit(\'saved\')">s</button></div>',
  },
}))
import LoansPage from './LoansPage.vue'

describe('LoansPage', () => {
  it('shows the Loans shell when no loan is open', () => {
    const w = mount(LoansPage, { props: { person: null, loanId: null } })
    expect(w.find('h2').text()).toBe('Loans')
    expect(w.find('[data-testid="loans-placeholder"]').exists()).toBe(true)
    expect(w.find('[data-testid="debt-detail"]').exists()).toBe(false)
    expect(w.attributes('data-person')).toBe('all')
  })
  it('shows the open loan with a back button that emits close', async () => {
    const w = mount(LoansPage, { props: { person: 'p1', loanId: 'acct-1', canEdit: true } })
    await flushPromises()
    expect(w.find('[data-testid="debt-detail"]').attributes('data-id')).toBe('acct-1')
    expect(w.attributes('data-person')).toBe('p1')
    await w.find('[data-testid="loans-back"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
  it('passes a saved edit up', async () => {
    const w = mount(LoansPage, { props: { person: null, loanId: 'acct-1' } })
    await w.find('[data-testid="dd-save"]').trigger('click')
    expect(w.emitted('saved')).toHaveLength(1)
  })
})
