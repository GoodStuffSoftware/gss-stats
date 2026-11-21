import { describe, expect, it } from 'vitest'
import { canHide, panelsKey, readHiddenPanels, togglePanel, writeHiddenPanels, type PanelStorage } from './panelVisibility'

function memory(): PanelStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}
const throwing: PanelStorage = {
  getItem() {
    throw new Error('blocked')
  },
  setItem() {
    throw new Error('quota')
  },
}

describe('panelsKey', () => {
  it('is per account, case-insensitive, and never holds the address', () => {
    const a = panelsKey('a@example.com')
    expect(a).toBe(panelsKey(' A@Example.com '))
    expect(a).not.toBe(panelsKey('b@example.com'))
    expect(a).not.toContain('example')
    expect(a).not.toContain('@')
    expect(panelsKey('')).toBe(panelsKey(null))
    expect(panelsKey(undefined)).toMatch(/:anon$/)
  })
})

describe('readHiddenPanels / writeHiddenPanels', () => {
  it('defaults to both shown', () => {
    expect(readHiddenPanels('a@example.com', memory())).toEqual([])
  })
  it('round-trips, separately for two accounts', () => {
    const s = memory()
    writeHiddenPanels('a@example.com', ['debts'], s)
    writeHiddenPanels('b@example.com', ['spending'], s)
    expect(readHiddenPanels('a@example.com', s)).toEqual(['debts'])
    expect(readHiddenPanels('b@example.com', s)).toEqual(['spending'])
    expect(readHiddenPanels('c@example.com', s)).toEqual([])
  })
  it('reads nothing hidden when storage throws, and does not throw on write', () => {
    expect(readHiddenPanels('a@example.com', throwing)).toEqual([])
    expect(() => writeHiddenPanels('a@example.com', ['debts'], throwing)).not.toThrow()
  })
  it('reads nothing hidden when there is no storage at all', () => {
    expect(readHiddenPanels('a@example.com', null)).toEqual([])
    expect(() => writeHiddenPanels('a@example.com', ['debts'], null)).not.toThrow()
  })
  it('treats malformed values as nothing hidden', () => {
    const s = memory()
    const key = panelsKey('a@example.com')
    for (const bad of ['not json', 'null', '[]', '{"hidden":"debts"}', '{"hidden":[1,"nope"]}']) {
      s.data.set(key, bad)
      expect(readHiddenPanels('a@example.com', s), bad).toEqual([])
    }
  })
  it('drops unknown ids and never returns both hidden', () => {
    const s = memory()
    const key = panelsKey('a@example.com')
    s.data.set(key, '{"hidden":["debts","bogus"]}')
    expect(readHiddenPanels('a@example.com', s)).toEqual(['debts'])
    s.data.set(key, '{"hidden":["spending","debts"]}')
    expect(readHiddenPanels('a@example.com', s)).toEqual([])
  })
})

describe('togglePanel / canHide', () => {
  it('hides one chart, and brings it back', () => {
    expect(togglePanel([], 'debts')).toEqual(['debts'])
    expect(togglePanel(['debts'], 'debts')).toEqual([])
  })
  it('refuses to hide the last chart shown', () => {
    expect(canHide(['debts'], 'spending')).toBe(false)
    expect(togglePanel(['debts'], 'spending')).toEqual(['debts'])
    expect(canHide([], 'spending')).toBe(true)
  })
})
