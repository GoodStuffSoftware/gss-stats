// Budget section view state: ONE object the pie, the crumbs, the filters and the table all read, mirrored
// to the address bar with replaceState (docs/adr/0007-budget-section.md). The table's TxnQuery and the
// pie's SummaryQuery are computed from it, so they cannot disagree.
//
// URL (`?section=budget` plus `b_*` params; every other param is left alone, see sectionLink.ts):
//   b_from, b_to (YYYY-MM-DD, always written), b_person (omitted = all), b_group=account (omitted = merchant),
//   b_review=1, b_tab=spending|debts|both (always written; absent reads as the width's default tab),
//   b_page=loans (Overview is the default and writes nothing; anything but `loans` reads as Overview).
// The drill path (category and store names) is NOT in the URL: the repo is public and URLs reach logs and synced
// history. It lives in history.state (drillHistory.ts), which also puts it back after a reload; an old link that
// still carries a `b_path` has it ignored and removed (searchWithoutPath). Likewise the open loan on the Loans
// page (an account id names an institution): a one-level step `{level:'loan', key}` in history.state, through its
// own createDrillHistory instance (own mark key), never in the URL. Likewise the debt open in place on Overview (a
// click on a slice of the debt pie shows that debt's balance line): `{level:'debt', key}`, own mark key, one more
// instance whose entries interleave with the spending drill's (both carry each other's marks).
// Everything read back is validated; anything malformed falls back to its default.
import { computed, getCurrentInstance, onBeforeUnmount, onMounted, reactive, watch } from 'vue'
import { createDrillHistory, readMark, readSteps, type DrillHistory, type HistoryLike } from './drillHistory'
import { fitSavedView, VIEW_STEP_KEY_MAX, VIEW_STEP_LABEL_MAX, type SavedView } from './savedView'
import { BUDGET_PARAM_PREFIX, PAGE_PARAM, budgetPageOf, budgetSectionOpen, type BudgetPage } from './sectionLink'
import type { IsoDate, PersonFilter, SummaryQuery, TxnQuery } from './types'

export type BudgetTab = 'spending' | 'debts' | 'both'
export const BUDGET_TABS: readonly BudgetTab[] = ['spending', 'debts', 'both']
/** The tab shown when nothing says otherwise (no link, no history entry, nothing saved): both charts where they fit side
 * by side (1024 px and wider), Spending below that. */
export function defaultTabFor(wide: boolean): BudgetTab {
  return wide ? 'both' : 'spending'
}
export type GroupBy = 'merchant' | 'account'
export interface DrillStep { level: 'category' | 'merchant'; key: string; label: string }
export interface LoanStep { level: 'loan'; key: string; label: string }
export interface DebtStep { level: 'debt'; key: string; label: string }
export interface BudgetViewState {
  from: IsoDate
  to: IsoDate
  person: PersonFilter
  path: DrillStep[]
  groupBy: GroupBy
  reviewOnly: boolean
  tab: BudgetTab
  /** Overview (the default) or Loans (`b_page=loans`). */
  page: BudgetPage
  /** The loan open on the Loans page (an account id): history.state only, never the URL. Null on Overview. */
  loan: string | null
  /** The debt open in place on Overview (an account id): history.state only, never the URL. Null = the debt pie. */
  debt: string | null
}

/** The server refuses a range longer than this (functions/api/budget/summary.ts). */
export const MAX_RANGE_DAYS = 400
export const PATH_LEVELS: ReadonlyArray<DrillStep['level']> = ['category', 'merchant']

// ── Dates (YYYY-MM-DD strings; UTC arithmetic on the calendar date, so no time zone or DST drift) ────────
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/
function dayNumber(s: string): number | null {
  if (!ISO_RE.test(s)) return null
  const [y, m, d] = s.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d)
  const back = new Date(t)
  return back.getUTCFullYear() === y && back.getUTCMonth() === m - 1 && back.getUTCDate() === d ? Math.round(t / 86_400_000) : null
}
const pad = (n: number) => String(n).padStart(2, '0')
function ymd(y: number, m1: number, d: number): IsoDate {
  const t = new Date(Date.UTC(y, m1 - 1, d))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}
