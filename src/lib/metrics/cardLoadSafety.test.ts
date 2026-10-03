// Card-load safety (next-phases plan, Phase 2 + slice 1a): the editor's Save gate and the load
// path (normCardRef) share one limits check, cardLimitProblems, so a card the editor saves always
// loads; and a note id this build doesn't know (a newer build's) is kept on load and save instead
// of turning the card into the "can't be shown" placeholder that the next save would write.
import { describe, expect, it } from 'vitest'
import { CARD_LIMITS, INVALID_CARD_PRESET, NOTE_ID_RE, cardLimitProblems, normCardRef, validateCard } from './validate'
import { PRESETS } from './presets'
import { BADGE_TONE_MAX, toggledCaptions } from './editorModel'
import { NOTES_REGISTRY } from '../notes'
import { CONFIG_VERSION, normalizeConfig } from '../defaults'
import type { CardSpec } from './types'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const tones = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`status ${i}`, 'live' as const]))
/** The campaign scorecard (it has a badge with tones) as a saved custom card. */
const scorecard = (): CardSpec => clone(PRESETS['campaign-scorecard'])
const withTones = (n: number): CardSpec => {
  const s = scorecard()
  ;(s.badge!.display as { tones?: Record<string, string> }).tones = tones(n)
  return s
}
const textItem = (id: string, label = 'x') => ({ id, label, data: { field: 'campaign.label' }, display: { as: 'text' } })
const rowsCard = (items: unknown[], sections = 1): CardSpec => ({ v: 1, repeat: { over: 'campaigns' }, sections: Array.from({ length: sections }, () => ({ layout: 'rows', items })) }) as unknown as CardSpec
const nested = (depth: number): unknown => (depth <= 0 ? 1 : { a: nested(depth - 1) })

/** The limits check normCardRef ran before this change (copied verbatim from 0.13.2), for the
 * parity test below: the new shared check must accept and refuse exactly the same cards. */
function withinLimitsOld(v: unknown, depth = 0): boolean {
  if (depth > 12) return false
  if (typeof v === 'string') return v.length <= 200
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'boolean' || v === null) return true
  if (Array.isArray(v)) return v.length <= 64 && v.every((x) => withinLimitsOld(x, depth + 1))
  if (typeof v === 'object') return Object.keys(v as object).length <= 32 && Object.values(v as object).every((x) => withinLimitsOld(x, depth + 1))
  return false
}
function oldLimitsOk(raw: unknown): boolean {
  try {
    const text = JSON.stringify(raw)
    if (typeof text !== 'string' || text.length > 16 * 1024) return false
    const spec = JSON.parse(text)
    if (!withinLimitsOld(spec) || !Array.isArray(spec.sections) || spec.sections.length > 8) return false
    const items = spec.sections.reduce((n: number, sec: any) => n + (Array.isArray(sec?.items) ? sec.items.length : Infinity), 0)
    return items <= 40
  } catch {
    return false
  }
}
/** A small seeded PRNG, so the generated cases are the same on every run. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
}
function junk(r: () => number, depth: number): unknown {
  const k = r()
  if (depth > 14 || k < 0.2) return r() < 0.5 ? 'x'.repeat(Math.floor(r() * 2) ? 200 : 201) : Math.floor(r() * 100)
  if (k < 0.3) return [null, true, false, 'ok', -1.5][Math.floor(r() * 5)]
  if (k < 0.6) return Array.from({ length: [0, 1, 3, 64, 65][Math.floor(r() * 5)] }, (_, i) => (i === 0 ? junk(r, depth + 1) : 1))
  const n = [0, 2, 32, 33][Math.floor(r() * 4)]
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i === 0 ? junk(r, depth + 1) : i]))
}
/** Cards around every limit, plus the presets and junk: the cases the gates are compared on. */
function cases(): [string, unknown][] {
  const out: [string, unknown][] = Object.entries(PRESETS).map(([id, s]) => [`preset ${id}`, clone(s)])
  out.push(['32 tones', withTones(32)], ['33 tones', withTones(33)])
  out.push(['label of 200', rowsCard([textItem('a', 'x'.repeat(200))])], ['label of 201', rowsCard([textItem('a', 'x'.repeat(201))])])
  out.push(['40 items', rowsCard(Array.from({ length: 40 }, (_, i) => textItem(`i${i}`)))], ['41 items', rowsCard(Array.from({ length: 41 }, (_, i) => textItem(`i${i}`)))])
  out.push(['8 sections', rowsCard([textItem('a')], 8)], ['9 sections', rowsCard([textItem('a')], 9)])
  out.push(['64 captions', { ...scorecard(), captions: Array(64).fill('arrivals-caveat') }], ['65 captions', { ...scorecard(), captions: Array(65).fill('arrivals-caveat') }])
  out.push(['depth 12', { ...scorecard(), extra: nested(11) }], ['depth 13', { ...scorecard(), extra: nested(12) }])
  out.push(['16 KiB', { ...scorecard(), pad: 'x' }], ['over 16 KiB', rowsCard(Array.from({ length: 40 }, (_, i) => textItem(`i${i}`, 'x'.repeat(200))), 2)])
  out.push(['a section with no items', { v: 1, sections: [{ layout: 'rows' }] }], ['sections not a list', { v: 1, sections: 'nope' }])
  out.push(['null', null], ['a number', 7], ['a string', 'card'], ['an infinite number', { v: 1, sections: [], n: 1 / 0 }])
  const r = rng(20261003)
  for (let i = 0; i < 400; i++) out.push([`junk ${i}`, { v: 1, sections: [{ layout: 'rows', items: [textItem('a')] }], junk: junk(r, 1) }])
  for (let i = 0; i < 100; i++) out.push([`junk spec ${i}`, junk(r, 0)])
  return out
}

