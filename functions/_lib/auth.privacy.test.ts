import { describe, it, expect, vi } from 'vitest'
import { authGate, type AuthEnv } from './auth'

// /privacy is the only page served without sign-in. Everything else stays gated.

const ORIGIN = 'https://stats.goodstuff.software'
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0)
const ENV: AuthEnv = {
  GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: 'x'.repeat(48),
  ALLOWED_EMAILS: 'owner@example.com',
}
const PAGE = '<title>Privacy policy, GSS Budget Receipts</title>'

async function gate(path: string, method = 'GET', env: AuthEnv = ENV) {
  const next = vi.fn(async () => new Response(PAGE, { status: 200, headers: { 'Content-Type': 'text/html' } }))
  const res = await authGate(new Request(ORIGIN + path, { method }), env, next, { now: () => NOW })
  return { res, next }
}

describe('/privacy is public', () => {
  it.each(['/privacy', '/privacy?x=1', '/privacy?next=/api/budget/summary'])('GET %s is 200 with no session', async (path) => {
    const { res, next } = await gate(path)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(PAGE)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('HEAD works too, and is public and cacheable but not frameable', async () => {
    const { res } = await gate('/privacy', 'HEAD')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'")
    expect(res.headers.getSetCookie()).toEqual([])
  })

  it('stays public even when sign-in is not configured', async () => {
    const { res } = await gate('/privacy', 'GET', {})
    expect(res.status).toBe(200)
  })

  it('a write to /privacy is refused, not public', async () => {
    const { res, next } = await gate('/privacy', 'POST')
    expect(res.status).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })
})

describe('everything else is still gated', () => {
  it.each([
    '/',
    '/index.html',
    '/privacy/',
    '/privacy.html',
    '/PRIVACY',
    '/Privacy',
    '/privacy-x',
    '/privacyx',
    '/privacy/x',
    '//privacy',
    '/%70rivacy',
    '/privacy%00',
    '/privacy%2F',
    '/x/privacy',
    '/assets/app.js',
  ])('GET %s with no session redirects to sign-in', async (path) => {
    const { res, next } = await gate(path)
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('/auth/google/login')
    expect(next).not.toHaveBeenCalled()
  })

  it.each([
    '/api/stats',
    '/api/config',
    '/api/budget/summary',
    '/api/budget/email/status',
    '/api/budget/email/receipts',
    '/api//budget/summary',
    '/api/budget/../stats',
    '/api/%62udget/summary',
    '/api/privacy',
    '/privacy/../api/stats',
    '/privacy/%2e%2e/api/stats',
  ])('GET %s with no session is 401 JSON and never reaches the function', async (path) => {
    const { res, next } = await gate(path)
    expect(res.status).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })
})
