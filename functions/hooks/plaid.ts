/// <reference types="@cloudflare/workers-types" />
//
// POST /hooks/plaid: Plaid's webhook endpoint, the ONE path that is not behind the sign-in gate (PLAID_HOOK_PATH in
// functions/_lib/auth.ts opens it for exactly this method and path). It is a forwarder and does nothing else: it
// reads the raw body (at most 64 KB), requires the `plaid-verification` header, hands both unchanged to the banks
// Worker through the BANKS Service Binding (`/webhook`), and relays the Worker's status. The Worker verifies
// Plaid's signed JWT (ES256, body hash, 5-minute iat) and answers 401 to anything else; Pages never parses, logs
// or stores the body. Plan section 3.2; docs/adr/0009-bank-links-plaid.md amends ADR 0002 for this path.
//
// Answers: {"ok":true} on the Worker's 2xx; otherwise {"error":code} with the Worker's status (Plaid retries a 5xx
// and does not retry a 4xx). No binding: 503 banks_not_configured. Worker timeout: 504 binding_timeout; any other
// Worker failure: 502 banks_failed. Never a name, id, token or body in an answer or a log.

import { BANKS_TIMEOUT_MS, type BanksEnv } from '../_lib/banksBinding'
import { bindingFetch } from '../_lib/gmailConnect'

/** Largest webhook body Pages reads; Plaid's are well under 2 KB. */
export const MAX_HOOK_BYTES = 64 * 1024
/** A Plaid JWT is a few hundred bytes; anything past this is not one. */
const MAX_HEADER_CHARS = 4096
const CODE = /^[a-z][a-z0-9_]{0,39}$/

function answer(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

/** The whole body, or null once it passes `max` bytes (the stream is cancelled, so an oversized body is never held). */
async function readCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) return null
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** The Worker's fixed error code, or a generic one; the Worker's text is never relayed. */
async function workerCode(res: Response): Promise<string> {
  try {
    const parsed = (await res.json()) as { code?: unknown }
    if (typeof parsed.code === 'string' && CODE.test(parsed.code)) return parsed.code
  } catch {
    /* not JSON: fall through */
  }
  return 'webhook_failed'
}

export const onRequestPost: PagesFunction<BanksEnv> = async (ctx) => {
  const banks = ctx.env.BANKS
  if (typeof banks?.fetch !== 'function') return answer(503, { error: 'banks_not_configured' })

  const signature = ctx.request.headers.get('plaid-verification')
  if (!signature || signature.length > MAX_HEADER_CHARS) return answer(400, { error: 'missing_signature' })

  const bytes = await readCapped(ctx.request, MAX_HOOK_BYTES)
  if (bytes === null) return answer(413, { error: 'too_large' })

  let res: Response
  try {
    res = await bindingFetch(
      banks,
      'https://banks.internal/webhook',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'plaid-verification': signature }, body: bytes },
      BANKS_TIMEOUT_MS.webhook,
    )
  } catch (e) {
    return e instanceof Error && e.message === 'binding_timeout'
      ? answer(504, { error: 'binding_timeout' })
      : answer(502, { error: 'banks_failed' })
  }

  if (res.status >= 200 && res.status < 300) return answer(200, { ok: true })
  const status = res.status >= 400 && res.status < 600 ? res.status : 502
  return answer(status, { error: await workerCode(res) })
}
