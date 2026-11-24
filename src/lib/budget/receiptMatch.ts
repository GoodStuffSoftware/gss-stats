// Receipt matcher (docs: email-receipts plan, section 7). Pure functions, no I/O: the Worker passes in the
// extracted receipts and the window's bank rows and gets back proposals with scores.
//
// Rules in one place:
//  - the amount is exact, in cents, against the absolute bank amount (no near matches);
//  - bank posted_date must fall in [base - 3, base + 10] days of the receipt date (refunds: +21), where base is
//    receipt_date, else email_date; day arithmetic is UTC day numbers, so no time zone or DST in it;
//  - score: exact amount 50; date 0-5 days +20 (6-10 +10); family +15; unique candidate +10; card_last4 equals
//    the account last4 +5; another equal candidate -30; split -20. Under 60 is not shown;
//  - splits (one order over 2-3 charges, or several receipts of one order summing to one charge) are suggest-only;
//  - nothing auto-applies at launch: AUTO_APPLY_DEFAULT is false and auto-apply needs rule 'exact', a unique
//    candidate, score >= AUTO_MIN_SCORE and a row no person has edited.
import { addDays, daysBetween, isIsoDate } from './dates'
import type { Cents, IsoDate } from './types'

// ---- constants ----------------------------------------------------------------------------------------------

/** Auto-apply is off at launch (RECEIPTS_AUTO_APPLY="0"). */
export const AUTO_APPLY_DEFAULT = false
/** Minimum score for auto-eligibility (RECEIPTS_AUTO_MIN_SCORE). */
export const AUTO_MIN_SCORE = 90
/** Under this score a candidate is not shown and the receipt stays unmatched. */
export const SHOW_MIN_SCORE = 60
export const PURCHASE_WINDOW = { before: 3, after: 10 } as const
export const REFUND_WINDOW = { before: 3, after: 21 } as const
/** Split search is bounded to this many candidate rows. */
export const SPLIT_CANDIDATE_LIMIT = 12
/** Most split proposals kept per receipt. */
const MAX_SPLIT_PROPOSALS = 5
/** Generic payment-service and platform words; no household merchant list lives in the repo. */
export const FAMILY_WORDS: readonly string[] = ['paypal', 'venmo', 'amazon', 'apple', 'google']
/** A row in one of these categories (or with none) takes a proposed category; any other is left alone. */
export const DEFAULT_CURRENCY = 'USD'

export const BROAD_CATEGORY_IDS: readonly string[] = ['other', 'shopping']

const SCORE = { amount: 50, dateNear: 20, dateFar: 10, family: 15, unique: 10, last4: 5, equalOther: -30, split: -20 } as const

// ---- types --------------------------------------------------------------------------------------------------

export type ReceiptKind = 'purchase' | 'refund' | 'subscription' | 'payment_sent' | 'payment_received' | 'decline' | 'other'
export type MatchRule = 'exact' | 'split_charges' | 'split_receipts' | 'refund' | 'decline_retry'
export type ReceiptOutcome = 'no_total' | 'unmatched' | 'suggested'

export interface ReceiptItem { description: string; amountCents: Cents | null; quantity?: number | null; categoryHint: string | null }
export interface ReceiptCharge { amountCents: Cents; last4?: string | null }

/** One extracted receipt. Dates may be 'YYYY-MM-DD' or a date-time string (see normalizeDate). */
export interface MatchReceipt {
  id: string
  kind: ReceiptKind | null
  merchant: string | null
  paymentVia: string | null
  cardLast4: string | null
  orderRef: string | null
  /** Sender domain of the email (the repeat-email guard's key when there is no order_ref). */
  senderDomain?: string | null
  /** ISO 4217 code as the email states it; null or absent = not stated (treated as the budget currency). */
  currency?: string | null
  emailDate: string
  receiptDate: string | null
  relatedDate: string | null
  totalCents: Cents | null
  charges: ReceiptCharge[]
  items: ReceiptItem[]
}

/** One bank row. amountCents is signed (negative = money out). */
export interface MatchBankRow {
  id: string
  accountId: string
  accountLast4: string | null
  postedDate: string
  amountCents: Cents
  kind: string
  merchantKey: string | null
  merchantName: string | null
  categoryId: string | null
  updatedAt: string
  /** True when a person has edited the row (a manual edit): never auto-applied. */
  personEdited: boolean
}

