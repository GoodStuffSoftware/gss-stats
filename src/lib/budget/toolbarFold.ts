// How the Budget transactions toolbar row folds so it is ONE row at every width. The row holds an optional lead control (the
// Cards | Table switch), the search and the Filters button. The caller measures the line and the controls (ResizeObserver) and
// asks here; nothing is keyed to a device width. Folding order, as the room shrinks:
//   0  everything inline: lead buttons, search field, Filters
//   1  the lead's buttons fold into one dropdown
//   2  the search folds into an icon button that pops its field out below the row
// The Filters button is never folded away.

export type FoldLevel = 0 | 1 | 2

export interface FoldSizes {
  /** Width (px) of the lead control in its inline form; 0 when there is no lead. */
  lead: number
  /** Width (px) of the lead control folded into a dropdown. */
  leadFolded: number
  /** The least width (px) the inline search field is worth showing at. */
  searchMin: number
  /** Width (px) of the Filters button (its label grows with the count). */
  filters: number
  /** Gap (px) between the controls. */
  gap: number
}

/** The first fold level whose controls all fit in `avail` px; level 2 is the floor and is always allowed. */
export function foldLevel(avail: number, s: FoldSizes): FoldLevel {
  const need = (lead: number) => (lead > 0 ? lead + s.gap : 0) + s.searchMin + s.gap + s.filters
  if (need(s.lead) <= avail) return 0
  if (s.lead > 0 && need(s.leadFolded) <= avail) return 1
  return 2
}

export interface PopPlacement {
  side: 'below' | 'above'
  /** The tallest the pop-out may be (px) so it stays on screen; it scrolls inside itself beyond this. */
  maxHeight: number
}

/**
 * Where a pop-out opens relative to its row: below by default, above when the room below is small and there is more above.
 * `rowTop` / `rowBottom` are the row's viewport coordinates, `viewportH` the visible height. Never smaller than `floor` px.
 */
export function popPlacement(rowTop: number, rowBottom: number, viewportH: number, opts: { gap?: number; edge?: number; floor?: number; roomy?: number } = {}): PopPlacement {
  const { gap = 4, edge = 8, floor = 96, roomy = 220 } = opts
  const below = viewportH - rowBottom - gap - edge
  const above = rowTop - gap - edge
  const side = below >= roomy || below >= above ? 'below' : 'above'
  return { side, maxHeight: Math.max(floor, Math.floor(side === 'below' ? below : above)) }
}
