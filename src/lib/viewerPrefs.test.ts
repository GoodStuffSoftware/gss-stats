// Per-viewer navigation state lives in this browser's localStorage, never in the shared config —
// and the dashboard must work the same when storage is missing, blocked, full or holds junk.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VIEWER_PREFS_KEY, initialPageId, readViewerPrefs, writeViewerPrefs } from './viewerPrefs'
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
afterEach(() => vi.unstubAllGlobals())

const page = (id: string, isDefault = false): DashboardPage => ({ id, name: id, isDefault, group: 'Mine', filters: {} as any, widgets: [] })

describe('readViewerPrefs / writeViewerPrefs', () => {
  it('round-trips the active page, the last page per group and the collapsed groups', () => {
    const s = memoryStorage()
    vi.stubGlobal('localStorage', s)
    writeViewerPrefs({ active: 'bsk-launch', lastByGroup: { 'Best Sudoku': 'bsk-launch' }, collapsed: ['Mine'] })
    expect(JSON.parse(s.map.get(VIEWER_PREFS_KEY)!)).toEqual({ active: 'bsk-launch', lastByGroup: { 'Best Sudoku': 'bsk-launch' }, collapsed: ['Mine'] })
    expect(readViewerPrefs()).toEqual({ active: 'bsk-launch', lastByGroup: { 'Best Sudoku': 'bsk-launch' }, collapsed: ['Mine'] })
  })

  it('reads nothing (never throws) when storage is missing, throws, or holds junk', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(readViewerPrefs()).toEqual({})
    expect(() => writeViewerPrefs({ active: 'x' })).not.toThrow()

    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    expect(readViewerPrefs()).toEqual({})
    expect(() => writeViewerPrefs({ active: 'x' })).not.toThrow()

    for (const junk of ['{not json', '"a string"', '[1,2]', 'null', JSON.stringify({ active: 5, lastByGroup: [1], collapsed: 'Mine' })]) {
      vi.stubGlobal('localStorage', memoryStorage({ [VIEWER_PREFS_KEY]: junk }))
      expect(readViewerPrefs(), junk).toEqual({})
    }
  })

  it('drops malformed entries field by field', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [VIEWER_PREFS_KEY]: JSON.stringify({ active: 'ok', lastByGroup: { A: 'p1', B: 3, '': 'x' }, collapsed: ['Mine', 4, ''] }) }))
    expect(readViewerPrefs()).toEqual({ active: 'ok', lastByGroup: { A: 'p1' }, collapsed: ['Mine'] })
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
