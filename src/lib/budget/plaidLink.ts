// Plaid Link in the browser (bank-links plan section 6; docs: https://plaid.com/docs/link/web/). The Link script is
// injected on the first Link click, never at page load, and only ever from cdn.plaid.com (Plaid requires that: it is not
// bundled or self-hosted). The link token being used is kept in localStorage (`gss-banks-link`) so a bank's OAuth
// redirect, which leaves the page and returns to /banks/return, can reopen Link with the same token; it is cleared when
// Link succeeds or exits and ignored after 30 minutes. It is a short-lived Link token, never an access token. Nothing
// here is logged.
import type { LinkAccount, LinkResult } from './banksClient'

export const LINK_SCRIPT_URL = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
export const LINK_STORAGE_KEY = 'gss-banks-link'
/** A saved token older than this is ignored (Link tokens expire in 30 minutes). */
export const LINK_MAX_AGE_MS = 30 * 60 * 1000
/** Plaid's OAuth redirect path (the SPA is served there; App.vue picks it up). */
export const OAUTH_RETURN_PATH = '/banks/return'
/** Where the page goes once an OAuth return has been picked up. */
export const BANKS_URL = '/?section=budget&b_page=banks'

/** `share`: the update-mode Link was started as "Share new accounts" (not Reconnect), so an OAuth resume finishes the same way. */
export interface SavedLink { token: string; itemId?: string; share?: boolean; at: number }

export function saveLink(token: string, itemId?: string, now = Date.now(), share = false): void {
  try {
    const v: SavedLink = { token, at: now, ...(itemId ? { itemId } : {}), ...(itemId && share ? { share: true } : {}) }
    window.localStorage.setItem(LINK_STORAGE_KEY, JSON.stringify(v))
  } catch {
    // storage blocked: only the OAuth resume is lost
  }
}
export function clearLink(): void {
  try {
    window.localStorage.removeItem(LINK_STORAGE_KEY)
  } catch {
    // nothing kept
  }
}
/** The saved token, or null when there is none, it is unreadable, or it is older than 30 minutes (a stale one is removed). */
export function readLink(now = Date.now()): SavedLink | null {
  try {
    const raw = window.localStorage.getItem(LINK_STORAGE_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<SavedLink> | null
    if (!v || typeof v.token !== 'string' || !v.token || typeof v.at !== 'number' || now - v.at > LINK_MAX_AGE_MS || now < v.at - 60_000) {
      clearLink()
      return null
    }
    return { token: v.token, at: v.at, ...(typeof v.itemId === 'string' && v.itemId ? { itemId: v.itemId, ...(v.share === true ? { share: true } : {}) } : {}) }
  } catch {
    clearLink()
    return null
  }
}

interface PlaidHandler { open(): void; destroy(): void }
interface PlaidGlobal {
  create(cfg: {
    token: string
    onSuccess: (publicToken: string | null, metadata: unknown) => void
    onExit: (error: unknown, metadata: unknown) => void
    receivedRedirectUri?: string
  }): PlaidHandler
}
const plaid = (): PlaidGlobal | undefined => (window as unknown as { Plaid?: PlaidGlobal }).Plaid

/** Adds the Link script once (a second call reuses the tag) and resolves when `window.Plaid` is there. */
export function loadPlaidScript(): Promise<void> {
  if (plaid()) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    let el = document.querySelector<HTMLScriptElement>(`script[data-gss-plaid]`)
    if (!el) {
      el = document.createElement('script')
      el.src = LINK_SCRIPT_URL
      el.async = true
      el.setAttribute('data-gss-plaid', '1')
      document.head.appendChild(el)
    }
    el.addEventListener('load', () => (plaid() ? resolve() : reject(new Error('link_unavailable'))), { once: true })
    el.addEventListener(
      'error',
      () => {
        el?.remove() // a later click tries again
        reject(new Error('link_unavailable'))
      },
      { once: true },
    )
  })
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Link's success metadata reduced to what the server takes (ids, names, last 4, type): nothing else leaves the browser. */
export function toLinkResult(publicToken: string, metadata: unknown): LinkResult | null {
  const m = (metadata ?? {}) as { institution?: { institution_id?: unknown; name?: unknown } | null; accounts?: unknown }
  const instId = str(m.institution?.institution_id)
  const instName = str(m.institution?.name)
  if (!instId || !instName || !Array.isArray(m.accounts)) return null
  const accounts: LinkAccount[] = []
  for (const a of m.accounts as Record<string, unknown>[]) {
    const aid = str(a?.id)
    const name = str(a?.name)
    const type = str(a?.type)
    if (!aid || !name || !type) continue
    accounts.push({ id: aid, name, mask: str(a.mask), type, subtype: str(a.subtype) })
  }
  return { publicToken, institution: { id: instId, name: instName }, accounts }
}

