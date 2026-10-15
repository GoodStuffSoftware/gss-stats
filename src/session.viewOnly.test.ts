// @vitest-environment happy-dom
//
// GET /auth/me's `role` drives the view-only UI (src/lib/viewOnly.ts): only an explicit
// "viewer" turns the edit controls off; "owner", no role, or no answer leaves them on.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadIdentity } from './session'
import { viewOnly } from './lib/viewOnly'

afterEach(() => {
  viewOnly.value = false
  vi.unstubAllGlobals()
})

function meAnswers(body: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })))
}

describe('loadIdentity sets view-only from the role', () => {
  it('role "viewer" turns view-only on', async () => {
    meAnswers({ email: 'viewer@example.com', role: 'viewer' })
    await loadIdentity()
    expect(viewOnly.value).toBe(true)
  })
  it.each([[{ email: 'owner@example.com', role: 'owner' }], [{ email: 'owner@example.com' }], [{ email: 'x@example.com', role: 'Viewer' }]])(
    'anything else leaves it off: %j',
    async (body) => {
      meAnswers(body)
      await loadIdentity()
      expect(viewOnly.value).toBe(false)
    },
  )
  it('a failed /auth/me leaves it off', async () => {
    meAnswers({ error: 'x' }, 500)
    await loadIdentity()
    expect(viewOnly.value).toBe(false)
  })
})
