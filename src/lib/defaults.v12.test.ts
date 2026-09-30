// The v12 layout migration: the Overview's small-sample note (one caption line) shipped as a
// 3-row grid cell, an empty band between the filter bar and the first card that the pre-v0.6
// page never had. It now takes one row and everything below it moves up two rows. Only the
// untouched factory cell is matched; version-gated, so a later resize is never undone.
import { describe, expect, it } from 'vitest'
import { CONFIG_VERSION, compactSmallSampleNoteV12, defaultConfig, normalizeConfig } from './defaults'
import type { DashboardConfig, DashboardPage, Widget } from '../types'
import PROD_V8 from './__fixtures__/prodLayout.v8.json'
import PROD_V9 from './__fixtures__/prodLayout.v9.json'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x))
const geom = (cfg: DashboardConfig, pageId = 'bsk-overview') =>
  Object.fromEntries(cfg.pages.find((p) => p.id === pageId)!.widgets.map((w) => [w.id, [w.x, w.y, w.w, w.h]]))
const V12_OVERVIEW = {
  'ow-note-smallsample': [0, 0, 12, 1],
  'ow-kpis': [0, 1, 12, 8],
  'ow-timeline': [0, 9, 12, 12],
  'ow-scorecard': [0, 21, 12, 14],
  'ow-release': [0, 35, 12, 9],
  'ow-completions': [0, 44, 12, 10],
}
const wd = (id: string, x: number, y: number, w: number, h: number, extra: Partial<Widget> = {}): Widget =>
  ({ id, i: id, title: id, type: 'table', dimension: '', metric: 'pageviews', limit: 1, x, y, w, h, ...extra }) as Widget
const note = (h = 3, extra: Partial<Widget> = {}) => wd('ow-note-smallsample', 0, 0, 12, h, { type: 'note', noteId: 'small-sample', ...extra })
const pg = (widgets: Widget[]): DashboardPage => ({ id: 'bsk-overview', name: 'Best Sudoku · Overview', filters: {}, widgets }) as DashboardPage

describe('v12: the small-sample note takes one grid row', () => {
  it('ships the one-row layout for a fresh config', () => {
    expect(CONFIG_VERSION).toBeGreaterThanOrEqual(12) // 13 since page navigation (defaults.v13.test.ts)
    expect(geom(defaultConfig())).toEqual(V12_OVERVIEW)
  })

  it('moves the production layout (v8 and v9) to exactly the new default geometry', () => {
    expect(geom(normalizeConfig(clone(PROD_V9)))).toEqual(V12_OVERVIEW)
    expect(geom(normalizeConfig(clone(PROD_V8)))).toEqual(V12_OVERVIEW)
  })

  it('touches nothing on any other page of the production layout', () => {
    const before = clone(PROD_V9) as unknown as DashboardConfig
    const after = normalizeConfig(clone(PROD_V9))
    for (const p of before.pages.filter((p) => p.id !== 'bsk-overview')) expect(geom(after, p.id), p.id).toEqual(geom(before, p.id))
  })

  it('shrinks the note and moves only the widgets below it', () => {
    const side = wd('side', 0, 0, 12, 3) // can't really share the note's rows, but proves rows above the freed band stay put
    const below = wd('below', 0, 3, 6, 4)
    const lower = wd('lower', 6, 10, 6, 2)
    const out = compactSmallSampleNoteV12(pg([note(), side, below, lower]))
    expect(out.widgets.map((w) => [w.id, w.y, w.h])).toEqual([
      ['ow-note-smallsample', 0, 1],
      ['side', 0, 3],
      ['below', 1, 4],
      ['lower', 8, 2],
    ])
  })

  it('leaves a resized or moved note alone, and is idempotent', () => {
    for (const n of [note(2), note(4), note(3, { w: 6 }), note(3, { x: 1, w: 11 }), note(3, { type: 'table' })]) {
      const p = pg([n, wd('k', 0, 3, 12, 8)])
      expect(compactSmallSampleNoteV12(p)).toBe(p)
    }
    const once = compactSmallSampleNoteV12(pg([note(), wd('k', 0, 3, 12, 8)]))
    expect(compactSmallSampleNoteV12(once)).toBe(once)
  })

  it('is version-gated: a v12 layout whose note was resized back to three rows keeps it', () => {
    const raw = { version: 12, activePageId: 'bsk-overview', pages: [pg([note(), wd('ow-kpis', 0, 3, 12, 8)])] }
    const out = normalizeConfig(clone(raw))
    expect(out.pages.find((p) => p.id === 'bsk-overview')!.widgets.map((w) => [w.id, w.y, w.h])).toEqual([
      ['ow-note-smallsample', 0, 3],
      ['ow-kpis', 3, 8],
    ])
  })
})
