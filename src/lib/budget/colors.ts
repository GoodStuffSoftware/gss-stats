// ONE place that decides a Budget category's colour, used by the pie slice AND the dot beside the same
// category in the table, so the two always agree. Colours are resolved hex strings (a canvas cannot read the
// site's CSS variables). The theme does not change them; the pie only swaps its slice border per theme.
import { PALETTE } from '../charts'
import { UNCATEGORIZED, type Category } from './types'

/** The site's categorical palette without its warm grey (PALETTE[7]), which is kept for "no category". */
export const CATEGORY_PALETTE: readonly string[] = PALETTE.filter((_, i) => i !== 7)
/** A row with no category. */
export const NONE_COLOR = PALETTE[7]
/** The folded "Other" slice: lighter than NONE_COLOR so the two never read as the same thing. */
export const OTHER_COLOR = '#C9C3B8'

/** Categories as the table lists them: by `sort`, then label. */
export function sortedCategories(categories: readonly Category[]): Category[] {
  return [...categories].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label))
}

/** A category's colour: its own `color`, else a slot of the palette by its position in the sorted list.
 * `null`, '' and the uncategorized key give NONE_COLOR; an id not in the list gets the first slot. */
export function categoryColor(categories: readonly Category[], id: string | null | undefined): string {
  if (!id || id === UNCATEGORIZED) return NONE_COLOR
  const sorted = sortedCategories(categories)
  const i = sorted.findIndex((c) => c.id === id)
  const own = i >= 0 ? sorted[i].color : null
  return own ?? CATEGORY_PALETTE[(i < 0 ? 0 : i) % CATEGORY_PALETTE.length]
}

const HEX_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i
/** `hex` mixed toward white by `t` (0 = unchanged, 1 = white). A value that is not #rrggbb comes back as is. */
export function lighten(hex: string, t: number): string {
  const m = HEX_RE.exec(hex)
  if (!m) return hex
  const k = Math.min(1, Math.max(0, t))
  const part = (h: string) =>
    Math.round(parseInt(h, 16) + (255 - parseInt(h, 16)) * k)
      .toString(16)
      .padStart(2, '0')
  return `#${part(m[1])}${part(m[2])}${part(m[3])}`
}

/** Slice `i` of the shades of one base colour (the slices inside one category): steps of lightness, repeating
 * every four so neighbours differ, the biggest slice being the base colour itself. */
export function shadeOf(base: string, i: number): string {
  return lighten(base, (i % 4) * 0.2 + Math.floor(i / 4) * 0.05)
}
