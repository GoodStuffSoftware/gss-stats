// A small session-history stand-in for tests that must walk Back AND Forward.
//
// happy-dom keeps `history.length` at 1 for a pushState called without an address (the debt drill does that: the
// URL stays the same), and its back()/forward() do not move through the entries. This keeps a real entry list:
// pushState cuts the entries above the current one and adds a new one, replaceState rewrites the current one,
// and back()/forward()/go(n) move the index, put that entry's state and address in place and dispatch `popstate`
// (asynchronously, like a browser). Test-only; install it in a beforeEach and call restore() in an afterEach.

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

  const place = (e: Entry) => realReplace(e.state, '', e.url)
  const resolve = (u?: string | URL | null) => {
    if (u == null) return entries[index].url
    const parsed = new URL(String(u), location.href)
    return parsed.pathname + parsed.search + parsed.hash
  }

  const own = (name: string, value: unknown) => Object.defineProperty(h, name, { value, configurable: true, writable: true })
  own('pushState', (state: unknown, _t: string, u?: string | URL | null) => {
    entries.length = index + 1
    entries.push({ state, url: resolve(u) })
    index++
    place(entries[index])
  })
  own('replaceState', (state: unknown, _t: string, u?: string | URL | null) => {
    entries[index] = { state, url: resolve(u) }
    place(entries[index])
  })
  const go = (delta = 0) => {
    const next = index + delta
    if (delta === 0 || next < 0 || next >= entries.length) return
    index = next
    place(entries[index])
    const state = entries[index].state
    setTimeout(() => window.dispatchEvent(new PopStateEvent('popstate', { state })), 0)
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
