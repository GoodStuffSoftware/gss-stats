// @vitest-environment happy-dom
//
// ChartEditor x chart captions (notes plan, slice 1c, part B1): the Caption text area, the "Data
// caveats" Show/Hide list (hiddenCaveats), "Insert from library", D5 convert-on-edit of legacy
// `notes` ids, N1 "remove unknown note", the note widget's own text area, and the CardEditor wiring
// for a card's spec captions. Every test reads the SAVED widget's shape: an empty value is an
// absent key, never '' or [].
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { PRESETS } from '../lib/metrics/presets'
import type { CardSpec } from '../lib/metrics/types'
import ChartEditor from './ChartEditor.vue'
import { CAPTION_MAX_CHARS, HIDDEN_CAVEATS_MAX, clonePage } from '../lib/defaults'
import { noteTemplate } from '../lib/notes'
import type { DashboardPage, StatsResponse, Widget } from '../types'

const mounted: VueWrapper[] = []
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
})
const base = (over: Partial<Widget> = {}): Widget =>
  ({ id: 'w1', i: 'w1', title: 'Panel', type: 'table', dataset: 'popup', dimension: 'kind', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 6, h: 6, ...over }) as Widget
function open(widget: Widget, extra: Record<string, unknown> = {}) {
  const w = mount(ChartEditor, { props: { widget, isNew: false, ...extra }, global: { stubs: { CardEditor: true } } })
  mounted.push(w)
  return w
}
const response = (extra: Partial<StatsResponse> = {}, meta: Partial<StatsResponse['meta']> = {}): StatsResponse =>
  ({
    rows: [],
    totals: { pageviews: 0, visits: 0 },
    meta: { site: 'all', host: null, since: '2026-01-01', until: '2026-09-30', dimensions: [], metric: 'pageviews', ...meta },
    ...extra,
  }) as StatsResponse
const captionBox = (w: VueWrapper) => w.get('.caption-field textarea')
const row = (w: VueWrapper, key: string) => w.find(`.caveat-row[data-key="${key}"]`)
async function save(w: VueWrapper): Promise<Widget> {
  await w.get('button.btn-primary').trigger('click')
  const ev = w.emitted('save')!
  return ev[ev.length - 1][0] as Widget
}
const SMALL = noteTemplate('small-sample').trim()
const RELEASE = noteTemplate('release-before-partial').trim()

describe('ChartEditor: Caption', () => {
  it('an untouched chart saves no caption, hiddenCaveats or notes key', async () => {
    const out = await save(open(base()))
    expect('caption' in out).toBe(false)
    expect('hiddenCaveats' in out).toBe(false)
    expect('notes' in out).toBe(false)
  })

  it('saves the typed caption (trimmed), with a counter and the 2,000-character limit on the box', async () => {
    const w = open(base())
    const box = captionBox(w)
    expect(box.attributes('maxlength')).toBe(String(CAPTION_MAX_CHARS))
    await box.setValue('  Shaded = **flights**.\n\nSecond paragraph.  ')
    expect(w.get('.caption-count').text()).toBe(`${'  Shaded = **flights**.\n\nSecond paragraph.  '.length} / ${CAPTION_MAX_CHARS}`)
    expect((await save(w)).caption).toBe('Shaded = **flights**.\n\nSecond paragraph.')
  })

  it('a caption of only whitespace deletes the key, and clearing an existing caption does too', async () => {
    const w = open(base())
    await captionBox(w).setValue('   \n  ')
    expect('caption' in (await save(w))).toBe(false)
    const w2 = open(base({ caption: 'Old text' }))
    expect((captionBox(w2).element as HTMLTextAreaElement).value).toBe('Old text')
    await captionBox(w2).setValue('')
    expect('caption' in (await save(w2))).toBe(false)
  })

  it('the hint explains Insert value and the "—" for a token with no value', () => {
    const text = open(base()).get('.caption-field').text()
    expect(text).toContain('Insert value adds a live number or date')
    expect(text).toContain('shows "—" when there is no value for it')
  })
})

