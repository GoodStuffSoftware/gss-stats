// ONE place that decides a Budget category's colour, used by the pie slice AND the dot beside the same
// category in the table, so the two always agree. Colours are resolved hex strings (a canvas cannot read the
// site's CSS variables). The theme does not change them; the pie only swaps its slice border per theme.
import { PALETTE } from '../charts'
import { UNCATEGORIZED, type Category } from './types'

/** More hues than the chart palette has, so a list of sixteen categories never repeats a colour: each is
 * far from every colour above it (and from the greys) in hue or lightness. */
const EXTRA_HUES = [
  '#264653', // deep petrol
  '#5AA9E6', // sky
  '#C0508A', // magenta
  '#9B8AD6', // lavender
  '#2F4B7C', // navy
] as const
/** The site's categorical palette without its warm grey (PALETTE[7]), which is kept for "no category", plus
 * EXTRA_HUES: 16 distinct colours, one per seeded category. */
export const CATEGORY_PALETTE: readonly string[] = [...PALETTE.filter((_, i) => i !== 7), ...EXTRA_HUES]
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
  return own ?? paletteSlot(i < 0 ? 0 : i)
}

/** An #rrggbb for hue `h` (degrees), saturation `s` and lightness `l` (0..1). */
function hslHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

/** Slot `i` of the category colours: the palette first, then (a long list, such as a private category set)
 * colours spread round the hue wheel by the golden angle and alternating light and dark, so no two slots
 * share a colour however many categories there are. */
export function paletteSlot(i: number): string {
  if (i < CATEGORY_PALETTE.length) return CATEGORY_PALETTE[i]
  const n = i - CATEGORY_PALETTE.length
  return hslHex((n * 137.508 + 20) % 360, 0.5, n % 2 ? 0.58 : 0.4)
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

/** `hex` mixed toward white by `t` > 0, toward black by `t` < 0 (-1 = black); 0 leaves it. */
export function tint(hex: string, t: number): string {
  if (t >= 0) return lighten(hex, t)
  const m = HEX_RE.exec(hex)
  if (!m) return hex
  const k = Math.min(1, -t)
  const part = (h: string) =>
    Math.round(parseInt(h, 16) * (1 - k))
      .toString(16)
      .padStart(2, '0')
  return `#${part(m[1])}${part(m[2])}${part(m[3])}`
}

const LIGHT_BASE = 150
/** Perceived brightness 0..255 of a #rrggbb colour (255 for anything else, so it is never darkened by mistake). */
function luminance(hex: string): number {
  const m = HEX_RE.exec(hex)
  if (!m) return 255
  return 0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16)
}

/** Mix steps for the slices inside one category, in slice order. They alternate dark and light (no two next to
 * each other are within 0.45 of one another, the wrap from the last step to the first included), so slices of
 * one hue still read apart in either theme. */
const SHADE_STEPS = [0, 0.55, -0.22, 0.33, 0.75] as const

/** Slice `i` of the shades of one base colour (the slices inside one category): the biggest slice is the base
 * colour itself, then SHADE_STEPS, each round of five a touch lighter than the one before. */
export function shadeOf(base: string, i: number): string {
  const t = SHADE_STEPS[i % SHADE_STEPS.length] + Math.floor(i / SHADE_STEPS.length) * 0.07
  // A base that is already light has no room to go lighter: its steps run the other way, toward black.
  return tint(base, luminance(base) > LIGHT_BASE ? -t : t)
}
