// The Budget table's logic, apart from the screen: columns, the category choices (incl. "Not spending"), the
// optimistic edit with revert, the rule offer and cursor paging. BudgetTable.vue draws it; the tests drive it with
// fake calls. State is Vue refs so the component can read them directly.
import { nextTick, reactive, ref } from 'vue'
import type { EditableColumn, RowStatus, SelectOption } from '../../components/table/EditableTable.vue'
import { BudgetApiError } from './clientEdit'
import { categoryColor, NONE_COLOR } from './colors'
import {
  SPENDING_KINDS, UNCATEGORIZED,
  type Account, type BudgetEditedEvent, type Category, type CategoryCreateResponse, type RuleFromEdit, type RuleResponse, type Txn, type TxnKind,
  type TxnPage, type TxnPatch, type TxnPatchResponse, type TxnQuery,
  type SimilarApply, type SimilarApplyResponse, type SimilarResponse,
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
]
export const NOT_SPENDING_GROUP = 'Not spending'
const UNCATEGORIZED_VALUE = ''

const KIND_CHOICE: Partial<Record<TxnKind, string>> = {
  income: 'kind:income', interest_earned: 'kind:income',
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

/** Why a row is flagged, as words: the engine's codes read plainly, and free text (a rule's own reason) shows as it is. */
const REVIEW_WORDS: Record<string, string> = {
  rule: 'A rule asks for a check',
  ambiguous_store: 'The store could fit more than one category',
  amount_out_of_band: 'The amount is unusual for this store',
  hidden_merchant: 'The real merchant is hidden behind a payment service',
  low_confidence: 'Not sure about this one',
  transfer_to_unknown_account: 'Transfer to an account that is not tracked',
}
export function reviewReasonText(reason: string | null | undefined): string | null {
  const r = reason?.trim()
  if (!r) return null
  return REVIEW_WORDS[r] ?? (/^[a-z]+(_[a-z]+)*$/.test(r) ? kindWords(r) : r)
}

// ---- columns ---------------------------------------------------------------------------------------------

/** How a phone shows the transactions: the card list, or the real table scrolled sideways. Kept per device. */
export type TxnView = 'cards' | 'table'
export const TXN_VIEW_KEY = 'gss-stats-budget-txn-view'
/** The saved choice; anything unreadable (storage blocked, another value) is the card list. */
export function loadTxnView(): TxnView {
  try {
    return window.localStorage.getItem(TXN_VIEW_KEY) === 'table' ? 'table' : 'cards'
  } catch {
    return 'cards'
  }
}
export function saveTxnView(v: TxnView): void {
  try {
    window.localStorage.setItem(TXN_VIEW_KEY, v)
  } catch {
    // Storage blocked or full: the choice just does not stay.
  }
}
/** The table's width on a phone in Table mode (fixed, wider than the column minimums so cells stay roomy); the page scrolls sideways past the screen. */
export const PHONE_TABLE_MIN_WIDTH = 880

/** `phoneTable`: the phone Table view puts Amount right after Merchant, so it shows without scrolling sideways. */
export function budgetColumns(categories: Category[], accounts: Account[], opts: { phoneTable?: boolean } = {}): EditableColumn<Txn>[] {
  const accountLabel = (t: Txn) => accounts.find((a) => a.id === t.accountId)?.label ?? ''
  const cols: EditableColumn<Txn>[] = [
    { key: 'postedDate', label: 'Date', editor: null, minWidth: 80, value: (t) => formatDate(t.postedDate) },
    { key: 'merchant', label: 'Merchant', editor: null, minWidth: 140, value: (t) => t.merchantName || t.description },
    // The note (short item descriptions, or what a person typed): text-editable; BudgetTable.vue draws it, clamped.
    { key: 'note', label: 'Note', editor: 'text', editGesture: 'hold', markdown: true, multiline: true, maxLength: NOTE_MAX, minWidth: 130, value: (t) => t.note ?? '', cardLine: 2 },
    { key: 'account', label: 'Account', editor: null, minWidth: 100, value: accountLabel, cardLine: 2 },
    { key: 'category', label: 'Category', editor: 'select', minWidth: 150, value: selectValueFor, options: (t) => categoryOptions(categories, t) },
    { key: 'amountCents', label: 'Amount', editor: null, align: 'end', minWidth: 90, value: (t) => formatAmount(t.amountCents), cardLine: 1 },
    // Included is an on/off switch right of the amount (BudgetTable.vue draws it), not a category. On (the default) = the
    // purchase counts in every spending total, pie and trend.
    { key: 'included', label: 'Included', editor: null, minWidth: 80, value: (t) => (t.included === false ? 'Excluded' : 'Included'), cardLine: 1 },
  ]
  if (!opts.phoneTable) return cols
  const amount = cols.findIndex((c) => c.key === 'amountCents')
  const [a] = cols.splice(amount, 1)
  cols.splice(2, 0, a)
  // Date, Merchant and Amount ask for their own width, so the wide (880px) table gives its slack to the other columns and
  // Amount is on screen at 390 px; the other columns scroll sideways.
  const ask: Record<string, number> = { postedDate: 84, merchant: 176, amountCents: 90 }
  return cols.map((c) => (ask[c.key] ? { ...c, width: ask[c.key] } : c))
}

// ---- the model -------------------------------------------------------------------------------------------

export interface TableDeps {
  fetchPage(q: TxnQuery): Promise<TxnPage>
  patch(id: string, p: TxnPatch): Promise<TxnPatchResponse>
  createRule(r: RuleFromEdit): Promise<RuleResponse>
  /** Makes a category (the server answers with the existing one when the name is taken). Absent = the table cannot add. */
  createCategory?(name: string): Promise<CategoryCreateResponse>
  /** GET similar: the same merchant's other purchases (the dialog after a category change). Absent = no dialog. */
  fetchSimilar?(id: string): Promise<SimilarResponse>
  applySimilar?(req: SimilarApply): Promise<SimilarApplyResponse>
}

/** What the "Change similar purchases?" dialog shows: the row that was just changed, the category it got, and the server's list. */
export interface SimilarOffer {
  sourceId: string
  categoryId: string | null
  response: SimilarResponse
}

/** Why a row no longer belongs to the query, or null while it still does. Used to dim it ("moved to X"). */
export function leavesSlice(q: TxnQuery, t: Txn, categories: Category[]): string | null {
  if (q.scope === 'spending' && !SPENDING_KINDS.includes(t.kind)) return `Moved to ${categoryLabel(categories, t)}`
  if (q.category && (t.categoryId ?? UNCATEGORIZED) !== q.category) return `Moved to ${categoryLabel(categories, t)}`
  if (q.review && !t.needsReview) return 'Reviewed, so it leaves the review list'
  return null
}

/** The server's limit on a note (functions/api/budget/transactions/[id].ts). */
export const NOTE_MAX = 500
const NETWORK_MESSAGE = 'Couldn’t save. Check your connection and try again.'

/** `onCategoryAdded` hears of every category the table made (or found by name), so the owner can put it in the lists. */
export function createTxnTable(
  deps: TableDeps,
  getCategories: () => Category[],
  onEdited: (e: BudgetEditedEvent) => void,
  onCategoryAdded: (c: Category) => void = () => {},
) {
  const rows = ref<Txn[]>([])
  const nextCursor = ref<string | null>(null)
  const loading = ref(false)
  const loadingMore = ref(false)
  const loadError = ref<string | null>(null)
  const rowState = reactive<Record<string, RowStatus>>({})
  /** Text for the polite live region. */
  const status = ref('')
  /** The open "Change similar purchases?" dialog, or null. */
  const similar = ref<SimilarOffer | null>(null)
  let similarToken = 0 // a newer category change (or a close) makes an older answer stale

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
  async function setSelection(id: string, value: string, confirm = false) {
    const i = indexOf(id)
    if (i < 0 || rowState[id]?.pending) return
    const before = rows.value[i]
    if (!confirm && parseSelection(value).categoryId !== undefined) closeSimilar()
    // Confirming a row that is not spending in a way the select can name (a card payment) saves its own kind.
    const sel = confirm && value.startsWith('kind:') && !NOT_SPENDING.some((n) => n.value === value) ? { kind: before.kind } : parseSelection(value)
    if (sel.categoryId === undefined && sel.kind === undefined) return
    const patch: TxnPatch = { expectedUpdatedAt: before.updatedAt }
    const optimistic: Txn = { ...before, needsReview: false, reviewReason: null }
    if (sel.categoryId !== undefined) {
      if (!confirm && selectValueFor(before) === value) return
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
      if (!confirm && before.kind === sel.kind) return
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
      // Only when a rule on this merchant key reaches just the merchant the label names (the server says so in ruleSafe).
      const offer = patch.categoryId != null && !!res.txn.merchantKey && res.txn.ruleSafe === true
      if (offer) setState(id, { ...rowState[id], action: { id: 'rule', label: `Use for all ${res.txn.merchantName || res.txn.merchantKey}` } })
      status.value = `Saved. ${res.txn.merchantName || 'Row'} is now ${categoryLabel(cats, res.txn)}.`
      onEdited({ txnId: id, ruleApplied: false, reapplied: 0 })
      if (!confirm && patch.categoryId !== undefined) void offerSimilar(id, patch.categoryId)
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

  function closeSimilar() {
    similarToken++
    similar.value = null
  }

  /** After a category change: ask the server for the merchant's other purchases. Rows -> the dialog opens; none, or any failure ->
   *  nothing shows (the change itself is already saved). */
  async function offerSimilar(id: string, categoryId: string | null) {
    if (!deps.fetchSimilar) return
    const mine = ++similarToken
    try {
      const response = await deps.fetchSimilar(id)
      if (mine !== similarToken || !response?.source || !Array.isArray(response.rows) || response.rows.length === 0) return
      similar.value = { sourceId: id, categoryId, response }
    } catch {
      // The offer is a convenience: no dialog, no error.
    }
  }

  /** Apply the ticked rows: PATCH-like batch, then mirror it onto the loaded page (changed rows take the category, conflicting ones the
   *  server's current row) and say so plainly. Throws what the call throws, so the dialog can keep itself open. */
  async function applySimilar(items: Array<{ id: string; expectedUpdatedAt: string }>, makeRule: boolean): Promise<SimilarApplyResponse | null> {
    const offer = similar.value
    if (!offer || !deps.applySimilar || items.length === 0) return null
    const res = await deps.applySimilar({ sourceId: offer.sourceId, categoryId: offer.categoryId, items, ...(makeRule ? { makeRule: true } : {}) })
    const done = new Map(res.changed.map((c) => [c.id, c.updatedAt]))
    const cur = new Map(res.conflicts.filter((c) => c.current).map((c) => [c.id, c.current as Txn]))
    rows.value = rows.value.map((r) => {
      const at = done.get(r.id)
      let next = r
      if (at) next = { ...r, categoryId: offer.categoryId, categorySource: 'manual', updatedAt: at, needsReview: false, reviewReason: null }
      else if (cur.has(r.id)) next = cur.get(r.id) as Txn
      if (next !== r) markIfMoved(next)
      return next
    })
    const n = res.changed.length
    const k = res.conflicts.length
    const word = (x: number) => `${x} ${x === 1 ? 'purchase' : 'purchases'}`
    let msg = n === 0 ? 'No purchases were changed.' : `Changed ${word(n)}.`
    if (k) msg = n === 0 ? `${k} changed elsewhere; not updated.` : `Changed ${n}; ${k} changed elsewhere; not updated.`
    if (res.rule) msg += res.rule.created ? ' New purchases follow the rule after the next rules re-apply.' : ' The rule was already there.'
    status.value = msg
    similarToken++
    similar.value = null
    if (n > 0) onEdited({ txnId: offer.sourceId, ruleApplied: !!res.rule, reapplied: n })
    return res
  }

  /** The Included switch of a row: flip it now, save (PATCH `included`, a manual edit), revert if the save fails. Excluding a
   *  purchase takes it out of every spending total, pie and trend; the pie refetches through `onEdited`. */
  async function setIncluded(id: string, on: boolean) {
    const i = indexOf(id)
    if (i < 0 || rowState[id]?.pending) return
    const before = rows.value[i]
    if ((before.included !== false) === on) return
    rows.value[i] = { ...before, included: on }
    setState(id, { pending: true })
    const name = before.merchantName || before.description || 'Row'
    try {
      const res = await deps.patch(id, { included: on, expectedUpdatedAt: before.updatedAt })
      const j = indexOf(id)
      if (j >= 0) rows.value[j] = res.txn
      setState(id, null)
      status.value = on ? `Saved. ${name} counts in spending again.` : `Saved. ${name} is excluded from spending.`
      onEdited({ txnId: id, ruleApplied: false, reapplied: 0 })
    } catch (e) {
      const j = indexOf(id)
      if (e instanceof BudgetApiError && e.status === 409) {
        if (j >= 0) rows.value[j] = e.current ?? before
        const msg = 'Changed by someone else. Check it and try again.'
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

  /** The Note cell of a row: save the text now (PATCH `note`, a manual edit stamp; empty text clears it), revert if the save fails. */
  async function setNote(id: string, text: string) {
    const i = indexOf(id)
    if (i < 0 || rowState[id]?.pending) return
    const before = rows.value[i]
    const next = text.trim()
    if (next === (before.note ?? '')) return
    if (next.length > NOTE_MAX) {
      const msg = `The note is over ${NOTE_MAX} characters. It was not saved.`
      setState(id, { error: msg })
      status.value = msg
      return
    }
    const note = next === '' ? null : next
    rows.value[i] = { ...before, note }
    setState(id, { pending: true })
    try {
      const res = await deps.patch(id, { note, expectedUpdatedAt: before.updatedAt })
      const j = indexOf(id)
      if (j >= 0) rows.value[j] = res.txn
      setState(id, null)
      status.value = `Saved. The note on ${before.merchantName || before.description || 'the row'} is ${note === null ? 'cleared' : 'updated'}.`
    } catch (e) {
      const j = indexOf(id)
      if (e instanceof BudgetApiError && e.status === 409) {
        if (j >= 0) rows.value[j] = e.current ?? before
        const msg = 'Changed by someone else. Check it and try again.'
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

  /** `Add category "<name>"` on a row: make the category, show it in every list, then give it to the row as any other
   *  category edit (same PATCH, manual source, audit row). If making it fails the row is left as it was, with the reason. */
  async function addCategoryTo(id: string, name: string) {
    if (!deps.createCategory || indexOf(id) < 0 || rowState[id]?.pending) return
    setState(id, { pending: true })
    let made: CategoryCreateResponse
    try {
      made = await deps.createCategory(name)
    } catch (e) {
      const msg = e instanceof BudgetApiError ? `Couldn’t add the category (${e.status}).` : NETWORK_MESSAGE
      setState(id, { error: msg })
      status.value = msg
      return
    }
    onCategoryAdded(made.category)
    // The owner's list is updated on the next tick; the edit below reads it for its confirmation text.
    await nextTick()
    setState(id, null)
    await setSelection(id, made.category.id)
  }

  /** "Looks right": save the row as it stands (its current category, or its kind when it is not spending) as a manual edit,
   *  which takes it off the review list. Picking the same option in the select again sends no change, hence this. */
  async function confirmReview(id: string) {
    const row = rows.value[indexOf(id)]
    if (row?.needsReview) await setSelection(id, selectValueFor(row), true)
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

  return { rows, nextCursor, loading, loadingMore, loadError, rowState, status, similar, closeSimilar, applySimilar, load, loadMore, setSelection, setIncluded, setNote, addCategoryTo, confirmReview, useForAll }
}
