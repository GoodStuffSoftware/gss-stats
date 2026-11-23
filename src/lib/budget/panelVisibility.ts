// Which Budget charts this viewer chose to hide (desktop, where the spending and debt panels sit side by
// side). Per viewer, in this browser's localStorage, like the site's other view state (lib/viewerPrefs.ts),
// and keyed by the signed-in account so two people sharing one browser keep separate choices. The key holds a
// hash of the address, never the address (BudgetSection gets it from GET /api/budget/access).
//
// localStorage can be missing, blocked or throw (private windows, disabled site data, quota), so every read and
// write is wrapped: a failed read is "nothing hidden", a failed write is ignored (the choice lasts this visit).
//
// Hiding both charts is not allowed: `togglePanel` refuses to hide the last one shown, and a stored value that
// hides both reads as "nothing hidden", so the section can never be left with no chart and no way back.

export type PanelId = 'spending' | 'debts'
export const PANEL_IDS: readonly PanelId[] = ['spending', 'debts']

export const PANELS_KEY_PREFIX = 'gss-stats-budget-panels'

/** Minimal slice of the Storage API, so tests can pass a stand-in. */
export interface PanelStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
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

/** The localStorage key for one account: a hash of the lower-cased address ('anon' while it is not known). */
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

/** The charts this account hid. Anything malformed, or a value that hides both, reads as nothing hidden. */
export function readHiddenPanels(email: string | null | undefined, storage: PanelStorage | null = defaultStorage()): PanelId[] {
  try {
    const text = storage?.getItem(panelsKey(email))
    if (!text) return []
    const raw: unknown = JSON.parse(text)
    const list = raw && typeof raw === 'object' ? (raw as { hidden?: unknown }).hidden : undefined
    if (!Array.isArray(list)) return []
    const hidden = PANEL_IDS.filter((id) => list.includes(id))
    return hidden.length >= PANEL_IDS.length ? [] : hidden
  } catch {
    return []
  }
}

/** Remember the hidden charts for this account. Never throws. */
export function writeHiddenPanels(email: string | null | undefined, hidden: readonly PanelId[], storage: PanelStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(panelsKey(email), JSON.stringify({ hidden: PANEL_IDS.filter((id) => hidden.includes(id)) }))
  } catch {
    // storage full, blocked or unavailable: the choice lasts this visit only
  }
}

/** Whether `id` may be hidden now: only while the other chart stays shown. */
export function canHide(hidden: readonly PanelId[], id: PanelId): boolean {
  return PANEL_IDS.some((p) => p !== id && !hidden.includes(p))
}

/** The hidden list after the control for `id` is pressed: a hidden chart comes back; a shown one hides unless it
 * is the last one shown (then nothing changes). */
export function togglePanel(hidden: readonly PanelId[], id: PanelId): PanelId[] {
  if (hidden.includes(id)) return hidden.filter((p) => p !== id)
  return canHide(hidden, id) ? [...hidden, id] : [...hidden]
}

// ── Desktop layout (Side by side | Tabs) ──────────────────────────────────────────────────────────────────
// How the Spending and Debts panels are arranged from 1024 px up. A choice about THIS device's screen, like the
// table's column sizing and the phone's Cards | Table switch, so it is kept per device (one localStorage key, not
// per account and not in the per-login KV prefs). Below 1024 px the tabs always apply and this is ignored.
export type DesktopLayout = 'side' | 'tabs'
export const LAYOUT_KEY = 'gss-stats-budget-layout'

/** The saved layout; anything missing, unknown or unreadable is Side by side. Never throws. */
export function readDesktopLayout(storage: PanelStorage | null = defaultStorage()): DesktopLayout {
  try {
    return storage?.getItem(LAYOUT_KEY) === 'tabs' ? 'tabs' : 'side'
  } catch {
    return 'side'
  }
}

/** Remember the layout on this device. Never throws (a failed write lasts this visit only). */
export function writeDesktopLayout(layout: DesktopLayout, storage: PanelStorage | null = defaultStorage()): void {
  try {
    storage?.setItem(LAYOUT_KEY, layout === 'tabs' ? 'tabs' : 'side')
  } catch {
    // storage full, blocked or unavailable: the choice lasts this visit only
  }
}
