// The slice-5 presets as data: valid cards, only registered and valid ratios, every label
// through the notes registry, no beacon path or file path in any text they can show, and a
// preset lookup that never resolves through Object.prototype. Their rendered parity with the
// bespoke Overview body is components/metrics/presets.parity.test.ts.
import { describe, expect, it } from 'vitest'
import { noteRawText, NOTES_REGISTRY } from '../notes'
import { BSK_KPIS, CAMPAIGN_SCORECARD, PRESETS, presetById } from './presets'
import { defineRatios, RATIO_DEFS, RATIOS, ratioVerdict } from './ratios'
import { validateCard } from './validate'
import type { CardSpec, Label, MetricItem } from './types'

/** Every preset id: slice 5's two, and slice 7's (the panels they replaced). */
const PRESET_IDS = ['bsk-kpis', 'campaign-scorecard', 'release-before-after', 'popup-rates', 'signin-eligibility', 'campaign-cost'] as const
const items = (spec: CardSpec): MetricItem[] => spec.sections.flatMap((s) => s.items)
const labelNoteIds = (l: Label | undefined): string[] => (l && typeof l === 'object' && 'note' in l ? [l.note] : [])

describe('presets', () => {
  it('every preset (slices 5 and 7) is registered and passes validateCard', () => {
    expect(Object.keys(PRESETS).sort()).toEqual([...PRESET_IDS].sort())
    expect(validateCard(CAMPAIGN_SCORECARD)).toEqual([])
    expect(validateCard(BSK_KPIS)).toEqual([])
    for (const [id, spec] of Object.entries(PRESETS)) expect(validateCard(spec), id).toEqual([])
  })

  it('the ratio check at import passes, and every ratio a preset names is registered and valid', () => {
    expect(() => defineRatios(RATIO_DEFS)).not.toThrow()
    for (const spec of Object.values(PRESETS)) {
      for (const it of items(spec)) {
        if (!('ratio' in it.data)) continue
        const r = RATIOS.get(it.data.ratio)
        expect(r, it.data.ratio).toBeDefined()
        expect(ratioVerdict(r!).ok, it.data.ratio).toBe(true)
        if (it.display.as === 'percent') expect(r!.kind, `${it.id} shows a percent`).toBe('proportion')
      }
    }
  })

  it('every label goes through the notes registry — never a literal string', () => {
    for (const spec of Object.values(PRESETS)) {
      for (const it of items(spec)) {
        expect(typeof it.label, `${it.id} label`).not.toBe('string')
        for (const id of [...labelNoteIds(it.label), ...labelNoteIds(it.caption), ...labelNoteIds(it.repeat?.empty?.label), ...labelNoteIds(it.repeat?.empty?.text)]) {
          expect(Object.hasOwn(NOTES_REGISTRY, id), id).toBe(true)
        }
      }
    }
  })

  it('no text a preset can show contains a beacon path or a file path', () => {
    const ids = new Set<string>(['flight-pending', 'no-campaign-flighting', 'not-yet-tracking', 'still-arriving', 'counted-from', 'install-fix-note', 'new-today', 'too-few-to-report', 'arrivals-caveat', 'raw-install-dedupe'])
    for (const spec of Object.values(PRESETS)) {
      for (const it of items(spec)) {
        for (const id of [...labelNoteIds(it.label), ...labelNoteIds(it.caption), ...labelNoteIds(it.repeat?.empty?.label), ...labelNoteIds(it.repeat?.empty?.text), ...(it.gating?.whenEmpty && typeof it.gating.whenEmpty === 'object' ? [it.gating.whenEmpty.note] : [])]) ids.add(id)
        const id = 'metric' in it.data ? it.data.metric : 'ratio' in it.data ? it.data.ratio : null
        if (id) ids.add(`label.${id}`)
      }
    }
    for (const id of ids) {
      const t = noteRawText(id, { from: '2026-09-26', campaign: 'x', n: 1 })
      expect(t, id).not.toBe('')
      expect(t, id).not.toMatch(/\/(return|install|game|popup-outcome|auth|signin-prompt|promo-first50)\b|\*|\.(ts|vue|js)\b|src\//)
    }
  })

  it('the KPI tiles show freshness in the header, and every caveat-carrying item hands it to the card notes', () => {
    expect(BSK_KPIS.showUpdated).toBe('header')
    for (const spec of Object.values(PRESETS)) {
      // The one deliberate exception: the cost card's "stale — sync pending" line stays visible
      // under the spend-through date, as the old freshness line showed it.
      for (const it of items(spec)) if (!('field' in it.data) && !(spec === PRESETS['campaign-cost'] && it.id === 'through')) expect(it.captionMode, it.id).toBe('compact')
    }
  })

  it('presetById only answers real preset ids — never an Object.prototype member', () => {
    expect(presetById('campaign-scorecard')).toBe(CAMPAIGN_SCORECARD)
    expect(presetById('bsk-kpis')).toBe(BSK_KPIS)
    for (const id of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf', '', 'nope']) expect(presetById(id), id).toBeUndefined()
    expect(presetById(42)).toBeUndefined()
    expect(Object.getPrototypeOf(PRESETS)).toBeNull()
  })
})

describe('validateCard: the slice-5 fields', () => {
  const base: CardSpec = { v: 1, sections: [{ layout: 'tiles', items: [{ id: 'x', label: { metric: true }, data: { metric: 'bsk.pageviews', window: 'todaySoFar' }, display: { as: 'number' } }] }] }
  it("accepts captionMode inline/compact and showUpdated true, 'header' or 'footer'", () => {
    for (const showUpdated of [true, false, 'header', 'footer'] as const) expect(validateCard({ ...base, showUpdated })).toEqual([])
    expect(validateCard({ ...base, showUpdated: true, sections: [{ ...base.sections[0], items: [{ ...base.sections[0].items[0], captionMode: 'compact' }] }] })).toEqual([])
    expect(validateCard({ ...base, sections: [{ ...base.sections[0], items: [{ ...base.sections[0].items[0], captionMode: 'inline' }] }] })).toEqual([])
  })
  it('rejects anything else', () => {
    expect(validateCard({ ...base, showUpdated: 'yes' } as unknown as CardSpec)).toContain("card: showUpdated must be a boolean, 'header' or 'footer'")
    expect(validateCard({ ...base, sections: [{ ...base.sections[0], items: [{ ...base.sections[0].items[0], captionMode: 'tooltip' }] }] } as unknown as CardSpec).join('\n')).toMatch(/captionMode must be 'inline' or 'compact'/)
  })
})
