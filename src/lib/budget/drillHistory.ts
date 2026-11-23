// Browser Back / Forward for the Budget drill-down: each level the spending pie opens adds one history entry,
// so Back goes up one level (toolbar button, mouse back button, Alt+Left, a trackpad swipe, Android back) and
// Forward re-opens the level it came from.
//
// What is stored: history.state only, never the address. Every entry this module pushes or marks carries
// `{ s: <session>, d: <depth>, p: <the drill steps down to that depth> }`, and the entries share the URL of the
// entry they were pushed from: the URL does not change and never names a category, store or purchase. (history.state
// is kept by the browser in this tab's session and is not part of any URL, log or synced history.) `p` is what lets
// a reload, or a Back onto an entry of an earlier visit, put the drill path back (see `readSteps`).
//
// Model: one `session` per mounted section; `depth` is how many levels the entry the user is on stands for
// (= the drill path's length); `base` is the depth the first entry of this session was adopted at (0 on a
// normal open, more after a reload that restored a path), so entries below it are not ours to go back through.
//   - a drill (path longer): push one entry per new level.
//   - a breadcrumb jump or any other path cut (path shorter by n): history.go(-n) over our own entries, so Back
//     after the jump never re-enters a level just left; the dropped steps wait in `forward` (the entries ahead
//     are still in the browser's list). Cut below `base`: the entry is re-marked instead (nothing behind to use).
//   - popstate onto one of our entries: shallower = Back (cut the path), deeper = Forward (drill again with the
//     remembered steps; when this session does not remember them (the entries ahead were adopted from an earlier
//     visit, or re-marked after a reload) the entry's own `p` is taken; only when the steps were forgotten (the range,
//     person or grouping changed: `forgetForward`) or `p` does not parse does it step back, so the entry cannot show
//     a level that no longer exists).
//   - popstate onto an entry that is NOT of this session (a stale one an earlier visit left behind, or one with
//     no mark) with the section open: the path is set from that entry's own `p` (the top when it has none or it
//     does not parse), and the entry is adopted as the new top of this session: re-marked with the current depth,
//     `forward` dropped. Nothing is navigated, so no Back press is ever swallowed by a loop.
// Stale entries are therefore never acted on, only adopted when the user lands on one with the section open.
// Landing on one with the section closed (App closes it) is none of this module's business.
// When the section goes away (`end`), the mark is taken off the entry the user is then on, so a page the app
// moved to keeps no drill state and opening the section again from it starts at the top.
//
// Pure of Vue and the DOM: the caller hands over a `history`-like object and what to do with the path.

export const MARK_KEY = 'gssBudgetDrill'

export interface DrillMark {
  s: string
  d: number
  /** The drill steps down to depth `d`, as stored (not yet validated: see `readSteps`). */
  p?: unknown
}
export interface HistoryLike {
  readonly state: unknown
  pushState(state: unknown, title: string): void
  replaceState(state: unknown, title: string): void
  go(delta: number): void
}

/** The mark an entry's state carries, or null (no state, another shape, a malformed mark). */
export function readMark(state: unknown, key: string = MARK_KEY): DrillMark | null {
  if (!state || typeof state !== 'object') return null
  const m = (state as Record<string, unknown>)[key]
  if (!m || typeof m !== 'object') return null
  const { s, d, p } = m as Record<string, unknown>
  if (!(typeof s === 'string' && s && typeof d === 'number' && Number.isInteger(d) && d >= 0)) return null
  return p === undefined ? { s, d } : { s, d, p }
}
/** `state` with the mark set; whatever else it held (an object) is kept. */
export function withMark(state: unknown, mark: DrillMark, key: string = MARK_KEY): Record<string, unknown> {
  const base = state && typeof state === 'object' && !Array.isArray(state) ? (state as Record<string, unknown>) : {}
  return { ...base, [key]: mark.p === undefined ? { s: mark.s, d: mark.d } : { s: mark.s, d: mark.d, p: mark.p } }
}
/** `state` without the mark (null when nothing else is left in it). */
export function withoutMark(state: unknown, key: string = MARK_KEY): Record<string, unknown> | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null
  const { [key]: _mark, ...rest } = state as Record<string, unknown>
  return Object.keys(rest).length ? rest : null
}
/** The steps an entry's mark holds, when `parse` accepts them and they are as many as the mark's depth; else null. */
export function readSteps<Step>(state: unknown, parse: (raw: unknown) => Step[] | null, key: string = MARK_KEY): Step[] | null {
  const m = readMark(state, key)
  if (!m || m.p === undefined) return null
  const steps = parse(m.p)
  return steps && steps.length === m.d ? steps : null
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
  /** The section's drill path right now. */
  path: () => Step[]
  /** Checks steps read back from history.state (anything may be in there): the valid steps, or null. */
  parseSteps: (raw: unknown) => Step[] | null
  /** Run `fn` after the other popstate listeners and the reactive flush (a macrotask in the browser). */
  later?: (fn: () => void) => void
  /** The landing of a go() this module issued (a breadcrumb jump): the entry landed on keeps the address it had when
   * it was pushed, so the section writes its current state onto it. */
  landed?: () => void
  session?: string
  /** The history.state key this instance marks entries with (default MARK_KEY). A second instance on the same
   * page (the Loans page's one-level `loan` step, viewState.ts) uses its own key so the two never read each
   * other's entries. */
  markKey?: string
  /** Pushed entries keep what the entry pushed from already holds in history.state (another instance's mark) instead
   * of starting empty. Needed when two instances share the same entries (the spending drill and the debt drill on
   * Overview): otherwise an entry one of them pushed looks foreign to the other, which would adopt it and reset. */
  carry?: boolean
  /** Asked before a path cut goes back through history (`go(-n)` over our own entries, down to depth `floor`). False
   * when something else pushed entries in between (the other instance), so going back would land on them: the entry
   * the user is on is re-marked instead, like a cut below the adopted base. Default: always true. */
  canGoBack?: (floor: number) => boolean
}

