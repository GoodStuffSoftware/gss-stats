// @vitest-environment happy-dom
//
// Reviewer-flagged lockout (2026-09-26, still relevant post filter-bar-restore): a real touch
// tap fires `focus` BEFORE `click` — touchstart -> touchend -> mouseover/mousemove/mousedown ->
// focus -> mouseup -> click. The `.fb-toggle` button (now the "show filters" pin toggle — see
// App.filterbar.test.ts for the full visibility state machine it drives) used to open
// unconditionally on focus, then the touch click handler toggled it right back closed on that
// SAME tap's trailing click — a full lockout, not a cosmetic flicker, on any device that relies
// on it. This simulates the exact event sequence a touchscreen produces and asserts one tap
// pins it, a second unpins it (App.vue's onToggleFocus gates the focus-side open to non-touch
// input; touch relies solely on the click handler's toggle).
import { describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import App from './App.vue'

// The pin only does anything once the in-flow bar has scrolled out of view (App.filterbar.test.ts
// covers that whole state machine) — while it's in view, activating the toggle moves focus to
// the bar instead (reviewer fix, 2026-09-27), so this touch-lockout regression needs the bar
// reported "out of view" first, same as a real scrolled-away touch tap would find it.
class FakeIntersectionObserver {
  callback: IntersectionObserverCallback
  static instances: FakeIntersectionObserver[] = []
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    FakeIntersectionObserver.instances.push(this)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  fire(isIntersecting: boolean) {
    this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}
vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)

vi.mock('./lib/responsive', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/responsive')>()
  return { ...actual, isTouchDevice: () => true }
})
// Avoid real network calls from onMounted (loadConfig/loadSites) — this test only cares about
// the toggle button's own open/close behavior, not loaded data.
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    loadConfig: vi.fn(async () => null),
    saveConfig: vi.fn(async () => true),
    // A first-time viewer lands on ★ Overview (id 'default', lib/defaults.ts); its charts
    // fetch their own data, which this test never waits for.
  }
})
vi.mock('./sitesStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sitesStore')>()
  return { ...actual, loadSites: vi.fn(async () => {}) }
})
// AccountMenu.vue calls this on its own mount — stub it too, purely to keep test output free of
// the (harmless, try/caught) ECONNREFUSED noise a real fetch to a relative URL produces under
// happy-dom's default base origin.
vi.mock('./session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session')>()
  return { ...actual, loadIdentity: vi.fn(async () => {}), checkSessionExpired: vi.fn(async () => {}) }
})

// The same event sequence a real touchscreen tap produces on the element, in order — see
// BaseChart.vue's own long-press handling for the canonical description of this sequence.
async function touchTap(el: HTMLElement) {
  el.dispatchEvent(new Event('touchstart', { bubbles: true }))
  el.dispatchEvent(new Event('touchend', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  el.focus() // fires a real 'focus' event, same as the browser does mid-tap
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
}

describe('App — show-filters pin toggle on touch (lockout regression)', () => {
  it('pins on the first tap and unpins on the second, never stuck closed', async () => {
    FakeIntersectionObserver.instances = []
    const w = mount(App, { attachTo: document.body })
    await flushPromises()
    FakeIntersectionObserver.instances[0].fire(false) // the in-flow bar has scrolled away
    await flushPromises()
    const toggle = w.get('.fb-toggle')
    expect(toggle.attributes('aria-expanded')).toBe('false')

    await touchTap(toggle.element as HTMLElement)
    expect(toggle.attributes('aria-expanded')).toBe('true')

    await touchTap(toggle.element as HTMLElement)
    expect(toggle.attributes('aria-expanded')).toBe('false')

    w.unmount()
  })
})
