// Per-viewer navigation state lives in this browser's localStorage, never in the shared config, keyed to the
// signed-in login — and the dashboard must work the same when storage is missing, blocked, full or holds junk.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VIEWER_PREFS_KEY, initialPageId, readViewerPrefs, writeViewerPrefs, setViewerLogin, viewerPrefsKey } from './viewerPrefs'
import { hash53, loginKey } from './loginStorage'
import type { DashboardPage } from '../types'

function memoryStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    map: m,
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  setViewerLogin(null)
})

const page = (id: string, isDefault = false): DashboardPage => ({ id, name: id, isDefault, group: 'Mine', filters: {} as any, widgets: [] })

const A = 'ann@example.com'
const B = 'bob@example.com'
const keyA = viewerPrefsKey(A)!
const keyB = viewerPrefsKey(B)!

describe('readViewerPrefs / writeViewerPrefs', () => {
  it('round-trips the active page, the last page per group and the collapsed groups, under the login key', () => {
    const s = memoryStorage()
    vi.stubGlobal('localStorage', s)
    setViewerLogin(A)
    writeViewerPrefs({ active: 'bsk-launch', lastByGroup: { 'Best Sudoku': 'bsk-launch' }, collapsed: ['Mine'] })
    expect(JSON.parse(s.map.get(keyA)!)).toEqual({ active: 'bsk-launch', lastByGroup: { 'Best Sudoku': 'bsk-launch' }, collapsed: ['Mine'] })
    expect(readViewerPrefs()).toEqual({ active: 'bsk-launch', lastByGroup: { 'Best Sudoku': 'bsk-launch' }, collapsed: ['Mine'] })
  })

  it('keys by a hash of the lower-cased address: no address in any key or value, case ignored', () => {
    const s = memoryStorage()
    vi.stubGlobal('localStorage', s)
    expect(keyA).toMatch(/^gss-stats-nav:[0-9a-f]{14}$/)
    expect(viewerPrefsKey(' Ann@Example.COM ')).toBe(keyA)
    expect(keyA).not.toBe(keyB)
    setViewerLogin(A)
    writeViewerPrefs({ active: 'x' })
    expect([...s.map.keys(), ...s.map.values()].join('|')).not.toMatch(/example\.com|ann/i)
  })

  it('keeps two logins on one browser apart', () => {
    vi.stubGlobal('localStorage', memoryStorage())
    setViewerLogin(A)
    writeViewerPrefs({ active: 'a-page', collapsed: ['Mine'] })
    setViewerLogin(B)
    expect(readViewerPrefs()).toEqual({})
    writeViewerPrefs({ active: 'b-page' })
    setViewerLogin(A)
    expect(readViewerPrefs()).toEqual({ active: 'a-page', collapsed: ['Mine'] })
    setViewerLogin(B)
    expect(readViewerPrefs()).toEqual({ active: 'b-page' })
  })

  it('reads and writes nothing while signed out', () => {
    const start = { [keyA]: JSON.stringify({ active: 'a-page' }), [VIEWER_PREFS_KEY]: JSON.stringify({ active: 'old' }) }
    const s = memoryStorage(start)
    vi.stubGlobal('localStorage', s)
    setViewerLogin(null)
    expect(readViewerPrefs()).toEqual({})
    writeViewerPrefs({ active: 'new' })
    setViewerLogin('   ')
    expect(readViewerPrefs()).toEqual({})
    writeViewerPrefs({ active: 'new' })
    expect(Object.fromEntries(s.map)).toEqual(start)
  })

  it('the first login with no state of its own adopts the legacy value, which is then removed', () => {
    const s = memoryStorage({ [VIEWER_PREFS_KEY]: JSON.stringify({ active: 'old-page', collapsed: ['Mine'] }) })
    vi.stubGlobal('localStorage', s)
    setViewerLogin(A)
    expect(readViewerPrefs()).toEqual({ active: 'old-page', collapsed: ['Mine'] })
    expect(s.map.has(VIEWER_PREFS_KEY)).toBe(false)
    setViewerLogin(B) // nothing left to adopt
    expect(readViewerPrefs()).toEqual({})
  })

  it('a login with state of its own neither adopts nor removes the legacy value', () => {
    const legacy = JSON.stringify({ active: 'old-page' })
    const s = memoryStorage({ [VIEWER_PREFS_KEY]: legacy, [keyA]: JSON.stringify({ active: 'mine' }) })
    vi.stubGlobal('localStorage', s)
    setViewerLogin(A)
    expect(readViewerPrefs()).toEqual({ active: 'mine' })
    expect(s.map.get(VIEWER_PREFS_KEY)).toBe(legacy)
    setViewerLogin(B) // B has none: the legacy value is still there for B to adopt
    expect(readViewerPrefs()).toEqual({ active: 'old-page' })
  })

  it('reads nothing and never throws when storage is missing or throws', () => {
    setViewerLogin(A)
    vi.stubGlobal('localStorage', undefined)
    expect(readViewerPrefs()).toEqual({})
    expect(() => writeViewerPrefs({ active: 'x' })).not.toThrow()
    expect(() => setViewerLogin(A)).not.toThrow()

    const boom = () => {
      throw new Error('SecurityError')
    }
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom })
    expect(() => setViewerLogin(A)).not.toThrow()
    expect(readViewerPrefs()).toEqual({})
    expect(() => writeViewerPrefs({ active: 'x' })).not.toThrow()

    // a legacy value is left alone when the copy fails
    const failing = memoryStorage({ [VIEWER_PREFS_KEY]: '{"active":"old"}' })
    vi.stubGlobal('localStorage', { ...failing, setItem: boom })
    expect(() => setViewerLogin(A)).not.toThrow()
    expect(failing.map.get(VIEWER_PREFS_KEY)).toBe('{"active":"old"}')

    // even touching the localStorage global throws (site data blocked)
    vi.unstubAllGlobals()
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: boom })
    expect(() => setViewerLogin(A)).not.toThrow()
    expect(readViewerPrefs()).toEqual({})
    expect(() => writeViewerPrefs({ active: 'x' })).not.toThrow()
    delete (globalThis as any).localStorage
  })

  it('reads nothing from junk', () => {
    setViewerLogin(A)
    for (const junk of ['{not json', '"a string"', '[1,2]', 'null', JSON.stringify({ active: 5, lastByGroup: [1], collapsed: 'Mine' })]) {
      vi.stubGlobal('localStorage', memoryStorage({ [keyA]: junk }))
      expect(readViewerPrefs(), junk).toEqual({})
    }
  })

  it('drops malformed entries field by field', () => {
    setViewerLogin(A)
    vi.stubGlobal('localStorage', memoryStorage({ [keyA]: JSON.stringify({ active: 'ok', lastByGroup: { A: 'p1', B: 3, '': 'x' }, collapsed: ['Mine', 4, ''] }) }))
    expect(readViewerPrefs()).toEqual({ active: 'ok', lastByGroup: { A: 'p1' }, collapsed: ['Mine'] })
  })
})

