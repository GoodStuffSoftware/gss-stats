// The Budget table's logic, apart from the screen: columns, the category choices (incl. "Not spending"), the
// optimistic edit with revert, the rule offer and cursor paging. BudgetTable.vue draws it; the tests drive it with
// fake calls. State is Vue refs so the component can read them directly.
import { reactive, ref } from 'vue'
import type { EditableColumn, RowStatus, SelectOption } from '../../components/table/EditableTable.vue'
import { BudgetApiError } from './clientEdit'
import { categoryColor, NONE_COLOR } from './colors'
import {
  SPENDING_KINDS, UNCATEGORIZED,
  type Account, type BudgetEditedEvent, type Category, type RuleFromEdit, type RuleResponse, type Txn, type TxnKind,
  type TxnPage, type TxnPatch, type TxnPatchResponse, type TxnQuery,
} from './types'

// ---- display helpers ------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** 'YYYY-MM-DD' as "Nov 5" (the year is added when it is not this year). Plain string work: no time zones. */
export function formatDate(iso: string, thisYear = new Date().getFullYear()): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const mon = MONTHS[Number(m[2]) - 1]
  if (!mon) return iso
  return Number(m[1]) === thisYear ? `${mon} ${Number(m[3])}` : `${mon} ${Number(m[3])}, ${m[1]}`
}

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
/** Cents as dollars, sign kept (a purchase is negative, a refund positive). */
export function formatAmount(cents: number): string {
  return USD.format(cents / 100)
}

// ---- category choices ------------------------------------------------------------------------------------

/** "Not spending" choices: they set the row's kind and leave its category alone. */
export const NOT_SPENDING: ReadonlyArray<{ value: string; label: string; kind: TxnKind }> = [
  { value: 'kind:transfer', label: 'Transfer', kind: 'transfer' },
  { value: 'kind:income', label: 'Income', kind: 'income' },
  { value: 'kind:exclude', label: 'Exclude', kind: 'other' },
]
export const NOT_SPENDING_GROUP = 'Not spending'
const UNCATEGORIZED_VALUE = ''

const KIND_CHOICE: Partial<Record<TxnKind, string>> = {
  income: 'kind:income', interest_earned: 'kind:income', other: 'kind:exclude',
}
const kindWords = (k: string) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

/** The select's value for a row: its category id ('' = none) while it counts as spending, else a `kind:` choice. */
export function selectValueFor(t: Txn): string {
  if (SPENDING_KINDS.includes(t.kind)) return t.categoryId ?? UNCATEGORIZED_VALUE
  return KIND_CHOICE[t.kind] ?? `kind:${t.kind}`
}

/** Choices for one row: every category, "Uncategorized", then the "Not spending" group (plus the row's own kind when it is
 *  another non-spending one, e.g. a card payment, so the select can show it). */
export function categoryOptions(categories: Category[], row?: Txn): SelectOption[] {
  const cats = [...categories].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label))
  const out: SelectOption[] = [
    ...cats.map((c) => ({ value: c.id, label: c.label })),
    { value: UNCATEGORIZED_VALUE, label: 'Uncategorized' },
    ...NOT_SPENDING.map((n) => ({ value: n.value, label: n.label, group: NOT_SPENDING_GROUP })),
  ]
  if (row) {
    const v = selectValueFor(row)
    if (v.startsWith('kind:') && !out.some((o) => o.value === v)) {
      out.push({ value: v, label: kindWords(v.slice(5)), group: NOT_SPENDING_GROUP, disabled: true })
    }
  }
  return out
}

/** A select value as the patch it means: a category id, '' for none, or a "Not spending" kind. */
export function parseSelection(value: string): { categoryId?: string | null; kind?: TxnKind } {
  if (value.startsWith('kind:')) {
    const hit = NOT_SPENDING.find((n) => n.value === value)
    return hit ? { kind: hit.kind } : {}
  }
  return { categoryId: value === UNCATEGORIZED_VALUE ? null : value }
}

// The colour dot of a category is the SAME colour as its pie slice: lib/budget/colors.ts is the one place.

/** Row colour for the dot: category colour while it counts as spending, grey otherwise. */
export function rowDotColor(categories: Category[], t: Txn): string {
  return SPENDING_KINDS.includes(t.kind) ? categoryColor(categories, t.categoryId) : NONE_COLOR
}

