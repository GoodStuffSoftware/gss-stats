// @vitest-environment happy-dom
// The Receipts connect and status page: each state, the consent text, the error messages, the disconnect modal and
// the callback code shown once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ReceiptsPage from './ReceiptsPage.vue'

const fetchMock = vi.fn()
let wrapper: VueWrapper | null = null

interface Reply { status?: number; body: unknown }
let routes: Record<string, Reply[]> = {}
beforeEach(() => {
  routes = {}
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    const r = routes[key]?.shift() ?? routes[key + '*']?.[0]
    if (!r) throw new Error(`unrouted ${key}`)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetchMock)
  window.history.replaceState(null, '', '/?section=budget&b_page=receipts')
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

const run = (over: Record<string, unknown> = {}) => ({
  trigger: 'cron', startedAt: '2026-11-23T15:23:00Z', finishedAt: '2026-11-23T15:24:00Z',
  listed: 9, fetched: 7, extracted: 5, skipped: 2, matched: 3, autoApplied: 0, errorCode: null, ...over,
})
const connected = (conn: Record<string, unknown> = {}, runs: unknown[] = [run()]) => ({
  configured: true,
  connection: { status: 'active', lastRunAt: '2026-11-23T15:23:00Z', lastOkAt: '2026-11-23T15:24:00Z', lastError: null, consentVersion: 1, email: 'pat@example.com', ...conn },
  lastRuns: runs,
  nextRunAt: '2026-11-23T16:23:00Z',
})
const notConnected = { configured: true, connection: null, lastRuns: [], nextRunAt: null }

async function mountPage(status: unknown, slots: Record<string, string> = {}) {
  routes['GET /api/budget/email/status'] = [{ body: status }]
  wrapper = mount(ReceiptsPage as never, { attachTo: document.body, slots } as never) as unknown as VueWrapper
  await flushPromises()
  return wrapper
}
const text = () => wrapper!.text()
const byId = (id: string) => wrapper!.find(`[data-testid="${id}"]`)

describe('ReceiptsPage states', () => {
  it('not configured: one calm line and no connect button', async () => {
    await mountPage({ configured: false, connection: null, lastRuns: [], nextRunAt: null })
    expect(text()).toContain("Receipts aren't set up yet.")
    expect(byId('receipts-connect').exists()).toBe(false)
    expect(byId('receipts-consent').exists()).toBe(false)
  })

  it('failed status load shows Retry', async () => {
    routes['GET /api/budget/email/status'] = [{ status: 500, body: { error: 'x' } }]
    wrapper = mount(ReceiptsPage as never, { attachTo: document.body } as never) as unknown as VueWrapper
    await flushPromises()
    expect(byId('receipts-failed').exists()).toBe(true)
    routes['GET /api/budget/email/status'] = [{ body: notConnected }]
    await byId('receipts-retry').trigger('click')
    await flushPromises()
    expect(byId('receipts-consent').exists()).toBe(true)
  })

  it('not connected: the consent card has the sharing sentence verbatim and the Gmail terms', async () => {
    await mountPage(notConnected)
    const t = byId('receipts-consent').text()
    expect(t).toContain('Receipts you connect are also shown to the other Budget person.')
    expect(t).toContain('Read-only access to receipt emails; nothing is sent, deleted or changed.')
    expect(t).toContain('never stores the email itself')
    expect(t).toContain('You can disconnect at any time')
    expect(t).toContain('Limited Use requirements')
  })

  it('Connect needs the checkbox, posts consent 1 and goes to the returned url', async () => {
    await mountPage(notConnected)
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, href: window.location.href, assign })
    const btn = byId('receipts-connect')
    expect(btn.attributes('disabled')).toBeDefined()
    await byId('receipts-agree').setValue(true)
    routes['POST /api/budget/email/connect'] = [{ body: { url: 'https://accounts.example.com/consent' } }]
    await btn.trigger('click')
    await flushPromises()
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/budget/email/connect')!
    expect(JSON.parse(call[1].body)).toEqual({ consent: 1 })
    expect(assign).toHaveBeenCalledWith('https://accounts.example.com/consent')
  })

  it('a revoked connection shows the consent card again', async () => {
    await mountPage(connected({ status: 'revoked' }))
    expect(byId('receipts-consent').exists()).toBe(true)
  })

  it('connected: address, last run counts, Check now, and the review slot', async () => {
    await mountPage(connected(), { review: '<div data-testid="slot-review">list</div>' })
    expect(byId('receipts-conn-line').text()).toContain('pat@example.com')
    expect(byId('receipts-last-run').text()).toContain('7 emails read, 5 receipts found, 3 matched')
    expect(byId('receipts-check').exists()).toBe(true)
    expect(byId('receipts-consent').exists()).toBe(false)
    expect(byId('slot-review').exists()).toBe(true)
  })

  it('the review slot is not drawn while not connected', async () => {
    await mountPage(notConnected, { review: '<div data-testid="slot-review">list</div>' })
    expect(byId('slot-review').exists()).toBe(false)
  })

  it('Check now posts, then reloads the status', async () => {
    await mountPage(connected())
    routes['POST /api/budget/email/sync'] = [{ status: 202, body: { ok: true } }]
    routes['GET /api/budget/email/status'] = [{ body: connected() }]
    await byId('receipts-check').trigger('click')
    await flushPromises()
    expect(byId('receipts-notice').text()).toContain('Checking now')
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/budget/email/status')).toHaveLength(2)
  })

  it.each([
    [429, { error: 'rate_limited', retryAfterSec: 150 }, 'A check just ran', 'about 3 min'],
    [503, { error: 'receipts_unavailable' }, 'not available right now', ''],
    [502, { error: 'receipts_failed' }, 'could not start', ''],
  ])('Check now %i shows plain words', async (status, body, a, b) => {
    await mountPage(connected())
    routes['POST /api/budget/email/sync'] = [{ status, body }]
    await byId('receipts-check').trigger('click')
    await flushPromises()
    const n = byId('receipts-notice').text()
    expect(n).toContain(a)
    expect(n).toContain(b)
  })

  it('shows api_rejected and api_limited plainly', async () => {
    await mountPage(connected({ lastError: 'api_rejected' }, [run({ errorCode: 'api_rejected' })]))
    expect(byId('receipts-paused').text()).toBe('Receipts paused: the API rejected the request')
    wrapper!.unmount()
    await mountPage(connected({ lastError: null }, [run({ errorCode: 'api_limited' })]))
    expect(byId('receipts-paused').text()).toBe('Receipts paused: API limit reached, retrying next hour')
  })

  it('needs_reconnect swaps Check now for a Reconnect button that starts the connect', async () => {
    await mountPage(connected({ status: 'needs_reconnect', lastError: 'needs_reconnect' }))
    expect(byId('receipts-check').exists()).toBe(false)
    expect(byId('receipts-reconnect').exists()).toBe(true)
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, href: window.location.href, assign })
    routes['POST /api/budget/email/connect'] = [{ body: { url: 'https://accounts.example.com/again' } }]
    await byId('receipts-reconnect').trigger('click')
    await flushPromises()
    expect(assign).toHaveBeenCalledWith('https://accounts.example.com/again')
  })
})

