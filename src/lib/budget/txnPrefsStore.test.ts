// @vitest-environment happy-dom
// The toolbar's per-login cache and debounced saver (fake timers via an injected scheduler).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSavedView, sameSavedView, type SavedView } from './savedView'
import { createPrefsSaver, fetchServerPrefs, fetchServerView, putServerPrefs, putServerView, readCachedPrefs, TXN_PREFS_PREFIX, VIEW_SAVE_DELAY_MS, writeCachedPrefs } from './txnPrefsStore'
import { defaultTxnViewPrefs, type TxnViewPrefs } from './txnView'
import { loginKey } from '../loginStorage'

const a: TxnViewPrefs = { ...defaultTxnViewPrefs(), search: 'milk' }
const b: TxnViewPrefs = { ...defaultTxnViewPrefs(), search: 'milk', categories: ['fun'] }

function fakeTimers() {
  let fn: (() => void) | null = null
  return {
    set: (f: () => void) => {
      fn = f
      return 1
    },
    clear: () => {
      fn = null
    },
    run: () => {
      const f = fn
      fn = null
      f?.()
    },
    pending: () => fn !== null,
  }
}

describe('local cache', () => {
  beforeEach(() => localStorage.clear())
  it('is keyed by a hash of the login, never the address, and separates logins', () => {
    writeCachedPrefs('One@Example.com', a)
    expect(readCachedPrefs('one@example.com')).toEqual(a)
    expect(readCachedPrefs('two@example.com')).toBeNull()
    const keys = Object.keys(localStorage)
    expect(keys).toEqual([loginKey(TXN_PREFS_PREFIX, 'one@example.com')])
    expect(keys[0]).not.toContain('example')
  })
  it('keeps nothing without a login and survives garbage', () => {
    writeCachedPrefs('', a)
    expect(localStorage.length).toBe(0)
    localStorage.setItem(loginKey(TXN_PREFS_PREFIX, 'x@example.com')!, '{not json')
    expect(readCachedPrefs('x@example.com')).toBeNull()
  })
})

