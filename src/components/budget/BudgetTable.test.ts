// @vitest-environment happy-dom
// The Budget table end to end with fetch mocked: paging, the optimistic edit and its reverts, "Use for all", the
// review filter, the layouts and read-only mode. Made-up data only (example.com, made-up merchants and amounts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import BudgetTable from './BudgetTable.vue'
import tableSrc from '../table/EditableTable.vue?raw'
import type { Account, BudgetEditedEvent, BudgetTableProps, Category, Txn, TxnQuery } from '../../lib/budget/types'

const CATS: Category[] = [
  { id: 'groceries', label: 'Groceries', color: null, sort: 10 },
  { id: 'fuel', label: 'Fuel', color: null, sort: 20 },
  { id: 'dining', label: 'Dining', color: null, sort: 30 },
]
const ACCOUNTS: Account[] = [{ id: 'a1', label: 'Checking A', kind: 'checking', personId: null, last4: '0001', isDebt: false, inSpending: true, creditLimitCents: null, aprBp: null }]
const QUERY: TxnQuery = { from: '2026-10-01', to: '2026-10-31', person: 'all', scope: 'spending' }

function txn(id: string, over: Partial<Txn> = {}): Txn {
  return {
    id, accountId: 'a1', postedDate: '2026-10-05', txnDate: null, amountCents: -1234, description: 'CHAIN X 0001', merchantKey: 'chain-x',
    merchantName: 'Chain X', storeNo: null, kind: 'spend', kindSource: 'auto', categoryId: 'groceries', categorySource: 'auto', ruleId: null,
    confidence: 50, needsReview: false, reviewReason: null, pairId: null, debtAccountId: null, principalCents: null, interestCents: null,
    note: null, updatedAt: '2026-10-06T00:00:00Z', updatedBy: 'user@example.com', ruleSafe: true, ...over,
  }
}

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response> | Error
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let calls: Array<{ url: URL; method: string; body: unknown }> = []
function mockFetch(handler: Handler) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'https://stats.example.com')
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const out = handler(url, init)
    if (out instanceof Error) throw out
    return out
  }))
}
const gets = () => calls.filter((c) => c.method === 'GET' && c.url.pathname === '/api/budget/transactions')

let width = 800
let wrapper: VueWrapper | null = null
beforeEach(() => {
  width = 800
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => width })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
})

function baseProps(over: Partial<BudgetTableProps> = {}): BudgetTableProps {
  return { query: QUERY, categories: CATS, accounts: ACCOUNTS, canEdit: true, refreshKey: 0, highlightId: null, ...over }
}
async function mountTable(over: Partial<BudgetTableProps> = {}) {
  wrapper = mount(BudgetTable, { props: baseProps(over), attachTo: document.body })
  await flushPromises()
  return wrapper
}
const rowEl = (w: VueWrapper, id: string) => w.get(`[data-row-key="${id}"]`)
const comboOf = (w: VueWrapper, id: string) => rowEl(w, id).get('input[role="combobox"]')
/** What the category field shows: the label of the current category. */
const comboValue = (w: VueWrapper, id: string) => (comboOf(w, id).element as HTMLInputElement).value
const optionsShown = (w: VueWrapper) => w.findAll('[role="option"]')
/** Opens the row's category list and clicks the option with this label. */
async function pick(w: VueWrapper, id: string, label: string) {
  await comboOf(w, id).trigger('click')
  await flushPromises()
  const opt = optionsShown(w).find((o) => o.text() === label)
  if (!opt) throw new Error('no option "' + label + '"')
  await opt.trigger('click')
  await flushPromises()
}

