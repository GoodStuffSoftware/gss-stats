// Remembering the Transactions toolbar (lib/budget/txnView.ts) per signed-in login:
//   - a localStorage cache keyed by a hash of the login (lib/loginStorage.ts), read for the first paint;
//   - the server copy (GET and PUT /api/budget/prefs, one JSON blob per login in KV), which wins once it has loaded;
//   - `createPrefsSaver`: a debounced PUT that only sends a real change.
// Nothing here ever touches the URL.
import { readLoginItem, writeLoginItem } from '../loginStorage'
import { parseTxnViewPrefs, samePrefs, type TxnViewPrefs } from './txnView'

export const TXN_PREFS_PREFIX = 'gss-stats-budget-txnview'
export const PREFS_SAVE_DELAY_MS = 1500

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

export interface PrefsSaver {
  /** Queue a save after the quiet period; a value equal to what the server already holds sends nothing. */
  schedule(prefs: TxnViewPrefs): void
  /** Send the queued value now (page hide, leaving). */
  flush(): void
  cancel(): void
  /** What the server is known to hold (after a load or a successful save); a later `schedule` of the same value is a no-op. */
  setBaseline(prefs: TxnViewPrefs | null): void
}

export function createPrefsSaver(
  send: (prefs: TxnViewPrefs) => Promise<boolean>,
  delayMs = PREFS_SAVE_DELAY_MS,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): PrefsSaver {
  let baseline: TxnViewPrefs | null = null
  let pending: TxnViewPrefs | null = null
  let handle: unknown = null
  const stop = () => {
    if (handle !== null) timers.clear(handle)
    handle = null
  }
  const fire = () => {
    stop()
    const p = pending
    pending = null
    if (!p || (baseline && samePrefs(baseline, p))) return
    void send(p).then((ok) => {
      if (ok) baseline = p
    })
  }
  return {
    schedule(prefs) {
      pending = prefs
      stop()
      if (baseline && samePrefs(baseline, prefs)) {
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
