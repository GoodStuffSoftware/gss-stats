// Browser Back / Forward for the Budget drill-down: each level the spending pie opens adds one history entry,
// so Back goes up one level (toolbar button, mouse back button, Alt+Left, a trackpad swipe, Android back) and
// Forward re-opens the level it came from.
//
// What is stored: history.state only, a small mark `{ s: <session>, d: <depth> }` (no names, no ids, no URL
// change: the entries it adds share the URL of the entry they were pushed from). The steps themselves (what a
// level is) live in memory in this object, for Forward.
//
// Model: one `session` per mounted section; `depth` is how many levels the entry the user is on stands for
// (= the drill path's length); `base` is the depth the first entry of this session was adopted at (0 on a
// normal open, more after a reload that restored a path from the address bar), so entries below it are not ours
// to go back through.
//   - a drill (path longer): push one entry per new level.
//   - a breadcrumb jump or any other path cut (path shorter by n): history.go(-n) over our own entries, so Back
//     after the jump never re-enters a level just left; the dropped steps wait in `forward` (the entries ahead
//     are still in the browser's list). Cut below `base`: the entry is re-marked instead (nothing behind to use).
//   - popstate onto one of our entries: shallower = Back (cut the path), deeper = Forward (drill again with the
//     remembered steps; if they are gone, step back so the entry cannot show a level that no longer exists).
//   - popstate onto an entry that is NOT of this session (a stale one a previous visit to Budget left behind, or
//     one with no mark): the section re-reads its own state from the address bar (viewState.readUrl, which runs
//     right after this) and this entry is adopted as the new top: re-marked with the current depth, `forward`
//     dropped. Nothing is navigated, so no Back press is ever swallowed by a loop.
// Stale entries are therefore never acted on, only adopted when the user lands on one with the section open.
// Landing on one with the section closed (App closes it) is none of this module's business.
//
// Pure of Vue and the DOM: the caller hands over a `history`-like object and what to do with the path.

export const MARK_KEY = 'gssBudgetDrill'

export interface DrillMark {
  s: string
  d: number
}
export interface HistoryLike {
  readonly state: unknown
  pushState(state: unknown, title: string): void
  replaceState(state: unknown, title: string): void
  go(delta: number): void
}

/** The mark an entry's state carries, or null (no state, another shape, a malformed mark). */
export function readMark(state: unknown): DrillMark | null {
  if (!state || typeof state !== 'object') return null
  const m = (state as Record<string, unknown>)[MARK_KEY]
  if (!m || typeof m !== 'object') return null
  const { s, d } = m as Record<string, unknown>
  return typeof s === 'string' && s && typeof d === 'number' && Number.isInteger(d) && d >= 0 ? { s, d } : null
}
/** `state` with the mark set; whatever else it held (an object) is kept. */
export function withMark(state: unknown, mark: DrillMark): Record<string, unknown> {
  const base = state && typeof state === 'object' && !Array.isArray(state) ? (state as Record<string, unknown>) : {}
  return { ...base, [MARK_KEY]: { s: mark.s, d: mark.d } }
}

let sessionCounter = 0
export function newSessionId(): string {
  sessionCounter += 1
  return `${Date.now().toString(36)}-${sessionCounter}`
}

export interface DrillHistoryOptions<Step> {
  history: HistoryLike
  /** Drill one level with this step (the section's own pushStep). */
  drill: (step: Step) => void
  /** Cut the path back to `depth` steps (the section's own popTo). */
  popTo: (depth: number) => void
  /** The section's drill path right now (used when it re-reads itself after a foreign entry). */
  path: () => Step[]
  /** Run `fn` after the other popstate listeners and the reactive flush (a macrotask in the browser). */
  later?: (fn: () => void) => void
  session?: string
}

