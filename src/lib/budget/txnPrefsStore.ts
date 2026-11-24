// Remembering the Transactions toolbar (lib/budget/txnView.ts) per signed-in login:
//   - a localStorage cache keyed by a hash of the login (lib/loginStorage.ts), read for the first paint;
//   - the server copy (GET and PUT /api/budget/prefs, one JSON blob per login in KV), which wins once it has loaded;
//   - `createPrefsSaver`: a debounced PUT that only sends a real change (generic: the toolbar block and the saved view
//     block, lib/budget/savedView.ts, each have their own saver, GET reads both from the same route).
// Nothing here ever touches the URL.
import { readLoginItem, writeLoginItem } from '../loginStorage'
import { parseSavedView, type SavedView } from './savedView'
import { parseTxnViewPrefs, type TxnViewPrefs } from './txnView'

export const TXN_PREFS_PREFIX = 'gss-stats-budget-txnview'
export const PREFS_SAVE_DELAY_MS = 1500
/** The saved view (Show choice and drill location) waits a little longer: it changes in bursts while someone drills. */
export const VIEW_SAVE_DELAY_MS = 2000

export function readCachedPrefs(email: string | null | undefined): TxnViewPrefs | null {
  const text = readLoginItem(TXN_PREFS_PREFIX, email)
  if (!text) return null
  try {
    return parseTxnViewPrefs(JSON.parse(text))
  } catch {
    return null
  }
}
export function writeCachedPrefs(email: string | null | undefined, prefs: TxnViewPrefs): void {
  writeLoginItem(TXN_PREFS_PREFIX, email, JSON.stringify(prefs))
}

/** The saved toolbar state, or null (nothing saved yet, or the server did not answer: the cache stands). Never throws. */
export async function fetchServerPrefs(fetchImpl: typeof fetch = fetch): Promise<TxnViewPrefs | null> {
  try {
    const res = await fetchImpl('/api/budget/prefs', { cache: 'no-store', headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const body = (await res.json()) as { txnView?: unknown } | null
    return body?.txnView ? parseTxnViewPrefs(body.txnView) : null
  } catch {
    return null
  }
}

/** PUTs the toolbar state. Resolves true when the server kept it. Never throws. */
export async function putServerPrefs(prefs: TxnViewPrefs, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl('/api/budget/prefs', {
      method: 'PUT',
      keepalive: true,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ txnView: prefs }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** The saved Budget view (where the person left the section): `ok` is false when the server did not answer (nothing is known),
 *  true with `view: null` when it answered and nothing is saved. Never throws. */
export async function fetchServerView(fetchImpl: typeof fetch = fetch): Promise<{ ok: boolean; view: SavedView | null; legacyOpen: boolean }> {
  try {
    const res = await fetchImpl('/api/budget/prefs', { cache: 'no-store', headers: { Accept: 'application/json' } })
    if (!res.ok) return { ok: false, view: null, legacyOpen: false }
    const body = (await res.json()) as { view?: unknown; viewLegacy?: unknown } | null
    const view = body?.view ? parseSavedView(body.view) : null
    return { ok: true, view, legacyOpen: !!view && body?.viewLegacy === true }
  } catch {
    return { ok: false, view: null, legacyOpen: false }
  }
}

/** PUTs the saved view (its own KV key, so it never races the toolbar block). Resolves true when the server kept it. Never throws. */
export async function putServerView(view: SavedView, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl('/api/budget/prefs', {
      method: 'PUT',
      keepalive: true,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ view }),
    })
    return res.ok
  } catch {
    return false
  }
}

export interface PrefsSaver<T = TxnViewPrefs> {
  /** Queue a save after the quiet period; a value equal to what the server already holds sends nothing. */
  schedule(prefs: T): void
  /** Send the queued value now (page hide, leaving). */
  flush(): void
  cancel(): void
  /** What the server is known to hold (after a load or a successful save); a later `schedule` of the same value is a no-op. */
  setBaseline(prefs: T | null): void
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export function createPrefsSaver<T = TxnViewPrefs>(
  send: (prefs: T) => Promise<boolean>,
  delayMs = PREFS_SAVE_DELAY_MS,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
  /** Called after every send with whether the server kept it. A failed save leaves the baseline alone, so the next change sends again. */
  onResult: (ok: boolean) => void = () => {},
  /** Equality of two values (default: same JSON). */
  same: (a: T, b: T) => boolean = sameJson,
): PrefsSaver<T> {
  let baseline: T | null = null
  let pending: T | null = null
  let handle: unknown = null
  const stop = () => {
    if (handle !== null) timers.clear(handle)
    handle = null
  }
  const fire = () => {
    stop()
    const p = pending
    pending = null
    if (!p || (baseline && same(baseline, p))) return
    void send(p).then((ok) => {
      if (ok) baseline = p
      onResult(ok)
    })
  }
  return {
    schedule(prefs) {
      pending = prefs
      stop()
      if (baseline && same(baseline, prefs)) {
        pending = null
        return
      }
      handle = timers.set(fire, delayMs)
    },
    flush: fire,
    cancel() {
      stop()
      pending = null
    },
    setBaseline(prefs) {
      baseline = prefs
    },
  }
}
