import { describe, expect, it } from 'vitest'
import { chartNotes } from './chartNotes'
import { getNote } from './notes'
import { rangeNoticeText, type RangeNotice } from './rangeNotice'
import { REFUSED_WHOLE_DAYS_CAPTION, SPLIT_GUARD_CAPTION } from './splitGuard'
import type { StatsResponse, Widget } from '../types'

const widget = (over: Partial<Widget> = {}): Widget => ({
  id: 'w1',
  i: 'w1',
  title: 'Pageviews',
  type: 'stat',
  dataset: 'geo',
  dimension: '',
  metric: 'pageviews',
  limit: 1,
  x: 0,
  y: 0,
  w: 3,
  h: 3,
  ...over,
})

const notice: RangeNotice = {
  kind: 'range-clamped',
  source: 'cf-rum',
  reason: 'both',
  requested: { from: '2026-01-01T05:00:00.000Z', to: '2026-10-01T04:00:00.000Z' },
  served: { from: '2026-07-01T04:00:00.000Z', to: '2026-10-01T04:00:00.000Z' },
  limitDays: 93,
  lookbackDays: 184,
}

const response = (extra: Partial<StatsResponse> = {}, meta: Partial<StatsResponse['meta']> = {}): StatsResponse => ({
  rows: [{ key: {}, pageviews: 5, visits: 3 }],
  totals: { pageviews: 5, visits: 3 },
  meta: { site: 'all', host: null, since: '2026-01-01', until: '2026-09-30', dimensions: [], metric: 'pageviews', ...meta },
  ...extra,
})

const keys = (notes: ReturnType<typeof chartNotes>) => notes.map((n) => n.key)

describe('chartNotes — order', () => {
  it('lists every source in the fixed order: legacy ids, popup note, split guard, whole days, range notice', () => {
    const data = response({ note: 'A pop-up caveat.', notice }, { splitGuard: true, refusedWholeDays: true })
    const notes = chartNotes(widget({ notes: ['small-sample', 'no-outcome-tracking'] }), data, null)
    expect(keys(notes)).toEqual(['small-sample', 'no-outcome-tracking', 'popup-note', 'split-guard', 'refused-whole-days', 'range-notice'])
  })

  it('the caption-text hook (slice 1c) is empty today: nothing comes before the legacy ids', () => {
    expect(chartNotes(widget({ notes: ['small-sample'] }), null, null)[0].key).toBe('small-sample')
  })
})

describe('chartNotes — each source on its own', () => {
  it('nothing at all: no notes', () => {
    expect(chartNotes(widget(), null, null)).toEqual([])
    expect(chartNotes(widget(), undefined, undefined)).toEqual([])
    expect(chartNotes(widget(), response(), null)).toEqual([])
  })

  it('legacy caption ids become registry notes, in the widget\'s own order', () => {
    const notes = chartNotes(widget({ notes: ['no-outcome-tracking', 'small-sample'] }), null, null)
    expect(notes).toEqual([
      { key: 'no-outcome-tracking', kind: 'caption', noteId: 'no-outcome-tracking', hideable: true },
      { key: 'small-sample', kind: 'caption', noteId: 'small-sample', hideable: true },
    ])
  })

  it('an explicit empty list and a missing list both mean no captions', () => {
    expect(chartNotes(widget({ notes: [] }), null, null)).toEqual([])
    expect(chartNotes(widget({ notes: undefined }), null, null)).toEqual([])
  })

  it('a note-type widget has no attached captions', () => {
    expect(chartNotes(widget({ type: 'note', notes: ['small-sample'] }), null, null)).toEqual([])
  })

  it('an unknown legacy id stays in the list (it renders as nothing) and is hideable', () => {
    expect(chartNotes(widget({ notes: ['not-a-note'] }), null, null)).toEqual([{ key: 'not-a-note', kind: 'caption', noteId: 'not-a-note', hideable: true }])
  })

  it('data.note becomes the popup-note caveat', () => {
    expect(chartNotes(widget(), response({ note: 'Install outcomes have a gap.' }), null)).toEqual([
      { key: 'popup-note', kind: 'caveat', text: 'Install outcomes have a gap.', hideable: true },
    ])
  })

  it('meta.splitGuard becomes the split-guard caveat', () => {
    expect(chartNotes(widget(), response({}, { splitGuard: true }), null)).toEqual([
      { key: 'split-guard', kind: 'caveat', text: SPLIT_GUARD_CAPTION, hideable: false },
    ])
  })

  it('meta.refusedWholeDays becomes the refused-whole-days caveat', () => {
    expect(chartNotes(widget(), response({}, { refusedWholeDays: true }), null)).toEqual([
      { key: 'refused-whole-days', kind: 'caveat', text: REFUSED_WHOLE_DAYS_CAPTION, hideable: false },
    ])
  })

  it('a false flag adds nothing', () => {
    expect(chartNotes(widget(), response({}, { splitGuard: false, refusedWholeDays: false }), null)).toEqual([])
  })

  it('a notice becomes the range-notice caveat, with its own text and the caveat tone', () => {
    const notes = chartNotes(widget(), response({ notice }), null)
    expect(notes).toEqual([{ key: 'range-notice', kind: 'caveat', severity: 'caveat', text: rangeNoticeText(notice), hideable: false }])
    expect(notes[0].text).toContain('Jul 1 – Sep 30 shown')
  })
})

describe('chartNotes — the error rule', () => {
  it('drops the range notice while an error is set, keeping the others', () => {
    const data = response({ note: 'A pop-up caveat.', notice }, { splitGuard: true })
    expect(keys(chartNotes(widget({ notes: ['small-sample'] }), data, 'stats 502'))).toEqual(['small-sample', 'popup-note', 'split-guard'])
  })

  it('an empty error string counts as no error', () => {
    expect(keys(chartNotes(widget(), response({ notice }), ''))).toEqual(['range-notice'])
  })
})

describe('chartNotes — hideable', () => {
  it('range-notice, split-guard and refused-whole-days are never hideable', () => {
    const data = response({ notice }, { splitGuard: true, refusedWholeDays: true })
    const byKey = Object.fromEntries(chartNotes(widget(), data, null).map((n) => [n.key, n.hideable]))
    expect(byKey).toEqual({ 'split-guard': false, 'refused-whole-days': false, 'range-notice': false })
  })

  it('popup-note and ordinary captions are hideable', () => {
    const notes = chartNotes(widget({ notes: ['small-sample'] }), response({ note: 'x' }), null)
    expect(notes.map((n) => [n.key, n.hideable])).toEqual([
      ['small-sample', true],
      ['popup-note', true],
    ])
  })

  it('a legacy caption follows its registry entry: country-split-excludes-refused is not hideable', () => {
    expect(getNote('country-split-excludes-refused')?.hideable).toBe(false)
    const notes = chartNotes(widget({ notes: ['country-split-excludes-refused', 'small-sample'] }), null, null)
    expect(notes.map((n) => [n.key, n.hideable])).toEqual([
      ['country-split-excludes-refused', false],
      ['small-sample', true],
    ])
  })
})
