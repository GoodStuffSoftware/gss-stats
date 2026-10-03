// @vitest-environment happy-dom
//
// A tab that could not read the stored layout never saves over it.
// - Every failed GET /api/config (no answer, 5xx, 401, a body that is not JSON or not a layout)
//   shows the built-in defaults with a banner, and no edit made then reaches the server: no PUT.
// - "Try again" that reads the layout replaces the stand-in with it and turns saving back on; the
//   next edit saves the STORED layout with that edit, never the defaults.
// - A store that holds nothing yet (GET answers null) still starts from the defaults and saves.
// These run the real loadConfig/saveConfig against a stubbed fetch, so they count actual PUTs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import App from './App.vue'
import Dashboard from './components/Dashboard.vue'
import { checkSessionExpired, sessionExpired } from './session'
import { defaultConfig, normalizeConfig } from './lib/defaults'
import PROD_V9 from './lib/__fixtures__/prodLayout.v9.json'
import type { DashboardConfig } from './types'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    fetchStats: vi.fn(() => new Promise(() => {})),
    fetchSeriesStats: vi.fn(() => new Promise(() => {})),
  }
})
vi.mock('./sitesStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sitesStore')>()
  return { ...actual, loadSites: vi.fn(async () => {}) }
})
vi.mock('./session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session')>()
  return { ...actual, loadIdentity: vi.fn(async () => {}), checkSessionExpired: vi.fn(async () => {}) }
})

const stored = (): DashboardConfig => ({ ...JSON.parse(JSON.stringify(PROD_V9)), version: 11 })
const json = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } })
type Reply = () => Response
const ok: Reply = () => json(JSON.stringify(stored()))

// GET /api/config answers from `gets` in order (the last one repeats); every PUT is recorded.
let gets: Reply[] = []
let puts: DashboardConfig[] = []
function stubServer(...replies: Reply[]) {
  gets = replies
  puts = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/config' && init?.method === 'PUT') {
        puts.push(JSON.parse(String(init.body)))
        return json('{"ok":true}')
      }
      if (url === '/api/config') return (gets.length > 1 ? gets.shift()! : gets[0])()
      return json('{}', 404)
    }),
  )
}

