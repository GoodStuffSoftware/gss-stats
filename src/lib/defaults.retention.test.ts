// R-3: the Best Sudoku retention page is a PAGE TEMPLATE only (lib/wizards.ts). It adds no layout
// version and no migration: it is not in defaultConfig(), normalizeConfig neither adds nor removes
// it, and what a person saves from it is an ordinary page of ordinary card widgets.
import { describe, expect, it } from 'vitest'
import {
  CONFIG_VERSION,
  LAYOUT_VERSIONS,
  defaultConfig,
  defaultRetentionPage,
  defaultRetentionWidgets,
  defaultWidgetsForPage,
  isRetentionPage,
  normalizeConfig,
} from './defaults'
import { getNote, noteRawText } from './notes'
import { presetById } from './metrics/presets'
import { splitRefused } from './splitGuard'
import { applyPageDraft, buildPage, newPageDraft, PAGE_TEMPLATES } from './wizards'
import type { DashboardConfig } from '../types'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))

describe('the retention page template', () => {
  it('places the shipped presets as cards and the notes by registry id', () => {
    const ws = defaultRetentionWidgets()
    const cards = ws.filter((x) => x.card)
    expect(cards.map((x) => ('preset' in x.card! ? x.card.preset : null))).toEqual(['retention-verdict', 'campaign-returns', 'campaign-engagement'])
    for (const c of cards) expect(presetById('preset' in c.card! ? c.card.preset : ''), c.id).toBeDefined()
    const notes = ws.filter((x) => x.type === 'note')
    expect(notes.map((n) => n.noteId)).toEqual(['retention-page-scope', 'small-sample'])
    for (const n of notes) expect(getNote(n.noteId!), n.id).toBeDefined()
    for (const x of ws) for (const id of x.notes ?? []) expect(getNote(id), `${x.id} ${id}`).toBeDefined()
  })

  it('has unique ids, no overlapping grid cells and fits twelve columns', () => {
    const ws = defaultRetentionWidgets()
    expect(new Set(ws.map((x) => x.id)).size).toBe(ws.length)
    for (const a of ws) {
      expect(a.i).toBe(a.id)
      expect(a.x + a.w).toBeLessThanOrEqual(12)
      for (const b of ws) {
        if (a === b) continue
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
        expect(apart, `${a.id} vs ${b.id}`).toBe(true)
      }
    }
  })

  it('is counts only: no chart, no split dimension, no hour, place or device word, no clock time', () => {
    const ws = defaultRetentionWidgets()
    for (const x of ws) {
      expect(x.type === 'table' || x.type === 'note', x.id).toBe(true)
      expect(x.dimension, x.id).toBe('')
      expect(x.breakdown, x.id).toBeUndefined()
      expect(x.rings, x.id).toBeUndefined()
      expect(splitRefused({ points: false, fields: [x.dimension ?? ''] }), x.id).toBe(false)
    }
    expect(JSON.stringify(ws)).not.toMatch(/hourEt|country|region|city|device|screenw|visitor|includeEventBeacons/i)
    const text = noteRawText('retention-page-scope')
    expect(text).toMatch(/count per campaign/)
    expect(text).not.toMatch(/\d\d?:\d\d|\b(am|pm|UTC)\b/i)
  })

  it('is a template, found by id, whose restore set is its own widgets', () => {
    const page = defaultRetentionPage()
    expect(page).toMatchObject({ id: 'bsk-retention', name: 'Retention', group: 'Best Sudoku', isDefault: false })
    expect(isRetentionPage(page)).toBe(true)
    expect(isRetentionPage({ id: 'bsk-campaigns' })).toBe(false)
    expect(defaultWidgetsForPage(page).map((x) => x.id)).toEqual(defaultRetentionWidgets().map((x) => x.id))
    expect(PAGE_TEMPLATES.find((t) => t.id === 'tpl-bsk-retention')).toMatchObject({ label: 'Best Sudoku · Retention', make: defaultRetentionPage })
  })

  it('builds from the wizard with fresh ids, in the picked group, as a top-level page', () => {
    const cfg = defaultConfig()
    const draft = { ...newPageDraft('Best Sudoku'), name: 'Retention', start: 'tpl-bsk-retention' }
    const page = buildPage(draft, cfg.pages[0])
    expect(page.id).not.toBe('bsk-retention')
    expect(page.group).toBe('Best Sudoku')
    expect(page.parentId).toBeUndefined()
    expect(page.widgets.map((x) => x.title)).toEqual(defaultRetentionWidgets().map((x) => x.title))
    const ids = new Set(defaultRetentionWidgets().map((x) => x.id))
    for (const x of page.widgets) expect(ids.has(x.id), x.id).toBe(false)
    const { result } = applyPageDraft(cfg, draft, cfg.pages[0])
    expect(result.pages).toHaveLength(cfg.pages.length + 1)
  })
})

describe('no layout version, no migration', () => {
  it('leaves CONFIG_VERSION and LAYOUT_VERSIONS where they were', () => {
    expect(CONFIG_VERSION).toBe(15)
    expect(LAYOUT_VERSIONS).toEqual({ compactNoteRow: 12, navigation: 13, sparklines: 14, dateEtTrends: 15 })
  })

  it('does not put the page in a fresh layout', () => {
    expect(defaultConfig().pages.map((p) => p.id)).not.toContain('bsk-retention')
    expect(JSON.stringify(defaultConfig())).not.toMatch(/retention-verdict|campaign-engagement/)
  })

  it('a stored layout without the page loads without gaining it', () => {
    const stored = clone(defaultConfig())
    expect(normalizeConfig(clone(stored)).pages.map((p) => p.id)).toEqual(stored.pages.map((p) => p.id))
  })

  it('a stored layout WITH the page (created from the template) round-trips unchanged', () => {
    const cfg: DashboardConfig = clone(defaultConfig())
    const draft = { ...newPageDraft('Best Sudoku'), name: 'Retention', start: 'tpl-bsk-retention' }
    const { result, page } = applyPageDraft(cfg, draft, cfg.pages[0])
    const saved: DashboardConfig = { ...cfg, pages: result.pages, groupOrder: result.groupOrder }
    const loaded = normalizeConfig(clone(saved))
    expect(loaded.version).toBe(CONFIG_VERSION)
    const back = loaded.pages.find((p) => p.id === page.id)!
    expect(back.widgets).toEqual(page.widgets)
    expect(back.group).toBe('Best Sudoku')
    expect(loaded.pages).toHaveLength(saved.pages.length)
  })
})
