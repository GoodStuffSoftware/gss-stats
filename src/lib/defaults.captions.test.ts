// Layout version LAYOUT_VERSIONS.captions (notes plan, slice 1c): a widget may carry its own
// plain-text `caption` and a `hiddenCaveats` list. normWidget whitelists and caps both. Legacy
// `notes` ids convert on the chart's next edit (decision D5). The one rewrite at load is the v16
// step (decision D2-B, seedHiddenAutoCaveatsV16): a pre-v16 chart hides the hideable automatic
// scope caveats it did not show, so it looks unchanged. Tests use the LAYOUT_VERSIONS key, never a
// literal, so whichever slice lands second only renumbers the map.
import { describe, expect, it } from 'vitest'
import {
  CAPTION_MAX_CHARS,
  CONFIG_VERSION,
  HIDDEN_CAVEATS_MAX,
  HIDDEN_CAVEAT_ID_RE,
  LAYOUT_VERSIONS,
  V16_SEEDABLE_CAVEATS,
  defaultCampaignsWidgets,
  defaultConfig,
  defaultWidgetsForPage,
  normalizeConfig,
  seedHiddenAutoCaveatsV16,
} from './defaults'
import { NOTES_REGISTRY, autoCaveatIds, getNote, isNoteIdHideable, isStaticCaptionNote } from './notes'
import { chartNotes } from './chartNotes'
import PROD_V12 from './__fixtures__/prodLayout.v12.json'
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
  it('every registry caption or caveat id (labels aside) fits HIDDEN_CAVEAT_ID_RE, so a note the editors can hide is one hiddenCaveats can store (NIT-4)', () => {
    const bad = Object.values(NOTES_REGISTRY).filter((n) => n.kind !== 'label' && !HIDDEN_CAVEAT_ID_RE.test(n.id)).map((n) => n.id)
    expect(bad).toEqual([])
  })
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

  it('absent stays absent: a widget that never had them gains no keys; a default widget has no caption and hides only its unlisted hideable autos', () => {
    const w = load({ ...BASE })
    expect('caption' in w).toBe(false)
    expect('hiddenCaveats' in w).toBe(false)
    for (const p of normalizeConfig(defaultConfig()).pages)
      for (const dw of p.widgets) {
        expect('caption' in dw, dw.id).toBe(false)
        expect(dw.hiddenCaveats ?? [], dw.id).toEqual(autoCaveatIds(dw).filter(isNoteIdHideable))
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
    // Scope 'popup', so it has an automatic caveat (min-cohort-caveat) the v16 step hides.
    {
      ...BASE,
      id: 'chart',
      i: 'chart',
      dataset: 'popup',
      caption: 'Counts **all** sites. Today: {=today.pageviews}',
      hiddenCaveats: ['popup-note', 'small-sample', 'range-notice'],
      notes: ['small-sample', 'not-a-note', 'also-gone'],
      fit: 'content',
    },
    // A custom card: a daily sparkline item, repeat.organic + repeat.empty, fit, hidden spec caption.
    { ...BASE, id: 'returns', i: 'returns', type: 'table', card: { spec: sparkReturns(), from: 'campaign-returns' }, fit: 'content', hiddenCaveats: ['no-return-visits-yet'] },
    // A custom card with badge tones and a spec caption it hides (D7); scope 'campaigns'.
    { ...BASE, id: 'score', i: 'score', type: 'table', dataset: 'campaigns', card: { spec: scorecard(), from: 'campaign-scorecard' }, caption: 'Mine.', hiddenCaveats: ['release-before-partial'] },
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

  it('a layout stored at the previous version loads the same widgets, except the v16 step hides their new automatic caveats', () => {
    const prev = Math.max(...Object.values(LAYOUT_VERSIONS).filter((v) => v < LAYOUT_VERSIONS.captions))
    const out = normalizeConfig(stored(prev, widgets()))
    expect(out.version).toBe(CONFIG_VERSION)
    const expected = widgets()
    expected[0].hiddenCaveats = ['popup-note', 'small-sample', 'range-notice', 'min-cohort-caveat']
    expected[2].hiddenCaveats = ['release-before-partial', 'play-tracking-status', 'min-cohort-caveat'] // not the data-cut one (D3)
    expect(json(widgetsOf(out))).toEqual(json(expected))
  })
})

describe('captions: the v16 step (D2-B) on a pre-v16 layout', () => {
  const prev = LAYOUT_VERSIONS.captions - 1
  const campaignsChart = { ...BASE, id: 'c', i: 'c', type: 'table', dataset: 'campaigns', view: 'funnel' }
  const popupChart = { ...BASE, id: 'p', i: 'p', type: 'bar', dataset: 'popup', dimension: 'eligible' }

  it('hides exactly the hideable automatic caveats a chart did not show; listed ones and data-cut ones stay visible', () => {
    // campaigns today: play-tracking-status, min-cohort-caveat (hideable), country-split-excludes-refused (not).
    // country-split-excludes-refused (not hideable) is automatic only on a card with country columns (B4a)
    expect(autoCaveatIds(campaignsChart as Widget)).toEqual(['play-tracking-status', 'min-cohort-caveat'])
    expect(load(campaignsChart, prev).hiddenCaveats).toEqual(['play-tracking-status', 'min-cohort-caveat'])
    expect(load({ ...campaignsChart, notes: ['min-cohort-caveat'] }, prev).hiddenCaveats).toEqual(['play-tracking-status'])
    expect(load({ ...campaignsChart, notes: ['play-tracking-status', 'min-cohort-caveat'] }, prev).hiddenCaveats).toBeUndefined()
    expect(load(popupChart, prev).hiddenCaveats).toEqual(['min-cohort-caveat'])
  })

  it('an upgraded chart shows what it showed before, plus a data-cut caveat only where it holds (D3, B4a)', () => {
    const old = { ...campaignsChart, notes: ['arrivals-caveat'] }
    expect(chartNotes(load(old, prev), null, null).map((n) => n.key)).toEqual(['caption:arrivals-caveat'])
    expect(chartNotes(load(popupChart, prev), null, null)).toEqual([])
    // a saved copy of the country card without its own caption: country columns, so the cut shows
    const country = { ...old, card: { spec: { ...clone(PRESETS['campaign-country']), captions: [] } } }
    const loaded = load(country, prev)
    expect(loaded.hiddenCaveats).toEqual(['play-tracking-status', 'min-cohort-caveat'])
    expect(chartNotes(loaded, null, null).map((n) => n.key)).toEqual(['caption:arrivals-caveat', 'caveat:country-split-excludes-refused'])
  })

  it('merges with hidden ids already stored, deduped, capped', () => {
    expect(load({ ...campaignsChart, hiddenCaveats: ['popup-note', 'min-cohort-caveat'] }, prev).hiddenCaveats).toEqual([
      'popup-note',
      'min-cohort-caveat',
      'play-tracking-status',
    ])
    const full = Array.from({ length: HIDDEN_CAVEATS_MAX }, (_, i) => `id-${i}`)
    expect(load({ ...campaignsChart, hiddenCaveats: full }, prev).hiddenCaveats).toEqual(full)
  })

  it('leaves note widgets, scope-less widgets and scopes with no automatic caveats alone', () => {
    expect('hiddenCaveats' in load({ ...BASE, type: 'note', dataset: 'campaigns', noteId: 'arrivals-caveat' }, prev)).toBe(false)
    expect('hiddenCaveats' in load({ ...BASE, dataset: undefined }, prev)).toBe(false)
    for (const dataset of ['overview', 'geo', 'ads-readings']) expect('hiddenCaveats' in load({ ...BASE, dataset }, prev), dataset).toBe(false)
  })

  it('a card: its spec captions are not automatic caveats, so they are neither shown twice nor seeded', () => {
    const card = { ...campaignsChart, card: { spec: { ...clone(PRESETS['campaign-scorecard']), captions: ['min-cohort-caveat'] } } }
    expect(autoCaveatIds(card as Widget)).toEqual(['play-tracking-status'])
    expect(load(card, prev).hiddenCaveats).toEqual(['play-tracking-status'])
    const preset = { ...campaignsChart, card: { preset: 'campaign-country' } } // its preset captions country-split-excludes-refused
    expect(autoCaveatIds(preset as Widget)).toEqual(['play-tracking-status', 'min-cohort-caveat'])
  })

  it('is idempotent: normalizing twice gives the same layout, and the step on its own output adds nothing', () => {
    const once = normalizeConfig(stored(prev, [campaignsChart, popupChart]))
    // widgets only: a page's relative date range re-resolves against the clock between the two loads
    const allWidgets = (c: DashboardConfig) => json(c.pages.map((p) => p.widgets))
    expect(allWidgets(normalizeConfig(json(once)))).toEqual(allWidgets(once))
    expect(widgetsOf(once).map((w) => w.hiddenCaveats)).toEqual([['play-tracking-status', 'min-cohort-caveat'], ['min-cohort-caveat']])
    for (const p of once.pages) expect(seedHiddenAutoCaveatsV16(p)).toBe(p)
  })

  it('a layout already at the captions version is never migrated', () => {
    expect('hiddenCaveats' in load(campaignsChart)).toBe(false)
    expect('hiddenCaveats' in load(popupChart, LAYOUT_VERSIONS.captions)).toBe(false)
  })

  it('the production layout (v12): every non-note chart hides only hideable ids it did not list', () => {
    const out = normalizeConfig(clone(PROD_V12) as never)
    const before = new Map((PROD_V12 as unknown as DashboardConfig).pages.flatMap((p) => p.widgets).map((w) => [w.id, w]))
    let seeded = 0
    for (const w of out.pages.flatMap((p) => p.widgets)) {
      const old = before.get(w.id)
      if (!old) continue // a page the older migrations added
      const added = (w.hiddenCaveats ?? []).filter((id) => !(old.hiddenCaveats ?? []).includes(id))
      if (w.type === 'note') expect(added, w.id).toEqual([])
      for (const id of added) {
        expect(old.notes ?? [], w.id).not.toContain(id)
        expect(id, w.id).not.toBe('country-split-excludes-refused')
      }
      seeded += added.length
    }
    expect(seeded).toBeGreaterThan(0)
  })
})

describe('built-in default charts look as they did before 1c (B4a)', () => {
  /** The registry notes a chart shows today: caption:/caveat: entries (a card's own spec captions
   * render inside the card, not here). */
  const visibleRegistryIds = (w: Widget) => chartNotes(w, null, null).filter((n) => n.noteId).map((n) => n.noteId)
  /** Before 1c a chart showed exactly its legacy notes ids, in order. */
  const before = (w: Widget) => w.notes ?? []
  const charts = (ws: Widget[]) => ws.filter((w) => w.type !== 'note')

  it('the default layout: every chart shows exactly the caveats its legacy notes showed', () => {
    const pages = normalizeConfig(defaultConfig()).pages
    expect(pages.length).toBeGreaterThan(0)
    let campaignsCharts = 0
    for (const p of pages)
      for (const w of charts(p.widgets)) {
        expect(visibleRegistryIds(w), `${p.id}/${w.id}`).toEqual(before(w))
        if (w.dataset === 'campaigns') campaignsCharts++
      }
    expect(campaignsCharts).toBeGreaterThan(0) // the scope with automatic caveats is covered
  })

  it('"restore defaults" on every built-in page gives charts that show exactly their legacy notes', () => {
    for (const p of normalizeConfig(defaultConfig()).pages)
      for (const w of charts(defaultWidgetsForPage(p))) expect(visibleRegistryIds(w), `${p.id}/${w.id}`).toEqual(before(w))
  })

  it('the default layout survives a reload unchanged (the factory seed and the v16 step agree)', () => {
    const once = normalizeConfig(defaultConfig())
    const twice = normalizeConfig(json(once))
    // the caption fields only: a chart's own relative date window re-resolves against the clock
    const fields = (w: Widget) => json({ id: w.id, notes: w.notes, caption: w.caption, hiddenCaveats: w.hiddenCaveats })
    expect(twice.pages.map((p) => p.widgets.map(fields))).toEqual(once.pages.map((p) => p.widgets.map(fields)))
  })

  it('a new chart a user adds still gets its automatic caveats', () => {
    const w = { ...BASE, id: 'n', i: 'n', type: 'table', dataset: 'campaigns', view: 'funnel' } as Widget
    expect(visibleRegistryIds(w)).toEqual(['play-tracking-status', 'min-cohort-caveat'])
  })
})

describe('the v16 seed is frozen to the caveats that existed at v16 (V16_SEEDABLE_CAVEATS)', () => {
  const prev = LAYOUT_VERSIONS.captions - 1
  const LATER = 'zz-later-caveat'
  const campaignsChart = { ...BASE, id: 'c', i: 'c', type: 'table', dataset: 'campaigns', view: 'funnel' }
  const hidesLater = (ws: Widget[]) => ws.filter((w) => (w.hiddenCaveats ?? []).includes(LATER)).map((w) => w.id)

  /** Runs `fn` with a hideable automatic caveat added to the campaigns and popup scopes, as a
   * later deploy might add one (computed text, so it is a caveat, not a static caption). */
  const withLaterCaveat = (fn: () => void) => {
    NOTES_REGISTRY[LATER] = { id: LATER, text: () => 'A caveat added after v16.', kind: 'note', severity: 'caveat', scopes: ['campaigns', 'popup'] }
    try {
      fn()
    } finally {
      delete NOTES_REGISTRY[LATER]
    }
  }

  it("pins the frozen set: v16's hideable automatic caveats, all known and hideable", () => {
    expect([...V16_SEEDABLE_CAVEATS]).toEqual(['play-tracking-status', 'play-tracking-not-live', 'tracking-not-yet-active', 'min-cohort-caveat'])
    for (const id of V16_SEEDABLE_CAVEATS) {
      expect(getNote(id), id).toBeDefined()
      expect(isNoteIdHideable(id), id).toBe(true)
      expect(isStaticCaptionNote(id), id).toBe(false)
    }
  })

  it('a caveat added to a scope later is automatic, and the pre-v16 migration does not hide it', () =>
    withLaterCaveat(() => {
      expect(autoCaveatIds(campaignsChart as Widget)).toContain(LATER) // the probe is real
      const loaded = load(campaignsChart, prev)
      expect(loaded.hiddenCaveats).toEqual(['play-tracking-status', 'min-cohort-caveat'])
      expect(chartNotes(loaded, null, null).map((n) => n.key)).toEqual([`caveat:${LATER}`])
      // production, stored at v12 until its first save: the seed re-runs on every load
      const prod = normalizeConfig(clone(PROD_V12) as never)
      expect(hidesLater(prod.pages.flatMap((p) => p.widgets))).toEqual([])
    }))

  it('the default and restored built-in charts do not hide it either, nor the v7 refill of an empty page', () =>
    withLaterCaveat(() => {
      const fresh = normalizeConfig(defaultConfig())
      const all = fresh.pages.flatMap((p) => p.widgets)
      expect(all.some((w) => autoCaveatIds(w).includes(LATER))).toBe(true) // some built-in chart has the scope
      expect(hidesLater(all)).toEqual([])
      expect(hidesLater(defaultCampaignsWidgets())).toEqual([])
      for (const p of fresh.pages) expect(hidesLater(defaultWidgetsForPage(p)), p.id).toEqual([])
      // v7: a built-in page stored empty is refilled from its factory on load
      const base = defaultConfig()
      const camp = base.pages.find((p) => defaultWidgetsForPage(p).some((w) => autoCaveatIds(w).includes(LATER)))!
      const emptied = { ...clone(base), version: prev, pages: clone(base.pages).map((p) => (p.id === camp.id ? { ...p, widgets: [] } : p)) }
      const again = normalizeConfig(emptied).pages.find((p) => p.id === camp.id)!.widgets
      expect(again.some((w) => autoCaveatIds(w).includes(LATER))).toBe(true)
      expect(hidesLater(again)).toEqual([])
    }))

  it("today's production seed is unchanged: exactly these five charts gain hidden ids", () => {
    const out = normalizeConfig(clone(PROD_V12) as never)
    const before = new Map((PROD_V12 as unknown as DashboardConfig).pages.flatMap((p) => p.widgets.map((w) => [`${p.id}/${w.id}`, w] as const)))
    const seeded: Record<string, string[]> = {}
    for (const p of out.pages)
      for (const w of p.widgets) {
        const old = before.get(`${p.id}/${w.id}`)
        const added = (w.hiddenCaveats ?? []).filter((id) => !(old?.hiddenCaveats ?? []).includes(id))
        if (added.length) seeded[`${p.id}/${w.id}`] = added
      }
    expect(seeded).toEqual({
      'bsk-campaigns/cw-funnel': ['play-tracking-status'],
      'bsk-campaigns/cw-country': ['play-tracking-status', 'min-cohort-caveat'],
      'bsk-campaigns/cw-cost': ['play-tracking-status', 'min-cohort-caveat'],
      'bsk-campaigns/cw-returns': ['min-cohort-caveat'],
      'bsk-popups/pu-eligible-bd': ['min-cohort-caveat'],
    })
  })
})
