// @vitest-environment happy-dom
// The Banks page with fetch and the Plaid global stubbed: each state, masked last 4 only, owner-only controls, the link
// flow (consent, count prompt, exchange), the per-account switch, new accounts, unlink, dropped rows, the OAuth resume,
// and that no Plaid id, token or cursor reaches the page or the console. Made-up data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import BanksPage from './BanksPage.vue'
import { saveLink, setOAuthReturn } from '../../lib/budget/plaidLink'
import type { Account, BankAccountView, BankItemView, BanksStatus } from '../../lib/budget/types'

const fetchMock = vi.fn()
let wrapper: VueWrapper | null = null
let calls: Array<{ method: string; path: string; body: unknown }> = []

interface Reply { status?: number; body: unknown }
let routes: Record<string, Reply[]> = {}
const R = (key: string, ...r: Reply[]) => {
  routes[key] = r
}

interface Cfg { token: string; receivedRedirectUri?: string; onSuccess: (p: string | null, m: unknown) => void; onExit: (e: unknown, m: unknown) => void }
let cfgs: Cfg[] = []
const handler = { open: vi.fn(), destroy: vi.fn() }
const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = []

beforeEach(() => {
  routes = {}
  calls = []
  cfgs = []
  handler.open.mockClear()
  handler.destroy.mockClear()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const key = `${method} ${url}`
    calls.push({ method, path: url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const r = routes[key]?.length > 1 ? routes[key].shift() : routes[key]?.[0]
    if (!r) throw new Error(`unrouted ${key}`)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  ;(window as unknown as { Plaid?: unknown }).Plaid = { create: (c: Cfg) => (cfgs.push(c), handler) }
  window.localStorage.clear()
  window.history.replaceState(null, '', '/?section=budget&b_page=banks')
  setOAuthReturn(null)
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => {}))
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 900 })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  document.head.querySelectorAll('script[data-gss-plaid]').forEach((s) => s.remove())
  delete (window as unknown as { Plaid?: unknown }).Plaid
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
  consoleSpies.splice(0).forEach((s) => s.mockRestore())
  vi.unstubAllGlobals()
})

const BUDGET_ACCOUNTS: Account[] = [
  { id: 'chk-1', label: 'Household checking', kind: 'checking', personId: null, last4: '0042', isDebt: false, inSpending: true, creditLimitCents: null, aprBp: null },
  { id: 'chk-2', label: 'Spare checking', kind: 'checking', personId: null, last4: '0077', isDebt: false, inSpending: true, creditLimitCents: null, aprBp: null },
  { id: 'card-1', label: 'Everyday card', kind: 'card', personId: null, last4: '0099', isDebt: true, inSpending: true, creditLimitCents: null, aprBp: null },
]
const acct = (over: Partial<BankAccountView> = {}): BankAccountView => ({
  id: 'ba-1', name: 'Everyday Checking', mask: '0042', type: 'depository', subtype: 'checking', sync: 'unmapped', accountId: null, syncFrom: null,
  balanceCents: 123456, availableCents: 120000, limitCents: null, balanceAsOf: '2026-11-27T10:00:00Z', ...over,
})
const item = (over: Partial<BankItemView> = {}, accounts: BankAccountView[] = [acct()]): BankItemView => ({
  id: 'it-1', institutionName: 'Example Bank', status: 'active', mine: true, newAccounts: false, lastOkAt: '2026-11-27T09:00:00Z',
  lastError: null, syncRequested: false, accounts, ...over,
})
const status = (over: Partial<BanksStatus> = {}): BanksStatus => ({
  configured: true, linkEnabled: true, slots: { used: 1, limit: 10, left: 9 }, items: [item()], dropped: [], ...over,
})
const none = (over: Partial<BanksStatus> = {}) => status({ slots: { used: 0, limit: 10, left: 10 }, items: [], ...over })

async function mountPage(s: unknown, props: Record<string, unknown> = { accounts: BUDGET_ACCOUNTS }) {
  R('GET /api/budget/banks/status', { body: s })
  wrapper = mount(BanksPage as never, { attachTo: document.body, props } as never) as unknown as VueWrapper
  await flushPromises()
  return wrapper
}
const text = () => wrapper!.text()
const byId = (id: string) => wrapper!.find(`[data-testid="${id}"]`)
const allById = (id: string) => wrapper!.findAll(`[data-testid="${id}"]`)
const modal = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)

