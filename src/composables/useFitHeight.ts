// Measures a fit-to-content card (lib/fit.ts) and reports its content height in px whenever it
// changes: on mount, when the content resizes (async data arriving, a font loading, a reflow at a
// new column width) and when the card gains or loses a child (captions, the markers list).
// ChartCard emits the height; Dashboard.vue turns it into grid rows (fitRows) and sets `h`.
//
// Loop safety: the measure is the bottom of the card's last in-flow child, never the card's own
// height, and the card body of a fit card is content-sized (not `flex: 1`), so a new grid height
// changes the card's slot but not what is measured. Only the children are observed. A height is
// reported on every measure (not only on a change) so a consumer that ignored one, such as the
// dashboard on a phone, still gets it when it can use it; the consumer skips a height it already
// has.
import { onBeforeUnmount, onMounted, onUpdated, watch, type Ref } from 'vue'
import { naturalCardHeight } from '../lib/fit'

export function useFitHeight(cardEl: Ref<HTMLElement | null>, active: Ref<boolean>, onHeight: (px: number) => void): void {
  let observer: ResizeObserver | null = null

  function measure() {
    const el = cardEl.value
    if (!el || !active.value) return
    onHeight(naturalCardHeight(el))
  }

  function observe() {
    observer?.disconnect()
    observer = null
    const el = cardEl.value
    if (!el || !active.value || typeof ResizeObserver === 'undefined') return
    observer = new ResizeObserver(measure)
    for (const child of Array.from(el.children)) observer.observe(child)
    measure()
  }

  onMounted(observe)
  // A child that appears or disappears (captions, the markers list) is not a resize of an observed
  // element; re-binding after every render of the card catches it.
  onUpdated(observe)
  // `post`: measure after the class that makes the card content-sized has been applied.
  watch(
    active,
    () => {
      observe()
    },
    { flush: 'post' },
  )
  onBeforeUnmount(() => observer?.disconnect())
}