// Slice 1d release 1: "Insert value ▾" puts a `{=…}` token (lib/valueTokens.ts) into the caption.
describe('ChartEditor: Insert value', () => {
  const valueMenu = (w: VueWrapper) => w.get('.caption-field select.insert-value')

  it('offers the chart values and the dates, in two groups, with what each reads right now', () => {
    const w = open(base(), { data: response({ totals: { pageviews: 1234, visits: 5 } }) })
    const sel = valueMenu(w)
    expect(sel.attributes('aria-label')).toBe('Insert value')
    expect(sel.findAll('optgroup').map((g) => g.attributes('label'))).toEqual(['This chart', 'Dates'])
    const values = sel.findAll('option').map((o) => o.attributes('value'))
    expect(values[0]).toBe('')
    expect(values).toContain('{=chart.total|number}')
    expect(values).toContain('{=chart.topShare|pct}')
    expect(values).toContain('{=golive.web|date}')
    expect(values).toContain('{=release.latestVersion}')
    expect(sel.find('option[value="{=chart.total|number}"]').text()).toBe('Total (1,234)')
    expect(sel.find('option[value="{=chart.top}"]').text()).toBe('Top item') // no rows: no value to show
  })

  it('appends with a space when the box was never focused, and the menu resets', async () => {
    const w = open(base({ caption: 'Views:' }))
    await valueMenu(w).setValue('{=chart.total|number}')
    expect((valueMenu(w).element as unknown as HTMLSelectElement).value).toBe('')
    expect((await save(w)).caption).toBe('Views: {=chart.total|number}')
  })

  it('an empty caption gets just the token', async () => {
    const w = open(base())
    await valueMenu(w).setValue('{=golive.web|date}')
    expect((await save(w)).caption).toBe('{=golive.web|date}')
  })

  it('inserts at the cursor the box had when it lost focus, replacing a selection, and a second insert follows the first', async () => {
    const w = open(base({ caption: 'A xx B' }))
    const el = captionBox(w).element as HTMLTextAreaElement
    el.setSelectionRange(2, 4)
    await captionBox(w).trigger('blur')
    await valueMenu(w).setValue('{=chart.total|number}')
    await valueMenu(w).setValue('{=chart.topShare|pct}')
    expect((await save(w)).caption).toBe('A {=chart.total|number}{=chart.topShare|pct} B')
  })

  it('does not insert a token that would not fit whole under the limit, and says the caption is full', async () => {
    const full = 'x'.repeat(CAPTION_MAX_CHARS - 5)
    const w = open(base({ caption: full }))
    const hint = w.get('.caption-field .caption-full')
    expect(hint.attributes('aria-live')).toBe('polite')
    expect(hint.text()).toBe('')
    await valueMenu(w).setValue('{=chart.total|number}')
    expect(hint.text()).toBe('Caption is full')
    expect((await save(w)).caption).toBe(full)
  })

  it('the "Caption is full" hint clears on the next edit: typing, or an insert that fits', async () => {
    const full = 'x'.repeat(CAPTION_MAX_CHARS - 5)
    const w = open(base({ caption: full }))
    const hint = () => w.get('.caption-field .caption-full').text()
    await valueMenu(w).setValue('{=chart.total|number}')
    expect(hint()).toBe('Caption is full')
    await captionBox(w).setValue('short')
    expect(hint()).toBe('')
    const w2 = open(base({ caption: full }))
    const hint2 = () => w2.get('.caption-field .caption-full').text()
    await valueMenu(w2).setValue('{=chart.total|number}')
    expect(hint2()).toBe('Caption is full')
    await valueMenu(w2).setValue('{=chart.top}') // 12 characters: still too long
    expect(hint2()).toBe('Caption is full')
    await captionBox(w2).setValue('x'.repeat(10))
    await valueMenu(w2).setValue('{=chart.top}')
    expect(hint2()).toBe('')
  })

  it('a token that ends exactly at the limit is inserted', async () => {
    const token = '{=chart.total|number}'
    const head = 'x'.repeat(CAPTION_MAX_CHARS - token.length - 1) // + the joining space = the limit
    const w = open(base({ caption: head }))
    await valueMenu(w).setValue(token)
    expect(w.get('.caption-field .caption-full').text()).toBe('')
    const out = (await save(w)).caption!
    expect(out).toBe(`${head} ${token}`)
    expect(out.length).toBe(CAPTION_MAX_CHARS)
    const w2 = open(base({ caption: head + 'x' })) // one character more: refused
    await valueMenu(w2).setValue(token)
    expect((await save(w2)).caption).toBe(head + 'x')
  })

  it('a cursor inside an existing token inserts after that token, never inside it', async () => {
    const w = open(base({ caption: 'A {=chart.total|number} B' }))
    const el = captionBox(w).element as HTMLTextAreaElement
    el.setSelectionRange(10, 10) // between "{=chart." and "total|number}"
    await captionBox(w).trigger('blur')
    await valueMenu(w).setValue('{=chart.top}')
    expect((await save(w)).caption).toBe('A {=chart.total|number}{=chart.top} B')
  })

  it('a selection that starts or ends inside a token replaces up to the end of that token, never half of one', async () => {
    const w = open(base({ caption: 'A {=chart.total} B {=chart.top} C' }))
    const el = captionBox(w).element as HTMLTextAreaElement
    el.setSelectionRange(5, 24) // inside {=chart.total} .. inside {=chart.top}
    await captionBox(w).trigger('blur')
    await valueMenu(w).setValue('{=golive.web|date}')
    expect((await save(w)).caption).toBe('A {=chart.total}{=golive.web|date} C')
  })

  it('an insert that fits after a refusal clears "Caption is full" with no typing between (N2/N4)', async () => {
    const full = 'x'.repeat(CAPTION_MAX_CHARS - 5)
    const w = open(base({ caption: full }))
    const hint = () => w.get('.caption-field .caption-full').text()
    await valueMenu(w).setValue('{=chart.total|number}')
    expect(hint()).toBe('Caption is full')
    const el = captionBox(w).element as HTMLTextAreaElement
    el.setSelectionRange(0, 20) // a selection the next token replaces, so it fits
    await captionBox(w).trigger('blur')
    await valueMenu(w).setValue('{=chart.top}')
    expect(hint()).toBe('')
    expect((await save(w)).caption).toBe('{=chart.top}' + full.slice(20))
  })

  it('a second refusal in a row is announced again: the message node is replaced (NIT-3)', async () => {
    const w = open(base({ caption: 'x'.repeat(CAPTION_MAX_CHARS - 5) }))
    await valueMenu(w).setValue('{=chart.total|number}')
    const first = w.get('.caption-field .caption-full span').element
    expect(first.textContent).toBe('Caption is full')
    await valueMenu(w).setValue('{=chart.top}')
    const second = w.get('.caption-field .caption-full span').element
    expect(second.textContent).toBe('Caption is full')
    expect(second).not.toBe(first)
  })

  it('a cursor exactly at the start of a token inserts before that token', async () => {
    const w = open(base({ caption: 'A {=chart.total} B' }))
    const el = captionBox(w).element as HTMLTextAreaElement
    el.setSelectionRange(2, 2)
    await captionBox(w).trigger('blur')
    await valueMenu(w).setValue('{=chart.top}')
    expect((await save(w)).caption).toBe('A {=chart.top}{=chart.total} B')
  })

  it('a popup card, which renders its own body, offers the Dates group only even with data loaded (NIT-1)', () => {
    const card = base({ type: 'rateTable', dimension: '', card: { preset: 'popup-rates' } } as Partial<Widget>)
    const sel = valueMenu(open(card, { data: response({ totals: { pageviews: 1234, visits: 5 } }) }))
    expect(sel.findAll('optgroup').map((g) => g.attributes('label'))).toEqual(['Dates'])
    expect(sel.findAll('option').some((o) => o.attributes('value')?.startsWith('{=chart.'))).toBe(false)
  })

  it.each(['overview', 'campaigns', 'ads-readings'] as const)(
    'a %s chart, which loads no response for chart values, offers the Dates group only',
    (dataset) => {
      const sel = valueMenu(open(base({ dataset, type: 'table', dimension: '' })))
      expect(sel.findAll('optgroup').map((g) => g.attributes('label'))).toEqual(['Dates'])
      const values = sel.findAll('option').map((o) => o.attributes('value'))
      expect(values).toContain('{=golive.web|date}')
      expect(values).toContain('{=release.latest|date}')
      expect(values.some((v) => v?.startsWith('{=chart.'))).toBe(false)
    },
  )
})

