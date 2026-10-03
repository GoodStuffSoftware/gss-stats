// Layout version LAYOUT_VERSIONS.captions (notes plan, slice 1c): a widget may carry its own
// plain-text `caption` and a `hiddenCaveats` list. normWidget whitelists and caps both; no stored
// layout is rewritten (decision D5: legacy `notes` ids convert on the chart's next edit). Tests use
// the LAYOUT_VERSIONS key, never a literal, so whichever slice lands second only renumbers the map.
import { describe, expect, it } from 'vitest'
import {
  CAPTION_MAX_CHARS,
  CONFIG_VERSION,
  HIDDEN_CAVEATS_MAX,
  LAYOUT_VERSIONS,
  defaultConfig,
  normalizeConfig,
} from './defaults'
import { PRESETS } from './metrics/presets'
import { validateCard } from './metrics/validate'
import type { CardSpec } from './metrics/types'
import type { DashboardConfig, DashboardPage, Widget } from '../types'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const json = (x: unknown) => JSON.parse(JSON.stringify(x))

/** A stored config at `version`: the default Overview plus a page `p1` holding `widgets`. */
const stored = (version: number, widgets: unknown[]): DashboardConfig => {
  const base = clone(defaultConfig())
  const page: DashboardPage = { ...clone(base.pages[0]), id: 'p1', name: 'One', isDefault: false, widgets: clone(widgets) as Widget[] }
  return { ...base, version, activePageId: base.pages[0].id, pages: [base.pages[0], page] }
}
const widgetsOf = (cfg: DashboardConfig) => cfg.pages.find((p) => p.id === 'p1')!.widgets
const load = (w: Record<string, unknown>, version = CONFIG_VERSION) => widgetsOf(normalizeConfig(stored(version, [w])))[0]

const BASE = { id: 'w1', i: 'w1', title: 'Pageviews', type: 'stat', dataset: 'geo', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3 }

describe('captions: the layout version', () => {
  it('is the newest layout version and the one this code writes', () => {
    expect(LAYOUT_VERSIONS.captions).toBeGreaterThan(LAYOUT_VERSIONS.dateEtTrends)
    expect(CONFIG_VERSION).toBe(LAYOUT_VERSIONS.captions)
    expect(CONFIG_VERSION).toBe(Math.max(...Object.values(LAYOUT_VERSIONS)))
    expect(defaultConfig().version).toBe(LAYOUT_VERSIONS.captions)
  })
})

describe('captions: normWidget limits', () => {
  it(`keeps a caption up to ${CAPTION_MAX_CHARS} characters, and cuts a longer one to exactly that, never dropping it`, () => {
    expect(CAPTION_MAX_CHARS).toBe(2000)
    const exact = 'a'.repeat(CAPTION_MAX_CHARS)
    expect(load({ ...BASE, caption: exact }).caption).toBe(exact)
    const long = 'b'.repeat(CAPTION_MAX_CHARS - 1) + 'cdef'
    expect(load({ ...BASE, caption: long }).caption).toBe(long.slice(0, CAPTION_MAX_CHARS))
    expect(load({ ...BASE, caption: 'Hi **there** {=x}' }).caption).toBe('Hi **there** {=x}')
  })

  it('drops a caption that is empty or not a string', () => {
    for (const caption of ['', 5, null, ['x'], { t: 'x' }, true]) expect('caption' in load({ ...BASE, caption }), String(caption)).toBe(false)
  })

  it(`hiddenCaveats keeps well-formed ids only (/^[a-z0-9-]{1,64}$/), deduped, at most ${HIDDEN_CAVEATS_MAX}, in order`, () => {
    expect(HIDDEN_CAVEATS_MAX).toBe(32)
    const raw = ['popup-note', 'Popup-Note', 'small-sample', 'popup-note', '', 'a:b', 'caption:x', 'a b', 7, null, 'x'.repeat(64), 'y'.repeat(65), 'min-cohort-caveat']
    expect(load({ ...BASE, hiddenCaveats: raw }).hiddenCaveats).toEqual(['popup-note', 'small-sample', 'x'.repeat(64), 'min-cohort-caveat'])
    const many = Array.from({ length: 40 }, (_, i) => `id-${i}`)
    expect(load({ ...BASE, hiddenCaveats: [...many, ...many] }).hiddenCaveats).toEqual(many.slice(0, HIDDEN_CAVEATS_MAX))
  })

  it('drops hiddenCaveats that is not an array or keeps nothing', () => {
    for (const hiddenCaveats of [[], ['BAD', ''], 'popup-note', { a: 1 }, null]) expect('hiddenCaveats' in load({ ...BASE, hiddenCaveats }), JSON.stringify(hiddenCaveats)).toBe(false)
  })

  it('absent stays absent: a widget that never had them gains no keys, and no default widget has them', () => {
    const w = load({ ...BASE })
    expect('caption' in w).toBe(false)
    expect('hiddenCaveats' in w).toBe(false)
    for (const p of normalizeConfig(defaultConfig()).pages)
      for (const dw of p.widgets) {
        expect('caption' in dw, dw.id).toBe(false)
        expect('hiddenCaveats' in dw, dw.id).toBe(false)
      }
  })
})

