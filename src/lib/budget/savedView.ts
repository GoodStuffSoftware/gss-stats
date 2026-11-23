// The Budget view a login left behind: the tab (Spending, Debts or Both), the spending drill path, Group by,
// Needs review, the open debt, the range, the person and the page. One small JSON block per login (GET and PUT
// /api/budget/prefs, key `view`), so "come back to where we left off" works on any device.
//
// Pure and dependency free: the Pages function validates with `parseSavedView(raw, true)` and the browser reads with the
// lenient form, so the schema lives here once. It imports nothing at run time (the function bundle must not pull in Vue).
// Every string and list is bounded, so a valid view is always far under the 4 KB the prefs endpoint accepts.
//
// What it is NOT: the donut sizes, which stay per device. The state a link or a history entry carries always wins over
// this on open (lib/budget/viewState.ts `restoreView`).
//
// Legacy: until 0.83.0 a block also carried `hidden` (the Show choice: the one hidden chart) and `tab` was only the phone
// tab. Both are still accepted, from old stored blocks and old cached clients, and folded into `tab` on read: hiding the
// spending chart is the Debts tab, hiding the debts chart is the Spending tab. `hidden` is never part of a view any more.

export const VIEW_PRESETS = ['this-month', 'last-month', '3-months', 'ytd', 'custom'] as const
export type ViewPreset = (typeof VIEW_PRESETS)[number]

export interface SavedStep {
  level: 'category' | 'merchant'
  key: string
  label: string
}
export interface SavedView {
  tab: 'spending' | 'debts' | 'both'
  page: 'overview' | 'loans'
  /** The spending drill: category, then merchant (or account). At most two steps. */
  path: SavedStep[]
  groupBy: 'merchant' | 'account'
  review: boolean
  /** The debt open in place (an account id) or null (the debt pie). */
  debt: string | null
  /** A preset moves with the calendar; `custom` carries its own dates. */
  range: { preset: ViewPreset; from?: string; to?: string }
  /** 'all' or a person id. */
  person: string
}

export const VIEW_STEP_KEY_MAX = 120
export const VIEW_STEP_LABEL_MAX = 60
export const VIEW_BYTES_MAX = 4096

const ISO = /^\d{4}-\d{2}-\d{2}$/
const PERSON = /^[a-z0-9][\w-]{0,23}$/
const DEBT_ID = /^[A-Za-z0-9][\w.-]{0,63}$/
const FIELDS = ['tab', 'page', 'path', 'groupBy', 'review', 'debt', 'range', 'person']
/** Accepted but optional: the pre-0.83.0 Show choice (see the header). */
const LEGACY_FIELDS = ['hidden']

export function defaultSavedView(): SavedView {
  return { tab: 'spending', page: 'overview', path: [], groupBy: 'merchant', review: false, debt: null, range: { preset: 'this-month' }, person: 'all' }
}

/** Bytes of the PUT body for this view. */
export function savedViewBytes(v: SavedView): number {
  return new TextEncoder().encode(JSON.stringify({ view: v })).length
}

export function sameSavedView(a: SavedView, b: SavedView): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function steps(raw: unknown, strict: boolean): SavedStep[] | null {
  if (!Array.isArray(raw) || raw.length > 2) return strict ? null : []
  const out: SavedStep[] = []
  const levels = ['category', 'merchant'] as const
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as unknown
    const o = t && typeof t === 'object' ? (t as Record<string, unknown>) : null
    const ok =
      !!o &&
      o.level === levels[i] &&
      typeof o.key === 'string' &&
      o.key.length > 0 &&
      o.key.length <= VIEW_STEP_KEY_MAX &&
      typeof o.label === 'string' &&
      o.label.length <= VIEW_STEP_LABEL_MAX &&
      (!strict || Object.keys(o).every((k) => k === 'level' || k === 'key' || k === 'label'))
    if (!ok) return strict ? null : out // a broken step ends the path there (lenient)
    out.push({ level: levels[i], key: (o as { key: string }).key, label: (o as { label: string }).label || (o as { key: string }).key.slice(0, VIEW_STEP_LABEL_MAX) })
  }
  return out
}

