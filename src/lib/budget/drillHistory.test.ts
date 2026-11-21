import { describe, expect, it } from 'vitest'
import { createDrillHistory, MARK_KEY, readMark, withMark, type HistoryLike } from './drillHistory'

// A browser history list that moves like the real one: go() lands later (flush), a push drops the entries ahead.
class FakeHistory implements HistoryLike {
  entries: unknown[] = [null]
  idx = 0
  pending: number | null = null
  listener: ((state: unknown) => void) | null = null
  get state() {
    return this.entries[this.idx]
  }
  pushState(state: unknown) {
    this.entries.splice(this.idx + 1)
    this.entries.push(state)
    this.idx++
  }
  replaceState(state: unknown) {
    this.entries[this.idx] = state
  }
  go(delta: number) {
    const to = this.idx + delta
    if (to >= 0 && to < this.entries.length) this.pending = to
  }
  /** What the user does: the browser's Back / Forward button. */
  back() {
    this.go(-1)
    this.flush()
  }
  forward() {
    this.go(1)
    this.flush()
  }
  flush() {
    if (this.pending === null) return
    this.idx = this.pending
    this.pending = null
    this.listener?.(this.state)
  }
}

interface Step {
  level: 'category' | 'merchant'
  key: string
}
const FUEL: Step = { level: 'category', key: 'fuel' }
const FOOD: Step = { level: 'category', key: 'food' }
const SHOP: Step = { level: 'merchant', key: 'shop-1' }

/** A section: a drill path, the way the view state keeps it, wired to one DrillHistory. */
function section(h: FakeHistory, startPath: Step[] = [], open = () => true) {
  const path: Step[] = startPath.slice()
  const later: (() => void)[] = []
  const dh = createDrillHistory<Step>({
    history: h,
    drill: (s) => {
      path.push(s)
      dh.pathChanged(path.slice()) // the view state's sync watcher
    },
    popTo: (d) => {
      path.splice(d)
      dh.pathChanged(path.slice())
    },
    path: () => path.slice(),
    later: (fn) => later.push(fn),
  })
  h.listener = (state) => dh.popped(state, open())
  dh.start()
  return {
    dh,
    path,
    /** The user picks a slice. */
    drill(s: Step) {
      path.push(s)
      dh.pathChanged(path.slice())
    },
    /** The user picks a crumb. */
    crumb(depth: number) {
      path.splice(depth)
      dh.pathChanged(path.slice())
    },
    runLater() {
      while (later.length) later.shift()!()
    },
    keys: () => path.map((s) => s.key),
  }
}

describe('the mark', () => {
  it('is read back from a state that carries it, and from nothing else', () => {
    expect(readMark(withMark(null, { s: 'a', d: 2 }))).toEqual({ s: 'a', d: 2 })
    expect(readMark(null)).toBeNull()
    expect(readMark('x')).toBeNull()
    expect(readMark({})).toBeNull()
    expect(readMark({ [MARK_KEY]: { s: '', d: 1 } })).toBeNull()
    expect(readMark({ [MARK_KEY]: { s: 'a', d: -1 } })).toBeNull()
    expect(readMark({ [MARK_KEY]: { s: 'a', d: 1.5 } })).toBeNull()
  })
  it('keeps whatever else the state held', () => {
    expect(withMark({ other: 1 }, { s: 'a', d: 0 })).toEqual({ other: 1, [MARK_KEY]: { s: 'a', d: 0 } })
    expect(withMark([1], { s: 'a', d: 0 })).toEqual({ [MARK_KEY]: { s: 'a', d: 0 } })
  })
})