export interface MatchOptions {
  /** Default AUTO_APPLY_DEFAULT (false). */
  autoApply?: boolean
  /** Default AUTO_MIN_SCORE (90). */
  autoMinScore?: number
  /** Row categories that count as broad defaults; default BROAD_CATEGORY_IDS. */
  broadCategoryIds?: readonly string[]
  /** The budget's currency; default DEFAULT_CURRENCY. A receipt in another currency never matches a bank row. */
  currency?: string
}

export interface MatchPart { receiptId: string; txnId: string; shareCents: Cents; txnUpdatedAt: string }

export interface MatchProposal {
  rule: MatchRule
  /** Rows of one split proposal share it; at most 40 characters. */
  groupKey: string
  score: number
  /** Always 'suggested' here; applying is the store's job. */
  status: 'suggested'
  parts: MatchPart[]
  /** True when the receipt has exactly one candidate and no other receipt competes for the row. */
  unique: boolean
  split: boolean
  /** Only ever true when autoApply is on, rule 'exact', unique, score >= autoMinScore, row not person-edited. */
  autoEligible: boolean
  proposedCategoryId: string | null
  /** decline_retry only: rows (bank fees on the decline's day) the decline can explain. Never written to a note. */
  explainsTxnIds: string[]
}

export interface ReceiptMatchResult {
  receiptId: string
  status: ReceiptOutcome
  /** Shown proposals (score >= SHOW_MIN_SCORE), best first. */
  proposals: MatchProposal[]
  /** The single winner: set only when exactly one non-split candidate exists. Ties and ambiguity give null. */
  winner: MatchProposal | null
}

// ---- small helpers ------------------------------------------------------------------------------------------

/**
 * A date-only 'YYYY-MM-DD' or a date-time ('2026-03-01T23:30:00-08:00', '...Z', or with a space) becomes the
 * calendar date as written. A time zone is NOT converted: a receipt's printed date is the local date, and bank
 * posted dates are plain dates. Anything unreadable gives null.
 */
export function normalizeDate(s: unknown): IsoDate | null {
  if (typeof s !== 'string') return null
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s.trim())
  return m && isIsoDate(m[1]) ? m[1] : null
}

/** Integer cents from a number: float noise (1998.9999999999998) rounds; a real fraction (1999.5) is invalid (null). */
export function toCents(n: unknown): Cents | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null
  const r = Math.round(n)
  return Math.abs(n - r) < 1e-6 ? r : null
}

function tokens(s: string | null | undefined): string[] {
  return (s ?? '').toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3)
}

const GENERIC_TOKENS = new Set(['inc', 'llc', 'ltd', 'com', 'net', 'www', 'the', 'and', 'store', 'stores', 'shop', 'payment',
  'payments', 'online', 'purchase', 'order', 'debit', 'card', 'pos', 'ach', 'web', 'pmt', 'pymt'])

function familyOf(parts: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>()
  for (const p of parts) for (const t of tokens(p)) if (FAMILY_WORDS.includes(t)) out.add(t)
  return out
}

function receiptFamily(r: MatchReceipt): Set<string> {
  const f = familyOf([r.merchant])
  if (r.paymentVia && FAMILY_WORDS.includes(r.paymentVia)) f.add(r.paymentVia)
  return f
}

function rowFamily(b: MatchBankRow): Set<string> {
  return familyOf([b.merchantKey, b.merchantName])
}

/** Family match: a shared payment-service word, or token overlap between the receipt merchant and the row's key or name. */
function familyMatch(r: MatchReceipt, b: MatchBankRow): boolean {
  const rf = receiptFamily(r)
  const bf = rowFamily(b)
  for (const w of rf) if (bf.has(w)) return true
  const rt = new Set(tokens(r.merchant).filter((t) => !GENERIC_TOKENS.has(t) && !FAMILY_WORDS.includes(t)))
  if (rt.size === 0) return false
  for (const t of tokens(b.merchantKey).concat(tokens(b.merchantName))) if (rt.has(t)) return true
  return false
}

function isRefund(r: MatchReceipt): boolean { return r.kind === 'refund' }
function isDecline(r: MatchReceipt): boolean { return r.kind === 'decline' }

/** Base date for the window: receipt_date, else email_date. */
function baseDate(r: MatchReceipt): IsoDate | null {
  return normalizeDate(r.receiptDate) ?? normalizeDate(r.emailDate)
}