describe('ChartEditor: Insert from library', () => {
  it('offers static captions only, and appends after a blank line when the box was never focused', async () => {
    const w = open(base({ caption: 'Mine.' }))
    const sel = w.get('.caption-field select.insert-library')
    const ids = sel.findAll('option').map((o) => o.attributes('value'))
    expect(ids[0]).toBe('')
    expect(ids).toContain('small-sample')
    expect(ids).not.toContain('play-tracking-status') // a caveat, never inserted as text
    await sel.setValue('small-sample')
    expect((sel.element as unknown as HTMLSelectElement).value).toBe('') // the menu resets
    expect((await save(w)).caption).toBe(`Mine.\n\n${SMALL}`)
  })

  it('inserts at the cursor the box had when it lost focus, replacing a selection', async () => {
    const w = open(base({ caption: 'AB' }))
    const el = captionBox(w).element as HTMLTextAreaElement
    el.setSelectionRange(1, 1)
    await captionBox(w).trigger('blur')
    await w.get('.caption-field select.insert-library').setValue('release-before-partial')
    expect((await save(w)).caption).toBe(`A${RELEASE}B`)
  })

  it('text that runs past the limit is cut back to before a value token the cut would split, and says so', async () => {
    const token = '{=chart.total|number}'
    const pad = 'x'.repeat(CAPTION_MAX_CHARS - SMALL.length - 10) // after the insert, the token straddles the limit
    const w = open(base({ caption: pad + token }))
    const el = captionBox(w).element as HTMLTextAreaElement
    el.setSelectionRange(0, 0)
    await captionBox(w).trigger('blur')
    await w.get('.caption-field select.insert-library').setValue('small-sample')
    const out = (await save(w)).caption!
    expect(out).toBe(SMALL + pad)
    expect(out).not.toContain('{=')
    expect(w.get('.caption-field .caption-full').text()).toBe('Caption is full')
  })

  it('a token ending exactly at the limit is kept when library text is cut back', async () => {
    const token = '{=chart.total|number}'
    const pad = 'x'.repeat(CAPTION_MAX_CHARS - SMALL.length - token.length) // after the insert, the token ends at the limit
    const w = open(base({ caption: pad + token + 'yyy' }))
    const el = captionBox(w).element as HTMLTextAreaElement
    el.setSelectionRange(0, 0)
    await captionBox(w).trigger('blur')
    await w.get('.caption-field select.insert-library').setValue('small-sample')
    const out = (await save(w)).caption!
    expect(out).toBe(SMALL + pad + token)
    expect(out.length).toBe(CAPTION_MAX_CHARS)
    expect(w.get('.caption-field .caption-full').text()).toBe('Caption is full')
  })

  it('a library insert that fits after a refusal clears "Caption is full" with no typing between', async () => {
    const full = 'x'.repeat(CAPTION_MAX_CHARS - 5)
    const w = open(base({ caption: full }))
    const hint = () => w.get('.caption-field .caption-full').text()
    await w.get('.caption-field select.insert-value').setValue('{=chart.total|number}')
    expect(hint()).toBe('Caption is full')
    const el = captionBox(w).element as HTMLTextAreaElement
    el.setSelectionRange(0, full.length) // replace it all, so the library text fits
    await captionBox(w).trigger('blur')
    await w.get('.caption-field select.insert-library').setValue('small-sample')
    expect(hint()).toBe('')
    expect((await save(w)).caption).toBe(SMALL)
  })

  it('a cursor inside a value token inserts library text after that token', async () => {
    const w = open(base({ caption: '{=chart.total|number} end' }))
    const el = captionBox(w).element as HTMLTextAreaElement
    el.setSelectionRange(4, 4)
    await captionBox(w).trigger('blur')
    await w.get('.caption-field select.insert-library').setValue('small-sample')
    expect((await save(w)).caption).toBe(`{=chart.total|number}${SMALL} end`)
  })

  it('library entries stay read-only: the insert copies text and records no id', async () => {
    const w = open(base())
    await w.get('.caption-field select.insert-library').setValue('small-sample')
    const out = await save(w)
    expect(out.caption).toBe(SMALL)
    expect('notes' in out).toBe(false)
  })
})

