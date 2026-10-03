// Fit-to-content card height (the reusable-widgets plan, slice 1): an optional `Widget.fit`
// ('content'; absent = the fixed grid height every widget has always had). A fit card measures
// its own content and the dashboard sets its grid height to the smallest whole number of rows
// that holds it (components/Dashboard.vue). Pure helpers live here so the row maths, the "can
// this widget fit at all" rule and the editor's set/clear are unit-testable without a DOM.
import type { Widget } from '../types'

/** The grid's row height and gap in px (components/Dashboard.vue passes both to GridLayout). */
export const GRID_ROW_HEIGHT = 40
export const GRID_MARGIN = 14
/** A fitted card is never shorter than GridItem's `min-h` (3 rows) or taller than this, so a
 * runaway measurement (a card whose content grows with its own height) cannot grow forever. */
export const FIT_MIN_ROWS = 3
export const FIT_MAX_ROWS = 100

/** Widget types that hold a Chart.js / map canvas, which sizes itself against its parent's
 * height (height:100%) and so has no content height of its own to fit. */
export const CHART_CANVAS_TYPES: ReadonlySet<string> = new Set(['bar', 'hbar', 'stackedBar', 'breakdownBar', 'line', 'area', 'doughnut', 'nestedDoughnut', 'pie', 'map'])

/** Does this widget hold a canvas that needs a definite pixel height (ChartCard's
 * `needs-chart-height`)? Content-driven bodies (the overview/campaigns/ads-readings panels and
 * notes) never do. */
export function widgetNeedsChartHeight(w: Pick<Widget, 'dataset' | 'type'>): boolean {
  if (w.dataset === 'overview') return false
  if (w.dataset === 'campaigns' || w.dataset === 'ads-readings' || w.type === 'note') return false
  return CHART_CANVAS_TYPES.has(w.type)
}

/** Can this widget use fit-to-content? Never a canvas widget. A metric card always can, whatever
 * `type` it carries (a saved card keeps its old chart type; its body is not a canvas). */
export function canFit(w: Pick<Widget, 'dataset' | 'type' | 'card'>): boolean {
  return !!w.card || !widgetNeedsChartHeight(w)
}

/** Is fit-to-content in effect for this widget: the option is on and the widget can use it. */
export function isFit(w: Pick<Widget, 'dataset' | 'type' | 'card' | 'fit'>): boolean {
  return w.fit === 'content' && canFit(w)
}

/** The editor's checkbox: on sets `fit: 'content'`; off (or a widget that cannot fit) removes the
 * key, so "off" is stored as absent, exactly like a widget that never had the option. */
export function setFit(draft: Widget, on: boolean): void {
  if (on && canFit(draft)) draft.fit = 'content'
  else delete draft.fit
}

/** Smallest whole number of grid rows whose height holds `px`. A grid item `h` rows tall is
 * `h * rowHeight + (h - 1) * margin` px, so `h = ceil((px + margin) / (rowHeight + margin))`. */
export function fitRows(px: number, rowHeight = GRID_ROW_HEIGHT, margin = GRID_MARGIN, min = FIT_MIN_ROWS, max = FIT_MAX_ROWS): number {
  if (!Number.isFinite(px) || px <= 0) return min
  const rows = Math.ceil((px + margin) / (rowHeight + margin))
  return Math.min(max, Math.max(min, rows))
}

/** A card's content height in px: from its top edge to the bottom of its last in-flow child, plus
 * the bottom border. The card itself stays `height: 100%` of its grid slot, so its own height is
 * never the measure (a slot taller than the content would never shrink). The children are laid out
 * top-down in a column, so the last one's bottom edge is the end of the content. Absolutely
 * positioned children (a note's floating menu) are not content. */
export function naturalCardHeight(card: HTMLElement): number {
  const top = card.getBoundingClientRect().top
  let bottom = top
  for (const child of Array.from(card.children) as HTMLElement[]) {
    const pos = getComputedStyle(child).position
    if (pos === 'absolute' || pos === 'fixed') continue
    bottom = Math.max(bottom, child.getBoundingClientRect().bottom)
  }
  const border = parseFloat(getComputedStyle(card).borderBottomWidth) || 0
  return Math.ceil(bottom - top + border)
}
