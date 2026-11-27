/// <reference types="@cloudflare/workers-types" />
//
// Shared pieces of the receipt-photo routes (functions/api/budget/uploads/**, docs/adr/0010-receipt-photo-uploads.md):
// the Worker call, the size cap and the image-share switch. No D1 write happens in Pages; the Worker owns the store.

import type { BudgetEnv } from './budgetAccess'
import { BINDING_TIMEOUT_MS, bindingFetch } from './gmailConnect'

/** Largest photo accepted (bytes). The client re-encodes to well under this; the Worker enforces its own cap too. */
export const UPLOAD_MAX_BYTES = 2_000_000
export const WORKER_BASE = 'https://receipts.internal'
/** The signed-in login, lower-cased, sent to the Worker (it re-checks its allowlist copy). */
export const EMAIL_HEADER = 'X-Budget-Email'

export interface UploadsEnv extends BudgetEnv {
  RECEIPTS?: Fetcher
  RECEIPTS_SHARE?: string
  RECEIPTS_IMAGE_SHARE?: string
}

/** `RECEIPTS_IMAGE_SHARE`: `both` (default) lets every listed person see a shared receipt's photo; `owner` only the uploader. */
export function imageShareBoth(raw: unknown): boolean {
  return (typeof raw === 'string' ? raw.trim().toLowerCase() : '') !== 'owner'
}

/** One call to the receipts Worker. Rejects on a binding failure or timeout (callers answer 502 `unavailable`). */
export function callWorker(env: UploadsEnv, path: string, init: RequestInit, email: string): Promise<Response> {
  if (typeof env.RECEIPTS?.fetch !== 'function') return Promise.reject(new Error('binding_missing'))
  const headers = new Headers(init.headers)
  headers.set(EMAIL_HEADER, email.toLowerCase())
  return bindingFetch(env.RECEIPTS, `${WORKER_BASE}${path}`, { ...init, headers }, BINDING_TIMEOUT_MS.upload)
}

/** The whole body as bytes, counted as it streams and cut at `max` (null when over). */
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
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
