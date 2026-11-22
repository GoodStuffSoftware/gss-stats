/// <reference types="@cloudflare/workers-types" />
//
// GET /api/budget/loans?person=: the Loans page in one read. Every debt as GET /api/budget/debts has it
// (statement vs typed balance, newer wins) plus its newest statement's extras (minimum due, due date,
// payoff, escrow, interest), its terms, that statement's promos, and payments summed per calendar month
// over the last 3 full months (zero months included). Read-only: terms come from the private load.

import { budgetJson } from '../../_lib/budgetAccess'
import { defineRoute, loadLoans, parsePerson } from '../../_lib/budgetDb'

export const onRequest = defineRoute({
  GET: async (ctx) => budgetJson(200, await loadLoans(ctx.env.BUDGET_DB!, parsePerson(new URL(ctx.request.url).searchParams))),
})
