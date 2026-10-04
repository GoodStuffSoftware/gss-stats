// @vitest-environment happy-dom
//
// `rangeOnly` (the Retention page): the date range and "Sync all pages" stay; the site picker and the
// exclusions (own visits, self-referrals) go, because nothing on that page reads them.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import FilterBar from './FilterBar.vue'
import { defaultFilters } from '../lib/defaults'

const labels = (rangeOnly?: boolean) =>
  mount(FilterBar, { props: { filters: defaultFilters(), syncRange: true, rangeOnly } })
    .findAll('.filter-bar > .group > label:first-child')
    .map((l) => l.text())

const hintShown = (filters: ReturnType<typeof defaultFilters>, rangeOnly = true) =>
  mount(FilterBar, { props: { filters, syncRange: true, rangeOnly } }).find('.range-only-hint').exists()

describe('FilterBar rangeOnly', () => {
  it('shows every group by default', () => {
    expect(labels()).toEqual(['Sites', 'Range', 'Exclusions', 'Pages'])
    expect(labels(false)).toEqual(['Sites', 'Range', 'Exclusions', 'Pages'])
  })

  it('keeps the date range and Sync, and hides Sites and Exclusions', () => {
    expect(labels(true)).toEqual(['Range', 'Pages'])
    const w = mount(FilterBar, { props: { filters: defaultFilters(), syncRange: true, rangeOnly: true } })
    expect(w.find('.range-field').exists()).toBe(true)
    expect(w.find('.sync-toggle').exists()).toBe(true)
    expect(w.find('.site-btn').exists()).toBe(false)
    expect(w.find('.excl-btn').exists()).toBe(false)
  })

  it('says the hidden filters still apply only when a site or exclusion filter is not at its default', () => {
    expect(hintShown(defaultFilters())).toBe(false)
    expect(hintShown({ ...defaultFilters(), siteSel: ['bestsudoku.example'] })).toBe(true)
    expect(hintShown({ ...defaultFilters(), excludeOwnVisits: false })).toBe(true)
    expect(hintShown({ ...defaultFilters(), excludeSelfReferrals: false })).toBe(true)
    const text = mount(FilterBar, { props: { filters: { ...defaultFilters(), siteSel: ['x'] }, syncRange: true, rangeOnly: true } }).find('.range-only-hint').text()
    expect(text).toMatch(/still apply/)
  })

  it('never shows the hint on a bar with the full controls', () => {
    expect(hintShown({ ...defaultFilters(), siteSel: ['bestsudoku.example'], excludeOwnVisits: false }, false)).toBe(false)
  })
})
