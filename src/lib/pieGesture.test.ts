import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPieGesture, DOUBLE_TAP_MS, HOLD_MS, SLOP_PX, type GesturePointer } from './pieGesture'

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
const mouse = (x: number, y: number) => ({ clientX: x, clientY: y, preventDefault: vi.fn(), stopPropagation: vi.fn() })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup() {
  const opened: number[] = []
  const g = createPieGesture({ hit, open: (i) => opened.push(i) })
  return { g, opened }
}

describe('a single click or tap', () => {
  it('opens nothing (mouse)', () => {
    const { g, opened } = setup()
    g.pointerdown(ptr('mouse', 50, 50))
    vi.advanceTimersByTime(80)
    g.pointerup(ptr('mouse', 50, 50))
    g.click(mouse(50, 50))
    vi.advanceTimersByTime(2000)
    expect(opened).toEqual([])
  })

  it('opens nothing (touch tap)', () => {
    const { g, opened } = setup()
    g.pointerdown(ptr('touch', 50, 50))
    vi.advanceTimersByTime(80)
    g.pointerup(ptr('touch', 50, 50))
    vi.advanceTimersByTime(2000)
    expect(opened).toEqual([])
  })
})

describe('a double-click', () => {
  it('opens the slice under the pointer', () => {
    const { g, opened } = setup()
    g.dblclick(mouse(150, 50))
    expect(opened).toEqual([1])
  })

  it('on empty space opens nothing, and the browser does not select text', () => {
    const { g, opened } = setup()
    const e = mouse(150, 250)
    g.dblclick(e)
    expect(opened).toEqual([])
    expect(e.preventDefault).toHaveBeenCalled()
  })
})

describe('a double-tap', () => {
  const tap = (g: ReturnType<typeof setup>['g'], x: number, y: number) => {
    g.pointerdown(ptr('touch', x, y))
    vi.advanceTimersByTime(60)
    g.pointerup(ptr('touch', x, y))
  }

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
})

describe('a press and hold', () => {
  it('opens after the hold time, mouse or touch, without waiting for the release', () => {
    for (const type of ['mouse', 'touch']) {
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
    steady.g.pointerdown(ptr('mouse', 50, 50))
    steady.g.pointermove(ptr('mouse', 50 + SLOP_PX - 1, 50))
    vi.advanceTimersByTime(HOLD_MS)
    expect(steady.opened).toEqual([0])
  })

  it('cancels on a release, a browser cancel, a second finger and the mouse leaving', () => {
    const early = setup()
    early.g.pointerdown(ptr('mouse', 50, 50))
    vi.advanceTimersByTime(HOLD_MS - 50)
    early.g.pointerup(ptr('mouse', 50, 50))
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

    const left = setup()
    left.g.pointerdown(ptr('mouse', 50, 50))
    left.g.pointerleave(ptr('mouse', 400, 400))
    vi.advanceTimersByTime(1000)
    expect(left.opened).toEqual([])
  })

  it('a press that starts off the pie, or with the right mouse button, never holds', () => {
    const { g, opened } = setup()
    g.pointerdown(ptr('mouse', 50, 250))
    g.pointerdown(ptr('mouse', 50, 50, { button: 2 }))
    vi.advanceTimersByTime(2000)
    expect(opened).toEqual([])
  })

  it('the release after a hold is not a click: the click is swallowed, and no double-click follows it', () => {
    const { g, opened } = setup()
    g.pointerdown(ptr('mouse', 50, 50))
    vi.advanceTimersByTime(HOLD_MS)
    expect(opened).toEqual([0])
    g.pointerup(ptr('mouse', 50, 50))
    const click = mouse(50, 50)
    g.click(click)
    expect(click.preventDefault).toHaveBeenCalled()
    expect(click.stopPropagation).toHaveBeenCalled()
    // the next, ordinary click is not swallowed
    const next = mouse(50, 50)
    g.click(next)
    expect(next.stopPropagation).not.toHaveBeenCalled()
    // a quick second click would make a dblclick: it must not open again
    g.dblclick(mouse(50, 50))
    expect(opened).toEqual([0])
  })

  it('a new press clears a swallow whose click never came (the release was off the pie)', () => {
    const { g } = setup()
    g.pointerdown(ptr('mouse', 50, 50))
    vi.advanceTimersByTime(HOLD_MS)
    g.pointerdown(ptr('mouse', 150, 50)) // no pointerup/click for the first
    g.pointerup(ptr('mouse', 150, 50))
    const click = mouse(150, 50)
    g.click(click)
    expect(click.stopPropagation).not.toHaveBeenCalled()
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
})
