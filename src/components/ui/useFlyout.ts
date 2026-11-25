// Placement for a pop-out that opens from a row: fixed to the screen (so no card or scroller clips it), as wide as the row
// (capped by `maxWidth`), below the row, or above it when there is more room there; it scrolls inside itself past `maxHeight`.
// It re-places on resize and scroll while open. Same shape as the anchored popovers in Best Sudoku and deckhand: a bordered
// panel under its control, one open at a time, closed by Escape or a tap outside (the caller wires those).
import { onBeforeUnmount, ref, watch, type CSSProperties, type Ref } from 'vue'
import { popPlacement } from '../../lib/budget/toolbarFold'

export function useFlyout(anchor: Ref<HTMLElement | null>, open: Ref<boolean>, opts: { maxWidth?: number; align?: 'start' | 'end' } = {}) {
  const style = ref<CSSProperties>({})

  function place() {
    const el = anchor.value
    if (!el || typeof window === 'undefined') return
    const r = el.getBoundingClientRect()
    const vh = window.innerHeight
    const { side, maxHeight } = popPlacement(r.top, r.bottom, vh)
    const width = Math.min(r.width, opts.maxWidth ?? r.width)
    const left = opts.align === 'end' ? r.right - width : r.left
    style.value = {
      position: 'fixed',
      left: `${Math.round(left)}px`,
      width: `${Math.round(width)}px`,
      maxHeight: `${maxHeight}px`,
      ...(side === 'below' ? { top: `${Math.round(r.bottom + 4)}px` } : { bottom: `${Math.round(vh - r.top + 4)}px` }),
    }
  }
  function on() {
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, { capture: true, passive: true })
  }
  function off() {
    window.removeEventListener('resize', place)
    window.removeEventListener('scroll', place, { capture: true } as EventListenerOptions)
  }
  watch(
    open,
    (o) => {
      off()
      if (o) {
        place()
        on()
      }
    },
    { flush: 'sync' },
  )
  onBeforeUnmount(off)
  return { style, place }
}