export function categoryLabel(categories: Category[], t: Txn): string {
  const v = selectValueFor(t)
  return categoryOptions(categories, t).find((o) => o.value === v)?.label ?? v
}

// ---- columns ---------------------------------------------------------------------------------------------

export function budgetColumns(categories: Category[], accounts: Account[]): EditableColumn<Txn>[] {
  const accountLabel = (t: Txn) => accounts.find((a) => a.id === t.accountId)?.label ?? ''
  return [
    { key: 'postedDate', label: 'Date', editor: null, value: (t) => formatDate(t.postedDate) },
    { key: 'merchant', label: 'Merchant', editor: null, value: (t) => t.merchantName || t.description },
    { key: 'account', label: 'Account', editor: null, value: accountLabel, cardLine: 2 },
    { key: 'category', label: 'Category', editor: 'select', value: selectValueFor, options: (t) => categoryOptions(categories, t) },
    { key: 'amountCents', label: 'Amount', editor: null, align: 'end', value: (t) => formatAmount(t.amountCents), cardLine: 1 },
  ]
}

// ---- the model -------------------------------------------------------------------------------------------

export interface TableDeps {
  fetchPage(q: TxnQuery): Promise<TxnPage>
  patch(id: string, p: TxnPatch): Promise<TxnPatchResponse>
  createRule(r: RuleFromEdit): Promise<RuleResponse>
}

/** Why a row no longer belongs to the query, or null while it still does. Used to dim it ("moved to X"). */
export function leavesSlice(q: TxnQuery, t: Txn, categories: Category[]): string | null {
  if (q.scope === 'spending' && !SPENDING_KINDS.includes(t.kind)) return `Moved to ${categoryLabel(categories, t)}`
  if (q.category && (t.categoryId ?? UNCATEGORIZED) !== q.category) return `Moved to ${categoryLabel(categories, t)}`
  if (q.review && !t.needsReview) return 'Reviewed, so it leaves the review list'
  return null
}

const NETWORK_MESSAGE = 'Couldn’t save. Check your connection and try again.'

