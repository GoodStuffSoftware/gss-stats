// The "open this slice" gesture for a pie, by input kind (the event's `pointerType`):
//   - mouse: a single click opens the slice (the hover tooltip stays). A habitual double-click opens only ONE
//     level: a click is ignored while `blocked()` says the level is still opening (the caller knows the fetch and
//     the motion) and for GUARD_MS after an open.
//   - touch and pen: a single tap only shows the tooltip; two quick taps (a double-tap) or a press held for
//     HOLD_MS open it. Pen is treated like touch: a pen tap has no hover step before it, so a lone tap must stay
//     harmless, and it keeps what a pen did before.
//
// Pure of the DOM and of Chart.js: the caller says which slice lies under a point (`hit`) and what opening means
// (`open`); the handlers take the fields they need of mouse and pointer events, so tests can feed plain objects.
//
// Rules
//   - A hold cancels once the pointer has moved more than SLOP_PX, when a second finger comes down, when the
//     pointer is cancelled (the browser took the touch for a scroll) or when it leaves the pie. A mouse has no
//     hold: it clicks.
//   - A hold that fired is over: the release must not count as a click, so the `click` that follows it is
//     swallowed, and neither it nor the hold can start or finish a double-tap.
//   - A double-tap is two quick taps on the same slice. The browser's own `dblclick` after it (or after a hold)
//     is ignored, as is one that follows an open within DEDUPE_MS, so one gesture opens once. A mouse `dblclick`
//     never opens: its first click already did.
export const HOLD_MS = 500
export const SLOP_PX = 10
export const DOUBLE_TAP_MS = 350
export const TAP_SLOP_PX = 30
const DEDUPE_MS = 600
/** After an open, a mouse click is ignored for this long (the second click of a double-click). */
export const GUARD_MS = 700

export interface GesturePointer {
  pointerId: number
  pointerType: string
  button: number
  clientX: number
  clientY: number
}
export interface GestureMouse {
  clientX: number
  clientY: number
  /** Set on the browser's click events (they are PointerEvents); else the last pointerdown's type is used. */
  pointerType?: string
  preventDefault?: () => void
  stopPropagation?: () => void
}

export interface PieGestureOptions {
  /** The index of the slice under a point (client coordinates), or null. */
  hit: (point: { clientX: number; clientY: number }) => number | null
  open: (index: number) => void
  /** True while the level that was just opened is still arriving or moving: a mouse click then does nothing. */
  blocked?: () => boolean
  holdMs?: number
  slopPx?: number
  /** Test hooks. */
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
}

export interface PieGesture {
  pointerdown(e: GesturePointer): void
  pointermove(e: GesturePointer): void
  pointerup(e: GesturePointer): void
  pointercancel(e: GesturePointer): void
  /** The pointer left the pie. */
  pointerleave(e: GesturePointer): void
  click(e: GestureMouse): void
  dblclick(e: GestureMouse): void
  destroy(): void
}

export function createPieGesture(opts: PieGestureOptions): PieGesture {
  const holdMs = opts.holdMs ?? HOLD_MS
  const slop = opts.slopPx ?? SLOP_PX
  const now = opts.now ?? (() => Date.now())
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>))

  let press: { id: number; x: number; y: number; index: number; timer: unknown; fired: boolean } | null = null
  let tap: { at: number; index: number; x: number; y: number } | null = null
  let swallowClick = false
  let lastOpenAt = -Infinity
  let lastType = '' // the pointerType of the latest press: a click event may not say

  const isMouse = (e: { pointerType?: string }) => (e.pointerType || lastType) === 'mouse'

  function open(index: number) {
    lastOpenAt = now()
    tap = null
    opts.open(index)
  }
  function endPress() {
    if (press?.timer !== undefined) clearTimer(press.timer)
    press = null
  }
  function cancelHold() {
    // a press that has not fired is dropped; one that has fired stays until its release (to swallow the click)
    if (press && !press.fired) endPress()
  }

  return {
    pointerdown(e) {
      swallowClick = false // a new press: whatever was left of the last one is over
      lastType = e.pointerType
      if (e.pointerType === 'mouse') return // a mouse opens on click, not on a hold
      if (press && !press.fired && e.pointerId !== press.id) {
        endPress() // a second finger: not a hold
        tap = null
        return
      }
      endPress()
      const index = opts.hit(e)
      if (index === null) return
      const id = e.pointerId
      const next = { id, x: e.clientX, y: e.clientY, index, timer: undefined as unknown, fired: false }
      next.timer = setTimer(() => {
        if (press !== next) return
        next.fired = true
        next.timer = undefined
        swallowClick = true
        tap = null
        open(next.index)
      }, holdMs)
      press = next
    },
    pointermove(e) {
      if (!press || press.fired || e.pointerId !== press.id) return
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > slop) {
        press.index = -1
        endPress()
        tap = null // a drag is not a tap
      }
    },
    pointerup(e) {
      const p = press
      if (!p || e.pointerId !== p.id) return
      if (p.fired) {
        endPress() // the click after this release is swallowed (see click)
        return
      }
      endPress()
      const t = now()
      if (tap && t - tap.at <= DOUBLE_TAP_MS && tap.index === p.index && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) <= TAP_SLOP_PX) {
        open(p.index)
      } else {
        tap = { at: t, index: p.index, x: e.clientX, y: e.clientY }
      }
    },
    pointercancel(e) {
      if (press && e.pointerId === press.id) cancelHold()
      tap = null
    },
    pointerleave(e) {
      if (e.pointerType === 'mouse') cancelHold()
    },
    click(e) {
      if (swallowClick) {
        swallowClick = false
        e.preventDefault?.()
        e.stopPropagation?.()
        return
      }
      if (!isMouse(e)) return // a tap only shows the tooltip
      if (opts.blocked?.() || now() - lastOpenAt < GUARD_MS) return // the second click of a double-click: one level only
      const index = opts.hit(e)
      if (index !== null) open(index)
    },
    dblclick(e) {
      e.preventDefault?.() // no text selection from a double-click
      if (isMouse(e)) return // its first click opened already
      if (now() - lastOpenAt < DEDUPE_MS) return // already opened by a hold or a double-tap
      const index = opts.hit(e)
      if (index !== null) open(index)
    },
    destroy() {
      endPress()
      tap = null
      swallowClick = false
    },
  }
}
