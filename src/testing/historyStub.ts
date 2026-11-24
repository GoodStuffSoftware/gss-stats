// A small session-history stand-in for tests that must walk Back AND Forward.
//
// happy-dom keeps `history.length` at 1 for a pushState called without an address (the debt drill does that: the
// URL stays the same), and its back()/forward() do not move through the entries. This keeps a real entry list:
// pushState cuts the entries above the current one and adds a new one, replaceState rewrites the current one,
// and back()/forward()/go(n) move the index later (a timer task, like a browser: until it runs `history.state` and the
// address are still the old entry's), then put that entry's state and address in place and dispatch `popstate`.
// State is structured-cloned on the way in and out, as in a browser.
// Not modelled: a traversal onto an entry of an EARLIER document (after a reload), which in a browser is a full page
// load; here every traversal is a same-document popstate. Test-only; install it in a beforeEach and call restore() in an
// afterEach.

interface Entry {
  state: unknown
  url: string
}

export interface HistoryStub {
  readonly entries: readonly Entry[]
  readonly index: number
  restore(): void
}

export function installHistoryStub(): HistoryStub {
  const h = history as History
  const realReplace = h.replaceState.bind(h)
  const here = () => location.pathname + location.search + location.hash
  const entries: Entry[] = [{ state: h.state, url: here() }]
  let index = 0

  const place = (e: Entry) => realReplace(structuredClone(e.state), '', e.url)
  const resolve = (u?: string | URL | null) => {
    if (u == null) return entries[index].url
    const parsed = new URL(String(u), location.href)
    return parsed.pathname + parsed.search + parsed.hash
  }

  // A browser structured-clones the state: a later change to the object does not change the entry, and a function or a
  // Vue reactive proxy throws DataCloneError (so does this).
  const own = (name: string, value: unknown) => Object.defineProperty(h, name, { value, configurable: true, writable: true })
  own('pushState', (state: unknown, _t: string, u?: string | URL | null) => {
    const kept = structuredClone(state)
    entries.length = index + 1
    entries.push({ state: kept, url: resolve(u) })
    index++
    place(entries[index])
  })
  own('replaceState', (state: unknown, _t: string, u?: string | URL | null) => {
    entries[index] = { state: structuredClone(state), url: resolve(u) }
    place(entries[index])
  })
  // The traversal runs later (a task, like a browser): until then `history.state` and the address still name the entry
  // the user is leaving. The target is worked out when it runs, so two back() calls in a row go back twice.
  const go = (delta = 0) => {
    if (delta === 0) return
    setTimeout(() => {
      const next = index + delta
      if (next < 0 || next >= entries.length) return
      index = next
      place(entries[index])
      window.dispatchEvent(new PopStateEvent('popstate', { state: structuredClone(entries[index].state) }))
    }, 0)
  }
  own('go', go)
  own('back', () => go(-1))
  own('forward', () => go(1))
  Object.defineProperty(h, 'length', { get: () => entries.length, configurable: true })

  return {
    get entries() {
      return entries
    },
    get index() {
      return index
    },
    restore() {
      for (const k of ['pushState', 'replaceState', 'go', 'back', 'forward', 'length']) delete (h as unknown as Record<string, unknown>)[k]
    },
  }
}