describe('BudgetTable loading and paging', () => {
  it('loads the first page for the query and shows date, merchant, account, category and amount', async () => {
    mockFetch(() => json({ rows: [txn('t1'), txn('t2', { merchantName: 'Shop Y', amountCents: -500 })], nextCursor: null }))
    const w = await mountTable()
    const req = gets()[0].url.searchParams
    expect(Object.fromEntries(req)).toEqual({ from: '2026-10-01', to: '2026-10-31', person: 'all', scope: 'spending' })
    expect(w.findAll('tbody tr[data-row-key]')).toHaveLength(2)
    const first = rowEl(w, 't1').text()
    expect(first).toContain('Oct 5')
    expect(first).toContain('Chain X')
    expect(first).toContain('Checking A')
    expect(first).toContain('-$12.34')
    expect(comboValue(w, 't1')).toBe('Groceries')
    expect(w.text()).not.toContain('Load more')
  })

  it('"Load more" fetches the next page with the cursor and appends it', async () => {
    mockFetch((url) => url.searchParams.get('cursor')
      ? json({ rows: [txn('t3')], nextCursor: null })
      : json({ rows: [txn('t1'), txn('t2')], nextCursor: 'cur1' }))
    const w = await mountTable()
    await w.get('.bt-more button').trigger('click')
    await flushPromises()
    expect(gets()[1].url.searchParams.get('cursor')).toBe('cur1')
    expect(w.findAll('tbody tr[data-row-key]').map((r) => r.attributes('data-row-key'))).toEqual(['t1', 't2', 't3'])
    expect(w.find('.bt-more').exists()).toBe(false)
  })

  it('a query change resets paging: first page again, no cursor, rows replaced', async () => {
    mockFetch((url) => {
      if (url.searchParams.get('cursor')) return json({ rows: [txn('t3')], nextCursor: null })
      return json(url.searchParams.get('category') === 'fuel'
        ? { rows: [txn('f1', { categoryId: 'fuel' })], nextCursor: null }
        : { rows: [txn('t1'), txn('t2')], nextCursor: 'cur1' })
    })
    const w = await mountTable()
    await w.get('.bt-more button').trigger('click')
    await flushPromises()
    await w.setProps({ query: { ...QUERY, category: 'fuel' } })
    await flushPromises()
    const last = gets().at(-1)!.url.searchParams
    expect(last.get('category')).toBe('fuel')
    expect(last.has('cursor')).toBe(false)
    expect(w.findAll('tbody tr[data-row-key]').map((r) => r.attributes('data-row-key'))).toEqual(['f1'])
    expect(gets()).toHaveLength(3)
  })

  it('an equal query in a new object does not reload', async () => {
    mockFetch(() => json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable()
    await w.setProps({ query: { ...QUERY } })
    await flushPromises()
    expect(gets()).toHaveLength(1)
  })

  it('a load error shows Retry, which loads again', async () => {
    let fail = true
    mockFetch(() => (fail ? json({ error: 'bad_request', message: 'x' }, 400) : json({ rows: [txn('t1')], nextCursor: null })))
    const w = await mountTable()
    expect(w.get('[role="alert"]').text()).toContain('Couldn’t load')
    fail = false
    await w.get('.bt-error button').trigger('click')
    await flushPromises()
    expect(w.find('[data-row-key="t1"]').exists()).toBe(true)
  })
})

describe('BudgetTable review filter and badge', () => {
  it('sends review=1 for reviewOnly and badges flagged rows', async () => {
    mockFetch(() => json({ rows: [txn('t1', { needsReview: true, reviewReason: 'ambiguous_store' }), txn('t2')], nextCursor: null }))
    const w = await mountTable({ query: { ...QUERY, review: true } })
    expect(gets()[0].url.searchParams.get('review')).toBe('1')
    expect(rowEl(w, 't1').find('.bt-badge').text()).toBe('Review')
    expect(rowEl(w, 't2').find('.bt-badge').exists()).toBe(false)
  })

  it('does not send review when the filter is off', async () => {
    mockFetch(() => json({ rows: [], nextCursor: null }))
    await mountTable()
    expect(gets()[0].url.searchParams.has('review')).toBe(false)
  })
})

describe('BudgetTable editing', () => {
  it('updates the row at once, sends PATCH with expectedUpdatedAt, then emits edited once', async () => {
    let release: (r: Response) => void = () => {}
    mockFetch((url, init) => {
      if (init?.method === 'PATCH') return new Promise<Response>((res) => { release = res }) as never
      return json({ rows: [txn('t1')], nextCursor: null })
    })
    const w = await mountTable()
    await pick(w, 't1', 'Fuel')
    expect(comboValue(w, 't1')).toBe('Fuel') // before the server answered
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.url.pathname).toBe('/api/budget/transactions/t1')
    expect(patch.body).toEqual({ categoryId: 'fuel', expectedUpdatedAt: '2026-10-06T00:00:00Z' })
    expect(w.emitted('edited')).toBeUndefined()
    release(json({ txn: txn('t1', { categoryId: 'fuel', categorySource: 'manual', updatedAt: '2026-10-07T00:00:00Z' }) }))
    await flushPromises()
    expect(w.emitted('edited')).toEqual([[{ txnId: 't1', ruleApplied: false, reapplied: 0 } satisfies BudgetEditedEvent]])
    expect(w.get('[role="status"]').text()).toContain('Fuel')
  })

  it('409: the row shows the server value and a message; no edited', async () => {
    mockFetch((url, init) => init?.method === 'PATCH'
      ? json({ error: 'conflict', current: txn('t1', { categoryId: 'dining', updatedAt: 'SERVER' }) }, 409)
      : json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable()
    await pick(w, 't1', 'Fuel')
    await flushPromises()
    expect(comboValue(w, 't1')).toBe('Dining')
    expect(w.get('[role="alert"]').text()).toBe('Changed by someone else. It is now Dining.')
    expect(w.emitted('edited')).toBeUndefined()
  })

  it('a network failure puts the row back with a message', async () => {
    mockFetch((url, init) => (init?.method === 'PATCH' ? new TypeError('Failed to fetch') : json({ rows: [txn('t1')], nextCursor: null })))
    // the session probe after a network failure is a fetch too; let it answer
    const w = await mountTable()
    await pick(w, 't1', 'Fuel')
    await flushPromises()
    expect(comboValue(w, 't1')).toBe('Groceries')
    expect(w.get('[role="alert"]').text()).toMatch(/Couldn’t save/)
    expect(w.emitted('edited')).toBeUndefined()
  })

  it('"Not spending: Transfer" sets the kind, not the category', async () => {
    mockFetch((url, init) => init?.method === 'PATCH'
      ? json({ txn: txn('t1', { kind: 'transfer', updatedAt: 'N' }) })
      : json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable()
    await comboOf(w, 't1').trigger('click')
    const options = optionsShown(w).filter((o) => o.element.closest('[role="group"][aria-label="Not spending"]')).map((o) => o.text())
    expect(options).toEqual(['Transfer', 'Income'])
    await comboOf(w, 't1').trigger('keydown', { key: 'Escape' })
    await pick(w, 't1', 'Transfer')
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ kind: 'transfer', expectedUpdatedAt: '2026-10-06T00:00:00Z' })
    expect(w.emitted('edited')).toHaveLength(1)
  })

  it('a row edited out of the current slice stays visible, dimmed, "Moved to X"', async () => {
    mockFetch((url, init) => init?.method === 'PATCH'
      ? json({ txn: txn('t1', { categoryId: 'fuel', updatedAt: 'N' }) })
      : json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable({ query: { ...QUERY, category: 'groceries' } })
    await pick(w, 't1', 'Fuel')
    await flushPromises()
    expect(rowEl(w, 't1').classes()).toContain('et-dimmed')
    expect(w.text()).toContain('Moved to Fuel')
  })

  it('read-only when canEdit is false: no category field, no buttons, the category as text', async () => {
    mockFetch(() => json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable({ canEdit: false })
    expect(w.find('input:not([data-testid="included-toggle"])').exists()).toBe(false)
    expect(w.find('tbody button:not([data-testid="merchant-tip-toggle"])').exists()).toBe(false)
    expect(rowEl(w, 't1').text()).toContain('Groceries')
  })
})

describe('BudgetTable "Use for all"', () => {
  function rulesFetch(reapplied: number) {
    return (url: URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return json({ txn: txn('t1', { categoryId: 'fuel', categorySource: 'manual', updatedAt: 'N' }) })
      if (url.pathname === '/api/budget/rules') return json({ rule: { id: 'r' + 'b'.repeat(16), merchantKey: 'chain-x', storeNo: null, accountId: null, amountMinCents: null, amountMaxCents: null, setCategoryId: 'fuel', setKind: null, debtAccountId: null, displayName: null, confidence: 90, review: false, reviewReason: null, source: 'edit', active: true }, reapplied })
      return json({ rows: [txn('t1'), txn('t2')], nextCursor: null })
    }
  }

  it('offers the rule after a category change, shows how many rows changed and emits edited', async () => {
    mockFetch(rulesFetch(3))
    const w = await mountTable()
    await pick(w, 't1', 'Fuel')
    await flushPromises()
    const offer = w.get('button.et-action')
    expect(offer.text()).toBe('Use for all Chain X')
    await offer.trigger('click')
    await flushPromises()
    const post = calls.find((c) => c.url.pathname === '/api/budget/rules')!
    expect(post.method).toBe('POST')
    expect(post.body).toEqual({ txnId: 't1', scope: 'merchant' })
    expect(w.text()).toContain('Rule saved. 3 other rows changed.')
    expect(w.find('button.et-action').exists()).toBe(false)
    expect(w.emitted('edited')).toEqual([
      [{ txnId: 't1', ruleApplied: false, reapplied: 0 }],
      [{ txnId: 't1', ruleApplied: true, reapplied: 3 }],
    ])
    expect(comboValue(w, 't2')).toBe('Fuel') // the other row of that merchant on the page followed
  })

  it('shows no "Use for all" when the row\'s key is shared (ruleSafe false), and a confirm does not offer it either', async () => {
    mockFetch((url, init) => (init?.method === 'PATCH'
      ? json({ txn: txn('t1', { categoryId: 'fuel', categorySource: 'manual', updatedAt: 'N', ruleSafe: false }) })
      : json({ rows: [txn('t1', { ruleSafe: false })], nextCursor: null })))
    const w = await mountTable()
    await pick(w, 't1', 'Fuel')
    await flushPromises()
    expect(w.find('button.et-action').exists()).toBe(false)
    expect(calls.some((c) => c.url.pathname === '/api/budget/rules')).toBe(false)
  })

  it('says so when no other row changed', async () => {
    mockFetch(rulesFetch(0))
    const w = await mountTable()
    await pick(w, 't1', 'Fuel')
    await flushPromises()
    await w.get('button.et-action').trigger('click')
    await flushPromises()
    expect(w.text()).toContain('No other rows needed changing')
  })
})

describe('BudgetTable and its parent', () => {
  function parent() {
    const refreshKey = ref(0)
    const edits: BudgetEditedEvent[] = []
    const Parent = defineComponent({
      setup: () => () => h(BudgetTable, { ...baseProps({ refreshKey: refreshKey.value }), onEdited: (e: BudgetEditedEvent) => { edits.push(e); refreshKey.value++ } }),
    })
    return { Parent, refreshKey, edits }
  }

  it('the refreshKey the parent bumps for our own edit does not reload; another bump does', async () => {
    mockFetch((url, init) => init?.method === 'PATCH'
      ? json({ txn: txn('t1', { categoryId: 'fuel', updatedAt: 'N' }) })
      : json({ rows: [txn('t1')], nextCursor: null }))
    const { Parent, refreshKey, edits } = parent()
    wrapper = mount(Parent, { attachTo: document.body }) as unknown as VueWrapper
    await flushPromises()
    await pick(wrapper, 't1', 'Fuel')
    await flushPromises()
    expect(edits).toHaveLength(1)
    expect(refreshKey.value).toBe(1)
    expect(gets()).toHaveLength(1) // no reload: the "moved" notes and the rule offer stay
    expect(wrapper.find('button.et-action').exists()).toBe(true)
    refreshKey.value++ // e.g. a Retry elsewhere on the page
    await flushPromises()
    expect(gets()).toHaveLength(2)
    expect(wrapper.find('button.et-action').exists()).toBe(false)
  })
})

describe('BudgetTable note', () => {
  const NOTE = 'Amazon: birthday gift for a friend (made-up)'
  const rows = () => [txn('t1', { note: NOTE }), txn('t2', { merchantName: 'Shop Y' }), txn('t3', { merchantName: 'Shop Z', note: '' })]
  const noteBtn = (w: VueWrapper, id: string) => rowEl(w, id).get('button.et-text-btn')
  async function editNote(w: VueWrapper, id: string, text: string) {
    await noteBtn(w, id).trigger('click')
    const input = rowEl(w, id).get('input.et-input')
    await input.setValue(text)
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
  }

  it('shows a non-empty note in its own cell, and nothing for rows without one', async () => {
    mockFetch(() => json({ rows: rows(), nextCursor: null }))
    const w = await mountTable()
    expect(rowEl(w, 't1').get('[data-testid="row-note"]').text()).toBe(NOTE)
    expect(rowEl(w, 't2').find('[data-testid="row-note"]').exists()).toBe(false)
    expect(rowEl(w, 't3').find('[data-testid="row-note"]').exists()).toBe(false)
    expect(w.findAll('thead th').map((t) => t.text())).toContain('Note')
  })
  it('shows it in the card layout too (a row without one has only the hidden "Add note" field)', async () => {
    width = 400
    mockFetch(() => json({ rows: rows(), nextCursor: null }))
    const w = await mountTable()
    const note = w.get('li[data-row-key="t1"] [data-testid="row-note"]')
    expect(note.text()).toBe(NOTE)
    expect(note.classes()).toContain('bt-note-card')
    expect(w.find('li[data-row-key="t2"] [data-testid="row-note"]').exists()).toBe(false)
  })
  it('the merchant tip also shows the note, and no note line without one', async () => {
    mockFetch(() => json({ rows: rows(), nextCursor: null }))
    const w = await mountTable()
    await rowEl(w, 't1').get('[data-testid="merchant-tip-toggle"]').trigger('click')
    expect(w.get('[data-testid="merchant-tip-note"]').text()).toBe(NOTE)
    await rowEl(w, 't2').get('[data-testid="merchant-tip-toggle"]').trigger('click')
    expect(w.find('[data-testid="merchant-tip-note"]').exists()).toBe(false)
  })
  it('editing sends only { note, expectedUpdatedAt }, shows the saved row, and does not touch the pie', async () => {
    mockFetch((url, init) => init?.method === 'PATCH'
      ? json({ txn: txn('t2', { merchantName: 'Shop Y', note: 'Made-up reason', updatedAt: '2026-10-07T00:00:00Z' }) })
      : json({ rows: rows(), nextCursor: null }))
    const w = await mountTable()
    await editNote(w, 't2', '  Made-up reason ')
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.url.pathname).toBe('/api/budget/transactions/t2')
    expect(patch.body).toEqual({ note: 'Made-up reason', expectedUpdatedAt: '2026-10-06T00:00:00Z' })
    expect(rowEl(w, 't2').get('[data-testid="row-note"]').text()).toBe('Made-up reason')
    expect(w.emitted('edited')).toBeUndefined()
  })
  it('clearing the text sends note null', async () => {
    mockFetch((url, init) => init?.method === 'PATCH'
      ? json({ txn: txn('t1', { note: null, updatedAt: '2026-10-07T00:00:00Z' }) })
      : json({ rows: rows(), nextCursor: null }))
    const w = await mountTable()
    await editNote(w, 't1', '')
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ note: null, expectedUpdatedAt: '2026-10-06T00:00:00Z' })
    expect(rowEl(w, 't1').find('[data-testid="row-note"]').exists()).toBe(false)
  })
  it('an unchanged note sends nothing', async () => {
    mockFetch(() => json({ rows: rows(), nextCursor: null }))
    const w = await mountTable()
    await editNote(w, 't1', NOTE)
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
  })
  it('a failed save puts the old note back and says so', async () => {
    mockFetch((url, init) => init?.method === 'PATCH' ? json({ error: 'x' }, 500) : json({ rows: rows(), nextCursor: null }))
    const w = await mountTable()
    await editNote(w, 't1', 'Something else (made-up)')
    expect(rowEl(w, 't1').get('[data-testid="row-note"]').text()).toBe(NOTE)
    expect(w.text()).toContain('Couldn’t save (500)')
  })
  it('a note over 500 characters is not sent', async () => {
    mockFetch(() => json({ rows: rows(), nextCursor: null }))
    const w = await mountTable()
    await editNote(w, 't2', 'x'.repeat(501))
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
    expect(w.text()).toContain('over 500 characters')
  })
  it('read-only: the note shows but cannot be edited', async () => {
    mockFetch(() => json({ rows: rows(), nextCursor: null }))
    const w = await mountTable({ canEdit: false })
    expect(rowEl(w, 't1').get('[data-testid="row-note"]').text()).toBe(NOTE)
    expect(rowEl(w, 't1').find('button.et-text-btn').exists()).toBe(false)
  })
})