describe('states', () => {
  it('the page loads nothing from Plaid: no script tag before a link starts', async () => {
    await mountPage(status())
    expect(document.querySelectorAll('script[data-gss-plaid]').length).toBe(0)
    expect(cfgs.length).toBe(0)
  })
  it('not configured (status says so): one calm line and no link button', async () => {
    await mountPage({ configured: false, linkEnabled: false, slots: { used: 0, limit: 10, left: 10 }, items: [], dropped: [] })
    expect(byId('banks-not-configured').text()).toBe('Bank links are not set up here.')
    expect(byId('banks-link').exists()).toBe(false)
  })
  it('failed status load shows Retry, which loads again', async () => {
    R('GET /api/budget/banks/status', { status: 500, body: { error: 'server_error' } })
    wrapper = mount(BanksPage as never, { attachTo: document.body, props: { accounts: BUDGET_ACCOUNTS } } as never) as unknown as VueWrapper
    await flushPromises()
    expect(byId('banks-failed').exists()).toBe(true)
    R('GET /api/budget/banks/status', { body: status() })
    await byId('banks-retry').trigger('click')
    await flushPromises()
    expect(byId('banks-failed').exists()).toBe(false)
    expect(byId('banks-slots-count').text()).toBe('1 of 10 bank links used')
  })
  it('a 503 banks_not_configured from an action reads as plain words', async () => {
    await mountPage(none())
    await byId('banks-agree').setValue(true)
    await byId('banks-link').trigger('click')
    await flushPromises()
    R('POST /api/budget/banks/link-token', { status: 503, body: { error: 'banks_not_configured' } })
    modal('banks-link-confirm')!.click()
    await flushPromises()
    expect(byId('banks-notice').text()).toBe('Bank links are not set up here.')
    expect(handler.open).not.toHaveBeenCalled()
  })
})

describe('slot counter', () => {
  const FIXED = "Plaid's free plan allows 10 bank links for life. Unlinking a bank does not give its link back."
  const slotsOf = async (used: number, over: Partial<BanksStatus> = {}) => {
    wrapper?.unmount()
    await mountPage(status({ slots: { used, limit: 10, left: 10 - used }, ...over }))
  }
  it('shows 0 of 10 with no warning and no extra line', async () => {
    await slotsOf(0, { items: [] })
    expect(byId('banks-slots-count').text()).toBe('0 of 10 bank links used')
    expect(byId('banks-slots-extra').exists()).toBe(false)
    expect(byId('banks-slots').classes()).not.toContain('bp-warn')
  })
  it('shows used of limit with no warning while more than 3 are left', async () => {
    await slotsOf(6)
    expect(byId('banks-slots-count').text()).toBe('6 of 10 bank links used')
    expect(byId('banks-slots-extra').exists()).toBe(false)
    expect(byId('banks-slots').classes()).not.toContain('bp-warn')
  })
  it('takes the warning style from 7 used, saying how many are left', async () => {
    await slotsOf(7)
    expect(byId('banks-slots-extra').text()).toBe('Only 3 left.')
    expect(byId('banks-slots').classes()).toContain('bp-warn')
    await slotsOf(9)
    expect(byId('banks-slots-count').text()).toBe('9 of 10 bank links used')
    expect(byId('banks-slots-extra').text()).toBe('Only 1 left.')
    expect(byId('banks-slots').classes()).toContain('bp-warn')
    expect(byId('banks-link').attributes('disabled')).toBeUndefined()
  })
  it('at 10 used says so, keeps the warning style, and turns the link button off', async () => {
    await slotsOf(10, { linkEnabled: false })
    expect(byId('banks-slots-extra').text()).toBe('All 10 are used. More need a paid Plaid plan.')
    expect(byId('banks-slots').classes()).toContain('bp-warn')
    expect(byId('banks-link').attributes('disabled')).toBeDefined()
  })
  it('always shows the free-plan line, at every count', async () => {
    for (const used of [0, 7, 10]) {
      await slotsOf(used, used === 0 ? { items: [] } : {})
      expect(byId('banks-slots').text(), String(used)).toContain(FIXED)
    }
  })
})

