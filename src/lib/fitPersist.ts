// What a layout save writes for a fit-to-content card (Widget.fit, lib/fit.ts).
//
// A fit card's grid height follows its content, which depends on the width of the screen it is
// drawn on and on the data it holds. That height is a property of this view, not of the shared
// layout: the layout is one record for every viewer and every width, so a height measured on one
// screen must never be written for the others (a ~740 px page load once saved narrow-screen heights
// over the desktop layout). So a fit card's `h` is held in memory for the grid, and a save writes
// the `h` the card had when the layout was loaded (or when it became a fit card). The cards below a
// fit card move with its fitted height, so their `y` is the same kind of view-only fact: the saved
// `y` values are recomputed from the saved heights, with the grid's own vertical compaction.
//
// The effect: a plain page load changes nothing that is saved, whatever the width, and an edit
// (a drag, a title) saves exactly the edit, never the heights the screen happened to measure.
import type { DashboardConfig, DashboardPage, Widget } from '../types'
import { isFit } from './fit'

/** Saved height of each fit card, keyed `<pageId>/<widgetId>`. */
export type FitBase = Map<string, number>

const keyOf = (page: DashboardPage, w: Widget) => `${page.id}/${w.id}`

/** Bring the record in line with the config: a card that is a fit card and has no record yet is
 * recorded at its current height (the stored one, as this runs before the card first reports);
 * a card that is no longer a fit card, or no longer exists, is dropped. */
export function syncFitBase(base: FitBase, cfg: DashboardConfig): void {
  const seen = new Set<string>()
  for (const page of cfg.pages) {
    for (const w of page.widgets) {
      if (!isFit(w)) continue
      const k = keyOf(page, w)
      seen.add(k)
      if (!base.has(k)) base.set(k, w.h)
    }
  }
  for (const k of [...base.keys()]) if (!seen.has(k)) base.delete(k)
}

function hits(a: Widget, b: Widget): boolean {
  return !(a.x + a.w <= b.x || a.x >= b.x + b.w || a.y + a.h <= b.y || a.y >= b.y + b.h)
}

/** The grid's vertical compaction (grid-layout-plus compact, no static items): items in
 * row-then-column order each move up as far as they go, then down past whatever they collide with.
 * Returns copies; the input is not touched. */
export function packVertically(widgets: Widget[]): Widget[] {
  const sorted = [...widgets].sort((a, b) => (a.y === b.y ? a.x - b.x : a.y - b.y))
  const placed: Widget[] = []
  const packed = new Map<Widget, Widget>()
  for (const w of sorted) {
    const l = { ...w }
    while (l.y > 0 && !placed.some((p) => hits(p, l))) l.y--
    let c: Widget | undefined
    while ((c = placed.find((p) => hits(p, l)))) l.y = c.y + c.h
    placed.push(l)
    packed.set(w, l)
  }
  return widgets.map((w) => packed.get(w)!)
}

/** The config as a save writes it: every fit card at its recorded height, and the pages that hold
 * one packed from those heights. Pages without a fit card are returned as they are. */
export function storedForm(cfg: DashboardConfig, base: FitBase): DashboardConfig {
  if (base.size === 0) return cfg
  return {
    ...cfg,
    pages: cfg.pages.map((page) => {
      if (!page.widgets.some((w) => base.has(keyOf(page, w)))) return page
      const atStored = page.widgets.map((w) => (base.has(keyOf(page, w)) ? { ...w, h: base.get(keyOf(page, w))! } : w))
      return { ...page, widgets: packVertically(atStored) }
    }),
  }
}