export interface DrillHistory<Step> {
  readonly session: string
  /** Adopt the entry the user is on as the top of this session, at the path's depth. Call once, when mounted. */
  start(): void
  /** The section is going away: take this session's mark off the entry the user is on. */
  end(): void
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
  const key = opts.markKey ?? MARK_KEY
  const carry = opts.carry === true

  let depth = 0 // the depth of the entry the user is on
  let base = 0
  let known: Step[] = [] // the steps of the levels down to `depth`
  let forward: Step[] = [] // the steps of the levels just below `depth`, for Forward (entries for them still exist)
  let expect: { depth: number; rebase: number | null } | null = null // landing of a go() we issued
  let settling = false
  let applying = false // the path is being changed by this module (Back, Forward): pathChanged must not answer it
  // forgetForward was called since the entries ahead were made: their steps (in `forward` or their own `p`) mean
  // nothing now. A push drops the entries ahead, so it clears this.
  let forgotten = false

  const mark = (d: number) => h.replaceState(withMark(h.state, { s: session, d, p: known.slice(0, d) }, key), '')
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
    end() {
      if (readMark(h.state, key)?.s === session) h.replaceState(withoutMark(h.state, key), '')
    },
    forgetForward() {
      forward = []
      // a range or person taken from the address of an earlier visit's entry being landed on is not a change of
      // the user's: the entries ahead still stand for what they did
      if (!settling) forgotten = true
    },
    pathChanged(path) {
      if (settling || applying) return // an outside change (settled later) or this module itself is changing it
      const n = path.length
      if (n === depth) {
        known = path.slice()
        return
      }
      if (n > depth) {
        for (let d = depth + 1; d <= n; d++) h.pushState(withMark(carry ? h.state : null, { s: session, d, p: path.slice(0, d) }, key), '')
        forward = [] // a push drops the entries ahead
        forgotten = false
        depth = n
        known = path.slice()
        return
      }
      // shorter: back over our own entries
      const floor = Math.max(n, base)
      const cut = depth - floor
      forward = known.slice(floor, depth).concat(forward)
      depth = n
      known = path.slice()
      if (cut > 0 && (opts.canGoBack?.(floor) ?? true)) {
        expect = { depth: floor, rebase: n < base ? n : null }
        h.go(-cut)
      } else {
        // nothing of ours behind this entry (cut below the adopted base, or foreign entries in between): re-mark it instead
        forward = []
        base = n
        mark(n)
      }
    },
    popped(state, sectionOpen) {
      if (!sectionOpen) return
      const m = readMark(state, key)
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
          opts.landed?.()
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
        // not remembered here (adopted after a reload, or re-marked): the entry's own steps, unless they were forgotten
        const own = forgotten ? null : readSteps(state, opts.parseSteps, key)
        if (own) {
          forward = []
          depth = m.d
          known = own.slice()
          apply(() => {
            opts.popTo(0)
            own.forEach((s) => opts.drill(s))
          })
          return
        }
        expect = { depth, rebase: null }
        h.go(depth - m.d) // a level that no longer exists: go back to where the path is
        return
      }
      // not an entry of this session: take the path it holds (else the top), then adopt it as the new top
      expect = null
      settling = true
      const steps = readSteps(state, opts.parseSteps, key) ?? []
      apply(() => {
        opts.popTo(0)
        steps.forEach((s) => opts.drill(s))
      })
      later(() => {
        settling = false
        adopt()
      })
    },
  }
}