export function createTxnTable(deps: TableDeps, getCategories: () => Category[], onEdited: (e: BudgetEditedEvent) => void) {
  const rows = ref<Txn[]>([])
  const nextCursor = ref<string | null>(null)
  const loading = ref(false)
  const loadingMore = ref(false)
  const loadError = ref<string | null>(null)
  const rowState = reactive<Record<string, RowStatus>>({})
  /** Text for the polite live region. */
  const status = ref('')

  let query: TxnQuery | null = null
  let token = 0 // a newer load makes older answers stale

  function clearStates() {
    for (const k of Object.keys(rowState)) delete rowState[k]
  }
  const indexOf = (id: string) => rows.value.findIndex((r) => r.id === id)
  const setState = (id: string, s: RowStatus | null) => {
    if (s) rowState[id] = s
    else delete rowState[id]
  }

  /** New query (or a refresh): paging starts over, row notes are dropped. */
  async function load(q: TxnQuery) {
    const mine = ++token
    query = { ...q, cursor: undefined }
    rows.value = []
    nextCursor.value = null
    clearStates()
    loadError.value = null
    loadingMore.value = false
    loading.value = true
    try {
      const page = await deps.fetchPage(query)
      if (mine !== token) return
      rows.value = page.rows
      nextCursor.value = page.nextCursor
    } catch (e) {
      if (mine !== token) return
      loadError.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (mine === token) loading.value = false
    }
  }

  /** The next page of the same query, appended. */
  async function loadMore() {
    if (!query || !nextCursor.value || loading.value || loadingMore.value) return
    const mine = token
    loadingMore.value = true
    try {
      const page = await deps.fetchPage({ ...query, cursor: nextCursor.value })
      if (mine !== token) return
      const have = new Set(rows.value.map((r) => r.id))
      rows.value = [...rows.value, ...page.rows.filter((r) => !have.has(r.id))]
      nextCursor.value = page.nextCursor
    } catch (e) {
      if (mine !== token) return
      loadError.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (mine === token) loadingMore.value = false
    }
  }

  function markIfMoved(t: Txn) {
    if (!query) return
    const why = leavesSlice(query, t, getCategories())
    if (why) setState(t.id, { ...rowState[t.id], dimmed: true, message: why })
  }

  /** The row changed from the category select: update it now, save, and revert if the save fails. */
  async function setSelection(id: string, value: string) {
    const i = indexOf(id)
    if (i < 0 || rowState[id]?.pending) return
    const before = rows.value[i]
    const sel = parseSelection(value)
    if (sel.categoryId === undefined && sel.kind === undefined) return
    const patch: TxnPatch = { expectedUpdatedAt: before.updatedAt }
    const optimistic: Txn = { ...before, needsReview: false, reviewReason: null }
    if (sel.categoryId !== undefined) {
      if (selectValueFor(before) === value) return
      patch.categoryId = sel.categoryId
      optimistic.categoryId = sel.categoryId
      optimistic.categorySource = 'manual'
      // A row that was not spending comes back into spending when it is given a category.
      if (!SPENDING_KINDS.includes(before.kind)) {
        patch.kind = 'spend'
        optimistic.kind = 'spend'
        optimistic.kindSource = 'manual'
      }
    } else if (sel.kind !== undefined) {
      if (before.kind === sel.kind) return
      patch.kind = sel.kind
      optimistic.kind = sel.kind
      optimistic.kindSource = 'manual'
    }
    rows.value[i] = optimistic
    setState(id, { pending: true })
    const cats = getCategories()
    try {
      const res = await deps.patch(id, patch)
      const j = indexOf(id)
      if (j >= 0) rows.value[j] = res.txn
      setState(id, null)
      markIfMoved(res.txn)
      const offer = patch.categoryId != null && !!res.txn.merchantKey
      if (offer) setState(id, { ...rowState[id], action: { id: 'rule', label: `Use for all ${res.txn.merchantName || res.txn.merchantKey}` } })
      status.value = `Saved. ${res.txn.merchantName || 'Row'} is now ${categoryLabel(cats, res.txn)}.`
      onEdited({ txnId: id, ruleApplied: false, reapplied: 0 })
    } catch (e) {
      const j = indexOf(id)
      if (e instanceof BudgetApiError && e.status === 409) {
        const now = e.current
        if (j >= 0) rows.value[j] = now ?? before
        const shown = now ? categoryLabel(cats, now) : null
        const msg = shown ? `Changed by someone else. It is now ${shown}.` : 'Changed by someone else. Refresh to see it.'
        setState(id, { error: msg })
        status.value = msg
      } else {
        if (j >= 0) rows.value[j] = before
        const msg = e instanceof BudgetApiError ? `Couldn’t save (${e.status}). The row is back as it was.` : NETWORK_MESSAGE
        setState(id, { error: msg })
        status.value = msg
      }
    }
  }

  /** "Use for all <merchant>": make the edit a rule, then show how many rows it changed. */
  async function useForAll(id: string) {
    const i = indexOf(id)
    if (i < 0) return
    const row = rows.value[i]
    const offer = rowState[id]?.action
    if (!offer || offer.busy) return
    setState(id, { ...rowState[id], error: undefined, action: { ...offer, busy: true } })
    try {
      const res = await deps.createRule({ txnId: id, scope: 'merchant' })
      const n = res.reapplied
      // Mirror what the server did to this page: its non-manual rows of the same merchant took the category.
      const to = res.rule.setCategoryId
      if (to) {
        rows.value = rows.value.map((r) => {
          if (r.id === id || r.merchantKey !== row.merchantKey || r.categorySource === 'manual') return r
          const next: Txn = { ...r, categoryId: to, categorySource: 'rule', ruleId: res.rule.id, needsReview: false, reviewReason: null }
          markIfMoved(next)
          return next
        })
      }
      const msg = n === 0 ? 'Rule saved. No other rows needed changing.' : `Rule saved. ${n} other ${n === 1 ? 'row' : 'rows'} changed.`
      setState(id, { ...rowState[id], action: undefined, message: msg, error: undefined })
      status.value = msg
      onEdited({ txnId: id, ruleApplied: true, reapplied: n })
    } catch (e) {
      const msg = e instanceof BudgetApiError ? `Couldn’t save the rule (${e.status}).` : NETWORK_MESSAGE
      setState(id, { ...rowState[id], error: msg, action: { ...offer, busy: false } })
      status.value = msg
    }
  }

  return { rows, nextCursor, loading, loadingMore, loadError, rowState, status, load, loadMore, setSelection, useForAll }
}