describe('BudgetTable review reason and "Looks right"', () => {
  const REASON = 'Business? Tech purchase since June, please confirm (made-up)'
  const flagged = (over: Partial<Txn> = {}) => txn('t1', { needsReview: true, reviewReason: REASON as never, categoryId: 'dining', ...over })
  const reviewed = (id: string, over: Partial<Txn> = {}) => txn(id, { categoryId: 'dining', categorySource: 'manual', updatedAt: 'N', ...over })

  it('shows the reason as visible text under the merchant and in the badge tooltip, with the note too', async () => {
    mockFetch(() => json({ rows: [flagged({ note: 'Laptop bag (made-up)' }), txn('t2', { merchantName: 'Shop Y' })], nextCursor: null }))
    const w = await mountTable()
    const r = rowEl(w, 't1')
    expect(r.get('.bt-reason').text()).toBe(REASON)
    expect(r.get('[data-testid="row-note"]').text()).toBe('Laptop bag (made-up)')
    expect(r.get('.bt-badge').attributes('title')).toBe(REASON)
    expect(rowEl(w, 't2').find('.bt-reason').exists()).toBe(false)
    expect(rowEl(w, 't2').find('.bt-confirm').exists()).toBe(false)
  })

  it('a flagged row without a reason shows the badge with the old tooltip and no reason line; engine codes read as words', async () => {
    mockFetch(() => json({ rows: [flagged({ reviewReason: null }), { ...flagged({ reviewReason: 'ambiguous_store' }), id: 't2' }], nextCursor: null }))
    const w = await mountTable()
    expect(rowEl(w, 't1').find('.bt-reason').exists()).toBe(false)
    expect(rowEl(w, 't1').get('.bt-badge').attributes('title')).toBe('Needs a look')
    expect(rowEl(w, 't2').get('.bt-reason').text()).toBe('The store could fit more than one category')
  })

  it('shows the reason in the card layout too', async () => {
    width = 400
    mockFetch(() => json({ rows: [flagged()], nextCursor: null }))
    const w = await mountTable()
    expect(w.get('li[data-row-key="t1"] .bt-reason').text()).toBe(REASON)
    expect(w.get('li[data-row-key="t1"] .bt-confirm').attributes('aria-label')).toBe('Looks right: Chain X')
  })

  it('confirm saves the CURRENT category, then the badge, reason and control are gone and edited is emitted', async () => {
    mockFetch((url, init) => (init?.method === 'PATCH' ? json({ txn: reviewed('t1') }) : json({ rows: [flagged()], nextCursor: null })))
    const w = await mountTable()
    const btn = rowEl(w, 't1').get('.bt-confirm')
    expect(btn.attributes('aria-label')).toBe('Looks right: Chain X')
    await btn.trigger('click')
    await flushPromises()
    const patches = calls.filter((c) => c.method === 'PATCH')
    expect(patches).toHaveLength(1)
    expect(patches[0].url.pathname).toBe('/api/budget/transactions/t1')
    expect(patches[0].body).toEqual({ categoryId: 'dining', expectedUpdatedAt: '2026-10-06T00:00:00Z' })
    const r = rowEl(w, 't1')
    expect(r.find('.bt-badge').exists()).toBe(false)
    expect(r.find('.bt-reason').exists()).toBe(false)
    expect(r.find('.bt-confirm').exists()).toBe(false)
    expect(comboValue(w, 't1')).toBe('Dining')
    expect(w.emitted('edited')).toEqual([[{ txnId: 't1', ruleApplied: false, reapplied: 0 }]])
  })

  it('confirm on a row that is not spending saves its kind', async () => {
    mockFetch((url, init) => (init?.method === 'PATCH' ? json({ txn: reviewed('t1', { kind: 'transfer' }) }) : json({ rows: [flagged({ kind: 'transfer' })], nextCursor: null })))
    const w = await mountTable()
    await rowEl(w, 't1').get('.bt-confirm').trigger('click')
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ kind: 'transfer', expectedUpdatedAt: '2026-10-06T00:00:00Z' })
  })

  it('a failed confirm puts the row back (badge, reason, control) and shows the error a failed category change shows', async () => {
    mockFetch((url, init) => (init?.method === 'PATCH' ? json({ error: 'server_error' }, 500) : json({ rows: [flagged()], nextCursor: null })))
    const w = await mountTable()
    await rowEl(w, 't1').get('.bt-confirm').trigger('click')
    await flushPromises()
    expect(w.get('[role="alert"]').text()).toBe('Couldn’t save (500). The row is back as it was.')
    expect(rowEl(w, 't1').find('.bt-badge').exists()).toBe(true)
    expect(rowEl(w, 't1').find('.bt-reason').text()).toBe(REASON)
    expect(rowEl(w, 't1').get('.bt-confirm').attributes('disabled')).toBeUndefined()
    expect(w.emitted('edited')).toBeUndefined()
  })

  it('in the review list the confirmed row stays, dimmed, until the list reloads', async () => {
    mockFetch((url, init) => (init?.method === 'PATCH' ? json({ txn: reviewed('t1') }) : json({ rows: [flagged()], nextCursor: null })))
    const w = await mountTable({ query: { ...QUERY, review: true } })
    await rowEl(w, 't1').get('.bt-confirm').trigger('click')
    await flushPromises()
    expect(rowEl(w, 't1').classes()).toContain('et-dimmed')
    expect(w.text()).toContain('Reviewed, so it leaves the review list')
  })

  it('read-only: the reason shows but there is no confirm control', async () => {
    mockFetch(() => json({ rows: [flagged()], nextCursor: null }))
    const w = await mountTable({ canEdit: false })
    expect(rowEl(w, 't1').get('.bt-reason').text()).toBe(REASON)
    expect(w.find('.bt-confirm').exists()).toBe(false)
  })
})

