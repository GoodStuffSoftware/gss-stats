import { describe, expect, it } from 'vitest'
import { allChartNotes, chartNotes, convertLegacyNotes, isChartNoteHidden, isNoteIdHideable } from './chartNotes'
import { autoCaveatIds, cardSplitsByCountry, getNote, isStaticCaptionNote, libraryCaptionOptions, noteTemplate } from './notes'
import { PRESETS } from './metrics/presets'
import type { CardSpec, MetricItem, RepeatSpec, Section } from './metrics/types'
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
    expect(keys(notes)).toEqual(['caption:small-sample', 'caption:no-outcome-tracking', 'popup-note', 'split-guard', 'refused-whole-days', 'range-notice'])
  })

  it("the widget's own caption (1c) comes first, before the legacy ids and every caveat", () => {
    const data = response({ note: 'A pop-up caveat.', notice }, { splitGuard: true, refusedWholeDays: true })
    const notes = chartNotes(widget({ caption: 'Counts **all** sites.', notes: ['small-sample'] }), data, null)
    expect(keys(notes)).toEqual(['caption', 'caption:small-sample', 'popup-note', 'split-guard', 'refused-whole-days', 'range-notice'])
    expect(notes[0]).toEqual({ key: 'caption', kind: 'caption', text: 'Counts **all** sites.', hideable: false })
  })

  it('without a caption, nothing comes before the legacy ids', () => {
    expect(chartNotes(widget({ notes: ['small-sample'] }), null, null)[0].key).toBe('caption:small-sample')
    expect(chartNotes(widget({ caption: '' }), null, null)).toEqual([])
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
      { key: 'caption:no-outcome-tracking', kind: 'caption', noteId: 'no-outcome-tracking', hideable: true, hideId: 'no-outcome-tracking' },
      { key: 'caption:small-sample', kind: 'caption', noteId: 'small-sample', hideable: true, hideId: 'small-sample' },
    ])
  })

  it('an explicit empty list and a missing list both mean no captions', () => {
    expect(chartNotes(widget({ notes: [] }), null, null)).toEqual([])
    expect(chartNotes(widget({ notes: undefined }), null, null)).toEqual([])
  })

  it('a note-type widget has no attached captions', () => {
    expect(chartNotes(widget({ type: 'note', notes: ['small-sample'] }), null, null)).toEqual([])
  })

  it('an unknown legacy id stays in the list, flagged unknown, and is not hideable (it renders as nothing)', () => {
    expect(chartNotes(widget({ notes: ['not-a-note'] }), null, null)).toEqual([
      { key: 'caption:not-a-note', kind: 'caption', noteId: 'not-a-note', hideable: false, unknown: true },
    ])
    // listing it in hiddenCaveats changes nothing: it is not hideable
    expect(keys(chartNotes(widget({ notes: ['not-a-note'], hiddenCaveats: ['not-a-note'] }), null, null))).toEqual(['caption:not-a-note'])
  })

  it('a legacy id spelled like a runtime note key never collides with it: `caption:` keys stay unique', () => {
    const data = response({}, { refusedWholeDays: true })
    const notes = chartNotes(widget({ notes: ['refused-whole-days'] }), data, null)
    expect(keys(notes)).toEqual(['caption:refused-whole-days', 'refused-whole-days'])
    expect(new Set(keys(notes)).size).toBe(notes.length)
  })

  it('data.note becomes the popup-note caveat', () => {
    expect(chartNotes(widget(), response({ note: 'Install outcomes have a gap.' }), null)).toEqual([
      { key: 'popup-note', kind: 'caveat', text: 'Install outcomes have a gap.', hideable: true, hideId: 'popup-note' },
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
    expect(keys(chartNotes(widget({ notes: ['small-sample'] }), data, 'stats 502'))).toEqual(['caption:small-sample', 'popup-note', 'split-guard'])
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
      ['caption:small-sample', true],
      ['popup-note', true],
    ])
  })

  it('a legacy caption follows its registry entry: country-split-excludes-refused is not hideable', () => {
    expect(getNote('country-split-excludes-refused')?.hideable).toBe(false)
    const notes = chartNotes(widget({ notes: ['country-split-excludes-refused', 'small-sample'] }), null, null)
    expect(notes.map((n) => [n.key, n.hideable])).toEqual([
      ['caption:country-split-excludes-refused', false],
      ['caption:small-sample', true],
    ])
  })

  it('isNoteIdHideable: a known hideable entry only; a data-cut entry and an unknown id are not', () => {
    expect(isNoteIdHideable('small-sample')).toBe(true)
    expect(isNoteIdHideable('country-split-excludes-refused')).toBe(false)
    expect(isNoteIdHideable('not-a-note')).toBe(false)
  })
})

