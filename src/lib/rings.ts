import type { Widget } from '../types'

// A nested doughnut's ring dimensions are configurable beyond the original dimension +
// breakdown pair (see Widget.rings in types.ts). This module is the ONE place that turns a
// widget's config into the effective ring list, so the query layer (api.ts), the render/
// click layer (lib/charts.ts), and the editor UI (ChartEditor.vue) can never disagree on it.

// Soft cap on ring count — a hint only (not enforced): many rings get visually dense fast.
export const RING_SOFT_CAP = 5

// The effective ring list, innermost → outermost: widget.dimension, then widget.breakdown,
// then any further widget.rings — deduped and with blanks dropped. An existing 2-ring widget
// (no `rings`) produces exactly [dimension, breakdown], identical to before this field existed.
export function ringDims(widget: Pick<Widget, 'dimension' | 'breakdown' | 'rings'>): string[] {
  const raw = [widget.dimension, widget.breakdown, ...(widget.rings ?? [])]
  const seen = new Set<string>()
  const out: string[] = []
  for (const d of raw) {
    if (!d || seen.has(d)) continue
    seen.add(d)
    out.push(d)
  }
  return out
}

// The dims to actually send to a stats query: same as ringDims(), except 'date' is dropped
// whenever it isn't the widget's ONLY dimension. 'date' is a derived time bucket (see
// functions/api/geo.ts and stats.ts), not a real equality-groupable column, so it can only
// ever be a chart's sole dimension (a trend series) — never one ring among several.
export function queryDims(widget: Pick<Widget, 'dimension' | 'breakdown' | 'rings'>): string[] {
  const dims = ringDims(widget)
  return dims.length > 1 ? dims.filter((d) => d !== 'date') : dims
}