describe('cardLimitProblems: each limit, at and one past it', () => {
  it.each([
    ['badge colours', withTones(32), withTones(33), /^Badge colours: up to 32 \(this card has 33\)$/],
    ['a string', rowsCard([textItem('a', 'x'.repeat(200))]), rowsCard([textItem('a', 'x'.repeat(201))]), /^sections\[0\]\.a\.label: up to 200 characters \(this is 201\)$/],
    ['items', rowsCard(Array.from({ length: 40 }, (_, i) => textItem(`i${i}`))), rowsCard(Array.from({ length: 41 }, (_, i) => textItem(`i${i}`))), /up to 40 items in all \(this card has 41\)/],
    ['sections', rowsCard([textItem('a')], 8), rowsCard([textItem('a')], 9), /up to 8 sections \(this card has 9\)/],
    ['a list', { ...scorecard(), captions: Array(64).fill('arrivals-caveat') }, { ...scorecard(), captions: Array(65).fill('arrivals-caveat') }, /^card\.captions: up to 64 entries \(this has 65\)$/],
    ['nesting', { ...scorecard(), extra: nested(11) }, { ...scorecard(), extra: nested(12) }, /nested more than 12 levels deep/],
  ] as const)('%s', (_n, at, past, msg) => {
    expect(cardLimitProblems(at)).toEqual([])
    expect(cardLimitProblems(past).join('\n')).toMatch(msg)
    // The load path refuses each one too, not only cardLimitProblems on its own.
    expect(normCardRef({ spec: past })).toEqual({ preset: INVALID_CARD_PRESET })
    if (!validateCard(at as CardSpec).length) expect(normCardRef({ spec: at })).toEqual({ spec: at })
  })
  it('the JSON size', () => {
    const big = rowsCard(Array.from({ length: 40 }, (_, i) => textItem(`i${i}`, 'x'.repeat(200))), 2)
    expect(JSON.stringify(big).length).toBeGreaterThan(CARD_LIMITS.jsonBytes)
    expect(cardLimitProblems(big).join('\n')).toMatch(/too large to save/)
  })
  it('never throws, whatever it is given', () => {
    const cyclic: any = { v: 1, sections: [] }
    cyclic.self = cyclic
    for (const x of [undefined, null, 7, 'x', [], cyclic, { v: 1, sections: [null] }, { toJSON: () => { throw new Error('no') } }]) expect(() => cardLimitProblems(x)).not.toThrow()
    expect(cardLimitProblems(cyclic)).toEqual(['card: not plain data'])
  })
  it('the editor\'s colour cap is the load limit', () => {
    expect(BADGE_TONE_MAX).toBe(CARD_LIMITS.objectKeys)
    expect(BADGE_TONE_MAX).toBe(32)
  })
})

describe('parity: the shared check accepts and refuses exactly what normCardRef refused before', () => {
  it('over the presets, each limit at and past it, and generated junk', () => {
    const all = cases()
    expect(all.length).toBeGreaterThan(500)
    const mismatches = all.filter(([, spec]) => oldLimitsOk(spec) !== (cardLimitProblems(spec).length === 0)).map(([n]) => n)
    expect(mismatches).toEqual([])
    // both outcomes are exercised, so the comparison means something
    expect(all.some(([, s]) => oldLimitsOk(s))).toBe(true)
    expect(all.some(([, s]) => !oldLimitsOk(s))).toBe(true)
  })
})

describe('the editor gate passes ⇒ the card loads', () => {
  it('every case the Save gate lets through loads back as the same spec', () => {
    let passed = 0
    for (const [n, spec] of cases()) {
      if (!spec || typeof spec !== 'object') continue
      if (cardLimitProblems(spec).length || validateCard(spec as CardSpec).length) continue
      passed++
      expect(normCardRef({ spec }), n).toEqual({ spec })
    }
    expect(passed).toBeGreaterThan(10)
  })
  it('32 badge colours load; 33 are the placeholder (and the editor refuses to save them)', () => {
    expect(normCardRef({ spec: withTones(32) })).toEqual({ spec: withTones(32) })
    expect(normCardRef({ spec: withTones(33) })).toEqual({ preset: INVALID_CARD_PRESET })
    expect(cardLimitProblems(withTones(33))).not.toEqual([])
  })
})

