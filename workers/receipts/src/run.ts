// One receipts run for one connection (plan sections 5-7): decrypt the token, list new Gmail ids, get, extract, store,
// re-match, mark stale, auto-apply when RECEIPTS_AUTO_APPLY is "1", and close the run row with counts and one code.
// Every error is a fixed code (never Google, mail or model text). Nothing here logs except through ./log (counts, codes).
import { matchReceipts } from '../../../src/lib/budget/receiptMatch'
import { extractBodyText } from './bodyText'
import { readSecret, type ReceiptsSecretsEnv, type SecretBinding } from './disconnect'
import { extractReceipt, extractReceiptImage, type ExtractedReceipt } from './extract'
import { GmailError, RETRY_NEXT_RUN, afterBound, buildReceiptQuery, createGmailClient } from './gmail'
import { keepDays, selectImageStore, type ImageStoreEnv } from './imageStore'
import { log } from './log'
import * as S from './store'
import { TokenCryptoError, decryptToken, reencryptToken } from './tokenCrypto'

export interface Env extends ReceiptsSecretsEnv, ImageStoreEnv {
  RECEIPTS_ANTHROPIC_KEY?: SecretBinding
  RECEIPTS_MODEL?: string
  RECEIPTS_MAX_PER_RUN?: string
  RECEIPTS_DAILY_CAP?: string
  RECEIPTS_BACKFILL_DAYS?: string
  RECEIPTS_AUTO_APPLY?: string
  RECEIPTS_AUTO_MIN_SCORE?: string
  /** Photo uploads one person may make per UTC day (the upload route checks it). */
  RECEIPTS_UPLOAD_DAILY_CAP?: string
}

export interface RunDeps {
  fetch?: typeof fetch
  now?: () => Date
  /** Wall-clock budget (ms): past it the run ends cleanly between messages (the next run continues). A manual run sets one because waitUntil is time-limited. */
  budgetMs?: number
  /** Most list calls one run makes (default 8); only a test needs another value. */
  maxLists?: number
}

/** Budget of a manual (/sync) run: Workers keep waitUntil work alive about 30 s after the response. */
export const MANUAL_BUDGET_MS = 25_000

export function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

export async function allowedEmails(env: Env): Promise<Set<string> | null> {
  const raw = await readSecret(env.RECEIPTS_ALLOWED_EMAILS)
  return raw === '' ? null : new Set(raw.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean))
}

const intVar = (v: string | undefined, dflt: number): number => {
  const n = Number(v)
  return v !== undefined && v.trim() !== '' && Number.isFinite(n) ? n : dflt
}

export interface RunOutcome { errorCode: string | null; counts: S.RunCounts }

const SKIPPED: ExtractedReceipt = {
  status: 'skipped', kind: null, merchant: null, paymentVia: null, cardLast4: null, orderRef: null, receiptDate: null, relatedDate: null,
  currency: null, totalCents: null, taxCents: null, shippingCents: null, charges: [], chargesJson: '[]', items: [],
}

function senderDomain(payload: { headers?: Array<{ name?: string; value?: string }> }): string | null {
  const from = payload.headers?.find((h) => h.name?.toLowerCase() === 'from')?.value ?? ''
  const m = /@([A-Za-z0-9.-]{1,80})>?\s*$/.exec(from.trim())
  return m ? m[1].toLowerCase() : null
}

/** New-message listing: slice length (seconds), floor for halving, and the most list calls one run makes. */
const SLICE_S = 7 * 86_400
const MIN_SLICE_S = 3_600
const MAX_LISTS_PER_RUN = 8

