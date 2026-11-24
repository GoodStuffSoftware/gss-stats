/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/email/sync: "Check now" for the signed-in login's own connection (plan sections 4 and 5).
// Asks the receipts Worker through the Service Binding `RECEIPTS` to run, for that one connection only.
//
// Rate limit: ONE atomic conditional insert of a `manual` run row, refused when any run of this connection (cron or
// manual) started in the last 5 minutes, so a Check-now spam, or two clicks racing, costs one D1 write and no Worker,
// Gmail or model call. The Worker finishes that row (it is handed `runId`).
//
// Worker contract, `RECEIPTS.fetch('https://receipts.internal/sync', {method: 'POST', JSON body})`:
//   request  {connectionId, runId, email}   (email = the session login; the Worker re-checks its allowlist copy)
//   response 202 {ok: true} as soon as the run is accepted (it works on in `ctx.waitUntil`, filling run `runId`:
//            counts, finished_at, error_code); any other status, or a throw, is a failure.
// No binding: 503 {error: 'receipts_unavailable'}. Worker failed: 502 {error: 'receipts_failed'}, the run row is
// closed with error_code `worker_failed`.

import { budgetJson, type BudgetEnv } from '../../../_lib/budgetAccess'
import { defineRoute } from '../../../_lib/budgetDb'

interface ReceiptsEnv extends BudgetEnv {
  RECEIPTS?: Fetcher
}

export const SYNC_MIN_GAP_MS = 5 * 60_000

export const onRequest = defineRoute({
  POST: async (ctx) => {
    const env = ctx.env as ReceiptsEnv
    const db = env.BUDGET_DB!
    const email = ctx.data.budgetEmail!
    if (typeof env.RECEIPTS?.fetch !== 'function') return budgetJson(503, { error: 'receipts_unavailable' })

    const conn = (await db.prepare('SELECT id, status FROM email_connections WHERE owner_email = ?').bind(email).first()) as
      | { id: string; status: string }
      | null
    if (!conn || conn.status === 'revoked') return budgetJson(409, { error: 'not_connected' })
    if (conn.status === 'needs_reconnect') return budgetJson(409, { error: 'reconnect_needed' })
    if (conn.status !== 'active') return budgetJson(409, { error: 'paused' })

    const now = Date.now()
    const startedAt = new Date(now).toISOString()
    const cutoff = new Date(now - SYNC_MIN_GAP_MS).toISOString()
    const ins = await db
      .prepare(
        `INSERT INTO receipt_sync_runs (connection_id, trigger, started_at)
         SELECT ?1, 'manual', ?2
          WHERE NOT EXISTS (SELECT 1 FROM receipt_sync_runs WHERE connection_id = ?1 AND started_at > ?3)`,
      )
      .bind(conn.id, startedAt, cutoff)
      .run()
    if (!ins.meta.changes) {
      const last = (await db
        .prepare('SELECT started_at FROM receipt_sync_runs WHERE connection_id = ? ORDER BY id DESC LIMIT 1')
        .bind(conn.id)
        .first()) as { started_at: string } | null
      const wait = last ? Math.max(1, Math.ceil((Date.parse(last.started_at) + SYNC_MIN_GAP_MS - now) / 1000)) : 1
      return budgetJson(429, { error: 'rate_limited', retryAfterSec: wait }, { 'Retry-After': String(wait) })
    }
    const run = (await db
      .prepare('SELECT id FROM receipt_sync_runs WHERE connection_id = ? AND started_at = ? ORDER BY id DESC LIMIT 1')
      .bind(conn.id, startedAt)
      .first()) as { id: number }

    let accepted = false
    try {
      const res = await env.RECEIPTS.fetch('https://receipts.internal/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId: conn.id, runId: run.id, email }),
      })
      accepted = res.status === 202
    } catch {
      accepted = false
    }
    if (!accepted) {
      await db
        .prepare("UPDATE receipt_sync_runs SET finished_at = ?, error_code = 'worker_failed' WHERE id = ? AND finished_at IS NULL")
        .bind(new Date().toISOString(), run.id)
        .run()
      return budgetJson(502, { error: 'receipts_failed' })
    }
    return budgetJson(202, { ok: true })
  },
})
