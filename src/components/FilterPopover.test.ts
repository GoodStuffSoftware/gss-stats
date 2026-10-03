// @vitest-environment happy-dom
// A chart's own filter (FilterPopover): the range it applies records its relative span in
// `rangeRel`, so the window is recomputed on load like the page filter bar's, and "Since first
// campaign" is one of its chips.
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import FilterPopover from './FilterPopover.vue'
import { defaultFilters } from '../lib/defaults'
import { SINCE_FIRST_CAMPAIGN, etDayRangeToISO } from '../lib/range'
import type { GlobalFilters } from '../types'

const last = (w: ReturnType<typeof mount>) => (w.emitted('apply') as GlobalFilters[][]).at(-1)![0]

describe('FilterPopover range', () => {
  it('the "Since first campaign" chip applies that range and keeps its token', async () => {
    const w = mount(FilterPopover, { props: { start: { ...defaultFilters(), rangeRel: '7d' }, active: true } })
    const chip = w.findAll('button.chip').find((b) => b.text() === 'Since first campaign')!
    await chip.trigger('click')
    const f = last(w)
    expect(f.rangeRel).toBe(SINCE_FIRST_CAMPAIGN)
    expect(f.since).toBe('2026-09-02T04:00:00.000Z')
    await w.setProps({ start: f })
    expect((w.find('input.rangefield').element as HTMLInputElement).value).toBe('Since first campaign')
    expect(w.findAll('button.chip.on').map((b) => b.text())).toEqual(['Since first campaign'])
  })

  it('a day chip or a typed span stores its span; a calendar range clears it', async () => {
    const w = mount(FilterPopover, { props: { start: { ...defaultFilters(), rangeRel: SINCE_FIRST_CAMPAIGN }, active: true } })
    await w.findAll('button.chip').find((b) => b.text() === '30d')!.trigger('click')
    expect(last(w).rangeRel).toBe('30d')
    const input = w.find('input.rangefield')
    await input.setValue('2w')
    await input.trigger('blur')
    expect(last(w).rangeRel).toBe('2w')
    const [from, to] = w.findAll('input[type="date"]')
    await from.setValue('2026-09-01')
    await to.setValue('2026-09-10')
    await to.trigger('change')
    expect(last(w).rangeRel).toBe('')
  })
})

describe('FilterPopover — the date pickers on an ET-day range (a drilled dateEt page)', () => {
  const day = (d: string) => etDayRangeToISO(d)
  const dates = (w: ReturnType<typeof mount>) => w.findAll('input[type="date"]').map((i) => (i.element as HTMLInputElement).value)

  it.each(['2026-03-08', '2026-11-01', '2026-06-15'])('shows the one ET day %s on both pickers and its single-date label, not two UTC days', (d) => {
    const w = mount(FilterPopover, { props: { start: { ...defaultFilters(), ...day(d), rangeRel: '' }, active: true } })
    expect(dates(w)).toEqual([d, d])
    expect((w.find('input.rangefield').element as HTMLInputElement).value).toBe(new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }))
    expect(w.emitted('apply')).toBeUndefined() // showing it changes nothing: no apply until the viewer edits a date
  })
  it('a UTC-day range still shows its own UTC dates', () => {
    const w = mount(FilterPopover, { props: { start: { ...defaultFilters(), since: '2026-03-08T00:00:00.000Z', until: '2026-03-09T23:59:59.999Z', rangeRel: '' }, active: true } })
    expect(dates(w)).toEqual(['2026-03-08', '2026-03-09'])
  })
})