describe('drilling and Back', () => {
  it('marks the entry it opens on, and each level drilled adds one entry', () => {
    const h = new FakeHistory()
    const s = section(h)
    expect(h.entries).toHaveLength(1)
    expect(readMark(h.state)).toEqual({ s: s.dh.session, d: 0 })
    s.drill(FUEL)
    s.drill(SHOP)
    expect(h.entries).toHaveLength(3)
    expect(h.entries.map((e) => readMark(e)?.d)).toEqual([0, 1, 2])
  })

  it('Back goes up one level at a time, then leaves the section at the top', () => {
    const h = new FakeHistory()
    h.entries = ['previous page', null]
    h.idx = 1
    const s = section(h)
    s.drill(FUEL)
    s.drill(SHOP)
    h.back()
    expect(s.keys()).toEqual(['fuel'])
    h.back()
    expect(s.keys()).toEqual([])
    expect(h.idx).toBe(1) // still on the entry the section opened on
    h.back() // the top: the browser's own Back, as before
    expect(h.state).toBe('previous page')
    expect(s.keys()).toEqual([])
  })

  it('a popstate while the address bar no longer names the section changes nothing', () => {
    const h = new FakeHistory()
    let open = true
    const s = section(h, [], () => open)
    s.drill(FUEL)
    open = false
    h.back()
    expect(s.keys()).toEqual(['fuel'])
  })

  it('stores nothing but the session and depth: no names, no ids, and no address (pushState takes none)', () => {
    const h = new FakeHistory()
    const s = section(h)
    s.drill(FUEL)
    s.drill(SHOP)
    const text = JSON.stringify(h.entries)
    expect(text).not.toMatch(/fuel|shop|category|merchant/i)
    expect(Object.keys((h.entries[2] as Record<string, unknown>)[MARK_KEY] as object).sort()).toEqual(['d', 's'])
  })
})

describe('Forward', () => {
  it('re-drills to the level it came from, one step at a time', () => {
    const h = new FakeHistory()
    const s = section(h)
    s.drill(FUEL)
    s.drill(SHOP)
    h.back()
    h.back()
    expect(s.keys()).toEqual([])
    h.forward()
    expect(s.keys()).toEqual(['fuel'])
    h.forward()
    expect(s.keys()).toEqual(['fuel', 'shop-1'])
    expect(h.entries).toHaveLength(3) // Forward pushed nothing
    h.back()
    expect(s.keys()).toEqual(['fuel'])
  })

  it('a different drill after Back drops what was ahead', () => {
    const h = new FakeHistory()
    const s = section(h)
    s.drill(FUEL)
    h.back()
    s.drill(FOOD)
    expect(h.entries).toHaveLength(2)
    h.forward() // nothing ahead
    expect(s.keys()).toEqual(['food'])
  })

  it('a level that no longer exists (the steps were forgotten) steps back instead of showing a stale path', () => {
    const h = new FakeHistory()
    const s = section(h)
    s.drill(FUEL)
    s.drill(SHOP)
    h.back()
    s.dh.forgetForward() // the range, person or grouping changed
    h.forward()
    h.flush() // the bounce lands
    expect(s.keys()).toEqual(['fuel'])
    expect(h.idx).toBe(1) // bounced back to the entry that stands for 'fuel'
    h.back()
    expect(s.keys()).toEqual([])
  })
})