describe('BudgetTable layouts and highlight', () => {
  it('under 600 px it is a card list: line 1 date, merchant, amount; line 2 the category select; a dot per row', async () => {
    width = 400
    mockFetch(() => json({ rows: [txn('t1', { needsReview: true })], nextCursor: null }))
    const w = await mountTable()
    expect(w.find('table').exists()).toBe(false)
    const card = w.get('li[data-row-key="t1"]')
    const line1 = card.get('.et-line1').text()
    expect(line1).toContain('Oct 5')
    expect(line1).toContain('Chain X')
    expect(line1).toContain('Review')
    expect(line1).toContain('-$12.34')
    expect(line1).not.toContain('Checking A')
    expect(card.get('.et-line2 input[role="combobox"]').attributes('aria-label')).toBe('Category, Chain X')
    expect(card.find('.et-line2 .cs-dot').exists()).toBe(true)
  })

  it('the card select edits like the table one', async () => {
    width = 400
    mockFetch((url, init) => init?.method === 'PATCH'
      ? json({ txn: txn('t1', { categoryId: 'dining', updatedAt: 'N' }) })
      : json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable()
    await pick(w, 't1', 'Dining')
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ categoryId: 'dining' })
  })

  it('highlightId scrolls to and marks that row', async () => {
    const scroll = vi.fn()
    HTMLElement.prototype.scrollIntoView = scroll
    mockFetch(() => json({ rows: [txn('t1'), txn('t2')], nextCursor: null }))
    const w = await mountTable({ highlightId: 't2' })
    await flushPromises()
    expect(scroll).toHaveBeenCalled()
    expect(rowEl(w, 't2').classes()).toContain('et-highlight')
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView
  })

  it('highlightId loads further pages until it finds the row', async () => {
    const scroll = vi.fn()
    HTMLElement.prototype.scrollIntoView = scroll
    mockFetch((url) => url.searchParams.get('cursor') === 'c1'
      ? json({ rows: [txn('t9')], nextCursor: null })
      : json({ rows: [txn('t1')], nextCursor: 'c1' }))
    const w = await mountTable({ highlightId: 't9' })
    await flushPromises()
    await flushPromises()
    expect(w.find('[data-row-key="t9"]').exists()).toBe(true)
    expect(scroll).toHaveBeenCalled()
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView
  })

  it('the generic table has no budget code in it', () => {
    expect(tableSrc).not.toMatch(/budget|categor|merchant|transaction/i)
  })
})

