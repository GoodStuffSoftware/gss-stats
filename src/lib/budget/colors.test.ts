import { describe, expect, it } from 'vitest'
import { CATEGORY_PALETTE, categoryColor, lighten, NONE_COLOR, OTHER_COLOR, shadeOf, sortedCategories } from './colors'
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
  it('wraps around when there are more categories than palette slots', () => {
    const many = Array.from({ length: CATEGORY_PALETTE.length + 2 }, (_, i) => cat(`c${String(i).padStart(2, '0')}`, i))
    expect(categoryColor(many, many[CATEGORY_PALETTE.length].id)).toBe(CATEGORY_PALETTE[0])
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
})
