import { describe, expect, it } from 'vitest'
import { createDrillHistory, MARK_KEY, readMark, readSteps, withMark, withoutMark, type HistoryLike } from './drillHistory'

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

/** The section's own check of steps read back from history.state. */
function parseSteps(raw: unknown): Step[] | null {
  if (!Array.isArray(raw)) return null
  const ok = raw.every((s) => s && (s.level === 'category' || s.level === 'merchant') && typeof s.key === 'string' && s.key)
  return ok ? (raw as Step[]) : null
}

/** A section: a drill path, the way the view state keeps it, wired to one DrillHistory. */
function section(h: FakeHistory, startPath: Step[] = [], open = () => true) {
  const path: Step[] = startPath.slice()
  const later: (() => void)[] = []
  let landings = 0
  const dh = createDrillHistory<Step>({
    landed: () => {
      landings++
    },
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
    parseSteps,
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
    landings: () => landings,
  }
}

describe('a second instance with its own markKey', () => {
  it('marks and reads entries under its own key, independent of the default one', () => {
    const h = new FakeHistory()
    const mk = (markKey?: string) => {
      const path: Step[] = []
      const dh = createDrillHistory<Step>({
        history: h, markKey, drill: (s) => void path.push(s), popTo: (d) => void path.splice(d), path: () => path.slice(), parseSteps,
      })
      dh.start()
      return dh
    }
    mk()
    const b = mk('otherKey')
    b.pathChanged([FUEL])
    expect(readMark(h.state, 'otherKey')).toMatchObject({ d: 1 })
    expect(readMark(h.state)).toBeNull() // a step of the second instance never carries the default key
    expect(readSteps(h.state, parseSteps, 'otherKey')).toEqual([FUEL])
  })
})

describe('carry and canGoBack (two instances sharing entries)', () => {
  const mk = (h: FakeHistory, markKey: string | undefined, opts: { carry?: boolean; canGoBack?: (floor: number) => boolean } = {}) => {
    const path: Step[] = []
    const dh = createDrillHistory<Step>({
      history: h, markKey, drill: (s) => void path.push(s), popTo: (d) => void path.splice(d), path: () => path.slice(), parseSteps, ...opts,
    })
    dh.start()
    return { dh, path }
  }

  it('a pushed entry keeps the other instance mark with carry, and drops it without', () => {
    const carried = new FakeHistory()
    const a = mk(carried, undefined, { carry: true })
    const b = mk(carried, 'otherKey', { carry: true })
    a.dh.pathChanged([FUEL])
    b.dh.pathChanged([SHOP])
    expect(readMark(carried.state)).toMatchObject({ d: 1 }) // the first instance's mark rode along on the second one's entry
    expect(readMark(carried.state, 'otherKey')).toMatchObject({ d: 1 })

    const plain = new FakeHistory()
    const c = mk(plain, undefined)
    const d = mk(plain, 'otherKey')
    c.dh.pathChanged([FUEL])
    d.dh.pathChanged([SHOP])
    expect(readMark(plain.state)).toBeNull()
    expect(readMark(plain.state, 'otherKey')).toMatchObject({ d: 1 })
  })

  it('a cut goes back through history when canGoBack allows it, and re-marks the entry when it does not', () => {
    const allowed = new FakeHistory()
    const a = mk(allowed, undefined, { canGoBack: () => true })
    a.dh.pathChanged([FUEL])
    const before = allowed.idx
    a.dh.pathChanged([])
    expect(allowed.pending).toBe(before - 1) // a go(-1) was issued

    const blocked = new FakeHistory()
    const b = mk(blocked, undefined, { canGoBack: () => false })
    b.dh.pathChanged([FUEL])
    const idx = blocked.idx
    b.dh.pathChanged([])
    expect(blocked.pending).toBeNull() // no go()
    expect(blocked.idx).toBe(idx)
    expect(readMark(blocked.state)).toMatchObject({ d: 0 }) // the entry the user is on was re-marked at the new depth
  })

  it('canGoBack is asked with the depth the cut would land on', () => {
    const h = new FakeHistory()
    const asked: number[] = []
    const a = mk(h, undefined, { canGoBack: (floor) => (asked.push(floor), true) })
    a.dh.pathChanged([FUEL, FOOD])
    a.dh.pathChanged([FUEL])
    expect(asked).toEqual([1])
  })
})

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
  it('carries the steps when given, and withoutMark takes only the mark off', () => {
    expect(readMark(withMark(null, { s: 'a', d: 1, p: [FUEL] }))).toEqual({ s: 'a', d: 1, p: [FUEL] })
    expect(withoutMark(withMark({ other: 1 }, { s: 'a', d: 0 }))).toEqual({ other: 1 })
    expect(withoutMark(withMark(null, { s: 'a', d: 0 }))).toBeNull()
    expect(withoutMark('x')).toBeNull()
  })
  it('readSteps gives the steps only when they parse and match the mark\'s depth', () => {
    expect(readSteps(withMark(null, { s: 'a', d: 2, p: [FUEL, SHOP] }), parseSteps)).toEqual([FUEL, SHOP])
    expect(readSteps(withMark(null, { s: 'a', d: 0, p: [] }), parseSteps)).toEqual([])
    expect(readSteps(withMark(null, { s: 'a', d: 1 }), parseSteps)).toBeNull() // no steps stored
    expect(readSteps(withMark(null, { s: 'a', d: 2, p: [FUEL] }), parseSteps)).toBeNull() // depth disagrees
    expect(readSteps(withMark(null, { s: 'a', d: 1, p: 'junk' }), parseSteps)).toBeNull()
    expect(readSteps(withMark(null, { s: 'a', d: 1, p: [{ level: 'x', key: 'k' }] }), parseSteps)).toBeNull()
    expect(readSteps(null, parseSteps)).toBeNull()
  })
})