/** The amount charged: stated charges (their sum) when present, else total_cents. Null or non-positive = no total. */
export function chargedCents(r: Pick<MatchReceipt, 'charges' | 'totalCents'>): Cents | null {
  const charges = r.charges.map((c) => toCents(c.amountCents))
  if (charges.length > 0 && charges.every((c): c is number => c !== null && c > 0)) return charges.reduce((a, b) => a + b, 0)
  const t = toCents(r.totalCents)
  return t !== null && t > 0 ? t : null
}

/** The amounts a single bank row would show for this receipt when the receipt has one charge (or none stated). */
function singleAmount(r: MatchReceipt): Cents | null {
  const charges = r.charges.map((c) => toCents(c.amountCents))
  if (charges.length > 1) return null
  return chargedCents(r)
}

const PURCHASE_ROW_KINDS = new Set(['spend', 'fee', 'other', 'transfer_external'])
const RECEIVED_ROW_KINDS = new Set(['income', 'other', 'transfer_external'])

/** Whether a bank row can be the other side of this receipt, by direction and kind (not amount or date). */
function rowFits(r: MatchReceipt, b: MatchBankRow): boolean {
  if (isRefund(r)) return b.kind === 'refund' && b.amountCents > 0
  if (r.kind === 'payment_received') return b.amountCents > 0 && RECEIVED_ROW_KINDS.has(b.kind)
  if (b.amountCents >= 0 || !PURCHASE_ROW_KINDS.has(b.kind)) return false
  // Venmo: a payment sent matches only a bank debit that names the rail (a balance payment has no bank row).
  if (r.kind === 'payment_sent' && !rowFamily(b).has('venmo')) return false
  return true
}

function windowOf(r: MatchReceipt) { return isRefund(r) ? REFUND_WINDOW : PURCHASE_WINDOW }

/** Signed days from the receipt's base date to the row's posted date, or null when it falls outside the window. */
function dayOffset(r: MatchReceipt, b: MatchBankRow): number | null {
  const base = baseDate(r)
  const posted = normalizeDate(b.postedDate)
  if (!base || !posted) return null
  const d = daysBetween(base, posted)
  const w = windowOf(r)
  return d >= -w.before && d <= w.after ? d : null
}

function dateScore(d: number): number {
  const a = Math.abs(d)
  return a <= 5 ? SCORE.dateNear : a <= 10 ? SCORE.dateFar : 0
}

/**
 * Adds the uniqueness term to a base score: +10 for a unique candidate, else -30 ("another equal candidate").
 * An ambiguous candidate that would have been shown on its own (>= SHOW_MIN_SCORE with the unique bonus) is still
 * shown ("both at a lower score", plan section 7, never dropped) at SHOW_MIN_SCORE plus a quarter of the evidence
 * beyond the amount (date, family, card), so the stronger tie ranks first (60 to 70 for an exact candidate).
 */
function withUniqueness(base: number, unique: boolean): number {
  if (unique) return base + SCORE.unique
  if (base + SCORE.unique >= SHOW_MIN_SCORE) return SHOW_MIN_SCORE + Math.max(0, Math.round((base - SCORE.amount) / 4))
  return base + SCORE.equalOther
}

/** True when the receipt states a currency other than the budget's: its cents are not comparable with bank cents. */
function foreignCurrency(r: MatchReceipt, opts: MatchOptions): boolean {
  const c = typeof r.currency === 'string' ? r.currency.trim().toUpperCase() : ''
  return c !== '' && c !== (opts.currency ?? DEFAULT_CURRENCY).toUpperCase()
}

function clamp(n: number): number { return Math.max(0, Math.min(100, n)) }

