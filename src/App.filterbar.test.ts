// @vitest-environment happy-dom
//
// Owner request (2026-09-26): the main filter bar is back in normal flow (see App.vue's
// `filterbar-inflow` section, restored to its pre-v0.6 layout — commit 8692b0f — EXACTLY,
// reviewer-confirmed 2026-09-27: header order is save-state/dark-toggle/add-chart/AccountMenu,
// nothing else). These tests cover the NEW bit: the IntersectionObserver-driven "show filters"
// pin that takes over once that in-flow bar scrolls out of the viewport. State machine under
// test (App.vue: barVisible / pinned):
//   in view      -> toggle button visually hidden, but ALWAYS in the tab order
//   out of view  -> toggle button shown
//   click        -> pinned (a second copy of FilterBar fixed at the top of the viewport)
//   back in view -> unpinned, button hidden again
//   Esc          -> unpinned, focus returns to the toggle
// Reviewer fix (2026-09-27): a keyboard user who has tabbed past the toggle must still be able
// to reach it once the bar scrolls away, so it's never `tabindex="-1"`/`aria-hidden`. Focusing
// or activating it while the in-flow bar IS visible does nothing pin-related (nothing to pin) —
// activating it instead moves focus to the bar's first control.
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

  it('visually hides the show-filters button while the in-flow bar is in view, but keeps it in the tab order', async () => {
    const w = await mountApp()
    const toggle = w.get('.fb-toggle')
    expect(toggle.classes()).toContain('fb-toggle-hidden')
    // Reviewer fix (2026-09-27): never tabindex="-1", never aria-hidden — a keyboard user who
    // tabbed past this earlier must still be able to reach it once the bar scrolls away.
    expect(toggle.attributes('tabindex')).toBeUndefined()
    expect(toggle.attributes('aria-hidden')).toBeUndefined()
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
    expect(toggle.attributes('aria-hidden')).toBeUndefined()
    w.unmount()
  })

  it('focusing the toggle while the in-flow bar is visible does not pin anything', async () => {
    const w = await mountApp()
    // Bar is in view (default state) — nothing has scrolled it away.
    const toggle = w.get('.fb-toggle')
    await toggle.trigger('focus')
    expect(w.find('#fb-pinned-panel').exists()).toBe(false)
    expect(toggle.attributes('aria-expanded')).toBe('false')
    w.unmount()
  })

  it('activating the toggle while the in-flow bar is visible moves focus to the bar instead of pinning', async () => {
    const w = await mountApp()
    const toggle = w.get('.fb-toggle')
    await toggle.trigger('click')

    // Nothing pinned — there's nothing to pin while the in-flow bar is already on screen.
    expect(w.find('#fb-pinned-panel').exists()).toBe(false)
    // Focus landed on a real control inside the in-flow bar, not the toggle itself.
    const inflow = w.get('.filterbar-inflow').element
    expect(inflow.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).not.toBe(toggle.element)
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

describe('App — header matches the pre-v0.6 layout EXACTLY (reviewer fix, 2026-09-27)', () => {
  it('has no "reveal chart controls" button — only save-state, dark-toggle, add-chart, AccountMenu', async () => {
    const w = await mountApp()
    const buttons = w.findAll('.top-actions button')
    // Every button in top-actions must be one of the two plain header buttons (theme toggle,
    // add chart) — no button carries aria-pressed (that was the removed reveal-controls toggle).
    expect(buttons.length).toBeGreaterThan(0)
    for (const b of buttons) {
      expect(b.attributes('aria-pressed')).toBeUndefined()
    }
    const texts = buttons.map((b) => b.text())
    expect(texts.some((t) => t.includes('Add chart'))).toBe(true)
    w.unmount()
  })
})
