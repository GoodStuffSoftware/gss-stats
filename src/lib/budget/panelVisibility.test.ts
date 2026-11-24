import { describe, expect, it } from 'vitest'
import { DONUT_KEY_PREFIX, LAYOUT_KEY, LEGEND_KEY_PREFIX, donutSizeKey, legendSideKey, migrateLegacyTab, panelsKey, readLegendSide, writeLegendSide, type PanelStorage } from './panelVisibility'

function memory(): PanelStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) }
}
const throwing: PanelStorage = {
  getItem() {
    throw new Error('blocked')
  },
  setItem() {
    throw new Error('quota')
  },
  removeItem() {
    throw new Error('blocked')
  },
}
const EMAIL = 'a@example.com'

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

describe('donutSizeKey', () => {
  it('shares one key in Both and keeps one per chart when shown alone', () => {
    expect(donutSizeKey('spending', true)).toBe(donutSizeKey('debts', true))
    expect(donutSizeKey('spending', true)).toBe(`${DONUT_KEY_PREFIX}:both`)
    expect(donutSizeKey('spending', false)).toBe(`${DONUT_KEY_PREFIX}:spending:solo`)
    expect(donutSizeKey('debts', false)).toBe(`${DONUT_KEY_PREFIX}:debts:solo`)
    expect(donutSizeKey('spending', false)).not.toBe(donutSizeKey('debts', false))
  })
  it('holds no personal data', () => {
    for (const key of [donutSizeKey('spending', true), donutSizeKey('debts', false)]) expect(key).not.toMatch(/[@\d]{4,}/)
  })
})

describe('migrateLegacyTab', () => {
  it('hiding Spending is the Debts tab, hiding Debts is the Spending tab', () => {
    const a = memory()
    a.setItem(panelsKey(EMAIL), JSON.stringify({ hidden: ['spending'] }))
    expect(migrateLegacyTab(EMAIL, a).tab).toBe('debts')
    const b = memory()
    b.setItem(panelsKey(EMAIL), JSON.stringify({ hidden: ['debts'] }))
    expect(migrateLegacyTab(EMAIL, b).tab).toBe('spending')
  })
  it('Side by side is Both (and is reported on its own), a hidden chart wins over it', () => {
    const a = memory()
    a.setItem(LAYOUT_KEY, 'side')
    expect(migrateLegacyTab(EMAIL, a)).toEqual({ tab: 'both', side: true })
    const b = memory()
    b.setItem(LAYOUT_KEY, 'side')
    b.setItem(panelsKey(EMAIL), JSON.stringify({ hidden: ['debts'] }))
    expect(migrateLegacyTab(EMAIL, b)).toEqual({ tab: 'spending', side: true })
  })
  it('a missing layout key was Side by side in 0.82.0: no tab of its own, but reported as side', () => {
    expect(migrateLegacyTab(EMAIL, memory())).toEqual({ tab: null, side: true })
  })
  it('tabs, or both hidden, is no opinion', () => {
    const a = memory()
    a.setItem(LAYOUT_KEY, 'tabs')
    expect(migrateLegacyTab(EMAIL, a)).toEqual({ tab: null, side: false })
    const b = memory()
    b.setItem(panelsKey(EMAIL), JSON.stringify({ hidden: ['spending', 'debts'] }))
    expect(migrateLegacyTab(EMAIL, b).tab).toBeNull()
  })
  it('only reads this account\'s Show key', () => {
    const a = memory()
    a.setItem(panelsKey('other@example.com'), JSON.stringify({ hidden: ['spending'] }))
    expect(migrateLegacyTab(EMAIL, a).tab).toBeNull()
  })
  it('removes the old keys (so it runs once) and moves the split donut size to the Both key', () => {
    const a = memory()
    a.setItem(LAYOUT_KEY, 'side')
    a.setItem(panelsKey(EMAIL), JSON.stringify({ hidden: [] }))
    a.setItem(`${DONUT_KEY_PREFIX}:spending:split`, '320')
    a.setItem(`${DONUT_KEY_PREFIX}:debts:split`, '280')
    a.setItem(`${DONUT_KEY_PREFIX}:spending:solo`, '400')
    migrateLegacyTab(EMAIL, a)
    expect([...a.data.keys()].sort()).toEqual([`${DONUT_KEY_PREFIX}:both`, `${DONUT_KEY_PREFIX}:spending:solo`].sort())
    expect(a.data.get(`${DONUT_KEY_PREFIX}:both`)).toBe('320')
    expect(migrateLegacyTab(EMAIL, a).tab).toBeNull()
  })
  it('keeps a Both size that already exists', () => {
    const a = memory()
    a.setItem(`${DONUT_KEY_PREFIX}:both`, '350')
    a.setItem(`${DONUT_KEY_PREFIX}:debts:split`, '280')
    migrateLegacyTab(EMAIL, a)
    expect(a.data.get(`${DONUT_KEY_PREFIX}:both`)).toBe('350')
  })
  it('treats a damaged Show value as nothing hidden', () => {
    const a = memory()
    a.setItem(panelsKey(EMAIL), '{not json')
    expect(migrateLegacyTab(EMAIL, a).tab).toBeNull()
    a.setItem(panelsKey(EMAIL), '[1,2]')
    expect(migrateLegacyTab(EMAIL, a).tab).toBeNull()
  })
  it('never throws when storage is missing or blocked', () => {
    expect(migrateLegacyTab(EMAIL, null)).toEqual({ tab: null, side: false })
    expect(migrateLegacyTab(EMAIL, throwing).tab).toBeNull()
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
