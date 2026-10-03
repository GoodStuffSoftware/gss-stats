// @vitest-environment happy-dom
//
// Fit-to-content card height (Widget.fit, lib/fit.ts, composables/useFitHeight.ts), at the
// component level: ChartCard marks a fit card and reports its content height; Dashboard turns that
// into grid rows, stops offering the resize grip on it, and leaves every widget without `fit`
// exactly as it was.
//
// happy-dom has no layout engine, so the geometry the browser would measure is stubbed here (the
// offset box, getBoundingClientRect, ResizeObserver). That makes these tests about the WIRING
// (class, event, rows, resize flag, settle step, no clipping rule in the CSS). Whether a real fit
// card is clipped or scrolls is checked in a real browser (scrollHeight vs clientHeight).
//
// `getBoundingClientRect` is deliberately stubbed to a DIFFERENT, inflated answer than the offset
// box, like a card mid-way through ChartCard's scale() zoom animation: the measure must use the
// offset box, so a regression to getBoundingClientRect fails these tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import ChartCard from './ChartCard.vue'
import chartCardSource from './ChartCard.vue?raw'
import Dashboard from './Dashboard.vue'
import { fitRows } from '../lib/fit'
import { FIT_SETTLE_MS } from '../composables/useFitHeight'
import type { GlobalFilters, Widget } from '../types'

const filters: GlobalFilters = { siteSel: [], since: '2026-09-01', until: '2026-09-26', excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
const note = (over: Partial<Widget> = {}): Widget => ({ id: 'n1', i: 'n1', title: 'A note', type: 'note', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 4, h: 5, ...over }) as Widget

// Stubbed layout. `contentBottom` is where the last child of every card ends, relative to the
// card's top (0). Observers are recorded so a test can fire a resize.
let contentBottom = 300
let laidOut = true
const observers: { cb: () => void; observed: Element[] }[] = []
class FakeResizeObserver {
  rec: { cb: () => void; observed: Element[] }
  constructor(cb: () => void) {
    this.rec = { cb, observed: [] }
    observers.push(this.rec)
  }
  observe(el: Element) {
    this.rec.observed.push(el)
  }
  unobserve() {}
  disconnect() {
    this.rec.observed = []
  }
}
const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) }) as DOMRect

const mounted: VueWrapper[] = []
beforeEach(() => {
  contentBottom = 300
  laidOut = true
  observers.length = 0
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  // The offset box (what the measure reads): the card is 999 tall in its slot, its children end at contentBottom.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(() => (laidOut ? 400 : 0))
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    if (!laidOut) return 0
    return this.classList.contains('chart-card') ? 999 : contentBottom
  })
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(() => 0)
  // The transformed rect: 2x taller than the real box, as a zoomed-out card mid-animation reports.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('chart-card') ? rect(0, 999 * 2) : rect(0, contentBottom * 2)
  })
  vi.stubGlobal('innerWidth', 1280)
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// Let the settle step elapse (and the promises behind it).
async function settle() {
  await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS + 10)
  await nextTick()
}
function fireResize() {
  for (const o of observers) if (o.observed.length) o.cb()
}

function mountCard(widget: Widget) {
  const w = mount(ChartCard, { props: { widget, filters, dark: false, drillOpen: false, forceControls: false }, attachTo: document.body })
  mounted.push(w)
  return w
}
function mountDashboard(widgets: Widget[]) {
  const w = mount(Dashboard, { props: { widgets, filters, dark: false, drillOpenId: null, controlsVisible: false }, attachTo: document.body })
  mounted.push(w)
  return w
}