describe('BudgetTable search and "Add category"', () => {
  /** A parent that owns the category list, as BudgetSection does (meta.categories). */
  function withCategories() {
    const categories = ref<Category[]>([...CATS])
    const added: Category[] = []
    const Parent = defineComponent({
      setup: () => () => h(BudgetTable, {
        ...baseProps({ categories: categories.value }),
        onCategoryAdded: (c: Category) => { added.push(c); categories.value = [...categories.value, c] },
      }),
    })
    return { Parent, categories, added }
  }
  const addFetch = (over: (url: URL, init?: RequestInit) => Response | undefined = () => undefined) => (url: URL, init?: RequestInit) => {
    const special = over(url, init)
    if (special) return special
    if (url.pathname === '/api/budget/categories') return json({ category: { id: 'u-boat-fees', label: 'Boat fees', color: null, sort: 1000 }, created: true }, 201)
    if (init?.method === 'PATCH') return json({ txn: txn('t1', { categoryId: 'u-boat-fees', categorySource: 'manual', updatedAt: '2026-10-07T00:00:00Z' }) })
    return json({ rows: [txn('t1'), txn('t2')], nextCursor: null })
  }
  async function typeAndEnter(w: VueWrapper, id: string, text: string) {
    const input = comboOf(w, id)
    await input.trigger('click')
    ;(input.element as HTMLInputElement).value = text
    await input.trigger('input')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
  }

  it('typing filters the row\'s list', async () => {
    mockFetch(() => json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable()
    await comboOf(w, 't1').trigger('click')
    ;(comboOf(w, 't1').element as HTMLInputElement).value = 'IN'
    await comboOf(w, 't1').trigger('input')
    expect(optionsShown(w).map((o) => o.text()).filter((l) => !l.startsWith('Add'))).toEqual(['Dining', 'Income'])
  })

  it('Add category: creates it, then saves the row with it as any category edit, and it is in every list at once', async () => {
    mockFetch(addFetch())
    const { Parent, added } = withCategories()
    wrapper = mount(Parent, { attachTo: document.body }) as unknown as VueWrapper
    await flushPromises()
    await typeAndEnter(wrapper, 't1', '  Boat fees ')
    const writes = calls.filter((c) => c.method !== 'GET')
    expect(writes.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['POST /api/budget/categories', 'PATCH /api/budget/transactions/t1'])
    expect(writes[0].body).toEqual({ name: 'Boat fees' })
    expect(writes[1].body).toEqual({ categoryId: 'u-boat-fees', expectedUpdatedAt: '2026-10-06T00:00:00Z' })
    expect(added).toEqual([{ id: 'u-boat-fees', label: 'Boat fees', color: null, sort: 1000 }])
    expect(comboValue(wrapper, 't1')).toBe('Boat fees')
    // the other row's list has it with no reload
    await comboOf(wrapper, 't2').trigger('click')
    expect(optionsShown(wrapper).map((o) => o.text())).toContain('Boat fees')
    expect(calls.filter((c) => c.method === 'GET' && c.url.pathname === '/api/budget/transactions')).toHaveLength(1) // no reload
  })

  it('when the server already has that name it returns that category and the row takes it (no duplicate)', async () => {
    mockFetch(addFetch((url) => (url.pathname === '/api/budget/categories'
      ? json({ category: { id: 'fuel', label: 'Fuel', color: null, sort: 20 }, created: false })
      : undefined)))
    const { Parent } = withCategories()
    wrapper = mount(Parent, { attachTo: document.body }) as unknown as VueWrapper
    await flushPromises()
    await typeAndEnter(wrapper, 't1', 'Fue')
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.body).toMatchObject({ categoryId: 'fuel' })
  })

  it('a failed create leaves the row as it was, says so, and sends no PATCH', async () => {
    mockFetch(addFetch((url) => (url.pathname === '/api/budget/categories' ? json({ error: 'bad_request', message: 'name: required' }, 400) : undefined)))
    const { Parent, added } = withCategories()
    wrapper = mount(Parent, { attachTo: document.body }) as unknown as VueWrapper
    await flushPromises()
    await typeAndEnter(wrapper, 't1', 'Boat fees')
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false)
    expect(added).toEqual([])
    expect(comboValue(wrapper, 't1')).toBe('Groceries')
    expect(wrapper.get('[role="alert"]').text()).toBe('Couldn’t add the category (400).')
    expect(rowEl(wrapper, 't1').find('input[role="combobox"]').attributes('disabled')).toBeUndefined()
  })

  it('a create that works but a save that fails (409) keeps the new category in the lists and shows the server row', async () => {
    mockFetch(addFetch((url, init) => (init?.method === 'PATCH'
      ? json({ error: 'conflict', current: txn('t1', { categoryId: 'dining', updatedAt: 'SERVER' }) }, 409)
      : undefined)))
    const { Parent, added } = withCategories()
    wrapper = mount(Parent, { attachTo: document.body }) as unknown as VueWrapper
    await flushPromises()
    await typeAndEnter(wrapper, 't1', 'Boat fees')
    expect(added).toHaveLength(1)
    expect(comboValue(wrapper, 't1')).toBe('Dining')
    expect(wrapper.get('[role="alert"]').text()).toContain('Changed by someone else')
  })
})

