// A toggletip: a small panel that opens when its trigger is tapped or clicked (or focused by keyboard), so touch has what
// hover gives a mouse. One tip at a time, whatever opened it. It closes on a tap outside the triggers and the tip, a second
// activation of the same trigger, Escape, a scroll or a resize. The panel itself is drawn by the caller from `tip`
// (its `style` places it, `data` is whatever the caller stored); the BudgetTable merchant and note tips share this.
import { onBeforeUnmount, shallowRef, watch, type Ref } from 'vue'

export const TIP_WIDTH = 320
const TIP_MARGIN = 8

export interface ToggletipState<T> {
  /** Identifies trigger and content: the same key activated again closes the tip. */
  key: string
  data: T
  style: Record<string, string>
}

/** Where a tip sits: under the trigger, or above it when the trigger is in the lower part of the screen. */
export function tipPlacement(r: { left: number; top: number; bottom: number }, vw: number, vh: number): Record<string, string> {
  const width = Math.max(120, Math.min(TIP_WIDTH, vw - TIP_MARGIN * 2))
  const left = Math.max(TIP_MARGIN, Math.min(r.left, vw - TIP_MARGIN - width))
  const style: Record<string, string> = { left: `${left}px`, width: `${width}px` }
  if (r.bottom > vh * 0.6) style.bottom = `${Math.max(TIP_MARGIN, vh - r.top + 6)}px`
  else style.top = `${r.bottom + 6}px`
  return style
}

/**
 * @param insideSelector CSS selector of everything a pointer-down must not close the tip on (the triggers and the tip).
 */
export function useToggletip<T>(insideSelector: string) {
  const tip = shallowRef<ToggletipState<T> | null>(null) as Ref<ToggletipState<T> | null>

  function close() {
    tip.value = null
  }
  function openAt(key: string, data: T, el: HTMLElement) {
    const vw = document.documentElement.clientWidth || window.innerWidth
    tip.value = { key, data, style: tipPlacement(el.getBoundingClientRect(), vw, window.innerHeight) }
  }
  function toggle(key: string, data: T, el: HTMLElement) {
    if (tip.value?.key === key) close()
    else openAt(key, data, el)
  }
  /** Keyboard focus only: a tap focuses the trigger too, and its click must not find the tip already open and close it. */
  function openOnKeyboardFocus(key: string, data: T, el: HTMLElement) {
    let keyboard = false
    try {
      keyboard = el.matches(':focus-visible')
    } catch {
      keyboard = false
    }
    if (keyboard && tip.value?.key !== key) openAt(key, data, el)
  }

  function onDocPointer(e: Event) {
    const t = e.target as Element | null
    if (t?.closest?.(insideSelector)) return
    close()
  }
  function onDocKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close()
  }
  function add() {
    document.addEventListener('pointerdown', onDocPointer, true)
    document.addEventListener('keydown', onDocKey)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
  }
  function remove() {
    document.removeEventListener('pointerdown', onDocPointer, true)
    document.removeEventListener('keydown', onDocKey)
    window.removeEventListener('scroll', close, true)
    window.removeEventListener('resize', close)
  }
  watch(
    () => tip.value !== null,
    (isOpen) => (isOpen ? add() : remove()),
  )
  onBeforeUnmount(remove)

  return { tip, close, toggle, openAt, openOnKeyboardFocus }
}
