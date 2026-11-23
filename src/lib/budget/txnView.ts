// The Transactions table's search, filters and sort (Budget Overview toolbar). Pure logic: it narrows and orders the rows
// the table has loaded (the pies and totals never see it). The same `TxnViewPrefs` shape is what is remembered per login
// (lib/budget/txnPrefsStore.ts on the client, functions/api/budget/prefs.ts on the server, which validates with
// `parseTxnViewPrefs(raw, true)`), so the schema lives here once. Nothing from it ever goes in the URL.
import type { Account, Category, Person, Txn } from './types'
import { UNCATEGORIZED } from './types'

export const TXN_SORT_KEYS = ['date', 'merchant', 'category', 'account', 'amount'] as const
export type TxnSortKey = (typeof TXN_SORT_KEYS)[number]
export type TxnSortDir = 'asc' | 'desc'

export interface TxnViewPrefs {
  search: string
  /** Merchant keys (`Txn.merchantKey`). Empty = every merchant. */
  merchants: string[]
  /** Category ids; UNCATEGORIZED ('__none__') for a row with none. Empty = every category. */
  categories: string[]
  accounts: string[]
  /** Person ids (the person who owns the row's account). */
  people: string[]
  /** YYYY-MM-DD or '' (no limit). */
  from: string
  to: string
  sortKey: TxnSortKey
  sortDir: TxnSortDir
  /** "Same amount only" in the similar-purchases dialog, as last chosen per merchant key (true = on). A capped map, oldest dropped first;
   *  not a filter of the table, so it never counts as "something active". An old saved blob without it reads as {}. */
  sameAmount: Record<string, boolean>
}

export const SEARCH_MAX = 100
export const LIST_MAX = 100
export const ITEM_MAX = 120
/** The most merchants whose "same amount only" choice is kept, and the longest key: 30 x ~90 bytes keeps the blob well under the 4 KB cap. */
export const SAME_AMOUNT_MAX = 30
export const SAME_AMOUNT_KEY_MAX = 80
/** The server keeps one blob per login and refuses a body over this (functions/api/budget/prefs.ts). The per-field caps alone
 *  allow more, so a valid blob must also serialise within it: the strict parse enforces it, and the toolbar uses `fitPrefs`. */
export const TXN_PREFS_MAX_BYTES = 4096

/** Bytes of the PUT body for these prefs. */
export function txnPrefsBytes(p: TxnViewPrefs): number {
  return new TextEncoder().encode(JSON.stringify({ txnView: p })).length
}

/** The prefs trimmed to fit the cap (the oldest "same amount" choices go first), or null when the filters alone do not fit. */
export function fitPrefs(p: TxnViewPrefs): TxnViewPrefs | null {
  let cur = p
  while (txnPrefsBytes(cur) > TXN_PREFS_MAX_BYTES) {
    const keys = Object.keys(cur.sameAmount ?? {})
    if (!keys.length) return null
    cur = { ...cur, sameAmount: Object.fromEntries(Object.entries(cur.sameAmount).slice(1)) }
  }
  return cur
}

export function defaultTxnViewPrefs(): TxnViewPrefs {
  return { search: '', merchants: [], categories: [], accounts: [], people: [], from: '', to: '', sortKey: 'date', sortDir: 'desc', sameAmount: {} }
}

/** True when the sort differs from the default (newest first, which is the order the server pages in). */
export function sortChanged(p: TxnViewPrefs): boolean {
  return p.sortKey !== 'date' || p.sortDir !== 'desc'
}

/** Anything narrowing the rows (the sort alone does not count). */
export function filtersActive(p: TxnViewPrefs): boolean {
  return !!p.search.trim() || p.merchants.length > 0 || p.categories.length > 0 || p.accounts.length > 0 || p.people.length > 0 || !!p.from || !!p.to
}

export function anythingActive(p: TxnViewPrefs): boolean {
  return filtersActive(p) || sortChanged(p)
}

const ISO = /^\d{4}-\d{2}-\d{2}$/
const FIELDS: readonly string[] = ['search', 'merchants', 'categories', 'accounts', 'people', 'from', 'to', 'sortKey', 'sortDir', 'sameAmount']