/** Short deterministic hash (FNV-1a, 8 hex) for group keys. */
function hash8(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

function groupKey(prefix: string, ids: string[]): string {
  return `${prefix}_${hash8([...ids].sort().join('|'))}`
}

/** The category hint carrying most of the item amount (count breaks no ties); a tie or no hints gives null. */
export function dominantHint(items: readonly ReceiptItem[]): string | null {
  const sums = new Map<string, { amt: number; n: number }>()
  for (const it of items) {
    if (!it.categoryHint) continue
    const e = sums.get(it.categoryHint) ?? { amt: 0, n: 0 }
    e.amt += Math.abs(it.amountCents ?? 0)
    e.n += it.quantity ?? 1
    sums.set(it.categoryHint, e)
  }
  const ranked = [...sums.entries()].sort((a, b) => b[1].amt - a[1].amt || b[1].n - a[1].n)
  if (ranked.length === 0) return null
  if (ranked.length > 1 && ranked[0][1].amt === ranked[1][1].amt && ranked[0][1].n === ranked[1][1].n) return null
  return ranked[0][0]
}

function proposedCategory(hint: string | null, row: MatchBankRow, opts: MatchOptions): string | null {
  if (!hint || row.personEdited) return null
  const broad = opts.broadCategoryIds ?? BROAD_CATEGORY_IDS
  if (row.categoryId === null || broad.includes(row.categoryId)) return hint === row.categoryId ? null : hint
  return null
}

// ---- matching -----------------------------------------------------------------------------------------------

interface Cand { row: MatchBankRow; offset: number }

function exactCandidates(r: MatchReceipt, rows: readonly MatchBankRow[], taken: ReadonlySet<string>): Cand[] {
  const amt = singleAmount(r)
  if (amt === null) return []
  const out: Cand[] = []
  for (const b of rows) {
    if (taken.has(b.id) || !rowFits(r, b)) continue
    if (Math.abs(toCents(b.amountCents) ?? NaN) !== amt) continue
    const off = dayOffset(r, b)
    if (off !== null) out.push({ row: b, offset: off })
  }
  return out
}

function hintFor(r: MatchReceipt, all: readonly MatchReceipt[]): string | null {
  const own = dominantHint(r.items)
  if (!isRefund(r) || !r.orderRef) return own
  // A refund takes its category from the original receipt (same order_ref) when one is stored.
  const orig = all.find((o) => o.id !== r.id && o.orderRef === r.orderRef && !isRefund(o) && dominantHint(o.items))
  return orig ? dominantHint(orig.items) : own
}

function finish(p: Omit<MatchProposal, 'autoEligible' | 'status'>, rows: MatchBankRow[], opts: MatchOptions): MatchProposal {
  const min = opts.autoMinScore ?? AUTO_MIN_SCORE
  const auto = (opts.autoApply ?? AUTO_APPLY_DEFAULT) === true && p.rule === 'exact' && p.unique && !p.split &&
    p.score >= min && rows.every((b) => !b.personEdited)
  return { ...p, status: 'suggested', autoEligible: auto }
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Best score first; ties by the first part's bank row id, then the group key, so the order never depends on input order. */
function sortProposals(ps: MatchProposal[]): MatchProposal[] {
  return ps.sort((a, b) => b.score - a.score || cmpStr(a.parts[0].txnId, b.parts[0].txnId) || cmpStr(a.groupKey, b.groupKey))
}

/** Subsets of 2-3 rows summing to `target`; when `stated` is given the amounts must equal that multiset. */
function subsetsSumming(cands: Cand[], target: Cents, stated: readonly Cents[] | null): Cand[][] {
  const abs = (c: Cand) => Math.abs(c.row.amountCents)
  const out: Cand[][] = []
  const want = stated ? [...stated].sort((a, b) => a - b).join(',') : null
  const ok = (s: Cand[]) => want === null || s.map(abs).sort((a, b) => a - b).join(',') === want
  const n = cands.length
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const two = [cands[i], cands[j]]
    if (abs(cands[i]) + abs(cands[j]) === target && ok(two)) out.push(two)
    for (let k = j + 1; k < n; k++) {
      const three = [cands[i], cands[j], cands[k]]
      if (abs(cands[i]) + abs(cands[j]) + abs(cands[k]) === target && ok(three)) out.push(three)
    }
  }
  return out
}

function splitChargeProposals(r: MatchReceipt, rows: readonly MatchBankRow[], taken: ReadonlySet<string>,
  all: readonly MatchReceipt[], opts: MatchOptions): MatchProposal[] {
  const total = chargedCents(r)
  if (total === null || isRefund(r) || isDecline(r)) return []
  const stated = r.charges.length > 1 ? r.charges.map((c) => toCents(c.amountCents) as number) : null
  const cands: Cand[] = []
  for (const b of rows) {
    if (taken.has(b.id) || !rowFits(r, b) || !familyMatch(r, b)) continue
    const off = dayOffset(r, b)
    if (off !== null && Math.abs(b.amountCents) < total) cands.push({ row: b, offset: off })
  }
  cands.sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset) || (a.row.id < b.row.id ? -1 : 1))
  const subsets = subsetsSumming(cands.slice(0, SPLIT_CANDIDATE_LIMIT), total, stated)
  const hint = hintFor(r, all)
  const out: MatchProposal[] = []
  for (const s of subsets) {
    let score = SCORE.amount + SCORE.family + SCORE.split
    score += Math.min(...s.map((c) => dateScore(c.offset)))
    if (r.cardLast4 && s.every((c) => c.row.accountLast4 === r.cardLast4)) score += SCORE.last4
    score = withUniqueness(score, subsets.length === 1)
    const rs = s.map((c) => c.row)
    out.push(finish({
      rule: 'split_charges', groupKey: groupKey('s', [r.id, ...rs.map((b) => b.id)]), score: clamp(score),
      parts: rs.map((b) => ({ receiptId: r.id, txnId: b.id, shareCents: Math.abs(b.amountCents), txnUpdatedAt: b.updatedAt })),
      unique: false, split: true,
      // The one category is stored on every part, so a person-edited row in any part leaves it out.
      proposedCategoryId: proposedCategory(hint, rs.find((b) => b.personEdited) ?? rs[0], opts), explainsTxnIds: [],
    }, rs, opts))
  }
  return out
}

