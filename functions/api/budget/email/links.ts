/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/email/links: the applied receipt of each transaction on screen, for the Receipt block (plan
// section 4, decisions file: sharing). Body `{txnIds: [id]}`, at most 200 ids. One read-only query: the keyed
// json_each(?) list drives idx_match_applied (or idx_match_txn), then receipts, email_connections (primary key),
// receipt_items (primary key prefix) and categories (primary key). Suggested, rejected and superseded matches never
// come back.
//
// Visibility, by the RECEIPTS_SHARE var (default `none`):
//   none            only the caller's own receipts
//   fields          every listed person's receipt fields; `gmailMsgId` only to the mailbox owner
//   fields_and_link every listed person's fields and `gmailMsgId`
// Never returned: tokens, key_id, the Google sub, any email address, connection ids, or raw email text.

import { budgetJson, type BudgetEnv } from '../../../_lib/budgetAccess'
import { badRequest, defineRoute, readJsonObject } from '../../../_lib/budgetDb'

export const MAX_LINK_TXNS = 200
const TXN_ID_RE = /^[0-9a-f]{32}$/
const MAX_BODY_BYTES = 16 * 1024

export type ShareMode = 'none' | 'fields' | 'fields_and_link'

export function shareMode(raw: unknown): ShareMode {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return v === 'fields' || v === 'fields_and_link' ? v : 'none'
}

export const LINKS_SQL = `SELECT m.txn_id AS txn_id, r.merchant AS merchant, coalesce(r.receipt_date, r.email_date) AS date,
       r.total_cents AS total_cents, r.tax_cents AS tax_cents, r.currency AS currency, r.order_ref AS order_ref,
       r.card_last4 AS card_last4, r.gmail_msg_id AS gmail_msg_id, (c.owner_email = ?) AS mine,
       i.seq AS seq, i.description AS description, i.quantity AS quantity, i.amount_cents AS amount_cents,
       i.category_hint AS category_id, k.label AS category_label
  FROM json_each(?) j
  JOIN receipt_matches m ON m.txn_id = j.value AND m.status = 'applied'
  JOIN receipts r ON r.id = m.receipt_id
  JOIN email_connections c ON c.id = r.connection_id
  LEFT JOIN receipt_items i ON i.receipt_id = r.id
  LEFT JOIN categories k ON k.id = i.category_hint
 WHERE (? = 1 OR c.owner_email = ?)`

interface LinkRow {
  txn_id: string
  merchant: string | null
  date: string | null
  total_cents: number | null
  tax_cents: number | null
  currency: string | null
  order_ref: string | null
  card_last4: string | null
  gmail_msg_id: string
  mine: number
  seq: number | null
  description: string | null
  quantity: number | null
  amount_cents: number | null
  category_id: string | null
  category_label: string | null
}

export interface ReceiptLinkItem {
  description: string
  quantity: number | null
  amountCents: number | null
  categoryId: string | null
  category: string | null
}
export interface ReceiptLink {
  merchant: string | null
  date: string | null
  totalCents: number | null
  taxCents: number | null
  currency: string | null
  orderRef: string | null
  cardLast4: string | null
  items: ReceiptLinkItem[]
  gmailMsgId?: string
}

export function parseTxnIds(body: Record<string, unknown>): string[] {
  const ids = body.txnIds
  if (!Array.isArray(ids)) throw badRequest('txnIds: expected an array')
  if (ids.length > MAX_LINK_TXNS) throw badRequest(`txnIds: at most ${MAX_LINK_TXNS}`)
  for (const id of ids) if (typeof id !== 'string' || !TXN_ID_RE.test(id)) throw badRequest('txnIds: each id must be a 32-character hex string')
  return [...new Set(ids as string[])]
}

export const onRequest = defineRoute({
  POST: async (ctx) => {
    const env = ctx.env as BudgetEnv & { RECEIPTS_SHARE?: string }
    const ids = parseTxnIds(await readJsonObject(ctx.request, MAX_BODY_BYTES))
    if (ids.length === 0) return budgetJson(200, { links: {} })
    const mode = shareMode(env.RECEIPTS_SHARE)
    const email = ctx.data.budgetEmail!
    const { results } = await env
      .BUDGET_DB!.prepare(LINKS_SQL)
      .bind(email, JSON.stringify(ids), mode === 'none' ? 0 : 1, email)
      .all<LinkRow>()
    const links: Record<string, ReceiptLink> = {}
    const seqs = new Map<string, number[]>()
    for (const r of results) {
      let link = links[r.txn_id]
      if (!link) {
        link = links[r.txn_id] = {
          merchant: r.merchant,
          date: r.date,
          totalCents: r.total_cents,
          taxCents: r.tax_cents,
          currency: r.currency,
          orderRef: r.order_ref,
          cardLast4: r.card_last4,
          items: [],
        }
        if (r.mine === 1 || mode === 'fields_and_link') link.gmailMsgId = r.gmail_msg_id
      }
      if (r.seq !== null && r.description !== null) {
        link.items.push({ description: r.description, quantity: r.quantity, amountCents: r.amount_cents, categoryId: r.category_id, category: r.category_label })
        const list = seqs.get(r.txn_id) ?? []
        list.push(r.seq)
        seqs.set(r.txn_id, list)
      }
    }
    // Items come back in line order (seq), without an ORDER BY temp b-tree in the query.
    for (const [txn, link] of Object.entries(links)) {
      const order = seqs.get(txn) ?? []
      const idx = link.items.map((_, n) => n).sort((a, b) => order[a] - order[b])
      link.items = idx.map((n) => link.items[n])
    }
    return budgetJson(200, { links })
  },
})
