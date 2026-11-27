// @vitest-environment happy-dom
// Receipt photos on the Receipts page: the Take / Choose inputs, upload, the 2 s poll (fake timers), the 40 s give-up line,
// error words, and when the review list shows. fetch is mocked; the re-encode step is stubbed (receiptImage.test.ts covers it).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

vi.mock('../../lib/budget/receiptImage', async (orig) => ({
  ...(await orig<typeof import('../../lib/budget/receiptImage')>()),
  prepareReceiptImage: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })),
}))
import { prepareReceiptImage, ReceiptImageError } from '../../lib/budget/receiptImage'
import ReceiptsPage from './ReceiptsPage.vue'

const fetchMock = vi.fn()
let wrapper: VueWrapper | null = null
interface Reply { status?: number; body: unknown }
let routes: Record<string, Reply[]> = {}
const calls: { key: string; init?: RequestInit }[] = []

beforeEach(() => {
  routes = {}
  calls.length = 0
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    calls.push({ key, init })
    const r = routes[key]?.shift() ?? routes[key + '*']?.[0]
    if (!r) throw new Error(`unrouted ${key}`)
    return new Response(r.status === 204 ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(prepareReceiptImage).mockClear()
  window.history.replaceState(null, '', '/?section=budget&b_page=receipts')
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const notConnected = { configured: true, connection: null, lastRuns: [], nextRunAt: null }
const connected = {
  configured: true,
  connection: { status: 'active', lastRunAt: null, lastOkAt: null, lastError: null, consentVersion: 1, googleEmail: 'pat@example.com' },
  lastRuns: [],
  nextRunAt: null,
}
const emptyList = { receipts: [], nextCursor: null }
const photoRow = (over: Record<string, unknown> = {}) => ({
  id: 'r1', emailDate: '2026-11-27', status: 'suggested', kind: 'purchase', merchant: 'Corner Shop', paymentVia: null, cardLast4: null,
  orderRef: null, receiptDate: '2026-11-26', relatedDate: null, currency: 'USD', totalCents: 1234, taxCents: null, shippingCents: null,
  source: 'upload', hasImage: true, mine: true, items: [{ seq: 0, description: 'Widget', amountCents: 1234, quantity: 1, categoryHint: null }],
  matches: [{ matchId: 1, score: 95, groupKey: null, rule: 'r', shareCents: 1234, status: 'suggested', proposedCategoryId: null, categoryProtectedBy: null,
    txn: { id: 't1', postedDate: '2026-11-27', amountCents: -1234, merchantName: 'CORNER SHOP', accountLabel: null, categoryId: null } }],
  ...over,
})

async function mountPage(status: unknown) {
  routes['GET /api/budget/email/status'] = [{ body: status }]
  for (const s of ['suggested', 'unmatched', 'applied']) routes[`GET /api/budget/email/receipts?status=${s}*`] = [{ body: emptyList }]
  wrapper = mount(ReceiptsPage as never, { attachTo: document.body } as never) as unknown as VueWrapper
  await flushPromises()
  return wrapper
}
const byId = (id: string) => wrapper!.find(`[data-testid="${id}"]`)
const pick = async (id: string) => {
  const input = byId(id).element as HTMLInputElement
  Object.defineProperty(input, 'files', { value: [new File([new Uint8Array([9])], 'r.jpg', { type: 'image/jpeg' })], configurable: true })
  await byId(id).trigger('change')
}
const settle = () => vi.advanceTimersByTimeAsync(0)

describe('photo card', () => {
  it('shows with and without Gmail, with Take (camera) and Choose (library) inputs', async () => {
    for (const status of [notConnected, connected]) {
      await mountPage(status)
      expect(byId('receipts-photo').exists()).toBe(true)
      expect(wrapper!.text()).toContain('Add a receipt photo')
      const take = byId('receipts-take').element as HTMLInputElement
      const choose = byId('receipts-choose').element as HTMLInputElement
      expect(take.type).toBe('file')
      expect(take.accept).toBe('image/*')
      expect(take.getAttribute('capture')).toBe('environment')
      expect(choose.accept).toBe('image/*')
      expect(choose.hasAttribute('capture')).toBe(false)
      expect(byId('receipts-take-btn').text()).toBe('Take photo')
      expect(byId('receipts-choose-btn').text()).toBe('Choose image')
      wrapper!.unmount()
    }
    wrapper = null
  })

  it('the photo card is absent when receipts are not configured', async () => {
    await mountPage({ configured: false, connection: null, lastRuns: [], nextRunAt: null })
    expect(byId('receipts-photo').exists()).toBe(false)
  })
})

describe('upload and polling', () => {
  it('sends a JPEG, shows Reading, polls every 2 s, then shows the fields and the suggestion', async () => {
    await mountPage(connected)
    vi.useFakeTimers()
    routes['POST /api/budget/uploads'] = [{ status: 202, body: { id: 'u1' } }]
    routes['GET /api/budget/uploads/u1'] = [{ body: { id: 'u1', status: 'pending' } }, { body: { id: 'u1', status: 'suggested', row: photoRow() } }]
    await pick('receipts-take')
    await settle()
    const post = calls.find((c) => c.key === 'POST /api/budget/uploads')!
    expect((post.init!.headers as Record<string, string>)['Content-Type']).toBe('image/jpeg')
    expect(post.init!.body).toBeInstanceOf(Blob)
    expect(byId('receipts-photo-reading').text()).toBe('Reading the receipt…')
    await vi.advanceTimersByTimeAsync(1999)
    expect(calls.filter((c) => c.key === 'GET /api/budget/uploads/u1')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls.filter((c) => c.key === 'GET /api/budget/uploads/u1')).toHaveLength(1)
    expect(byId('receipts-photo-reading').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(byId('receipts-photo-done').exists()).toBe(true)
    expect(byId('receipts-photo-done').text()).toContain('Corner Shop')
    expect(byId('receipts-photo-done').text()).toContain('$12.34')
    expect(byId('receipts-photo-suggestion').text()).toContain('CORNER SHOP')
    expect(byId('receipts-photo-reading').exists()).toBe(false)
  })

  it('the Choose input uploads the same way', async () => {
    await mountPage(connected)
    vi.useFakeTimers()
    routes['POST /api/budget/uploads'] = [{ status: 202, body: { id: 'u2' } }]
    routes['GET /api/budget/uploads/u2'] = [{ body: { id: 'u2', status: 'unmatched', row: photoRow({ matches: [], status: 'unmatched' }) } }]
    await pick('receipts-choose')
    await vi.advanceTimersByTimeAsync(2000)
    expect(byId('receipts-photo-done').text()).toContain('No matching bank row yet')
    expect(prepareReceiptImage).toHaveBeenCalledTimes(1)
  })

  it('gives up after 40 s with the within-the-hour line', async () => {
    await mountPage(connected)
    vi.useFakeTimers()
    routes['POST /api/budget/uploads'] = [{ status: 202, body: { id: 'u3' } }]
    routes['GET /api/budget/uploads/u3*'] = [{ body: { id: 'u3', status: 'pending' } }]
    await pick('receipts-take')
    await settle()
    await vi.advanceTimersByTimeAsync(38_000)
    expect(byId('receipts-photo-reading').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(byId('receipts-photo-slow').text()).toBe('Still reading; it will show in the list within the hour')
    const n = calls.filter((c) => c.key.startsWith('GET /api/budget/uploads/u3')).length
    expect(n).toBe(20)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls.filter((c) => c.key.startsWith('GET /api/budget/uploads/u3'))).toHaveLength(20)
  })

  it('a read that ends in error says so', async () => {
    await mountPage(connected)
    vi.useFakeTimers()
    routes['POST /api/budget/uploads'] = [{ status: 202, body: { id: 'u4' } }]
    routes['GET /api/budget/uploads/u4'] = [{ body: { id: 'u4', status: 'error' } }]
    await pick('receipts-take')
    await vi.advanceTimersByTimeAsync(2000)
    expect(byId('receipts-photo-error').text()).toContain('could not be read')
  })

  it('a duplicate with no id says it was already added and does not poll', async () => {
    await mountPage(connected)
    routes['POST /api/budget/uploads'] = [{ body: { duplicate: true } }]
    await pick('receipts-take')
    await flushPromises()
    expect(byId('receipts-photo-done').text()).toContain('already added')
    expect(calls.some((c) => c.key.startsWith('GET /api/budget/uploads/'))).toBe(false)
  })
})

describe('upload errors', () => {
  const cases: [number, string, string][] = [
    [413, 'too_large', 'too large'],
    [415, 'convert_first', "Can't read this image type"],
    [429, 'daily_cap', 'daily limit of 20'],
    [403, 'forbidden', 'Budget access'],
    [502, 'unavailable', 'unavailable'],
  ]
  for (const [status, code, words] of cases) {
    it(`${status} ${code} shows plain words`, async () => {
      await mountPage(connected)
      routes['POST /api/budget/uploads'] = [{ status, body: { code } }]
      await pick('receipts-take')
      await flushPromises()
      expect(byId('receipts-photo-error').text()).toContain(words)
    })
  }

  it('a file the browser cannot read shows the convert message and sends nothing', async () => {
    await mountPage(connected)
    vi.mocked(prepareReceiptImage).mockRejectedValueOnce(new ReceiptImageError("Can't read this image type; take a photo or save it as JPEG"))
    await pick('receipts-choose')
    await flushPromises()
    expect(byId('receipts-photo-error').text()).toBe("Can't read this image type; take a photo or save it as JPEG")
    expect(calls.some((c) => c.key.startsWith('POST'))).toBe(false)
  })
})

describe('review list visibility', () => {
  it('mounts without Gmail when the person already has a photo receipt', async () => {
    routes['GET /api/budget/email/status'] = [{ body: notConnected }]
    routes['GET /api/budget/email/receipts?status=suggested*'] = [{ body: { receipts: [photoRow()], nextCursor: null } }]
    routes['GET /api/budget/email/receipts?status=unmatched*'] = [{ body: emptyList }]
    routes['GET /api/budget/email/receipts?status=applied*'] = [{ body: emptyList }]
    wrapper = mount(ReceiptsPage as never, { attachTo: document.body } as never) as unknown as VueWrapper
    await flushPromises()
    expect(byId('receipts-review').exists()).toBe(true)
  })

  it('stays out without Gmail and without uploads', async () => {
    await mountPage(notConnected)
    expect(byId('receipts-review').exists()).toBe(false)
  })

  it('mounts after a first photo is read', async () => {
    await mountPage(notConnected)
    vi.useFakeTimers()
    routes['POST /api/budget/uploads'] = [{ status: 202, body: { id: 'u5' } }]
    routes['GET /api/budget/uploads/u5'] = [{ body: { id: 'u5', status: 'unmatched', row: photoRow({ matches: [] }) } }]
    routes['GET /api/budget/email/receipts?status=suggested*'] = [{ body: emptyList }]
    await pick('receipts-take')
    await vi.advanceTimersByTimeAsync(2000)
    await vi.advanceTimersByTimeAsync(0)
    expect(byId('receipts-review').exists()).toBe(true)
  })
})

describe('review rows', () => {
  async function withRows(rows: unknown[]) {
    routes['GET /api/budget/email/status'] = [{ body: connected }]
    routes['GET /api/budget/email/receipts?status=suggested*'] = [{ body: { receipts: rows, nextCursor: null } }]
    wrapper = mount(ReceiptsPage as never, { attachTo: document.body } as never) as unknown as VueWrapper
    await flushPromises()
  }

  it('tags each row Photo or Email', async () => {
    await withRows([photoRow({ id: 'a' }), photoRow({ id: 'b', source: 'email', mine: undefined, gmailMsgId: '18c0ffee12345678' })])
    const tags = wrapper!.findAll('[data-testid="rr-source"]').map((t) => t.text())
    expect(tags.some((t) => t.includes('Photo'))).toBe(true)
    expect(tags.some((t) => t.includes('Email'))).toBe(true)
  })

  it('Delete shows only on the viewer\'s own photo receipts and calls DELETE', async () => {
    await withRows([
      photoRow({ id: 'own' }),
      photoRow({ id: 'theirs', mine: false }),
      photoRow({ id: 'mail', source: 'email', mine: undefined }),
    ])
    const dels = wrapper!.findAll('[data-testid="rr-delete"]')
    expect(dels.length).toBeGreaterThanOrEqual(1)
    const seen = new Set(dels.map((d) => d.element.closest('tr, li, [data-row-key]')?.textContent ?? ''))
    expect(seen.size).toBeGreaterThanOrEqual(1)
    // one row per kind is drawn once per layout (table and card); every layout has exactly one Delete for the own row
    const perLayout = dels.length
    routes['DELETE /api/budget/uploads/own'] = [{ status: 204, body: null }]
    await dels[0].trigger('click')
    await flushPromises()
    expect(calls.some((c) => c.key === 'DELETE /api/budget/uploads/own')).toBe(true)
    expect(perLayout).toBeLessThanOrEqual(2)
  })
})
