// What is left of the pre-0.83.0 chart choices, and the donut size keys.
//
// Until 0.83.0 a viewer chose "Side by side | Tabs" (one localStorage key per device) and hid one chart with the
// "Show" toggles (one key per signed-in account, holding a hash of the address, never the address). The Budget section
// now always shows tabs (Spending | Debts | Both; lib/budget/savedView.ts keeps the tab per login on the server), so
// `migrateLegacyTab` reads those two keys ONCE, maps them to a tab and removes them.
//
// localStorage can be missing, blocked or throw (private windows, disabled site data, quota), so every read and
// write is wrapped: a failed read is "nothing saved", a failed write is ignored.
import type { BudgetTab } from './viewState'

export type PanelId = 'spending' | 'debts'
export const PANEL_IDS: readonly PanelId[] = ['spending', 'debts']

export const PANELS_KEY_PREFIX = 'gss-stats-budget-panels'
export const LAYOUT_KEY = 'gss-stats-budget-layout'

/** Minimal slice of the Storage API, so tests can pass a stand-in. */
export interface PanelStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** cyrb53: a small non-cryptographic 53-bit hash, as 14 hex digits. Enough to tell two accounts apart in a key. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0')
}

/** The old per-account Show key: a hash of the lower-cased address ('anon' while it is not known). */
export function panelsKey(email: string | null | undefined): string {
  const who = (email ?? '').trim().toLowerCase()
  return `${PANELS_KEY_PREFIX}:${who ? hash53(who) : 'anon'}`
}

function defaultStorage(): PanelStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null // even touching localStorage can throw when site data is blocked
  }
}

// ── Donut size ──────────────────────────────────────────────────────────────────────────────────────────────
// How big a person made a chart's donut (the DrillPie handle), kept per device. A chart shown alone keeps its own size
// (it has the whole width, so its donut is bigger). In Both the two donuts share ONE size key, so dragging either
// sizes both. DrillPie reads and writes the key; it knows nothing about charts, so the name is built here.
export const DONUT_KEY_PREFIX = 'gss-stats-budget-donut'
export function donutSizeKey(chart: PanelId, both: boolean): string {
  return both ? `${DONUT_KEY_PREFIX}:both` : `${DONUT_KEY_PREFIX}:${chart}:solo`
}

// ── Migration (once, 0.83.0) ──────────────────────────────────────────────────────────────────────────────────
const legacyDonutKey = (chart: PanelId) => `${DONUT_KEY_PREFIX}:${chart}:split`

export interface LegacyChoice {
  /** The tab those choices map to, or null for no opinion (the saved or default tab applies). */
  tab: BudgetTab | null
  /** The layout "Side by side" was chosen on this device. */
  side: boolean
}

/**
 * Reads the pre-0.83.0 choices of this browser, maps them and removes them (so it runs once):
 *  - a hidden chart is the other chart's tab (hide Spending = Debts, hide Debts = Spending);
 *  - else the layout "Side by side" chosen on purpose is Both;
 *  - else (Tabs, or nothing was ever chosen) no opinion: null, and the saved or default tab applies.
 * `side` also reports the layout choice alone: a 0.82.0 saved view that hid nothing is the phone tab only, so a person
 * who was on Side by side lands on Both over it (BudgetSection `settleView`).
 * The side-by-side donut size becomes the Both size (if there is none yet). Never throws.
 */
export function migrateLegacyTab(email: string | null | undefined, storage: PanelStorage | null = defaultStorage()): LegacyChoice {
  if (!storage) return { tab: null, side: false }
  const get = (key: string): string | null => {
    try {
      return storage.getItem(key)
    } catch {
      return null
    }
  }
  const remove = (key: string) => {
    try {
      storage.removeItem(key)
    } catch {
      // blocked or unavailable: it is read again next visit, with the same result
    }
  }
  const showKey = panelsKey(email)
  let hidden: PanelId[] = []
  try {
    const text = get(showKey)
    const raw: unknown = text ? JSON.parse(text) : null
    const list = raw && typeof raw === 'object' ? (raw as { hidden?: unknown }).hidden : undefined
    if (Array.isArray(list)) hidden = PANEL_IDS.filter((id) => list.includes(id))
  } catch {
    hidden = []
  }
  const layout = get(LAYOUT_KEY)
  const side = layout === 'side'
  let tab: BudgetTab | null = null
  if (hidden.length === 1) tab = hidden[0] === 'spending' ? 'debts' : 'spending'
  else if (side) tab = 'both'

  const bothKey = donutSizeKey('spending', true)
  if (get(bothKey) === null) {
    const split = get(legacyDonutKey('spending')) ?? get(legacyDonutKey('debts'))
    if (split !== null) {
      try {
        storage.setItem(bothKey, split)
      } catch {
        // storage full: the Both size starts automatic
      }
    }
  }
  for (const key of [showKey, LAYOUT_KEY, legacyDonutKey('spending'), legacyDonutKey('debts')]) remove(key)
  return { tab, side }
}