function strList(v: unknown, strict: boolean): string[] | null {
  if (!Array.isArray(v)) return strict ? null : []
  if (strict && v.length > LIST_MAX) return null
  const out: string[] = []
  for (const s of v.slice(0, LIST_MAX)) {
    if (typeof s !== 'string' || s.length > ITEM_MAX) {
      if (strict) return null
      continue
    }
    if (!out.includes(s)) out.push(s)
  }
  return out
}

function sameAmountMap(v: unknown, strict: boolean): Record<string, boolean> | null {
  if (v === undefined) return {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return strict ? null : {}
  const entries = Object.entries(v as Record<string, unknown>)
  if (strict && entries.length > SAME_AMOUNT_MAX) return null
  const out: Record<string, boolean> = {}
  for (const [k, on] of entries) {
    if (k.length === 0 || k.length > SAME_AMOUNT_KEY_MAX || typeof on !== 'boolean') {
      if (strict) return null
      continue
    }
    if (Object.keys(out).length < SAME_AMOUNT_MAX) out[k] = on
  }
  return out
}

/** The remembered choice for a merchant key, or undefined (none yet: the dialog's own default applies). */
export function sameAmountChoice(p: Pick<TxnViewPrefs, 'sameAmount'>, merchantKey: string): boolean | undefined {
  return p.sameAmount && Object.prototype.hasOwnProperty.call(p.sameAmount, merchantKey) ? p.sameAmount[merchantKey] : undefined
}

/** Prefs with one merchant's choice set (moved to the newest end); past SAME_AMOUNT_MAX the oldest entries go. A key too long to keep is not stored. */
export function withSameAmount(p: TxnViewPrefs, merchantKey: string, on: boolean): TxnViewPrefs {
  if (!merchantKey || merchantKey.length > SAME_AMOUNT_KEY_MAX) return p
  const next = Object.entries(p.sameAmount ?? {}).filter(([k]) => k !== merchantKey)
  next.push([merchantKey, on])
  return { ...p, sameAmount: Object.fromEntries(next.slice(-SAME_AMOUNT_MAX)) }
}

/** Reads a saved or posted value. `strict` (the server): every field present and exactly right, no unknown field, else null.
 *  Not strict (the browser cache): anything wrong falls back to that field's default; null only when it is not an object. */
export function parseTxnViewPrefs(raw: unknown, strict = false): TxnViewPrefs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (strict && Object.keys(o).some((k) => !FIELDS.includes(k))) return null
  const d = defaultTxnViewPrefs()
  const lists = (['merchants', 'categories', 'accounts', 'people'] as const).map((k) => strList(o[k], strict))
  if (strict && lists.some((l) => l === null)) return null
  const sameAmount = sameAmountMap(o.sameAmount, strict)
  if (strict && sameAmount === null) return null
  const searchOk = typeof o.search === 'string' && o.search.length <= SEARCH_MAX
  const fromOk = typeof o.from === 'string' && (o.from === '' || ISO.test(o.from))
  const toOk = typeof o.to === 'string' && (o.to === '' || ISO.test(o.to))
  const keyOk = typeof o.sortKey === 'string' && (TXN_SORT_KEYS as readonly string[]).includes(o.sortKey)
  const dirOk = o.sortDir === 'asc' || o.sortDir === 'desc'
  if (strict && !(searchOk && fromOk && toOk && keyOk && dirOk)) return null
  const out: TxnViewPrefs = {
    search: searchOk ? (o.search as string) : d.search,
    merchants: lists[0] ?? [],
    categories: lists[1] ?? [],
    accounts: lists[2] ?? [],
    people: lists[3] ?? [],
    from: fromOk ? (o.from as string) : '',
    to: toOk ? (o.to as string) : '',
    sortKey: keyOk ? (o.sortKey as TxnSortKey) : d.sortKey,
    sortDir: dirOk ? (o.sortDir as TxnSortDir) : d.sortDir,
    sameAmount: sameAmount ?? {},
  }
  if (strict && txnPrefsBytes(out) > TXN_PREFS_MAX_BYTES) return null
  return out
}

export function samePrefs(a: TxnViewPrefs, b: TxnViewPrefs): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export interface TxnViewContext {
  categories: Category[]
  accounts: Account[]
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })
const merchantLabel = (t: Txn) => t.merchantName || t.description
const categoryValue = (t: Txn) => t.categoryId ?? UNCATEGORIZED

