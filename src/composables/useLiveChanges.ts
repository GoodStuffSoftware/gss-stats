// Live push: one same-origin WebSocket to /api/live that tells an open dashboard tab "something
// changed". The server (workers/live, a Durable Object) sends the exact text {"t":"changed"} at
// most once per fixed 15-minute boundary, and only after a new non-refused beacon row was
// written. The message carries nothing else: no row, id, count, path or clock time.
//
// What this module does with it is deliberately small:
//
// - The socket is open ONLY while the tab is visible, there has been input within IDLE_MS (2 h)
//   and the browser has WebSocket. Hidden or idle closes it; visible or input reopens it. A tab
//   left open and untouched all day therefore holds no socket and costs nothing.
// - It acts on the exact ping text and nothing else. Anything else the server (or anything in
//   between) sends is ignored.
// - A ping fires the live subscribers (useReturnRefresh.ts `onLiveChange`) at the 15-minute
//   boundary + 95 s + rand(0-25 s): past the server's 90 s edge-cache TTL, so the refetch cannot
//   be served the answer from before the change, and spread out so tabs do not all hit at once.
//   A ping that comes due while the tab is hidden or idle is dropped; the return refetch
//   (useReturnRefresh) catches up when the user is back.
// - Reconnects back off from 1 s, doubling to a 5 min cap with jitter, reset when a socket opens.
//   A "ping" text goes out every 50 s so an idle-but-open socket is not dropped by a proxy (the
//   server answers it itself without waking the Durable Object).
// - Fail-soft: every error is swallowed, and none of today's refresh paths (load, filter change,
//   Refresh button, return to the tab, ET midnight) depends on this module. With no socket the
//   dashboard behaves exactly as it did before it existed.
//
// Which data then refetches is the subscribers' decision, and it is fail-closed: only values the
// server flagged `liveSafe === true` (never anything that can count a refused row).
import { getCurrentScope, onScopeDispose } from 'vue'
import { emitLiveChange } from './useReturnRefresh'

/** The only message acted on. */
export const LIVE_CHANGED_TEXT = '{"t":"changed"}'
export const LIVE_PATH = '/api/live'
/** The ping lands at a fixed boundary; the refetch waits this long past it (edge cache is 90 s)... */
export const LIVE_FIRE_DELAY_MS = 95_000
/** ...plus up to this much random spread. */
export const LIVE_FIRE_JITTER_MS = 25_000
/** Fixed 15-minute boundaries (ET offsets are whole hours, so they equal epoch boundaries). */
export const LIVE_BOUNDARY_MS = 15 * 60_000
/** No input for this long: the socket closes and pings are dropped until the next input. */
export const LIVE_IDLE_MS = 2 * 60 * 60_000
export const LIVE_KEEPALIVE_MS = 50_000
export const LIVE_BACKOFF_BASE_MS = 1_000
export const LIVE_BACKOFF_CAP_MS = 5 * 60_000

const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

/** The reconnect delay after `attempt` consecutive failures (0 = the first): 1 s doubling to the
 * 5 min cap, with the upper half jittered: the result is in [base / 2, base]. */
export function liveBackoffMs(attempt: number, random: number = Math.random()): number {
  const base = Math.min(LIVE_BACKOFF_CAP_MS, LIVE_BACKOFF_BASE_MS * 2 ** Math.min(attempt, 30))
  return Math.round(base * (0.5 + 0.5 * random))
}

/** When a ping that arrived at `now` should fire: its 15-minute boundary + 95 s + `jitter` (0-25 s). */
export function liveFireAt(now: number, jitterMs: number): number {
  return Math.floor(now / LIVE_BOUNDARY_MS) * LIVE_BOUNDARY_MS + LIVE_FIRE_DELAY_MS + jitterMs
}

let started = false
let ws: WebSocket | null = null
let attempt = 0
let lastInputAt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let keepaliveTimer: ReturnType<typeof setInterval> | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let fireTimer: ReturnType<typeof setTimeout> | null = null

const isVisible = () => typeof document !== 'undefined' && document.visibilityState !== 'hidden'
const isIdle = () => Date.now() - lastInputAt >= LIVE_IDLE_MS
const supported = () => typeof WebSocket !== 'undefined'
const wanted = () => started && supported() && isVisible() && !isIdle()

function clearTimer(t: ReturnType<typeof setTimeout> | null) {
  if (t) clearTimeout(t)
}

function liveUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${LIVE_PATH}`
}

function stopSocketTimers() {
  if (keepaliveTimer) clearInterval(keepaliveTimer)
  keepaliveTimer = null
  clearTimer(idleTimer)
  idleTimer = null
}

function closeSocket() {
  stopSocketTimers()
  const s = ws
  ws = null
  if (!s) return
  s.onopen = s.onmessage = s.onerror = s.onclose = null
  try {
    s.close()
  } catch {
    // already closed
  }
}

function scheduleReconnect() {
  if (reconnectTimer || !wanted()) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    evaluate()
  }, liveBackoffMs(attempt))
  attempt++
}

/** The socket is gone (closed by the server, the network or a failed handshake): try again later
 * if the tab still wants one. */
function onSocketGone(s: WebSocket) {
  if (ws !== s) return // a socket we already replaced or closed on purpose
  closeSocket()
  scheduleReconnect()
}

/** While open, close once the tab has been idle for LIVE_IDLE_MS. Re-armed from the last input, so
 * pointer and key events only write a timestamp. */
function armIdleTimer() {
  clearTimer(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (!ws) return
    if (isIdle()) closeSocket()
    else armIdleTimer()
  }, Math.max(0, lastInputAt + LIVE_IDLE_MS - Date.now()) + 1)
}

function onChanged() {
  if (fireTimer) return // one fire is already pending for this boundary
  const now = Date.now()
  const delay = Math.max(0, liveFireAt(now, Math.random() * LIVE_FIRE_JITTER_MS) - now)
  fireTimer = setTimeout(() => {
    fireTimer = null
    if (!isVisible() || isIdle()) return // hidden or idle at fire time: dropped
    try {
      emitLiveChange()
    } catch {
      // never let a subscriber break the socket
    }
  }, delay)
}

function open() {
  let s: WebSocket
  try {
    s = new WebSocket(liveUrl())
  } catch {
    scheduleReconnect() // a constructor that throws (blocked, bad URL): treated as a failed connect
    return
  }
  ws = s
  s.onopen = () => {
    if (ws !== s) return
    attempt = 0
    try {
      if (keepaliveTimer) clearInterval(keepaliveTimer)
      keepaliveTimer = setInterval(() => {
        try {
          if (s.readyState === 1) s.send('ping')
        } catch {
          // a send on a closing socket: onclose follows
        }
      }, LIVE_KEEPALIVE_MS)
      armIdleTimer()
    } catch {
      // swallow
    }
  }
  s.onmessage = (e: MessageEvent) => {
    try {
      if (typeof e.data === 'string' && e.data === LIVE_CHANGED_TEXT) onChanged()
    } catch {
      // swallow
    }
  }
  s.onerror = () => onSocketGone(s)
  s.onclose = () => onSocketGone(s)
}

/** Brings the socket in line with "should one be open right now". */
function evaluate() {
  try {
    if (!wanted()) {
      clearTimer(reconnectTimer)
      reconnectTimer = null
      if (ws) closeSocket()
      return
    }
    if (ws || reconnectTimer) return
    open()
  } catch {
    // fail-soft
  }
}

function onVisibility() {
  evaluate()
}
function onInput() {
  lastInputAt = Date.now()
  // Reopen straight away if the socket was closed for idleness (a pending backoff is left alone).
  if (!ws && !reconnectTimer) evaluate()
}

/** Starts the live socket once for the page; returns the stop function. A second call while
 * started is a no-op that returns a no-op, so only the first caller owns it. */
export function startLiveChanges(): () => void {
  if (started || typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  started = true
  attempt = 0
  lastInputAt = Date.now()
  try {
    document.addEventListener('visibilitychange', onVisibility)
    for (const ev of INPUT_EVENTS) window.addEventListener(ev, onInput, { passive: true, capture: true })
    evaluate()
  } catch {
    // fail-soft
  }
  return stopLiveChanges
}

function stopLiveChanges() {
  if (!started) return
  started = false
  try {
    document.removeEventListener('visibilitychange', onVisibility)
    for (const ev of INPUT_EVENTS) window.removeEventListener(ev, onInput, { capture: true })
  } catch {
    // swallow
  }
  clearTimer(reconnectTimer)
  reconnectTimer = null
  clearTimer(fireTimer)
  fireTimer = null
  closeSocket()
}

/** App-level: starts the live socket for this app's lifetime, stopped with the calling scope. */
export function useLiveChanges(): void {
  const stop = startLiveChanges()
  if (getCurrentScope()) onScopeDispose(stop)
}

/** Test-only: stops everything and resets module state. */
export function __resetLiveChangesForTests(): void {
  stopLiveChanges()
  attempt = 0
  lastInputAt = 0
}