describe('chartNotes — hiddenCaveats (1c)', () => {
  const data = response({ note: 'A pop-up caveat.', notice }, { splitGuard: true, refusedWholeDays: true })
  const all = ['caption', 'caption:small-sample', 'caption:no-outcome-tracking', 'popup-note', 'split-guard', 'refused-whole-days', 'range-notice']
  const w = (hiddenCaveats?: string[]) => widget({ caption: 'Mine.', notes: ['small-sample', 'no-outcome-tracking'], hiddenCaveats })

  it('hides legacy captions by registry id and runtime caveats by their key, keeping the order of the rest', () => {
    expect(keys(chartNotes(w(['small-sample', 'popup-note']), data, null))).toEqual(['caption', 'caption:no-outcome-tracking', 'split-guard', 'refused-whole-days', 'range-notice'])
  })

  it('ignores every entry naming a note that is not hideable: range-notice, split-guard, refused-whole-days', () => {
    expect(keys(chartNotes(w(['range-notice', 'split-guard', 'refused-whole-days']), data, null))).toEqual(all)
  })

  it('ignores a hidden registry id whose entry is hideable: false (country-split-excludes-refused)', () => {
    const cw = widget({ notes: ['country-split-excludes-refused'], hiddenCaveats: ['country-split-excludes-refused'] })
    expect(keys(chartNotes(cw, null, null))).toEqual(['caption:country-split-excludes-refused'])
  })

  it("never hides the widget's own caption, and a `caption:` key is not a hide id", () => {
    expect(keys(chartNotes(w(['caption', 'caption:small-sample']), data, null))).toEqual(all)
  })

  it('an empty or missing list hides nothing; ids naming notes the chart does not show change nothing', () => {
    expect(keys(chartNotes(w([]), data, null))).toEqual(all)
    expect(keys(chartNotes(w(undefined), data, null))).toEqual(all)
    expect(keys(chartNotes(w(['min-cohort-caveat', 'whatever']), data, null))).toEqual(all)
  })

  it("allChartNotes keeps the hidden ones (the editor's list), and isChartNoteHidden says which", () => {
    const hidden = ['small-sample', 'popup-note', 'split-guard']
    const notes = allChartNotes(w(hidden), data, null)
    expect(keys(notes)).toEqual(all)
    expect(notes.filter((n) => isChartNoteHidden(n, hidden)).map((n) => n.key)).toEqual(['caption:small-sample', 'popup-note'])
    expect(notes.find((n) => n.key === 'caption:small-sample')?.hideId).toBe('small-sample')
    expect(notes.filter((n) => !n.hideable).every((n) => n.hideId === undefined)).toBe(true)
  })
})

describe('static library captions (1c, D1)', () => {
  it('a plain registry caption is static; gated, computed, code-tied, data-cut and unknown ids are not', () => {
    expect(isStaticCaptionNote('small-sample')).toBe(true)
    expect(isStaticCaptionNote('release-before-partial')).toBe(true)
    expect(isStaticCaptionNote('tracking-not-yet-active')).toBe(false) // activeWhen
    expect(isStaticCaptionNote('play-tracking-status')).toBe(false) // computed text
    expect(isStaticCaptionNote('min-cohort-caveat')).toBe(false) // vars tied to code
    expect(isStaticCaptionNote('country-split-excludes-refused')).toBe(false) // data cut
    expect(isStaticCaptionNote('no-such-note')).toBe(false)
  })

  it('"Insert from library" offers exactly the static captions', () => {
    const ids = libraryCaptionOptions().map((o) => o.value)
    expect(ids).toContain('small-sample')
    expect(ids.every(isStaticCaptionNote)).toBe(true)
    expect(ids).not.toContain('play-tracking-status')
  })
})

