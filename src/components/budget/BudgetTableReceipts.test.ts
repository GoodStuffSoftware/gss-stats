// @vitest-environment happy-dom
// The Receipt block on Budget transactions: links fetched in batches of at most 200, the row line, the tip, a note-less row
// that still peeks, and a failed or empty answer that leaves the table as it was. Made-up data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import BudgetTable from './BudgetTable.vue'
import { LINK_BATCH } from '../../lib/budget/tableModel'
import type { Account, BudgetTableProps, Category, Txn, TxnQuery } from '../../lib/budget/types'

const CATS: Category[] = [{ id: 'groceries', label: 'Groceries', color: null, sort: 10 }]
const ACCOUNTS: Account[] = [{ id: 'a1', label: 'Checking A', kind: 'checking', personId: null, last4: '0001', isDebt: false, inSpending: true, creditLimitCents: null, aprBp: null }]
const QUERY: TxnQuery = { from: '2026-10-01', to: '2026-10-31', person: 'all', scope: 'spending' }
const hex = (n: number) => n.toString(16).padStart(32, '0')
const GOOD_ID = '18c0ffee12345678'

function txn(id: string, over: Partial<Txn> = {}): Txn {
  return {
    id, accountId: 'a1', postedDate: '2026-10-05', txnDate: null, amountCents: -1234, description: 'CHAIN X 0001', merchantKey: 'chain-x',
    merchantName: 'Chain X', storeNo: null, kind: 'spend', kindSource: 'auto', categoryId: 'groceries', categorySource: 'auto', ruleId: null,
    confidence: 50, needsReview: false, reviewReason: null, pairId: null, debtAccountId: null, principalCents: null, interestCents: null,
    note: null, updatedAt: '2026-10-06T00:00:00Z', updatedBy: 'user@example.com', ruleSafe: true, ...over,
  }
}
const receipt = (over: Record<string, unknown> = {}) => ({
  merchant: 'Corner Shop', date: '2026-10-05', totalCents: 1234, taxCents: 98, currency: 'USD', orderRef: 'ORD-1', cardLast4: '4242',
  items: [{ description: 'Widget', quantity: 2, amountCents: 500, categoryId: null, category: null }], ...over,
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let calls: Array<{ path: string; method: string; body: { txnIds?: string[] } | undefined }> = []
function mockApi(rows: Txn[], links: (ids: string[]) => Response | Error) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input, 'https://stats.example.com')
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ path: url.pathname, method: init?.method ?? 'GET', body })
    if (url.pathname === '/api/budget/email/links') {
      const out = links(body.txnIds)
      if (out instanceof Error) throw out
      return out
    }
    if (url.pathname === '/api/budget/transactions') return json({ rows, nextCursor: null })
    return json({})
  }))
}
const linkCalls = () => calls.filter((c) => c.path === '/api/budget/email/links')

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
async function mountTable(over: Partial<BudgetTableProps> = {}) {
  wrapper = mount(BudgetTable, { props: { query: QUERY, categories: CATS, accounts: ACCOUNTS, canEdit: true, refreshKey: 0, highlightId: null, ...over }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
const rowEl = (w: VueWrapper, id: string) => w.get(`[data-row-key="${id}"]`)
const noteBtn = (w: VueWrapper, id: string) => rowEl(w, id).get('button.et-text-btn')

const A = hex(1)
const B = hex(2)
const C = hex(3)

describe('BudgetTable receipt links', () => {
  it('asks once for the loaded rows and shows a receipt line only where one came back', async () => {
    mockApi([txn(A), txn(B, { note: 'weekly shop' }), txn(C)], () => json({ links: { [A]: receipt(), [B]: receipt({ merchant: 'Big Store', totalCents: 5000 }) } }))
    const w = await mountTable()
    expect(linkCalls()).toHaveLength(1)
    expect(linkCalls()[0].body!.txnIds).toEqual([A, B, C])
    expect(rowEl(w, A).get('[data-testid="row-receipt"]').text()).toBe('Receipt: Corner Shop · $12.34')
    expect(rowEl(w, B).get('[data-testid="row-receipt"]').text()).toBe('Receipt: Big Store · $50.00')
    expect(rowEl(w, B).get('[data-testid="row-note"]').text()).toBe('weekly shop')
    expect(rowEl(w, C).find('[data-testid="row-receipt"]').exists()).toBe(false)
    expect(rowEl(w, C).get('.bt-note-empty').text()).toBe('Add note')
    // A receipt row with no note keeps the faint prompt, after the receipt line.
    const aHtml = rowEl(w, A).html()
    expect(rowEl(w, A).get('.bt-note-empty').text()).toBe('Add note')
    expect(aHtml.indexOf('data-testid="row-receipt"')).toBeLessThan(aHtml.indexOf('bt-note-empty'))
  })
  it('never sends more than 200 ids in one request', async () => {
    const rows = Array.from({ length: 450 }, (_, n) => txn(hex(n + 1)))
    mockApi(rows, () => json({ links: {} }))
    await mountTable()
    const sizes = linkCalls().map((c) => c.body!.txnIds!.length)
    expect(LINK_BATCH).toBe(200)
    expect(sizes).toEqual([200, 200, 50])
    expect(new Set(linkCalls().flatMap((c) => c.body!.txnIds!)).size).toBe(450)
  })
  it('skips ids the route would refuse, and asks nothing when there are none', async () => {
    mockApi([txn('t1'), txn('t2')], () => json({ links: {} }))
    await mountTable()
    expect(linkCalls()).toHaveLength(0)
  })
  it('does not ask again on a re-render', async () => {
    mockApi([txn(A)], () => json({ links: { [A]: receipt() } }))
    const w = await mountTable()
    await w.setProps({ canEdit: false })
    await flushPromises()
    expect(linkCalls()).toHaveLength(1)
  })
  it('a failed fetch leaves the table as it is, with no error shown', async () => {
    mockApi([txn(A)], () => new TypeError('network down'))
    const w = await mountTable()
    expect(w.find('[role="alert"]').exists()).toBe(false)
    expect(w.find('[data-testid="row-receipt"]').exists()).toBe(false)
    expect(rowEl(w, A).get('.bt-note-empty').text()).toBe('Add note')
  })
  it('a refused or empty answer (no access, or none mode) also changes nothing', async () => {
    mockApi([txn(A)], () => json({ error: 'forbidden' }, 403))
    const w1 = await mountTable()
    expect(w1.find('[role="alert"]').exists()).toBe(false)
    expect(w1.find('[data-testid="row-receipt"]').exists()).toBe(false)
    w1.unmount()
    wrapper = null
    mockApi([txn(A)], () => json({ links: {} }))
    const w2 = await mountTable()
    expect(w2.find('[data-testid="row-receipt"]').exists()).toBe(false)
  })
  it('ignores answers for ids it did not ask about, and non-object answers', async () => {
    mockApi([txn(A), txn(B)], () => json({ links: { [A]: 'oops', [B]: [1], [hex(99)]: receipt(), __proto__: receipt() } }))
    const w = await mountTable()
    expect(w.find('[data-testid="row-receipt"]').exists()).toBe(false)
  })
})

describe('BudgetTable receipt tip', () => {
  it('a click shows the note and, under it, the Receipt block with the Gmail link for the owner', async () => {
    mockApi([txn(A, { note: 'weekly shop' })], () => json({ links: { [A]: receipt({ gmailMsgId: GOOD_ID }) } }))
    const w = await mountTable()
    await noteBtn(w, A).trigger('click')
    const tip = w.get('[data-testid="merchant-tip"]')
    expect(tip.get('[data-testid="note-tip"]').text()).toBe('weekly shop')
    expect(tip.get('[data-testid="receipt-block"]').text()).toContain('Corner Shop')
    expect(tip.get('a[data-testid="receipt-gmail"]').attributes('href')).toBe(`https://mail.google.com/mail/#all/${GOOD_ID}`)
    // the note comes before the block
    expect(tip.html().indexOf('note-tip')).toBeLessThan(tip.html().indexOf('receipt-block'))
  })
  it('without gmailMsgId (the other person) the block shows and there is no link', async () => {
    mockApi([txn(A, { note: 'n' })], () => json({ links: { [A]: receipt() } }))
    const w = await mountTable()
    await noteBtn(w, A).trigger('click')
    expect(w.find('[data-testid="receipt-block"]').exists()).toBe(true)
    expect(w.find('a[data-testid="receipt-gmail"]').exists()).toBe(false)
  })
  it('a bad gmailMsgId gives no link', async () => {
    mockApi([txn(A, { note: 'n' })], () => json({ links: { [A]: receipt({ gmailMsgId: 'javascript:alert(1)' }) } }))
    const w = await mountTable()
    await noteBtn(w, A).trigger('click')
    expect(w.find('[data-testid="receipt-block"]').exists()).toBe(true)
    expect(w.find('.bt-tip a').exists()).toBe(false)
  })
  it('a row with a receipt but no note still peeks on click instead of opening the editor', async () => {
    mockApi([txn(A)], () => json({ links: { [A]: receipt() } }))
    const w = await mountTable()
    await noteBtn(w, A).trigger('click')
    expect(w.find('[data-testid="receipt-block"]').exists()).toBe(true)
    expect(w.find('[data-testid="note-tip"]').exists()).toBe(false)
    expect(rowEl(w, A).find('.et-input').exists()).toBe(false)
  })
  it('opt-in only: a row with no note and no receipt still opens the editor on click', async () => {
    mockApi([txn(A), txn(B)], () => json({ links: { [A]: receipt() } }))
    const w = await mountTable()
    await noteBtn(w, B).trigger('click')
    expect(rowEl(w, B).find('textarea.et-input').exists()).toBe(true)
    expect(w.find('[data-testid="receipt-block"]').exists()).toBe(false)
  })
  it('hostile receipt fields in the tip stay text', async () => {
    const bad = '<img src=x onerror=alert(1)>"><script>x</script>'
    mockApi([txn(A)], () => json({ links: { [A]: receipt({ merchant: bad, orderRef: bad, items: [{ description: bad, quantity: 1, amountCents: 1, categoryId: null, category: null }], gmailMsgId: GOOD_ID }) } }))
    const w = await mountTable()
    await noteBtn(w, A).trigger('click')
    const tip = w.get('[data-testid="merchant-tip"]')
    expect(tip.find('img').exists()).toBe(false)
    expect(tip.find('script').exists()).toBe(false)
    expect(tip.findAll('a')).toHaveLength(1)
    expect(w.get('[data-testid="row-receipt"]').element.querySelector('img')).toBeNull()
  })
  it('the merchant tip carries the block too', async () => {
    mockApi([txn(A)], () => json({ links: { [A]: receipt() } }))
    const w = await mountTable()
    await rowEl(w, A).get('[data-testid="merchant-tip-toggle"]').trigger('click')
    expect(w.find('[data-testid="merchant-tip"] [data-testid="receipt-block"]').exists()).toBe(true)
  })
  it('on a phone card the line is the compact variant', async () => {
    width = 400
    mockApi([txn(A)], () => json({ links: { [A]: receipt() } }))
    const w = await mountTable()
    expect(w.get(`li[data-row-key="${A}"] [data-testid="row-receipt"]`).classes()).toContain('bt-receipt-card')
  })
})