export interface DrillHistory<Step> {
  readonly session: string
  /** Adopt the entry the user is on as the top of this session, at the path's depth. Call once, when mounted. */
  start(): void
  /** The path changed (synchronously, in the same call that changed it). */
  pathChanged(path: Step[]): void
  /** The steps remembered for Forward no longer mean anything (the range, person or grouping changed). */
  forgetForward(): void
  /** A popstate event with the state of the entry landed on; `sectionOpen` is whether the address bar still names
   * the section. */
  popped(state: unknown, sectionOpen: boolean): void
  /** True while a popstate that this module does not own is being settled (see above). */
  readonly settling: boolean
}

export function createDrillHistory<Step>(opts: DrillHistoryOptions<Step>): DrillHistory<Step> {
  const h = opts.history
  const session = opts.session ?? newSessionId()
  const later = opts.later ?? ((fn) => void setTimeout(fn, 0))

  let depth = 0 // the depth of the entry the user is on
  let base = 0
  let known: Step[] = [] // the steps of the levels down to `depth`
  let forward: Step[] = [] // the steps of the levels just below `depth`, for Forward (entries for them still exist)
  let expect: { depth: number; rebase: number | null } | null = null // landing of a go() we issued
  let settling = false
  let applying = false // the path is being changed by this module (Back, Forward): pathChanged must not answer it

  const mark = (d: number) => h.replaceState(withMark(h.state, { s: session, d }), '')

  function apply(fn: () => void) {
    applying = true
    try {
      fn()
    } finally {
      applying = false
    }
  }
  function adopt() {
    const p = opts.path()
    depth = p.length
    base = depth
    known = p.slice()
    forward = []
    mark(depth)
  }

  return {
    session,
    get settling() {
      return settling
    },
    start() {
      adopt()
    },
    forgetForward() {
      forward = []
    },
    pathChanged(path) {
      if (settling || applying) return // an outside re-read (settled later) or this module itself is changing it
      const n = path.length
      if (n === depth) {
        known = path.slice()
        return
      }
      if (n > depth) {
        for (let d = depth + 1; d <= n; d++) h.pushState(withMark(null, { s: session, d }), '')
        forward = [] // a push drops the entries ahead
        depth = n
        known = path.slice()
        return
      }
      // shorter: back over our own entries
      const floor = Math.max(n, base)
      const dropped = known.slice(floor, depth)
      const cut = depth - floor
      forward = dropped.concat(forward)
      if (cut > 0) {
        expect = { depth: floor, rebase: n < base ? n : null }
        h.go(-cut)
      } else {
        // nothing of ours behind this entry (cut below the adopted base): re-mark it instead
        forward = []
        base = n
        mark(n)
      }
      depth = n
      known = path.slice()
    },
    popped(state, sectionOpen) {
      if (!sectionOpen) return
      const m = readMark(state)
      if (m && m.s === session) {
        const landed = expect
        expect = null
        if (landed && m.d === landed.depth) {
          // the landing of a go() we issued: the path is already where it should be
          if (landed.rebase !== null) {
            base = landed.rebase
            forward = []
            mark(landed.rebase)
          }
          return
        }
        if (m.d === depth) return
        if (m.d < depth) {
          // Back: one level up (or several, from the browser's history list)
          forward = known.slice(m.d, depth).concat(forward)
          depth = m.d
          known = known.slice(0, m.d)
          apply(() => opts.popTo(m.d))
          return
        }
        // Forward: only when the steps of those levels are still remembered
        const need = m.d - depth
        if (forward.length >= need) {
          const steps = forward.slice(0, need)
          forward = forward.slice(need)
          depth = m.d
          known = known.concat(steps)
          apply(() => steps.forEach((s) => opts.drill(s)))
          return
        }
        expect = { depth, rebase: null }
        h.go(depth - m.d) // a level that no longer exists: go back to where the path is
        return
      }
      // not an entry of this session: the section re-reads itself; adopt the entry once that has happened
      expect = null
      settling = true
      later(() => {
        settling = false
        adopt()
      })
    },
  }
}