describe('link flow', () => {
  it('the first link needs the consent card ticked; Link stays off until then', async () => {
    await mountPage(none())
    expect(byId('banks-consent').exists()).toBe(true)
    expect(byId('banks-consent').text()).toContain('2 years')
    expect(byId('banks-link').attributes('disabled')).toBeDefined()
    await byId('banks-agree').setValue(true)
    expect(byId('banks-link').attributes('disabled')).toBeUndefined()
  })
  it('once this person has linked a bank the consent card is gone', async () => {
    await mountPage(status())
    expect(byId('banks-consent').exists()).toBe(false)
    expect(byId('banks-link').attributes('disabled')).toBeUndefined()
  })
  it('a person with no bank of their own still sees the consent card when the other person has linked one', async () => {
    await mountPage(status({ items: [item({ mine: false })] }))
    expect(byId('banks-consent').exists()).toBe(true)
    expect(byId('banks-link').attributes('disabled')).toBeDefined()
    await byId('banks-agree').setValue(true)
    expect(byId('banks-link').attributes('disabled')).toBeUndefined()
    // Ticked, the link goes through and sends the consent version, which stamps this person's own consent time.
    await byId('banks-link').trigger('click')
    await flushPromises()
    R('POST /api/budget/banks/link-token', { body: { linkToken: 'link-sandbox-aaa', expiration: 'x' } })
    modal('banks-link-confirm')!.click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/link-token'))!.body).toEqual({ consent: 1 })
  })
  it('each person is asked until they have a bank: with both banks present neither sees the card', async () => {
    await mountPage(status({ items: [item({ mine: false }), item({ id: 'it-2', mine: true })] }))
    expect(byId('banks-consent').exists()).toBe(false)
  })
  it('a person with a bank of their own but who has had it revoked is not asked again', async () => {
    await mountPage(status({ items: [item({ status: 'revoked' })] }))
    expect(byId('banks-consent').exists()).toBe(false)
  })
  it('Link a bank asks first (using 1 of N), then makes a token, opens Link, and success exchanges and reloads', async () => {
    await mountPage(none())
    await byId('banks-agree').setValue(true)
    await byId('banks-link').trigger('click')
    await flushPromises()
    expect(modal('banks-link-modal-text')!.textContent).toContain('uses another one')
    expect(document.body.textContent).toContain('Use 1 of your 10 remaining bank links?')
    expect(calls.some((c) => c.path.endsWith('/link-token'))).toBe(false) // nothing sent before confirming

    R('POST /api/budget/banks/link-token', { body: { linkToken: 'link-sandbox-aaa', expiration: 'x' } })
    modal('banks-link-confirm')!.click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/link-token'))!.body).toEqual({ consent: 1 })
    expect(cfgs[0].token).toBe('link-sandbox-aaa')
    expect(handler.open).toHaveBeenCalledTimes(1)

    R('POST /api/budget/banks/exchange', { body: { itemId: 'it-1' } })
    R('GET /api/budget/banks/status', { body: status() })
    cfgs[0].onSuccess('public-sandbox-x', { institution: { institution_id: 'ins_1', name: 'Example Bank' }, accounts: [{ id: 'acc-a', name: 'Everyday Checking', mask: '0042', type: 'depository', subtype: 'checking' }] })
    await flushPromises()
    const ex = calls.find((c) => c.path.endsWith('/exchange'))!
    expect(ex.body).toMatchObject({ consent: 1, publicToken: 'public-sandbox-x', institution: { id: 'ins_1', name: 'Example Bank' } })
    expect(byId('banks-notice').text()).toContain('Bank linked')
    expect(allById('banks-item').length).toBe(1)
    expect(window.localStorage.getItem('gss-banks-link')).toBeNull()
  })
  it('closing Link without finishing frees the button and keeps no token', async () => {
    await mountPage(status())
    await byId('banks-link').trigger('click')
    await flushPromises()
    R('POST /api/budget/banks/link-token', { body: { linkToken: 'link-sandbox-aaa', expiration: 'x' } })
    modal('banks-link-confirm')!.click()
    await flushPromises()
    expect(byId('banks-link').text()).toBe('Working…')
    cfgs[0].onExit(null, {})
    await flushPromises()
    expect(byId('banks-link').text()).toBe('Link a bank')
    expect(window.localStorage.getItem('gss-banks-link')).toBeNull()
  })
  it('a Link script that cannot load says so plainly and frees the button', async () => {
    delete (window as unknown as { Plaid?: unknown }).Plaid
    await mountPage(status())
    await byId('banks-link').trigger('click')
    await flushPromises()
    R('POST /api/budget/banks/link-token', { body: { linkToken: 'link-sandbox-aaa', expiration: 'x' } })
    modal('banks-link-confirm')!.click()
    await flushPromises()
    const el = document.head.querySelector('script[data-gss-plaid]')!
    expect(el.getAttribute('src')).toBe('https://cdn.plaid.com/link/v2/stable/link-initialize.js')
    el.dispatchEvent(new Event('error'))
    await flushPromises()
    expect(byId('banks-notice').text()).toContain('Plaid Link could not load')
    expect(byId('banks-link').text()).toBe('Link a bank')
  })
})

