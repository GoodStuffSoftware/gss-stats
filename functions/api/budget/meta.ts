/// <reference types="@cloudflare/workers-types" />
//
// GET /api/budget/meta: people, accounts, categories and the date range of the data, for the filter bar
// and the category pickers. Four tiny reads (people, accounts, categories, MIN and MAX over idx_txn_date) in
// one batch. Behind the scoped middleware (identity in `data.budgetEmail`).

import type { MetaResponse } from '../../../src/lib/budget/types'
import { budgetJson } from '../../_lib/budgetAccess'
import { ACCOUNT_COLUMNS, RANGE_SQL, defineRoute, mapAccount, mapCategory, mapPerson } from '../../_lib/budgetDb'

export const onRequest = defineRoute({
  GET: async (ctx) => {
    const db = ctx.env.BUDGET_DB!
    const [people, accounts, categories, range] = await db.batch<Record<string, unknown>>([
      db.prepare('SELECT id, label FROM people ORDER BY sort, id'),
      db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE archived = 0 ORDER BY sort, id`),
      db.prepare('SELECT id, label, color, sort FROM categories WHERE archived = 0 ORDER BY sort, id'),
      db.prepare(RANGE_SQL),
    ])
    const r = range.results[0] ?? {}
    const body: MetaResponse = {
      people: people.results.map(mapPerson),
      accounts: accounts.results.map(mapAccount),
      categories: categories.results.map(mapCategory),
      range: { min: (r.min as string | null) ?? null, max: (r.max as string | null) ?? null },
    }
    return budgetJson(200, body)
  },
})
