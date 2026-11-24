// @vitest-environment happy-dom
// The Receipts review list: rows, batch apply (50 max per call), outcome words, reject, dismiss, load more.
// Mocked fetch and made-up data only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ReceiptsReview from './ReceiptsReview.vue'

const fetchMock = vi.fn()
let wrapper: VueWrapper | null = null
interface Reply { status?: number; body: unknown }
let routes: Record<string, Reply[]> = {}
let calls: { key: string; body: any }[] = []

beforeEach(() => {
  routes = {}
  calls = []
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    calls.push({ key, body: init?.body ? JSON.parse(String(init.body)) : null })
    const r = routes[key]?.shift()
    if (!r) throw new Error(`unrouted ${key}`)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const GMAIL_ID = 'abcdef0123456789'
const match = (id: number, over: Record<string, unknown> = {}) => ({
  matchId: id, txnId: `t${id}`, groupKey: null, rule: 'exact', shareCents: null, score: 92, status: 'suggested',
  proposedCategoryId: 'groceries', linkedOther: false, categoryProtectedBy: null,
  txn: { postedDate: '2026-11-10', amountCents: -4250, merchantName: `Bank Shop ${id}`, accountLabel: 'Visa 1111', categoryId: null, categorySource: null, needsReview: false, updatedAt: `2026-11-11T00:00:0${id % 10}Z` },
  ...over,
})
const receipt = (n: number, matches: unknown[] = [match(n)], over: Record<string, unknown> = {}) => ({
  id: `r${n}`, emailDate: '2026-11-09', status: 'suggested', kind: 'purchase', merchant: `Store ${n}`, paymentVia: null, cardLast4: '1111',
  orderRef: null, receiptDate: '2026-11-09', relatedDate: null, currency: 'USD', totalCents: 4250, taxCents: 200, shippingCents: null,
  gmailMsgId: GMAIL_ID, items: [{ seq: 1, description: `Widget ${n}`, amountCents: 4050, quantity: 1, categoryHint: null }], matches, ...over,
})
const META = { people: [], accounts: [], categories: [{ id: 'groceries', label: 'Groceries', color: null, sort: 1 }, { id: 'home', label: 'Home', color: null, sort: 2 }], range: { min: null, max: null } }

async function mountList(receipts: unknown[], nextCursor: string | null = null, status = 'suggested') {
  routes[`GET /api/budget/email/receipts?status=${status}`] = [{ body: { receipts, nextCursor } }]
  routes['GET /api/budget/meta'] = [{ body: META }]
  wrapper = mount(ReceiptsReview as never, { attachTo: document.body, props: { categories: META.categories } } as never) as unknown as VueWrapper
  await flushPromises()
  return wrapper
}
const text = () => wrapper!.text()
const byId = (id: string) => wrapper!.find(`[data-testid="${id}"]`)
const all = (id: string) => wrapper!.findAll(`[data-testid="${id}"]`)
const applyCalls = () => calls.filter((c) => c.key === 'POST /api/budget/email/apply')

describe('ReceiptsReview', () => {
  it('renders each receipt with its match, items and strength in words', async () => {
    await mountList([receipt(1), receipt(2, [match(2, { score: 70 })])])
    expect(text()).toContain('Store 1')
    expect(text()).toContain('Widget 1')
    expect(text()).toContain('$42.50')
    expect(text()).toContain('Bank Shop 1')
    expect(text()).toContain('Visa 1111')
    expect(text()).toContain('Strong')
    expect(text()).toContain('Likely')
    expect(text()).not.toContain('92')
  })

  it('says up front that a person-set category will be kept, and only then', async () => {
    await mountList([receipt(1, [match(1, { categoryProtectedBy: 'manual', proposedCategoryId: null })]), receipt(2)])
    expect(all('rr-kept')).toHaveLength(1)
    expect(byId('rr-kept').text()).toContain('Category will be kept')
  })

  it('never shows a Gmail message id as text', async () => {
    await mountList([receipt(1)])
    expect(wrapper!.html()).not.toContain(GMAIL_ID)
  })

  it('shows the other candidates as "Also matches" and a split as N charges', async () => {
    await mountList([receipt(1, [match(1), match(5, { score: 65, txn: { ...match(5).txn, merchantName: 'Other Shop' } })]), receipt(2, [match(21, { groupKey: 'g' }), match(22, { groupKey: 'g' })])])
    expect(byId('rr-also').text()).toContain('Other Shop')
    expect(byId('rr-split').text()).toContain('2 charges')
  })

  it('Apply on one row sends its match, expectedUpdatedAt and the proposed category', async () => {
    await mountList([receipt(1)])
    routes['POST /api/budget/email/apply'] = [{ body: { applied: [{ matchId: 1, txnId: 't1', categorySet: true, categoryKept: null, updatedAt: 'x' }], rejected: [], skipped: [] } }]
    await byId('rr-apply').trigger('click')
    await flushPromises()
    expect(applyCalls()[0].body).toEqual({ items: [{ matchId: 1, expectedUpdatedAt: '2026-11-11T00:00:01Z', categoryId: 'groceries' }] })
    expect(text()).toContain('Linked, and the category was set.')
    expect(all('rr-apply')).toHaveLength(0)
  })

  it('selecting 60 rows and applying sends at most 50 match ids per call', async () => {
    await mountList(Array.from({ length: 60 }, (_, i) => receipt(i + 1)))
    const reply = (ids: number[]) => ({ body: { applied: ids.map((id) => ({ matchId: id, txnId: `t${id}`, categorySet: true, categoryKept: null, updatedAt: 'x' })), rejected: [], skipped: [] } })
    routes['POST /api/budget/email/apply'] = [reply(Array.from({ length: 50 }, (_, i) => i + 1)), reply(Array.from({ length: 10 }, (_, i) => i + 51))]
    const boxes = wrapper!.findAll('input[type="checkbox"]')
    // The first checkbox is select all (when drawn); tick every row box by choosing the header one.
    await boxes[0].setValue(true)
    expect(byId('rr-apply-selected').text()).toContain('(60)')
    await byId('rr-apply-selected').trigger('click')
    await flushPromises()
    const sent = applyCalls().map((c) => c.body.items.length)
    expect(sent).toEqual([50, 10])
    expect(Math.max(...sent)).toBeLessThanOrEqual(50)
  })

  it('says the category was kept for manual and person_edit', async () => {
    await mountList([receipt(1), receipt(2)])
    routes['POST /api/budget/email/apply'] = [{ body: { applied: [
      { matchId: 1, txnId: 't1', categorySet: false, categoryKept: 'manual', updatedAt: 'x' },
      { matchId: 2, txnId: 't2', categorySet: false, categoryKept: 'person_edit', updatedAt: 'x' }], rejected: [], skipped: [] } }]
    await wrapper!.findAll('input[type="checkbox"]')[0].setValue(true)
    await byId('rr-apply-selected').trigger('click')
    await flushPromises()
    expect(byId('rr-results').text().match(/Linked; your category was kept\./g)).toHaveLength(2)
  })

  it.each([
    ['stale', 'Changed since loaded, refresh'],
    ['txn_linked', 'already has a receipt'],
    ['incomplete_group', 'Part of a split purchase is missing'],
    ['group_blocked', 'Another part of this split'],
    ['conflict', 'already linked to another bank row'],
    ['not_found', 'no longer there'],
    ['not_suggested', 'no longer a suggestion'],
  ])('skip reason %s is shown in plain words and the row stays', async (reason, words) => {
    await mountList([receipt(1)])
    routes['POST /api/budget/email/apply'] = [{ body: { applied: [], rejected: [], skipped: [{ matchId: 1, reason }] } }]
    await byId('rr-apply').trigger('click')
    await flushPromises()
    expect(byId('rr-results').text()).toContain(words)
    expect(byId('rr-apply').exists()).toBe(true)
  })

  it('Reject sends the match id under reject and removes the row', async () => {
    await mountList([receipt(1), receipt(2)])
    routes['POST /api/budget/email/apply'] = [{ body: { applied: [], rejected: [1], skipped: [] } }]
    await all('rr-reject')[0].trigger('click')
    await flushPromises()
    expect(applyCalls()[0].body).toEqual({ items: [], reject: [1] })
    expect(text()).toContain('Match rejected.')
    expect(all('rr-reject')).toHaveLength(1)
  })

  it('Dismiss patches the receipt and removes the row', async () => {
    await mountList([receipt(1)])
    routes['PATCH /api/budget/email/receipts/r1'] = [{ body: { id: 'r1', status: 'dismissed' } }]
    await byId('rr-dismiss').trigger('click')
    await flushPromises()
    expect(calls.find((c) => c.key.startsWith('PATCH'))?.body).toEqual({ dismissed: true })
    expect(text()).toContain('Dismissed.')
    expect(text()).not.toContain('Widget 1')
  })

  it('Load more appends the next page with the cursor', async () => {
    await mountList([receipt(1)], 'cur1')
    routes['GET /api/budget/email/receipts?status=suggested&cursor=cur1'] = [{ body: { receipts: [receipt(2)], nextCursor: null } }]
    await byId('rr-more').trigger('click')
    await flushPromises()
    expect(text()).toContain('Widget 1')
    expect(text()).toContain('Widget 2')
    expect(byId('rr-more').exists()).toBe(false)
  })

  it('the Unmatched tab lists receipts with Dismiss only', async () => {
    await mountList([])
    routes['GET /api/budget/email/receipts?status=unmatched'] = [{ body: { receipts: [receipt(3, [], { status: 'unmatched' })], nextCursor: null } }]
    await byId('rr-tab-unmatched').trigger('click')
    await flushPromises()
    expect(text()).toContain('Store 3')
    expect(byId('rr-dismiss').exists()).toBe(true)
    expect(byId('rr-apply').exists()).toBe(false)
  })
})
