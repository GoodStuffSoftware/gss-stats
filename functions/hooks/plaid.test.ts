import { describe, it, expect, vi, afterEach } from 'vitest'
import { onRequestPost, MAX_HOOK_BYTES } from './plaid'

// The webhook forwarder (functions/hooks/plaid.ts). Fake Worker only; invented bytes; no Plaid, no network.

const URL_ = 'https://stats.goodstuff.software/hooks/plaid'
const SIG = 'header.payload.signature-test-only'

interface Call {
  url: string
  init: RequestInit
}

function fakeBanks(reply: () => Promise<Response> | Response) {
  const calls: Call[] = []
  const banks = {
    fetch: vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} })
      return reply()
    }),
  }
  return { banks, calls }
}

function post(body: BodyInit | null, headers: Record<string, string> = { 'plaid-verification': SIG }) {
  return new Request(URL_, { method: 'POST', headers, body })
}

async function run(request: Request, banks?: unknown) {
  return onRequestPost({ request, env: { BANKS: banks } } as never)
}

const sent = (c: Call) => new Uint8Array(c.init.body as Uint8Array)

afterEach(() => {
  vi.useRealTimers()
})

describe('forwarding', () => {
  it('hands the Worker the same bytes and the signature header, and answers {ok:true}', async () => {
    // Whitespace, key order and non-ASCII are exactly what a JSON round trip would change: the hash covers these bytes.
    const body = new TextEncoder().encode('{ "webhook_type" : "TRANSACTIONS",\n "note":"café ☃",  "item_id":"item-sandbox-001" }  \n')
    const { banks, calls } = fakeBanks(() => new Response(JSON.stringify({ ok: true, code: 'ignored' }), { status: 200 }))
    const res = await run(post(body), banks)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://banks.internal/webhook')
    expect(calls[0].init.method).toBe('POST')
    expect(new Headers(calls[0].init.headers).get('plaid-verification')).toBe(SIG)
    expect(Array.from(sent(calls[0]))).toEqual(Array.from(body))
  })

  it('forwards bytes that are not valid UTF-8 untouched', async () => {
    const body = new Uint8Array([0x7b, 0xff, 0xfe, 0x00, 0x80, 0x7d])
    const { banks, calls } = fakeBanks(() => new Response('{"ok":true}', { status: 200 }))
    await run(post(body), banks)
    expect(Array.from(sent(calls[0]))).toEqual(Array.from(body))
  })

  it('accepts a body of exactly 64 KB', async () => {
    const body = new Uint8Array(MAX_HOOK_BYTES).fill(0x20)
    const { banks, calls } = fakeBanks(() => new Response('{"ok":true}', { status: 200 }))
    const res = await run(post(body), banks)
    expect(res.status).toBe(200)
    expect(sent(calls[0]).byteLength).toBe(MAX_HOOK_BYTES)
  })

  it('an empty body is forwarded (the Worker decides)', async () => {
    const { banks, calls } = fakeBanks(() => new Response(JSON.stringify({ ok: false, code: 'bad_signature' }), { status: 401 }))
    const res = await run(post(null), banks)
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(1)
    expect(sent(calls[0]).byteLength).toBe(0)
  })
})

describe('refusals before the Worker', () => {
  it('413 over 64 KB (streamed), and the Worker is never called', async () => {
    const { banks, calls } = fakeBanks(() => new Response('{"ok":true}'))
    const res = await run(post(new Uint8Array(MAX_HOOK_BYTES + 1)), banks)
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'too_large' })
    expect(calls).toHaveLength(0)
  })

  it('413 on a declared content-length over 64 KB, without reading the body', async () => {
    const { banks, calls } = fakeBanks(() => new Response('{"ok":true}'))
    const res = await run(post('{}', { 'plaid-verification': SIG, 'content-length': String(MAX_HOOK_BYTES + 1) }), banks)
    expect(res.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('400 without the plaid-verification header', async () => {
    const { banks, calls } = fakeBanks(() => new Response('{"ok":true}'))
    const res = await run(post('{}', {}), banks)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'missing_signature' })
    expect(calls).toHaveLength(0)
  })

  it('400 for an empty or absurdly long header', async () => {
    const { banks, calls } = fakeBanks(() => new Response('{"ok":true}'))
    expect((await run(post('{}', { 'plaid-verification': '' }), banks)).status).toBe(400)
    expect((await run(post('{}', { 'plaid-verification': 'a'.repeat(5000) }), banks)).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('503 when BANKS is not bound (preview, local), body never read', async () => {
    const res = await run(post('{}'), undefined)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'banks_not_configured' })
  })

  it('503 when BANKS is bound to something that is not a binding', async () => {
    const res = await run(post('{}'), {})
    expect(res.status).toBe(503)
  })
})

describe('relaying the Worker answer', () => {
  it('passes a 401 through as {error:code} (Plaid does not retry a 4xx)', async () => {
    const { banks } = fakeBanks(() => new Response(JSON.stringify({ ok: false, code: 'bad_signature' }), { status: 401 }))
    const res = await run(post('{}'), banks)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'bad_signature' })
  })

  it('passes a 503 through (Plaid retries it)', async () => {
    const { banks } = fakeBanks(() => new Response(JSON.stringify({ ok: false, code: 'key_unavailable' }), { status: 503 }))
    const res = await run(post('{}'), banks)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'key_unavailable' })
  })

  it('never relays Worker text: an unexpected body becomes a fixed code', async () => {
    const { banks } = fakeBanks(() => new Response('<html>boom item-sandbox-001</html>', { status: 500 }))
    const res = await run(post('{}'), banks)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'webhook_failed' })
  })

  it('a code that is not a plain lower-case token is replaced too', async () => {
    const { banks } = fakeBanks(() => new Response(JSON.stringify({ ok: false, code: 'Item item-sandbox-001 failed' }), { status: 502 }))
    const res = await run(post('{}'), banks)
    expect(await res.json()).toEqual({ error: 'webhook_failed' })
  })

  it('a Worker that throws is 502 banks_failed', async () => {
    const { banks } = fakeBanks(() => {
      throw new Error('service unavailable')
    })
    const res = await run(post('{}'), banks)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'banks_failed' })
  })

  it('a Worker that never answers is 504 binding_timeout after 8 s', async () => {
    vi.useFakeTimers()
    const { banks } = fakeBanks(() => new Promise<Response>(() => {}))
    const pending = run(post('{}'), banks)
    await vi.advanceTimersByTimeAsync(8_001)
    const res = await pending
    expect(res.status).toBe(504)
    expect(await res.json()).toEqual({ error: 'binding_timeout' })
  })

  it('answers are JSON and never cached', async () => {
    const { banks } = fakeBanks(() => new Response('{"ok":true}'))
    const res = await run(post('{}'), banks)
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('no other method', () => {
  it('exports only a POST handler', async () => {
    const mod = await import('./plaid')
    expect(Object.keys(mod).filter((k) => k.startsWith('onRequest')).sort()).toEqual(['onRequestPost'])
  })
})