describe('ChartEditor: Data caveats', () => {
  it('lists the runtime caveats with Show toggles; hiding writes hiddenCaveats and showing again deletes the key', async () => {
    const w = open(base(), { data: response({ note: 'Pop-up shown on day 2.' }) })
    const popup = row(w, 'popup-note')
    expect(popup.text()).toContain('Pop-up shown on day 2.')
    const box = popup.get('input[type="checkbox"]')
    expect((box.element as HTMLInputElement).checked).toBe(true)
    expect((box.element as HTMLInputElement).disabled).toBe(false)
    await box.setValue(false)
    expect((await save(w)).hiddenCaveats).toEqual(['popup-note'])
    await row(w, 'popup-note').get('input[type="checkbox"]').setValue(true)
    expect('hiddenCaveats' in (await save(w))).toBe(false)
  })

  it('a data-cut caveat shows a disabled toggle and the reason it is always shown', () => {
    const w = open(base(), { data: response({}, { splitGuard: true }) })
    const guard = row(w, 'split-guard')
    expect((guard.get('input[type="checkbox"]').element as HTMLInputElement).disabled).toBe(true)
    expect((guard.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
    expect(guard.text()).toContain('always shown: affects what the data means')
  })

  it('a hidden id the editor cannot see right now stays listed, so it can be shown again', async () => {
    const w = open(base({ hiddenCaveats: ['popup-note'] }))
    const hidden = row(w, 'hidden:popup-note')
    expect(hidden.exists()).toBe(true)
    expect((hidden.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
    await hidden.get('input[type="checkbox"]').setValue(true)
    expect('hiddenCaveats' in (await save(w))).toBe(false)
  })

  it('a hideable legacy caveat id (kept in notes) toggles under its registry id', async () => {
    const w = open(base({ notes: ['min-cohort-caveat'] }))
    await row(w, 'caption:min-cohort-caveat').get('input[type="checkbox"]').setValue(false)
    const out = await save(w)
    expect(out.hiddenCaveats).toEqual(['min-cohort-caveat'])
    expect(out.notes).toEqual(['min-cohort-caveat'])
  })

  it("lists the scope's automatic caveats (D2-B): a hideable one toggles under its id, a data-cut one is locked", async () => {
    const w = open(base({ dataset: 'campaigns', view: 'funnel' }))
    const cohort = row(w, 'caveat:min-cohort-caveat')
    expect((cohort.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
    // the country data cut is listed only where it holds: a card with country columns (B4a)
    expect(row(w, 'caveat:country-split-excludes-refused').exists()).toBe(false)
    await cohort.get('input[type="checkbox"]').setValue(false)
    expect((await save(w)).hiddenCaveats).toEqual(['min-cohort-caveat'])
    const spec: CardSpec = { ...JSON.parse(JSON.stringify(PRESETS['campaign-country'])), captions: [] }
    const country = open(base({ dataset: 'campaigns', type: 'table', card: { spec } }))
    const cut = row(country, 'caveat:country-split-excludes-refused')
    expect((cut.get('input[type="checkbox"]').element as HTMLInputElement).disabled).toBe(true)
  })

  it('an id the chart can never hide gets no "hidden" row; a hideable one still does (NIT-5a)', () => {
    const locked = ['range-notice', 'split-guard', 'refused-whole-days', 'country-split-excludes-refused']
    const w = open(base({ hiddenCaveats: [...locked, 'popup-note'] }))
    for (const id of locked) expect(row(w, `hidden:${id}`).exists()).toBe(false)
    expect(row(w, 'hidden:popup-note').exists()).toBe(true)
    // with the response, the always-shown note is listed once, locked and checked
    const withData = open(base({ hiddenCaveats: locked }), { data: response({}, { splitGuard: true }) })
    const keys = withData.findAll('.caveat-row').map((r) => r.attributes('data-key'))
    expect(keys.filter((k) => k?.includes('split-guard'))).toEqual(['split-guard'])
    expect(keys.some((k) => k?.startsWith('hidden:'))).toBe(false)
    expect((row(withData, 'split-guard').get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
  })

  it('an automatic caveat the chart hides is listed unchecked, never twice', () => {
    const w = open(base({ hiddenCaveats: ['min-cohort-caveat'] }))
    expect((row(w, 'caveat:min-cohort-caveat').get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false)
    expect(row(w, 'hidden:min-cohort-caveat').exists()).toBe(false)
  })
})

describe('ChartEditor: legacy notes (D5 convert-on-edit, N1)', () => {
  const legacy = () => base({ caption: 'Mine.', notes: ['small-sample', 'bogus-id', 'min-cohort-caveat', 'release-before-partial'] })

  it('folds known static ids into the caption on open, keeps unknown and caveat ids, and saves that shape', async () => {
    const w = open(legacy())
    expect((captionBox(w).element as HTMLTextAreaElement).value).toBe(`Mine.\n\n${SMALL}\n\n${RELEASE}`)
    expect(w.find('.caption-converted').exists()).toBe(true)
    const out = await save(w)
    expect(out.caption).toBe(`Mine.\n\n${SMALL}\n\n${RELEASE}`)
    expect(out.notes).toEqual(['bogus-id', 'min-cohort-caveat'])
  })

  it('a folded id also leaves hiddenCaveats, so no dead "hidden" row stays (NIT-5b)', async () => {
    const w = open(base({ caption: 'Mine.', notes: ['small-sample', 'min-cohort-caveat'], hiddenCaveats: ['small-sample', 'popup-note'] }))
    expect((captionBox(w).element as HTMLTextAreaElement).value).toBe('Mine.') // hidden: folded without text
    expect(row(w, 'hidden:small-sample').exists()).toBe(false)
    expect(row(w, 'hidden:popup-note').exists()).toBe(true)
    const out = await save(w)
    expect(out.hiddenCaveats).toEqual(['popup-note'])
    expect(out.notes).toEqual(['min-cohort-caveat'])
    // the last hidden id folded deletes the key
    const only = open(base({ notes: ['small-sample'], hiddenCaveats: ['small-sample'] }))
    const saved = await save(only)
    expect('hiddenCaveats' in saved).toBe(false)
    expect('notes' in saved).toBe(false)
  })

  it("a folded id the card's own spec captions name stays hidden (they share the list, D7)", async () => {
    const spec: CardSpec = { ...JSON.parse(JSON.stringify(PRESETS['campaign-country'])), captions: ['small-sample'] }
    const w = open(base({ dataset: 'campaigns', notes: ['small-sample'], hiddenCaveats: ['small-sample'], card: { spec } }))
    expect((await save(w)).hiddenCaveats).toEqual(['small-sample'])
  })

  it('never changes the chart it was given (Cancel leaves it as it was)', async () => {
    const src = legacy()
    const w = open(src)
    await row(w, 'caption:bogus-id').get('button.caveat-remove').trigger('click')
    await captionBox(w).setValue('changed')
    await w.findAll('.actions button').find((b) => b.text() === 'Cancel')!.trigger('click')
    expect(w.emitted('cancel')).toBeTruthy()
    expect(src.caption).toBe('Mine.')
    expect(src.notes).toEqual(['small-sample', 'bogus-id', 'min-cohort-caveat', 'release-before-partial'])
  })

  it('lists an unknown id as "Unknown note <id>" with Remove; removing the last id deletes notes', async () => {
    const w = open(base({ notes: ['bogus-id'] }))
    const unknown = row(w, 'caption:bogus-id')
    expect(unknown.text()).toContain('Unknown note bogus-id')
    expect(unknown.find('input[type="checkbox"]').exists()).toBe(false)
    expect((await save(w)).notes).toEqual(['bogus-id']) // kept until the author removes it
    await row(w, 'caption:bogus-id').get('button.caveat-remove').trigger('click')
    expect(row(w, 'caption:bogus-id').exists()).toBe(false)
    expect('notes' in (await save(w))).toBe(false)
  })

  it('switching to a note widget keeps an unknown id (no silent drop) and drops the chart-only caption fields', async () => {
    const w = open(base({ notes: ['bogus-id'], caption: 'Mine.', hiddenCaveats: ['popup-note'] }))
    await w.findAll('select').find((s) => s.findAll('option').some((o) => o.attributes('value') === 'note'))!.setValue('note')
    const out = await save(w)
    expect(out.type).toBe('note')
    expect(out.notes).toEqual(['bogus-id'])
    expect('caption' in out).toBe(false)
    expect('hiddenCaveats' in out).toBe(false)
  })
})

describe('ChartEditor: note widget', () => {
  const note = (over: Partial<Widget> = {}) => base({ type: 'note', dataset: undefined, dimension: '', ...over })

  it('shows a text area (no library picker for an id) and inserts library text into it', async () => {
    const w = open(note({ note: 'Intro.' }))
    expect(w.find('.caption-field').exists()).toBe(false)
    expect(w.findAll('select').some((s) => s.text().includes('From the notes library'))).toBe(false)
    await w.get('.note-text select.insert-library').setValue('small-sample')
    const out = await save(w)
    expect(out.note).toBe(`Intro.\n\n${SMALL}`)
    expect(out.noteId).toBeUndefined()
  })

  it('a legacy static noteId still shows read-only, and "Edit as text" turns it into the note text', async () => {
    const w = open(note({ noteId: 'small-sample' }))
    expect(w.get('.library-note').text()).toContain('From the notes library')
    expect(w.find('.note-text textarea').exists()).toBe(false)
    await w.get('button.note-to-text').trigger('click')
    expect((w.get('.note-text textarea').element as HTMLTextAreaElement).value).toBe(SMALL)
    const out = await save(w)
    expect(out.note).toBe(SMALL)
    expect(out.noteId).toBeUndefined()
  })

  it('a caveat noteId keeps following the data until the author replaces it', async () => {
    const w = open(note({ noteId: 'play-tracking-status' }))
    expect(w.get('.library-note').text()).toContain('updates by itself')
    expect((await save(w)).noteId).toBe('play-tracking-status')
    await w.get('button.note-to-text').trigger('click')
    const out = await save(w)
    expect(out.noteId).toBeUndefined()
  })
})

describe('ChartEditor: card spec captions (CardEditor wiring, part B2)', () => {
  const card = () => base({ type: 'table', dataset: 'overview', card: { preset: 'release-before-after' }, hiddenCaveats: ['release-before-partial'] } as Partial<Widget>)

  it('passes hiddenCaveats to CardEditor and writes its update:hidden-captions back (empty deletes the key)', async () => {
    const w = open(card())
    const ce = w.findComponent({ name: 'CardEditor' })
    expect(ce.props('hiddenCaptions')).toEqual(['release-before-partial'])
    ce.vm.$emit('update:hiddenCaptions', ['release-before-partial', 'small-sample'])
    expect((await save(w)).hiddenCaveats).toEqual(['release-before-partial', 'small-sample'])
    w.findComponent({ name: 'CardEditor' }).vm.$emit('update:hiddenCaptions', [])
    expect('hiddenCaveats' in (await save(w))).toBe(false)
  })

  it("keeps only ids hiddenCaveats can store, once each, from CardEditor's update (NIT-4)", async () => {
    const w = open(card())
    w.findComponent({ name: 'CardEditor' }).vm.$emit('update:hiddenCaptions', ['release-before-partial', 'Bad_Id', 'release-before-partial', 'x'.repeat(65)])
    expect((await save(w)).hiddenCaveats).toEqual(['release-before-partial'])
    w.findComponent({ name: 'CardEditor' }).vm.$emit('update:hiddenCaptions', ['Bad_Id'])
    expect('hiddenCaveats' in (await save(w))).toBe(false)
  })

  it(`keeps at most HIDDEN_CAVEATS_MAX (${HIDDEN_CAVEATS_MAX}) ids in the draft (NIT-D)`, async () => {
    const w = open(card())
    const many = Array.from({ length: HIDDEN_CAVEATS_MAX + 8 }, (_, i) => `id-${i}`)
    w.findComponent({ name: 'CardEditor' }).vm.$emit('update:hiddenCaptions', many)
    expect((await save(w)).hiddenCaveats).toEqual(many.slice(0, HIDDEN_CAVEATS_MAX))
  })

  it("the chart's caveat list leaves the card's own spec captions to CardEditor", () => {
    expect(row(open(card()), 'hidden:release-before-partial').exists()).toBe(false)
  })

  // With the real CardEditor (no stub): its fetches fail quietly, which is fine for the form.
  function openReal(widget: Widget) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }))
    const w = mount(ChartEditor, { props: { widget, isNew: false } })
    mounted.push(w)
    return w
  }

  it("the real CardEditor's Hide toggle lands in the saved widget's hiddenCaveats", async () => {
    const w = openReal(base({ type: 'table', dataset: 'overview', card: { preset: 'release-before-after' } } as Partial<Widget>))
    await flushPromises()
    await w.get('button.ce-caption-toggle').trigger('click')
    expect((await save(w)).hiddenCaveats).toEqual(['release-before-partial'])
    vi.unstubAllGlobals()
  })

  it('an unknown spec caption saves unchanged, and N1 Remove drops it', async () => {
    const spec = JSON.parse(JSON.stringify(PRESETS['release-before-after'])) as CardSpec
    spec.captions = [...(spec.captions ?? []), 'no-such-note-b3']
    const w = openReal(base({ type: 'table', dataset: 'overview', card: { spec } } as Partial<Widget>))
    await flushPromises()
    // Slice 1a: an id this build doesn't know is valid as stored, so Save stays on.
    expect(w.get('button.btn-primary').attributes('disabled')).toBeUndefined()
    expect(((await save(w)).card as { spec: CardSpec }).spec.captions).toEqual(['release-before-partial', 'no-such-note-b3'])
    await w.get('button.ce-caption-remove').trigger('click')
    await flushPromises()
    expect(w.get('button.btn-primary').attributes('disabled')).toBeUndefined()
    const out = await save(w)
    expect((out.card as { spec: CardSpec }).spec.captions).toEqual(['release-before-partial'])
    vi.unstubAllGlobals()
  })
})

describe('copies carry caption and hiddenCaveats', () => {
  it('the editor draft is a copy: toggling and typing never touch the widget it was given', async () => {
    const src = base({ caption: 'Mine.', hiddenCaveats: ['popup-note'] })
    const w = open(src)
    await row(w, 'hidden:popup-note').get('input[type="checkbox"]').setValue(true)
    await captionBox(w).setValue('Other.')
    expect(src.hiddenCaveats).toEqual(['popup-note'])
    expect(src.caption).toBe('Mine.')
    const out = await save(w)
    expect(out.caption).toBe('Other.')
  })

  it('an unedited save keeps both fields as they were', async () => {
    const out = await save(open(base({ caption: 'Mine.', hiddenCaveats: ['popup-note'] })))
    expect(out.caption).toBe('Mine.')
    expect(out.hiddenCaveats).toEqual(['popup-note'])
  })

  it('duplicating a page (clonePage) copies both fields onto the new widgets, as separate arrays', () => {
    const wd = base({ caption: 'Mine.', hiddenCaveats: ['popup-note'] })
    const page = { id: 'p1', name: 'P', isDefault: false, filters: { since: '-7d', until: 'now' }, widgets: [wd] } as unknown as DashboardPage
    const copy = clonePage(page, 'Copy').widgets[0]
    expect(copy.caption).toBe('Mine.')
    expect(copy.hiddenCaveats).toEqual(['popup-note'])
    expect(copy.hiddenCaveats).not.toBe(wd.hiddenCaveats)
  })
})
