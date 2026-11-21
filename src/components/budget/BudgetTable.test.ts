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
    note: null, updatedAt: '2026-10-06T00:00:00Z', updatedBy: 'user@example.com', ...over,
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
const selectOf = (w: VueWrapper, id: string) => rowEl(w, id).get('select').element as HTMLSelectElement

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
    expect(selectOf(w, 't1').value).toBe('groceries')
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
    const sel = selectOf(w, 't1')
    sel.value = 'fuel'
    await w.get('[data-row-key="t1"] select').trigger('change')
    await w.vm.$nextTick()
    expect(selectOf(w, 't1').value).toBe('fuel') // before the server answered
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
    await w.get('[data-row-key="t1"] select').setValue('fuel')
    await flushPromises()
    expect(selectOf(w, 't1').value).toBe('dining')
    expect(w.get('[role="alert"]').text()).toBe('Changed by someone else. It is now Dining.')
    expect(w.emitted('edited')).toBeUndefined()
  })

  it('a network failure puts the row back with a message', async () => {
    mockFetch((url, init) => (init?.method === 'PATCH' ? new TypeError('Failed to fetch') : json({ rows: [txn('t1')], nextCursor: null })))
    // the session probe after a network failure is a fetch too; let it answer
    const w = await mountTable()
    await w.get('[data-row-key="t1"] select').setValue('fuel')
    await flushPromises()
    expect(selectOf(w, 't1').value).toBe('groceries')
    expect(w.get('[role="alert"]').text()).toMatch(/Couldn’t save/)
    expect(w.emitted('edited')).toBeUndefined()
  })

  it('"Not spending: Transfer" sets the kind, not the category', async () => {
    mockFetch((url, init) => init?.method === 'PATCH'
      ? json({ txn: txn('t1', { kind: 'transfer', updatedAt: 'N' }) })
      : json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable()
    const options = Array.from(selectOf(w, 't1').querySelectorAll('optgroup[label="Not spending"] option')).map((o) => o.textContent)
    expect(options).toEqual(['Transfer', 'Income', 'Exclude'])
    await w.get('[data-row-key="t1"] select').setValue('kind:transfer')
    await flushPromises()
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ kind: 'transfer', expectedUpdatedAt: '2026-10-06T00:00:00Z' })
    expect(w.emitted('edited')).toHaveLength(1)
  })

  it('a row edited out of the current slice stays visible, dimmed, "Moved to X"', async () => {
    mockFetch((url, init) => init?.method === 'PATCH'
      ? json({ txn: txn('t1', { categoryId: 'fuel', updatedAt: 'N' }) })
      : json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable({ query: { ...QUERY, category: 'groceries' } })
    await w.get('[data-row-key="t1"] select').setValue('fuel')
    await flushPromises()
    expect(rowEl(w, 't1').classes()).toContain('et-dimmed')
    expect(w.text()).toContain('Moved to Fuel')
  })

  it('read-only when canEdit is false: no select, no buttons, the category as text', async () => {
    mockFetch(() => json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable({ canEdit: false })
    expect(w.find('select').exists()).toBe(false)
    expect(w.find('tbody button').exists()).toBe(false)
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
    await w.get('[data-row-key="t1"] select').setValue('fuel')
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
    expect(selectOf(w, 't2').value).toBe('fuel') // the other row of that merchant on the page followed
  })

  it('says so when no other row changed', async () => {
    mockFetch(rulesFetch(0))
    const w = await mountTable()
    await w.get('[data-row-key="t1"] select').setValue('fuel')
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
    await wrapper.get('[data-row-key="t1"] select').setValue('fuel')
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

describe('BudgetTable purpose note', () => {
  const rows = () => [txn('t1', { note: 'Birthday gift for a friend (made-up)' }), txn('t2', { merchantName: 'Shop Y' }), txn('t3', { merchantName: 'Shop Z', note: '' })]
  it('shows a non-empty note under the merchant with the full text in the title, and nothing for rows without one', async () => {
    mockFetch(() => json({ rows: rows(), nextCursor: null }))
    const w = await mountTable()
    const note = rowEl(w, 't1').get('.bt-note')
    expect(note.text()).toBe('Birthday gift for a friend (made-up)')
    expect(note.attributes('title')).toBe('Birthday gift for a friend (made-up)')
    expect(rowEl(w, 't2').find('.bt-note').exists()).toBe(false)
    expect(rowEl(w, 't3').find('.bt-note').exists()).toBe(false)
  })
  it('shows it in the card layout too', async () => {
    width = 400
    mockFetch(() => json({ rows: rows(), nextCursor: null }))
    const w = await mountTable()
    expect(w.get('li[data-row-key="t1"] .bt-note').text()).toBe('Birthday gift for a friend (made-up)')
    expect(w.find('li[data-row-key="t2"] .bt-note').exists()).toBe(false)
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
    expect(card.get('.et-line2 select').attributes('aria-label')).toBe('Category, Chain X')
    expect(card.find('.et-line2 .cs-dot').exists()).toBe(true)
  })

  it('the card select edits like the table one', async () => {
    width = 400
    mockFetch((url, init) => init?.method === 'PATCH'
      ? json({ txn: txn('t1', { categoryId: 'dining', updatedAt: 'N' }) })
      : json({ rows: [txn('t1')], nextCursor: null }))
    const w = await mountTable()
    await w.get('li[data-row-key="t1"] select').setValue('dining')
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
