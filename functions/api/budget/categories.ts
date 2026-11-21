/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/categories: make a category (the picker's `Add category "<text>"`).
// Body (CategoryCreateRequest): `name`. The name is trimmed, 1-40 characters, no control characters, and not one
// of the picker's own choices (Uncategorized, Transfer, Income, Exclude, Not spending); else 400.
// A name that matches a visible category, ignoring case, is NOT an error: the answer is 200 with that category and
// `created: false` (the caller applies it the same way; two adds of one name at the very same moment can still make
// two categories with the same label, which is harmless). A new category answers 201 with `created: true`.
// The id is 'u-' + a slug of the name, made unique ('-2', '-3'...); the 'u-' prefix is reserved, so the seed tool
// (sqlFile.ts categorySql) can never overwrite, rename or recolour it. It sorts after every existing category
// (MAX(sort) + 10, set in the same statement), so no existing category changes position or palette colour, and it
// has no colour of its own (the palette slot of its position, as the pie and the table dots both compute). Categories
// are all spending: debt, transfer and income are kinds, not categories. The schema has no place for who made it, so
// that is not recorded (the edit that uses it lands in category_edits as usual). The write is one statement, so it
// is atomic; an id taken in a race is retried with the next suffix.

import type { CategoryCreateResponse } from '../../../src/lib/budget/types'
import { categoryNameKey, checkCategoryName, userCategoryId } from '../../../src/lib/budget/categoryName'
import { budgetJson } from '../../_lib/budgetAccess'
import { BudgetHttpError, badRequest, defineRoute, mapCategory, readJsonObject } from '../../_lib/budgetDb'

const MAX_BODY_BYTES = 1024
const MAX_ATTEMPTS = 5

export const onRequest = defineRoute({
  POST: async (ctx) => {
    const db = ctx.env.BUDGET_DB!
    const body = await readJsonObject(ctx.request, MAX_BODY_BYTES)
    const checked = checkCategoryName(body.name)
    if (!checked.ok) throw badRequest(`name: ${checked.reason}`)
    const { name } = checked
    const key = categoryNameKey(name)

    const { results } = await db.prepare('SELECT id, label, color, sort, archived FROM categories').all<Record<string, unknown>>()
    const same = results.find((r) => Number(r.archived) === 0 && categoryNameKey(String(r.label)) === key)
    if (same) {
      const res: CategoryCreateResponse = { category: mapCategory(same), created: false }
      return budgetJson(200, res)
    }

    const taken = new Set(results.map((r) => String(r.id)))
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const id = userCategoryId(name, taken)
      const ins = await db.prepare(
        `INSERT INTO categories (id, label, color, sort, archived)
         SELECT ?, ?, NULL, (SELECT COALESCE(MAX(sort), 0) + 10 FROM categories), 0
         WHERE NOT EXISTS (SELECT 1 FROM categories WHERE id = ?)`,
      ).bind(id, name, id).run()
      if (Number(ins.meta?.changes ?? 0) === 0) {
        taken.add(id)
        continue
      }
      const row = await db.prepare('SELECT id, label, color, sort FROM categories WHERE id = ?').bind(id).first<Record<string, unknown>>()
      const res: CategoryCreateResponse = { category: mapCategory(row!), created: true }
      return budgetJson(201, res)
    }
    throw new BudgetHttpError(409, 'conflict', 'could not find a free id for this category; try again')
  },
})
