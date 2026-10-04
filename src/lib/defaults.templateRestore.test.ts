// "Restore default charts" on a page built from a template brings back THAT template's set, for every
// template, by the page's stored marker (DashboardPage.templateId). No layout version: the field is
// optional and a page without it is read by id (and, for Retention, by its scope note). Layout key
// `templateMarker` guards it (no migration: the field is read as is, a page without it is never rewritten).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CONFIG_VERSION,
  LAYOUT_VERSIONS,
  TEMPLATE_WIDGETS,
  clonePage,
  defaultCampaignComparePage,
  defaultConfig,
  defaultRetentionPage,
  defaultWidgets,
  defaultWidgetsForPage,
  normalizeConfig,
  pageFilterBar,
  pageTemplateId,
} from './defaults'
import { applyPageDraft, buildPage, newPageDraft, PAGE_TEMPLATES } from './wizards'
import type { DashboardConfig, DashboardPage, Widget } from '../types'

// Default charts carry a since/until from the clock; pin it so two builds compare equal.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-04T12:00:00Z'))
})
afterAll(() => vi.useRealTimers())

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
// A widget set without its ids (clonePage gives a page fresh ones).
const shape = (ws: Widget[]) =>
  ws.map((w) => {
    const c: Record<string, unknown> = { ...w }
    delete c.id
    delete c.i
    return c
  })
const built = (start: string): DashboardPage => buildPage({ ...newPageDraft('Mine'), name: 'Mine', start }, defaultConfig().pages[0])
const trashed = (p: DashboardPage): DashboardPage => ({ ...p, widgets: [p.widgets[0]] })

describe('template marker', () => {
  it('has a chart set for every page template, equal to what the template itself creates', () => {
    expect(Object.keys(TEMPLATE_WIDGETS).sort()).toEqual(PAGE_TEMPLATES.map((t) => t.id).sort())
    for (const t of PAGE_TEMPLATES) expect(shape(TEMPLATE_WIDGETS[t.id]()), t.id).toEqual(shape(defaultWidgetsForPage(t.make())))
  })

  it('is set on a page created from a template, and on no other page', () => {
    for (const t of PAGE_TEMPLATES) expect(built(t.id).templateId, t.id).toBe(t.id)
    expect(built('blank').templateId).toBeUndefined()
    // none of the built-in pages carries it: it is stored only once someone creates a page from a template
    for (const p of defaultConfig().pages) expect(p.templateId, p.id).toBeUndefined()
  })

  it('is kept by a duplicate of the page, and not by a drill copy', () => {
    const p = built('tpl-bsk-retention')
    expect(buildPage({ ...newPageDraft('Mine'), name: 'Copy', start: 'duplicate' }, p).templateId).toBe('tpl-bsk-retention')
    expect(clonePage(p, 'Copy', true).templateId).toBe('tpl-bsk-retention')
    expect(clonePage(p, 'Filtered').templateId).toBeUndefined()
  })
})

describe('Restore default charts (defaultWidgetsForPage)', () => {
  for (const t of PAGE_TEMPLATES) {
    it(`brings back the ${t.label} set on a page created from it (fresh id, edited charts)`, () => {
      const page = trashed(built(t.id))
      expect(page.id).not.toBe(t.make().id)
      const restored = defaultWidgetsForPage(page)
      expect(shape(restored)).toEqual(shape(TEMPLATE_WIDGETS[t.id]()))
      expect(restored.length).toBeGreaterThan(1)
    })
  }

  it('the Retention template restores the Retention set, not the generic one', () => {
    const restored = defaultWidgetsForPage(trashed(built('tpl-bsk-retention')))
    expect(restored.map((x) => x.id)).toContain('rt-verdict')
    expect(shape(restored)).not.toEqual(shape(defaultWidgets()))
  })

  it('a page with a marker this build does not know restores as an unmarked page does', () => {
    const odd = { ...trashed(built('tpl-default')), templateId: 'tpl-from-the-future' }
    expect(pageTemplateId(odd)).toBeUndefined()
    expect(shape(defaultWidgetsForPage(odd))).toEqual(shape(defaultWidgets()))
  })

  it('an unmarked custom page still restores the generic set (unchanged)', () => {
    const page: DashboardPage = { id: 'mine1', name: 'Mine', isDefault: false, group: 'Mine', filters: defaultConfig().pages[0].filters, widgets: [] }
    expect(shape(defaultWidgetsForPage(page))).toEqual(shape(defaultWidgets()))
  })

  it('the campaigns page restores by id as before, with or without a marker', () => {
    const camp = defaultCampaignComparePage()
    expect(shape(defaultWidgetsForPage({ ...camp, widgets: [] }))).toEqual(shape(TEMPLATE_WIDGETS['tpl-bsk-campaigns']()))
  })
})

