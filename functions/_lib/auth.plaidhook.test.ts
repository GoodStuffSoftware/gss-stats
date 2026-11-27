import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { authGate, PLAID_HOOK_PATH, type AuthEnv } from './auth'

// POST /hooks/plaid is the ONE unauthenticated write (Plaid's webhook). Exactly that method and path opens;
// every other method and near-miss path keeps the normal gate. Neighbours: auth.privacy.test.ts (/privacy).

const ORIGIN = 'https://stats.goodstuff.software'
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0)
const ENV: AuthEnv = {
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: 'x'.repeat(48),
  ALLOWED_EMAILS: 'owner@example.com',
}

async function gate(path: string, method = 'POST', env: AuthEnv = ENV, headers: Record<string, string> = {}, base = ORIGIN) {
  const next = vi.fn(async () => new Response('reached the function', { status: 200 }))
  const res = await authGate(new Request(base + path, { method, headers, body: method === 'POST' ? '{}' : undefined }), env, next, { now: () => NOW })
  return { res, next }
}

describe('POST /hooks/plaid is open', () => {
  it('names the exact path', () => {
    expect(PLAID_HOOK_PATH).toBe('/hooks/plaid')
  })

  it('reaches the function with no session and no Origin', async () => {
    const { res, next } = await gate('/hooks/plaid')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('reached the function')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('reaches the function even when sign-in is not configured', async () => {
    const { res, next } = await gate('/hooks/plaid', 'POST', {})
    expect(res.status).toBe(200)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('still refuses plain http off loopback (the https redirect runs first)', async () => {
    const { res, next } = await gate('/hooks/plaid', 'POST', ENV, {}, 'http://stats.goodstuff.software')
    expect(res.status).toBe(308)
    expect(res.headers.get('Location')).toBe('https://stats.goodstuff.software/hooks/plaid')
    expect(next).not.toHaveBeenCalled()
  })
})

describe('every other method on /hooks/plaid keeps the gate', () => {
  it.each(['GET', 'HEAD'])('%s with no session redirects to sign-in', async (method) => {
    const { res, next } = await gate('/hooks/plaid', method)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('/auth/google/login')
    expect(next).not.toHaveBeenCalled()
  })

  it.each(['PUT', 'PATCH', 'DELETE'])('%s with no session is 401', async (method) => {
    const { res, next } = await gate('/hooks/plaid', method)
    expect(res.status).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('OPTIONS with no session is 401', async () => {
    const { res, next } = await gate('/hooks/plaid', 'OPTIONS')
    expect(res.status).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('near-miss paths on POST keep the gate', () => {
  it.each([
    '/hooks/plaid/',
    '/hooks/Plaid',
    '/hooks/PLAID',
    '/hooks/plaidx',
    '/hooks/plaid.',
    '/hooks/plaid/x',
    '/hooks/plaid?x=1',
    '/hooks/plaid?next=/api/budget/summary',
    '/hooks',
    '/hooks/',
    '//hooks/plaid',
    '/%68ooks/plaid',
    '/hooks/%70laid',
    '/hooks/plaid%2F',
    '/hooks/plaid%00',
    '/x/hooks/plaid',
    '/api/hooks/plaid',
    '/hooks/plaid/../../api/stats',
    '/api/budget/hooks/plaid',
    '/api/budget/banks/status',
  ])('POST %s with no session is 401 and never reaches the function', async (path) => {
    const { res, next } = await gate(path)
    expect(res.status).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it.each(['/hooks/plaid/', '/hooks/Plaid', '/hooks/plaidx', '/hooks/plaid?x=1'])('GET %s with no session goes to sign-in', async (path) => {
    const { res, next } = await gate(path, 'GET')
    expect(res.status).toBe(302)
    expect(next).not.toHaveBeenCalled()
  })

  it('a cross-origin POST to a near-miss path is refused before anything else', async () => {
    const { res, next } = await gate('/hooks/plaid/', 'POST', ENV, { Origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('the wrangler.toml binding', () => {
  // Read as text: BANKS goes in the top-level block only. The preview shares the production D1, so it never gets it.
  const toml = readFileSync('wrangler.toml', 'utf8')
  const at = toml.search(/^\[env\.preview\]/m)
  const bound = /^\s*binding\s*=\s*"BANKS"/m

  it('has an [env.preview] section to check against', () => {
    expect(at).toBeGreaterThan(0)
  })

  it('binds BANKS to the banks Worker at the top level', () => {
    const top = toml.slice(0, at)
    expect(bound.test(top)).toBe(true)
    expect(top).toMatch(/binding\s*=\s*"BANKS"\s*\r?\nservice\s*=\s*"gss-budget-banks"/)
  })

  it('never binds BANKS under env.preview', () => {
    expect(bound.test(toml.slice(at))).toBe(false)
    expect(toml.slice(at)).not.toMatch(/gss-budget-banks/)
  })
})