const pastDebounce = async () => {
  await new Promise((r) => setTimeout(r, 800))
  await flushPromises()
}
const mounted: VueWrapper[] = []
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  localStorage.clear()
  sessionExpired.value = false
  vi.mocked(checkSessionExpired).mockClear()
})
async function mountApp() {
  const w = mount(App, { attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  return w
}
/** ⋯ → Rename: the page's breadcrumb segment turns into a field; type the name, Enter. */
async function rename(w: VueWrapper, name: string) {
  await w.find('.page-menu-btn').trigger('click')
  await flushPromises()
  Array.from(document.querySelectorAll<HTMLElement>('#page-menu [role="menuitem"]')).find((b) => b.textContent!.trim() === 'Rename')!.click()
  await flushPromises()
  const input = document.querySelector<HTMLInputElement>('nav.crumbs .seg.editing input')!
  input.value = name
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await flushPromises()
}
// Three different ways an edit reaches the config: a nav edit (rename), the grid's own v-model
// (a moved/resized or edited widget, as the card editor and the grid write it), and the grid's
// change event.
async function editEveryWay(w: VueWrapper) {
  await rename(w, 'Edited while failed')
  const dash = w.findComponent(Dashboard)
  const widgets = (dash.props('widgets') as { w: number }[]).map((x, i) => (i === 0 ? { ...x, w: x.w === 3 ? 4 : 3 } : x))
  dash.vm.$emit('update:widgets', widgets)
  dash.vm.$emit('change')
  await flushPromises()
  await pastDebounce()
}
const banner = () => document.querySelector<HTMLElement>('.load-failed-banner')
const pageIds = (c: DashboardConfig) => c.pages.map((p) => p.id)
const savedName = (c: DashboardConfig) => c.pages.find((p) => p.id === 'default')!.name

describe('App — a failed layout load never saves over the stored layout', () => {
  it.each([
    ['no answer (network error)', () => Promise.reject(new TypeError('Failed to fetch')) as unknown as Response],
    ['500', () => json('{"error":"internal"}', 500)],
    ['503', () => json('upstream unavailable', 503)],
    ['an HTML page instead of JSON', () => new Response('<!doctype html><p>Sign in</p>', { status: 200, headers: { 'Content-Type': 'text/html' } })],
    ['truncated JSON', () => json('{"version":12,"pages":[{"id":"default"', 200)],
    ['JSON that is not a layout', () => json('{"oops":true}', 200)],
  ] as [string, Reply][])('%s: banner shown, edits are labelled "Not saved", and no PUT goes out', async (_name, reply) => {
    stubServer(reply)
    const w = await mountApp()
    expect(banner()).not.toBeNull()
    expect(banner()!.textContent).toContain("Couldn't load your saved layout")
    expect(banner()!.querySelector('button')!.textContent!.trim()).toBe('Try again')
    // The stand-in on screen is the built-in default layout.
    expect(w.findComponent(Dashboard).exists()).toBe(true)

    await editEveryWay(w)
    expect(puts).toHaveLength(0)
    expect(w.find('.save-state').text()).toBe('Not saved')
    // still nothing a while later
    await pastDebounce()
    expect(puts).toHaveLength(0)
  })

  it('a network failure also runs the sign-in probe (an expired Access session looks like one)', async () => {
    stubServer(() => Promise.reject(new TypeError('Failed to fetch')) as unknown as Response)
    await mountApp()
    expect(checkSessionExpired).toHaveBeenCalledTimes(1)
  })

  it('a 401 shows the sign-in banner (not the retry one), and no PUT goes out', async () => {
    stubServer(() => json('{"error":"unauthenticated"}', 401))
    const w = await mountApp()
    expect(sessionExpired.value).toBe(true)
    expect(w.find('.reauth-banner').text()).toContain('Sign in again')
    expect(banner()).toBeNull()
    await editEveryWay(w)
    expect(puts).toHaveLength(0)
  })

  it('"Try again" that loads the layout shows it and turns saving back on — the next edit saves the stored layout', async () => {
    stubServer(() => json('upstream unavailable', 503), ok)
    const w = await mountApp()
    await editEveryWay(w)
    expect(puts).toHaveLength(0)

    await banner()!.querySelector('button')!.click()
    await flushPromises()
    await pastDebounce()
    expect(banner()).toBeNull()
    // Loading it is not an edit: nothing saved, and the "Not saved" label is gone.
    expect(puts).toHaveLength(0)
    expect(w.find('.save-state').exists()).toBe(false)

    await rename(w, 'After retry')
    await pastDebounce()
    expect(puts).toHaveLength(1)
    // What went out is the STORED layout with this one edit, not the defaults (and not the edits
    // made on the stand-in).
    const expected = normalizeConfig(stored())
    expect(pageIds(puts[0])).toEqual(pageIds(expected))
    expect(pageIds(puts[0])).not.toEqual(pageIds(defaultConfig()))
    expect(savedName(puts[0])).toBe('After retry')
    expect(w.find('.save-state').text()).toBe('Saved')
  })

  it('"Try again" that fails again keeps saving off', async () => {
    stubServer(() => json('boom', 500))
    const w = await mountApp()
    await banner()!.querySelector('button')!.click()
    await flushPromises()
    expect(banner()).not.toBeNull()
    await editEveryWay(w)
    expect(puts).toHaveLength(0)
  })

  it('an empty store (GET answers null) starts from the defaults and saves them on the first edit', async () => {
    stubServer(() => json('null'))
    const w = await mountApp()
    expect(banner()).toBeNull()
    await rename(w, 'First save')
    await pastDebounce()
    expect(puts).toHaveLength(1)
    expect(savedName(puts[0])).toBe('First save')
  })

  it('a stored layout that loads saves as before', async () => {
    stubServer(ok)
    const w = await mountApp()
    expect(banner()).toBeNull()
    await rename(w, 'Normal save')
    await pastDebounce()
    expect(puts).toHaveLength(1)
    expect(pageIds(puts[0])).toEqual(pageIds(normalizeConfig(stored())))
  })
})
