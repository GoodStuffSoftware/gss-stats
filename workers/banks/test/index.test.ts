import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUTES, handleFetch, handleScheduled, type Env } from '../src/index'

const secret = (v: string) => ({ get: async () => v })
const env: Env = {
  BUDGET_DB: {} as D1Database,
  RECEIPTS_ALLOWED_EMAILS: secret('owner@example.com, Other@Example.com'),
  PLAID_ENV: 'sandbox',
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

const post = (path: string, body: unknown, e: Env = env, init: RequestInit = {}) =>
  handleFetch(new Request(`https://banks.internal${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...init }), e, ctx)
const code = async (r: Response) => ((await r.json()) as { code: string }).code

afterEach(() => vi.restoreAllMocks())

describe('routing', () => {
  it('answers 400 bad_request on /unlink and /accounts-refresh without an item id, before any D1 or Plaid call', async () => {
    for (const p of ['/unlink', '/accounts-refresh']) {
      const r = await post(p, { ownerEmail: 'Owner@example.com' })
      expect(r.status).toBe(400)
      expect(await code(r)).toBe('bad_request')
    }
  })

  it('answers 401 on the webhook path without an owner check or a signature', async () => {
    const r = await post('/webhook', 'not json at all')
    expect(r.status).toBe(401)
  })

  it('404s an unknown path, a prototype key and a non-POST method', async () => {
    expect((await post('/nope', {})).status).toBe(404)
    expect((await post('/constructor', {})).status).toBe(404)
    expect((await post('/toString', {})).status).toBe(404)
    const get = await handleFetch(new Request('https://banks.internal/link-token'), env, ctx)
    expect(get.status).toBe(404)
    expect(await code(get)).toBe('not_found')
  })

  it('413s a body over the cap, by header and by bytes', async () => {
    const big = JSON.stringify({ ownerEmail: 'owner@example.com', pad: 'x'.repeat(17 * 1024) })
    expect((await post('/exchange', big)).status).toBe(413)
    const r = await post('/exchange', '{}', env, { headers: { 'content-length': String(1024 * 1024) } })
    expect(r.status).toBe(413)
    expect((await post('/webhook', 'y'.repeat(17 * 1024))).status).toBe(413)
  })

  it('400s a body that is not a JSON object or has no usable ownerEmail', async () => {
    expect((await post('/link-token', 'nope')).status).toBe(400)
    expect((await post('/link-token', '[]')).status).toBe(400)
    expect((await post('/link-token', {})).status).toBe(400)
    expect((await post('/link-token', { ownerEmail: 7 })).status).toBe(400)
  })

  it('403s an owner off the allowlist and 503s when the allowlist secret is missing', async () => {
    const r = await post('/link-token', { ownerEmail: 'stranger@example.com' })
    expect(r.status).toBe(403)
    expect(await code(r)).toBe('not_allowed')
    const none = await post('/link-token', { ownerEmail: 'owner@example.com' }, { ...env, RECEIPTS_ALLOWED_EMAILS: secret('') })
    expect(none.status).toBe(503)
    expect(await code(none)).toBe('secrets_missing')
  })

  it('accepts the second allowlisted person, case-insensitively', async () => {
    expect((await post('/unlink', { ownerEmail: ' OTHER@example.com ' })).status).toBe(400)
  })

  it('has exactly the planned routes', () => {
    expect(Object.keys(ROUTES).sort()).toEqual(['/accounts-refresh', '/exchange', '/link-token', '/unlink', '/webhook'])
  })

  it('logs a handler crash as a code only and answers 500', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    const boom = { ...env, RECEIPTS_ALLOWED_EMAILS: { get: async () => { throw new Error('secret-detail') } } }
    // readSecret swallows a throwing binding, which reads as missing: 503, nothing logged with the message
    const r = await post('/link-token', { ownerEmail: 'owner@example.com' }, boom)
    expect(r.status).toBe(503)
    expect(lines.join('\n')).not.toContain('secret-detail')
  })
})

describe('scheduled', () => {
  it('without token keys the tick logs a start and a skip code, and calls nothing', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')))
    await handleScheduled(env)
    expect(lines).toEqual(['{"event":"scheduled_start"}', '{"event":"scheduled_skip","code":"keys_missing"}'])
  })
})

describe('logging', () => {
  it('uses console only inside log.ts', () => {
    const dir = join(fileURLToPath(import.meta.url), '..', '..', 'src')
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && n !== 'log.ts')) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/console\./)
    }
  })
})