describe('convertLegacyNotes (1c, D5 convert-on-edit)', () => {
  it('folds static ids into the caption in order, after the existing caption, and keeps unknown and caveat ids', () => {
    const w = widget({ caption: 'Mine.  ', notes: ['small-sample', 'bogus-id', 'tracking-not-yet-active', 'release-before-partial'] })
    const { widget: out, converted } = convertLegacyNotes(w)
    expect(converted).toEqual(['small-sample', 'release-before-partial'])
    expect(out.caption).toBe(`Mine.\n\n${noteTemplate('small-sample').trim()}\n\n${noteTemplate('release-before-partial').trim()}`)
    expect(out.notes).toEqual(['bogus-id', 'tracking-not-yet-active'])
    expect(w.notes).toHaveLength(4) // never mutates
    expect(w.caption).toBe('Mine.  ')
  })

  it('deletes `notes` once every id is converted, and starts a caption when there was none', () => {
    const { widget: out } = convertLegacyNotes(widget({ notes: ['small-sample'] }))
    expect('notes' in out).toBe(false)
    expect(out.caption).toBe(noteTemplate('small-sample').trim())
  })

  it('a hidden static id leaves `notes` without adding text, so the chart looks the same', () => {
    const { widget: out, converted } = convertLegacyNotes(widget({ notes: ['small-sample'], hiddenCaveats: ['small-sample'] }))
    expect(converted).toEqual(['small-sample'])
    expect('caption' in out).toBe(false)
    expect('notes' in out).toBe(false)
  })

  it('returns the same object when there is nothing to convert, and for every note widget', () => {
    const plain = widget()
    expect(convertLegacyNotes(plain).widget).toBe(plain)
    const onlyUnknown = widget({ notes: ['bogus-id'] })
    expect(convertLegacyNotes(onlyUnknown).widget).toBe(onlyUnknown)
    const note = widget({ type: 'note', notes: ['small-sample'] })
    expect(convertLegacyNotes(note).widget).toBe(note)
  })
})

describe('automatic scope caveats (1c, D2-B)', () => {
  const campaigns = (over: Partial<Widget> = {}) => widget({ type: 'table', dataset: 'campaigns', ...over })

  it('a new chart shows its scope caveats after the legacy ids and before the runtime notes', () => {
    const data = response({ note: 'A pop-up caveat.' })
    expect(keys(chartNotes(campaigns({ caption: 'Mine.', notes: ['arrivals-caveat'] }), data, null))).toEqual([
      'caption',
      'caption:arrivals-caveat',
      'caveat:play-tracking-status',
      'caveat:min-cohort-caveat',
      'popup-note',
    ])
    expect(keys(chartNotes(widget({ dataset: 'popup' }), null, null))).toEqual(['caveat:min-cohort-caveat'])
  })

  it('static library captions never show automatically, and scopes with only those show none', () => {
    for (const dataset of ['overview', 'geo', 'ads-readings'] as const) expect(chartNotes(widget({ dataset }), null, null), dataset).toEqual([])
    expect(chartNotes(widget({ dataset: undefined }), null, null)).toEqual([])
  })

  it('an id the chart already lists in notes shows once, under its legacy key', () => {
    expect(keys(chartNotes(campaigns({ notes: ['min-cohort-caveat'] }), null, null))).toEqual([
      'caption:min-cohort-caveat',
      'caveat:play-tracking-status',
    ])
  })

  it('a hidden automatic caveat stays hidden; a data-cut one cannot be hidden', () => {
    // the data cut shows only where it is true: a card with country columns (B4a)
    const card: Widget['card'] = { spec: { ...JSON.parse(JSON.stringify(PRESETS['campaign-country'])), captions: [] } }
    const w = campaigns({ card, hiddenCaveats: ['play-tracking-status', 'min-cohort-caveat', 'country-split-excludes-refused'] })
    expect(keys(chartNotes(w, null, null))).toEqual(['caveat:country-split-excludes-refused'])
    const all = allChartNotes(w, null, null)
    expect(all.find((n) => n.key === 'caveat:min-cohort-caveat')).toMatchObject({ kind: 'caveat', noteId: 'min-cohort-caveat', hideable: true, hideId: 'min-cohort-caveat' })
    const cut = all.find((n) => n.key === 'caveat:country-split-excludes-refused')!
    expect(cut.hideable).toBe(false)
    expect(cut.hideId).toBeUndefined()
  })

  it('an activeWhen gate that is off keeps a gated caveat out (both tracking dates are set today)', () => {
    expect(getNote('play-tracking-not-live')!.scopes).toContain('campaigns')
    expect(getNote('tracking-not-yet-active')!.scopes).toContain('popup')
    expect(keys(allChartNotes(campaigns(), null, null))).not.toContain('caveat:play-tracking-not-live')
    expect(keys(allChartNotes(widget({ dataset: 'popup' }), null, null))).not.toContain('caveat:tracking-not-yet-active')
  })

  it("a note widget gets none, and a card's own spec captions are not repeated", () => {
    expect(allChartNotes(campaigns({ type: 'note', noteId: 'arrivals-caveat' }), null, null)).toEqual([])
    expect(keys(allChartNotes(campaigns({ card: { preset: 'campaign-country' } }), null, null))).not.toContain('caveat:country-split-excludes-refused')
  })
})