describe('captions: a config round-trip through normalizeConfig keeps every field as it was', () => {
  const SPARK = { as: 'sparkline', series: 'daily' } as const
  /** campaign-returns (repeat.organic and repeat.empty) with its d0 item drawn as a daily sparkline. */
  function sparkReturns(): CardSpec {
    const spec = clone(PRESETS['campaign-returns'])
    const d0 = spec.sections[0].items.find((i) => i.id === 'd0')!
    d0.data = { metric: 'campaign.taggedArrivals' }
    d0.display = { ...SPARK }
    return spec
  }
  /** campaign-scorecard (badge tones, item repeat.empty) given the release-before-partial caption. */
  const scorecard = (): CardSpec => ({ ...clone(PRESETS['campaign-scorecard']), captions: ['release-before-partial'] })

  const specOf = (w: Widget): CardSpec => (w.card as { spec: CardSpec }).spec
  const widgets = (): Widget[] => [
    // A chart: its own caption (with a value token), hidden caveats, legacy notes with unknown ids, fit.
    {
      ...BASE,
      id: 'chart',
      i: 'chart',
      caption: 'Counts **all** sites. Today: {=today.pageviews}',
      hiddenCaveats: ['popup-note', 'small-sample', 'range-notice'],
      notes: ['small-sample', 'not-a-note', 'also-gone'],
      fit: 'content',
    },
    // A custom card: a daily sparkline item, repeat.organic + repeat.empty, fit, hidden spec caption.
    { ...BASE, id: 'returns', i: 'returns', type: 'table', card: { spec: sparkReturns(), from: 'campaign-returns' }, fit: 'content', hiddenCaveats: ['no-return-visits-yet'] },
    // A custom card with badge tones and a spec caption it hides (D7).
    { ...BASE, id: 'score', i: 'score', type: 'table', card: { spec: scorecard(), from: 'campaign-scorecard' }, caption: 'Mine.', hiddenCaveats: ['release-before-partial'] },
    // A custom card with an item-level repeat.empty (bsk-kpis' flighting-today item).
    { ...BASE, id: 'kpis', i: 'kpis', type: 'table', card: { spec: clone(PRESETS['bsk-kpis']), from: 'bsk-kpis' } },
  ] as Widget[]

  it('the fixtures are what they claim', () => {
    const [c, r, s, k] = widgets()
    expect(c.notes).toEqual(['small-sample', 'not-a-note', 'also-gone'])
    const rs = specOf(r)
    expect(validateCard(rs)).toEqual([])
    expect(rs.repeat).toMatchObject({ organic: true, empty: { label: '', text: { note: 'no-return-visits-yet' } } })
    expect(rs.sections[0].items.find((i) => i.id === 'd0')!.display).toEqual(SPARK)
    const ss = specOf(s)
    expect(validateCard(ss)).toEqual([])
    expect(ss.badge!.display).toMatchObject({ tones: { 'flighting today': 'live' } })
    expect(ss.captions).toEqual(['release-before-partial'])
    const ks = specOf(k)
    expect(validateCard(ks)).toEqual([])
    expect(ks.sections.flatMap((sec) => sec.items).some((i) => i.repeat?.empty)).toBe(true)
  })

  it('a load at this version returns every widget exactly as stored, and a second load changes nothing', () => {
    const input = widgets()
    const once = normalizeConfig(stored(CONFIG_VERSION, input))
    expect(json(widgetsOf(once))).toEqual(json(input))
    // (only page p1: the default page's relative date range re-resolves against the clock)
    const twice = normalizeConfig(json(once))
    expect(json(widgetsOf(twice))).toEqual(json(widgetsOf(once)))
  })

  it('a layout stored at the previous version loads the same widgets: no migration rewrites them', () => {
    const prev = Math.max(...Object.values(LAYOUT_VERSIONS).filter((v) => v < LAYOUT_VERSIONS.captions))
    const out = normalizeConfig(stored(prev, widgets()))
    expect(out.version).toBe(CONFIG_VERSION)
    expect(json(widgetsOf(out))).toEqual(json(widgets()))
  })
})