/** Today's calendar date in the browser's own time zone. */
export function todayIso(now: Date = new Date()): IsoDate {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** A real range: both dates exist, from <= to, at most MAX_RANGE_DAYS days (inclusive). */
export function rangeValid(from: string, to: string): boolean {
  const a = dayNumber(from)
  const b = dayNumber(to)
  return a !== null && b !== null && a <= b && b - a + 1 <= MAX_RANGE_DAYS
}

export type RangePreset = 'this-month' | 'last-month' | '3-months' | 'ytd' | 'custom'
export const RANGE_PRESETS: ReadonlyArray<{ id: RangePreset; label: string }> = [
  { id: 'this-month', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: '3-months', label: 'Last 3 months' },
  { id: 'ytd', label: 'Year to date' },
  { id: 'custom', label: 'Custom' },
]

/** The range a preset means on `today`; null for 'custom'. "3 months" = the 2 calendar months before this
 * one plus this month so far. */
export function rangeForPreset(preset: RangePreset, today: IsoDate): { from: IsoDate; to: IsoDate } | null {
  const [y, m] = today.split('-').map(Number)
  switch (preset) {
    case 'this-month': return { from: ymd(y, m, 1), to: today }
    case 'last-month': return { from: ymd(y, m - 1, 1), to: ymd(y, m, 0) }
    case '3-months': return { from: ymd(y, m - 2, 1), to: today }
    case 'ytd': return { from: ymd(y, 1, 1), to: today }
    default: return null
  }
}
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/**
 * The calendar months a range of whole days touches, as text: one month 'October 2026'; several 'Aug – Oct 2026'
 * (the year shown once when both ends share it, else 'Dec 2025 – Feb 2026'). `toDate` appends ' (to date)'.
 * Works on 'YYYY-MM-DD' or 'YYYY-MM' ends. '' when an end is not a date.
 */
export function monthsLabel(from: string, to: string, toDate = false): string {
  const a = /^(\d{4})-(\d{2})/.exec(from)
  const b = /^(\d{4})-(\d{2})/.exec(to)
  if (!a || !b) return ''
  const [y1, m1, y2, m2] = [Number(a[1]), Number(a[2]) - 1, Number(b[1]), Number(b[2]) - 1]
  if (m1 < 0 || m2 < 0 || m1 > 11 || m2 > 11) return ''
  const tail = toDate ? ' (to date)' : ''
  if (y1 === y2 && m1 === m2) return `${MONTH_LONG[m1]} ${y1}${tail}`
  if (y1 === y2) return `${MONTH_SHORT[m1]} – ${MONTH_SHORT[m2]} ${y1}${tail}`
  return `${MONTH_SHORT[m1]} ${y1} – ${MONTH_SHORT[m2]} ${y2}${tail}`
}
/** The months a picked range covers; 'to date' when it ends today (or later), i.e. its last month is still running. */
export function rangeMonths(from: string, to: string, today: IsoDate): string {
  return monthsLabel(from, to, to >= today)
}
/** A preset's picker text: 'Last month · October 2026'. The preset's range comes from rangeForPreset, the same
 * code the queries use; 'custom' stays 'Custom' (its dates are shown beside it). */
export function presetLabel(preset: RangePreset, today: IsoDate): string {
  const base = RANGE_PRESETS.find((p) => p.id === preset)?.label ?? ''
  const r = rangeForPreset(preset, today)
  return r ? `${base} · ${monthsLabel(r.from, r.to)}` : base
}
/** Which preset a range is on `today`, else 'custom'. */
export function presetOf(from: string, to: string, today: IsoDate): RangePreset {
  for (const p of RANGE_PRESETS) {
    const r = rangeForPreset(p.id, today)
    if (r && r.from === from && r.to === to) return p.id
  }
  return 'custom'
}

// ── State <-> URL ─────────────────────────────────────────────────────────────────────────────────────────
export function defaultViewState(today: IsoDate = todayIso(), tab: BudgetTab = 'spending'): BudgetViewState {
  const r = rangeForPreset('this-month', today)!
  return { from: r.from, to: r.to, person: 'all', path: [], groupBy: 'merchant', reviewOnly: false, tab, page: 'overview', loan: null, debt: null }
}

const P = BUDGET_PARAM_PREFIX
const PERSON_RE = /^[a-z0-9][\w-]{0,23}$/
const STEP_TEXT_MAX = 120
const LOAN_ID_RE = /^[A-Za-z0-9][\w.-]{0,63}$/
/** history.state key of the loan step's own drillHistory instance (the drill path keeps drillHistory's MARK_KEY). */
export const LOAN_MARK_KEY = 'gssBudgetLoan'
/** history.state key of the in-place debt step's own drillHistory instance. */
export const DEBT_MARK_KEY = 'gssBudgetDebt'

/** The in-place debt step read back from history.state: none or exactly one `{level:'debt', key}` with a plain id, else null. */
export function parseDebtSteps(raw: unknown): DebtStep[] | null {
  if (!Array.isArray(raw) || raw.length > 1) return null
  if (raw.length === 0) return []
  const t = raw[0] as unknown
  if (!t || typeof t !== 'object') return null
  const { level, key } = t as Record<string, unknown>
  if (level !== 'debt' || typeof key !== 'string' || !LOAN_ID_RE.test(key)) return null
  return [{ level: 'debt', key, label: key }]
}

/** The loan step read back from history.state: none or exactly one `{level:'loan', key}` with a plain id, else null. */
export function parseLoanSteps(raw: unknown): LoanStep[] | null {
  if (!Array.isArray(raw) || raw.length > 1) return null
  if (raw.length === 0) return []
  const t = raw[0] as unknown
  if (!t || typeof t !== 'object') return null
  const { level, key } = t as Record<string, unknown>
  if (level !== 'loan' || typeof key !== 'string' || !LOAN_ID_RE.test(key)) return null
  return [{ level: 'loan', key, label: key }]
}

/** Drill steps read back from history.state (anything can be in there): the steps when they are a valid path
 * (levels in order, at most PATH_LEVELS.length, plain strings), else null. */
export function parseDrillSteps(raw: unknown): DrillStep[] | null {
  if (!Array.isArray(raw) || raw.length > PATH_LEVELS.length) return null
  const out: DrillStep[] = []
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as unknown
    if (!t || typeof t !== 'object') return null
    const { level, key, label } = t as Record<string, unknown>
    if (level !== PATH_LEVELS[i] || typeof key !== 'string' || !key || key.length > STEP_TEXT_MAX) return null
    out.push({ level: PATH_LEVELS[i], key, label: typeof label === 'string' && label ? label.slice(0, STEP_TEXT_MAX) : key })
  }
  return out
}