export function categoryText(ctx: TxnViewContext, t: Txn): string {
  const id = categoryValue(t)
  if (id === UNCATEGORIZED) return 'Uncategorized'
  return ctx.categories.find((c) => c.id === id)?.label ?? id
}

/** Case-insensitive match over the merchant, the raw description and the note; every word typed must be found. */
export function matchesSearch(t: Txn, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = `${t.merchantName ?? ''}\n${t.description ?? ''}\n${t.note ?? ''}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

export function filterTxns(rows: readonly Txn[], p: TxnViewPrefs, ctx: TxnViewContext): Txn[] {
  const personOf = new Map(ctx.accounts.map((a) => [a.id, a.personId ?? null]))
  return rows.filter((t) => {
    if (p.merchants.length && !p.merchants.includes(t.merchantKey)) return false
    if (p.categories.length && !p.categories.includes(categoryValue(t))) return false
    if (p.accounts.length && !p.accounts.includes(t.accountId)) return false
    if (p.people.length) {
      const who = personOf.get(t.accountId)
      if (!who || !p.people.includes(who)) return false
    }
    if (p.from && t.postedDate < p.from) return false
    if (p.to && t.postedDate > p.to) return false
    return matchesSearch(t, p.search)
  })
}

export function sortTxns(rows: readonly Txn[], p: TxnViewPrefs, ctx: TxnViewContext): Txn[] {
  const accountLabel = (t: Txn) => ctx.accounts.find((a) => a.id === t.accountId)?.label ?? ''
  const dir = p.sortDir === 'asc' ? 1 : -1
  const cmp = (a: Txn, b: Txn): number => {
    switch (p.sortKey) {
      case 'date':
        return a.postedDate < b.postedDate ? -1 : a.postedDate > b.postedDate ? 1 : 0
      case 'merchant':
        return collator.compare(merchantLabel(a), merchantLabel(b))
      case 'category':
        return collator.compare(categoryText(ctx, a), categoryText(ctx, b))
      case 'account':
        return collator.compare(accountLabel(a), accountLabel(b))
      case 'amount':
        return a.amountCents - b.amountCents
    }
  }
  // Array.prototype.sort is stable, so equal rows keep the order the server sent them in.
  return [...rows].sort((a, b) => cmp(a, b) * dir)
}

/** What the table shows: the filtered rows in the chosen order. */
export function applyTxnView(rows: readonly Txn[], p: TxnViewPrefs, ctx: TxnViewContext): Txn[] {
  const filtered = filtersActive(p) ? filterTxns(rows, p, ctx) : [...rows]
  return sortChanged(p) ? sortTxns(filtered, p, ctx) : filtered
}

export interface Choice { value: string; label: string }

/** The merchants present in these rows (one entry per merchant key), A to Z. */
export function merchantChoices(rows: readonly Txn[]): Choice[] {
  const seen = new Map<string, string>()
  for (const t of rows) if (!seen.has(t.merchantKey)) seen.set(t.merchantKey, merchantLabel(t))
  return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => collator.compare(a.label, b.label))
}
export function categoryChoices(rows: readonly Txn[], ctx: TxnViewContext): Choice[] {
  const seen = new Map<string, string>()
  for (const t of rows) if (!seen.has(categoryValue(t))) seen.set(categoryValue(t), categoryText(ctx, t))
  return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => collator.compare(a.label, b.label))
}
export function accountChoices(rows: readonly Txn[], ctx: TxnViewContext): Choice[] {
  const ids = new Set(rows.map((t) => t.accountId))
  return ctx.accounts.filter((a) => ids.has(a.id)).map((a) => ({ value: a.id, label: a.label })).sort((a, b) => collator.compare(a.label, b.label))
}
export function personChoices(rows: readonly Txn[], ctx: TxnViewContext, people: readonly Person[]): Choice[] {
  const ids = new Set(rows.map((t) => ctx.accounts.find((a) => a.id === t.accountId)?.personId).filter(Boolean))
  return people.filter((p) => ids.has(p.id)).map((p) => ({ value: p.id, label: p.label }))
}
