/// <reference types="@cloudflare/workers-types" />
//
// GET /api/budget/debts?person=: every debt account with its latest balance. The balance is the newer of
// the latest statement and the latest typed balance (a tie goes to the statement); `source` says which.
// A debt with neither has `balanceCents: null` (the Debt panel lists it with "Add balance").

import type { DebtsResponse } from '../../../../src/lib/budget/types'
import { budgetJson } from '../../../_lib/budgetAccess'
import { defineRoute, loadDebts, parsePerson } from '../../../_lib/budgetDb'

export const onRequest = defineRoute({
  GET: async (ctx) => {
    const person = parsePerson(new URL(ctx.request.url).searchParams)
    const body: DebtsResponse = { debts: await loadDebts(ctx.env.BUDGET_DB!, person) }
    return budgetJson(200, body)
  },
})
