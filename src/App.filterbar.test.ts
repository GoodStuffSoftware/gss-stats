// @vitest-environment happy-dom
//
// Owner request (2026-09-26): the main filter bar is back in normal flow (see App.vue's
// `filterbar-inflow` section, restored to its pre-v0.6 layout — commit 8692b0f). These tests
// cover the NEW bit: the IntersectionObserver-driven "show filters" pin that takes over once
// that in-flow bar scrolls out of the viewport. State machine under test (App.vue: barVisible /
// pinned):
//   in view      -> toggle button hidden
//   out of view  -> toggle button shown
//   click        -> pinned (a second copy of FilterBar fixed at the top of the viewport)
//   back in view -> unpinned, button hidden again
//   Esc          -> unpinned, focus returns to the toggle
// happy-dom ships a real `IntersectionObserver` constructor but never fires it on its own (no
// actual layout/scrolling) — these tests stub it with a controllable fake so `observe()` is
// captured and its callback can be driven by hand.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import App from './App.vue'

// ── Controllable IntersectionObserver stub ─────────────────────────────────────────────────
// Deliberately NOT `implements IntersectionObserver` — the real interface grows non-standard
// members (e.g. `scrollMargin`) across lib.dom versions that App.vue's own code never touches;
// asserting the instance to the real type at the one point it's handed to a real callback
// (`fire`) is enough to keep the test honest without chasing every incidental interface field.
class FakeIntersectionObserver {
  root: Element | Document | null = null
  rootMargin = ''
  thresholds: number[] = [0]
  callback: IntersectionObserverCallback
  target: Element | null = null
  static instances: FakeIntersectionObserver[] = []
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    FakeIntersectionObserver.instances.push(this)
  }
  observe(el: Element) {
    this.target = el
  }
  unobserve() {
    this.target = null
  }
  disconnect() {
    this.target = null
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  // Test helper: simulate the bar entering/leaving the viewport.
  fire(isIntersecting: boolean) {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    loadConfig: vi.fn(async () => null),
    saveConfig: vi.fn(async () => true),
    fetchOverview: vi.fn(async () => null as any),
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

async function mountApp() {
  const w = mount(App, { attachTo: document.body })
  await flushPromises()
  return w
}

describe('App — main filter bar: in-flow layout + show-filters pin state machine', () => {
  let realIO: typeof IntersectionObserver

  beforeEach(() => {
    FakeIntersectionObserver.instances = []
    realIO = window.IntersectionObserver
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  })
  afterEach(() => {
    vi.stubGlobal('IntersectionObserver', realIO)
  })

  it('restores the bar to normal flow, directly under the page tabs — not behind a hidden panel', async () => {
    const w = await mountApp()
    // The pre-v0.6 in-flow section exists and contains the real FilterBar (unconditionally,
    // not gated behind any `v-if="barOpen"`-style panel).
    expect(w.find('.filterbar-inflow').exists()).toBe(true)
    expect(w.find('.filterbar-inflow .filter-bar').exists()).toBe(true)
    w.unmount()
  })

  it('hides the show-filters button while the in-flow bar is in view', async () => {
    const w = await mountApp()
    const toggle = w.get('.fb-toggle')
    expect(toggle.classes()).toContain('fb-toggle-hidden')
    expect(toggle.attributes('aria-hidden')).toBe('true')
    w.unmount()
  })

  it('shows the button once the in-flow bar scrolls out of view', async () => {
    const w = await mountApp()
    const observer = FakeIntersectionObserver.instances[0]
    expect(observer).toBeTruthy()

    observer.fire(false) // scrolled away
    await flushPromises()

    const toggle = w.get('.fb-toggle')
    expect(toggle.classes()).not.toContain('fb-toggle-hidden')
    expect(toggle.attributes('aria-hidden')).toBe('false')
    w.unmount()
  })

  it('pins the same FilterBar, fixed at the top, on click', async () => {
    const w = await mountApp()
    const observer = FakeIntersectionObserver.instances[0]
    observer.fire(false)
    await flushPromises()

    expect(w.find('#fb-pinned-panel').exists()).toBe(false)

    await w.get('.fb-toggle').trigger('click')

    w.get('#fb-pinned-panel') // throws if missing — the pin rendered
    expect(w.get('.fb-toggle').attributes('aria-expanded')).toBe('true')
    // The in-flow bar keeps its place — it's never removed while pinned (no layout shift).
    expect(w.find('.filterbar-inflow').exists()).toBe(true)
    w.unmount()
  })

  it('unpins and hides the button again once scrolled back to where the in-flow bar is visible', async () => {
    const w = await mountApp()
    const observer = FakeIntersectionObserver.instances[0]
    observer.fire(false)
    await flushPromises()
    await w.get('.fb-toggle').trigger('click')
    expect(w.find('#fb-pinned-panel').exists()).toBe(true)

    observer.fire(true) // scrolled back — the in-flow bar is visible again
    await flushPromises()

    expect(w.find('#fb-pinned-panel').exists()).toBe(false)
    const toggle = w.get('.fb-toggle')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(toggle.classes()).toContain('fb-toggle-hidden')
    w.unmount()
  })

  it('Esc unpins and returns focus to the toggle button', async () => {
    const w = await mountApp()
    const observer = FakeIntersectionObserver.instances[0]
    observer.fire(false)
    await flushPromises()
    const toggle = w.get('.fb-toggle')
    await toggle.trigger('click')
    expect(w.find('#fb-pinned-panel').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(w.find('#fb-pinned-panel').exists()).toBe(false)
    expect(document.activeElement).toBe(toggle.element)
    w.unmount()
  })

  it('clicking outside the pinned bar dismisses it', async () => {
    const w = await mountApp()
    const observer = FakeIntersectionObserver.instances[0]
    observer.fire(false)
    await flushPromises()
    await w.get('.fb-toggle').trigger('click')
    expect(w.find('#fb-pinned-panel').exists()).toBe(true)

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()

    expect(w.find('#fb-pinned-panel').exists()).toBe(false)
    w.unmount()
  })
})

describe('App — "reveal all chart controls" stays reachable without the old hidden panel', () => {
  it('is an always-present header toggle, independent of the filter-bar pin state', async () => {
    const w = await mountApp()
    // Not gated behind barOpen/pinned — it's a plain always-visible button in the header now.
    const buttons = w.findAll('.top-actions button')
    expect(buttons.length).toBeGreaterThan(0)
    const revealBtn = buttons.find((b) => b.attributes('aria-pressed') !== undefined)
    expect(revealBtn).toBeTruthy()
    expect(revealBtn!.attributes('aria-pressed')).toBe('false')
    await revealBtn!.trigger('click')
    expect(revealBtn!.attributes('aria-pressed')).toBe('true')
    w.unmount()
  })
})