export const CATEGORIES_SQL = `SELECT id FROM categories WHERE archived = 0 ORDER BY id`
/** The run is still open and its connection still active (a disconnect pauses or revokes the connection first). */
const RUN_ACTIVE_SQL = `SELECT 1 AS ok FROM receipt_sync_runs r JOIN email_connections c ON c.id = r.connection_id
WHERE r.id = ?1 AND r.connection_id = ?2 AND r.finished_at IS NULL AND c.status = 'active'`
const RUN_OPEN_SQL =`SELECT 1 AS ok FROM receipt_sync_runs WHERE id = ?1 AND connection_id = ?2 AND finished_at IS NULL`
/** Re-encrypted token: only the row still holding the ciphertext we read, still active. */
const REKEY_SQL = `UPDATE email_connections SET token_ct = ?3, token_iv = ?4, key_id = ?5, updated_at = ?6 WHERE id = ?1 AND token_ct = ?2 AND status = 'active'`

/** True when run `runId` exists for the connection and is still open (the /sync route checks this before answering 202). */
export async function runIsOpen(db: D1Database, runId: number, connectionId: string): Promise<boolean> {
  return (await db.prepare(RUN_OPEN_SQL).bind(runId, connectionId).first()) !== null
}

/** Run one connection into run row `runId` (or a new cron row). Never throws: the row is always closed with counts and one code. */
export async function runConnection(env: Env, connectionId: string, runId: number | null, trigger: 'cron' | 'manual', deps: RunDeps = {}): Promise<RunOutcome> {
  const clock = deps.now ?? (() => new Date())
  const db = env.BUDGET_DB
  const counts: S.RunCounts = { ...S.ZERO_COUNTS }
  let code: string | null = null
  let watermarkAt: string | null = null
  let id = runId
  try {
    if (id === null) {
      id = await S.createRunIfIdle(db, connectionId, trigger, clock())
      // Another run of this mailbox is still going: do nothing (no row, no result), so the two never spend at once.
      if (id === null) return { errorCode: 'run_busy', counts }
    }
    const r = await runInner(env, connectionId, id, counts, deps, clock)
    code = r.code
    watermarkAt = r.watermarkAt
  } catch {
    code = 'run_failed'
  }
  try {
    const at = clock()
    if (id !== null) await S.finishRun(db, id, counts, code, at)
    await S.recordConnectionResult(db, connectionId, { runAtIso: at.toISOString(), ok: code === null, watermarkAt, lastError: code })
    await S.pruneRuns(db, connectionId)
  } catch {
    code = code ?? 'run_failed'
  }
  log('run_done', { listed: counts.listed, fetched: counts.fetched, extracted: counts.extracted, skipped: counts.skipped, matched: counts.matched, auto_applied: counts.autoApplied }, code)
  return { errorCode: code, counts }
}

