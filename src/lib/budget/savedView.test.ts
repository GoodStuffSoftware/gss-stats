// The saved view schema: strict (the server) and lenient (the browser) reads, the size bound and the fit fallback.
// All values are made up.
import { describe, expect, it } from 'vitest'
import { defaultSavedView, fitSavedView, parseSavedView, sameSavedView, savedViewBytes, VIEW_BYTES_MAX, type SavedView } from './savedView'

const full: SavedView = {
  hidden: 'spending',
  tab: 'debts',
  page: 'loans',
  path: [
    { level: 'category', key: 'fun', label: 'Fun' },
    { level: 'merchant', key: 'acme', label: 'Acme' },
  ],
  groupBy: 'account',
  review: true,
  debt: 'acct-9',
  range: { preset: 'custom', from: '2026-03-01', to: '2026-03-31' },
  person: 'sam',
}

describe('parseSavedView strict', () => {
  it('accepts a full view and the default view unchanged', () => {
    expect(parseSavedView(full, true)).toEqual(full)
    expect(parseSavedView(defaultSavedView(), true)).toEqual(defaultSavedView())
  })
  it('refuses unknown or missing fields, non-objects and bad values', () => {
    expect(parseSavedView({ ...full, extra: 1 }, true)).toBeNull()
    const { person: _p, ...missing } = full
    expect(parseSavedView(missing, true)).toBeNull()
    for (const raw of [null, undefined, [], 'x', 3]) expect(parseSavedView(raw, true)).toBeNull()
    expect(parseSavedView({ ...full, hidden: 'both' }, true)).toBeNull()
    expect(parseSavedView({ ...full, debt: 'a b' }, true)).toBeNull()
    expect(parseSavedView({ ...full, range: { preset: 'custom', from: '2026-03-01' } }, true)).toBeNull()
    expect(parseSavedView({ ...full, path: [{ level: 'merchant', key: 'a', label: 'A' }] }, true)).toBeNull()
  })
})

describe('parseSavedView lenient', () => {
  it('a wrong field takes its default, the rest is kept', () => {
    const got = parseSavedView({ ...full, tab: 'x', range: { preset: 'forever' }, person: 4, extra: 1 })
    expect(got).toEqual({ ...full, tab: 'spending', range: { preset: 'this-month' }, person: 'all' })
  })
  it('a broken second step ends the path after the first', () => {
    const got = parseSavedView({ ...full, path: [full.path[0], { level: 'merchant', key: '', label: 'x' }] })
    expect(got?.path).toEqual([full.path[0]])
  })
  it('a path longer than two steps or not a list becomes empty', () => {
    expect(parseSavedView({ ...full, path: [...full.path, full.path[1]] })?.path).toEqual([])
    expect(parseSavedView({ ...full, path: 'x' })?.path).toEqual([])
  })
  it('null only when it is not an object', () => {
    expect(parseSavedView(null)).toBeNull()
    expect(parseSavedView([])).toBeNull()
    expect(parseSavedView({})).toEqual(defaultSavedView())
  })
})

describe('size', () => {
  it('the worst-case view is far under the cap and over-long steps are refused strictly', () => {
    const worst: SavedView = { ...full, person: 'p'.repeat(24), debt: 'd'.repeat(64), path: [{ level: 'category', key: '"'.repeat(120), label: '"'.repeat(60) }, { level: 'merchant', key: '"'.repeat(120), label: '"'.repeat(60) }] }
    expect(savedViewBytes(worst)).toBeLessThan(VIEW_BYTES_MAX / 2)
    expect(parseSavedView(worst, true)).toEqual(worst)
    expect(parseSavedView({ ...full, path: [{ ...full.path[0], key: 'k'.repeat(121) }] }, true)).toBeNull()
  })
  it('fitSavedView keeps a small view and drops the path of one over the cap', () => {
    expect(fitSavedView(full)).toBe(full)
    const huge = { ...full, path: [{ level: 'category' as const, key: 'k'.repeat(5000), label: 'x' }] }
    expect(fitSavedView(huge).path).toEqual([])
  })
  it('sameSavedView compares by value', () => {
    expect(sameSavedView(full, { ...full, path: [...full.path] })).toBe(true)
    expect(sameSavedView(full, { ...full, review: false })).toBe(false)
  })
})
