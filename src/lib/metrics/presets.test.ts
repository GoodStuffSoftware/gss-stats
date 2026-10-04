// The slice-5 presets as data: valid cards, only registered and valid ratios, every label
// through the notes registry, no beacon path or file path in any text they can show, and a
// preset lookup that never resolves through Object.prototype. Their rendered parity with the
// bespoke Overview body is components/metrics/presets.parity.test.ts.
import { describe, expect, it } from 'vitest'
import { noteRawText, NOTES_REGISTRY } from '../notes'
import { ADS_READINGS_LOG, BSK_KPIS, CAMPAIGN_SCORECARD, PRESETS, presetById } from './presets'
import { defineRatios, RATIO_DEFS, RATIOS, ratioVerdict } from './ratios'
import { validateCard } from './validate'
import { isReadingCountPath, READING_COUNT_PATHS, type CardSpec, type Label, type MetricItem, type ScopePath } from './types'

/** Every preset id: slice 5's two, slice 7's (the panels they replaced), R-2's two (picker only), slice 3's readings log, and R-4's Play installs. */
const PRESET_IDS = ['bsk-kpis', 'campaign-scorecard', 'release-before-after', 'popup-rates', 'signin-eligibility', 'campaign-cost', 'campaign-funnel', 'campaign-country', 'campaign-returns', 'retention-verdict', 'campaign-engagement', 'ads-readings-log', 'play-installs'] as const
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

  // validateCard checks only a note id's shape now (a newer build's id must load), so a typo in a
  // preset would render as nothing: every { note } and caption anywhere in a preset must exist.
  it('every note id anywhere in a preset (labels, titles, captions, whenEmpty) is registered', () => {
    const found: string[] = []
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk)
      if (!v || typeof v !== 'object') return
      const o = v as Record<string, unknown>
      if (typeof o.note === 'string') found.push(o.note)
      if (Array.isArray(o.captions)) for (const c of o.captions) if (typeof c === 'string') found.push(c)
      Object.values(o).forEach(walk)
    }
    walk(Object.values(PRESETS))
    expect(found.length).toBeGreaterThan(10)
    expect(found.filter((id) => !Object.hasOwn(NOTES_REGISTRY, id))).toEqual([])
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
      // And the readings log: a card's compact notes are built once, at setup, before the readings
      // (and their freshness) arrive, so its spend rows keep their captions inline.
      for (const it of items(spec)) if (!('field' in it.data) && !(spec === PRESETS['campaign-cost'] && it.id === 'through') && spec !== PRESETS['ads-readings-log']) expect(it.captionMode, it.id).toBe('compact')
      if (spec === PRESETS['ads-readings-log']) for (const it of items(spec)) expect(it.captionMode, it.id).not.toBe('compact')
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

describe('ads-readings-log (ADR 0005 slice 3)', () => {
  const log = ADS_READINGS_LOG
  const table = log.sections.find((s) => s.layout === 'table')!
  const fieldOf = (it: MetricItem): string | null => ('field' in it.data ? String(it.data.field) : null)

  it('is the readings table: ten columns in the old widget order, default limit 30, a campaign card each', () => {
    expect(log.repeat?.over).toBe('campaigns')
    expect(table.repeat).toMatchObject({ over: 'readings', limit: 30 })
    expect(table.items.map((i) => i.id)).toEqual(['read', 'kind', 'spend', 'rules', 'proposal', 'arrivals', 'asks', 'accepts', 'auth', 'signUps'])
    expect(log.actions).toEqual(['ads-refresh'])
    expect(log.notices).toBe('ads-readings')
  })

  it('never uses compact captions (the card builds its notes once, readings arrive later)', () => {
    for (const it of items(log)) expect(it.captionMode, it.id).not.toBe('compact')
  })

  it('reads counts only: its count paths are inside the allow-list, and nothing names a refused count, a time, a place or a device', () => {
    const counts = items(log).map(fieldOf).filter((f): f is string => !!f && f.startsWith('reading.count.'))
    expect(counts.sort()).toEqual(['reading.count.accepts', 'reading.count.arrivals', 'reading.count.asks', 'reading.count.auth', 'reading.count.signUps'])
    for (const p of counts) expect(isReadingCountPath(p), p).toBe(true)
    expect([...READING_COUNT_PATHS].sort()).toEqual(['reading.count.accepts', 'reading.count.arrivals', 'reading.count.asks', 'reading.count.auth', 'reading.count.signUpsAtMost'])
    // no generic count path, no refused-count words, no hour / place / device in any binding or id
    const everything = JSON.stringify(log)
    expect(everything).not.toMatch(/reading\.count\.\*|return|gamestart|game-start|tutorial|tour|hour|country|device|visitor|platform|placement/i)
    for (const f of items(log).map(fieldOf)) if (f?.startsWith('reading.')) expect(/^reading\.(readAt|kind|spend|rules|proposal)$/.test(f) || isReadingCountPath(f), f).toBe(true)
  })

  it('validateCard refuses a count path outside the allow-list, so a saved spec cannot widen it', () => {
    const widen = (field: string): CardSpec => ({ ...log, sections: [{ ...table, items: [{ id: 'x', label: 'X', data: { field: field as ScopePath }, display: { as: 'number' } }] }] })
    for (const field of ['reading.count.returnD0Web', 'reading.count.gameStart', 'reading.count.anything']) expect(validateCard(widen(field)).join('\n'), field).toMatch(/reading\.count/)
    expect(validateCard(widen('reading.count.asks'))).toEqual([])
  })

  it('validateCard checks the new fields: notices is a known value, withActivity is true and for campaigns only', () => {
    expect(validateCard({ ...log, notices: 'ads-readings' })).toEqual([])
    expect(validateCard({ ...log, notices: 'other' } as unknown as CardSpec).join('\n')).toMatch(/notices must be one of/)
    expect(validateCard({ ...log, repeat: { over: 'campaigns', withActivity: false } } as unknown as CardSpec).join('\n')).toMatch(/withActivity/)
    expect(validateCard({ ...log, repeat: { over: 'countries', withActivity: true } } as unknown as CardSpec).join('\n')).toMatch(/withActivity/)
  })
})
