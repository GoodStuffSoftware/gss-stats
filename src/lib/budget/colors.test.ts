import { describe, expect, it } from 'vitest'
import { CATEGORY_PALETTE, categoryColor, lighten, NONE_COLOR, OTHER_COLOR, shadeOf, sortedCategories, tint } from './colors'
import { UNCATEGORIZED, type Category } from './types'

const cat = (id: string, sort: number, color: string | null = null, label = id): Category => ({ id, label, color, sort })
const CATS = [cat('fuel', 20), cat('groceries', 10), cat('dining', 30, '#112233')]

describe('categoryColor', () => {
  it('uses the category own colour, else a palette slot by position in the sorted list', () => {
    expect(sortedCategories(CATS).map((c) => c.id)).toEqual(['groceries', 'fuel', 'dining'])
    expect(categoryColor(CATS, 'groceries')).toBe(CATEGORY_PALETTE[0])
    expect(categoryColor(CATS, 'fuel')).toBe(CATEGORY_PALETTE[1])
    expect(categoryColor(CATS, 'dining')).toBe('#112233')
  })
  it('no category, the uncategorized key and a blank id are the neutral grey; an unknown id takes slot 0', () => {
    expect(categoryColor(CATS, null)).toBe(NONE_COLOR)
    expect(categoryColor(CATS, undefined)).toBe(NONE_COLOR)
    expect(categoryColor(CATS, '')).toBe(NONE_COLOR)
    expect(categoryColor(CATS, UNCATEGORIZED)).toBe(NONE_COLOR)
    expect(categoryColor(CATS, 'unknown')).toBe(CATEGORY_PALETTE[0])
  })
  it('never hands a category the grey kept for "none" or "Other"; every colour is #rrggbb', () => {
    expect(CATEGORY_PALETTE).not.toContain(NONE_COLOR)
    expect(CATEGORY_PALETTE).not.toContain(OTHER_COLOR)
    for (const c of [...CATEGORY_PALETTE, NONE_COLOR, OTHER_COLOR]) expect(c).toMatch(/^#[0-9a-fA-F]{6}$/)
  })
  it('gives every category its own colour, however long the list (the palette first, then spread hues)', () => {
    const many = Array.from({ length: 40 }, (_, i) => cat(`c${String(i).padStart(2, '0')}`, i))
    const colors = many.map((c) => categoryColor(many, c.id))
    expect(new Set(colors).size).toBe(40)
    expect(colors.slice(0, CATEGORY_PALETTE.length)).toEqual([...CATEGORY_PALETTE])
    for (const c of colors) expect(c).toMatch(/^#[0-9a-f]{6}$/i)
    expect(colors).not.toContain(NONE_COLOR)
    expect(colors).not.toContain(OTHER_COLOR)
  })
  it('the palette has the 11 site colours plus 5 more, no two the same', () => {
    expect(CATEGORY_PALETTE).toHaveLength(16)
    expect(new Set(CATEGORY_PALETTE.map((c) => c.toLowerCase())).size).toBe(16)
  })
})

describe('shades', () => {
  it('lighten mixes toward white and leaves a non-hex colour alone', () => {
    expect(lighten('#000000', 0)).toBe('#000000')
    expect(lighten('#000000', 1)).toBe('#ffffff')
    expect(lighten('#ff0000', 0.5)).toBe('#ff8080')
    expect(lighten('rgb(1 2 3)', 0.5)).toBe('rgb(1 2 3)')
  })
  it('the first shade is the base colour, neighbouring shades differ', () => {
    expect(shadeOf('#2C7DA0', 0)).toBe('#2c7da0')
    const shades = Array.from({ length: 12 }, (_, i) => shadeOf('#2C7DA0', i))
    for (let i = 1; i < shades.length; i++) expect(shades[i]).not.toBe(shades[i - 1])
    expect(new Set(shades).size).toBe(12)
  })
  it('tint mixes toward black when negative', () => {
    expect(tint('#ff8040', -1)).toBe('#000000')
    expect(tint('#ff8040', -0.5)).toBe('#804020')
    expect(tint('#ff0000', 0.5)).toBe(lighten('#ff0000', 0.5))
    expect(tint('rgb(1 2 3)', -0.5)).toBe('rgb(1 2 3)')
  })
  it('neighbouring shades are far apart in lightness, wrap-around included, for every palette colour', () => {
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    for (const base of CATEGORY_PALETTE) {
      const shades = Array.from({ length: 12 }, (_, i) => lum(shadeOf(base, i)))
      for (let i = 1; i < shades.length; i++) expect(Math.abs(shades[i] - shades[i - 1]), `${base} ${i}`).toBeGreaterThan(40)
    }
  })
})
