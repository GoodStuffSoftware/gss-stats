// The bank-link route helpers: the binding check, the Worker call (timeout, throw, error codes, non-JSON), and the Item
// owner lookups. The Worker is a fake. Logs carry a path and a code only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BudgetHttpError } from './budgetDb'
import { BANKS_TIMEOUT_MS, callBanks, isItemId, itemOwner, requireBanks, requireOwnItem } from './banks'
import { createBudgetDb, type FakeBudgetDb } from './testing/budgetDb'
import { createFakeBanks, seedBankItem, SECRETS, type FakeBanks } from './testing/banksFake'

let banks: FakeBanks
let errors: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  banks = createFakeBanks()
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const env = () => ({ BANKS: banks.binding }) as never
async function fails(p: Promise<unknown>): Promise<BudgetHttpError> {
  try {
    await p
  } catch (e) {
    if (e instanceof BudgetHttpError) return e
    throw e
  }
  throw new Error('expected a BudgetHttpError')
}

describe('requireBanks', () => {
  it('returns the binding, or 503 banks_not_configured when it is absent or not a fetcher', async () => {
    expect(requireBanks(env())).toBe(banks.binding)
    for (const e of [{}, { BANKS: undefined }, { BANKS: {} }, { BANKS: 'x' }]) {
      try {
        requireBanks(e as never)
        throw new Error('should throw')
      } catch (err) {
        expect(err).toBeInstanceOf(BudgetHttpError)
        expect(err).toMatchObject({ status: 503, code: 'banks_not_configured' })
      }
    }
  })
})

describe('callBanks', () => {
  it('POSTs JSON to the Worker path and returns the parsed 2xx answer', async () => {
    banks.answer('/x', 201, { ok: true, n: 3 })
    expect(await callBanks(env(), '/x', { a: 1 }, 1000)).toEqual({ ok: true, n: 3 })
    expect(banks.calls).toEqual([{ path: '/x', body: { a: 1 } }])
  })

  it('a hung Worker is 504 binding_timeout once the time limit passes', async () => {
    banks.hang('/slow')
    const e = await fails(callBanks(env(), '/slow', {}, 30))
    expect(e).toMatchObject({ status: 504, code: 'binding_timeout' })
  })

  it('a throwing binding is 502 banks_failed', async () => {
    banks.fail('/boom')
    expect(await fails(callBanks(env(), '/boom', {}, 1000))).toMatchObject({ status: 502, code: 'banks_failed' })
  })

  it('a Worker error keeps its status and its fixed code', async () => {
    banks.answer('/x', 409, { code: 'duplicate_item' })
    expect(await fails(callBanks(env(), '/x', {}, 1000))).toMatchObject({ status: 409, code: 'duplicate_item' })
  })

  it('reads the code from `error` too, and falls back to banks_failed for anything not a plain code', async () => {
    banks.answer('/x', 400, { error: 'bad_input' })
    expect(await fails(callBanks(env(), '/x', {}, 1000))).toMatchObject({ status: 400, code: 'bad_input' })
    for (const code of ['Has Space', 'UPPER', '9starts_digit', 'x'.repeat(41), 7, null]) {
      banks.answer('/x', 400, { code })
      expect(await fails(callBanks(env(), '/x', {}, 1000)), String(code)).toMatchObject({ status: 400, code: 'banks_failed' })
    }
  })

  it('a non-2xx, non-error status (a redirect) is 502', async () => {
    banks.answer('/x', 302, {})
    expect(await fails(callBanks(env(), '/x', {}, 1000))).toMatchObject({ status: 502, code: 'banks_failed' })
  })

  it('a non-JSON error body still gives banks_failed with the Worker status', async () => {
    const binding = { fetch: async () => new Response('<html>oops</html>', { status: 503 }) } as unknown as Fetcher
    expect(await fails(callBanks({ BANKS: binding } as never, '/x', {}, 1000))).toMatchObject({ status: 503, code: 'banks_failed' })
  })

  it('a 2xx with a non-object body is an empty answer', async () => {
    const binding = { fetch: async () => new Response('[1,2]', { status: 200 }) } as unknown as Fetcher
    expect(await callBanks({ BANKS: binding } as never, '/x', {}, 1000)).toEqual({})
  })

  it('without the binding it is 503 banks_not_configured and nothing is sent', async () => {
    expect(await fails(callBanks({} as never, '/x', {}, 1000))).toMatchObject({ status: 503, code: 'banks_not_configured' })
  })

  it('logs only the path and a code, never the request body or an error message', async () => {
    banks.answer('/x', 409, { code: 'slots_full', message: 'access-sandbox-secret-9' })
    await fails(callBanks(env(), '/x', { publicToken: 'public-sandbox-secret-7', ownerEmail: 'user-a@example.com' }, 1000))
    banks.fail('/y')
    await fails(callBanks(env(), '/y', { publicToken: 'public-sandbox-secret-7' }, 1000))
    const text = errors.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n')
    expect(text).toContain('/x')
    expect(text).not.toMatch(/secret|user-a@example|simulated/)
  })

  it('has a time limit for every Worker call a route makes', () => {
    for (const k of ['linkToken', 'exchange', 'accounts', 'unlink'] as const) expect(BANKS_TIMEOUT_MS[k]).toBeGreaterThan(0)
  })
})

