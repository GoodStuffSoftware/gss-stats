// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

vi.mock('../../session', () => ({ checkSessionExpired: vi.fn(async () => {}) }))
import { checkSessionExpired } from '../../session'
import { resetAccessProbe } from '../../lib/budget/clientRead'
import BudgetNavLink from './BudgetNavLink.vue'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  resetAccessProbe()
  vi.mocked(checkSessionExpired).mockClear()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  history.replaceState(null, '', '/?page=p1')
})
afterEach(() => vi.unstubAllGlobals())

async function mountLink(props: { active?: boolean } = {}) {
  const w = mount(BudgetNavLink, { props })
  await flushPromises()
  return w
}

describe('BudgetNavLink', () => {
  it('shows on 200', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, email: 'a@example.com' }))
    const w = await mountLink()
    expect(w.find('[data-testid="budget-nav-link"]').exists()).toBe(true)
    expect(w.text()).toBe('Budget')
  })

  it.each([
    ['403', () => fetchMock.mockResolvedValue(json({ error: 'budget_denied' }, 403))],
    ['401', () => fetchMock.mockResolvedValue(json({ error: 'unauthorized' }, 401))],
    ['500', () => fetchMock.mockResolvedValue(json({}, 500))],
    ['a network error', () => fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))],
  ])('renders nothing on %s', async (_n, arrange) => {
    arrange()
    const w = await mountLink()
    expect(w.html()).toBe('<!--v-if-->')
  })

  it('401 raises the existing session-expired check', async () => {
    fetchMock.mockResolvedValue(json({}, 401))
    await mountLink()
    expect(checkSessionExpired).toHaveBeenCalledTimes(1)
  })

  it('probes once per load: a second link shares the answer, nothing retries', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    await mountLink()
    await mountLink()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/budget/access')
  })

  it('a plain click emits open; the href keeps other params; active click emits close', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, email: 'a@example.com' }))
    const w = await mountLink()
    const a = w.get('a')
    expect(new URLSearchParams(a.attributes('href')!.split('?')[1])).toEqual(new URLSearchParams('page=p1&section=budget'))
    await a.trigger('click')
    expect(w.emitted('open')).toHaveLength(1)
    await w.setProps({ active: true })
    expect(w.get('a').attributes('aria-current')).toBe('page')
    expect(w.get('a').attributes('href')).not.toContain('section')
    await w.get('a').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('a ctrl-click is left to the browser', async () => {
    fetchMock.mockResolvedValue(json({ ok: true, email: 'a@example.com' }))
    const w = await mountLink()
    await w.get('a').trigger('click', { ctrlKey: true })
    expect(w.emitted('open')).toBeUndefined()
  })
})