async function runInner(env: Env, connectionId: string, runId: number | null, counts: S.RunCounts, deps: RunDeps, clock: () => Date): Promise<{ code: string | null; watermarkAt: string | null }> {
  const db = env.BUDGET_DB
  const doFetch = deps.fetch ?? fetch
  const startedMs = clock().getTime()
  const conn = await S.loadConnection(db, connectionId)
  if (!conn || conn.status !== 'active' || !conn.tokenCt || !conn.tokenIv) return { code: 'not_active', watermarkAt: null }

  // The owner must still be on the Budget list (a removed person's mailbox stops syncing; no Gmail call).
  const allowed = await allowedEmails(env)
  if (allowed === null) return { code: 'secrets_missing', watermarkAt: null }
  if (!allowed.has(conn.ownerEmail)) {
    await S.setConnectionStatus(db, connectionId, 'paused', 'not_allowed', clock())
    return { code: 'not_allowed', watermarkAt: null }
  }

  const [clientId, clientSecret, keyCurrent, keyOld, apiKey] = await Promise.all([
    readSecret(env.RECEIPTS_GMAIL_CLIENT_ID), readSecret(env.RECEIPTS_GMAIL_CLIENT_SECRET), readSecret(env.RECEIPTS_TOKEN_KEY),
    readSecret(env.RECEIPTS_TOKEN_KEY_OLD), readSecret(env.RECEIPTS_ANTHROPIC_KEY),
  ])
  if (!clientId || !clientSecret || !keyCurrent || !apiKey) return { code: 'secrets_missing', watermarkAt: null }

  // Decrypt (AAD = connection id). A token that will not decrypt is a reconnect, never a retry loop.
  let refreshToken: string
  try {
    const enc = { token_ct: conn.tokenCt, token_iv: conn.tokenIv, key_id: conn.keyId ?? '' }
    const d = await decryptToken(enc, connectionId, { current: keyCurrent, old: keyOld })
    refreshToken = d.plaintext
    if (d.usedOldKey) {
      try {
        const n = await reencryptToken(refreshToken, connectionId, keyCurrent)
        await db.prepare(REKEY_SQL).bind(connectionId, conn.tokenCt, n.token_ct, n.token_iv, n.key_id, clock().toISOString()).run()
      } catch {
        // The next run tries again; the old key still works.
      }
    }
  } catch (e) {
    if (e instanceof TokenCryptoError && e.code === 'decrypt_failed') {
      await S.setConnectionStatus(db, connectionId, 'needs_reconnect', 'decrypt_failed', clock(), conn.tokenCt)
      return { code: 'decrypt_failed', watermarkAt: null }
    }
    return { code: 'key_invalid', watermarkAt: null }
  }

  const maxPerRun = Math.max(0, Math.floor(intVar(env.RECEIPTS_MAX_PER_RUN, 60)))
  const remaining = S.capRemaining(intVar(env.RECEIPTS_DAILY_CAP, 150), await S.modelCallsToday(db, connectionId, clock()))
  let budget = Math.min(maxPerRun, remaining)
  if (budget === 0) return { code: 'daily_cap', watermarkAt: null }

  const gmail = createGmailClient({ clientId, clientSecret, refreshToken, fetch: doFetch })
  const model = env.RECEIPTS_MODEL?.trim() || 'claude-haiku-5-5'
  const categoryIds = (await db.prepare(CATEGORIES_SQL).all<{ id: string }>()).results.map((c) => c.id)
  const timeUp = (): boolean => deps.budgetMs !== undefined && clock().getTime() - startedMs >= deps.budgetMs
  let code: string | null = null
  let handledMs = 0 // internalDate of the message the last handle() stored (0 when it stored none)
  let wmMs = 0 // the watermark this run may move to (see the slice loop)

  /** Get, extract and store (or complete) one message. Returns a run-ending code, or null to go on. */
  const handle = async (gmailId: string, retry: { id: string } | null): Promise<string | null> => {
    // A disconnect (pause, revoke, purge) while this run is going ends it before the next message is read or paid for.
    if (runId !== null && !(await db.prepare(RUN_ACTIVE_SQL).bind(runId, connectionId).first())) return 'not_active'
    let msg
    try {
      msg = await gmail.getMessage(gmailId)
    } catch (e) {
      if (e instanceof GmailError && (e.code === 'needs_reconnect' || RETRY_NEXT_RUN.has(e.code))) throw e
      const failure = e instanceof GmailError ? e.code : 'client_error'
      if (retry) await S.recordFailure(db, retry.id, failure, clock())
      else await S.insertReceipt(db, { connectionId, gmailMsgId: gmailId, emailDate: clock().toISOString().slice(0, 10), extracted: null, failureCode: failure }, clock())
      return null
    }
    counts.fetched++
    const emailDate = new Date(msg.internalDateMs).toISOString().slice(0, 10)
    const text = extractBodyText(msg.payload)
    let receipt: ExtractedReceipt | null = null
    if (text === '') {
      receipt = SKIPPED
    } else {
      const r = await extractReceipt({ text, emailDate, categoryIds }, { apiKey, model }, doFetch)
      if (r.usage) { counts.modelInTokens += r.usage.inputTokens; counts.modelOutTokens += r.usage.outputTokens }
      if (!r.ok) {
        if (r.code === 'extract_invalid') {
          if (retry) await S.recordFailure(db, retry.id, 'extract_invalid', clock())
          else await S.insertReceipt(db, { connectionId, gmailMsgId: gmailId, emailDate, extracted: null, failureCode: 'extract_invalid', senderDomain: senderDomain(msg.payload) }, clock())
          return null
        }
        return r.reason ?? 'api_unavailable' // stop_run or auth_failed: nothing stored, no attempt used
      }
      receipt = r.receipt
    }
    const domain = senderDomain(msg.payload)
    const stored = retry
      ? await S.completeReceipt(db, retry.id, receipt, model, domain, clock())
      : (await S.insertReceipt(db, { connectionId, gmailMsgId: gmailId, emailDate, extracted: receipt, senderDomain: domain, model }, clock())).inserted
    if (stored) {
      if (receipt.status === 'skipped') counts.skipped++
      else counts.extracted++
      // Only a stored message counts as handled: one the insert guard dropped (a disconnect landed) must not move the watermark.
      handledMs = msg.internalDateMs
    }
    return null
  }

  try {
    // One token refresh up front: a token-endpoint failure (invalid_client, bad answer) is a run code, never a charge
    // against a message's attempts.
    await gmail.refreshAccessToken()
    // Retries first (pending or error rows under the attempt limit), then new messages oldest first.
    const retries = await S.loadRetryReceipts(db, connectionId, budget)
    for (const rr of retries) {
      if (budget <= 0 || timeUp()) break
      budget--
      code = await handle(rr.gmailMsgId, { id: rr.id })
      if (code) break
    }
    if (!code && budget > 0 && !timeUp()) {
      // New messages in oldest-first time slices. Gmail lists newest first and a list is capped (2 pages), so a slice that
      // still has more pages is halved until it fits; the watermark moves to a slice's end only when that slice was listed
      // completely and every fresh message in it was handled, otherwise only to the newest message handled (a prefix).
      const queries = await S.loadReceiptQueries(db)
      const nowMs = clock().getTime()
      const nowSec = Math.floor(nowMs / 1000)
      let cursor = afterBound(S.watermarkMs(conn), nowMs, intVar(env.RECEIPTS_BACKFILL_DAYS, 14))
      let len = SLICE_S
      const maxLists = deps.maxLists ?? MAX_LISTS_PER_RUN
      for (let lists = 0; lists < maxLists && cursor <= nowSec && budget > 0 && !timeUp();) {
        const end = cursor + len
        const open = end > nowSec // the last slice has no upper bound
        const listed = await gmail.listMessageIds(buildReceiptQuery(queries, cursor, open ? undefined : end), { pageSize: 100, maxPages: 2 })
        lists++
        if (listed.more && len > MIN_SLICE_S) {
          len = Math.max(MIN_SLICE_S, Math.floor(len / 2))
          continue
        }
        counts.listed += listed.ids.length
        const { fresh } = await S.filterNewMessageIds(db, connectionId, listed.ids)
        let complete = true
        let sliceNewest = 0
        for (const gid of fresh.reverse()) {
          if (budget <= 0 || timeUp()) {
            complete = false
            break
          }
          budget--
          handledMs = 0
          code = await handle(gid, null)
          sliceNewest = Math.max(sliceNewest, handledMs)
          if (code) {
            complete = false
            break
          }
        }
        // A slice already at the shortest length that still has more pages was listed newest first and cut: its oldest
        // messages were never seen, so it is not complete and the watermark stays at the newest message handled.
        if (!complete || listed.more) {
          wmMs = Math.max(wmMs, sliceNewest)
          break
        }
        wmMs = Math.max(wmMs, open ? sliceNewest : end * 1000)
        if (open) break
        cursor = end - 1 // one second of overlap; stored ids are skipped
        len = Math.min(SLICE_S, len * 2) // a slice that fit says the mail is thinner here: grow back toward a week
      }
    }
  } catch (e) {
    if (e instanceof GmailError) {
      code = e.code
      if (e.code === 'needs_reconnect') await S.setConnectionStatus(db, connectionId, 'needs_reconnect', 'needs_reconnect', clock(), conn.tokenCt)
    } else {
      code = 'run_failed'
    }
  }

  // Re-match open receipts, mark stale, then auto-apply (off unless RECEIPTS_AUTO_APPLY is "1"). Runs after a stop too,
  // but not after a disconnect (not_active): nothing is suggested or applied for a person who has left.
  if (code !== 'needs_reconnect' && code !== 'not_active') {
    try {
      await rematch(env, { kind: 'connection', connectionId }, clock(), counts)
    } catch {
      code = code ?? 'match_failed'
    }
  }
  return { code, watermarkAt: wmMs > 0 ? new Date(wmMs).toISOString() : null }
}


