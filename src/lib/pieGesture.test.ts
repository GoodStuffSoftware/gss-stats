import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPieGesture, DOUBLE_TAP_MS, GUARD_MS, HOLD_MS, SLOP_PX, type GesturePointer } from './pieGesture'

// Slice 0 lies left of x = 100, slice 1 right of it; anything below y = 200 is off the pie.
const hit = (p: { clientX: number; clientY: number }) => (p.clientY > 200 ? null : p.clientX < 100 ? 0 : 1)
const ptr = (type: string, x: number, y: number, extra: Partial<GesturePointer> = {}): GesturePointer => ({
  pointerId: 1,
  pointerType: type,
  button: 0,
  clientX: x,
  clientY: y,
  ...extra,
})
const mouse = (x: number, y: number, pointerType?: string) => ({ clientX: x, clientY: y, pointerType, preventDefault: vi.fn(), stopPropagation: vi.fn() })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(blocked?: () => boolean) {
  const opened: number[] = []
  const g = createPieGesture({ hit, open: (i) => opened.push(i), blocked })
  return { g, opened }
}
/** A whole mouse click: press, release, then the browser's click. */
function click(g: ReturnType<typeof setup>['g'], x: number, y: number) {
  g.pointerdown(ptr('mouse', x, y))
  vi.advanceTimersByTime(60)
  g.pointerup(ptr('mouse', x, y))
  g.click(mouse(x, y))
}
const tap = (g: ReturnType<typeof setup>['g'], x: number, y: number, type = 'touch') => {
  g.pointerdown(ptr(type, x, y))
  vi.advanceTimersByTime(60)
  g.pointerup(ptr(type, x, y))
  g.click(mouse(x, y, type)) // the click a browser adds after a tap
}

describe('a mouse click', () => {
  it('opens the slice under the pointer, at once', () => {
    const { g, opened } = setup()
    click(g, 150, 50)
    expect(opened).toEqual([1])
  })

  it('on empty space opens nothing; a click with no pointerdown of a mouse (keyboard, assistive tech) opens nothing', () => {
    const { g, opened } = setup()
    click(g, 50, 250)
    expect(opened).toEqual([])
    const other = setup()
    other.g.click(mouse(50, 50))
    expect(other.opened).toEqual([])
  })

  it('has no hold: pressing and waiting opens nothing until the click', () => {
    const { g, opened } = setup()
    g.pointerdown(ptr('mouse', 50, 50))
    vi.advanceTimersByTime(HOLD_MS * 3)
    expect(opened).toEqual([])
    g.pointerup(ptr('mouse', 50, 50))
    g.click(mouse(50, 50))
    expect(opened).toEqual([0])
  })

  it('a double-click opens ONE level: the second click, the dblclick and a third click are ignored for the guard window', () => {
    const { g, opened } = setup()
    click(g, 50, 50)
    vi.advanceTimersByTime(80)
    click(g, 50, 50) // the second click of the double-click
    const dbl = mouse(50, 50)
    g.dblclick(dbl)
    expect(opened).toEqual([0])
    expect(dbl.preventDefault).toHaveBeenCalled() // and no text selection
    vi.advanceTimersByTime(GUARD_MS - 400)
    click(g, 150, 50) // a slice of the next level, still inside the guard
    expect(opened).toEqual([0])
  })

  it('clicks work again once the guard window has passed', () => {
    const { g, opened } = setup()
    click(g, 50, 50)
    vi.advanceTimersByTime(GUARD_MS)
    click(g, 150, 50)
    expect(opened).toEqual([0, 1])
  })

  it('ignores clicks while the caller says the level is still opening, however long that takes', () => {
    let busy = true
    const { g, opened } = setup(() => busy)
    vi.advanceTimersByTime(5000)
    click(g, 50, 50)
    expect(opened).toEqual([])
    busy = false
    click(g, 50, 50)
    expect(opened).toEqual([0])
  })

  it('the click event\'s own pointerType decides when it says mouse', () => {
    const { g, opened } = setup()
    g.click(mouse(150, 50, 'mouse'))
    expect(opened).toEqual([1])
  })
})

describe('a touch tap', () => {
  it('opens nothing (it only shows the tooltip), not even with the click the browser adds', () => {
    const { g, opened } = setup()
    tap(g, 50, 50)
    vi.advanceTimersByTime(2000)
    expect(opened).toEqual([])
  })

  it('a pen tap is a touch tap: nothing opens', () => {
    const { g, opened } = setup()
    tap(g, 50, 50, 'pen')
    vi.advanceTimersByTime(2000)
    expect(opened).toEqual([])
  })
})

describe('a touch double-click event', () => {
  it('opens the slice under the pointer when the browser reports one for a finger or pen', () => {
    const { g, opened } = setup()
    g.pointerdown(ptr('touch', 150, 50))
    g.pointerup(ptr('touch', 150, 50))
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 400) // not a double-tap by our own count
    g.dblclick(mouse(150, 50))
    expect(opened).toEqual([1])
  })

  it('on empty space opens nothing, and the browser does not select text', () => {
    const { g, opened } = setup()
    g.pointerdown(ptr('touch', 150, 250))
    const e = mouse(150, 250)
    g.dblclick(e)
    expect(opened).toEqual([])
    expect(e.preventDefault).toHaveBeenCalled()
  })
})