/** Several receipts of one order (same order_ref) whose amounts sum exactly to one bank charge. */
function splitReceiptProposals(receipts: readonly MatchReceipt[], rows: readonly MatchBankRow[], taken: ReadonlySet<string>,
  opts: MatchOptions): Map<string, MatchProposal[]> {
  const out = new Map<string, MatchProposal[]>()
  const byOrder = new Map<string, MatchReceipt[]>()
  for (const r of receipts) {
    if (!r.orderRef || isRefund(r) || isDecline(r) || chargedCents(r) === null || !baseDate(r) || foreignCurrency(r, opts)) continue
    const g = byOrder.get(r.orderRef) ?? []
    g.push(r)
    byOrder.set(r.orderRef, g)
  }
  for (const group of byOrder.values()) {
    if (group.length < 2 || group.length > 5) continue
    // Two receipts of one order with the same amount are a repeat email (a shipping notice), not two parts of a charge.
    if (new Set(group.map((r) => chargedCents(r))).size < group.length) continue
    const sum = group.reduce((a, r) => a + (chargedCents(r) as number), 0)
    const found: Array<{ row: MatchBankRow; worst: number }> = []
    for (const b of rows) {
      if (taken.has(b.id) || Math.abs(b.amountCents) !== sum) continue
      const offs = group.map((r) => (rowFits(r, b) && familyMatch(r, b) ? dayOffset(r, b) : null))
      if (offs.some((o) => o === null)) continue
      found.push({ row: b, worst: Math.max(...offs.map((o) => Math.abs(o as number))) })
    }
    for (const f of found) {
      let score = SCORE.amount + SCORE.family + SCORE.split + dateScore(f.worst)
      if (group.every((r) => r.cardLast4 && r.cardLast4 === f.row.accountLast4)) score += SCORE.last4
      score = withUniqueness(score, found.length === 1)
      const hint = dominantHint(group.flatMap((r) => r.items))
      const p = finish({
        rule: 'split_receipts', groupKey: groupKey('r', [f.row.id, ...group.map((r) => r.id)]), score: clamp(score),
        parts: group.map((r) => ({ receiptId: r.id, txnId: f.row.id, shareCents: chargedCents(r) as number, txnUpdatedAt: f.row.updatedAt })),
        unique: false, split: true, proposedCategoryId: proposedCategory(hint, f.row, opts), explainsTxnIds: [],
      }, [f.row], opts)
      for (const r of group) out.set(r.id, [...(out.get(r.id) ?? []), p])
    }
  }
  return out
}