describe('Item lookups', () => {
  let db: FakeBudgetDb
  beforeEach(async () => {
    db = await createBudgetDb({ seed: false })
    seedBankItem(db, { id: 'i000000000000a001', owner: 'user-a@example.com' })
    seedBankItem(db, { id: 'i000000000000a002', owner: 'user-b@example.com', status: 'revoked', plaidItemId: 'plaid-item-two-002' })
  })

  it('isItemId accepts only i plus 16 lower-case hex', () => {
    expect(isItemId('i000000000000a001')).toBe(true)
    for (const v of ['I000000000000a001', 'i000000000000a00', 'i000000000000a0011', 'i00000000000000g1', 7, null, undefined]) expect(isItemId(v), String(v)).toBe(false)
  })

  it('itemOwner reads one row by primary key, or null (and runs no query for a malformed id)', async () => {
    expect(await itemOwner(db.d1, 'i000000000000a001')).toEqual({ ownerEmail: 'user-a@example.com', status: 'active' })
    expect(await itemOwner(db.d1, 'i000000000000a002')).toEqual({ ownerEmail: 'user-b@example.com', status: 'revoked' })
    expect(await itemOwner(db.d1, 'i000000000000a999')).toBeNull()
    db.statements.length = 0
    expect(await itemOwner(db.d1, "i000000000000a001' OR 1=1")).toBeNull()
    expect(db.statements).toEqual([])
    expect(db.explain('SELECT owner_email, status FROM bank_items WHERE id = ?', ['i000000000000a001']).join('\n')).toMatch(/SEARCH bank_items USING (INDEX sqlite_autoindex_bank_items_1|PRIMARY KEY)|SEARCH bank_items USING INDEX/)
  })

  it('requireOwnItem: the owner passes (address compared trimmed and lower-cased), a missing Item is 404, the other person 403', async () => {
    expect(await requireOwnItem(db.d1, 'i000000000000a001', '  User-A@Example.com ')).toMatchObject({ status: 'active' })
    expect(await fails(requireOwnItem(db.d1, 'i000000000000a999', 'user-a@example.com'))).toMatchObject({ status: 404, code: 'item_not_found' })
    expect(await fails(requireOwnItem(db.d1, 'i000000000000a001', 'user-b@example.com'))).toMatchObject({ status: 403, code: 'not_owner' })
  })

  it('never exposes the token, cursor or Plaid item id from a lookup', async () => {
    const text = JSON.stringify(await itemOwner(db.d1, 'i000000000000a001'))
    for (const s of [SECRETS.tokenCt, SECRETS.cursor, SECRETS.plaidItem]) expect(text).not.toContain(s)
  })
})