/** `search` without the old `b_path` param (drill names do not ride in URLs); every other param kept. */
export function searchWithoutPath(search: string): string {
  const q = new URLSearchParams(search)
  if (!q.has(`${P}path`)) return search
  q.delete(`${P}path`)
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** The view state a query string names; anything missing or malformed takes its default (`tab`: the width's default). */
export function stateFromSearch(search: string, today: IsoDate = todayIso(), tab: BudgetTab = 'spending'): BudgetViewState {
  const state = defaultViewState(today, tab)
  let q: URLSearchParams
  try {
    q = new URLSearchParams(search)
  } catch {
    return state
  }
  const from = q.get(`${P}from`)
  const to = q.get(`${P}to`)
  if (from && to && rangeValid(from, to)) {
    state.from = from
    state.to = to
  }
  const person = q.get(`${P}person`)
  if (person && (person === 'all' || PERSON_RE.test(person))) state.person = person
  state.groupBy = q.get(`${P}group`) === 'account' ? 'account' : 'merchant'
  state.reviewOnly = q.get(`${P}review`) === '1'
  const tabParam = q.get(`${P}tab`) as BudgetTab | null
  if (tabParam && BUDGET_TABS.includes(tabParam)) state.tab = tabParam
  state.page = budgetPageOf(search)
  return state
}

/** `search` with the state written into its `b_*` params (old ones replaced); other params untouched.
 * Defaults are left out except the range. Returns '' or a string starting with '?'. */
export function searchWithState(search: string, state: BudgetViewState): string {
  const q = new URLSearchParams(search)
  for (const k of Array.from(q.keys())) if (k.startsWith(P)) q.delete(k)
  q.set(`${P}from`, state.from)
  q.set(`${P}to`, state.to)
  if (state.person !== 'all') q.set(`${P}person`, state.person)
  if (state.groupBy === 'account') q.set(`${P}group`, 'account')
  if (state.reviewOnly) q.set(`${P}review`, '1')
  q.set(`${P}tab`, state.tab) // always written: the default depends on the width, so an omitted tab would not survive a reload
  if (state.page === 'loans') q.set(PAGE_PARAM, 'loans')
  const s = q.toString()
  return s ? `?${s}` : ''
}

// ── The saved view (where the person left off, per login: lib/budget/savedView.ts) ───────────────────────────
/** True when the address or the history entry already says what to show: any `b_*` param other than the page (a link, a
 * reload: writeUrl always stamps b_from/b_to) or a drill, loan or debt mark in history.state (Back/Forward, a reload).
 * Then the saved view must not be applied: a link or Back/Forward always wins. */
export function hasExplicitViewState(search: string, historyState: unknown): boolean {
  try {
    for (const k of new URLSearchParams(search).keys()) if (k.startsWith(P) && k !== PAGE_PARAM) return true
  } catch {
    // an unreadable query string names nothing
  }
  return !!(readMark(historyState) || readMark(historyState, LOAN_MARK_KEY) || readMark(historyState, DEBT_MARK_KEY))
}

/** The state as a saved view. A path that cannot be saved (a key over the cap) is dropped; the whole block is kept under
 * the byte cap. */
export function savedViewOfState(state: BudgetViewState, today: IsoDate): SavedView {
  const steps = state.path.slice(0, PATH_LEVELS.length)
  const pathOk = steps.every((s) => s.key.length > 0 && s.key.length <= VIEW_STEP_KEY_MAX)
  const preset = presetOf(state.from, state.to, today)
  return fitSavedView({
    tab: state.tab,
    page: state.page,
    path: pathOk ? steps.map((s) => ({ level: s.level, key: s.key, label: s.label.slice(0, VIEW_STEP_LABEL_MAX) })) : [],
    groupBy: state.groupBy,
    review: state.reviewOnly,
    debt: state.debt,
    range: preset === 'custom' ? { preset, from: state.from, to: state.to } : { preset },
    person: state.person,
  })
}

/** What a saved view becomes on `today` against what exists now. Stale parts fall back, never error: a category that is gone
 * drops the whole drill (back to the top); a person that is gone is 'all'; a custom range the server would refuse, the
 * default; a preset is recomputed so "This month" is this month. The second drill step cannot be checked until the first
 * level's slices load: it is returned as `pendingStep`. A debt that is gone is checked by the section against the debts. */
export interface RestorePatch {
  from: IsoDate
  to: IsoDate
  person: PersonFilter
  groupBy: GroupBy
  reviewOnly: boolean
  tab: BudgetTab
  page: BudgetPage
  path: DrillStep[]
  pendingStep: DrillStep | null
  debt: string | null
}
export function restorePatch(view: SavedView, ctx: { today: IsoDate; categoryIds: ReadonlyArray<string>; personIds: ReadonlyArray<string> }): RestorePatch {
  const def = defaultViewState(ctx.today)
  const r = view.range.preset === 'custom'
    ? (view.range.from && view.range.to && rangeValid(view.range.from, view.range.to) ? { from: view.range.from, to: view.range.to } : null)
    : rangeForPreset(view.range.preset, ctx.today)
  const first = view.path[0]
  const categoryOk = !!first && first.level === 'category' && ctx.categoryIds.includes(first.key)
  const second = categoryOk ? view.path[1] : undefined
  return {
    from: r?.from ?? def.from,
    to: r?.to ?? def.to,
    person: view.person === 'all' || ctx.personIds.includes(view.person) ? view.person : 'all',
    groupBy: view.groupBy,
    reviewOnly: view.review,
    tab: view.tab,
    page: view.page,
    path: categoryOk ? [{ level: 'category', key: first.key, label: first.label || first.key }] : [],
    pendingStep: second && second.level === 'merchant' ? { level: 'merchant', key: second.key, label: second.label || second.key } : null,
    debt: view.page === 'overview' ? view.debt : null,
  }
}

// ── Queries derived from the state ────────────────────────────────────────────────────────────────────────
// The second drill step's key is a merchant when slices are grouped by merchant and an account id when they
// are grouped by account. Each goes in its own field (`merchant` / `account`) of BOTH queries, so the pie
// and the table always show the same slice.
function levelKeys(state: BudgetViewState): { category?: string; merchant?: string; account?: string } {
  const second = state.path[1]?.key
  return {
    category: state.path[0]?.key,
    merchant: state.groupBy === 'merchant' ? second : undefined,
    account: state.groupBy === 'account' ? second : undefined,
  }
}
export function summaryQueryOf(state: BudgetViewState): SummaryQuery {
  const { category, merchant, account } = levelKeys(state)
  const q: SummaryQuery = { from: state.from, to: state.to, person: state.person }
  if (category !== undefined) {
    q.category = category
    q.groupBy = state.groupBy
  }
  if (merchant !== undefined) q.merchant = merchant
  if (account !== undefined) q.account = account
  return q
}
export function txnQueryOf(state: BudgetViewState): TxnQuery {
  const { category, merchant, account } = levelKeys(state)
  // Review mode lists every flagged row, whatever its kind (the server ignores `scope` for it), like the count.
  const q: TxnQuery = { from: state.from, to: state.to, person: state.person, scope: state.reviewOnly ? 'all' : 'spending' }
  if (category !== undefined) q.category = category
  if (merchant !== undefined) q.merchant = merchant
  if (account !== undefined) q.account = account
  if (state.reviewOnly) q.review = true
  return q
}

// ── The live state ────────────────────────────────────────────────────────────────────────────────────────
/** `defaultTab` names the tab for a link or entry that does not carry one (the width decides: `defaultTabFor`). */
export function useBudgetViewState(today: IsoDate = todayIso(), defaultTab: () => BudgetTab = () => 'spending') {
  const state = reactive<BudgetViewState>(stateFromSearch(globalThis.location?.search ?? '', today, defaultTab()))
  // Read before anything below (or writeUrl) stamps the address or history: does it already say what to show? Then the
  // saved view is never applied (restoreView).
  let explicit = true
  let keepPage = false
  try {
    explicit = hasExplicitViewState(globalThis.location?.search ?? '', globalThis.history?.state)
    keepPage = new URLSearchParams(globalThis.location?.search ?? '').has(PAGE_PARAM)
  } catch {
    // no location or history (tests, tools): nothing explicit, apply the saved view
    explicit = false
  }
  // The drill path is not in the URL. An old link may still carry one: drop it from the address bar. A reload (or
  // a Back onto an entry of an earlier visit) puts the path back from the entry's own history.state, when that
  // still parses; otherwise the section starts at the top.
  try {
    const loc = globalThis.location
    if (loc && budgetSectionOpen(loc.search)) {
      const clean = searchWithoutPath(loc.search)
      if (clean !== loc.search) globalThis.history.replaceState(globalThis.history.state, '', loc.pathname + clean + loc.hash)
      const kept = readSteps(globalThis.history?.state, parseDrillSteps)
      if (kept) state.path = kept
      if (state.page === 'loans') state.loan = readSteps(globalThis.history?.state, parseLoanSteps, LOAN_MARK_KEY)?.[0]?.key ?? null
      else state.debt = readSteps(globalThis.history?.state, parseDebtSteps, DEBT_MARK_KEY)?.[0]?.key ?? null
    }
  } catch {
    // history unavailable or sandboxed: the section starts at the top
  }
  const summaryQuery = computed(() => summaryQueryOf(state))
  const txnQuery = computed(() => txnQueryOf(state))

  // replaceState, not pushState: this only rewrites the current entry (the drill's own entries are pushed by
  // drillHistory.ts, in history.state). Skipped once the section is no longer
  // the one in the address bar (App closed it), so a late write cannot bring `section=budget` back.
  function writeUrl() {
    try {
      const loc = globalThis.location
      if (!budgetSectionOpen(loc.search)) return
      // An entry of an earlier visit (after a reload, its history-step session is stale) was landed on: its path or
      // loan is being set from the entry's own state, and the browser fires popstate at the other listeners (readUrl
      // takes the page, range and person from the address) AFTER the reactive flush that would run this. Writing now
      // would stamp the page still on screen onto that entry's address, so Back would never leave it.
      if (drill?.settling || loanHist?.settling || debtHist?.settling) return
      const search = searchWithState(loc.search, state)
      if (search !== loc.search) globalThis.history.replaceState(globalThis.history.state, '', loc.pathname + search + loc.hash)
    } catch {
      // history unavailable or sandboxed: the link just isn't kept up to date
    }
  }
  watch(state, writeUrl, { deep: true })

  // Back/Forward over the drill levels (drillHistory.ts): one history entry per level, in history.state only.
  // Only inside a component; a bare call (tests, tools) touches no history.
  let drill: DrillHistory<DrillStep> | null = null
  let loanHist: DrillHistory<LoanStep> | null = null
  let debtHist: DrillHistory<DebtStep> | null = null
  let pageSwitching = false // setPage / a popstate is changing page and loan together: the loan step must not push
  const loanPath = (): LoanStep[] => (state.loan ? [{ level: 'loan', key: state.loan, label: state.loan }] : [])
  const debtPath = (): DebtStep[] => (state.debt ? [{ level: 'debt', key: state.debt, label: state.debt }] : [])
  // The spending drill and the in-place debt drill push entries into the same history list, so a path cut of one that
  // goes back through history (go(-n)) must not run over entries the other pushed since. Each instance keeps the depth
  // the OTHER one stood at when it last pushed (-1: nothing in the way): a cut that stays at or above that depth only
  // crosses its own entries; a deeper one re-marks the entry the user is on instead (drillHistory.ts `canGoBack`).
  let drillBlock = -1 // the spending depth when the debt step last pushed
  let debtBlock = -1 // the debt depth (0 or 1) when a spending level last pushed
  const tracked = (onPush: () => void): HistoryLike => ({
    get state() {
      return globalThis.history.state
    },
    pushState: (st, t) => {
      globalThis.history.pushState(st, t)
      onPush()
    },
    replaceState: (st, t) => globalThis.history.replaceState(st, t),
    go: (n) => globalThis.history.go(n),
  })
  if (getCurrentInstance() && globalThis.history && globalThis.window) {
    const copy = () => state.path.map((x) => ({ ...x }))
    const d = createDrillHistory<DrillStep>({
      history: tracked(() => void (debtBlock = state.debt ? 1 : 0)),
      drill: pushStep,
      popTo,
      path: copy,
      parseSteps: parseDrillSteps,
      landed: writeUrl,
      carry: true,
      canGoBack: (floor) => floor >= drillBlock,
    })
    drill = d
    // sync: the entry is pushed before writeUrl (later in the flush) stamps the new level on the address bar
    watch(() => state.path.length, () => d.pathChanged(copy()), { flush: 'sync' })
    // the steps kept for Forward mean nothing under another range, person, grouping or review filter
    watch(() => [state.from, state.to, state.person, state.groupBy, state.reviewOnly], () => d.forgetForward())
    // the drill path is Overview's: on the Loans page its entries are not acted on (the path stays as it was)
    const onPop = (e: PopStateEvent) => {
      const search = globalThis.location?.search ?? ''
      d.popped(e.state, budgetSectionOpen(search) && budgetPageOf(search) === 'overview')
    }
    // The open loan: one level, own mark key, active on the Loans page only.
    const l = createDrillHistory<LoanStep>({
      history: globalThis.history,
      markKey: LOAN_MARK_KEY,
      drill: (step) => void (state.loan = step.key),
      popTo: (depth) => void (depth < 1 && (state.loan = null)),
      path: loanPath,
      parseSteps: parseLoanSteps,
      landed: writeUrl,
    })
    loanHist = l
    watch(() => state.loan, () => { if (!pageSwitching) l.pathChanged(loanPath()) }, { flush: 'sync' })
    const onLoanPop = (e: PopStateEvent) => {
      const search = globalThis.location?.search ?? ''
      if (budgetSectionOpen(search) && budgetPageOf(search) === 'loans') l.popped(e.state, true)
    }
    // The debt open in place on Overview: one level, own mark key, active on Overview only.
    const b = createDrillHistory<DebtStep>({
      history: tracked(() => void (drillBlock = state.path.length)),
      markKey: DEBT_MARK_KEY,
      drill: (step) => void (state.debt = step.key),
      popTo: (depth) => void (depth < 1 && (state.debt = null)),
      path: debtPath,
      parseSteps: parseDebtSteps,
      landed: writeUrl,
      carry: true,
      canGoBack: (floor) => floor >= debtBlock,
    })
    debtHist = b
    watch(() => state.debt, () => b.pathChanged(debtPath()), { flush: 'sync' })
    // the steps kept for Forward mean nothing for another person's debts
    watch(() => state.person, () => b.forgetForward())
    const onDebtPop = (e: PopStateEvent) => {
      const search = globalThis.location?.search ?? ''
      if (budgetSectionOpen(search) && budgetPageOf(search) === 'overview') b.popped(e.state, true)
    }
    // registered before BudgetSection's own readUrl listener (its onMounted comes after this call), so a foreign
    // entry is flagged as settling before readUrl changes the path
    onMounted(() => {
      d.start()
      if (state.page === 'loans') l.start()
      else b.start()
      globalThis.addEventListener('popstate', onPop)
      globalThis.addEventListener('popstate', onLoanPop)
      globalThis.addEventListener('popstate', onDebtPop)
    })
    onBeforeUnmount(() => {
      globalThis.removeEventListener('popstate', onPop)
      globalThis.removeEventListener('popstate', onLoanPop)
      globalThis.removeEventListener('popstate', onDebtPop)
      l.end()
      b.end()
      d.end() // the entry the user is on (a page the app moved to) keeps no drill state
    })
  }

  /** Re-read the address bar (back/forward). A popstate onto one of the drill entries this session pushed
   * (drillHistory.ts) is left alone: Back/Forward there only moves the drill path, and re-reading the older
   * entry's address would also roll back the range or person chosen since. */
  function readUrl(e?: PopStateEvent) {
    syncPage(e ? e.state : globalThis.history?.state)
    if (e && drill && readMark(e.state)?.s === drill.session) return
    // a loan step of this session: Back/Forward only moves the open loan, the person and range stay as chosen
    if (e && loanHist && readMark(e.state, LOAN_MARK_KEY)?.s === loanHist.session) return
    // a debt step of this session: Back/Forward only moves the open debt
    if (e && debtHist && readMark(e.state, DEBT_MARK_KEY)?.s === debtHist.session) return
    // the address names no drill path: whatever is on screen stays (drillHistory.ts sets it from the entry)
    const { path: _path, page: _page, loan: _loan, debt: _debt, ...fromUrl } = stateFromSearch(globalThis.location?.search ?? '', today, defaultTab())
    Object.assign(state, fromUrl)
  }
  /** Back/Forward onto an entry of another page: take the page from the address and the open loan from the entry's
   * own state (one entry per page change, so this never pushes). */
  function syncPage(entryState: unknown) {
    const page = budgetPageOf(globalThis.location?.search ?? '')
    if (page === state.page) return
    pageSwitching = true
    try {
      state.page = page
      state.loan = page === 'loans' ? (readSteps(entryState, parseLoanSteps, LOAN_MARK_KEY)?.[0]?.key ?? null) : null
    } finally {
      pageSwitching = false
    }
    if (state.page === 'loans') loanHist?.start()
  }
  /** Go to a page. A page change pushes ONE history entry (Back returns to the page as it was); `loan` opens that
   * loan on the Loans page in the same entry. On the Loans page already, a loan opens or closes through its own
   * history step. Overview never holds a loan. */
  function setPage(page: BudgetPage, loan: string | null = null) {
    const open = page === 'loans' ? loan : null
    if (page === state.page) {
      if (page === 'loans' && open !== state.loan) state.loan = open
      return
    }
    pageSwitching = true
    try {
      const loc = globalThis.location
      if (loc && budgetSectionOpen(loc.search)) {
        const search = searchWithState(loc.search, { ...state, page })
        try {
          globalThis.history.pushState(null, '', loc.pathname + search + loc.hash)
        } catch {
          // history unavailable or sandboxed: the page still changes, the address just isn't kept up to date
        }
      }
      state.page = page
      state.loan = open
    } finally {
      pageSwitching = false
    }
    if (state.page === 'loans') loanHist?.start()
    // the new Overview entry carries no drill mark yet: mark it with the path still on screen, so crumbing to the top
    // re-marks instead of go(-1) onto the Loans entry, and Back onto it restores the drill
    if (state.page === 'overview') {
      drill?.start()
      debtHist?.start()
    }
  }
  /** False (and nothing changes) for a range the server would refuse. */
  function setRange(from: IsoDate, to: IsoDate): boolean {
    if (!rangeValid(from, to)) return false
    state.from = from
    state.to = to
    return true
  }
  function setPerson(person: PersonFilter) {
    state.person = person
  }
  /** Drill one level down; ignored at the bottom (purchases are not drillable) or for the wrong level. */
  function pushStep(step: DrillStep) {
    if (state.path.length >= PATH_LEVELS.length || step.level !== PATH_LEVELS[state.path.length]) return
    state.path.push({ level: step.level, key: step.key, label: step.label })
  }
  /** Back to `depth` steps (0 = the top). */
  function popTo(depth: number) {
    if (depth < state.path.length) state.path.splice(Math.max(0, depth))
  }
  /** Open a debt in place on Overview (an account id) or close it (null). Its own history step: Back closes it. */
  function setDebt(id: string | null) {
    state.debt = id !== null && LOAN_ID_RE.test(id) ? id : null
  }
  /** Changing what the second level groups by makes a chosen second step meaningless, so it is dropped. */
  function setGroupBy(g: GroupBy) {
    if (state.groupBy === g) return
    state.groupBy = g
    popTo(1)
  }
  function setReviewOnly(on: boolean) {
    state.reviewOnly = on
  }
  function setTab(tab: BudgetTab) {
    state.tab = tab
  }
  /** Put the saved view on screen, once and only when the address and history said nothing (a link or Back/Forward
   * always wins; `b_page` alone does not count, it just keeps the page the link names). Returns the second drill step to
   * check once the first level's slices have loaded, or null; `applied` is false when the view was not used. The drill
   * and the open debt are set through the same state the clicks use, so their history entries are pushed as usual. */
  let restored = false
  function restoreView(view: SavedView, ctx: { categoryIds: ReadonlyArray<string>; personIds: ReadonlyArray<string> }): { applied: boolean; pendingStep: DrillStep | null } {
    if (explicit || restored) return { applied: false, pendingStep: null }
    restored = true
    const p = restorePatch(view, { today, ...ctx })
    Object.assign(state, { from: p.from, to: p.to, person: p.person, groupBy: p.groupBy, reviewOnly: p.reviewOnly, tab: p.tab })
    const page = keepPage ? state.page : p.page
    if (page !== state.page) {
      state.page = page
      if (page === 'loans') loanHist?.start()
    }
    state.debt = state.page === 'overview' ? p.debt : null
    if (state.page === 'overview') state.path = p.path
    return { applied: true, pendingStep: state.page === 'overview' ? p.pendingStep : null }
  }
  /** The tab a pre-0.83.0 browser left behind (lib/budget/panelVisibility.ts `migrateLegacyTab`), used when the address and
   * history said nothing, and (unless `overSaved`) only when the server holds no view: same precedence as the saved view.
   * `overSaved` is for a 0.82.0 saved view that hid nothing, whose tab was only the phone tab. */
  function applyLegacyTab(tab: BudgetTab, overSaved = false): boolean {
    if (explicit || (restored && !overSaved)) return false
    state.tab = tab
    return true
  }
  return { state, summaryQuery, txnQuery, readUrl, setRange, setPerson, pushStep, popTo, setGroupBy, setReviewOnly, setTab, setPage, setDebt, restoreView, applyLegacyTab, today }
}
