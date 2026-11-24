import { describe, expect, it, vi } from 'vitest'
import {
  GmailError,
  afterBound,
  buildReceiptQuery,
  createGmailClient,
  groupQueries,
  type GmailClient,
} from '../src/gmail'

// Every value here is made up: example.com senders, fake merchants, fake amounts, fake tokens.
const FAKE_REFRESH = 'fake-refresh-token-0000'
const FAKE_ACCESS = 'fake-access-token-1111'
const FAKE_SECRET = 'fake-client-secret-2222'
const ID1 = 'aaaa1111bbbb2222'
const ID2 = 'cccc3333dddd4444'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return handler(String(url), init ?? {})
  }) as unknown as typeof fetch
  const client = createGmailClient({ clientId: 'fake-client-id', clientSecret: FAKE_SECRET, refreshToken: FAKE_REFRESH, fetch: fetchFn })
  return { client, calls }
}

const tokenOk = () => json({ access_token: FAKE_ACCESS, expires_in: 3600 })

describe('token refresh', () => {
  it('posts a refresh_token grant to the Google token endpoint and uses the bearer token', async () => {
    const { client, calls } = setup((url) => (url.includes('/token') ? tokenOk() : json({ messages: [{ id: ID1 }] })))
    await client.listMessageIds('q')
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token')
    expect(calls[0].init.method).toBe('POST')
    const form = new URLSearchParams(String(calls[0].init.body))
    expect(form.get('grant_type')).toBe('refresh_token')
    expect(form.get('refresh_token')).toBe(FAKE_REFRESH)
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe(`Bearer ${FAKE_ACCESS}`)
  })

  it('maps invalid_grant to needs_reconnect', async () => {
    const { client } = setup(() => json({ error: 'invalid_grant', error_description: 'Token has been revoked.' }, 400))
    await expect(client.refreshAccessToken()).rejects.toMatchObject({ code: 'needs_reconnect' })
  })

  it('maps invalid_client to client_error, 429 to rate_limited, 503 to server_error, a throw to network_error', async () => {
    await expect(setup(() => json({ error: 'invalid_client' }, 401)).client.refreshAccessToken()).rejects.toMatchObject({ code: 'client_error' })
    await expect(setup(() => json({}, 429)).client.refreshAccessToken()).rejects.toMatchObject({ code: 'rate_limited' })
    await expect(setup(() => json({}, 503)).client.refreshAccessToken()).rejects.toMatchObject({ code: 'server_error' })
    await expect(
      setup(() => {
        throw new Error('boom user@example.com')
      }).client.refreshAccessToken(),
    ).rejects.toMatchObject({ code: 'network_error' })
  })

  it('rejects a malformed token response', async () => {
    await expect(setup(() => json({ nope: 1 })).client.refreshAccessToken()).rejects.toMatchObject({ code: 'bad_response' })
  })
})

describe('listMessageIds', () => {
  it('pages up to maxPages, reports more, and skips ids that are not hex', async () => {
    let page = 0
    const { client, calls } = setup((url) => {
      if (url.includes('/token')) return tokenOk()
      page++
      return json({ messages: [{ id: page === 1 ? ID1 : ID2 }, { id: 'NOT-HEX!' }], nextPageToken: `tok${page}` })
    })
    const r = await client.listMessageIds('after:1 x', { pageSize: 50, maxPages: 2 })
    expect(r).toEqual({ ids: [ID1, ID2], more: true, skipped: 2 })
    const list = calls.filter((c) => c.url.includes('/messages'))
    expect(list).toHaveLength(2)
    const u = new URL(list[1].url)
    expect(u.searchParams.get('q')).toBe('after:1 x')
    expect(u.searchParams.get('maxResults')).toBe('50')
    expect(u.searchParams.get('pageToken')).toBe('tok1')
    expect(u.searchParams.get('includeSpamTrash')).toBe('false')
  })

  it('stops at the last page and handles an empty mailbox', async () => {
    const { client } = setup((url) => (url.includes('/token') ? tokenOk() : json({ resultSizeEstimate: 0 })))
    expect(await client.listMessageIds('q')).toEqual({ ids: [], more: false, skipped: 0 })
  })
})