describe('banks and accounts (masked, no ids)', () => {
  it('shows the bank, its status and accounts with the last 4 only', async () => {
    await mountPage(status({ items: [item({}, [acct({ mask: '0042' }), acct({ id: 'ba-2', name: 'Rainy Day', mask: '0077', subtype: 'savings' })])] }))
    expect(byId('banks-item').text()).toContain('Example Bank')
    expect(byId('banks-item-status').text()).toBe('Connected')
    expect(text()).toContain('ending 0042')
    expect(text()).toContain('ending 0077')
    expect(text()).toContain('$1,234.56')
    expect(text().match(/\d{5,}/)).toBeNull() // no run of 5 or more digits anywhere (a balance has a comma, a mask is 4)
  })
  it('no Plaid id, token or cursor reaches the page or the console', async () => {
    await mountPage(status())
    await byId('banks-link').trigger('click')
    await flushPromises()
    R('POST /api/budget/banks/link-token', { body: { linkToken: 'link-sandbox-aaa', expiration: 'x' } })
    modal('banks-link-confirm')!.click()
    await flushPromises()
    R('POST /api/budget/banks/exchange', { body: { itemId: 'it-9' } })
    R('GET /api/budget/banks/status', { body: status() })
    cfgs[0].onSuccess('public-sandbox-x', { institution: { institution_id: 'ins_1', name: 'Example Bank' }, accounts: [{ id: 'acc-plaid-id', name: 'Everyday Checking', mask: '0042', type: 'depository', subtype: 'checking' }] })
    await flushPromises()
    const html = document.body.innerHTML
    for (const bad of ['link-sandbox', 'public-sandbox', 'access-', 'acc-plaid-id', 'ins_1', 'cursor', 'item_id', 'itemId']) expect(html, bad).not.toContain(bad)
    for (const s of consoleSpies) expect(s).not.toHaveBeenCalled()
  })
  it('an owner sees Sync now, Unlink, and the account controls', async () => {
    await mountPage(status())
    expect(byId('banks-sync-now').exists()).toBe(true)
    expect(byId('banks-unlink').exists()).toBe(true)
    expect(byId('banks-other-owner').exists()).toBe(false)
    expect(allById('banks-account-select').length).toBe(1)
    expect(allById('banks-account-select')[0].attributes('disabled')).toBeUndefined()
  })
  it('the other person sees the bank but none of the owner-only controls, and the table is not editable', async () => {
    await mountPage(status({ items: [item({ mine: false, status: 'needs_reconnect', newAccounts: true })] }))
    expect(byId('banks-other-owner').text()).toBe('Linked by the other person.')
    for (const id of ['banks-reconnect', 'banks-unlink', 'banks-new-accounts']) expect(byId(id).exists(), id).toBe(false)
    expect(byId('banks-new-accounts-line').exists()).toBe(false)
    // Not editable: the editor controls are not rendered at all; the cells read as plain text.
    for (const id of ['banks-account-select', 'banks-sync-on', 'banks-sync-off']) expect(allById(id).length, id).toBe(0)
    expect(byId('banks-item').text()).toContain('Everyday Checking')
    expect(text()).toContain('ending 0042')
  })
  it('Reconnect shows for the owner of an item that needs it; Share new accounts when the bank has new ones', async () => {
    await mountPage(status({ items: [item({ status: 'needs_reconnect', newAccounts: true, lastError: 'item_login_required' })] }))
    expect(byId('banks-reconnect').exists()).toBe(true)
    expect(byId('banks-new-accounts').exists()).toBe(true)
    expect(byId('banks-item-error').text()).toBe('The bank login has to be redone. Use Reconnect; nothing syncs until you do.')
    expect(byId('banks-sync-now').attributes('disabled')).toBeDefined()
  })
  it('a needs_reconnect card (a Plaid login-required code, a sync still requested) says to reconnect, not that it retries or is queued', async () => {
    await mountPage(status({ items: [item({ status: 'needs_reconnect', lastError: 'plaid_item_login_required', syncRequested: true })] }))
    expect(byId('banks-item-error').text()).toBe('The bank login has to be redone. Use Reconnect; nothing syncs until you do.')
    expect(byId('banks-item-synced').text()).not.toContain('queued')
    expect(text()).not.toContain('retries on its own')
  })
  it('the other person sees the linker has to reconnect, with no Reconnect button', async () => {
    await mountPage(status({ items: [item({ status: 'needs_reconnect', mine: false, lastError: 'plaid_item_login_required', syncRequested: true })] }))
    expect(byId('banks-item-error').text()).toBe('The person who linked this bank has to reconnect it. Nothing syncs until they do.')
    expect(byId('banks-reconnect').exists()).toBe(false)
    expect(byId('banks-item-synced').text()).not.toContain('queued')
  })
})

