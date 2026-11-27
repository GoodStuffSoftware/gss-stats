// @vitest-environment happy-dom
// Plaid Link in the browser: the script loads only when a link starts (and once), the token kept for an OAuth bank
// round trip (saved, cleared, 30 minute limit), the OAuth return pickup and the resume with receivedRedirectUri.
// Plaid itself is a stub on `window`; nothing here reaches the network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BANKS_URL,
  captureOAuthReturn,
  clearLink,
  LINK_MAX_AGE_MS,
  LINK_SCRIPT_URL,
  LINK_STORAGE_KEY,
  loadPlaidScript,
  openLink,
  readLink,
  resumeLink,
  saveLink,
  setOAuthReturn,
  takeOAuthReturn,
  toLinkResult,
} from './plaidLink'

interface Cfg { token: string; receivedRedirectUri?: string; onSuccess: (p: string | null, m: unknown) => void; onExit: (e: unknown, m: unknown) => void }
let cfgs: Cfg[] = []
const handler = { open: vi.fn(), destroy: vi.fn() }
const create = vi.fn((cfg: Cfg) => {
  cfgs.push(cfg)
  return handler
})
const plaidScripts = () => document.querySelectorAll('script[data-gss-plaid]')

/** A script tag added to <head> finishes loading when the test says so (and then `window.Plaid` is there). */
function stubHead() {
  const added: HTMLScriptElement[] = []
  const spy = vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(n: T): T => {
    added.push(n as unknown as HTMLScriptElement)
    return n
  })
  // happy-dom would try to run the script on a real insert, so the tag is only recorded; a lookup for it finds it.
  const find = document.querySelector.bind(document)
  vi.spyOn(document, 'querySelector').mockImplementation(((sel: string) => (sel.includes('data-gss-plaid') ? (added[0] ?? null) : find(sel))) as typeof document.querySelector)
  return { added, spy }
}
const finishLoad = (el: HTMLScriptElement) => {
  ;(window as unknown as { Plaid?: unknown }).Plaid = { create }
  el.dispatchEvent(new Event('load'))
}

beforeEach(() => {
  cfgs = []
  create.mockClear()
  handler.open.mockClear()
  handler.destroy.mockClear()
  delete (window as unknown as { Plaid?: unknown }).Plaid
  document.head.querySelectorAll('script[data-gss-plaid]').forEach((s) => s.remove())
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
  setOAuthReturn(null)
})
afterEach(() => vi.restoreAllMocks())

describe('script loading', () => {
  it('nothing loads until a link starts', () => {
    expect(plaidScripts().length).toBe(0)
    expect((window as unknown as { Plaid?: unknown }).Plaid).toBeUndefined()
  })
  it('the first link adds the script once, from cdn.plaid.com, and a second call reuses it', async () => {
    const { added } = stubHead()
    const a = loadPlaidScript()
    const b = loadPlaidScript()
    expect(added.length).toBe(1)
    expect(added[0].src).toBe(LINK_SCRIPT_URL)
    expect(LINK_SCRIPT_URL.startsWith('https://cdn.plaid.com/')).toBe(true)
    finishLoad(added[0])
    await expect(Promise.all([a, b])).resolves.toBeDefined()
    expect(added.length).toBe(1)
  })
  it('a script that loads resolves both waiting calls once Plaid is on the page', async () => {
    const { added } = stubHead()
    const a = loadPlaidScript()
    expect(added.length).toBe(1)
    finishLoad(added[0])
    await expect(a).resolves.toBeUndefined()
  })
  it('once Plaid is there nothing more is added', async () => {
    ;(window as unknown as { Plaid?: unknown }).Plaid = { create }
    const { added } = stubHead()
    await loadPlaidScript()
    expect(added.length).toBe(0)
  })
  it('a load error rejects link_unavailable', async () => {
    const { added } = stubHead()
    const p = loadPlaidScript()
    added[0].dispatchEvent(new Event('error'))
    await expect(p).rejects.toThrow('link_unavailable')
  })
})

describe('the saved token', () => {
  it('saves, reads and clears', () => {
    saveLink('link-sandbox-aaa', 'item-1', 1_000)
    expect(readLink(2_000)).toEqual({ token: 'link-sandbox-aaa', itemId: 'item-1', at: 1_000 })
    clearLink()
    expect(readLink()).toBeNull()
  })
  it('a new link has no item id', () => {
    saveLink('link-sandbox-aaa', undefined, 5)
    expect(readLink(6)).toEqual({ token: 'link-sandbox-aaa', at: 5 })
  })
  it('is ignored and removed after 30 minutes', () => {
    saveLink('link-sandbox-aaa', undefined, 1_000)
    expect(readLink(1_000 + LINK_MAX_AGE_MS)).not.toBeNull()
    expect(readLink(1_000 + LINK_MAX_AGE_MS + 1)).toBeNull()
    expect(window.localStorage.getItem(LINK_STORAGE_KEY)).toBeNull()
  })
  it('unreadable storage is dropped, not thrown', () => {
    window.localStorage.setItem(LINK_STORAGE_KEY, '{not json')
    expect(readLink()).toBeNull()
    window.localStorage.setItem(LINK_STORAGE_KEY, JSON.stringify({ token: '', at: Date.now() }))
    expect(readLink()).toBeNull()
  })
})