function range(raw: unknown, strict: boolean): SavedView['range'] | null {
  const d = defaultSavedView().range
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  if (!o || typeof o.preset !== 'string' || !(VIEW_PRESETS as readonly string[]).includes(o.preset)) return strict ? null : d
  const preset = o.preset as ViewPreset
  if (strict && Object.keys(o).some((k) => k !== 'preset' && k !== 'from' && k !== 'to')) return null
  if (preset !== 'custom') {
    if (strict && (o.from !== undefined || o.to !== undefined)) return null
    return { preset }
  }
  const fromOk = typeof o.from === 'string' && ISO.test(o.from)
  const toOk = typeof o.to === 'string' && ISO.test(o.to)
  if (!fromOk || !toOk) return strict ? null : d
  return { preset, from: o.from as string, to: o.to as string }
}

/** A legacy hidden chart leaves the other one: the matching single tab. */
function tabFolded(tab: SavedView['tab'], hidden: unknown): SavedView['tab'] {
  return hidden === 'spending' ? 'debts' : hidden === 'debts' ? 'spending' : tab
}

/** True for a 0.82.0 block that hid nothing (`hidden: null`): the one legacy shape whose tab is only the phone tab, so a
 *  browser that chose "Side by side" there lands on Both (BudgetSection `settleView`). A new block never carries `hidden`. */
export function isLegacyOpenView(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).hidden === null
}

/** Reads a saved or posted view. `strict` (the server): every field present and exactly right, no unknown field, else null.
 *  Lenient (the browser): a wrong field takes its default; null only when it is not an object. */
export function parseSavedView(raw: unknown, strict = false): SavedView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (strict && (Object.keys(o).some((k) => !FIELDS.includes(k) && !LEGACY_FIELDS.includes(k)) || FIELDS.some((k) => !(k in o)))) return null
  const d = defaultSavedView()
  const hiddenOk = !('hidden' in o) || o.hidden === null || o.hidden === 'spending' || o.hidden === 'debts'
  const tabOk = o.tab === 'spending' || o.tab === 'debts' || o.tab === 'both'
  const pageOk = o.page === 'overview' || o.page === 'loans'
  const groupOk = o.groupBy === 'merchant' || o.groupBy === 'account'
  const reviewOk = typeof o.review === 'boolean'
  const debtOk = o.debt === null || (typeof o.debt === 'string' && DEBT_ID.test(o.debt))
  const personOk = o.person === 'all' || (typeof o.person === 'string' && PERSON.test(o.person))
  const path = steps(o.path, strict)
  const rng = range(o.range, strict)
  if (strict && !(hiddenOk && tabOk && pageOk && groupOk && reviewOk && debtOk && personOk && path && rng)) return null
  const out: SavedView = {
    tab: tabFolded(tabOk ? (o.tab as SavedView['tab']) : d.tab, hiddenOk ? o.hidden : null),
    page: pageOk ? (o.page as SavedView['page']) : d.page,
    path: path ?? [],
    groupBy: groupOk ? (o.groupBy as SavedView['groupBy']) : d.groupBy,
    review: reviewOk ? (o.review as boolean) : d.review,
    debt: debtOk ? (o.debt as string | null) : d.debt,
    range: rng ?? d.range,
    person: personOk ? (o.person as string) : d.person,
  }
  if (strict && savedViewBytes(out) > VIEW_BYTES_MAX) return null
  return out
}

/** A view that is certain to fit the cap: the drill path is dropped first (it is the only unbounded-ish part), nothing else can overflow. */
export function fitSavedView(v: SavedView): SavedView {
  return savedViewBytes(v) > VIEW_BYTES_MAX ? { ...v, path: [] } : v
}