describe('getMessage', () => {
  it('requests format=full and returns the payload and date', async () => {
    const payload = { mimeType: 'text/plain', body: { data: 'aGk' } }
    const { client, calls } = setup((url) =>
      url.includes('/token') ? tokenOk() : json({ id: ID1, internalDate: '1763900000000', payload }),
    )
    const m = await client.getMessage(ID1)
    expect(m).toEqual({ id: ID1, internalDateMs: 1763900000000, payload })
    expect(calls[1].url).toBe(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${ID1}?format=full`)
  })

  it('refuses a non-hex id before any request and a response for a different id', async () => {
    const { client, calls } = setup(() => tokenOk())
    await expect(client.getMessage('../drafts')).rejects.toMatchObject({ code: 'client_error' })
    expect(calls).toHaveLength(0)
    const other = setup((url) => (url.includes('/token') ? tokenOk() : json({ id: ID2, internalDate: '1', payload: {} })))
    await expect(other.client.getMessage(ID1)).rejects.toMatchObject({ code: 'bad_response' })
  })
})

describe('error mapping on Gmail calls', () => {
  it('401 retries once after a refresh and then succeeds', async () => {
    let gets = 0
    const { client, calls } = setup((url) => {
      if (url.includes('/token')) return tokenOk()
      return ++gets === 1 ? json({}, 401) : json({ messages: [{ id: ID1 }] })
    })
    expect((await client.listMessageIds('q')).ids).toEqual([ID1])
    expect(calls.filter((c) => c.url.includes('/token'))).toHaveLength(2)
  })

  it('a second 401 becomes needs_reconnect', async () => {
    const { client } = setup((url) => (url.includes('/token') ? tokenOk() : json({}, 401)))
    await expect(client.listMessageIds('q')).rejects.toMatchObject({ code: 'needs_reconnect' })
  })

  it('429, rate-limit 403 and 5xx stop the run with a retry-next-run code', async () => {
    const run = (status: number, body: unknown = {}) =>
      setup((url) => (url.includes('/token') ? tokenOk() : json(body, status))).client.getMessage(ID1)
    await expect(run(429)).rejects.toMatchObject({ code: 'rate_limited' })
    await expect(run(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } })).rejects.toMatchObject({ code: 'rate_limited' })
    await expect(run(500)).rejects.toMatchObject({ code: 'server_error' })
    await expect(run(503)).rejects.toMatchObject({ code: 'server_error' })
    await expect(run(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } })).rejects.toMatchObject({ code: 'needs_reconnect' })
    await expect(run(404)).rejects.toMatchObject({ code: 'client_error' })
  })

  it('never puts tokens, addresses or response content into an error', async () => {
    const secrets = [FAKE_REFRESH, FAKE_ACCESS, FAKE_SECRET, 'user@example.com', 'Order total $12.34']
    const leaky = { error: { message: secrets.join(' | '), errors: [{ reason: 'x' }] }, error_description: secrets.join(' ') }
    const cases: Array<() => Promise<unknown>> = [
      () => setup(() => json(leaky, 400)).client.refreshAccessToken(),
      () => setup((u) => (u.includes('/token') ? tokenOk() : json(leaky, 403))).client.getMessage(ID1),
      () => setup((u) => (u.includes('/token') ? tokenOk() : json(leaky, 500))).client.getMessage(ID1),
      () =>
        setup(() => {
          throw new Error(secrets.join(' '))
        }).client.refreshAccessToken(),
    ]
    for (const c of cases) {
      const e = (await c().catch((x) => x)) as GmailError
      expect(e).toBeInstanceOf(GmailError)
      const text = `${e.message} ${e.name} ${String(e)} ${JSON.stringify(e)} ${e.stack ?? ''}`
      for (const s of secrets) expect(text).not.toContain(s)
      expect(e.message).toBe(e.code)
    }
  })
})

describe('read-only guarantee', () => {
  it('the client has no modify, send, label, trash, delete or insert method', () => {
    const { client } = setup(() => tokenOk())
    const names = Object.keys(client as GmailClient)
    expect(names.sort()).toEqual(['getMessage', 'listMessageIds', 'refreshAccessToken'])
    for (const n of names) expect(n).not.toMatch(/modify|send|label|trash|delete|insert|import|draft|batch|untrash/i)
  })

  it('every request is a GET to messages (list or get) or the token POST: no write endpoint is ever called', async () => {
    const { client, calls } = setup((url) => {
      if (url.includes('/token')) return tokenOk()
      return url.includes(`/messages/${ID1}`) ? json({ id: ID1, internalDate: '5', payload: {} }) : json({ messages: [{ id: ID1 }] })
    })
    await client.listMessageIds('q')
    await client.getMessage(ID1)
    for (const c of calls) {
      const isToken = c.url === 'https://oauth2.googleapis.com/token'
      expect(c.init.method).toBe(isToken ? 'POST' : 'GET')
      if (!isToken) {
        expect(c.url).toMatch(/^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages(\/[0-9a-f]{8,32})?\?/)
        expect(c.url.split('?')[0]).not.toMatch(/modify|send|labels|trash|untrash|delete|import|insert|batch|drafts/i)
      }
    }
  })
})

describe('buildReceiptQuery', () => {
  const q = groupQueries([
    { kind: 'from', value: 'orders@shop.example.com' },
    { kind: 'from', value: '@pay.example.com' },
    { kind: 'subject', value: 'receipt' },
    { kind: 'subject', value: 'order confirmation' },
    { kind: 'exclude_from', value: 'news@shop.example.com' },
  ])

  it('builds after, senders, subjects, exclusions and folder filters', () => {
    expect(buildReceiptQuery(q, 1763000000.9)).toBe(
      'after:1763000000 ({from:orders@shop.example.com from:@pay.example.com} OR subject:("receipt" OR "order confirmation")) ' +
        '-{from:news@shop.example.com} -in:spam -in:trash -in:drafts',
    )
  })

  it('works with subjects only, and refuses an empty matcher set', () => {
    const s = buildReceiptQuery({ from: [], subject: ['receipt'], excludeFrom: [] }, 100)
    expect(s).toBe('after:100 subject:("receipt") -in:spam -in:trash -in:drafts')
    expect(() => buildReceiptQuery({ from: [], subject: [], excludeFrom: [] }, 100)).toThrow(GmailError)
  })

  it('drops values that could change the query structure', () => {
    const s = buildReceiptQuery(
      { from: ['a@example.com) OR (in:anywhere', 'ok@example.com', 'x y'], subject: ['bad" OR "x', 'fine', '{evil}', '(x)'], excludeFrom: ['z@example.com }'] },
      100,
    )
    expect(s).toBe('after:100 ({from:ok@example.com} OR subject:("fine")) -in:spam -in:trash -in:drafts')
  })

  it('rejects a missing or non-positive lower bound', () => {
    expect(() => buildReceiptQuery(q, 0)).toThrow(GmailError)
    expect(() => buildReceiptQuery(q, NaN)).toThrow(GmailError)
  })
})

describe('afterBound', () => {
  it('is the watermark minus two days, or now minus the backfill on the first run', () => {
    expect(afterBound(1_763_000_000_000, 0, 14)).toBe(1_763_000_000 - 2 * 86400)
    expect(afterBound(null, 1_763_000_000_000, 14)).toBe(1_763_000_000 - 14 * 86400)
  })
})
