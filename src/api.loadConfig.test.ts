import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, ConfigLoadError } from './api'
import { sessionExpired } from './session'

// loadConfig tells "nothing is stored yet" (null: the defaults ARE the layout, saving them is right)
// apart from "the stored layout could not be read" (ConfigLoadError: the tab must not save).
// Every failure used to resolve to null as well, so a 5xx showed the defaults and the first edit
// saved them over the real layout.

function stubGet(reply: () => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply()),
  )
}
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  sessionExpired.value = false
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadConfig', () => {
  it('resolves to the stored layout (pages, or a legacy widgets list)', async () => {
    stubGet(() => json('{"version":12,"pages":[]}'))
    await expect(loadConfig()).resolves.toEqual({ version: 12, pages: [] })
    stubGet(() => json('{"widgets":[]}'))
    await expect(loadConfig()).resolves.toEqual({ widgets: [] })
  })

  it('resolves to null only when the server says nothing is stored (a literal null body)', async () => {
    stubGet(() => json('null'))
    await expect(loadConfig()).resolves.toBeNull()
  })

  it('never reads the layout from the HTTP cache', async () => {
    stubGet(() => json('null'))
    await loadConfig()
    expect(vi.mocked(fetch).mock.calls[0]).toEqual(['/api/config', { cache: 'no-store' }])
  })

  it.each([
    ['network', () => Promise.reject(new TypeError('Failed to fetch')), undefined],
    ['http', () => json('{"error":"boom"}', 500), 500],
    ['http', () => json('upstream', 503), 503],
    ['http', () => json('not found', 404), 404],
    ['bad-json', () => new Response('<!doctype html><title>Sign in</title>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 200],
    ['bad-json', () => json('{"pages":[', 200), 200],
    ['bad-shape', () => json('{}'), 200],
    ['bad-shape', () => json('[]'), 200],
    ['bad-shape', () => json('"dashboard"'), 200],
    ['bad-shape', () => json('{"pages":"nope"}'), 200],
  ] as const)('throws ConfigLoadError(%s) for a load that failed (status %s)', async (reason, reply, status) => {
    stubGet(reply)
    const err = await loadConfig().catch((e) => e)
    expect(err).toBeInstanceOf(ConfigLoadError)
    expect(err.reason).toBe(reason)
    expect(err.status).toBe(status)
    expect(sessionExpired.value).toBe(false)
  })

  it('a 401 throws ConfigLoadError(auth) and raises the sign-in banner', async () => {
    stubGet(() => json('{"error":"unauthenticated"}', 401))
    const err = await loadConfig().catch((e) => e)
    expect(err).toBeInstanceOf(ConfigLoadError)
    expect(err.reason).toBe('auth')
    expect(sessionExpired.value).toBe(true)
  })
})
