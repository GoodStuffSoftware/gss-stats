// Budget section view state: ONE object the pie, the crumbs, the filters and the table all read, mirrored
// to the address bar with replaceState (docs/adr/0007-budget-section.md). The table's TxnQuery and the
// pie's SummaryQuery are computed from it, so they cannot disagree.
//
// URL (`?section=budget` plus `b_*` params; every other param is left alone, see sectionLink.ts):
//   b_from, b_to (YYYY-MM-DD, always written), b_person (omitted = all), b_path (JSON
//   [[level,key,label],...], omitted = top), b_group=account (omitted = merchant), b_review=1, b_tab=debts.
// Everything read back is validated; anything malformed falls back to its default.
import { computed, reactive, watch } from 'vue'
import { BUDGET_PARAM_PREFIX, budgetSectionOpen } from './sectionLink'
import type { IsoDate, PersonFilter, SummaryQuery, TxnQuery } from './types'

export type BudgetTab = 'spending' | 'debts'
export type GroupBy = 'merchant' | 'account'
export interface DrillStep { level: 'category' | 'merchant'; key: string; label: string }
export interface BudgetViewState {
  from: IsoDate
  to: IsoDate
  person: PersonFilter
  path: DrillStep[]
  groupBy: GroupBy
  reviewOnly: boolean
  tab: BudgetTab
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
/** Which preset a range is on `today`, else 'custom'. */
export function presetOf(from: string, to: string, today: IsoDate): RangePreset {
  for (const p of RANGE_PRESETS) {
    const r = rangeForPreset(p.id, today)
    if (r && r.from === from && r.to === to) return p.id
  }
  return 'custom'
}

// ── State <-> URL ─────────────────────────────────────────────────────────────────────────────────────────
export function defaultViewState(today: IsoDate = todayIso()): BudgetViewState {
  const r = rangeForPreset('this-month', today)!
  return { from: r.from, to: r.to, person: 'all', path: [], groupBy: 'merchant', reviewOnly: false, tab: 'spending' }
}

const P = BUDGET_PARAM_PREFIX
const PERSON_RE = /^[a-z0-9][\w-]{0,23}$/
const STEP_TEXT_MAX = 120

function parsePath(raw: string | null): DrillStep[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr) || arr.length > PATH_LEVELS.length) return []
    const out: DrillStep[] = []
    for (let i = 0; i < arr.length; i++) {
      const t = arr[i] as unknown
      if (!Array.isArray(t) || t[0] !== PATH_LEVELS[i]) return []
      const key = t[1]
      const label = t[2]
      if (typeof key !== 'string' || !key || key.length > STEP_TEXT_MAX) return []
      out.push({ level: PATH_LEVELS[i], key, label: typeof label === 'string' && label ? label.slice(0, STEP_TEXT_MAX) : key })
    }
    return out
  } catch {
    return []
  }
}

/** The view state a query string names; anything missing or malformed takes its default. */
export function stateFromSearch(search: string, today: IsoDate = todayIso()): BudgetViewState {
  const state = defaultViewState(today)
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
  state.path = parsePath(q.get(`${P}path`))
  state.groupBy = q.get(`${P}group`) === 'account' ? 'account' : 'merchant'
  state.reviewOnly = q.get(`${P}review`) === '1'
  state.tab = q.get(`${P}tab`) === 'debts' ? 'debts' : 'spending'
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
  if (state.path.length) q.set(`${P}path`, JSON.stringify(state.path.map((s) => [s.level, s.key, s.label])))
  if (state.groupBy === 'account') q.set(`${P}group`, 'account')
  if (state.reviewOnly) q.set(`${P}review`, '1')
  if (state.tab === 'debts') q.set(`${P}tab`, 'debts')
  const s = q.toString()
  return s ? `?${s}` : ''
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
export function useBudgetViewState(today: IsoDate = todayIso()) {
  const state = reactive<BudgetViewState>(stateFromSearch(globalThis.location?.search ?? '', today))
  const summaryQuery = computed(() => summaryQueryOf(state))
  const txnQuery = computed(() => txnQueryOf(state))

  // replaceState, not pushState: drilling adds no history entries. Skipped once the section is no longer
  // the one in the address bar (App closed it), so a late write cannot bring `section=budget` back.
  function writeUrl() {
    try {
      const loc = globalThis.location
      if (!budgetSectionOpen(loc.search)) return
      const search = searchWithState(loc.search, state)
      if (search !== loc.search) globalThis.history.replaceState(globalThis.history.state, '', loc.pathname + search + loc.hash)
    } catch {
      // history unavailable or sandboxed: the link just isn't kept up to date
    }
  }
  watch(state, writeUrl, { deep: true })

  /** Re-read the address bar (back/forward). */
  function readUrl() {
    Object.assign(state, stateFromSearch(globalThis.location?.search ?? '', today))
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
  return { state, summaryQuery, txnQuery, readUrl, setRange, setPerson, pushStep, popTo, setGroupBy, setReviewOnly, setTab, today }
}
