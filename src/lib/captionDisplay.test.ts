// Widget.captionDisplay in the saved layout: it is an optional field, so a layout saved without it
// loads unchanged and CONFIG_VERSION does not move. normWidget keeps only the two folding modes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CAPTION_AUTO_CHARS, NEW_WIDGET_CAPTION_DISPLAY, captionDisplayOf, captionFolds, normCaptionDisplay } from './captionDisplay'
import { CONFIG_VERSION, defaultConfig, normalizeConfig } from './defaults'
import PROD_V12 from './__fixtures__/prodLayout.v12.json'
import type { DashboardConfig, Widget } from '../types'

const wrap = (widgets: unknown[], version: number = CONFIG_VERSION) => ({ version, activePageId: 'p1', pages: [{ id: 'p1', name: 'P', filters: { siteSel: [] }, widgets }] }) as unknown as DashboardConfig
const chart = (over: Record<string, unknown> = {}) => ({ id: 'w1', i: 'w1', title: 'T', type: 'table', dataset: 'popup', dimension: 'kind', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 6, h: 6, ...over })
const loaded = (over: Record<string, unknown>): Widget => normalizeConfig(wrap([chart(over)])).pages[0].widgets[0]

describe('captionDisplay helpers', () => {
  it('a widget with no value (or an unknown one) is "always"', () => {
    expect(captionDisplayOf({})).toBe('always')
    expect(captionDisplayOf({ captionDisplay: 'always' })).toBe('always')
    expect(captionDisplayOf({ captionDisplay: 'bogus' as never })).toBe('always')
    expect(captionDisplayOf({ captionDisplay: 'collapsible' })).toBe('collapsible')
    expect(captionDisplayOf({ captionDisplay: 'auto' })).toBe('auto')
  })

  it('collapsible folds any text; auto folds only over the threshold; always and none never fold', () => {
    expect(captionFolds('collapsible', 5)).toBe(true)
    expect(captionFolds('auto', CAPTION_AUTO_CHARS)).toBe(false)
    expect(captionFolds('auto', CAPTION_AUTO_CHARS + 1)).toBe(true)
    expect(captionFolds('always', 5000)).toBe(false)
    expect(captionFolds(undefined, 5000)).toBe(false)
  })

  it('a new chart starts on auto', () => {
    expect(NEW_WIDGET_CAPTION_DISPLAY).toBe('auto')
  })

  it('normCaptionDisplay keeps only the two folding modes', () => {
    expect(normCaptionDisplay('collapsible')).toBe('collapsible')
    expect(normCaptionDisplay('auto')).toBe('auto')
    for (const v of ['always', '', 'AUTO', 1, true, null, undefined, {}]) expect(normCaptionDisplay(v)).toBeUndefined()
  })
})

describe('captionDisplay in the saved layout', () => {
  // A relative range (rangeRel) is recomputed from the clock on every load, so freeze it to compare two loads.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('a widget saved without it gains no key, and a layout round-trips unchanged', () => {
    const w = loaded({ caption: 'Hello' })
    expect('captionDisplay' in w).toBe(false)
    const once = normalizeConfig(wrap([chart({ caption: 'Hello' })]))
    expect(normalizeConfig(JSON.parse(JSON.stringify(once)))).toEqual(once)
  })

  it('an older stored layout (the prod copy fixture) loads with no widget carrying the key, and loading twice is stable', () => {
    const once = normalizeConfig(JSON.parse(JSON.stringify(PROD_V12)))
    const widgets = once.pages.flatMap((p) => p.widgets)
    expect(widgets.length).toBeGreaterThan(5)
    expect(widgets.some((w) => 'captionDisplay' in w)).toBe(false)
    const twice = normalizeConfig(JSON.parse(JSON.stringify(once)))
    const plain = (c: DashboardConfig) => JSON.parse(JSON.stringify(c.pages.flatMap((p) => p.widgets))) // as stored: no undefined keys
    expect(plain(twice)).toEqual(plain(once))
  })

  it('the factory layout has no widget with the key (only "Add chart" starts a chart on auto)', () => {
    const widgets = defaultConfig().pages.flatMap((p) => p.widgets)
    expect(widgets.length).toBeGreaterThan(0)
    expect(widgets.some((w) => 'captionDisplay' in w)).toBe(false)
  })

  it('keeps collapsible and auto, drops anything else, and a layout that already has a value is not migrated', () => {
    expect(loaded({ captionDisplay: 'collapsible' }).captionDisplay).toBe('collapsible')
    expect(loaded({ captionDisplay: 'auto' }).captionDisplay).toBe('auto')
    for (const v of ['always', 'nope', 7, null, ['auto']]) expect('captionDisplay' in loaded({ captionDisplay: v })).toBe(false)
    const cfg = normalizeConfig(wrap([chart({ captionDisplay: 'auto' })]))
    expect(cfg.version).toBe(CONFIG_VERSION)
    expect(cfg.pages[0].widgets[0].captionDisplay).toBe('auto')
  })

  it('a card widget keeps it, a note widget does not', () => {
    expect(loaded({ card: { preset: 'bsk-kpis' }, dataset: 'overview', view: 'kpis', captionDisplay: 'collapsible' }).captionDisplay).toBe('collapsible')
    expect('captionDisplay' in loaded({ type: 'note', note: 'x', captionDisplay: 'auto' })).toBe(false)
  })

  it('needs no CONFIG_VERSION bump: a layout stored at the current version passes through with the field and without it', () => {
    const a = normalizeConfig(wrap([chart({ id: 'a', i: 'a' }), chart({ id: 'b', i: 'b', captionDisplay: 'auto' })]))
    expect(a.version).toBe(CONFIG_VERSION)
    expect(a.pages[0].widgets.map((w) => w.captionDisplay)).toEqual([undefined, 'auto'])
  })
})
