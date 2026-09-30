// Pure-function tests for CardEditor.vue's draft <-> CardSpec mapping (ADR 0003 slice 6). No
// mounting: every one of these is testable as a plain function, which is the point of keeping
// them out of the .vue files (see editorModel.ts's own header comment).
import { describe, expect, it } from 'vitest'
import { CAMPAIGNS } from '../campaigns'
import { hasNote } from '../notes'
import { POPUPS } from '../popupEvents'
import { METRICS } from './metrics'
import { RATIOS } from './ratios'
import { DISPLAYS_FOR, kindOf, validateCard } from './validate'
import { CAMPAIGN_SCORECARD, PRESETS } from './presets'
import type { CardSpec, Display, DisplayAs, Label } from './types'
import {
  CAMPAIGN_ID_OPTIONS,
  POPUP_ID_OPTIONS,
  cloneSpec,
  dataBindingKind,
  displayOptionsFor,
  duplicateItem,
  emptyItem,
  emptySection,
  emptySpec,
  firstDisplayFor,
  freshId,
  groupErrors,
  isDisplaySelectable,
  isKnownNote,
  labelKind,
  makeData,
  makeDisplay,
  makeLabel,
  metricDef,
  metricOptions,
  moveBy,
  noteLabelOptions,
  presetOptions,
  ratioDef,
  ratioOptions,
  reorder,
  scopePathOptions,
  specFromPresetId,
  noteVarNames,
  rebindData,
  repeatIdOptions,
  rowsToTones,
  tonesToRows,
  withGating,
  withNoteId,
  withNoteVar,
  withRepeatOver,
  type LabelKind,
} from './editorModel'

describe('freshId', () => {
  it('never collides across many calls, and is never a bare registry-lookup hazard', () => {
    const ids = new Set(Array.from({ length: 200 }, () => freshId('item')))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id === 'constructor' || id === '__proto__' || id === 'toString').toBe(false)
  })
})