describe('BudgetTable Included switch', () => {
  const toggleOf = (w: VueWrapper, id: string) => rowEl(w, id).get('[data-testid="included-toggle"]')
  const checked = (w: VueWrapper, id: string) => (toggleOf(w, id).element as HTMLInputElement).checked

  it('is the last column, right after Amount, headed Included, and is on by default', async () => {
    mockFetch(() => json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable()
    const heads = w.findAll('thead th').map((h) => h.text())
    expect(heads.at(-1)).toBe('Included')
    expect(heads.at(-2)).toBe('Amount')
    const cells = rowEl(w, 't1').findAll('td')
    expect(cells.at(-2)!.text()).toContain('-$12.34')
    expect(cells.at(-1)!.find('[data-testid="included-toggle"]').exists()).toBe(true)
    expect(checked(w, 't1')).toBe(true)
    expect(cells.at(-1)!.get('label').attributes('title')).toBe('Count in totals')
  })

  it('shows the switch only on spend, refund and fee rows (a transfer, card payment or income row has none), unless already excluded', async () => {
    mockFetch(() => json({ rows: [
      txn('s1'), txn('r1', { kind: 'refund' }), txn('f1', { kind: 'fee' }),
      txn('x1', { kind: 'transfer', categoryId: null }), txn('c1', { kind: 'card_payment', categoryId: null }), txn('i1', { kind: 'income', categoryId: null }),
      txn('x2', { kind: 'transfer', categoryId: null, included: false }),
    ], nextCursor: null }))
    const w = await mountTable()
    const has = (id: string) => rowEl(w, id).find('[data-testid="included-toggle"]').exists()
    for (const id of ['s1', 'r1', 'f1', 'x2']) expect(has(id), id).toBe(true)
    for (const id of ['x1', 'c1', 'i1']) expect(has(id), id).toBe(false)
  })

  it('is never in the category picker', async () => {
    mockFetch(() => json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable()
    await comboOf(w, 't1').trigger('click')
    await flushPromises()
    expect(optionsShown(w).map((o) => o.text()).join(' ')).not.toMatch(/included|count in totals/i)
  })

  it.each([390, 320])('in the card layout at %i px it sits on line 1, right of the amount', async (px) => {
    width = px
    mockFetch(() => json({ rows: [txn('t1', { included: false })], nextCursor: null }))
    const w = await mountTable()
    const parts = w.get('li[data-row-key="t1"] .et-line1').findAll('.et-part')
    expect(parts.at(-2)!.text()).toContain('-$12.34')
    expect(parts.at(-1)!.find('[data-testid="included-toggle"]').exists()).toBe(true)
    expect(checked(w, 't1')).toBe(false)
  })

  it('turning it off sends only { included, expectedUpdatedAt }, shows it off at once, emits edited, and leaves category and kind alone', async () => {
    let release: (r: Response) => void = () => {}
    mockFetch((url, init) => {
      if (init?.method === 'PATCH') return new Promise<Response>((res) => { release = res }) as never
      return json({ rows: [txn('t1')], nextCursor: null })
    })
    const w = await mountTable()
    await toggleOf(w, 't1').setValue(false)
    expect(checked(w, 't1')).toBe(false)
    expect(comboValue(w, 't1')).toBe('Groceries')
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.url.pathname).toBe('/api/budget/transactions/t1')
    expect(patch.body).toEqual({ included: false, expectedUpdatedAt: '2026-10-06T00:00:00Z' })
    expect(w.emitted('edited')).toBeUndefined()
    release(json({ txn: txn('t1', { included: false, updatedAt: '2026-10-07T00:00:00Z' }) }))
    await flushPromises()
    expect(w.emitted('edited')).toEqual([[{ txnId: 't1', ruleApplied: false, reapplied: 0 } satisfies BudgetEditedEvent]])
    expect(checked(w, 't1')).toBe(false)
    expect(comboValue(w, 't1')).toBe('Groceries')
    expect(rowEl(w, 't1').text()).toContain('Chain X')
  })

  it('turning it back on sends included true', async () => {
    mockFetch((url, init) => init?.method === 'PATCH'
      ? json({ txn: txn('t1', { included: true, updatedAt: '2026-10-08T00:00:00Z' }) })
      : json({ rows: [txn('t1', { included: false })], nextCursor: null }))
    const w = await mountTable()
    await toggleOf(w, 't1').setValue(true)
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ included: true, expectedUpdatedAt: '2026-10-06T00:00:00Z' })
    expect(checked(w, 't1')).toBe(true)
  })

  it('a failed save puts the switch back and says so', async () => {
    mockFetch((url, init) => init?.method === 'PATCH' ? json({ error: 'x' }, 500) : json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable()
    await toggleOf(w, 't1').setValue(false)
    await flushPromises()
    expect(checked(w, 't1')).toBe(true)
    expect(w.get('[role="alert"]').text()).toContain('Couldn’t save')
    expect(w.emitted('edited')).toBeUndefined()
  })

  it('is disabled when the viewer cannot edit', async () => {
    mockFetch(() => json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable({ canEdit: false })
    expect((toggleOf(w, 't1').element as HTMLInputElement).disabled).toBe(true)
  })

  it('a click, a tap and a press-and-hold on it reach nothing outside: no event bubbles to the row, no drill', async () => {
    mockFetch((url, init) => init?.method === 'PATCH' ? json({ txn: txn('t1', { included: false }) }) : json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable()
    const seen: string[] = []
    const row = rowEl(w, 't1').element
    for (const ev of ['click', 'pointerdown', 'touchstart', 'contextmenu']) row.addEventListener(ev, () => seen.push(ev))
    const label = rowEl(w, 't1').get('label.bt-included')
    for (const ev of ['click', 'pointerdown', 'touchstart', 'contextmenu']) await label.trigger(ev)
    expect(seen).toEqual([])
    expect(w.emitted('drill')).toBeUndefined()
  })
})

describe('BudgetTable merchant tip', () => {
  const rows = () => json({ rows: [txn('t1', { merchantName: 'Chain X', description: 'CHAIN X 0001 SAMPLE CITY' }), txn('t2', { merchantName: 'Shop Y', description: 'Shop Y' })], nextCursor: null })
  const toggles = (w: VueWrapper) => w.findAll('[data-testid="merchant-tip-toggle"]')

  it('keeps the raw description as the hover title', async () => {
    mockFetch(rows)
    const w = await mountTable()
    expect(toggles(w)[0].attributes('title')).toBe('CHAIN X 0001 SAMPLE CITY')
  })
  it('a tap shows the merchant and the raw statement description; a second tap closes it', async () => {
    mockFetch(rows)
    const w = await mountTable()
    expect(w.find('[data-testid="merchant-tip"]').exists()).toBe(false)
    await toggles(w)[0].trigger('click')
    const tip = w.get('[data-testid="merchant-tip"]')
    expect(tip.text()).toContain('Chain X')
    expect(tip.get('[data-testid="merchant-tip-desc"]').text()).toBe('CHAIN X 0001 SAMPLE CITY')
    expect(toggles(w)[0].attributes('aria-expanded')).toBe('true')
    await toggles(w)[0].trigger('click')
    expect(w.find('[data-testid="merchant-tip"]').exists()).toBe(false)
  })
  it('shows no second line when the description equals the merchant text', async () => {
    mockFetch(rows)
    const w = await mountTable()
    await toggles(w)[1].trigger('click')
    expect(w.find('[data-testid="merchant-tip-desc"]').exists()).toBe(false)
  })
  it('only one tip is open: tapping another merchant moves it', async () => {
    mockFetch(rows)
    const w = await mountTable()
    await toggles(w)[0].trigger('click')
    await toggles(w)[1].trigger('click')
    expect(w.findAll('[data-testid="merchant-tip"]')).toHaveLength(1)
    expect(w.get('[data-testid="merchant-tip"]').text()).toContain('Shop Y')
  })
  it('a tap outside, or Escape, closes it', async () => {
    mockFetch(rows)
    const w = await mountTable()
    await toggles(w)[0].trigger('click')
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(w.find('[data-testid="merchant-tip"]').exists()).toBe(false)
    await toggles(w)[0].trigger('click')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(w.find('[data-testid="merchant-tip"]').exists()).toBe(false)
  })
  it('a pointer press inside the tip leaves it open', async () => {
    mockFetch(rows)
    const w = await mountTable()
    await toggles(w)[0].trigger('click')
    w.get('[data-testid="merchant-tip"]').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(w.find('[data-testid="merchant-tip"]').exists()).toBe(true)
  })
  it('stays inside a 390px viewport', async () => {
    mockFetch(rows)
    const w = await mountTable()
    Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => 390 })
    const el = toggles(w)[0].element
    el.getBoundingClientRect = () => ({ left: 300, right: 380, top: 100, bottom: 120, width: 80, height: 20, x: 300, y: 100, toJSON: () => ({}) })
    await toggles(w)[0].trigger('click')
    const style = (w.get('[data-testid="merchant-tip"]').element as HTMLElement).style
    const left = parseFloat(style.left)
    const width = parseFloat(style.width)
    expect(left).toBeGreaterThanOrEqual(8)
    expect(left + width).toBeLessThanOrEqual(390 - 8)
    delete (document.documentElement as unknown as Record<string, unknown>).clientWidth
  })
})