describe('ReceiptsPage disconnect', () => {
  const panel = () => document.querySelector('[role="dialog"]') as HTMLElement | null
  const q = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLInputElement

  it('opens a modal; the default keeps the receipts', async () => {
    await mountPage(connected())
    await byId('receipts-disconnect').trigger('click')
    await flushPromises()
    expect(panel()).not.toBeNull()
    routes['POST /api/budget/email/disconnect'] = [{ body: { ok: true, revoked: true, purged: false } }]
    routes['GET /api/budget/email/status'] = [{ body: notConnected }]
    q('receipts-disconnect-confirm').click()
    await flushPromises()
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/budget/email/disconnect')!
    expect(JSON.parse(call[1].body)).toEqual({ purge: false })
    expect(panel()).toBeNull()
    expect(byId('receipts-consent').exists()).toBe(true)
  })

  it('the delete choice sends purge true and says so', async () => {
    await mountPage(connected())
    await byId('receipts-disconnect').trigger('click')
    await flushPromises()
    const del = q('receipts-purge')
    del.checked = true
    del.dispatchEvent(new Event('change'))
    routes['POST /api/budget/email/disconnect'] = [{ body: { ok: true, revoked: false, purged: true } }]
    routes['GET /api/budget/email/status'] = [{ body: notConnected }]
    q('receipts-disconnect-confirm').click()
    await flushPromises()
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/budget/email/disconnect')!
    expect(JSON.parse(call[1].body)).toEqual({ purge: true })
    expect(byId('receipts-notice').text()).toContain('receipts were deleted')
    expect(byId('receipts-notice').text()).toContain('third-party access')
  })
})

describe('ReceiptsPage callback code', () => {
  it('shows the message once, then removes only `email` from the URL', async () => {
    window.history.replaceState({ k: 1 }, '', '/?section=budget&b_page=receipts&email=denied')
    await mountPage(notConnected)
    expect(byId('receipts-notice').text()).toContain('access was declined')
    expect(window.location.search).toBe('?section=budget&b_page=receipts')
    expect(window.history.state).toEqual({ k: 1 })
    wrapper!.unmount()
    await mountPage(notConnected)
    expect(byId('receipts-notice').exists()).toBe(false)
  })

  it('a connected code reads as success', async () => {
    window.history.replaceState(null, '', '/?section=budget&b_page=receipts&email=connected')
    await mountPage(connected())
    expect(byId('receipts-notice').text()).toContain('Gmail connected')
    expect(byId('receipts-notice').classes()).toContain('rp-ok')
    expect(window.location.search).not.toContain('email=')
  })

  it('an unknown code gets the generic line, never the raw code', async () => {
    window.history.replaceState(null, '', '/?section=budget&b_page=receipts&email=zzz_weird')
    await mountPage(notConnected)
    expect(byId('receipts-notice').text()).not.toContain('zzz_weird')
  })
})

describe('ReceiptsPage never shows a Gmail id', () => {
  it('drops a gmailMsgId that rides along in the status payload', async () => {
    await mountPage({ ...connected({ gmailMsgId: '18c0ffee12345678' }, [run({ gmailMsgId: '18c0ffee12345678' })]), gmailMsgId: '18c0ffee12345678' })
    expect(wrapper!.html()).not.toContain('18c0ffee12345678')
  })
})
