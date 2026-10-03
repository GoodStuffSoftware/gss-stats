// Refetch when the user comes back to the tab. The page never polls: it fetches on mount, on a
// range/filter change and on the reload buttons, so a tab left open goes stale. This is the one
// extra trigger — when the tab becomes visible again, or the window regains focus — and it is
// deliberately small:
//
// - ONE page-level listener (document `visibilitychange` + window `focus`), a module-level
//   singleton. The first subscriber installs it, the last one to leave removes it. Cards only
//   subscribe; none of them listens to the DOM itself.
// - A debounce, so a single return (visibilitychange and focus land within a few ms of each
//   other) fires the subscribers once.
// - Never while hidden. No timer here ever fetches: the only timer is the short debounce.
// - Each subscriber applies its own throttle (RETURN_MIN_AGE_MS since its last settled load,
//   nothing in flight) — see `isStale`. It never sends `fresh: true`, so the 90 s edge cache
//   keeps absorbing repeats.
import { getCurrentScope, onScopeDispose } from 'vue'

/** A card refetches on return only if its last load settled at least this long ago. */
export const RETURN_MIN_AGE_MS = 60_000
/** visibilitychange and focus for one return arrive together; they collapse into one fire. */
export const RETURN_DEBOUNCE_MS = 250

/** True when `settledAt` (epoch ms of the last load that finished, null = never) is old enough
 * to refetch on return. The caller separately skips a card that is mid-load. */
export function isStale(settledAt: number | null, now: number = Date.now()): boolean {
  return settledAt == null || now - settledAt >= RETURN_MIN_AGE_MS
}

const subscribers = new Map<() => void, number>() // callback -> subscription count
let installed = false
let timer: ReturnType<typeof setTimeout> | null = null

const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

function fire() {
  timer = null
  if (isHidden()) return // went away again inside the debounce window
  for (const cb of [...subscribers.keys()]) {
    try {
      cb()
    } catch {
      // one subscriber's failure must not stop the others
    }
  }
}

function onReturnEvent() {
  if (isHidden() || timer) return // hidden: never; a fire is already pending: this return is covered
  timer = setTimeout(fire, RETURN_DEBOUNCE_MS)
}

function install() {
  if (installed || typeof document === 'undefined' || typeof window === 'undefined') return
  installed = true
  document.addEventListener('visibilitychange', onReturnEvent)
  window.addEventListener('focus', onReturnEvent)
}
function uninstall() {
  if (!installed) return
  installed = false
  document.removeEventListener('visibilitychange', onReturnEvent)
  window.removeEventListener('focus', onReturnEvent)
  if (timer) clearTimeout(timer)
  timer = null
}

/** Subscribes `cb` to "the user came back to the tab"; returns the unsubscribe. */
export function onReturn(cb: () => void): () => void {
  subscribers.set(cb, (subscribers.get(cb) ?? 0) + 1)
  install()
  let done = false
  return () => {
    if (done) return
    done = true
    const n = (subscribers.get(cb) ?? 1) - 1
    if (n > 0) subscribers.set(cb, n)
    else subscribers.delete(cb)
    if (subscribers.size === 0) uninstall()
  }
}

/** `onReturn` tied to the current effect scope (a component's setup): unsubscribed when it ends. */
export function useReturnRefresh(cb: () => void): void {
  const off = onReturn(cb)
  if (getCurrentScope()) onScopeDispose(off)
  else off()
}

/** Test-only: drops every subscriber and the listener. */
export function __resetReturnRefreshForTests(): void {
  subscribers.clear()
  uninstall()
}