describe('toLinkResult', () => {
  const meta = {
    institution: { institution_id: 'ins_1', name: 'Example Bank' },
    accounts: [
      { id: 'acc-a', name: 'Everyday', mask: '0042', type: 'depository', subtype: 'checking', verification_status: 'x' },
      { id: '', name: 'No id', type: 'credit' },
    ],
    link_session_id: 'abc',
  }
  it('keeps only ids, names, last 4 and types, and skips an account with no id', () => {
    expect(toLinkResult('public-sandbox-x', meta)).toEqual({
      publicToken: 'public-sandbox-x',
      institution: { id: 'ins_1', name: 'Example Bank' },
      accounts: [{ id: 'acc-a', name: 'Everyday', mask: '0042', type: 'depository', subtype: 'checking' }],
    })
  })
  it('is null without an institution or an account list', () => {
    expect(toLinkResult('p', {})).toBeNull()
    expect(toLinkResult('p', { institution: { institution_id: 'i', name: 'n' } })).toBeNull()
    expect(toLinkResult('p', null)).toBeNull()
  })
})

describe('openLink', () => {
  async function open(extra: Partial<Parameters<typeof openLink>[0]> = {}) {
    ;(window as unknown as { Plaid?: unknown }).Plaid = { create }
    const onSuccess = vi.fn()
    const onExit = vi.fn()
    await openLink({ token: 'link-sandbox-aaa', onSuccess, onExit, ...extra })
    return { onSuccess, onExit }
  }
  it('saves the token, creates the handler and opens it', async () => {
    await open()
    expect(readLink()?.token).toBe('link-sandbox-aaa')
    expect(create).toHaveBeenCalledTimes(1)
    expect(cfgs[0].receivedRedirectUri).toBeUndefined()
    expect(handler.open).toHaveBeenCalledTimes(1)
  })
  it('success clears the saved token and hands over the reduced result', async () => {
    const { onSuccess } = await open()
    cfgs[0].onSuccess('public-sandbox-x', { institution: { institution_id: 'ins_1', name: 'Example Bank' }, accounts: [] })
    expect(readLink()).toBeNull()
    expect(onSuccess).toHaveBeenCalledWith({ publicToken: 'public-sandbox-x', institution: { id: 'ins_1', name: 'Example Bank' }, accounts: [] }, 'public-sandbox-x')
  })
  it('exit clears the saved token, destroys the handler and tells the page', async () => {
    const { onExit } = await open()
    cfgs[0].onExit(null, {})
    expect(readLink()).toBeNull()
    expect(handler.destroy).toHaveBeenCalled()
    expect(onExit).toHaveBeenCalled()
  })
  it('update mode keeps the item id in the saved token', async () => {
    await open({ itemId: 'item-1' })
    expect(readLink()?.itemId).toBe('item-1')
  })
  it('a missing Plaid after the script loaded rejects link_unavailable', async () => {
    const { added } = stubHead()
    const p = openLink({ token: 't', onSuccess: vi.fn(), onExit: vi.fn() })
    added[0].dispatchEvent(new Event('load')) // loaded but no window.Plaid
    await expect(p).rejects.toThrow('link_unavailable')
  })
})

describe('OAuth return', () => {
  it('only /banks/return is picked up; the address becomes the Banks page', () => {
    expect(captureOAuthReturn({ pathname: '/', href: 'https://x.example/' })).toBe(false)
    expect(takeOAuthReturn()).toBeNull()
    const href = 'https://x.example/banks/return?oauth_state_id=abc'
    window.history.replaceState(null, '', '/banks/return?oauth_state_id=abc')
    expect(captureOAuthReturn({ pathname: '/banks/return', href })).toBe(true)
    expect(window.location.pathname + window.location.search).toBe(BANKS_URL)
    expect(takeOAuthReturn()).toBe(href)
    expect(takeOAuthReturn()).toBeNull() // taken once
  })
  it('resume reopens Link with the saved token and receivedRedirectUri, and keeps the original time stamp', async () => {
    ;(window as unknown as { Plaid?: unknown }).Plaid = { create }
    saveLink('link-sandbox-aaa', 'item-1', Date.now() - 60_000)
    const at = readLink()!.at
    window.history.replaceState(null, '', '/banks/return?oauth_state_id=abc')
    const r = await resumeLink('https://x.example/banks/return?oauth_state_id=abc', { onSuccess: vi.fn(), onExit: vi.fn() })
    expect(r).toEqual({ itemId: 'item-1' })
    expect(cfgs[0]).toMatchObject({ token: 'link-sandbox-aaa', receivedRedirectUri: 'https://x.example/banks/return?oauth_state_id=abc' })
    expect(handler.open).toHaveBeenCalled()
    expect(readLink()?.at).toBe(at)
    expect(window.location.pathname + window.location.search).toBe(BANKS_URL)
  })
  it('resume does nothing when no fresh token was saved', async () => {
    ;(window as unknown as { Plaid?: unknown }).Plaid = { create }
    expect(await resumeLink('https://x.example/banks/return', { onSuccess: vi.fn(), onExit: vi.fn() })).toBeNull()
    expect(create).not.toHaveBeenCalled()
    saveLink('link-sandbox-aaa', undefined, Date.now() - LINK_MAX_AGE_MS - 5_000)
    expect(await resumeLink('https://x.example/banks/return', { onSuccess: vi.fn(), onExit: vi.fn() })).toBeNull()
  })
})
