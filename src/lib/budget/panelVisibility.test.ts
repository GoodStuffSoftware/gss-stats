import { describe, expect, it } from 'vitest'
import { DONUT_KEY_PREFIX, LAYOUT_KEY, LEGEND_KEY_PREFIX, canHide, donutSizeKey, legendSideKey, panelsKey, readDesktopLayout, readHiddenPanels, readLegendSide, writeLegendSide, togglePanel, writeDesktopLayout, writeHiddenPanels, type PanelStorage } from './panelVisibility'

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

describe('readDesktopLayout / writeDesktopLayout', () => {
  it('defaults to side by side', () => {
    expect(readDesktopLayout(memory())).toBe('side')
    expect(readDesktopLayout(null)).toBe('side')
  })
  it('round-trips tabs and side, one key for the device', () => {
    const s = memory()
    writeDesktopLayout('tabs', s)
    expect(s.data.get(LAYOUT_KEY)).toBe('tabs')
    expect(readDesktopLayout(s)).toBe('tabs')
    writeDesktopLayout('side', s)
    expect(readDesktopLayout(s)).toBe('side')
  })
  it('reads an unknown value as side by side', () => {
    const s = memory()
    s.setItem(LAYOUT_KEY, 'grid')
    expect(readDesktopLayout(s)).toBe('side')
  })
  it('never throws when storage is blocked', () => {
    expect(readDesktopLayout(throwing)).toBe('side')
    expect(() => writeDesktopLayout('tabs', throwing)).not.toThrow()
  })
})

describe('donutSizeKey', () => {
  it('gives each chart and each mode its own key, shared by nobody else', () => {
    const keys = [donutSizeKey('spending', true), donutSizeKey('spending', false), donutSizeKey('debts', true), donutSizeKey('debts', false)]
    expect(new Set(keys).size).toBe(4)
    expect(keys[0]).toBe(`${DONUT_KEY_PREFIX}:spending:solo`)
    expect(keys[3]).toBe(`${DONUT_KEY_PREFIX}:debts:split`)
    // not the per-account panel key and not the layout key
    for (const k of keys) expect([LAYOUT_KEY, panelsKey('a@b.c')]).not.toContain(k)
  })
})

describe('legend side', () => {
  it('has a key per chart that holds no personal data, apart from the donut and layout keys', () => {
    expect(legendSideKey('spending')).toBe(`${LEGEND_KEY_PREFIX}:spending`)
    expect(legendSideKey('debts')).not.toBe(legendSideKey('spending'))
    for (const k of [legendSideKey('spending'), legendSideKey('debts')]) expect(k).not.toMatch(/@/)
    expect([LAYOUT_KEY, donutSizeKey('spending', true), donutSizeKey('spending', false)]).not.toContain(legendSideKey('spending'))
  })
  it('reads right when nothing is saved or the saved value is invalid, and each chart on its own', () => {
    const s = memory()
    expect(readLegendSide('spending', s)).toBe('right')
    expect(readLegendSide('spending', null)).toBe('right')
    s.setItem(legendSideKey('spending'), 'sideways')
    expect(readLegendSide('spending', s)).toBe('right')
    writeLegendSide('spending', 'left', s)
    writeLegendSide('debts', 'bottom', s)
    expect(readLegendSide('spending', s)).toBe('left')
    expect(readLegendSide('debts', s)).toBe('bottom')
    writeLegendSide('spending', 'right', s)
    expect(readLegendSide('spending', s)).toBe('right')
  })
  it('never throws when storage is blocked', () => {
    expect(readLegendSide('debts', throwing)).toBe('right')
    expect(() => writeLegendSide('debts', 'left', throwing)).not.toThrow()
  })
})