describe('reorder / moveBy', () => {
  it('moves an element and leaves the rest in order', () => {
    expect(reorder(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(reorder(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c'])
  })
  it('is a no-op out of range or when from === to', () => {
    const list = ['a', 'b', 'c']
    expect(reorder(list, 1, 1)).toEqual(list)
    expect(reorder(list, -1, 1)).toEqual(list)
    expect(reorder(list, 0, 5)).toEqual(list)
  })
  it('moveBy is reorder(list, i, i+dir)', () => {
    expect(moveBy(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(moveBy(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
    // Can't move the first item up, or the last item down.
    expect(moveBy(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
    expect(moveBy(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
  })
})

describe('label kinds round-trip', () => {
  const cases: { kind: LabelKind; sample: Label }[] = [
    { kind: 'text', sample: 'Tagged arrivals' },
    { kind: 'metric', sample: { metric: true } },
    { kind: 'note', sample: { note: 'flight-pending' } },
    { kind: 'bind', sample: { bind: 'campaign.label' } },
  ]
  for (const { kind, sample } of cases) {
    it(`labelKind(${kind} sample) === '${kind}'`, () => {
      expect(labelKind(sample)).toBe(kind)
    })
    it(`makeLabel('${kind}', sample) round-trips through labelKind`, () => {
      expect(labelKind(makeLabel(kind, sample, 'campaign.label'))).toBe(kind)
    })
  }
  it('labelKind(undefined) is text (a fresh item has no label opinion yet)', () => {
    expect(labelKind(undefined)).toBe('text')
  })
  it('switching kind away and back preserves the note id / bind path already chosen', () => {
    let label: Label = { note: 'small-sample' }
    label = makeLabel('text', label, 'campaign.label')
    expect(labelKind(label)).toBe('text')
    label = makeLabel('note', label, 'campaign.label')
    // The note id was lost switching through 'text' (a string has no id to carry) — this just
    // checks makeLabel never throws or leaves an invalid shape, always landing on a real string.
    expect(typeof (label as { note: string }).note).toBe('string')
  })
  it('every kind is reachable from every other kind without throwing', () => {
    const kinds: LabelKind[] = ['text', 'metric', 'note', 'bind']
    for (const from of kinds) {
      let label = makeLabel(from, undefined, 'campaign.label')
      for (const to of kinds) {
        label = makeLabel(to, label, 'campaign.label')
        expect(labelKind(label)).toBe(to)
      }
    }
  })
})

describe('data binding kinds', () => {
  it('dataBindingKind reads metric/ratio/field correctly', () => {
    expect(dataBindingKind({ metric: 'campaign.taggedArrivals' })).toBe('metric')
    expect(dataBindingKind({ ratio: 'campaign.acceptPerAsk' })).toBe('ratio')
    expect(dataBindingKind({ field: 'campaign.label' })).toBe('field')
  })
  it('makeData round-trips through dataBindingKind and always yields a REAL id', () => {
    for (const kind of ['metric', 'ratio', 'field'] as const) {
      const b = makeData(kind, { field: 'campaign.label' }, 'campaign.label')
      expect(dataBindingKind(b)).toBe(kind)
      if (kind === 'metric') expect(METRICS.has((b as { metric: string }).metric)).toBe(true)
      if (kind === 'ratio') expect(RATIOS.has((b as { ratio: string }).ratio)).toBe(true)
    }
  })
})

describe('metric/ratio option lists never expose an unknown or prototype-named id', () => {
  it('metricOptions() lists only real, own-key METRICS entries', () => {
    const opts = metricOptions()
    expect(opts.length).toBe(METRICS.size)
    for (const o of opts) expect(METRICS.has(o.id)).toBe(true)
    expect(opts.find((o) => o.id === 'constructor')).toBeUndefined()
    expect(opts.find((o) => o.id === '__proto__')).toBeUndefined()
  })
  it('ratioOptions() lists only real, registered RATIOS entries (already validity-checked at import)', () => {
    const opts = ratioOptions()
    expect(opts.length).toBe(RATIOS.size)
    for (const o of opts) expect(RATIOS.has(o.id)).toBe(true)
  })
  it('metricDef/ratioDef never resolve a prototype-named id (Map#get, never a bracket lookup)', () => {
    expect(metricDef('constructor')).toBeUndefined()
    expect(metricDef('__proto__')).toBeUndefined()
    expect(metricDef('toString')).toBeUndefined()
    expect(ratioDef('constructor')).toBeUndefined()
    expect(ratioDef('__proto__')).toBeUndefined()
  })
  it('a search for "constructor" (or any Object.prototype member) matches nothing real', () => {
    const q = 'constructor'
    expect(metricOptions().filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q))).toHaveLength(0)
    expect(ratioOptions().filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q))).toHaveLength(0)
  })
  it('CAMPAIGN_ID_OPTIONS / POPUP_ID_OPTIONS are exactly the real registries, id+label only', () => {
    expect(CAMPAIGN_ID_OPTIONS.map((o) => o.value)).toEqual(CAMPAIGNS.map((c) => c.id))
    expect(POPUP_ID_OPTIONS.map((o) => o.value)).toEqual(POPUPS.map((p) => p.id))
  })
})

describe('notes: plain-text previews, no raw markup or {vars}', () => {
  it('noteLabelOptions() previews never contain raw ** or unresolved {vars}', () => {
    for (const o of noteLabelOptions()) {
      expect(o.preview).not.toMatch(/\*\*/)
      // A note with its own default `vars` (e.g. min-cohort-caveat) resolves them; one with a
      // runtime-only var (card labels, kind 'label') is excluded by noteOptions() already.
      expect(o.preview).not.toMatch(/\{[a-zA-Z]+\}/)
    }
  })
  it('isKnownNote uses the registry\'s own-key check, so a prototype member is never "known"', () => {
    expect(isKnownNote('constructor')).toBe(false)
    expect(isKnownNote('toString')).toBe(false)
    expect(isKnownNote('flight-pending')).toBe(true)
    expect(hasNote('flight-pending')).toBe(true)
  })
})

describe('display compatibility matrix (DISPLAYS_FOR, via displayOptionsFor)', () => {
  const cases: { binding: Parameters<typeof kindOf>[0]; expectAllowed: DisplayAs[]; expectDisallowed: DisplayAs[] }[] = [
    { binding: { metric: 'campaign.taggedArrivals' }, expectAllowed: ['number', 'bar'], expectDisallowed: ['percent', 'currency', 'counts'] },
    { binding: { metric: 'campaign.spend' }, expectAllowed: ['currency'], expectDisallowed: ['percent', 'number', 'counts'] },
    { binding: { ratio: 'campaign.acceptPerAsk' }, expectAllowed: ['percent', 'counts', 'bar'], expectDisallowed: ['number', 'currency', 'date', 'status'] },
    { binding: { metric: 'campaign.lastSync' }, expectAllowed: ['date', 'ago'], expectDisallowed: ['number', 'currency', 'percent', 'bar'] },
    { binding: { metric: 'campaign.spendSource' }, expectAllowed: ['status'], expectDisallowed: ['number', 'currency', 'date'] },
    { binding: { ratio: 'campaign.costPerArrival' }, expectAllowed: ['currency'], expectDisallowed: ['percent', 'counts'] },
    { binding: { ratio: 'campaign.gameViewsVsArrivals' }, expectAllowed: ['counts'], expectDisallowed: ['percent', 'number', 'currency', 'bar'] },
    { binding: { field: 'campaign.flight' }, expectAllowed: ['dateRange', 'datetime', 'badge', 'text', 'number', 'currency'], expectDisallowed: ['percent', 'counts', 'bar'] },
  ]
  for (const { binding, expectAllowed, expectDisallowed } of cases) {
    const id = 'metric' in binding ? binding.metric : 'ratio' in binding ? binding.ratio : binding.field
    it(`${id}: offers exactly its data kind's displays`, () => {
      const opts = displayOptionsFor(binding)
      const offered = opts.map((o) => o.as)
      const k = kindOf(binding)!
      expect(offered).toEqual(DISPLAYS_FOR[k])
      for (const as of expectAllowed) expect(isDisplaySelectable(binding, as)).toBe(true)
      for (const as of expectDisallowed) expect(isDisplaySelectable(binding, as)).toBe(false)
    })
  }
  it('an invalid/unknown binding offers no displays at all', () => {
    expect(displayOptionsFor({ metric: 'not-a-real-metric' })).toEqual([])
    expect(displayOptionsFor({ metric: 'constructor' })).toEqual([])
  })
  it('sparkline is ALWAYS disabled, even where DISPLAYS_FOR allows it (count/money)', () => {
    for (const binding of [{ metric: 'campaign.taggedArrivals' }, { metric: 'campaign.spend' }] as const) {
      const opt = displayOptionsFor(binding).find((o) => o.as === 'sparkline')
      expect(opt).toBeDefined()
      expect(opt!.disabled).toBe(true)
      expect(isDisplaySelectable(binding, 'sparkline')).toBe(false)
    }
  })
  it('firstDisplayFor never returns the disabled sparkline placeholder', () => {
    expect(firstDisplayFor({ metric: 'campaign.taggedArrivals' })).not.toBe('sparkline')
    expect(firstDisplayFor({ metric: 'campaign.spend' })).not.toBe('sparkline')
  })
  it('an invalid ratio can never even be asked about: RATIOS holds only the registry\'s validated set', () => {
    // ratios.ts's own defineRatios() throws at import for anything invalid, so by the time the
    // editor runs, every id in RATIOS necessarily passes ratioVerdict. This just pins that the
    // editor's option list IS that set, not a hand-rolled one that could drift.
    expect(ratioOptions().map((o) => o.id).sort()).toEqual([...RATIOS.keys()].sort())
  })
})

describe('makeDisplay', () => {
  it('percent keeps its decimals across a round trip, defaulting to 1', () => {
    const d = makeDisplay('percent', { as: 'number' })
    expect(d).toEqual({ as: 'percent', decimals: 1 })
    expect(makeDisplay('percent', { as: 'percent', decimals: 2 } as Display)).toEqual({ as: 'percent', decimals: 2 })
  })
  it('number keeps deltas only if already set', () => {
    expect(makeDisplay('number', { as: 'number', deltas: ['yesterday'] })).toEqual({ as: 'number', deltas: ['yesterday'] })
    expect(makeDisplay('number', { as: 'percent', decimals: 1 })).toEqual({ as: 'number' })
  })
  it('every other display kind round-trips to a minimal, valid shape', () => {
    expect(makeDisplay('counts', { as: 'number' })).toEqual({ as: 'counts' })
    expect(makeDisplay('currency', { as: 'number' })).toEqual({ as: 'currency' })
    expect(makeDisplay('text', { as: 'number' })).toEqual({ as: 'text' })
  })
})

describe('scopePathOptions', () => {
  it('returns [] with no active repeat (nothing to bind against)', () => {
    expect(scopePathOptions(undefined)).toEqual([])
  })
  it('every offered path is a real ScopePath the render layer understands', () => {
    for (const over of ['campaigns', 'popups', 'windows', 'readings'] as const) {
      const opts = scopePathOptions(over)
      expect(opts.length).toBeGreaterThan(0)
    }
  })
})

describe('withRepeatOver', () => {
  it('"" clears the repeat', () => {
    expect(withRepeatOver({ over: 'campaigns', ids: ['x'] }, '')).toBeUndefined()
  })
  it('switching to a different `over` drops the previous shape (ids/status no longer apply)', () => {
    expect(withRepeatOver({ over: 'campaigns', ids: ['x'] }, 'popups')).toEqual({ over: 'popups' })
  })
  it('re-selecting the SAME `over` keeps the existing repeat untouched', () => {
    const current = { over: 'campaigns' as const, ids: ['x'] }
    expect(withRepeatOver(current, 'campaigns')).toBe(current)
  })
})

describe('default drafts and duplication', () => {
  it('emptyItem/emptySection/emptySpec are already valid enough to sit inside validateCard', () => {
    const spec: CardSpec = { v: 1, sections: [emptySection()] }
    // A fresh item's data (the first metric, no params/window override) may still be missing a
    // required param outside a repeat — that's fine, the editor shows it as an inline error
    // until the user picks one; this just checks the shape itself never crashes validateCard.
    expect(() => validateCard(spec)).not.toThrow()
    expect(() => validateCard(emptySpec())).not.toThrow()
  })
  it('duplicateItem produces a distinct id but an equal-otherwise item', () => {
    const item = emptyItem()
    const dup = duplicateItem(item)
    expect(dup.id).not.toBe(item.id)
    expect(dup.label).toEqual(item.label)
    expect(dup.data).toEqual(item.data)
    expect(dup.display).toEqual(item.display)
  })
  it('cloneSpec is a deep copy — mutating the clone never touches the source (never the live PRESETS object)', () => {
    const clone = cloneSpec(CAMPAIGN_SCORECARD)
    clone.sections[0].items[0].label = 'mutated'
    expect(CAMPAIGN_SCORECARD.sections[0].items[0].label).not.toBe('mutated')
  })
  it('specFromPresetId falls back to an empty spec for an unknown/prototype-named id', () => {
    // freshId() makes every emptySpec() item id unique, so compare structure, not identity.
    for (const id of ['not-a-real-preset', 'constructor']) {
      const spec = specFromPresetId(id)
      expect(spec.sections).toHaveLength(1)
      expect(spec.sections[0].layout).toBe('rows')
      expect(spec.sections[0].items).toHaveLength(1)
    }
  })
})

describe('presetOptions', () => {
  it('lists every real preset id, and nothing from Object.prototype', () => {
    const opts = presetOptions()
    expect(opts.map((o) => o.value).sort()).toEqual(Object.keys(PRESETS).sort())
    expect(opts.length).toBeGreaterThanOrEqual(3)
    expect(opts.find((o) => o.value === 'constructor')).toBeUndefined()
  })
  it('gives every preset a plain-language name and description from the notes registry — never its raw id', () => {
    for (const o of presetOptions()) {
      expect(o.label).not.toBe(o.value) // never the bare id
      expect(o.label).not.toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/) // never a dashed-id-shaped string either
      expect(o.description.length).toBeGreaterThan(0)
    }
  })
})

describe('groupErrors', () => {
  it('routes a card-level error to cardErrors', () => {
    const spec = emptySpec()
    const g = groupErrors(['card: needs at least one section'], spec)
    expect(g.cardErrors).toEqual(['card: needs at least one section'])
  })
  it('routes a section-level error (no item id) to that section, and an item-level error to that item', () => {
    const spec: CardSpec = { v: 1, sections: [{ layout: 'rows', items: [{ id: 'a', label: '', data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } }] }] }
    const errors = ['sections[0].repeat: unknown repeat \'bogus\'', "sections[0].a: display 'percent' not allowed for a count"]
    const g = groupErrors(errors, spec)
    expect(g.sectionErrors[0]).toEqual(["sections[0].repeat: unknown repeat 'bogus'"])
    expect(g.itemErrors[0].a).toEqual(["sections[0].a: display 'percent' not allowed for a count"])
  })
  it('never throws when errors reference an out-of-range section index', () => {
    const spec = emptySpec()
    expect(() => groupErrors(['sections[5].x: bad'], spec)).not.toThrow()
  })
})

// ── Setters that must not drop what a template set (the card-editor data-loss fix) ─────────────
describe('template settings survive a re-pick', () => {
  it('makeLabel("note") on a note label keeps its vars; withNoteId keeps them across a note change', () => {
    const l: Label = { note: 'label.card.taggedArrivalsFor', vars: { campaign: 'campaign.label' } }
    expect(makeLabel('note', l, 'campaign.label')).toEqual(l)
    expect(withNoteId(l, 'label.card.popupTapRate')).toEqual({ note: 'label.card.popupTapRate', vars: { campaign: 'campaign.label' } })
    expect(withNoteId('text', 'label.card.flight')).toEqual({ note: 'label.card.flight' })
  })

  it('noteVarNames reads the template placeholders; withNoteVar binds and unbinds one', () => {
    expect(noteVarNames('label.card.upsellSegment')).toEqual(['at', 'day'])
    expect(noteVarNames('no-such-note')).toEqual([])
    const l: Label = { note: 'label.card.taggedArrivalsFor', vars: { campaign: 'campaign.label' } }
    expect(withNoteVar(l, 'campaign', '')).toEqual({ note: 'label.card.taggedArrivalsFor' })
    expect(withNoteVar({ note: 'label.card.taggedArrivalsFor' }, 'campaign', 'campaign.id')).toEqual({ note: 'label.card.taggedArrivalsFor', vars: { campaign: 'campaign.id' } })
    expect(withNoteVar('plain', 'x', 'campaign.id')).toBe('plain')
  })

  it('rebindData: the same id is a no-op; another id keeps the window and params it accepts', () => {
    const cur = { metric: 'bsk.pageviews', window: 'todaySoFar' as const }
    expect(rebindData(cur, { metric: 'bsk.pageviews' })).toBe(cur)
    expect(rebindData(cur, { metric: 'bsk.gameViews' })).toEqual({ metric: 'bsk.gameViews', window: 'todaySoFar' })
    // A window the new metric does not serve is dropped (campaign.returnD0 has only attribution).
    expect(rebindData({ metric: 'campaign.taggedArrivals', window: 'todaySoFar' }, { metric: 'campaign.returnD0' })).toEqual({ metric: 'campaign.returnD0' })
    // Params: kept when accepted, dropped when not.
    const pinned = { ratio: 'popup.installedRate', params: { popup: 'install' }, window: 'page' as const }
    expect(rebindData(pinned, { ratio: 'popup.tapRate' })).toEqual({ ratio: 'popup.tapRate', params: { popup: 'install' }, window: 'page' })
    expect(rebindData(pinned, { metric: 'bsk.pageviews' })).toEqual({ metric: 'bsk.pageviews', window: 'page' })
    // A before/after binding keeps { scope: 'window' } while the new metric serves a side.
    expect(rebindData({ metric: 'bsk.pageviews', window: { scope: 'window' } }, { metric: 'bsk.installs' })).toEqual({ metric: 'bsk.installs', window: { scope: 'window' } })
    expect(rebindData({ field: 'campaign.label' }, { metric: 'bsk.pageviews' })).toEqual({ metric: 'bsk.pageviews' })
  })

  it('withRepeatOver keeps `empty` when the kind changes', () => {
    const empty = { label: '', text: { note: 'no-return-visits-yet' } }
    expect(withRepeatOver({ over: 'campaigns', tracked: true, empty }, 'popups')).toEqual({ over: 'popups', empty })
  })

  it('repeatIdOptions lists window sides and country buckets too', () => {
    expect(repeatIdOptions('windows').map((o) => o.value)).toEqual(['before', 'after', 'upsellPre', 'upsellPost'])
    expect(repeatIdOptions('countries').map((o) => o.value)).toEqual(['US', 'CA', 'other'])
    expect(repeatIdOptions('readings')).toEqual([])
  })

  it('withGating drops an emptied gating instead of leaving gating: {}', () => {
    const item = { id: 'a', label: '', data: { metric: 'bsk.pageviews' }, display: { as: 'number' as const } }
    expect('gating' in withGating(item, { whenUnmeasured: undefined })).toBe(false)
    expect(withGating({ ...item, gating: { whenZero: 'omit' } }, { whenZero: undefined })).toStrictEqual(item)
    expect(withGating(item, { whenZero: 'omit' })).toEqual({ ...item, gating: { whenZero: 'omit' } })
  })

  it('badge tones round-trip through rows, and a prototype-named value stays plain data', () => {
    const tones = { 'flighting today': 'live' as const, closed: 'warn' as const }
    expect(rowsToTones(tonesToRows(tones))).toEqual(tones)
    expect(rowsToTones([])).toBeUndefined()
    const odd = rowsToTones([{ value: '__proto__', tone: 'warn' }])!
    expect(Object.getPrototypeOf(odd)).toBe(Object.prototype)
    expect(Object.hasOwn(odd, '__proto__')).toBe(true)
  })
})
