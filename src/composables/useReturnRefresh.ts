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

/** A load that has been running this long is treated as hung, not in flight, so a return may
 * refetch past it. Reasoning: the slowest legitimate answer is the metrics endpoint's all-miss
 * D1 path (a few seconds, well under 10 s), and the browser gives a request no timeout of its own,
 * so a socket left half-open by laptop sleep or a dropped network would otherwise block the
 * return refetch (the very recovery path for that tab) forever. 30 s is several times the slowest
 * real load and half the 60 s throttle, so a slow-but-alive request is never doubled in practice,
 * and a refetch that does start supersedes the hung one (its late answer is dropped). */
export const RETURN_INFLIGHT_MAX_MS = 30_000

/** True when a load that began at `startedAt` (epoch ms, null = none running) is still plausibly
 * in flight — running, and not yet old enough to count as hung. */
export function isInFlight(startedAt: number | null, now: number = Date.now()): boolean {
  return startedAt != null && now - startedAt < RETURN_INFLIGHT_MAX_MS
}

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
  // A pending debounce timer is left to fire: with no subscribers it just walks an empty set, and
  // a subscriber that leaves and rejoins inside the debounce window (a card rebuilding at the ET
  // day rollover) must not lose the return it was about to see.
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

// ── Live changes (composables/useLiveChanges.ts) ─────────────────────────────────────────────
// A second, separate source: the server's "something changed" push, already delayed past the edge
// cache and dropped while hidden or idle by the socket composable. Its subscribers are their own
// set, so a return never wakes a live subscriber and a push never wakes a return subscriber. Each
// live subscriber applies its own gate (isStale / isInFlight above, plus its own opt-in: only data
// the server marked `liveSafe`), exactly as the return subscribers do.
const liveSubscribers = new Map<() => void, number>() // callback -> subscription count

/** Subscribes `cb` to "the server pushed a change"; returns the unsubscribe. */
export function onLiveChange(cb: () => void): () => void {
  liveSubscribers.set(cb, (liveSubscribers.get(cb) ?? 0) + 1)
  let done = false
  return () => {
    if (done) return
    done = true
    const n = (liveSubscribers.get(cb) ?? 1) - 1
    if (n > 0) liveSubscribers.set(cb, n)
    else liveSubscribers.delete(cb)
  }
}

/** `onLiveChange` tied to the current effect scope (a component's setup): unsubscribed when it ends. */
export function useLiveRefresh(cb: () => void): void {
  const off = onLiveChange(cb)
  if (getCurrentScope()) onScopeDispose(off)
  else off()
}

/** Fires every live subscriber once (never while hidden). Called by useLiveChanges only. */
export function emitLiveChange(): void {
  if (isHidden()) return
  for (const cb of [...liveSubscribers.keys()]) {
    try {
      cb()
    } catch {
      // one subscriber's failure must not stop the others
    }
  }
}

/** Test-only: drops every subscriber and the listener. */
export function __resetReturnRefreshForTests(): void {
  subscribers.clear()
  liveSubscribers.clear()
  uninstall()
  if (timer) clearTimeout(timer)
  timer = null
}