/** Decline emails: the later retried charge (same amount, after related_date) links to the original payment. */
function declineProposals(r: MatchReceipt, rows: readonly MatchBankRow[], taken: ReadonlySet<string>, opts: MatchOptions): MatchProposal[] {
  const amt = singleAmount(r)
  const base = baseDate(r)
  if (amt === null || !base) return []
  const related = normalizeDate(r.relatedDate)
  const cands = exactCandidates(r, rows, taken).filter((c) => {
    const posted = normalizeDate(c.row.postedDate) as IsoDate
    return related === null ? daysBetween(base, posted) >= 0 : daysBetween(related, posted) > 0
  })
  const fees = rows.filter((b) => b.kind === 'fee' && b.amountCents < 0 && normalizeDate(b.postedDate) === base).map((b) => b.id)
  return cands.map((c) => {
    let score = SCORE.amount + dateScore(c.offset) + (familyMatch(r, c.row) ? SCORE.family : 0)
    if (r.cardLast4 && r.cardLast4 === c.row.accountLast4) score += SCORE.last4
    score = withUniqueness(score, cands.length === 1)
    return finish({
      rule: 'decline_retry', groupKey: groupKey('d', [r.id, c.row.id]), score: clamp(score),
      parts: [{ receiptId: r.id, txnId: c.row.id, shareCents: Math.abs(c.row.amountCents), txnUpdatedAt: c.row.updatedAt }],
      unique: cands.length === 1, split: false, proposedCategoryId: null, explainsTxnIds: fees,
    }, [c.row], opts)
  })
}

/**
 * A receipt already applied to a bank row. An open receipt of the same direction (refund or not) and charged amount is
 * a repeat email when it has the same order_ref within the purchase window, or (both without an order_ref) the same
 * sender domain within three days.
 */
export interface AppliedSibling {
  orderRef: string | null
  amountCents: Cents
  /** True for an applied refund: a refund is only a repeat of a refund, never of its purchase. */
  refund: boolean
  /** The applied receipt's base date (receipt_date, else email_date). */
  baseDate?: string | null
  senderDomain?: string | null
}

/** An order_ref repeats only within the span of one purchase window (a reused reference on a later receipt is new). */
export const REPEAT_SPAN_DAYS = PURCHASE_WINDOW.before + PURCHASE_WINDOW.after
/** Without an order_ref the same sender and amount repeat only this close together. */
export const NO_REF_REPEAT_DAYS = 3

export interface MatchContext {
  /** Bank row ids already linked (applied) to a receipt: never proposed again. */
  takenTxnIds?: readonly string[]
  /** Receipts already applied to a bank row: see AppliedSibling. */
  appliedSiblings?: readonly AppliedSibling[]
}

function siblingKey(refund: boolean, ref: string, amount: Cents): string { return `${refund ? 'R' : 'P'}|${ref}|${amount}` }

/** Ids of open receipts that repeat an applied one (never matched). */
function repeatIds(receipts: readonly MatchReceipt[], siblings: readonly AppliedSibling[]): Set<string> {
  const byKey = new Map<string, Array<IsoDate | null>>()
  for (const s of siblings) {
    const ref = s.orderRef !== null ? `o:${s.orderRef}` : s.senderDomain ? `d:${s.senderDomain}` : null
    if (ref === null) continue
    const k = siblingKey(s.refund, ref, s.amountCents)
    const l = byKey.get(k) ?? []
    l.push(normalizeDate(s.baseDate ?? null))
    byKey.set(k, l)
  }
  const out = new Set<string>()
  if (byKey.size === 0) return out
  for (const r of receipts) {
    const amt = chargedCents(r)
    if (amt === null) continue
    const ref = r.orderRef !== null ? `o:${r.orderRef}` : r.senderDomain ? `d:${r.senderDomain}` : null
    if (ref === null) continue
    const dates = byKey.get(siblingKey(isRefund(r), ref, amt))
    if (!dates) continue
    const base = baseDate(r)
    const span = r.orderRef !== null ? REPEAT_SPAN_DAYS : NO_REF_REPEAT_DAYS
    // A sibling without a usable date counts as a repeat only for an order_ref (the weaker fallback key needs the date).
    if (dates.some((d) => (d === null || base === null ? r.orderRef !== null : Math.abs(daysBetween(d, base)) <= span))) out.add(r.id)
  }
  return out
}

/**
 * Match every receipt against the bank rows. Pure: the same inputs always give the same output.
 * Receipts that compete for one row (same amount, same window) weaken each other (-30) and are never unique.
 */
