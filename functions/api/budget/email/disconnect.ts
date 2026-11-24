/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/email/disconnect {purge: boolean}: stop reading the signed-in login's mailbox (plan sections 4, 9).
// The body must say `purge` as a real boolean (true or false): that is the confirmation, a bare POST is a 400.
//
//   1. Revoke at Google, best effort: only the Worker holds the AES key, so it is asked through the Service Binding.
//      Worker contract, `RECEIPTS.fetch('https://receipts.internal/disconnect', {method: 'POST', JSON body})`:
//        request  {connectionId}      response 200 {revoked: boolean}
//      A missing binding, a throw, a non-200 or `revoked:false` never stops step 2; the answer says `revoked:false`
//      so the page can point the person at their Google account's third-party access list.
//      Both steps have a time limit; on a timeout the revoke counts as failed. Before step 1 an active connection is set
//      to `paused` (token kept), so the hourly run stops reading the mailbox even if this request is cut off.
//   2. Locally, in one batch: the connection becomes `revoked` with token_ct, token_iv and key_id all NULL (the schema
//      CHECK requires that trio), last_error, google_email and the sync watermark cleared. With `purge:true` the person's receipts are deleted, and the
//      FK cascade removes their items and matches, plus their run rows. Applied category edits on transactions stay.

import { budgetJson, type BudgetEnv } from '../../../_lib/budgetAccess'
import { badRequest, defineRoute, readJsonObject } from '../../../_lib/budgetDb'
import { BINDING_TIMEOUT_MS, bindingFetch } from '../../../_lib/gmailConnect'

interface ReceiptsEnv extends BudgetEnv {
  RECEIPTS?: Fetcher
}

export const onRequest = defineRoute({
  POST: async (ctx) => {
    const env = ctx.env as ReceiptsEnv
    const db = env.BUDGET_DB!
    const email = ctx.data.budgetEmail!
    const body = await readJsonObject(ctx.request, 256)
    if (typeof body.purge !== 'boolean' || Object.keys(body).length !== 1) throw badRequest('body: expected {"purge": true|false}')
    const purge = body.purge

    const conn = (await db.prepare('SELECT id FROM email_connections WHERE owner_email = ?').bind(email).first()) as { id: string } | null
    if (!conn) return budgetJson(404, { error: 'not_connected' })

    // Step 0, before anything slow: an active connection is paused (the token stays, so the Worker can still revoke it).
    // The hourly run reads only active connections, so even if this request is cut off during the revoke the mailbox
    // is never read again; the final batch below then marks it revoked.
    await db
      .prepare("UPDATE email_connections SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'")
      .bind(new Date().toISOString(), conn.id)
      .run()

    let revoked = false
    if (typeof env.RECEIPTS?.fetch === 'function') {
      try {
        const res = await bindingFetch(
          env.RECEIPTS,
          'https://receipts.internal/disconnect',
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: conn.id }) },
          BINDING_TIMEOUT_MS.disconnect,
        )
        if (res.status === 200) revoked = ((await res.json()) as { revoked?: unknown }).revoked === true
      } catch {
        revoked = false
      }
    }

    const stmts = [
      db
        .prepare(
          `UPDATE email_connections
              SET status = 'revoked', token_ct = NULL, token_iv = NULL, key_id = NULL, google_email = NULL, watermark_at = NULL, last_error = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .bind(new Date().toISOString(), conn.id),
    ]
    if (purge) {
      stmts.push(db.prepare('DELETE FROM receipts WHERE connection_id = ?').bind(conn.id))
      stmts.push(db.prepare('DELETE FROM receipt_sync_runs WHERE connection_id = ?').bind(conn.id))
    }
    await db.batch(stmts)
    return budgetJson(200, { ok: true, revoked, purged: purge })
  },
})
