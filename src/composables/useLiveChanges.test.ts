// @vitest-environment happy-dom
//
// The live socket (useLiveChanges.ts) against a fake WebSocket and fake timers. Counts-only
// guarantee 6 (gating): a ping that arrives or comes due while the tab is hidden or idle is dropped,
// and the socket is only open while the tab is visible and in use. Plus the contract: the same-origin
// ws/wss URL, the ping timing (95 s + 0-25 s after the ping arrives, whatever the client clock says), only the exact ping text acted
// on, backoff 1 s doubling to 5 min with jitter and reset only after 60 s open, the 50 s keepalive, and a
// constructor that throws being fail-soft.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetLiveChangesForTests,
  LIVE_BACKOFF_CAP_MS,
  LIVE_BOUNDARY_MS,
  LIVE_CHANGED_TEXT,
  LIVE_FIRE_DELAY_MS,
  LIVE_FIRE_JITTER_MS,
  LIVE_IDLE_MS,
  LIVE_KEEPALIVE_MS,
  LIVE_STABLE_MS,
  liveBackoffMs,
  liveFireDelayMs,
  startLiveChanges,
  useLiveChanges,
} from './useLiveChanges'
import { __resetReturnRefreshForTests, emitLiveChange, onLiveChange, onReturn } from './useReturnRefresh'
import { effectScope } from 'vue'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readyState = 0
  sent: string[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
    this.readyState = 3
  }
  // test helpers: what the network does
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  message(data: unknown) {
    this.onmessage?.({ data })
  }
  drop() {
    this.readyState = 3
    this.onerror?.()
    this.onclose?.()
  }
}
const sockets = () => FakeWebSocket.instances
const last = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1]

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}
const input = (type: string = 'pointerdown') => window.dispatchEvent(new Event(type))

// A fixed clock on a 15-minute boundary: 2026-10-05 14:00:00 UTC (10:00 ET).
const B0 = Date.parse('2026-10-05T14:00:00Z')

let random = 0
beforeEach(() => {
  __resetLiveChangesForTests()
  __resetReturnRefreshForTests()
  FakeWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  vi.useFakeTimers()
  vi.setSystemTime(B0)
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  random = 0
  vi.spyOn(Math, 'random').mockImplementation(() => random)
})
afterEach(() => {
  __resetLiveChangesForTests()
  __resetReturnRefreshForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** Starts the socket and opens it. */
function startOpen() {
  startLiveChanges()
  expect(sockets()).toHaveLength(1)
  last().open()
  return last()
}

describe('pure helpers', () => {
  it('liveFireDelayMs: 95 s + jitter, past the 90 s edge cache for any jitter', () => {
    expect(LIVE_BOUNDARY_MS).toBe(900_000)
    expect(liveFireDelayMs(0)).toBe(95_000)
    expect(liveFireDelayMs(25_000)).toBe(120_000)
    expect(liveFireDelayMs(0)).toBeGreaterThan(90_000)
  })

  it('liveBackoffMs: 1 s doubling to a 5 min cap, jitter within [base/2, base]', () => {
    const full = Array.from({ length: 12 }, (_, i) => liveBackoffMs(i, 1))
    expect(full).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000, 300000])
    expect(LIVE_BACKOFF_CAP_MS).toBe(300_000)
    expect(liveBackoffMs(0, 0)).toBe(500)
    expect(liveBackoffMs(20, 0)).toBe(150_000)
    for (let a = 0; a < 40; a++) for (const r of [0, 0.3, 0.999]) expect(liveBackoffMs(a, r)).toBeLessThanOrEqual(LIVE_BACKOFF_CAP_MS)
  })
})