/**
 * Re-match one scope's open receipts (an email connection's, or one person's uploads), mark stale, then auto-apply.
 * Auto-apply only ever runs for an email connection and only when RECEIPTS_AUTO_APPLY is "1": an upload is
 * never auto-applied (the SQL also holds source = 'email'). Fills `counts` as it goes when given.
 */
export async function rematch(env: Env, scope: S.ReceiptScope, now: Date, counts?: S.RunCounts): Promise<{ suggested: number; autoApplied: number }> {
  const db = env.BUDGET_DB
  const enabled = scope.kind === 'connection' && S.autoApplyEnabled(env.RECEIPTS_AUTO_APPLY)
  const minScore = intVar(env.RECEIPTS_AUTO_MIN_SCORE, 90)
  const open = await S.loadOpenReceipts(db, scope, now)
  const { rows, takenTxnIds } = await S.loadCandidateRows(db, open)
  const appliedSiblings = await S.loadAppliedSiblings(db, scope, open)
  const results = matchReceipts(open, rows, { autoApply: enabled, autoMinScore: minScore }, { takenTxnIds, appliedSiblings })
  const written = await S.writeMatchResults(db, results, now)
  if (counts) counts.matched = written.suggested
  await S.markStale(db, scope, now)
  const autoApplied = await S.autoApplyMatches(db, written.proposals, now, { enabled, minScore })
  if (counts) counts.autoApplied = autoApplied
  return { suggested: written.suggested, autoApplied }
}

