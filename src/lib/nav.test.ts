import { describe, expect, it } from 'vitest'
import { drillChildren, drillTrail, parentOf, rootOf } from './nav'
import type { DashboardPage, GlobalFilters } from '../types'

const f = (over: Partial<GlobalFilters> = {}): GlobalFilters => ({
  siteSel: [],
  since: '2026-09-01T00:00:00.000Z',
  until: '2026-09-08T00:00:00.000Z',
  rangeRel: '7d',
  excludeSelfReferrals: true,
  excludeOwnVisits: true,
  ownBrowser: '',
  ownOS: '',
  ...over,
})
const page = (id: string, over: Partial<DashboardPage> = {}): DashboardPage => ({ id, name: id, isDefault: false, group: 'Mine', filters: f(), widgets: [], ...over })
const label = (t: string) => `<${t}>`

describe('drill tree helpers', () => {
  const pages = [page('default', { isDefault: true }), page('t'), page('k1', { parentId: 't' }), page('k2', { parentId: 't' }), page('stale', { parentId: 'gone' })]
  it('parentOf / rootOf follow a drill page to its root; a root (or a stale link) is its own root', () => {
    expect(parentOf(pages[2], pages)?.id).toBe('t')
    expect(rootOf(pages[2], pages).id).toBe('t')
    expect(rootOf(pages[1], pages).id).toBe('t')
    expect(parentOf(pages[4], pages)).toBeUndefined()
    expect(rootOf(pages[4], pages).id).toBe('stale')
  })
  it('drillChildren lists a root\'s drill pages in array order', () => {
    expect(drillChildren('t', pages).map((p) => p.id)).toEqual(['k1', 'k2'])
    expect(drillChildren('default', pages)).toEqual([])
  })
})

describe('drillTrail (a drill page\'s name)', () => {
  const mobile = { key: 'device', value: 'mobile', label: 'mobile' }
  const de = { key: 'country', value: 'DE', label: 'Germany' }
  it('names a first drill by its value alone — the root\'s own site pick is not repeated', () => {
    const root = f({ siteSel: ['bestsudoku', 'bestsudoku-app'] })
    expect(drillTrail(f({ siteSel: ['bestsudoku', 'bestsudoku-app'], drill: [mobile] }), root, label)).toBe('mobile')
  })
  it('a drill from a drill page carries the trail forward, joined with " › "', () => {
    expect(drillTrail(f({ drill: [mobile, de] }), f(), label)).toBe('mobile › Germany')
  })
  it('a drill that replaces a constraint on the same dimension shows only the new value', () => {
    expect(drillTrail(f({ drill: [de, { key: 'device', value: 'desktop', label: 'desktop' }] }), f(), label)).toBe('Germany › desktop')
  })
  it('a site drill names the site (or the count of sites)', () => {
    expect(drillTrail(f({ siteSel: ['stats.goodstuff.software'] }), f(), label)).toBe('<stats.goodstuff.software>')
    expect(drillTrail(f({ siteSel: ['a', 'b'], drill: [mobile] }), f(), label)).toBe('2 sites › mobile')
  })
  it('a date drill ends with the day; a later drill from it keeps the date range', () => {
    const day = f({ drill: [mobile], since: '2026-09-28T00:00:00.000Z', until: '2026-09-28T23:59:59.999Z', rangeRel: '' })
    expect(drillTrail(day, f(), label, 'Sep 28')).toBe('mobile › Sep 28')
    expect(drillTrail({ ...day, drill: [mobile, de] }, f(), label)).toBe('mobile › Germany › Sep 28 – Sep 28')
  })
  it('an absolute root range copied unchanged is not a date part', () => {
    const root = f({ since: '2026-01-01T00:00:00.000Z', rangeRel: '' })
    expect(drillTrail({ ...root, drill: [mobile] }, root, label)).toBe('mobile')
  })
  it('"Filtered" when nothing differs from the root', () => {
    expect(drillTrail(f(), f(), label)).toBe('Filtered')
  })
})
