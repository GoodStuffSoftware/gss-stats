/// <reference types="@cloudflare/workers-types" />
//
// Receipts review list and apply: the Pages-side D1 queries behind /api/budget/email/receipts, /receipts/[id] and /apply
// (plan sections 4 and 7, decisions (l)). Every statement is scoped to the caller's own connection through
// `email_connections.owner_email` (UNIQUE), so one person never reads or writes the other's receipts.
// Apply sets the CATEGORY only (never `note`), reuses the category_edits insert (EDITS_FROM_JSON_SQL) and the person-edit
// test (personEditSql) of the rule engine, and never moves a manual or person-edited row (it links the receipt only).

import { nextStamp, EDITS_FROM_JSON_SQL, personEditSql, badRequest } from './budgetDb'

export const MAX_APPLY = 50
export const MAX_LIST = 100
export const DEFAULT_LIST = 50
export const LIST_STATUSES = ['suggested', 'unmatched', 'applied'] as const
export type ListStatus = (typeof LIST_STATUSES)[number]

export const RECEIPT_ID_RE = /^r[0-9a-f]{16}$/
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2})\|(r[0-9a-f]{16})$/

type Row = Record<string, unknown>

// ---------- cursor -------------------------------------------------------------------------------

export function encodeReceiptCursor(emailDate: string, id: string): string {
  return btoa(`${emailDate}|${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function decodeReceiptCursor(cursor: string): { emailDate: string; id: string } {
  let text = ''
  try {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(cursor)) throw new Error('shape')
    text = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    throw badRequest('cursor: not a valid cursor')
  }
  const m = CURSOR_RE.exec(text)
  if (!m) throw badRequest('cursor: not a valid cursor')
  return { emailDate: m[1], id: m[2] }
}

// ---------- the review list ----------------------------------------------------------------------

const OWN_CONN = '(SELECT id FROM email_connections WHERE owner_email = ?1)'
const LIST_COLUMNS = 'r.id, r.email_date, r.status, r.kind, r.merchant, r.payment_via, r.card_last4, r.order_ref, r.receipt_date, r.related_date, '
  + 'r.currency, r.total_cents, r.tax_cents, r.shipping_cents, r.gmail_msg_id, r.source, r.image_key'

/** One arm of the list: newest first, LIMIT applied inside so each arm reads only what the page needs. */
const listArm = (where: string, withCursor: boolean): string =>
  `SELECT * FROM (SELECT ${LIST_COLUMNS} FROM receipts r WHERE ${where} AND r.status = ?2`
  + (withCursor ? ' AND (r.email_date, r.id) < (?4, ?5)' : '')
  + ' ORDER BY r.email_date DESC, r.id DESC LIMIT ?3)'

/**
 * The review list is a UNION ALL of two index-served arms, merged by (email_date, id): the email arm on idx_rcpt_review
 * (connection_id, status, email_date, id) and the upload arm on idx_rcpt_up_review (uploader_email, status, email_date, id).
 * Each arm is a reverse index scan with the keyset cursor and LIMIT; only the merge of at most 2 x LIMIT rows sorts.
 */
export function listSql(withCursor: boolean): string {
  return `${listArm(`r.connection_id = ${OWN_CONN}`, withCursor)} UNION ALL ${listArm('r.uploader_email = ?1', withCursor)}`
    + ' ORDER BY email_date DESC, id DESC LIMIT ?3'
}

/** The caller's own photos in every state, newest upload first: one bounded read on idx_rcpt_up_day (uploader_email, created_at), no sort. */
export const PHOTOS_SQL = `SELECT ${LIST_COLUMNS} FROM receipts r WHERE r.uploader_email = ?1 AND r.source = 'upload' ORDER BY r.created_at DESC LIMIT ?2`
/** Whether the caller has any photo (any state): an existence probe on idx_rcpt_up_day. */
export const HAS_UPLOADS_SQL = `SELECT EXISTS (SELECT 1 FROM receipts WHERE uploader_email = ?1 AND source = 'upload') AS has_uploads`

export const LIST_MATCHES_SQL = `SELECT m.id, m.receipt_id, m.txn_id, m.group_key, m.rule, m.share_cents, m.score, m.status, m.proposed_category_id,
  t.posted_date, t.amount_cents, t.merchant_name, t.category_id, t.category_source, t.needs_review, t.updated_at, a.label AS account_label,
  ${personEditSql('t')} AS person_edit,
  EXISTS (SELECT 1 FROM receipt_matches o WHERE o.txn_id = m.txn_id AND o.status = 'applied' AND o.id <> m.id) AS linked_other
FROM receipt_matches m JOIN transactions t ON t.id = m.txn_id JOIN accounts a ON a.id = t.account_id
WHERE m.receipt_id IN (SELECT value FROM json_each(?1)) AND m.status IN ('suggested', 'applied')
ORDER BY m.receipt_id, m.score DESC, m.id`

export const LIST_ITEMS_SQL = `SELECT receipt_id, seq, description, amount_cents, quantity, category_hint FROM receipt_items
WHERE receipt_id IN (SELECT value FROM json_each(?1)) ORDER BY receipt_id, seq`

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))

/** The photo tab: up to `limit` of the caller's newest uploads, whatever their state (so each can be deleted); one page, no cursor. */
export async function loadOwnPhotos(db: D1Database, email: string, limit: number): Promise<{ receipts: unknown[]; nextCursor: string | null }> {
  const rows = (await db.prepare(PHOTOS_SQL).bind(email, limit).all<Row>()).results
  return { receipts: rows.length ? await hydrateReceipts(db, rows) : [], nextCursor: null }
}

export async function loadReceiptList(
  db: D1Database, email: string, status: ListStatus, limit: number, cursor: { emailDate: string; id: string } | null,
): Promise<{ receipts: unknown[]; nextCursor: string | null }> {
  const stmt = cursor
    ? db.prepare(listSql(true)).bind(email, status, limit + 1, cursor.emailDate, cursor.id)
    : db.prepare(listSql(false)).bind(email, status, limit + 1)
  const all = (await stmt.all<Row>()).results
  const rows = all.slice(0, limit)
  const nextCursor = all.length > limit && rows.length > 0 ? encodeReceiptCursor(String(rows[rows.length - 1].email_date), String(rows[rows.length - 1].id)) : null
  if (rows.length === 0) return { receipts: [], nextCursor: null }
  return { receipts: await hydrateReceipts(db, rows), nextCursor }
}

export const imageUrlFor = (id: string): string => `/api/budget/uploads/${id}/image`

/** One of the caller's own upload receipts in the review-list row shape (null when missing or not theirs: one PK read). */
export async function loadOwnUpload(db: D1Database, id: string, email: string): Promise<{ status: string; row: unknown | null } | null> {
  const r = await db.prepare(`SELECT ${LIST_COLUMNS} FROM receipts r WHERE r.id = ?1 AND r.source = 'upload' AND r.uploader_email = ?2`).bind(id, email).first<Row>()
  if (!r) return null
  const status = String(r.status)
  if (status === 'pending') return { status, row: null }
  return { status, row: (await hydrateReceipts(db, [r]))[0] }
}

/** Who may fetch an upload's photo: the uploader, or (RECEIPTS_SHARE not none, RECEIPTS_IMAGE_SHARE both) another listed person once the receipt is applied. */
export async function mayViewImage(db: D1Database, id: string, email: string, shareFields: boolean, imageShareBoth: boolean): Promise<boolean> {
  const r = await db.prepare("SELECT status, image_key, uploader_email FROM receipts WHERE id = ?1 AND source = 'upload'").bind(id).first<Row>()
  if (!r || r.image_key === null || r.image_key === undefined) return false
  if (r.uploader_email === email) return true
  return shareFields && imageShareBoth && r.status === 'applied'
}

/** Whether the caller uploaded this receipt (one PK read). */
export async function isUploader(db: D1Database, id: string, email: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM receipts WHERE id = ?1 AND source = 'upload' AND uploader_email = ?2").bind(id, email).first()) !== null
}

async function hydrateReceipts(db: D1Database, rows: Row[]): Promise<unknown[]> {
  const ids = JSON.stringify(rows.map((r) => String(r.id)))
  const [matches, items] = await db.batch([db.prepare(LIST_MATCHES_SQL).bind(ids), db.prepare(LIST_ITEMS_SQL).bind(ids)])
  const mBy = new Map<string, unknown[]>()
  for (const m of matches.results as Row[]) {
    const protectedBy = m.category_source === 'manual' ? 'manual' : Number(m.person_edit) === 1 ? 'person_edit' : null
    const out = {
      matchId: Number(m.id), txnId: String(m.txn_id), groupKey: String(m.group_key), rule: String(m.rule), shareCents: Number(m.share_cents),
      score: Number(m.score), status: String(m.status), proposedCategoryId: s(m.proposed_category_id),
      linkedOther: Number(m.linked_other) === 1, categoryProtectedBy: protectedBy,
      txn: {
        postedDate: String(m.posted_date), amountCents: Number(m.amount_cents), merchantName: String(m.merchant_name), accountLabel: String(m.account_label),
        categoryId: s(m.category_id), categorySource: String(m.category_source), needsReview: Number(m.needs_review) === 1, updatedAt: String(m.updated_at),
      },
    }
    const k = String(m.receipt_id)
    mBy.set(k, [...(mBy.get(k) ?? []), out])
  }
  const iBy = new Map<string, unknown[]>()
  for (const i of items.results as Row[]) {
    const k = String(i.receipt_id)
    iBy.set(k, [...(iBy.get(k) ?? []), { seq: Number(i.seq), description: String(i.description), amountCents: num(i.amount_cents), quantity: num(i.quantity), categoryHint: s(i.category_hint) }])
  }
  return rows.map((r) => {
    const upload = r.source === 'upload'
    const hasImage = r.image_key !== null && r.image_key !== undefined
    return {
      id: String(r.id), emailDate: String(r.email_date), status: String(r.status), kind: s(r.kind), merchant: s(r.merchant), paymentVia: s(r.payment_via),
      cardLast4: s(r.card_last4), orderRef: s(r.order_ref), receiptDate: s(r.receipt_date), relatedDate: s(r.related_date), currency: s(r.currency),
      totalCents: num(r.total_cents), taxCents: num(r.tax_cents), shippingCents: num(r.shipping_cents),
      ...(upload ? {} : { gmailMsgId: String(r.gmail_msg_id) }),
      source: upload ? 'upload' : 'email', hasImage, mine: true, // this list only ever holds the caller's own rows
      ...(hasImage ? { imageUrl: imageUrlFor(String(r.id)) } : {}),
      items: iBy.get(String(r.id)) ?? [], matches: mBy.get(String(r.id)) ?? [],
    }
  })
}

// ---------- dismiss ------------------------------------------------------------------------------

export const OWN_RECEIPT_SQL = `SELECT r.status FROM receipts r WHERE r.id = ?1 AND (r.connection_id = (SELECT id FROM email_connections WHERE owner_email = ?2) OR r.uploader_email = ?2)`

/** Dismiss (suggested or unmatched -> dismissed) or undo (dismissed -> suggested when a suggestion is left, else unmatched). Returns the new status, or null on a state mismatch. */
export async function setDismissed(db: D1Database, id: string, email: string, dismissed: boolean, now = new Date().toISOString()): Promise<{ found: boolean; status: string | null }> {
  const cur = await db.prepare(OWN_RECEIPT_SQL).bind(id, email).first<{ status: string }>()
  if (!cur) return { found: false, status: null }
  const from = dismissed ? ['suggested', 'unmatched'] : ['dismissed']
  if (!from.includes(cur.status)) return { found: true, status: null }
  const to = dismissed ? "'dismissed'" : "CASE WHEN EXISTS (SELECT 1 FROM receipt_matches m WHERE m.receipt_id = receipts.id AND m.status = 'suggested') THEN 'suggested' ELSE 'unmatched' END"
  const res = await db.prepare(
    `UPDATE receipts SET status = ${to}, updated_at = ?3, updated_by = ?2
      WHERE id = ?1 AND status = ?4 AND (connection_id = (SELECT id FROM email_connections WHERE owner_email = ?2) OR uploader_email = ?2)`,
  ).bind(id, email, now, cur.status).run()
  if (Number(res.meta?.changes ?? 0) === 0) return { found: true, status: null }
  const after = await db.prepare(OWN_RECEIPT_SQL).bind(id, email).first<{ status: string }>()
  return { found: true, status: after?.status ?? null }
}

// ---------- apply --------------------------------------------------------------------------------

export interface ApplyItem { matchId: number; expectedUpdatedAt: string; categoryId?: string | null }
export type SkipReason = 'not_found' | 'not_suggested' | 'stale' | 'txn_linked' | 'incomplete_group' | 'group_blocked' | 'conflict'
export interface ApplyResult {
  applied: Array<{ matchId: number; txnId: string; categorySet: boolean; categoryKept: 'manual' | 'person_edit' | null; updatedAt: string }>
  rejected: number[]
  skipped: Array<{ matchId: number; reason: SkipReason; currentUpdatedAt?: string }>
}

export const APPLY_READ_SQL = `SELECT m.id AS match_id, m.receipt_id, m.txn_id, m.group_key, m.rule, m.status AS match_status, m.proposed_category_id,
  r.status AS receipt_status, t.updated_at, t.category_id, t.category_source, t.kind,
  ${personEditSql('t')} AS person_edit,
  EXISTS (SELECT 1 FROM receipt_matches o WHERE o.txn_id = m.txn_id AND o.status = 'applied') AS linked
FROM receipt_matches m JOIN receipts r ON r.id = m.receipt_id
  LEFT JOIN email_connections c ON c.id = r.connection_id
  JOIN transactions t ON t.id = m.txn_id
WHERE m.id IN (SELECT value FROM json_each(?1)) AND (c.owner_email = ?2 OR r.uploader_email = ?2)`

/** The suggested sibling parts of split_charges groups (one receipt over several bank rows): all apply or none. */
export const GROUP_SIBLINGS_SQL = `SELECT id, receipt_id, group_key FROM receipt_matches
WHERE receipt_id IN (SELECT value FROM json_each(?1)) AND rule = 'split_charges' AND status = 'suggested'`

const NOT_LINKED = `NOT EXISTS (SELECT 1 FROM receipt_matches o WHERE o.txn_id = transactions.id AND o.status = 'applied')`
/** One receipt links to one bank row, except the parts of one split_charges group: true when another match of `mm`'s receipt is already applied. */
const receiptLinkedElsewhere = (mm: string): string => `EXISTS (SELECT 1 FROM receipt_matches o WHERE o.receipt_id = ${mm}.receipt_id AND o.status = 'applied' AND o.id <> ${mm}.id
    AND NOT (${mm}.rule = 'split_charges' AND o.rule = 'split_charges' AND o.group_key = ${mm}.group_key))`
const matchOpen = (mid: string): string => `EXISTS (SELECT 1 FROM receipt_matches mm WHERE mm.id = ${mid} AND mm.status = 'suggested' AND NOT ${receiptLinkedElsewhere('mm')})`
const MATCH_OPEN = matchOpen(`json_extract(j.value, '$.mid')`)

/** The audit insert is the rule engine's own (EDITS_FROM_JSON_SQL), narrowed to rows whose match is still open and unlinked. */
export const APPLY_EDITS_SQL = `${EDITS_FROM_JSON_SQL}
WHERE ${MATCH_OPEN} AND NOT EXISTS (SELECT 1 FROM receipt_matches o WHERE o.txn_id = t.id AND o.status = 'applied')`

/** Category only: no note, kind, amount, date or pairing. A person apply is a manual edit by the caller (plan section 3). */
export const APPLY_UPDATE_SQL = `WITH ch AS (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.prev') AS prev, json_extract(value, '$.stamp') AS stamp,
  json_extract(value, '$.cat') AS cat, json_extract(value, '$.mid') AS mid FROM json_each(?1))
UPDATE transactions SET category_id = ch.cat, category_source = 'manual', rule_id = NULL, needs_review = 0, review_reason = NULL, confidence = 100,
  updated_at = ch.stamp, updated_by = ?2
FROM ch WHERE transactions.id = ch.id AND transactions.updated_at = ch.prev AND ${NOT_LINKED}
  AND ${matchOpen('ch.mid')}`

export const APPLY_MATCH_SQL = `WITH ch AS (SELECT json_extract(value, '$.mid') AS mid, json_extract(value, '$.want') AS want FROM json_each(?1))
UPDATE receipt_matches SET status = 'applied', decided_at = ?3, decided_by = ?2
FROM ch WHERE receipt_matches.id = ch.mid AND receipt_matches.status = 'suggested'
  AND EXISTS (SELECT 1 FROM transactions t WHERE t.id = receipt_matches.txn_id AND t.updated_at = ch.want)
  AND NOT EXISTS (SELECT 1 FROM receipt_matches o WHERE o.txn_id = receipt_matches.txn_id AND o.status = 'applied')
  AND NOT ${receiptLinkedElsewhere('receipt_matches')}`

/** After an apply, the receipt's other open suggestions (a tie, a second equal charge) are moot: superseded, in the same batch. */
export const SUPERSEDE_LEFTOVER_SQL = `UPDATE receipt_matches SET status = 'superseded', decided_at = ?3, decided_by = ?2
WHERE status = 'suggested' AND receipt_id IN (SELECT receipt_id FROM receipt_matches WHERE id IN (SELECT value FROM json_each(?1)) AND status = 'applied')
  AND ${receiptLinkedElsewhere('receipt_matches')}`

export const APPLY_RECEIPT_SQL = `UPDATE receipts SET status = 'applied', updated_at = ?3, updated_by = ?2
WHERE id IN (SELECT receipt_id FROM receipt_matches WHERE id IN (SELECT value FROM json_each(?1)) AND status = 'applied') AND status = 'suggested'`

export const REJECT_MATCH_SQL = `UPDATE receipt_matches SET status = 'rejected', decided_at = ?3, decided_by = ?2
WHERE id IN (SELECT value FROM json_each(?1)) AND status = 'suggested'`

export const REJECT_RECEIPT_SQL = `UPDATE receipts SET status = 'unmatched', updated_at = ?3, updated_by = ?2
WHERE id IN (SELECT receipt_id FROM receipt_matches WHERE id IN (SELECT value FROM json_each(?1))) AND status = 'suggested'
  AND NOT EXISTS (SELECT 1 FROM receipt_matches m WHERE m.receipt_id = receipts.id AND m.status IN ('suggested', 'applied'))`

export const READBACK_SQL = `SELECT id, status FROM receipt_matches WHERE id IN (SELECT value FROM json_each(?1))`

export async function applyReceipts(
  db: D1Database, email: string, items: ApplyItem[], reject: number[], categoryChecker: (ids: string[]) => Promise<(id: string) => void>, now: number = Date.now(),
): Promise<ApplyResult> {
  const ids = [...items.map((i) => i.matchId), ...reject]
  const read = (await db.prepare(APPLY_READ_SQL).bind(JSON.stringify(ids), email).all<Row>()).results
  const by = new Map(read.map((r) => [Number(r.match_id), r]))
  const skipped: ApplyResult['skipped'] = []
  const skip = (matchId: number, reason: SkipReason, currentUpdatedAt?: string): void => { skipped.push({ matchId, reason, ...(currentUpdatedAt ? { currentUpdatedAt } : {}) }) }

  // Sibling parts of split_charges groups: all parts must be in this request, all must pass.
  const splitReceipts = [...new Set(read.filter((r) => r.rule === 'split_charges').map((r) => String(r.receipt_id)))]
  const sibs = splitReceipts.length ? (await db.prepare(GROUP_SIBLINGS_SQL).bind(JSON.stringify(splitReceipts)).all<Row>()).results : []
  const wanted = new Set(items.map((i) => i.matchId))

  // One category read for the whole request: every category an item could write (an upper bound, before the skip checks);
  // an item that is skipped never trips the check, only a planned one does.
  const wantedCats = new Set<string>()
  for (const item of items) {
    const r = by.get(item.matchId)
    const c = item.categoryId === undefined ? (r ? s(r.proposed_category_id) : null) : item.categoryId
    if (c !== null && c !== '' && c !== 'uncategorized') wantedCats.add(c)
  }
  const validCategory = await categoryChecker([...wantedCats])

  interface Plan { item: ApplyItem; row: Row; cat: string | null; kept: 'manual' | 'person_edit' | null; stamp: string }
  const plans = new Map<number, Plan>()
  const txnTaken = new Set<string>()
  const receiptTaken = new Map<string, string>() // receipt id -> 'one' or 'split:<group>' (the match planned for it in this request)
  for (const item of items) {
    const r = by.get(item.matchId)
    if (!r) { skip(item.matchId, 'not_found'); continue }
    if (r.match_status !== 'suggested' || r.receipt_status !== 'suggested') { skip(item.matchId, 'not_suggested'); continue }
    if (String(r.updated_at) !== item.expectedUpdatedAt) { skip(item.matchId, 'stale', String(r.updated_at)); continue }
    if (Number(r.linked) === 1 || txnTaken.has(String(r.txn_id))) { skip(item.matchId, 'txn_linked'); continue }
    // One receipt, one bank row (split_charges parts of one group excepted): the first request item wins, the rest conflict.
    const rTag = r.rule === 'split_charges' ? `split:${String(r.group_key)}` : 'one'
    const rHeld = receiptTaken.get(String(r.receipt_id))
    if (rHeld !== undefined && !(rTag !== 'one' && rHeld === rTag)) { skip(item.matchId, 'conflict'); continue }
    const kept = r.category_source === 'manual' ? 'manual' : Number(r.person_edit) === 1 ? 'person_edit' : null
    let cat: string | null = item.categoryId === undefined ? s(r.proposed_category_id) : item.categoryId
    if (cat === '' || cat === 'uncategorized') cat = null
    if (kept || cat === s(r.category_id)) cat = null
    if (cat !== null) validCategory(cat)
    txnTaken.add(String(r.txn_id))
    receiptTaken.set(String(r.receipt_id), rTag)
    plans.set(item.matchId, { item, row: r, cat, kept, stamp: cat !== null ? nextStamp(String(r.updated_at), now) : String(r.updated_at) })
  }
  // split_charges: drop a part unless every sibling part is requested and still planned (repeat until stable).
  for (let changed = true; changed;) {
    changed = false
    for (const [id, p] of plans) {
      if (p.row.rule !== 'split_charges') continue
      const parts = sibs.filter((x) => x.receipt_id === p.row.receipt_id && x.group_key === p.row.group_key).map((x) => Number(x.id))
      const missing = parts.some((x) => !wanted.has(x))
      if (missing || parts.some((x) => !plans.has(x))) {
        plans.delete(id)
        skip(id, missing ? 'incomplete_group' : 'group_blocked')
        changed = true
      }
    }
  }

  const rejects: number[] = []
  for (const id of reject) {
    const r = by.get(id)
    if (!r) skip(id, 'not_found')
    else if (r.match_status !== 'suggested') skip(id, 'not_suggested')
    else rejects.push(id)
  }

  const iso = new Date(now).toISOString()
  const withCat = [...plans.values()].filter((p) => p.cat !== null)
  const edits = JSON.stringify(withCat.map((p) => ({
    id: p.row.txn_id, prev: p.row.updated_at, stamp: p.stamp, old_cat: p.row.category_id, cat: p.cat, old_kind: p.row.kind, kind: p.row.kind, rule_id: null, mid: p.item.matchId,
  })))
  const links = JSON.stringify([...plans.values()].map((p) => ({ mid: p.item.matchId, want: p.stamp })))
  const planIds = JSON.stringify([...plans.keys()])
  const stmts: D1PreparedStatement[] = []
  if (withCat.length) {
    stmts.push(db.prepare(APPLY_EDITS_SQL).bind(edits, email))
    stmts.push(db.prepare(APPLY_UPDATE_SQL).bind(edits, email))
  }
  if (plans.size) {
    stmts.push(db.prepare(APPLY_MATCH_SQL).bind(links, email, iso))
    stmts.push(db.prepare(APPLY_RECEIPT_SQL).bind(planIds, email, iso))
    stmts.push(db.prepare(SUPERSEDE_LEFTOVER_SQL).bind(planIds, email, iso))
  }
  if (rejects.length) {
    const rj = JSON.stringify(rejects)
    stmts.push(db.prepare(REJECT_MATCH_SQL).bind(rj, email, iso))
    stmts.push(db.prepare(REJECT_RECEIPT_SQL).bind(rj, email, iso))
  }
  if (stmts.length === 0) return { applied: [], rejected: [], skipped }
  stmts.push(db.prepare(READBACK_SQL).bind(JSON.stringify([...plans.keys(), ...rejects])))
  const results = await db.batch(stmts)
  const state = new Map((results[results.length - 1].results as Row[]).map((r) => [Number(r.id), String(r.status)]))

  const applied: ApplyResult['applied'] = []
  for (const [id, p] of plans) {
    if (state.get(id) === 'applied') applied.push({ matchId: id, txnId: String(p.row.txn_id), categorySet: p.cat !== null, categoryKept: p.kept, updatedAt: p.stamp })
    else skip(id, 'conflict')
  }
  const rejected = rejects.filter((id) => state.get(id) === 'rejected')
  for (const id of rejects) if (state.get(id) !== 'rejected') skip(id, 'conflict')
  return { applied, rejected, skipped }
}