describe('ChartCard: a fit card', () => {
  it('without fit: no .fit class, no observer, no fit-height event (renders exactly as before)', async () => {
    const w = mountCard(note())
    await settle()
    expect(w.get('.chart-card').classes()).not.toContain('fit')
    expect(observers.length).toBe(0)
    expect(w.emitted('fit-height')).toBeUndefined()
  })

  it('with fit: gets .fit and reports its content height (the last child bottom, not the slot height)', async () => {
    const w = mountCard(note({ fit: 'content' }))
    await settle()
    expect(w.get('.chart-card').classes()).toContain('fit')
    const heights = (w.emitted('fit-height') ?? []).map((a) => a[0])
    expect(heights.length).toBeGreaterThan(0)
    // card is stubbed 999 tall; the content ends at 300: the content is what is reported.
    expect(heights.at(-1)).toBe(300)
  })

  it('reports again when the content resizes (async data arriving, a font loading)', async () => {
    const w = mountCard(note({ fit: 'content' }))
    await settle()
    contentBottom = 520
    fireResize()
    await settle()
    expect((w.emitted('fit-height') ?? []).at(-1)![0]).toBe(520)
  })

  it('observes the card children, and never the card itself', async () => {
    mountCard(note({ fit: 'content' }))
    await settle()
    const live = observers.filter((o) => o.observed.length)
    expect(live.length).toBe(1)
    expect(live[0].observed.every((el) => !(el as HTMLElement).classList.contains('chart-card'))).toBe(true)
  })

  it('turning fit off stops reporting and drops the class', async () => {
    const w = mountCard(note({ fit: 'content' }))
    await settle()
    await w.setProps({ widget: note() })
    await nextTick()
    expect(w.get('.chart-card').classes()).not.toContain('fit')
    const before = (w.emitted('fit-height') ?? []).length
    contentBottom = 800
    fireResize()
    await settle()
    expect((w.emitted('fit-height') ?? []).length).toBe(before)
  })

  it('a canvas widget ignores fit: no class, no reporting (it has no content height of its own)', async () => {
    const w = mountCard(note({ type: 'line', fit: 'content' }))
    await settle()
    expect(w.get('.chart-card').classes()).not.toContain('fit')
    expect(w.emitted('fit-height')).toBeUndefined()
  })

  it('measures the offset box, not the transformed rect: a zoom-out scale() cannot inflate the height', async () => {
    const w = mountCard(note({ fit: 'content' }))
    await settle()
    const card = w.get('.chart-card').element as HTMLElement
    // The FLIP animation's start state: a scale on the card. getBoundingClientRect (stubbed 2x here)
    // follows it; the offset box does not.
    card.style.transform = 'translate(10px, 20px) scale(1.5, 2)'
    fireResize()
    await settle()
    expect((w.emitted('fit-height') ?? []).map((a) => a[0])).not.toContain(600)
    expect((w.emitted('fit-height') ?? []).at(-1)![0]).toBe(300)
  })

  it('settles: a burst of resizes (data loading in two steps) yields one report, of the final height', async () => {
    const w = mountCard(note({ fit: 'content' }))
    await settle()
    const before = (w.emitted('fit-height') ?? []).length
    contentBottom = 120 // the placeholder
    fireResize()
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS - 100)
    expect((w.emitted('fit-height') ?? []).length).toBe(before) // still settling: nothing reported yet
    contentBottom = 480 // the data arrives
    fireResize()
    await vi.advanceTimersByTimeAsync(FIT_SETTLE_MS - 100)
    expect((w.emitted('fit-height') ?? []).length).toBe(before)
    await vi.advanceTimersByTimeAsync(200)
    const heights = (w.emitted('fit-height') ?? []).map((a) => a[0])
    expect(heights.length).toBe(before + 1)
    expect(heights.at(-1)).toBe(480)
  })

  it('a card that is not laid out (hidden, zero-sized) reports nothing, so it never saves the minimum', async () => {
    const w = mountCard(note({ fit: 'content' }))
    await settle()
    const before = (w.emitted('fit-height') ?? []).length
    laidOut = false
    contentBottom = 0
    fireResize()
    await settle()
    expect((w.emitted('fit-height') ?? []).length).toBe(before)
  })

  it('a card that is unmounted before it settles reports nothing', async () => {
    const w = mountCard(note({ fit: 'content' }))
    w.unmount()
    mounted.pop()
    await settle()
    expect(w.emitted('fit-height')).toBeUndefined()
  })

  it('keeps one observer for the card across re-renders (no rebuild, no extra report)', async () => {
    const w = mountCard(note({ fit: 'content' }))
    await settle()
    const made = observers.length
    const before = (w.emitted('fit-height') ?? []).length
    await w.setProps({ forceControls: true })
    await w.setProps({ forceControls: false })
    await settle()
    expect(observers.length).toBe(made)
    expect((w.emitted('fit-height') ?? []).length).toBe(before)
  })

  it('the .fit card body is content-sized and not clipped: no flex:1, no scroll container', () => {
    const src = chartCardSource
    const rule = /\.chart-card\.fit \.card-body\s*\{([^}]*)\}/.exec(src)
    expect(rule, 'a .chart-card.fit .card-body rule').toBeTruthy()
    expect(rule![1]).toMatch(/flex:\s*none/)
    expect(rule![1]).toMatch(/overflow:\s*visible/)
    expect(rule![1]).not.toMatch(/overflow(-y)?:\s*(auto|scroll|hidden)/)
  })
})

describe('Dashboard: grid height follows the content', () => {
  it('sets h to the smallest whole number of rows that holds the content', async () => {
    const widgets = [note({ fit: 'content', h: 5 })]
    mountDashboard(widgets)
    await settle()
    expect(widgets[0].h).toBe(fitRows(300))
    expect(widgets[0].h).toBe(6) // 6 rows are 6*40 + 5*14 = 310px, the least that holds 300
  })

  it('follows the content up and down', async () => {
    const widgets = [note({ fit: 'content', h: 5 })]
    mountDashboard(widgets)
    await settle()
    contentBottom = 520
    fireResize()
    await settle()
    expect(widgets[0].h).toBe(fitRows(520))
    contentBottom = 100
    fireResize()
    await settle()
    expect(widgets[0].h).toBe(3) // the grid minimum
  })

  it('a widget without fit keeps its h, and nothing observes it', async () => {
    const widgets = [note({ h: 5 }), note({ id: 'n2', i: 'n2', x: 4, h: 9 })]
    mountDashboard(widgets)
    await settle()
    expect(widgets.map((w) => w.h)).toEqual([5, 9])
    expect(observers.filter((o) => o.observed.length).length).toBe(0)
  })

  it('only the fit card changes when fit and fixed cards sit side by side', async () => {
    const widgets = [note({ fit: 'content', h: 5 }), note({ id: 'n2', i: 'n2', x: 4, h: 9 })]
    mountDashboard(widgets)
    await settle()
    expect(widgets[0].h).toBe(6)
    expect(widgets[1].h).toBe(9)
  })

  it('does not offer the resize grip on a fit card, and still does on a fixed one', async () => {
    const widgets = [note({ fit: 'content' }), note({ id: 'n2', i: 'n2', x: 4 })]
    const w = mountDashboard(widgets)
    await settle()
    const items = w.findAll('.vgl-item:not(.vgl-item--placeholder)')
    expect(items.length).toBe(2)
    expect(items[0].find('.vgl-item__resizer').exists()).toBe(false)
    expect(items[1].find('.vgl-item__resizer').exists()).toBe(true)
  })

  it('on a phone the measurement never overwrites the desktop h', async () => {
    vi.stubGlobal('innerWidth', 600)
    const widgets = [note({ fit: 'content', h: 5 })]
    mountDashboard(widgets)
    await settle()
    expect(widgets[0].h).toBe(5)
  })
})