describe('drilling and Back', () => {
  it('marks the entry it opens on, and each level drilled adds one entry', () => {
    const h = new FakeHistory()
    const s = section(h)
    expect(h.entries).toHaveLength(1)
    expect(readMark(h.state)).toMatchObject({ s: s.dh.session, d: 0 })
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

  it('stores the session, depth and steps in the state only: pushState and replaceState are never given an address', () => {
    const h = new FakeHistory()
    const args: unknown[][] = []
    const push = h.pushState.bind(h)
    const replace = h.replaceState.bind(h)
    h.pushState = (...a: unknown[]) => (args.push(a), push(a[0]))
    h.replaceState = (...a: unknown[]) => (args.push(a), replace(a[0]))
    const s = section(h)
    s.drill(FUEL)
    s.drill(SHOP)
    expect(args.length).toBeGreaterThan(0)
    for (const a of args) expect(a).toHaveLength(2) // (state, title): no URL argument
    expect(Object.keys((h.entries[2] as Record<string, unknown>)[MARK_KEY] as object).sort()).toEqual(['d', 'p', 's'])
    expect(readMark(h.entries[1])?.p).toEqual([FUEL])
    expect(readMark(h.entries[2])?.p).toEqual([FUEL, SHOP])
  })

  it('end() takes this session\'s mark off the entry the user is on, and keeps the rest of its state', () => {
    const h = new FakeHistory()
    h.entries = [{ page: 'p1' }]
    const s = section(h)
    s.drill(FUEL)
    expect(readMark(h.state)).not.toBeNull()
    s.dh.end()
    expect(h.state).toBeNull()
    expect(h.entries[0]).toEqual({ [MARK_KEY]: { s: s.dh.session, d: 0, p: [] }, page: 'p1' })
    h.idx = 0
    s.dh.end()
    expect(h.state).toEqual({ page: 'p1' })
  })

  it('end() leaves an entry that is not this session\'s alone', () => {
    const h = new FakeHistory()
    const s = section(h)
    h.replaceState({ [MARK_KEY]: { s: 'someone-else', d: 1 } })
    s.dh.end()
    expect(readMark(h.state)).toEqual({ s: 'someone-else', d: 1 })
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

  it('tells the section when the jump lands (to write its state onto the entry landed on), not on a plain Back', () => {
    const h = new FakeHistory()
    const s = section(h)
    s.drill(FUEL)
    s.drill(SHOP)
    s.crumb(0)
    expect(s.landings()).toBe(0) // the traversal has not landed yet
    h.flush()
    expect(s.landings()).toBe(1)
    s.drill(FUEL)
    h.back()
    expect(s.landings()).toBe(1)
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
    expect(readMark(h.state)).toMatchObject({ s: s.dh.session, d: 1 })
    s.drill(SHOP)
    s.crumb(0) // below where the history starts: go back to the adopted entry, then re-mark it as the top
    h.flush()
    expect(h.idx).toBe(1)
    expect(readMark(h.state)).toMatchObject({ s: s.dh.session, d: 0 })
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
    expect(readMark(h.state)).toMatchObject({ s: s.dh.session, d: 0 })
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
    expect(readMark(h.state)).toMatchObject({ s: second.dh.session, d: 0 })
  })

  it('landing on an older visit\'s entry with the section open takes the path that entry holds and adopts it, with no navigation', () => {
    const h = new FakeHistory()
    const first = section(h)
    first.drill(FUEL)
    first.drill(SHOP)
    const second = section(h) // a later visit on the same entry (depth 2 of the first visit's mark)
    expect(second.keys()).toEqual([])
    h.back() // onto the first visit's entry for depth 1
    expect(second.dh.settling).toBe(true)
    expect(second.keys()).toEqual(['fuel']) // the path that entry stands for
    expect(h.entries).toHaveLength(3) // nothing pushed while settling
    expect(h.pending).toBeNull() // and no go()
    second.runLater()
    expect(second.dh.settling).toBe(false)
    expect(readMark(h.state)).toMatchObject({ s: second.dh.session, d: 1, p: [FUEL] })
    h.back() // the next entry down is stale too: adopted the same way, never skipped over or looped on
    expect(second.dh.settling).toBe(true)
    expect(second.keys()).toEqual([])
    second.runLater()
    expect(readMark(h.state)).toMatchObject({ s: second.dh.session, d: 0 })
  })

  it('a stale entry whose steps are missing, broken or disagree with its depth is shown at the top', () => {
    for (const stale of [
      { [MARK_KEY]: { s: 'old', d: 1 } },
      { [MARK_KEY]: { s: 'old', d: 1, p: 'junk' } },
      { [MARK_KEY]: { s: 'old', d: 2, p: [FUEL] } },
      { [MARK_KEY]: { s: 'old', d: 1, p: [{ level: 'other', key: 'k' }] } },
      null,
    ]) {
      const h = new FakeHistory()
      h.entries = [stale, null]
      h.idx = 1
      const s = section(h, [FUEL])
      h.back()
      expect(s.keys()).toEqual([])
      s.runLater()
      expect(readMark(h.state)).toMatchObject({ s: s.dh.session, d: 0 })
    }
  })

  it('an entry with no mark at all, landed on with the section open, is adopted the same way', () => {
    const h = new FakeHistory()
    h.entries = [null, 'other']
    h.idx = 1
    const s = section(h)
    h.back()
    expect(s.dh.settling).toBe(true)
    s.runLater()
    expect(readMark(h.state)).toMatchObject({ s: s.dh.session, d: 0 })
    expect(h.entries).toHaveLength(2)
  })

  it('after a reload, Back over the earlier visit\'s entries then Forward re-drills them, with no navigation of its own', () => {
    const h = new FakeHistory()
    const first = section(h, [], () => h.idx < 2)
    first.drill(FUEL)
    h.pushState(null) // another page (Loans), one entry; the drill is not acted on there
    const second = section(h, [], () => h.idx < 2) // the reload, on that entry
    h.back()
    second.runLater()
    expect(second.keys()).toEqual(['fuel'])
    h.back()
    second.runLater()
    expect(second.keys()).toEqual([])
    h.forward()
    expect(h.pending).toBeNull() // no go() of its own
    expect(h.idx).toBe(1)
    expect(second.keys()).toEqual(['fuel'])
    h.forward()
    expect(h.idx).toBe(2)
    expect(second.keys()).toEqual(['fuel']) // the other page: the path stays as it was
    h.back()
    h.back()
    expect(second.keys()).toEqual([])
    h.forward()
    expect(second.keys()).toEqual(['fuel'])
  })

  it('a reload on a drilled level, Back then Forward: Forward re-drills from the entry\'s own steps', () => {
    const h = new FakeHistory()
    const first = section(h)
    first.drill(FUEL)
    first.drill(SHOP)
    const second = section(h, [FUEL, SHOP]) // the reload restored the path
    h.back()
    second.runLater()
    h.back()
    second.runLater()
    expect(second.keys()).toEqual([])
    h.forward()
    h.forward()
    expect(h.pending).toBeNull()
    expect(h.idx).toBe(2)
    expect(second.keys()).toEqual(['fuel', 'shop-1'])
  })

  it('after a reload, a forgotten Forward (the range changed) still steps back', () => {
    const h = new FakeHistory()
    const first = section(h)
    first.drill(FUEL)
    const second = section(h, [FUEL])
    h.back()
    second.runLater()
    second.dh.forgetForward()
    h.forward()
    h.flush()
    expect(h.idx).toBe(0)
    expect(second.keys()).toEqual([])
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