/** The requests made after the link token was asked for, as "METHOD path". */
const afterToken = () => calls.slice(calls.findIndex((c) => c.path.endsWith('/link-token')) + 1).map((c) => `${c.method} ${c.path}`)

describe('actions', () => {
  it('Reconnect: update-mode token with the item id, then reconnected, then reload', async () => {
    await mountPage(status({ items: [item({ status: 'needs_reconnect' })] }))
    R('POST /api/budget/banks/link-token', { body: { linkToken: 'link-sandbox-bbb', expiration: 'x' } })
    await byId('banks-reconnect').trigger('click')
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/link-token'))!.body).toEqual({ consent: 1, itemId: 'it-1' })
    R('POST /api/budget/banks/items/it-1/reconnected', { body: { ok: true } })
    R('GET /api/budget/banks/status', { body: status() })
    cfgs[0].onSuccess('public-sandbox-ignored', {})
    await flushPromises()
    expect(afterToken()).toEqual(['POST /api/budget/banks/items/it-1/reconnected', 'GET /api/budget/banks/status'])
    expect(calls.some((c) => c.path.endsWith('/exchange'))).toBe(false)
    expect(byId('banks-notice').text()).toBe('Reconnected.')
  })
  it('Share new accounts: account-selection token, reconnected, then accounts-refresh', async () => {
    await mountPage(status({ items: [item({ newAccounts: true })] }))
    R('POST /api/budget/banks/link-token', { body: { linkToken: 'link-sandbox-ccc', expiration: 'x' } })
    await byId('banks-new-accounts').trigger('click')
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/link-token'))!.body).toEqual({ consent: 1, itemId: 'it-1', accountSelection: true })
    R('POST /api/budget/banks/items/it-1/reconnected', { body: { ok: true } })
    R('POST /api/budget/banks/items/it-1/accounts-refresh', { body: { added: 1 } })
    R('GET /api/budget/banks/status', { body: status() })
    cfgs[0].onSuccess('public-sandbox-ignored', {})
    await flushPromises()
    // In this order, once each, then one status read.
    expect(afterToken()).toEqual([
      'POST /api/budget/banks/items/it-1/reconnected',
      'POST /api/budget/banks/items/it-1/accounts-refresh',
      'GET /api/budget/banks/status',
    ])
    expect(calls.some((c) => c.path.endsWith('/exchange'))).toBe(false)
    expect(byId('banks-notice').text()).toBe('New accounts added below.')
  })
  it('Sync now queues a sync and says when it starts', async () => {
    await mountPage(status())
    R('POST /api/budget/banks/items/it-1/sync', { body: { ok: true } })
    R('GET /api/budget/banks/status', { body: status({ items: [item({ syncRequested: true })] }) })
    await byId('banks-sync-now').trigger('click')
    await flushPromises()
    expect(byId('banks-notice').text()).toBe('Queued. It starts within 10 minutes.')
    expect(byId('banks-item-synced').text()).toContain('A sync is queued.')
  })
  it('Unlink asks first, then unlinks with confirm and reloads', async () => {
    await mountPage(status())
    await byId('banks-unlink').trigger('click')
    await flushPromises()
    expect(modal('banks-unlink-text')!.textContent).toContain('Rows already in Budget stay.')
    expect(calls.some((c) => c.path.endsWith('/unlink'))).toBe(false)
    R('POST /api/budget/banks/items/it-1/unlink', { body: { ok: true } })
    R('GET /api/budget/banks/status', { body: none() })
    modal('banks-unlink-confirm')!.click()
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/unlink'))!.body).toEqual({ confirm: true })
    expect(byId('banks-notice').text()).toContain('Example Bank unlinked.')
    expect(allById('banks-item').length).toBe(0)
  })
  it('a not_owner answer shows its sentence', async () => {
    await mountPage(status())
    R('POST /api/budget/banks/items/it-1/sync', { status: 403, body: { error: 'not_owner' } })
    await byId('banks-sync-now').trigger('click')
    await flushPromises()
    expect(byId('banks-notice').text()).toBe('Only the person who linked this bank can do that.')
  })
})