// ---------- photo uploads ----------

export type UploadReadOutcome = 'read' | 'failed' | 'stop'
export interface UploadReadResult { outcome: UploadReadOutcome; code: string | null }

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/**
 * Read one stored upload with the model and fill its row. A model answer that does not validate, or an image that is gone,
 * costs one attempt (3 and the row is 'error'). An API stop (limit, outage, rejected, bad key) costs nothing and ends the
 * caller's loop: the next run tries again. Never throws on a model or store failure.
 */
export async function readUpload(env: Env, row: S.UploadRow, ctx: { apiKey: string; categoryIds: readonly string[]; fetch: typeof fetch; now: () => Date }): Promise<UploadReadResult> {
  const db = env.BUDGET_DB
  const store = selectImageStore(env)
  if (!store) return { outcome: 'stop', code: 'store_missing' }
  let bytes: Uint8Array | null = null
  if (row.imageKey) {
    try { bytes = await store.get(row.imageKey) } catch { return { outcome: 'stop', code: 'store_failed' } }
  }
  if (!bytes) {
    await S.recordFailure(db, row.id, 'image_missing', ctx.now())
    return { outcome: 'failed', code: 'image_missing' }
  }
  const model = env.RECEIPTS_MODEL?.trim() || 'claude-haiku-5-5'
  const r = await extractReceiptImage({ jpegB64: toBase64(bytes), uploadDate: row.emailDate, categoryIds: ctx.categoryIds }, { apiKey: ctx.apiKey, model }, ctx.fetch)
  if (!r.ok) {
    if (r.code === 'extract_invalid') {
      await S.recordFailure(db, row.id, 'extract_invalid', ctx.now())
      return { outcome: 'failed', code: 'extract_invalid' }
    }
    return { outcome: 'stop', code: r.reason ?? 'api_unavailable' }
  }
  await S.completeReceipt(db, row.id, r.receipt, r.model, null, ctx.now())
  return { outcome: 'read', code: null }
}