describe('legacy pages (no marker)', () => {
  it('the Retention page by its id restores its own set', () => {
    const page = defaultRetentionPage()
    expect(page.templateId).toBeUndefined()
    expect(pageTemplateId(page)).toBe('tpl-bsk-retention')
    expect(defaultWidgetsForPage(trashed(page)).map((x) => x.id)).toContain('rt-verdict')
  })

  it('a Retention page created from the template before the marker is recognised by its scope note', () => {
    const page = built('tpl-bsk-retention')
    delete page.templateId
    expect(pageTemplateId(page)).toBe('tpl-bsk-retention')
    expect(shape(defaultWidgetsForPage(page))).toEqual(shape(TEMPLATE_WIDGETS['tpl-bsk-retention']()))
    expect(pageFilterBar(page)).toBe('range')
  })

  it('a drill page copied from it is not taken for a Retention page', () => {
    const page = built('tpl-bsk-retention')
    delete page.templateId
    const drill = { ...clonePage(page, 'Filtered'), parentId: page.id }
    expect(pageTemplateId(drill)).toBeUndefined()
    expect(pageFilterBar(drill)).toBe('full')
  })

  it('other templates have no fingerprint: a page without the marker is generic', () => {
    for (const t of PAGE_TEMPLATES.filter((x) => x.id !== 'tpl-bsk-retention' && x.id !== 'tpl-bsk-campaigns')) {
      const page = built(t.id)
      delete page.templateId
      expect(pageTemplateId(page), t.id).toBeUndefined()
    }
  })
})

describe('the marker is stored, under a guard-only layout version', () => {
  it('survives normalizeConfig; junk is dropped', () => {
    const cfg: DashboardConfig = clone(defaultConfig())
    const { result, page } = applyPageDraft(cfg, { ...newPageDraft('Best Sudoku'), name: 'Retention', start: 'tpl-bsk-retention' }, cfg.pages[0])
    const saved: DashboardConfig = { ...cfg, pages: result.pages }
    const back = normalizeConfig(clone(saved)).pages.find((p) => p.id === page.id)!
    expect(back.templateId).toBe('tpl-bsk-retention')
    for (const junk of [7, '', 'Retention', 'tpl-', 'tpl-' + 'x'.repeat(60), { a: 1 }]) {
      const s = clone(saved)
      ;(s.pages.find((p) => p.id === page.id) as unknown as Record<string, unknown>).templateId = junk
      expect(normalizeConfig(s).pages.find((p) => p.id === page.id)!.templateId, String(junk)).toBeUndefined()
    }
  })

  it('takes its own layout key: CONFIG_VERSION is that key, the highest, and the fresh layout carries no marker', () => {
    expect(CONFIG_VERSION).toBe(LAYOUT_VERSIONS.templateMarker)
    expect(CONFIG_VERSION).toBe(Math.max(...Object.values(LAYOUT_VERSIONS)))
    expect(LAYOUT_VERSIONS.templateMarker).toBeGreaterThan(LAYOUT_VERSIONS.rateTile)
    expect(JSON.stringify(defaultConfig())).not.toMatch(/templateId/)
  })

  // A guard only: an older stored layout loads to the new version with nothing written to its pages.
  for (const [name, stored] of [['v12', 12], ['rateTile', LAYOUT_VERSIONS.rateTile]] as const) {
    it(`a ${name} layout loads at the new version with templateId absent, and Restore keeps its legacy fallback`, () => {
      const cfg: DashboardConfig = clone(defaultConfig())
      cfg.pages.push(defaultRetentionPage(), { ...built('blank'), id: 'plain-1', name: 'Plain', widgets: [] })
      const out = normalizeConfig({ ...clone(cfg), version: stored })
      expect(out.version).toBe(LAYOUT_VERSIONS.templateMarker)
      for (const p of out.pages) expect(p.templateId, p.id).toBeUndefined()
      const retention = out.pages.find((p) => p.id === 'bsk-retention')!
      expect(defaultWidgetsForPage(trashed(retention)).map((x) => x.id)).toContain('rt-verdict')
      const plain = out.pages.find((p) => p.id === 'plain-1')!
      expect(shape(defaultWidgetsForPage(plain))).toEqual(shape(defaultWidgets()))
    })
  }
})

describe('pageFilterBar', () => {
  it('is none on the campaigns page, as before; range on a Retention page; full elsewhere', () => {
    expect(pageFilterBar(defaultCampaignComparePage())).toBe('none')
    expect(pageFilterBar(built('tpl-bsk-retention'))).toBe('range')
    expect(pageFilterBar(defaultRetentionPage())).toBe('range')
    expect(pageFilterBar(built('blank'))).toBe('full')
    for (const t of PAGE_TEMPLATES.filter((x) => x.id !== 'tpl-bsk-retention' && x.id !== 'tpl-bsk-campaigns')) expect(pageFilterBar(built(t.id)), t.id).toBe('full')
    for (const p of defaultConfig().pages.filter((x) => x.id !== 'bsk-campaigns' && x.id !== 'bsk-retention')) expect(pageFilterBar(p), p.id).toBe('full')
  })
})
