// Pure collision-avoidance for the Overall-timeline chart's major-release labels
// (OverviewWidgetBody.vue's Chart.js overlay plugin) — pulled out so the algorithm is
// unit-testable without a canvas (fix/clean-look, 2026-09-26: two markers close together used
// to draw their labels on top of each other, e.g. "v1.86.40v1.87.0"). The plugin still owns
// all actual drawing (ctx.fillText, dashed lines); this just decides WHERE each label goes, or
// whether it's dropped in favor of just the tick/line.
export interface MarkerInput {
  x: number // pixel position (already resolved via the chart's x scale)
  label: string
}

export interface PlacedLabel {
  x: number
  y: number // offset from the top of the chart area, in px (row 0, 1, 2, …)
  label: string // possibly truncated with an ellipsis to fit the chart width
}

export interface MarkerLayoutOptions {
  measureWidth: (text: string) => number // ctx.measureText(text).width in the real plugin
  areaLeft: number
  areaRight: number
  maxRows?: number // default 3
  rowHeight?: number // px between stacked rows, default 11
  minGapPx?: number // minimum horizontal gap between two labels in the same row, default 6
  labelOffsetX?: number // how far right of the marker's own x the label starts, default 4
}

/** Sorts markers left-to-right and greedily assigns each one to the first row (top to bottom)
 * where it doesn't overlap the row's rightmost-so-far label. A marker that doesn't fit in any
 * row (even the last) is dropped from the result entirely — the CALLER still draws its
 * dashed line/tick from the original marker list; only the text placement is decided here. A
 * label wider than the whole chart area is truncated with an ellipsis via `measureWidth`
 * (binary-search-free — the caller's measureWidth is assumed cheap, matching Canvas2D's own
 * measureText). */
export function layoutMarkerLabels(markers: MarkerInput[], opts: MarkerLayoutOptions): PlacedLabel[] {
  const maxRows = opts.maxRows ?? 3
  const rowHeight = opts.rowHeight ?? 11
  const minGapPx = opts.minGapPx ?? 6
  const labelOffsetX = opts.labelOffsetX ?? 4
  const maxW = opts.areaRight - opts.areaLeft - 8

  const sorted = [...markers].sort((a, b) => a.x - b.x)
  const rowRight = new Array(maxRows).fill(-Infinity)
  const placed: PlacedLabel[] = []

  for (const m of sorted) {
    let label = m.label
    let textW = opts.measureWidth(label)
    if (maxW > 0 && textW > maxW) {
      while (label.length > 1 && opts.measureWidth(label + '…') > maxW) label = label.slice(0, -1)
      label = label + '…'
      textW = opts.measureWidth(label)
    }
    const labelX = Math.min(m.x + labelOffsetX, opts.areaRight - textW - 2)
    let row = -1
    for (let r = 0; r < maxRows; r++) {
      if (labelX >= rowRight[r] + minGapPx) {
        row = r
        break
      }
    }
    if (row === -1) continue // no free row without overlapping — drop the label
    placed.push({ x: labelX, y: row * rowHeight, label })
    rowRight[row] = labelX + textW
  }
  return placed
}
