// The deliberate "open this slice" gesture for a pie: a double-click (mouse), a double-tap (touch or pen) or a press
// held for HOLD_MS (mouse, touch or pen). A single click or tap opens nothing (the chart's own hover and tooltip
// are all it does), so a tooltip can be read without drilling by accident.
//
// Pure of the DOM and of Chart.js: the caller says which slice lies under a point (`hit`) and what opening means
// (`open`); the handlers take the fields they need of mouse and pointer events, so tests can feed plain objects.
//
// Rules
//   - A hold cancels once the pointer has moved more than SLOP_PX, when a second finger comes down, when the
//     pointer is cancelled (the browser took the touch for a scroll) or when it leaves the pie.
//   - A hold that fired is over: the release must not count as a click, so the `click` that follows it is
//     swallowed, and neither it nor the hold can start or finish a double-click or double-tap.
//   - A double-click is the browser's own `dblclick` (it knows the system's double-click time). A double-tap is
//     two quick taps on the same slice; a `dblclick` that a browser adds after it is ignored, as is one that
//     follows an open within DEDUPE_MS, so one gesture opens once.
export const HOLD_MS = 500
export const SLOP_PX = 10
export const DOUBLE_TAP_MS = 350
export const TAP_SLOP_PX = 30
const DEDUPE_MS = 600

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
  preventDefault?: () => void
  stopPropagation?: () => void
}

export interface PieGestureOptions {
  /** The index of the slice under a point (client coordinates), or null. */
  hit: (point: { clientX: number; clientY: number }) => number | null
  open: (index: number) => void
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
      if (e.pointerType === 'mouse' && e.button !== 0) return
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
      if (e.pointerType === 'mouse') return // a mouse double-click is the browser's dblclick
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
      if (!swallowClick) return
      swallowClick = false
      e.preventDefault?.()
      e.stopPropagation?.()
    },
    dblclick(e) {
      e.preventDefault?.() // no text selection from a double-click
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