describe('when the socket is open', () => {
  it('opens ws://<host>/api/live on a plain-http page and wss:// on https', () => {
    startLiveChanges()
    expect(last().url).toBe(`ws://${location.host}/api/live`)
    __resetLiveChangesForTests()
    FakeWebSocket.instances = []
    vi.stubGlobal('location', { protocol: 'https:', host: 'stats.example.com' })
    startLiveChanges()
    expect(last().url).toBe('wss://stats.example.com/api/live')
  })

  it('does not open while the tab is hidden, and opens when it becomes visible', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    startLiveChanges()
    expect(sockets()).toHaveLength(0)
    setVisibility('visible')
    expect(sockets()).toHaveLength(1)
  })

  it('does nothing at all when WebSocket is unsupported', () => {
    vi.stubGlobal('WebSocket', undefined)
    expect(() => startLiveChanges()).not.toThrow()
    vi.advanceTimersByTime(LIVE_IDLE_MS)
    input()
    setVisibility('visible')
    expect(sockets()).toHaveLength(0)
  })

  it('closes when hidden (no reconnect while hidden) and reopens when visible again', () => {
    const s = startOpen()
    setVisibility('hidden')
    expect(s.closed).toBe(true)
    vi.advanceTimersByTime(LIVE_BACKOFF_CAP_MS * 2)
    expect(sockets()).toHaveLength(1)
    setVisibility('visible')
    expect(sockets()).toHaveLength(2)
  })

  it('closes after 2 h without input; the next input reopens it', () => {
    const s = startOpen()
    vi.advanceTimersByTime(LIVE_IDLE_MS - 1000)
    expect(s.closed).toBe(false)
    vi.advanceTimersByTime(2000)
    expect(s.closed).toBe(true)
    expect(sockets()).toHaveLength(1)
    vi.advanceTimersByTime(LIVE_IDLE_MS) // stays closed while untouched
    expect(sockets()).toHaveLength(1)
    input('keydown')
    expect(sockets()).toHaveLength(2)
  })

  it('input pushes the idle cutoff out: input at 1 h 59 m keeps the socket for another 2 h', () => {
    const s = startOpen()
    vi.advanceTimersByTime(LIVE_IDLE_MS - 60_000)
    input('wheel')
    vi.advanceTimersByTime(LIVE_IDLE_MS - 120_000)
    expect(s.closed).toBe(false)
    vi.advanceTimersByTime(180_000)
    expect(s.closed).toBe(true)
  })

  it('every one of pointerdown, keydown, wheel and touchstart counts as input', () => {
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      __resetLiveChangesForTests()
      FakeWebSocket.instances = []
      startOpen()
      vi.advanceTimersByTime(LIVE_IDLE_MS + 1000)
      expect(last().closed).toBe(true)
      input(type)
      expect(sockets()).toHaveLength(2)
    }
  })

  it('a second start is a no-op: still one socket, and only the first caller can stop it', () => {
    const stop1 = startLiveChanges()
    const stop2 = startLiveChanges()
    expect(sockets()).toHaveLength(1)
    stop2()
    expect(last().closed).toBe(false)
    stop1()
    expect(last().closed).toBe(true)
  })

  it('useLiveChanges stops with its effect scope', () => {
    const scope = effectScope()
    scope.run(() => useLiveChanges())
    const s = last()
    scope.stop()
    expect(s.closed).toBe(true)
    setVisibility('visible')
    expect(sockets()).toHaveLength(1) // listeners are gone too
  })
})

describe('keepalive', () => {
  it('sends the text "ping" every 50 s while open, and stops when the socket closes', () => {
    const s = startOpen()
    vi.advanceTimersByTime(LIVE_KEEPALIVE_MS - 1)
    expect(s.sent).toEqual([])
    vi.advanceTimersByTime(1)
    expect(s.sent).toEqual(['ping'])
    vi.advanceTimersByTime(LIVE_KEEPALIVE_MS * 2)
    expect(s.sent).toEqual(['ping', 'ping', 'ping'])
    setVisibility('hidden')
    vi.advanceTimersByTime(LIVE_KEEPALIVE_MS * 3)
    expect(s.sent).toHaveLength(3)
  })

  it('a send that throws is swallowed', () => {
    const s = startOpen()
    s.send = () => {
      throw new Error('InvalidStateError')
    }
    expect(() => vi.advanceTimersByTime(LIVE_KEEPALIVE_MS * 2)).not.toThrow()
  })
})