export function matchReceipts(receipts: readonly MatchReceipt[], rows: readonly MatchBankRow[],
  opts: MatchOptions = {}, ctx: MatchContext = {}): ReceiptMatchResult[] {
  const taken = new Set(ctx.takenTxnIds ?? [])
  const repeats = repeatIds(receipts, ctx.appliedSiblings ?? [])
  // Never matched: another currency, or a repeat email of a receipt that is already applied.
  const skip = (r: MatchReceipt): boolean => foreignCurrency(r, opts) || repeats.has(r.id)
  const splitRecv = splitReceiptProposals(receipts.filter((r) => !skip(r)), rows, taken, opts)

  // Which receipts claim each row (for cross-receipt ambiguity).
  const cands = new Map<string, Cand[]>()
  const claims = new Map<string, Set<string>>()
  for (const r of receipts) {
    if (isDecline(r) || !baseDate(r) || skip(r)) continue
    const cs = exactCandidates(r, rows, taken)
    cands.set(r.id, cs)
    for (const c of cs) {
      const s = claims.get(c.row.id) ?? new Set<string>()
      s.add(r.id)
      claims.set(c.row.id, s)
    }
  }

  return receipts.map((r): ReceiptMatchResult => {
    if (chargedCents(r) === null) return { receiptId: r.id, status: 'no_total', proposals: [], winner: null }
    if (!baseDate(r) || skip(r)) return { receiptId: r.id, status: 'unmatched', proposals: [], winner: null }

    let proposals: MatchProposal[] = []
    if (isDecline(r)) {
      proposals = declineProposals(r, rows, taken, opts)
    } else {
      const cs = cands.get(r.id) ?? []
      const hint = hintFor(r, receipts)
      const rule: MatchRule = isRefund(r) ? 'refund' : 'exact'
      for (const c of cs) {
        const competing = cs.length > 1 || (claims.get(c.row.id)?.size ?? 0) > 1
        let score = SCORE.amount + dateScore(c.offset) + (familyMatch(r, c.row) ? SCORE.family : 0)
        if (r.cardLast4 && r.cardLast4 === c.row.accountLast4) score += SCORE.last4
        score = withUniqueness(score, !competing)
        proposals.push(finish({
          rule, groupKey: groupKey('e', [r.id, c.row.id]), score: clamp(score),
          parts: [{ receiptId: r.id, txnId: c.row.id, shareCents: Math.abs(c.row.amountCents), txnUpdatedAt: c.row.updatedAt }],
          unique: !competing, split: false, proposedCategoryId: proposedCategory(hint, c.row, opts), explainsTxnIds: [],
        }, [c.row], opts))
      }
      // Splits are tried only when no single row carries the amount.
      if (cs.length === 0) {
        proposals.push(...splitChargeProposals(r, rows, taken, receipts, opts).slice(0, MAX_SPLIT_PROPOSALS))
        proposals.push(...(splitRecv.get(r.id) ?? []))
      }
    }

    const shown = sortProposals(proposals.filter((p) => p.score >= SHOW_MIN_SCORE))
    if (shown.length === 0) return { receiptId: r.id, status: 'unmatched', proposals: [], winner: null }
    const only = shown.length === 1 && shown[0].unique && !shown[0].split && shown[0].rule !== 'decline_retry'
    return { receiptId: r.id, status: 'suggested', proposals: shown, winner: only ? shown[0] : null }
  })
}

/** Convenience for one receipt against the rows (no competing receipts). */
export function matchReceipt(receipt: MatchReceipt, rows: readonly MatchBankRow[], opts: MatchOptions = {},
  ctx: MatchContext = {}): ReceiptMatchResult {
  return matchReceipts([receipt], rows, opts, ctx)[0]
}

/** Unmatched receipts older than this many days (from today) go stale on their own. */
export const STALE_AFTER_DAYS = 75

/** True when an unmatched receipt's base date is more than STALE_AFTER_DAYS before `today`. */
export function isStale(r: Pick<MatchReceipt, 'emailDate' | 'receiptDate'>, today: string): boolean {
  const base = normalizeDate(r.receiptDate) ?? normalizeDate(r.emailDate)
  const t = normalizeDate(today)
  return base !== null && t !== null && daysBetween(base, t) > STALE_AFTER_DAYS
}

/** Window bounds a store can use to select candidate bank rows for a receipt (inclusive), or null with no usable date. */
export function candidateWindow(r: Pick<MatchReceipt, 'kind' | 'emailDate' | 'receiptDate'>): { from: IsoDate; to: IsoDate } | null {
  const base = normalizeDate(r.receiptDate) ?? normalizeDate(r.emailDate)
  if (!base) return null
  const w = r.kind === 'refund' ? REFUND_WINDOW : PURCHASE_WINDOW
  return { from: addDays(base, -w.before), to: addDays(base, w.after) }
}