describe('a non-hideable automatic caveat shows only where it is true (B4a)', () => {
  const CUT = 'country-split-excludes-refused'
  const campaigns = (over: Partial<Widget> = {}) => widget({ type: 'table', dataset: 'campaigns', ...over })
  const countries: RepeatSpec = { over: 'countries' }
  const spec = (over: Partial<CardSpec> = {}, section: Partial<Section> = {}): Widget['card'] => ({
    spec: { v: 1, ...over, sections: [{ layout: 'table', items: [], ...section }] },
  })
  const item = (repeat?: RepeatSpec) => ({ ...JSON.parse(JSON.stringify(PRESETS['campaign-funnel'].sections[0].items[0])), repeat }) as MetricItem

  it('a campaigns chart without country columns does not get the country caveat', () => {
    for (const w of [
      campaigns(),
      campaigns({ type: 'line', dimension: 'dateEt' }),
      campaigns({ card: { preset: 'campaign-funnel' } }),
      campaigns({ card: { preset: 'campaign-returns' } }),
      campaigns({ card: { preset: 'campaign-cost' } }),
      campaigns({ card: spec({ repeat: { over: 'campaigns' } }, { columns: { over: 'windows' }, items: [item({ over: 'campaigns' })] }) }),
      campaigns({ card: { preset: 'no-such-preset' } }),
    ]) {
      expect(cardSplitsByCountry(w.card), JSON.stringify(w.card)).toBe(false)
      expect(autoCaveatIds(w), JSON.stringify(w.card)).not.toContain(CUT)
      expect(keys(chartNotes(w, null, null))).not.toContain(`caveat:${CUT}`)
    }
  })

  it('a campaigns card with country columns (or any per-country repeat) gets it, and it cannot be hidden', () => {
    const cards: Widget['card'][] = [
      { spec: { ...JSON.parse(JSON.stringify(PRESETS['campaign-country'])), captions: [] } },
      spec({}, { columns: countries }),
      spec({}, { repeat: countries }),
      spec({ repeat: countries }),
      spec({}, { items: [item(countries)] }),
    ]
    for (const card of cards) {
      expect(cardSplitsByCountry(card), JSON.stringify(card)).toBe(true)
      const w = campaigns({ card, hiddenCaveats: [CUT] })
      expect(autoCaveatIds(w)).toContain(CUT)
      expect(keys(chartNotes(w, null, null))).toContain(`caveat:${CUT}`)
    }
  })

  it('the campaign-country preset shows it once, as its own card caption, never as an automatic caveat', () => {
    const w = campaigns({ card: { preset: 'campaign-country' } })
    expect(cardSplitsByCountry(w.card)).toBe(true)
    expect(autoCaveatIds(w)).not.toContain(CUT)
  })

  it('outside its scope it never shows, even with country columns', () => {
    expect(autoCaveatIds(widget({ type: 'table', dataset: 'overview', card: spec({}, { columns: countries }) }))).not.toContain(CUT)
  })

  it('a widget condition makes a note a caveat, never a static library caption', () => {
    expect(getNote(CUT)!.appliesTo).toBeTypeOf('function')
    expect(isStaticCaptionNote(CUT)).toBe(false)
  })
})