describe('slice 1a: a note id this build does not know is kept, not refused', () => {
  const FUTURE = 'label.future.noteFromANewerBuild'
  const unknownNotes = (): CardSpec => {
    const s = scorecard()
    s.captions = ['arrivals-caveat', 'future-caveat-v99']
    const item = s.sections[0].items[0] as any
    item.label = { note: FUTURE }
    item.gating = { ...(item.gating ?? {}), whenEmpty: { note: 'future.empty' } }
    return s
  }
  it('every registry id is a well-shaped id', () => {
    const bad = Object.keys(NOTES_REGISTRY).filter((id) => !NOTE_ID_RE.test(id))
    expect(bad).toEqual([])
  })
  it('unknown caption, label and whenEmpty ids validate and load byte-equal', () => {
    const spec = unknownNotes()
    expect(validateCard(spec)).toEqual([])
    const out = normCardRef({ spec: clone(spec) }) as { spec: CardSpec }
    expect(JSON.stringify(out.spec)).toBe(JSON.stringify(spec))
  })
  it.each([
    ['empty', ''],
    ['a space', 'has space'],
    ['a leading dot', '.x'],
    ['a slash', 'a/b'],
    ['too long', 'a'.repeat(65)],
    ['not a string', 7],
    ['null', null],
  ] as const)('a badly-shaped id (%s) is still refused, as a label, a caption and a whenEmpty', (_n, id) => {
    const asLabel = scorecard()
    ;(asLabel.sections[0].items[0] as any).label = { note: id }
    expect(validateCard(asLabel).join('\n')).toMatch(/is not a note id/)
    expect(normCardRef({ spec: asLabel })).toEqual({ preset: INVALID_CARD_PRESET })
    const asCaption = { ...scorecard(), captions: [id] } as unknown as CardSpec
    expect(validateCard(asCaption).join('\n')).toMatch(/card\.captions: .* is not a note id/)
    const asEmpty = scorecard()
    ;(asEmpty.sections[0].items[0] as any).gating = { whenEmpty: { note: id } }
    expect(validateCard(asEmpty).join('\n')).toMatch(/gating\.whenEmpty: .* is not a note id/)
  })
  it('captions that are not a list are still refused', () => {
    expect(validateCard({ ...scorecard(), captions: 'arrivals-caveat' } as unknown as CardSpec)).toContain('card.captions: must be a list of note ids')
  })

  it('an older tab loads and saves a layout without losing unknown ids or any persisted field', () => {
    // Every field the plan names as persisted: fit, a sparkline display, repeat.organic,
    // repeat.empty, captions (with an unknown id) and badge tones.
    const spec = unknownNotes()
    spec.repeat = { ...spec.repeat!, organic: true, empty: { label: '', text: { note: 'future.nothingYet' } } } as any
    ;(spec.badge!.display as any).tones = tones(32)
    spec.sections[0].items.push({ id: 'trend', label: { metric: true }, data: { metric: 'bsk.pageviews', window: 'page' }, display: { as: 'sparkline', series: 'daily' } } as any)
    expect(validateCard(spec)).toEqual([])
    expect(cardLimitProblems(spec)).toEqual([])
    const widget = { id: 'w', title: 'Mine', type: 'card', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 6, h: 6, fit: 'content', card: { spec: clone(spec) } }
    const stored = { version: CONFIG_VERSION, activePageId: 'p', pages: [{ id: 'p', name: 'P', filters: {}, widgets: [widget] }] }
    const once = normalizeConfig(clone(stored) as any)
    const w1 = once.pages.find((p) => p.id === 'p')!.widgets.find((x) => x.id === 'w')!
    expect(once.version).toBe(CONFIG_VERSION)
    expect(w1.fit).toBe('content')
    expect(JSON.stringify((w1.card as { spec: CardSpec }).spec)).toBe(JSON.stringify(spec))
    // save (JSON) and load again: still the same bytes
    const twice = normalizeConfig(JSON.parse(JSON.stringify(once)))
    const w2 = twice.pages.find((p) => p.id === 'p')!.widgets.find((x) => x.id === 'w')!
    expect(JSON.stringify(w2.card)).toBe(JSON.stringify(w1.card))
    expect(w2.fit).toBe('content')
  })
})

describe('toggledCaptions: the editor never drops a stored caption it does not offer', () => {
  const offered = ['a', 'b', 'c']
  it('ticking and unticking an offered note keeps the unknown ids, in their stored order', () => {
    expect(toggledCaptions(['future-2', 'b', 'future-1'], offered, 'a', true)).toEqual(['a', 'b', 'future-2', 'future-1'])
    expect(toggledCaptions(['future-2', 'b', 'future-1'], offered, 'b', false)).toEqual(['future-2', 'future-1'])
  })
  it('offered notes follow the offered order', () => {
    expect(toggledCaptions(['c'], offered, 'a', true)).toEqual(['a', 'c'])
    expect(toggledCaptions([], offered, 'b', true)).toEqual(['b'])
  })
})
