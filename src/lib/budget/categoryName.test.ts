import { describe, expect, it } from 'vitest'
import { CATEGORY_NAME_MAX, categoryNameKey, categorySlug, checkCategoryName, userCategoryId } from './categoryName'

describe('checkCategoryName', () => {
  it('trims and folds runs of spaces', () => {
    expect(checkCategoryName('  Pet   food \n')).toEqual({ ok: true, name: 'Pet food' })
  })
  it('refuses empty, non-text, too long and built-in names', () => {
    expect(checkCategoryName('   ')).toMatchObject({ ok: false })
    expect(checkCategoryName(null)).toMatchObject({ ok: false })
    expect(checkCategoryName(7)).toMatchObject({ ok: false })
    expect(checkCategoryName('x'.repeat(CATEGORY_NAME_MAX))).toMatchObject({ ok: true })
    expect(checkCategoryName('x'.repeat(CATEGORY_NAME_MAX + 1))).toMatchObject({ ok: false })
    for (const n of ['uncategorized', 'TRANSFER', 'Income', 'exclude', 'Not  Spending']) expect(checkCategoryName(n), n).toMatchObject({ ok: false })
  })
  it('refuses control, separator, zero-width and bidi characters', () => {
    const bad = [0x00, 0x07, 0x09, 0x0a, 0x7f, 0x85, 0x200b, 0x200e, 0x2028, 0x202e, 0x2066, 0xfeff]
    for (const code of bad) expect(checkCategoryName(`a${String.fromCharCode(code)}b`), code.toString(16)).toMatchObject({ ok: false })
    expect(checkCategoryName('Café & Crème')).toMatchObject({ ok: true })
  })
})

describe('categoryNameKey', () => {
  it('ignores case, outer and repeated whitespace', () => {
    expect(categoryNameKey('  Pet  FOOD ')).toBe(categoryNameKey('pet food'))
  })
})

describe('ids', () => {
  it('slugs a name', () => {
    expect(categorySlug('Pet Food & Care')).toBe('pet-food-care')
    expect(categorySlug('Café')).toBe('cafe')
    expect(categorySlug('!!!')).toBe('category')
  })
  it('prefixes u-, never repeats a taken id and stays within 32 characters', () => {
    expect(userCategoryId('Pet food', new Set())).toBe('u-pet-food')
    expect(userCategoryId('Pet food', new Set(['u-pet-food']))).toBe('u-pet-food-2')
    expect(userCategoryId('Pet food', new Set(['u-pet-food', 'u-pet-food-2']))).toBe('u-pet-food-3')
    const long = 'a'.repeat(40)
    const first = userCategoryId(long, new Set())
    const second = userCategoryId(long, new Set([first]))
    expect(first).toHaveLength(32)
    expect(second).toHaveLength(32)
    expect(second).not.toBe(first)
    expect(second).toMatch(/^[a-z0-9-]+$/)
  })
})
