// @vitest-environment happy-dom
//
// The one page-level "user came back to the tab" listener (useReturnRefresh.ts): a singleton on
// document `visibilitychange` + window `focus`, debounced so a single return fires once, silent
// while the tab is hidden, installed by the first subscriber and removed with the last.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetReturnRefreshForTests, isInFlight, isStale, onReturn, RETURN_DEBOUNCE_MS, RETURN_INFLIGHT_MAX_MS, RETURN_MIN_AGE_MS } from './useReturnRefresh'

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}
/** A real return to the tab: it becomes visible and the window takes focus, in the same tick. */
function comeBack({ visibility = true, focus = true } = {}) {
  setVisibility('visible')
  if (visibility) document.dispatchEvent(new Event('visibilitychange'))
  if (focus) window.dispatchEvent(new Event('focus'))
}

beforeEach(() => {
  __resetReturnRefreshForTests()
  setVisibility('visible')
  vi.useFakeTimers()
})
afterEach(() => {
  __resetReturnRefreshForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useReturnRefresh: one listener, debounced, never while hidden', () => {
  it('hidden -> visible fires the subscriber once', () => {
    const cb = vi.fn()
    onReturn(cb)
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()
    comeBack({ focus: false })
    vi.advanceTimersByTime(RETURN_DEBOUNCE_MS + 1)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('visibilitychange and focus together (one return) fire once', () => {
    const cb = vi.fn()
    onReturn(cb)
    comeBack()
    vi.advanceTimersByTime(RETURN_DEBOUNCE_MS + 1)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('a focus on its own (window switch, tab already visible) fires once', () => {
    const cb = vi.fn()
    onReturn(cb)
    comeBack({ visibility: false })
    vi.advanceTimersByTime(RETURN_DEBOUNCE_MS + 1)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('never fires while the tab is hidden, even on a focus event or if it hides inside the debounce', () => {
    const cb = vi.fn()
    onReturn(cb)
    setVisibility('hidden')
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()
    comeBack()
    setVisibility('hidden') // gone again before the debounce ends
    vi.advanceTimersByTime(1000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('does not poll: with no event, no time passing ever fires the subscriber', () => {
    const cb = vi.fn()
    onReturn(cb)
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(cb).not.toHaveBeenCalled()
  })

  it('installs ONE document listener and ONE window listener however many subscribe, and removes them with the last', () => {
    const docAdd = vi.spyOn(document, 'addEventListener')
    const winAdd = vi.spyOn(window, 'addEventListener')
    const docRemove = vi.spyOn(document, 'removeEventListener')
    const winRemove = vi.spyOn(window, 'removeEventListener')
    const offs = [onReturn(vi.fn()), onReturn(vi.fn()), onReturn(vi.fn())]
    expect(docAdd.mock.calls.filter((c) => c[0] === 'visibilitychange')).toHaveLength(1)
    expect(winAdd.mock.calls.filter((c) => (c[0] as string) === 'focus')).toHaveLength(1)
    offs[0]()
    offs[1]()
    expect(docRemove).not.toHaveBeenCalled()
    offs[2]()
    expect(docRemove.mock.calls.filter((c) => c[0] === 'visibilitychange')).toHaveLength(1)
    expect(winRemove.mock.calls.filter((c) => (c[0] as string) === 'focus')).toHaveLength(1)
  })

  it('an unsubscribed callback is not called', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = onReturn(a)
    onReturn(b)
    offA()
    comeBack()
    vi.advanceTimersByTime(RETURN_DEBOUNCE_MS + 1)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('a throwing subscriber does not stop the others', () => {
    const b = vi.fn()
    onReturn(() => {
      throw new Error('boom')
    })
    onReturn(b)
    comeBack()
    vi.advanceTimersByTime(RETURN_DEBOUNCE_MS + 1)
    expect(b).toHaveBeenCalledTimes(1)
  })
})

describe('isStale: the 60 s throttle', () => {
  it('is false under 60 s since the last settled load, true at or beyond it, true when never loaded', () => {
    expect(isStale(1000, 1000 + RETURN_MIN_AGE_MS - 1)).toBe(false)
    expect(isStale(1000, 1000 + RETURN_MIN_AGE_MS)).toBe(true)
    expect(isStale(null, 5)).toBe(true)
  })
})

describe('isInFlight: the age limit on the in-flight guard', () => {
  it('is true while a load is running and younger than the limit, false once it is old or none is running', () => {
    expect(isInFlight(null, 1000)).toBe(false)
    expect(isInFlight(1000, 1000 + RETURN_INFLIGHT_MAX_MS - 1)).toBe(true)
    expect(isInFlight(1000, 1000 + RETURN_INFLIGHT_MAX_MS)).toBe(false)
  })
  it('the limit is 30 s: longer than any real load, shorter than the 60 s throttle', () => {
    expect(RETURN_INFLIGHT_MAX_MS).toBe(30_000)
    expect(RETURN_INFLIGHT_MAX_MS).toBeLessThan(RETURN_MIN_AGE_MS)
  })
})

describe('useReturnRefresh: timing and resubscribe', () => {
  it('the debounce is 250 ms: nothing at 249 ms, one fire at 250 ms', () => {
    const cb = vi.fn()
    onReturn(cb)
    comeBack()
    vi.advanceTimersByTime(249)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('a subscriber that leaves and rejoins inside the debounce window still gets the return', () => {
    const cb = vi.fn()
    let off = onReturn(cb)
    comeBack()
    off() // the last subscriber goes (a card rebuilding at the ET day rollover) ...
    off = onReturn(cb) // ... and is back within the window
    vi.advanceTimersByTime(RETURN_DEBOUNCE_MS + 1)
    expect(cb).toHaveBeenCalledTimes(1)
    off()
  })
})