describe('a ping: 95 s + jitter after it arrives', () => {
  it('fires live subscribers 95 s after the ping arrives when the jitter is 0', () => {
    const cb = vi.fn()
    onLiveChange(cb)
    const s = startOpen()
    vi.advanceTimersByTime(10_000) // now B0 + 10 s
    s.message(LIVE_CHANGED_TEXT)
    random = 0
    vi.advanceTimersByTime(LIVE_FIRE_DELAY_MS - 1)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('fires up to 25 s later with the largest jitter, and not before', () => {
    const cb = vi.fn()
    onLiveChange(cb)
    const s = startOpen()
    random = 0.999999
    s.message(LIVE_CHANGED_TEXT) // at the boundary itself
    vi.advanceTimersByTime(LIVE_FIRE_DELAY_MS + LIVE_FIRE_JITTER_MS - 10)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('is past the 90 s edge cache for any jitter', () => {
    expect(LIVE_FIRE_DELAY_MS).toBeGreaterThan(90_000)
  })

  // The server sends the ping at the boundary B; the client must wait out the 90 s edge cache from
  // when the ping ARRIVES, not from a boundary rebuilt from its own clock. A clock that reads just
  // before B used to pick the previous window and fire at once (inside the cache window, eating the
  // chart's hourly cap on the stale answer).
  it.each([
    ['-0.5 s (slow)', -500],
    ['-5 s (slow)', -5_000],
    ['+5 s (fast)', 5_000],
    ['-3 min (slow)', -180_000],
    ['+3 min (fast)', 180_000],
    ['on time', 0],
  ])('a client clock %s: fires no earlier than 95 s after receipt, and by 120 s', (_name, skew) => {
    const cb = vi.fn()
    onLiveChange(cb)
    const s = startOpen()
    vi.setSystemTime(B0 + 200 + skew) // the ping arrives 200 ms after the true boundary
    s.message(LIVE_CHANGED_TEXT) // jitter 0 (random = 0)
    vi.advanceTimersByTime(LIVE_FIRE_DELAY_MS - 1)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it.each([-500, 5_000, -180_000])('a client clock off by %i ms, largest jitter: waits the full 120 s', (skew) => {
    const cb = vi.fn()
    onLiveChange(cb)
    const s = startOpen()
    vi.setSystemTime(B0 + 200 + skew)
    random = 0.999999
    s.message(LIVE_CHANGED_TEXT)
    vi.advanceTimersByTime(LIVE_FIRE_DELAY_MS + LIVE_FIRE_JITTER_MS - 10)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('a ping that arrives late (minutes past the boundary) still waits the full delay, never fires at once', () => {
    const cb = vi.fn()
    onLiveChange(cb)
    const s = startOpen()
    vi.advanceTimersByTime(5 * 60_000)
    s.message(LIVE_CHANGED_TEXT)
    vi.advanceTimersByTime(LIVE_FIRE_DELAY_MS - 1)
    expect(cb).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('two pings in one window fire once', () => {
    const cb = vi.fn()
    onLiveChange(cb)
    const s = startOpen()
    s.message(LIVE_CHANGED_TEXT)
    s.message(LIVE_CHANGED_TEXT)
    vi.advanceTimersByTime(LIVE_BOUNDARY_MS)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('the next boundary fires again', () => {
    const cb = vi.fn()
    onLiveChange(cb)
    const s = startOpen()
    s.message(LIVE_CHANGED_TEXT)
    vi.advanceTimersByTime(LIVE_BOUNDARY_MS) // now B0 + 15 min
    s.message(LIVE_CHANGED_TEXT)
    vi.advanceTimersByTime(LIVE_BOUNDARY_MS)
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('never wakes a return subscriber, and a return never wakes a live one (separate sets)', () => {
    const live = vi.fn()
    const ret = vi.fn()
    onLiveChange(live)
    onReturn(ret)
    const s = startOpen()
    s.message(LIVE_CHANGED_TEXT)
    vi.advanceTimersByTime(LIVE_BOUNDARY_MS)
    expect(live).toHaveBeenCalledTimes(1)
    expect(ret).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('focus'))
    vi.advanceTimersByTime(1000)
    expect(ret).toHaveBeenCalledTimes(1)
    expect(live).toHaveBeenCalledTimes(1)
  })

  it('a throwing subscriber does not stop the others', () => {
    const ok = vi.fn()
    onLiveChange(() => {
      throw new Error('boom')
    })
    onLiveChange(ok)
    const s = startOpen()
    s.message(LIVE_CHANGED_TEXT)
    expect(() => vi.advanceTimersByTime(LIVE_BOUNDARY_MS)).not.toThrow()
    expect(ok).toHaveBeenCalledTimes(1)
  })
})

describe('guarantee 6: hidden or idle drops pings', () => {
  it('a ping that comes due while the tab is hidden is dropped (not fired when it comes back, either)', () => {
    const cb = vi.fn()
    onLiveChange(cb)
    const s = startOpen()
    s.message(LIVE_CHANGED_TEXT)
    vi.advanceTimersByTime(30_000)
    setVisibility('hidden')
    vi.advanceTimersByTime(LIVE_BOUNDARY_MS) // due while hidden
    expect(cb).not.toHaveBeenCalled()
    setVisibility('visible')
    vi.advanceTimersByTime(LIVE_BOUNDARY_MS)
    expect(cb).not.toHaveBeenCalled()
  })

  it('hidden and visible again BEFORE it comes due: still fires', () => {
    const cb = vi.fn()
    onLiveChange(cb)
    const s = startOpen()
    s.message(LIVE_CHANGED_TEXT)
    vi.advanceTimersByTime(10_000)
    setVisibility('hidden')
    vi.advanceTimersByTime(10_000)
    setVisibility('visible')
    vi.advanceTimersByTime(LIVE_FIRE_DELAY_MS + LIVE_FIRE_JITTER_MS)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('a ping that comes due after 2 h without input is dropped', () => {
    const cb = vi.fn()
    onLiveChange(cb)
    const s = startOpen()
    vi.advanceTimersByTime(30_000)
    input() // the last input: the idle mark is B0 + 2 h + 30 s
    vi.advanceTimersByTime(LIVE_IDLE_MS - 20_000) // now B0 + 2 h + 10 s, inside the next window
    expect(s.closed).toBe(false)
    s.message(LIVE_CHANGED_TEXT) // due at B0 + 2 h + 95 s: past the idle mark
    vi.advanceTimersByTime(LIVE_BOUNDARY_MS)
    expect(cb).not.toHaveBeenCalled()
  })

  it('input before it comes due makes it count', () => {
    const cb = vi.fn()
    onLiveChange(cb)
    const s = startOpen()
    vi.advanceTimersByTime(30_000)
    input()
    vi.advanceTimersByTime(LIVE_IDLE_MS - 20_000) // B0 + 2 h + 10 s
    s.message(LIVE_CHANGED_TEXT) // due at B0 + 2 h + 95 s
    vi.advanceTimersByTime(50_000) // B0 + 2 h + 60 s: the idle mark has passed, the socket closed
    expect(s.closed).toBe(true)
    input() // back at the tab before the ping comes due
    vi.advanceTimersByTime(LIVE_BOUNDARY_MS)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('emitLiveChange itself never fires while hidden', () => {
    const cb = vi.fn()
    onLiveChange(cb)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    emitLiveChange()
    expect(cb).not.toHaveBeenCalled()
  })
})

describe('only the exact ping text is acted on', () => {
  const ignored: [string, unknown][] = [
    ['trailing space', '{"t":"changed"} '],
    ['extra field', '{"t":"changed","n":3}'],
    ['a count', '{"t":"changed","count":12}'],
    ['bare word', 'changed'],
    ['another type', '{"t":"other"}'],
    ['pong (the keepalive answer)', 'pong'],
    ['empty', ''],
    ['whitespace-reformatted', '{ "t": "changed" }'],
    ['different case', '{"t":"Changed"}'],
    ['binary', new ArrayBuffer(8)],
    ['null', null],
    ['an object', { t: 'changed' }],
  ]
  for (const [name, data] of ignored) {
    it(`ignores ${name}`, () => {
      const cb = vi.fn()
      onLiveChange(cb)
      const s = startOpen()
      s.message(data)
      vi.advanceTimersByTime(LIVE_BOUNDARY_MS * 2)
      expect(cb).not.toHaveBeenCalled()
    })
  }

  it('acts on the exact text', () => {
    const cb = vi.fn()
    onLiveChange(cb)
    startOpen().message('{"t":"changed"}')
    vi.advanceTimersByTime(LIVE_BOUNDARY_MS)
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('reconnect backoff', () => {
  it('1 s doubling to the 5 min cap (jitter at its maximum), then stays at the cap', () => {
    random = 1
    startLiveChanges()
    const delays = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000]
    for (const d of delays) {
      const n = sockets().length
      last().drop() // the handshake failed or the server went away
      vi.advanceTimersByTime(d - 1)
      expect(sockets()).toHaveLength(n)
      vi.advanceTimersByTime(1)
      expect(sockets()).toHaveLength(n + 1)
    }
  })

  it('has jitter: with the smallest random value the first retry is at half the base', () => {
    random = 0
    startLiveChanges()
    last().drop()
    vi.advanceTimersByTime(499)
    expect(sockets()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(sockets()).toHaveLength(2)
  })

  it('resets to 1 s only after the socket has stayed open for 60 s', () => {
    random = 1
    startLiveChanges()
    for (let i = 0; i < 5; i++) {
      last().drop()
      vi.advanceTimersByTime(LIVE_BACKOFF_CAP_MS)
    }
    expect(sockets()).toHaveLength(6)
    last().open()
    vi.advanceTimersByTime(LIVE_STABLE_MS) // stayed open long enough: the backoff resets
    last().drop()
    vi.advanceTimersByTime(999)
    expect(sockets()).toHaveLength(6)
    vi.advanceTimersByTime(1)
    expect(sockets()).toHaveLength(7)
  })

  it('does not reset when a socket opens and closes before 60 s', () => {
    random = 1
    startLiveChanges()
    last().drop() // attempt 0 -> 1 s
    vi.advanceTimersByTime(1000)
    last().open()
    vi.advanceTimersByTime(LIVE_STABLE_MS - 1)
    last().drop() // closed 1 ms short of stable: the next delay is 2 s, not 1 s
    vi.advanceTimersByTime(1999)
    expect(sockets()).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(sockets()).toHaveLength(3)
  })

  it('a server that accepts then closes at once grows the backoff to the 5 min cap', () => {
    random = 1
    startLiveChanges()
    const delays = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000, 300000]
    for (const d of delays) {
      const n = sockets().length
      last().open() // accepted...
      last().drop() // ...and closed at once
      vi.advanceTimersByTime(d - 1)
      expect(sockets()).toHaveLength(n)
      vi.advanceTimersByTime(1)
      expect(sockets()).toHaveLength(n + 1)
    }
  })

  it('an error followed by a close schedules ONE retry', () => {
    random = 1
    startLiveChanges()
    last().drop() // fires onerror and onclose
    vi.advanceTimersByTime(1000)
    expect(sockets()).toHaveLength(2)
    vi.advanceTimersByTime(60_000 * 4)
    // the second socket never errored: no stray extra attempts
    expect(sockets()).toHaveLength(2)
  })

  it('does not retry while hidden or idle, and the pending retry is cancelled on hide', () => {
    random = 1
    startLiveChanges()
    last().drop()
    setVisibility('hidden')
    vi.advanceTimersByTime(LIVE_BACKOFF_CAP_MS)
    expect(sockets()).toHaveLength(1)
  })

  it('does not retry while idle either (no input for 2 h): no timer reopens the socket', () => {
    random = 1
    startLiveChanges()
    last().drop() // a retry is pending in 1 s
    vi.setSystemTime(B0 + LIVE_IDLE_MS + 1) // the retry's timer is still armed, but the tab is now idle
    vi.advanceTimersByTime(LIVE_BACKOFF_CAP_MS)
    expect(sockets()).toHaveLength(1)
    input() // input brings it back
    expect(sockets()).toHaveLength(2)
  })

  it('hidden then visible during a backoff waits out the rest of it instead of opening at once', () => {
    random = 1
    startLiveChanges()
    for (let i = 0; i < 6; i++) {
      last().drop() // refused upgrades: the delays grow 1, 2, 4, 8, 16, 32 s
      vi.advanceTimersByTime(liveBackoffMs(i, 1))
    }
    expect(sockets()).toHaveLength(7)
    last().drop() // the 7th failure: next retry in 64 s
    setVisibility('hidden')
    vi.advanceTimersByTime(5_000)
    setVisibility('visible')
    expect(sockets()).toHaveLength(7) // not opened straight away
    vi.advanceTimersByTime(58_000)
    expect(sockets()).toHaveLength(7)
    vi.advanceTimersByTime(2_000)
    expect(sockets()).toHaveLength(8) // 64 s after the failure
  })

  it('hidden for longer than the backoff, then visible: opens at once', () => {
    random = 1
    startLiveChanges()
    last().drop()
    setVisibility('hidden')
    vi.advanceTimersByTime(60_000)
    setVisibility('visible')
    expect(sockets()).toHaveLength(2)
  })
})

describe('fail-soft', () => {
  it('a WebSocket constructor that throws is swallowed, retried with backoff, and recovers', () => {
    random = 1
    let throwing = true
    class Throwing {
      constructor(url: string) {
        if (throwing) throw new Error('SecurityError')
        return new FakeWebSocket(url) as never
      }
    }
    vi.stubGlobal('WebSocket', Throwing)
    expect(() => startLiveChanges()).not.toThrow()
    expect(sockets()).toHaveLength(0)
    vi.advanceTimersByTime(1000)
    expect(sockets()).toHaveLength(0) // retried, threw again, swallowed
    throwing = false
    vi.advanceTimersByTime(2000)
    expect(sockets()).toHaveLength(1)
    // and it still works once connected
    const cb = vi.fn()
    onLiveChange(cb)
    last().open()
    last().message(LIVE_CHANGED_TEXT)
    vi.advanceTimersByTime(LIVE_BOUNDARY_MS)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('a constructor that always throws never throws out of any entry point', () => {
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor() {
          throw new Error('nope')
        }
      },
    )
    expect(() => {
      startLiveChanges()
      input()
      setVisibility('hidden')
      setVisibility('visible')
      vi.advanceTimersByTime(LIVE_IDLE_MS * 2)
    }).not.toThrow()
  })

  it('a message handler that sees a throwing getter on the event does not break the socket', () => {
    const s = startOpen()
    expect(() => s.onmessage?.({ get data(): unknown { throw new Error('x') } })).not.toThrow()
  })

  it('a socket that is closed while still connecting (never opened) cannot revive anything', () => {
    startLiveChanges() // connecting: no open() yet
    const s = last()
    expect(s.readyState).toBe(0)
    setVisibility('hidden')
    expect(s.closed).toBe(true)
    // late events from the closed socket: handlers were detached
    expect(s.onopen).toBeNull()
    expect(s.onmessage).toBeNull()
    expect(s.onclose).toBeNull()
    // the same events delivered anyway (a late handshake, a message, a drop) change nothing
    const cb = vi.fn()
    onLiveChange(cb)
    s.onopen?.()
    s.onmessage?.({ data: LIVE_CHANGED_TEXT })
    s.drop()
    vi.advanceTimersByTime(LIVE_BACKOFF_CAP_MS)
    expect(cb).not.toHaveBeenCalled()
    expect(sockets()).toHaveLength(1)
  })
})