describe('loginKey (shared with the Budget panel key)', () => {
  it('is cyrb53 of the trimmed, lower-cased address, the hash behind the Budget section panelsKey', () => {
    expect(loginKey('gss-stats-budget-panels', ' Ann@Example.com')).toBe('gss-stats-budget-panels:' + hash53('ann@example.com'))
    expect(hash53('ann@example.com')).toMatch(/^[0-9a-f]{14}$/)
    expect(loginKey('p', null)).toBeNull()
    expect(loginKey('p', '  ')).toBeNull()
  })
})

describe('initialPageId', () => {
  const pages = [page('default', true), page('beacon'), page('bsk-launch')]
  it('the page this viewer was on, when it still exists', () => {
    expect(initialPageId(pages, { active: 'bsk-launch' }, 'default')).toBe('bsk-launch')
  })
  it('a first-time viewer lands on the config landing page (★ Overview)', () => {
    expect(initialPageId(pages, {}, 'default')).toBe('default')
  })
  it('a remembered page that was deleted falls back to the landing page, then the default page', () => {
    expect(initialPageId(pages, { active: 'gone' }, 'beacon')).toBe('beacon')
    expect(initialPageId(pages, { active: 'gone' }, 'also-gone')).toBe('default')
    expect(initialPageId([page('a'), page('b')], {}, 'x')).toBe('a')
  })
})