describe('a breadcrumb jump', () => {
  it('goes back over our own entries, so Back after it never re-enters the level just left', () => {
    const h = new FakeHistory()
    h.entries = ['previous page', null]
    h.idx = 1
    const s = section(h)
    s.drill(FUEL)
    s.drill(SHOP)
    s.crumb(0)
    h.flush() // the browser lands
    expect(s.keys()).toEqual([])
    expect(h.idx).toBe(1)
    h.back() // the top: leaves the section
    expect(h.state).toBe('previous page')
    expect(s.keys()).toEqual([])
  })

  it('a jump up one level uses one entry', () => {
    const h = new FakeHistory()
    const s = section(h)
    s.drill(FUEL)
    s.drill(SHOP)
    s.crumb(1)
    h.flush()
    expect(s.keys()).toEqual(['fuel'])
    expect(h.idx).toBe(1)
    h.back()
    expect(s.keys()).toEqual([])
  })

  it('Forward after a jump re-drills the levels that were left', () => {
    const h = new FakeHistory()
    const s = section(h)
    s.drill(FUEL)
    s.drill(SHOP)
    s.crumb(0)
    h.flush()
    h.forward()
    expect(s.keys()).toEqual(['fuel'])
    h.forward()
    expect(s.keys()).toEqual(['fuel', 'shop-1'])
  })

  it('a jump to a level the history never had (a path restored by a reload) re-marks instead of going back out', () => {
    const h = new FakeHistory()
    h.entries = ['previous page', null]
    h.idx = 1
    const s = section(h, [FUEL]) // opened already inside a category
    expect(readMark(h.state)).toEqual({ s: s.dh.session, d: 1 })
    s.drill(SHOP)
    s.crumb(0) // below where the history starts: go back to the adopted entry, then re-mark it as the top
    h.flush()
    expect(h.idx).toBe(1)
    expect(readMark(h.state)).toEqual({ s: s.dh.session, d: 0 })
    s.drill(FOOD)
    h.back()
    expect(s.keys()).toEqual([])
    h.back()
    expect(h.state).toBe('previous page')
  })

  it('a jump right on the adopted entry just re-marks it', () => {
    const h = new FakeHistory()
    h.entries = ['previous page', null]
    h.idx = 1
    const s = section(h, [FUEL])
    s.crumb(0)
    expect(h.pending).toBeNull() // no navigation
    expect(readMark(h.state)).toEqual({ s: s.dh.session, d: 0 })
    h.back()
    expect(h.state).toBe('previous page')
  })
})

describe('stale entries', () => {
  it('a new visit adopts the entry it opens on, whatever mark an earlier visit left there', () => {
    const h = new FakeHistory()
    const first = section(h)
    first.drill(FUEL)
    first.drill(SHOP) // the section is left at depth 2 (the entry keeps its mark)
    const second = section(h) // opened again, no path
    expect(second.dh.session).not.toBe(first.dh.session)
    expect(readMark(h.state)).toEqual({ s: second.dh.session, d: 0 })
  })

  it('landing on an older visit\'s entry with the section open re-reads the section and adopts that entry, with no navigation', () => {
    const h = new FakeHistory()
    const first = section(h)
    first.drill(FUEL)
    first.drill(SHOP)
    const second = section(h) // a later visit on the same entry (depth 2 of the first visit's mark)
    h.back() // onto the first visit's entry for depth 1
    expect(second.dh.settling).toBe(true)
    second.path.splice(0, second.path.length, FUEL) // the section's own re-read of the address bar
    second.dh.pathChanged(second.path.slice()) // ignored while settling
    expect(h.entries).toHaveLength(3)
    expect(h.pending).toBeNull()
    second.runLater()
    expect(second.dh.settling).toBe(false)
    expect(readMark(h.state)).toEqual({ s: second.dh.session, d: 1 })
    h.back() // the next entry down is stale too: adopted the same way, never skipped over or looped on
    expect(second.dh.settling).toBe(true)
    second.path.splice(0)
    second.runLater()
    expect(readMark(h.state)).toEqual({ s: second.dh.session, d: 0 })
  })

  it('an entry with no mark at all, landed on with the section open, is adopted the same way', () => {
    const h = new FakeHistory()
    h.entries = [null, 'other']
    h.idx = 1
    const s = section(h)
    h.back()
    expect(s.dh.settling).toBe(true)
    s.runLater()
    expect(readMark(h.state)).toEqual({ s: s.dh.session, d: 0 })
    expect(h.entries).toHaveLength(2)
  })

  it('Back from a drilled level the section left (closed by the app) does not touch the page the app went to', () => {
    const h = new FakeHistory()
    let open = true
    const first = section(h, [], () => open)
    first.drill(FUEL)
    open = false // the app closed the section: a page is on screen
    h.pushState({ page: 'other' })
    h.back()
    expect(first.keys()).toEqual(['fuel']) // not acted on: the section is closed
    expect(first.dh.settling).toBe(false)
  })
})
