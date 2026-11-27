/// <reference types="@cloudflare/workers-types" />
//
// GET /api/budget/email/status: the signed-in login's OWN Gmail receipts connection, in one batch of three reads (the third is the photo existence probe, `hasUploads`)
// (plan section 4). `{configured, connection: {status, lastRunAt, lastOkAt, lastError, consentVersion, googleEmail} | null,
// lastRuns: [newest 5], nextRunAt}`. Only codes and counts, plus `googleEmail`: the
// signed-in person's OWN linked Gmail address, returned to them only (the row is found by their session email, so the
// other Budget person's address can never come back). Never the token columns, key_id, the Google sub, an id, or
// anything about the other connection (the owner's email is the lookup key, never selected).
// `lastError` and each run's `errorCode` are the Worker's own codes (for example `api_rejected`, `api_limited`,
// `rate_limited`, `needs_reconnect`), passed through untouched so a run that keeps failing stays visible.

import { budgetJson, type BudgetEnv } from '../../../_lib/budgetAccess'
import { defineRoute } from '../../../_lib/budgetDb'
import { HAS_UPLOADS_SQL } from '../../../_lib/receiptsDb'

interface ReceiptsEnv extends BudgetEnv {
  RECEIPTS?: Fetcher
  RECEIPTS_GMAIL_CLIENT_ID?: string
}

/** The Worker's cron is `23 * * * *` (workers/receipts/wrangler.toml): minute 23 of every hour, UTC. */
export const CRON_MINUTE = 23

/** The next cron firing strictly after `now`. */
export function nextRunAt(now: Date): string {
  const t = new Date(now)
  t.setUTCSeconds(0, 0)
  t.setUTCMinutes(CRON_MINUTE)
  if (t.getTime() <= now.getTime()) t.setUTCHours(t.getUTCHours() + 1)
  return t.toISOString()
}

interface ConnRow {
  status: string
  last_run_at: string | null
  last_ok_at: string | null
  last_error: string | null
  consent_version: number
  google_email: string | null
}
interface RunRow {
  run_trigger: string
  started_at: string
  finished_at: string | null
  listed: number
  fetched: number
  extracted: number
  skipped: number
  matched: number
  auto_applied: number
  error_code: string | null
}

export const onRequest = defineRoute({
  GET: async (ctx) => {
    const env = ctx.env as ReceiptsEnv
    const db = env.BUDGET_DB!
    const email = ctx.data.budgetEmail!
    const [conn, runs, up] = await db.batch([
      db.prepare('SELECT status, last_run_at, last_ok_at, last_error, consent_version, google_email FROM email_connections WHERE owner_email = ?').bind(email),
      db
        .prepare(
          `SELECT run_trigger, started_at, finished_at, listed, fetched, extracted, skipped, matched, auto_applied, error_code
             FROM receipt_sync_runs
            WHERE connection_id = (SELECT id FROM email_connections WHERE owner_email = ?)
            ORDER BY id DESC LIMIT 5`,
        )
        .bind(email),
      db.prepare(HAS_UPLOADS_SQL).bind(email),
    ])
    const c = (conn.results as ConnRow[])[0]
    const configured = typeof env.RECEIPTS?.fetch === 'function' && !!env.RECEIPTS_GMAIL_CLIENT_ID
    return budgetJson(200, {
      configured,
      connection: c
        ? { status: c.status, lastRunAt: c.last_run_at, lastOkAt: c.last_ok_at, lastError: c.last_error, consentVersion: c.consent_version, googleEmail: c.google_email }
        : null,
      lastRuns: (runs.results as RunRow[]).map((r) => ({
        trigger: r.run_trigger,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        listed: r.listed,
        fetched: r.fetched,
        extracted: r.extracted,
        skipped: r.skipped,
        matched: r.matched,
        autoApplied: r.auto_applied,
        errorCode: r.error_code,
      })),
      hasUploads: Number((up.results as Array<{ has_uploads: number }>)[0]?.has_uploads ?? 0) === 1,
      nextRunAt: c && c.status === 'active' ? nextRunAt(new Date()) : null,
    })
  },
})
