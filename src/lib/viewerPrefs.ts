// Per-viewer navigation state (layout version 13): which page this viewer is on, the page they
// last viewed in each group, and which drawer groups and drill trees they collapsed. It lives in this browser's
// localStorage, NOT in the shared dashboard config: everyone shares one config in KV and the last
// write wins, so one person switching pages must never move everyone else (or cost a KV write).
//
// localStorage can be missing, blocked or throw (private windows, disabled site data, quota), so
// every access is wrapped: a failed read is "nothing remembered", a failed write is ignored, and
// the dashboard works the same either way — it just lands on the config's landing page.
//
// Keyed per signed-in login (`gss-stats-nav:<hash of the lower-cased address>`, lib/loginStorage.ts), so two
// people sharing a browser keep separate state. App calls `setViewerLogin` once /auth/me has answered and
// before it applies any of this; until then, and while signed out, nothing is read or written.
import type { DashboardPage } from '../types'
import { adoptLegacyItem, loginKey, readLoginItem, writeLoginItem } from './loginStorage'

/** The key every viewer shared before state was kept per login; adopted by the first login with none of its own. */
export const VIEWER_PREFS_KEY = 'gss-stats-nav'

let login: string | null = null

/** localStorage key holding this login's navigation state (null when nobody is signed in). */
export const viewerPrefsKey = (email: string | null | undefined): string | null => loginKey(VIEWER_PREFS_KEY, email)

/** Name the signed-in login whose state read/writeViewerPrefs use (null: signed out, nothing is kept).
 * The first login to arrive with no state of its own adopts the legacy shared value, which is then removed. */
export function setViewerLogin(email: string | null | undefined): void {
  login = email?.trim() ? email : null
  if (login) adoptLegacyItem(VIEWER_PREFS_KEY, login, VIEWER_PREFS_KEY)
}

export interface ViewerPrefs {
  /** The page this viewer was last on. */
  active?: string
  /** Group name → the page last viewed in it (picking a group opens that page). */
  lastByGroup?: Record<string, string>
  /** Drawer groups this viewer collapsed. */
  collapsed?: string[]
  /** Pages whose drill pages this viewer collapsed in the drawer (page ids). */
  collapsedPages?: string[]
}

const ID_MAX = 200
const isId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= ID_MAX

/** What this browser remembers, validated field by field (anything malformed is dropped). */
export function readViewerPrefs(): ViewerPrefs {
  let raw: unknown
  try {
    const text = readLoginItem(VIEWER_PREFS_KEY, login)
    raw = text ? JSON.parse(text) : null
  } catch {
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: ViewerPrefs = {}
  if (isId(r.active)) out.active = r.active
  if (r.lastByGroup && typeof r.lastByGroup === 'object' && !Array.isArray(r.lastByGroup)) {
    const entries = Object.entries(r.lastByGroup as Record<string, unknown>).filter(([k, v]) => isId(k) && isId(v)) as [string, string][]
    if (entries.length) out.lastByGroup = Object.fromEntries(entries.slice(0, 100))
  }
  if (Array.isArray(r.collapsed)) {
    const c = r.collapsed.filter(isId).slice(0, 100)
    if (c.length) out.collapsed = c
  }
  if (Array.isArray(r.collapsedPages)) {
    const c = r.collapsedPages.filter(isId).slice(0, 200)
    if (c.length) out.collapsedPages = c
  }
  return out
}

/** Remember `prefs` in this browser. Never throws. */
export function writeViewerPrefs(prefs: ViewerPrefs): void {
  try {
    writeLoginItem(VIEWER_PREFS_KEY, login, JSON.stringify(prefs))
  } catch {
    // unserializable: nothing is remembered, nothing breaks
  }
}

/** The page to show on load: the one a `?page=<id>` link names if it exists (a copied URL wins over
 * the remembered page), else the one this viewer was last on if it still exists, else the
 * config's landing page (`activePageId`, ★ Overview for a first-time viewer), else the default
 * page, else the first page. */
export function initialPageId(pages: readonly DashboardPage[], prefs: ViewerPrefs, landingId: string, linkedId?: string): string {
  const has = (id: string | undefined): id is string => !!id && pages.some((p) => p.id === id)
  if (has(linkedId)) return linkedId
  if (has(prefs.active)) return prefs.active
  if (has(landingId)) return landingId
  return (pages.find((p) => p.isDefault) ?? pages[0]).id
}

export const DARK_PREF_KEY = 'gss-stats-dark'

/** Whether this viewer chose dark mode. A blocked or throwing localStorage reads as "no". */
export function readDarkPref(): boolean {
  try {
    return globalThis.localStorage?.getItem(DARK_PREF_KEY) === '1'
  } catch {
    return false
  }
}

/** Remember this viewer's dark-mode choice. Never throws. */
export function writeDarkPref(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(DARK_PREF_KEY, on ? '1' : '0')
  } catch {
    // storage full, blocked or unavailable: the choice lasts this visit only
  }
}