describe('debounced saver', () => {
  it('sends once after the quiet period with the last value', async () => {
    const t = fakeTimers()
    const send = vi.fn(async () => true)
    const s = createPrefsSaver(send, 1500, t)
    s.setBaseline(defaultTxnViewPrefs())
    s.schedule(a)
    s.schedule(b)
    expect(send).not.toHaveBeenCalled()
    t.run()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(b)
  })
  it('sends nothing for a value equal to what the server holds, and not again after a good save', async () => {
    const t = fakeTimers()
    const send = vi.fn(async () => true)
    const s = createPrefsSaver(send, 1500, t)
    s.setBaseline(a)
    s.schedule({ ...a })
    expect(t.pending()).toBe(false)
    s.schedule(b)
    t.run()
    await Promise.resolve()
    await Promise.resolve()
    s.schedule({ ...b })
    expect(t.pending()).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('flush sends at once; cancel drops; a failed save is retried on the next change', async () => {
    const t = fakeTimers()
    const send = vi.fn(async () => false)
    const s = createPrefsSaver(send, 1500, t)
    s.setBaseline(defaultTxnViewPrefs())
    s.schedule(a)
    s.flush()
    expect(send).toHaveBeenCalledTimes(1)
    s.schedule(a)
    s.cancel()
    t.run()
    expect(send).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    s.schedule(a)
    expect(t.pending()).toBe(true)
  })
})

describe('failed saves', () => {
  it('reports each result, keeps the baseline on a failure and sends again on the next change', async () => {
    const t = fakeTimers()
    const results: boolean[] = []
    let ok = false
    const send = vi.fn(async () => ok)
    const s = createPrefsSaver(send, 1500, t, (r) => results.push(r))
    s.setBaseline(defaultTxnViewPrefs())
    s.schedule(a)
    t.run()
    await Promise.resolve()
    await Promise.resolve()
    expect(results).toEqual([false])
    ok = true
    s.schedule(a) // same value as the failed one: still sent, because the server never took it
    expect(t.pending()).toBe(true)
    t.run()
    await Promise.resolve()
    await Promise.resolve()
    expect(results).toEqual([false, true])
    s.schedule(a)
    expect(t.pending()).toBe(false)
  })
})

describe('saver for the saved view', () => {
  const v0 = defaultSavedView()
  const v1: SavedView = { ...v0, hidden: 'spending' }
  const settle = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }
  it('debounces to the last value, skips a value equal to the baseline, flushes at once', async () => {
    const t = fakeTimers()
    const send = vi.fn(async (_v: SavedView) => true)
    const s = createPrefsSaver<SavedView>(send, VIEW_SAVE_DELAY_MS, t, undefined, sameSavedView)
    expect(VIEW_SAVE_DELAY_MS).toBe(2000)
    s.setBaseline(v0)
    s.schedule({ ...v0, tab: 'debts' })
    s.schedule(v1)
    expect(send).not.toHaveBeenCalled()
    t.run()
    await settle()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith(v1)
    s.schedule({ ...v1, path: [] }) // equal by value to what the server now holds
    expect(t.pending()).toBe(false)
    s.schedule({ ...v1, review: true })
    s.flush()
    await settle()
    expect(send).toHaveBeenCalledTimes(2)
    expect(t.pending()).toBe(false)
  })
  it('a failed save keeps the baseline, so the same value is sent again on the next change', async () => {
    const t = fakeTimers()
    let ok = false
    const send = vi.fn(async (_v: SavedView) => ok)
    const s = createPrefsSaver<SavedView>(send, VIEW_SAVE_DELAY_MS, t, undefined, sameSavedView)
    s.setBaseline(v0)
    s.schedule(v1)
    t.run()
    await settle()
    ok = true
    s.schedule(v1)
    expect(t.pending()).toBe(true)
    t.run()
    await settle()
    expect(send).toHaveBeenCalledTimes(2)
    s.schedule(v1)
    expect(t.pending()).toBe(false)
  })
})

describe('server calls', () => {
  it('GET reads txnView; failures read as nothing saved', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ txnView: b }), { status: 200 })) as unknown as typeof fetch
    expect(await fetchServerPrefs(ok)).toEqual(b)
    expect(await fetchServerPrefs((async () => new Response('{}', { status: 200 })) as unknown as typeof fetch)).toBeNull()
    expect(await fetchServerPrefs((async () => new Response('{}', { status: 403 })) as unknown as typeof fetch)).toBeNull()
    expect(await fetchServerPrefs((async () => { throw new Error('offline') }) as unknown as typeof fetch)).toBeNull()
  })
  it('PUT posts only { txnView } to the prefs route', async () => {
    const f = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    expect(await putServerPrefs(a, f as unknown as typeof fetch)).toBe(true)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/budget/prefs')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ txnView: a })
    expect(await putServerPrefs(a, (async () => { throw new Error('x') }) as unknown as typeof fetch)).toBe(false)
  })
  it('the view GET tells a failed read from nothing saved, and reads the block leniently', async () => {
    const saved = { ...defaultSavedView(), hidden: 'debts' as const, tab: 'debts' as const }
    const got = await fetchServerView((async () => new Response(JSON.stringify({ txnView: b, view: saved }), { status: 200 })) as unknown as typeof fetch)
    expect(got).toEqual({ ok: true, view: saved })
    expect(await fetchServerView((async () => new Response('{}', { status: 200 })) as unknown as typeof fetch)).toEqual({ ok: true, view: null })
    expect(await fetchServerView((async () => new Response('{}', { status: 403 })) as unknown as typeof fetch)).toEqual({ ok: false, view: null })
    expect(await fetchServerView((async () => { throw new Error('offline') }) as unknown as typeof fetch)).toEqual({ ok: false, view: null })
  })
  it('the view PUT posts only { view } with keepalive, and never throws', async () => {
    const f = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    const v = { ...defaultSavedView(), review: true }
    expect(await putServerView(v, f as unknown as typeof fetch)).toBe(true)
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/budget/prefs')
    expect(init.method).toBe('PUT')
    expect(init.keepalive).toBe(true)
    expect(JSON.parse(init.body as string)).toEqual({ view: v })
    expect(await putServerView(v, (async () => new Response('{}', { status: 413 })) as unknown as typeof fetch)).toBe(false)
    expect(await putServerView(v, (async () => { throw new Error('x') }) as unknown as typeof fetch)).toBe(false)
  })
})
