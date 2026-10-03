// Measures a fit-to-content card (lib/fit.ts) and reports its content height in px once it has
// settled: on mount, when the content resizes (async data arriving, a font loading, a reflow at a
// new column width) and when the card gains or loses a child (captions, the markers list).
// ChartCard emits the height; Dashboard.vue turns it into grid rows (fitRows) and sets `h`.
//
// Settling: reports are trailing-debounced (FIT_SETTLE_MS), so data that arrives in two steps (a
// placeholder, then the real body) yields one report of the final height rather than a layout
// write per step. A card that is not laid out (hidden, detached, zero-sized) reports nothing: a
// missing measurement is not "no content", and must not save the 3-row minimum.
//
// Loop safety: the measure is the bottom of the card's last in-flow child, never the card's own
// height, and the card body of a fit card is content-sized (not `flex: 1`), so a new grid height
// changes the card's slot but not what is measured. Only the children are observed, with one
// observer for the card's lifetime whose targets are updated as children come and go.
import { onBeforeUnmount, onMounted, onUpdated, watch, type Ref } from 'vue'
import { isLaidOut, naturalCardHeight } from '../lib/fit'

/** Quiet time after the last resize before a height is reported. */
export const FIT_SETTLE_MS = 300

export function useFitHeight(cardEl: Ref<HTMLElement | null>, active: Ref<boolean>, onHeight: (px: number) => void): void {
  let observer: ResizeObserver | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const targets = new Set<Element>()

  function report() {
    timer = undefined
    const el = cardEl.value
    if (!el || !active.value || !isLaidOut(el)) return
    onHeight(naturalCardHeight(el))
  }

  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(report, FIT_SETTLE_MS)
  }

  /** Point the observer at the card's current children; true if the set changed. */
  function syncTargets(): boolean {
    const el = cardEl.value
    if (!observer || !el) return false
    const now = new Set<Element>(Array.from(el.children))
    let changed = false
    for (const t of targets) {
      if (!now.has(t)) {
        observer.unobserve(t)
        targets.delete(t)
        changed = true
      }
    }
    for (const c of now) {
      if (!targets.has(c)) {
        observer.observe(c)
        targets.add(c)
        changed = true
      }
    }
    return changed
  }

  function start() {
    if (observer || !cardEl.value || !active.value || typeof ResizeObserver === 'undefined') return
    observer = new ResizeObserver(schedule)
    syncTargets()
    schedule()
  }

  function stop() {
    clearTimeout(timer)
    timer = undefined
    observer?.disconnect()
    observer = null
    targets.clear()
  }

  onMounted(start)
  // A child that appears or disappears (captions, the markers list) is not a resize of an observed
  // element: after a render, update the targets, and re-measure only if the set changed.
  onUpdated(() => {
    if (syncTargets()) schedule()
  })
  // `post`: measure after the class that makes the card content-sized has been applied.
  watch(
    active,
    (on) => {
      if (on) start()
      else stop()
    },
    { flush: 'post' },
  )
  onBeforeUnmount(stop)
}
