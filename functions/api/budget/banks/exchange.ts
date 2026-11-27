/// <reference types="@cloudflare/workers-types" />
//
// POST /api/budget/banks/exchange: swaps the one-time public token Plaid Link hands the browser for a stored Item (plan 3.1).
// Any listed person; the caller becomes the owner. Body `{ consent, publicToken, institution: {id, name}, accounts: [{id, name,
// mask, type, subtype}] }`, at most 8 KB. The Worker does the duplicate check, the slot guard and the exchange (409
// duplicate_item / slots_full pass through). Answers `{ itemId }` only: the Budget id, never Plaid's.

import { BANKS_CONSENT_VERSION } from '../../../../src/lib/budget/types'
import { budgetJson } from '../../../_lib/budgetAccess'
import { BudgetHttpError, badRequest, defineRoute, readJsonObject } from '../../../_lib/budgetDb'
import { BANKS_TIMEOUT_MS, callBanks, isItemId, requireBanks } from '../../../_lib/banks'

export const MAX_BODY_EXCHANGE = 8192
const PUBLIC_TOKEN_RE = /^public-(sandbox|production)-[A-Za-z0-9-]{1,80}$/
const INSTITUTION_ID_RE = /^[A-Za-z0-9_]{1,32}$/
const PLAID_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_ACCOUNTS = 50

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const textOrNull = (v: unknown, max: number, what: string): string | null => {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string' || v.length > max) throw badRequest(`${what}: expected text up to ${max} characters`)
  return v
}

export const onRequest = defineRoute({
  POST: async (ctx) => {
    requireBanks(ctx.env)
    const email = ctx.data.budgetEmail!
    const body = await readJsonObject(ctx.request, MAX_BODY_EXCHANGE)

    if (body.consent !== BANKS_CONSENT_VERSION) throw new BudgetHttpError(400, 'consent_required', 'Agree to the bank-link terms first.')
    if (typeof body.publicToken !== 'string' || !PUBLIC_TOKEN_RE.test(body.publicToken)) throw badRequest('publicToken: not a Plaid public token')
    const inst = body.institution
    if (!isObj(inst)) throw badRequest('institution: expected an object')
    if (inst.id !== undefined && inst.id !== null && (typeof inst.id !== 'string' || !INSTITUTION_ID_RE.test(inst.id))) throw badRequest('institution.id: not valid')
    const institution = { id: typeof inst.id === 'string' ? inst.id : null, name: textOrNull(inst.name, 120, 'institution.name') }
    if (!Array.isArray(body.accounts) || body.accounts.length > MAX_ACCOUNTS) throw badRequest(`accounts: expected a list of at most ${MAX_ACCOUNTS}`)
    const accounts = body.accounts.map((a, i) => {
      if (!isObj(a)) throw badRequest(`accounts[${i}]: expected an object`)
      if (typeof a.id !== 'string' || !PLAID_ID_RE.test(a.id)) throw badRequest(`accounts[${i}].id: not valid`)
      return {
        id: a.id, name: textOrNull(a.name, 120, `accounts[${i}].name`), mask: textOrNull(a.mask, 16, `accounts[${i}].mask`),
        type: textOrNull(a.type, 24, `accounts[${i}].type`), subtype: textOrNull(a.subtype, 48, `accounts[${i}].subtype`),
      }
    })

    const answer = await callBanks(ctx.env, '/exchange', {
      ownerEmail: email.trim().toLowerCase(), consentVersion: BANKS_CONSENT_VERSION, publicToken: body.publicToken, institution, accounts,
    }, BANKS_TIMEOUT_MS.exchange)
    if (!isItemId(answer.itemId)) throw new BudgetHttpError(502, 'banks_failed')
    return budgetJson(200, { itemId: answer.itemId })
  },
})