export interface UploadRunResult { read: number; failed: number; matched: number; code: string | null }

/** Most uploads one cron pass retries (a retry is one model call; attempts are capped at 3 per row). */
const UPLOAD_RETRY_BATCH = 10

/**
 * Cron retry of uploads that are pending or errored (under 3 attempts), then a re-match for each person whose upload was read.
 * Never auto-applies. Uploaders no longer on the allowlist are left alone. Never throws.
 */
export async function runUploads(env: Env, deps: RunDeps = {}): Promise<UploadRunResult> {
  const clock = deps.now ?? (() => new Date())
  const db = env.BUDGET_DB
  const out: UploadRunResult = { read: 0, failed: 0, matched: 0, code: null }
  try {
    if (!selectImageStore(env)) return out // uploads are not set up: nothing stored, nothing to retry
    const rows = await S.loadUploadRetries(db, Math.min(UPLOAD_RETRY_BATCH, Math.max(1, Math.floor(intVar(env.RECEIPTS_MAX_PER_RUN, 60)))))
    if (rows.length === 0) return out
    const [apiKey, allowed] = await Promise.all([readSecret(env.RECEIPTS_ANTHROPIC_KEY), allowedEmails(env)])
    if (!apiKey || allowed === null) { out.code = 'secrets_missing'; return out }
    const categoryIds = (await db.prepare(CATEGORIES_SQL).all<{ id: string }>()).results.map((c) => c.id)
    const startedMs = clock().getTime()
    const people = new Set<string>()
    for (const row of rows) {
      if (deps.budgetMs !== undefined && clock().getTime() - startedMs >= deps.budgetMs) break
      if (!allowed.has(row.uploaderEmail)) continue
      const r = await readUpload(env, row, { apiKey, categoryIds, fetch: deps.fetch ?? fetch, now: clock })
      if (r.outcome === 'stop') { out.code = r.code; break }
      if (r.outcome === 'read') { out.read++; people.add(row.uploaderEmail) } else out.failed++
    }
    for (const email of people) {
      try { out.matched += (await rematch(env, { kind: 'upload', email }, clock())).suggested } catch { out.code = out.code ?? 'match_failed' }
    }
  } catch {
    out.code = out.code ?? 'run_failed'
  }
  log('uploads_done', { read: out.read, failed: out.failed, matched: out.matched }, out.code)
  return out
}

/** Most images one sweep deletes; the rest go in the next day's sweep. */
const SWEEP_BATCH = 50

/**
 * Daily retention: delete stored images older than RECEIPTS_IMAGE_KEEP_DAYS and clear the row's image_key. The row, its facts,
 * its matches and its hash stay. An image whose delete failed keeps its key and is tried again next time. Never throws.
 */
export async function sweepImages(env: Env, deps: RunDeps = {}): Promise<{ swept: number; code: string | null }> {
  const clock = deps.now ?? (() => new Date())
  let swept = 0
  let code: string | null = null
  try {
    const store = selectImageStore(env)
    if (!store) return { swept, code }
    const now = clock()
    const cutoff = new Date(now.getTime() - keepDays(env.RECEIPTS_IMAGE_KEEP_DAYS) * 86_400_000)
    for (const img of await S.loadExpiredImages(env.BUDGET_DB, cutoff, SWEEP_BATCH)) {
      try {
        await store.delete(img.imageKey)
        await S.clearImageKey(env.BUDGET_DB, img.id, now)
        swept++
      } catch {
        code = 'sweep_partial'
      }
    }
  } catch {
    code = 'sweep_failed'
  }
  log('image_sweep', { swept }, code)
  return { swept, code }
}
