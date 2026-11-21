// The name of a category made in the app: how it is cleaned, compared and turned into an id. Used by the
// create route (functions/api/budget/categories.ts) and by the picker (so "Add category" is offered exactly
// when the server would make a new one). Pure functions, no I/O.

/** categories.label is CHECK length 1..40. */
export const CATEGORY_NAME_MAX = 40
/** Every category made in the app has an id that starts with this; the seed tool refuses to write one (sqlFile.ts), so a
 * re-import can never overwrite, rename or recolour it. categories.id is CHECK length 1..32. */
export const USER_CATEGORY_PREFIX = 'u-'
const ID_MAX = 32

/** Control characters, line and paragraph separators, zero-width and bidi marks: never part of a name (code unit ranges). */
const BAD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff],
]
const hasBadChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (BAD_RANGES.some(([lo, hi]) => c >= lo && c <= hi)) return true
  }
  return false
}
/** The picker's own choices; a category named like one would be unreadable beside it. */
const RESERVED = ['uncategorized', 'transfer', 'income', 'exclude', 'not spending']

/** A name as compared: Unicode-normalised, whitespace collapsed, lower case. */
export function categoryNameKey(s: string): string {
  return s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

export type CategoryNameCheck = { ok: true; name: string } | { ok: false; reason: string }

/** The trimmed name (inner runs of spaces become one), or why it is refused. */
export function checkCategoryName(raw: unknown): CategoryNameCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'expected text' }
  const name = raw.trim().replace(/ {2,}/g, ' ')
  if (name === '') return { ok: false, reason: 'required' }
  if (hasBadChar(name)) return { ok: false, reason: 'contains a control character' }
  if (name.length > CATEGORY_NAME_MAX) return { ok: false, reason: `over ${CATEGORY_NAME_MAX} characters` }
  if (RESERVED.includes(categoryNameKey(name))) return { ok: false, reason: 'is the name of a built-in choice' }
  return { ok: true, name }
}

/** 'Pet Food & Care' -> 'pet-food-care' ('category' when nothing a-z0-9 is left). */
export function categorySlug(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[^\x00-\x7f]/g, '') // accents came apart from their letters; anything else non-ASCII is dropped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'category'
}

/** A new id for `name`: 'u-' + slug, then '-2', '-3'... until it is not in `taken`. Fits the 32-character limit. */
export function userCategoryId(name: string, taken: ReadonlySet<string>): string {
  const base = USER_CATEGORY_PREFIX + categorySlug(name)
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`
    const id = base.slice(0, ID_MAX - suffix.length).replace(/-+$/, '') + suffix
    if (!taken.has(id)) return id
  }
}