describe('the per-account switch', () => {
  it('turning Sync on with a chosen Budget account sends it and reloads', async () => {
    await mountPage(status())
    const sel = byId('banks-account-select')
    await sel.setValue('chk-1')
    R('PATCH /api/budget/banks/accounts/ba-1', { body: { ok: true, syncFrom: '2026-11-27' } })
    R('GET /api/budget/banks/status', { body: status({ items: [item({}, [acct({ sync: 'on', accountId: 'chk-1', syncFrom: '2026-11-27' })])] }) })
    await byId('banks-sync-on').trigger('click')
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ sync: 'on', accountId: 'chk-1' })
    expect(text()).toContain('Household checking')
    expect(text()).toContain('Statement rows from that day on will be skipped')
  })
  it('turning Sync on with nothing chosen asks for a Budget account and sends nothing', async () => {
    await mountPage(status())
    await byId('banks-sync-on').trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
    expect(text()).toContain('Choose a Budget account first.')
  })
  it('a Budget account another bank account already feeds is offered but disabled', async () => {
    const other = acct({ id: 'ba-2', name: 'Other', sync: 'on', accountId: 'chk-2' })
    await mountPage(status({ items: [item({}, [acct(), other])] }))
    const opts = byId('banks-account-select').findAll('option')
    const taken = opts.find((o) => o.attributes('value') === 'chk-2')!
    expect(taken.text()).toContain('already syncing')
    expect(taken.attributes('disabled')).toBeDefined()
    expect(opts.some((o) => o.attributes('value') === 'card-1')).toBe(false) // a card does not fit a checking account
    expect(opts.some((o) => o.attributes('value') === '__new')).toBe(true)
  })
  it('New account makes one named after the bank account and tells the Budget page about it', async () => {
    const w = await mountPage(status())
    await byId('banks-account-select').setValue('__new')
    R('PATCH /api/budget/banks/accounts/ba-1', { body: { ok: true, accountId: 'new-acct-1', created: true } })
    R('GET /api/budget/banks/status', { body: status() })
    await byId('banks-sync-on').trigger('click')
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ sync: 'on', newAccount: { name: 'Everyday Checking', kind: 'checking', personId: null } })
    const ev = w.emitted('account-added')!
    expect(ev.length).toBe(1)
    expect(ev[0][0]).toMatchObject({ id: 'new-acct-1', label: 'Everyday Checking', kind: 'checking', last4: '0042', isDebt: false, inSpending: true })
  })
  it('turning Sync off sends sync off', async () => {
    await mountPage(status({ items: [item({}, [acct({ sync: 'on', accountId: 'chk-1' })])] }))
    R('PATCH /api/budget/banks/accounts/ba-1', { body: { ok: true } })
    R('GET /api/budget/banks/status', { body: status() })
    await byId('banks-sync-off').trigger('click')
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ sync: 'off' })
  })
})

describe('rows the bank removed', () => {
  const dropped = [{ txnId: 'tx-1', postedDate: '2026-11-20', amountCents: -2599, description: 'Sample Cafe', accountId: 'chk-1' }]
  it('lists them with Delete and Keep; a choice posts and reloads', async () => {
    await mountPage(status({ dropped }))
    expect(byId('banks-dropped').text()).toContain('Sample Cafe')
    expect(byId('banks-dropped').text()).toContain('Household checking')
    R('POST /api/budget/banks/dropped/tx-1', { body: { ok: true } })
    R('GET /api/budget/banks/status', { body: status() })
    await byId('banks-dropped-keep').trigger('click')
    await flushPromises()
    expect(calls.find((c) => c.path.endsWith('/dropped/tx-1'))!.body).toEqual({ action: 'keep' })
    expect(byId('banks-dropped').exists()).toBe(false)
  })
  it('the section is absent when nothing was removed', async () => {
    await mountPage(status())
    expect(byId('banks-dropped').exists()).toBe(false)
  })
})

