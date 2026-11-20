// budgetAccess.ts helpers: the no-store stamp and the one-time empty-list warning. The access
// matrix itself is functions/api/budget/access.test.ts and functions/_lib/auth.budget.test.ts.
import { describe, expect, it, vi } from 'vitest'
import { authorizeBudget, budgetJson, noStore } from './budgetAccess'

describe('noStore', () => {
  it('replaces Cache-Control and adds Cookie to Vary without dropping the rest', async () => {
    const res = noStore(new Response('hi', { status: 201, headers: { 'Cache-Control': 'public', Vary: 'Origin, Accept', 'X-Keep': '1' } }))
    expect(res.status).toBe(201)
    expect(await res.text()).toBe('hi')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Vary')).toBe('Origin, Accept, Cookie')
    expect(res.headers.get('X-Keep')).toBe('1')
  })
  it('does not repeat Cookie, and leaves Vary: * alone', () => {
    expect(noStore(new Response('', { headers: { Vary: 'cookie' } })).headers.get('Vary')).toBe('cookie')
    expect(noStore(new Response('', { headers: { Vary: '*' } })).headers.get('Vary')).toBe('*')
  })
})

describe('budgetJson', () => {
  it('is JSON, no-store and varies on Cookie', async () => {
    const res = budgetJson(404, { error: 'not_found' }, { Allow: 'GET' })
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Allow')).toBe('GET')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('Vary')).toBe('Cookie')
    expect(await res.json()).toEqual({ error: 'not_found' })
  })
})

describe('authorizeBudget', () => {
  it('logs the empty list once, and never logs an email', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 0; i < 3; i++) {
      const r = await authorizeBudget(new Request('https://stats.goodstuff.software/api/budget/access'), {})
      expect(r.ok).toBe(false)
    }
    expect(err.mock.calls.length).toBeLessThanOrEqual(1)
    err.mockRestore()
  })
})