describe('a double-tap', () => {
  it('two quick taps on the same slice open it, once (a dblclick the browser adds after is ignored)', () => {
    const { g, opened } = setup()
    tap(g, 50, 50)
    vi.advanceTimersByTime(100)
    tap(g, 52, 51)
    expect(opened).toEqual([0])
    g.dblclick(mouse(52, 51))
    expect(opened).toEqual([0])
  })

  it('two taps too far apart in time, or on different slices, open nothing', () => {
    const { g, opened } = setup()
    tap(g, 50, 50)
    vi.advanceTimersByTime(DOUBLE_TAP_MS + 50)
    tap(g, 50, 50)
    expect(opened).toEqual([])
    vi.advanceTimersByTime(100)
    tap(g, 150, 50) // the other slice
    expect(opened).toEqual([])
  })

  it('a drag between the taps does not make a double-tap', () => {
    const { g, opened } = setup()
    tap(g, 50, 50)
    g.pointerdown(ptr('touch', 50, 50))
    g.pointermove(ptr('touch', 50, 50 + SLOP_PX + 5))
    g.pointerup(ptr('touch', 50, 50 + SLOP_PX + 5))
    tap(g, 50, 50)
    expect(opened).toEqual([])
  })

  it('a pen double-taps like a finger', () => {
    const { g, opened } = setup()
    tap(g, 50, 50, 'pen')
    vi.advanceTimersByTime(100)
    tap(g, 50, 50, 'pen')
    expect(opened).toEqual([0])
  })
})

describe('a press and hold (touch and pen)', () => {
  it('opens after the hold time, without waiting for the release', () => {
    for (const type of ['touch', 'pen']) {
      const { g, opened } = setup()
      g.pointerdown(ptr(type, 150, 60))
      vi.advanceTimersByTime(HOLD_MS - 1)
      expect(opened).toEqual([])
      vi.advanceTimersByTime(1)
      expect(opened).toEqual([1])
    }
  })

  it('a hold that moves more than the slop cancels; a tremble within it does not', () => {
    const moved = setup()
    moved.g.pointerdown(ptr('touch', 50, 50))
    vi.advanceTimersByTime(200)
    moved.g.pointermove(ptr('touch', 50 + SLOP_PX + 1, 50))
    vi.advanceTimersByTime(2000)
    expect(moved.opened).toEqual([])

    const steady = setup()
    steady.g.pointerdown(ptr('touch', 50, 50))
    steady.g.pointermove(ptr('touch', 50 + SLOP_PX - 1, 50))
    vi.advanceTimersByTime(HOLD_MS)
    expect(steady.opened).toEqual([0])
  })

  it('cancels on a release, a browser cancel, a second finger', () => {
    const early = setup()
    early.g.pointerdown(ptr('touch', 50, 50))
    vi.advanceTimersByTime(HOLD_MS - 50)
    early.g.pointerup(ptr('touch', 50, 50))
    vi.advanceTimersByTime(1000)
    expect(early.opened).toEqual([])

    const cancelled = setup()
    cancelled.g.pointerdown(ptr('touch', 50, 50))
    cancelled.g.pointercancel(ptr('touch', 50, 50))
    vi.advanceTimersByTime(1000)
    expect(cancelled.opened).toEqual([])

    const two = setup()
    two.g.pointerdown(ptr('touch', 50, 50))
    two.g.pointerdown(ptr('touch', 150, 50, { pointerId: 2 }))
    vi.advanceTimersByTime(1000)
    expect(two.opened).toEqual([])
  })

  it('a press that starts off the pie never holds', () => {
    const { g, opened } = setup()
    g.pointerdown(ptr('touch', 50, 250))
    vi.advanceTimersByTime(2000)
    expect(opened).toEqual([])
  })

  it('the release after a hold is not a click: the click is swallowed, and no double-click follows it', () => {
    const { g, opened } = setup()
    g.pointerdown(ptr('touch', 50, 50))
    vi.advanceTimersByTime(HOLD_MS)
    expect(opened).toEqual([0])
    g.pointerup(ptr('touch', 50, 50))
    const swallowed = mouse(50, 50, 'touch')
    g.click(swallowed)
    expect(swallowed.preventDefault).toHaveBeenCalled()
    expect(swallowed.stopPropagation).toHaveBeenCalled()
    // the next, ordinary tap's click is not swallowed
    const next = mouse(50, 50, 'touch')
    g.click(next)
    expect(next.stopPropagation).not.toHaveBeenCalled()
    // a dblclick that follows the hold must not open again
    g.dblclick(mouse(50, 50, 'touch'))
    expect(opened).toEqual([0])
  })

  it('a new press clears a swallow whose click never came (the release was off the pie)', () => {
    const { g } = setup()
    g.pointerdown(ptr('touch', 50, 50))
    vi.advanceTimersByTime(HOLD_MS)
    g.pointerdown(ptr('touch', 150, 50)) // no pointerup/click for the first
    g.pointerup(ptr('touch', 150, 50))
    const next = mouse(150, 50, 'touch')
    g.click(next)
    expect(next.stopPropagation).not.toHaveBeenCalled()
  })

  it('opens once per hold, and destroy() drops a pending one', () => {
    const { g, opened } = setup()
    g.pointerdown(ptr('touch', 50, 50))
    vi.advanceTimersByTime(HOLD_MS * 3)
    expect(opened).toEqual([0])
    const other = setup()
    other.g.pointerdown(ptr('touch', 50, 50))
    other.g.destroy()
    vi.advanceTimersByTime(HOLD_MS * 3)
    expect(other.opened).toEqual([])
  })

  it('a touch hold is not blocked by the mouse guard', () => {
    const { g, opened } = setup(() => true)
    g.pointerdown(ptr('touch', 50, 50))
    vi.advanceTimersByTime(HOLD_MS)
    expect(opened).toEqual([0])
  })
})