export interface OpenOptions {
  token: string
  /** Update mode (Reconnect, Share new accounts): the Item the token is for. */
  itemId?: string
  /** Update mode started as "Share new accounts": kept so an OAuth resume finishes the same way. */
  share?: boolean
  /** OAuth return: the full address Plaid sent the browser back to. */
  receivedRedirectUri?: string
  /** A new Link (no itemId) finished: the public token and what Link shows about the bank. */
  onSuccess: (r: LinkResult | null, publicToken: string) => void | Promise<void>
  /** Link was closed without finishing. */
  onExit: () => void
}

/** Saves the token, loads the script (first call only), opens Link. Rejects `link_unavailable` when the script cannot load. */
export async function openLink(o: OpenOptions): Promise<void> {
  if (!o.receivedRedirectUri) saveLink(o.token, o.itemId, Date.now(), o.share) // a resume keeps the original time stamp
  await loadPlaidScript()
  const p = plaid()
  if (!p) throw new Error('link_unavailable')
  let handler: PlaidHandler | null = null
  handler = p.create({
    token: o.token,
    ...(o.receivedRedirectUri ? { receivedRedirectUri: o.receivedRedirectUri } : {}),
    onSuccess: (publicToken, metadata) => {
      clearLink()
      handler?.destroy()
      void o.onSuccess(publicToken ? toLinkResult(publicToken, metadata) : null, publicToken ?? '')
    },
    onExit: () => {
      clearLink()
      handler?.destroy()
      o.onExit()
    },
  })
  handler.open()
}

// An OAuth return is noticed once, by App.vue at startup (before the Budget section reads the address): it keeps the full
// address here and moves the address bar to the Banks page. The Banks page then calls `resumeLink`.
let oauthReturn: string | null = null
/** App.vue: true (and the address becomes the Banks page) when the page was opened at /banks/return. */
export function captureOAuthReturn(loc: Pick<Location, 'pathname' | 'href'> = window.location): boolean {
  if (loc.pathname !== OAUTH_RETURN_PATH) return false
  oauthReturn = loc.href
  try {
    window.history.replaceState(window.history.state, '', BANKS_URL)
  } catch {
    // history unavailable: the page still opens on the Banks section it is given
  }
  return true
}
/** Takes the captured OAuth return address, once. */
export function takeOAuthReturn(): string | null {
  const v = oauthReturn
  oauthReturn = null
  return v
}
/** For tests. */
export function setOAuthReturn(href: string | null): void {
  oauthReturn = href
}

/** Reopens Link for an OAuth return with the saved token and `receivedRedirectUri`. False when no fresh token was saved. */
export async function resumeLink(href: string, o: Omit<OpenOptions, 'token' | 'itemId' | 'share' | 'receivedRedirectUri'>): Promise<{ itemId?: string; share?: boolean } | null> {
  const saved = readLink()
  if (!saved) return null
  await openLink({ ...o, token: saved.token, itemId: saved.itemId, share: saved.share, receivedRedirectUri: href })
  try {
    window.history.replaceState(window.history.state, '', BANKS_URL)
  } catch {
    // the address stays as it is
  }
  return { itemId: saved.itemId, ...(saved.share ? { share: true } : {}) }
}