describe('OAuth resume', () => {
  it('after a bank redirect the page reopens Link with the saved token and receivedRedirectUri', async () => {
    saveLink('link-sandbox-aaa')
    setOAuthReturn('https://stats.example.com/banks/return?oauth_state_id=abc')
    await mountPage(none())
    expect(cfgs.length).toBe(1)
    expect(cfgs[0]).toMatchObject({ token: 'link-sandbox-aaa', receivedRedirectUri: 'https://stats.example.com/banks/return?oauth_state_id=abc' })
    expect(handler.open).toHaveBeenCalledTimes(1)
    R('POST /api/budget/banks/exchange', { body: { itemId: 'it-1' } })
    R('GET /api/budget/banks/status', { body: status() })
    cfgs[0].onSuccess('public-sandbox-x', { institution: { institution_id: 'ins_1', name: 'Example Bank' }, accounts: [] })
    await flushPromises()
    expect(calls.some((c) => c.path.endsWith('/exchange'))).toBe(true)
  })
  const RETURN = 'https://stats.example.com/banks/return?oauth_state_id=abc'
  it('a Reconnect resumed after the redirect finishes as a Reconnect, even when the bank has new accounts', async () => {
    saveLink('link-sandbox-bbb', 'it-1')
    setOAuthReturn(RETURN)
    await mountPage(status({ items: [item({ status: 'needs_reconnect', newAccounts: true })] }))
    expect(cfgs[0]).toMatchObject({ token: 'link-sandbox-bbb', receivedRedirectUri: RETURN })
    R('POST /api/budget/banks/items/it-1/reconnected', { body: { ok: true } })
    R('GET /api/budget/banks/status', { body: status() })
    const before = calls.length
    cfgs[0].onSuccess('public-sandbox-ignored', {})
    await flushPromises()
    expect(calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/budget/banks/items/it-1/reconnected', 'GET /api/budget/banks/status'])
    expect(calls.some((c) => c.path.endsWith('/exchange') || c.path.endsWith('/accounts-refresh'))).toBe(false)
    expect(byId('banks-notice').text()).toBe('Reconnected.')
  })
  it('a Share-new-accounts resumed after the redirect reconnects, refreshes the accounts, then reloads', async () => {
    saveLink('link-sandbox-ccc', 'it-1', Date.now(), true)
    setOAuthReturn(RETURN)
    await mountPage(status({ items: [item({ newAccounts: true })] }))
    expect(cfgs[0]).toMatchObject({ token: 'link-sandbox-ccc', receivedRedirectUri: RETURN })
    R('POST /api/budget/banks/items/it-1/reconnected', { body: { ok: true } })
    R('POST /api/budget/banks/items/it-1/accounts-refresh', { body: { added: 1 } })
    R('GET /api/budget/banks/status', { body: status() })
    const before = calls.length
    cfgs[0].onSuccess('public-sandbox-ignored', {})
    await flushPromises()
    expect(calls.slice(before).map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/budget/banks/items/it-1/reconnected',
      'POST /api/budget/banks/items/it-1/accounts-refresh',
      'GET /api/budget/banks/status',
    ])
    expect(calls.some((c) => c.path.endsWith('/exchange'))).toBe(false)
    expect(byId('banks-notice').text()).toBe('New accounts added below.')
  })
  it('the mode is saved when the person starts an update, so the resume has it', async () => {
    await mountPage(status({ items: [item({ newAccounts: true })] }))
    R('POST /api/budget/banks/link-token', { body: { linkToken: 'link-sandbox-ccc', expiration: 'x' } })
    await byId('banks-new-accounts').trigger('click')
    await flushPromises()
    expect(JSON.parse(window.localStorage.getItem('gss-banks-link')!)).toMatchObject({ itemId: 'it-1', share: true })
  })
  it('with no saved token nothing reopens', async () => {
    setOAuthReturn('https://stats.example.com/banks/return?oauth_state_id=abc')
    await mountPage(none())
    expect(cfgs.length).toBe(0)
    expect(byId('banks-link').text()).toBe('Link a bank')
  })
  it('an ordinary visit (no OAuth return) never reopens Link', async () => {
    saveLink('link-sandbox-aaa')
    await mountPage(none())
    expect(cfgs.length).toBe(0)
  })
})
