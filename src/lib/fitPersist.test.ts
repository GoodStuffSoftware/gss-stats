import { describe, expect, it } from 'vitest'
import { packVertically, storedForm, syncFitBase, type FitBase } from './fitPersist'
import type { DashboardConfig, Widget } from '../types'

const w = (id: string, x: number, y: number, ww: number, h: number, fit = false): Widget =>
  ({ id, i: id, title: id, type: 'note', dimension: '', metric: 'pageviews', limit: 10, x, y, w: ww, h, card: { preset: 'x' }, ...(fit ? { fit: 'content' } : {}) }) as unknown as Widget
const cfg = (...widgets: Widget[]): DashboardConfig =>
  ({ version: 19, activePageId: 'p', pages: [{ id: 'p', name: 'P', isDefault: false, group: 'g', widgets }] }) as unknown as DashboardConfig

describe('packVertically', () => {
  it('closes gaps and moves a card down past what it collides with, like the grid does', () => {
    const out = packVertically([w('a', 0, 0, 12, 6), w('b', 0, 3, 12, 4), w('c', 0, 20, 12, 2)])
    expect(out.map((x) => [x.id, x.y])).toEqual([['a', 0], ['b', 6], ['c', 10]])
  })
  it('keeps side-by-side cards side by side and leaves the input alone', () => {
    const input = [w('a', 0, 0, 6, 8), w('b', 6, 0, 6, 3), w('c', 6, 9, 6, 2)]
    const out = packVertically(input)
    expect(out.map((x) => x.y)).toEqual([0, 0, 3])
    expect(input[2].y).toBe(9)
  })
})

describe('syncFitBase / storedForm', () => {
  it('records a fit card at its loaded height; a later fitted height is not what is saved', () => {
    const c = cfg(w('top', 0, 0, 12, 6, true), w('below', 0, 6, 12, 4))
    const base: FitBase = new Map()
    syncFitBase(base, c)
    expect(base.get('p/top')).toBe(6)
    c.pages[0].widgets[0].h = 12 // fitted on a narrow screen
    c.pages[0].widgets[1].y = 12 // pushed down by the grid
    syncFitBase(base, c)
    const saved = storedForm(c, base).pages[0].widgets
    expect(saved.map((x) => [x.h, x.y])).toEqual([[6, 0], [4, 6]])
    expect(c.pages[0].widgets[0].h).toBe(12) // the live config is untouched
  })
  it('a page with no fit card is returned as it is', () => {
    const c = cfg(w('a', 0, 0, 12, 4), w('b', 0, 9, 12, 4))
    const base: FitBase = new Map()
    syncFitBase(base, c)
    expect(storedForm(c, base)).toBe(c)
  })
  it('a card that stops being a fit card, or goes away, is forgotten', () => {
    const c = cfg(w('top', 0, 0, 12, 6, true))
    const base: FitBase = new Map()
    syncFitBase(base, c)
    delete (c.pages[0].widgets[0] as Widget).fit
    syncFitBase(base, c)
    expect(base.size).toBe(0)
  })
})
