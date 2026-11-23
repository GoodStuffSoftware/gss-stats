// The toolbar's per-login cache and debounced saver (fake timers via an injected scheduler).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPrefsSaver, fetchServerPrefs, putServerPrefs, readCachedPrefs, TXN_PREFS_PREFIX, writeCachedPrefs } from './txnPrefsStore'
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
})
