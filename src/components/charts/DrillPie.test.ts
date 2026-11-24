// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { Chart } from 'chart.js'
import { defineComponent, nextTick } from 'vue'
import BaseChart from './BaseChart.vue'
import DrillPie, { DONUT_MIN, DONUT_STEP, LEGEND_COL_PX, WIDE_GAP_PX, clampDonutSize, donutLayout, dragDiameter, holdSelectionLock, legendColumns, releaseSelectionLock, readDonutSize, sliceLabelParts, writeDonutSize, type PieSlice } from './DrillPie.vue'
import source from './DrillPie.vue?raw'

const SLICES: PieSlice[] = [
  { key: 'a', label: 'Alpha', value: 6000, color: '#E0722C', detail: '3 items' },
  { key: 'b', label: 'Beta', value: 3000, color: '#2C7DA0' },
  { key: 'zero', label: 'Nothing', value: 0, color: '#000000' },
  { key: '__other__', label: 'Other (3)', value: 1000, color: '#C9C3B8', inert: true },
]

// A stand-in chart: DrillPie's job is the config it hands over and the clicks it takes back.
const ChartStub = defineComponent({
  name: 'BaseChart',
  props: { config: { type: Object, required: true }, drillOpen: Boolean },
  emits: ['point'],
  template: '<div class="chart-stub" />',
})

const mounted: VueWrapper[] = []
function mountPie(props: Record<string, unknown> = {}, stub = true) {
  const w = mount(DrillPie, {
    props: { slices: SLICES, dark: false, ...props },
    global: stub ? { stubs: { BaseChart: ChartStub } } : {},
    attachTo: document.body,
  })
  mounted.push(w)
  return w
}
const configOf = (w: VueWrapper) => w.findComponent(ChartStub).props('config') as any
const pluginOf = (c: any, id: string) => c.plugins.find((p: any) => p.id === id)
const motionOf = (w: VueWrapper) => pluginOf(configOf(w), 'pieMotion').motion

function setReducedMotion(on: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (q: string) =>
      ({ matches: on && q.includes('prefers-reduced-motion'), media: q, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  )
}

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.restoreAllMocks()
})

describe('DrillPie config', () => {
  beforeEach(() => setReducedMotion(false))

  it('a doughnut of the slices that have a size, in their colours', () => {
    const c = configOf(mountPie())
    expect(c.type).toBe('doughnut')
    expect(c.data.labels).toEqual(['Alpha', 'Beta', 'Other (3)'])
    expect(c.data.datasets[0].data).toEqual([6000, 3000, 1000])
    expect(c.data.datasets[0].backgroundColor).toEqual(['#E0722C', '#2C7DA0', '#C9C3B8'])
    expect(c.options.plugins.legend.display).toBe(false)
  })

  it('a first appearance sweeps in; animate=false plays nothing', () => {
    expect(motionOf(mountPie())).toEqual({ kind: 'unfurl', mid: 0 })
    expect(motionOf(mountPie({ animate: false }))).toEqual({ kind: 'none' })
  })

  it('prefers-reduced-motion plays the same motion (a short one-shot, no fade in its place)', () => {
    setReducedMotion(true)
    expect(motionOf(mountPie())).toEqual({ kind: 'unfurl', mid: 0 })
    expect(motionOf(mountPie({ animate: false }))).toEqual({ kind: 'none' })
  })

  describe('a transition says where the next set of slices comes from', () => {
    const level1: PieSlice[] = [
      { key: 'a', label: 'Alpha', value: 2000, color: '#E0722C' },
      { key: 'b', label: 'Beta', value: 6000, color: '#2C7DA0' },
      { key: 'c', label: 'Gamma', value: 2000, color: '#9C6644' },
    ]
    const level2: PieSlice[] = [
      { key: 'b1', label: 'B one', value: 5, color: '#111111' },
      { key: 'b2', label: 'B two', value: 5, color: '#222222' },
    ]

    it('in: the new slices grow out of the picked slice\'s wedge of the pie that was on screen', async () => {
      const w = mountPie({ slices: level1 })
      expect(motionOf(w)).toEqual({ kind: 'unfurl', mid: 0 })
      await w.setProps({ slices: level2, transition: { key: 'b', dir: 'in' } })
      expect(motionOf(w)).toEqual({ kind: 'expand', from: 0.2, to: 0.8 })
    })

    it('out: the pie grows around the slice it came back from, in the new pie', async () => {
      const w = mountPie({ slices: level2 })
      await w.setProps({ slices: level1, transition: { key: 'b', dir: 'out' } })
      const m = motionOf(w)
      expect(m.kind).toBe('unfurl')
      expect(m.mid).toBeCloseTo(0.5, 9)
    })

    it('a slice inside a folded bucket counts as the bucket\'s wedge', async () => {
      const members: PieSlice[] = [
        { key: 'm1', label: 'M1', value: 300, color: '#111111' },
        { key: 'm2', label: 'M2', value: 200, color: '#222222' },
      ]
      const folded: PieSlice[] = [{ key: 'a', label: 'Alpha', value: 500, color: '#E0722C' }, { key: 'bucket', label: '2 smaller', value: 500, color: '#C9C3B8', members }]
      const w = mountPie({ slices: folded })
      await w.setProps({ slices: level2, transition: { key: 'm2', dir: 'in' } })
      expect(motionOf(w)).toEqual({ kind: 'expand', from: 0.5, to: 1 })
      await w.setProps({ slices: folded, transition: { key: 'm2', dir: 'out' } })
      expect(motionOf(w)).toMatchObject({ kind: 'unfurl', mid: 0.75 })
    })

    it('a transition whose slice is not found, or none at all, falls back to the sweep from the top', async () => {
      const w = mountPie({ slices: level1 })
      await w.setProps({ slices: level2, transition: { key: 'nope', dir: 'in' } })
      expect(motionOf(w)).toEqual({ kind: 'unfurl', mid: 0 })
      await w.setProps({ slices: level1, transition: undefined })
      expect(motionOf(w)).toEqual({ kind: 'unfurl', mid: 0 })
    })

    it('a transition is used once: a later change of the slices does not reuse it', async () => {
      const w = mountPie({ slices: level1 })
      const t = { key: 'b', dir: 'in' as const }
      await w.setProps({ slices: level2, transition: t })
      expect(motionOf(w).kind).toBe('expand')
      await w.setProps({ slices: [level2[0]] }) // same transition object still set, a different slice set
      expect(motionOf(w)).toEqual({ kind: 'unfurl', mid: 0 })
    })

    it('the old pie stays (the same chart) until the new slices arrive, and a new level starts with its buckets closed', async () => {
      const members: PieSlice[] = [{ key: 'm1', label: 'M1', value: 500, color: '#111111' }]
      const folded: PieSlice[] = [{ key: 'a', label: 'Alpha', value: 500, color: '#E0722C' }, { key: 'bucket', label: '1 smaller', value: 500, color: '#C9C3B8', members }]
      const w = mountPie({ slices: folded })
      const before = configOf(w)
      await w.get('[data-testid="pie-row-bucket"]').trigger('click')
      expect(w.find('[data-testid="pie-members-bucket"]').exists()).toBe(true)
      expect(configOf(w)).toBe(before)
      await w.setProps({ slices: level2 })
      await w.setProps({ slices: folded })
      expect(w.find('[data-testid="pie-members-bucket"]').exists()).toBe(false)
    })
  })

  it('the same slices redrawn (a theme switch, new numbers) play no motion; a different set does', async () => {
    const w = mountPie()
    expect(motionOf(w).kind).toBe('unfurl')
    await w.setProps({ dark: true })
    expect(motionOf(w)).toEqual({ kind: 'none' })
    await w.setProps({ slices: SLICES.map((s) => ({ ...s, value: s.value * 2 })) })
    expect(motionOf(w)).toEqual({ kind: 'none' })
    await w.setProps({ slices: SLICES.slice(0, 2) })
    expect(motionOf(w).kind).toBe('unfurl')
  })

  it('labels each drawn slice on the arc: its name, then the amount and share alternatives', () => {
    const c = configOf(mountPie({ format: (v: number) => `$${v / 100}` }))
    const labels = pluginOf(c, 'arcLabels')
    expect(labels).toBeTruthy()
    // the labels plugin comes before the motion plugin: labels are drawn on the moved arcs, then the arcs go back
    expect(c.plugins.map((p: any) => p.id)).toEqual(['arcLabels', 'pieMotion'])
    expect(sliceLabelParts('$60', 60)).toEqual(['$60 · 60%', '$60', '60%'])
  })

  it('the slice border follows the theme', () => {
    expect(configOf(mountPie({ dark: false })).data.datasets[0].borderColor).toBe('#FFFFFF')
    expect(configOf(mountPie({ dark: true })).data.datasets[0].borderColor).toBe('#211C18')
  })

  it('the tooltip shows the formatted value and its share', () => {
    const c = configOf(mountPie({ format: (v: number) => `$${v / 100}` }))
    expect(c.options.plugins.tooltip.callbacks.label({ label: 'Alpha', raw: 6000 })).toBe('Alpha: $60 (60%)')
  })

  it('a new array with the same content keeps the chart (no replayed sweep); changed content builds a new one', async () => {
    const w = mountPie()
    const first = configOf(w)
    await w.setProps({ slices: SLICES.map((s) => ({ ...s })) })
    expect(configOf(w)).toBe(first)
    await w.setProps({ slices: SLICES.slice(0, 2) })
    expect(configOf(w)).not.toBe(first)
    expect(configOf(w).data.labels).toEqual(['Alpha', 'Beta'])
  })
})

describe('DrillPie picks', () => {
  beforeEach(() => setReducedMotion(false))

  it('a click on a slice reports its key; the index counts only the slices that are drawn', () => {
    const w = mountPie()
    const chart = w.findComponent(ChartStub)
    chart.vm.$emit('point', { index: 1, datasetIndex: 0, x: 0, y: 0 })
    expect(w.emitted('select')).toEqual([['b']])
  })

  it('an inert slice (the folded "Other") is never reported, on the chart or in the list', async () => {
    const w = mountPie()
    w.findComponent(ChartStub).vm.$emit('point', { index: 2, datasetIndex: 0, x: 0, y: 0 })
    expect(w.emitted('select')).toBeUndefined()
    const row = w.get('[data-testid="pie-row-__other__"]')
    expect(row.element.tagName).toBe('DIV')
    await row.trigger('click')
    expect(w.emitted('select')).toBeUndefined()
  })

  it('a slice with members opens a list of them (chart or row), is not reported itself, and a member is', async () => {
    const members: PieSlice[] = [
      { key: 'm1', label: 'Mem One', value: 600, color: '#111111' },
      { key: 'm2', label: 'Mem Two', value: 400, color: '#222222' },
    ]
    const w = mountPie({ slices: [SLICES[0], { key: 'bucket', label: '2 smaller things', value: 1000, color: '#C9C3B8', members }] })
    const row = w.get('[data-testid="pie-row-bucket"]')
    expect(row.element.tagName).toBe('BUTTON')
    expect(row.attributes('aria-expanded')).toBe('false')
    expect(w.find('[data-testid="pie-members-bucket"]').exists()).toBe(false)
    await row.trigger('click')
    expect(row.attributes('aria-expanded')).toBe('true')
    expect(w.findAll('[data-testid^="pie-member-"]').map((m) => m.get('.dp-label').text())).toEqual(['Mem One', 'Mem Two'])
    expect(w.emitted('select')).toBeUndefined()
    await w.get('[data-testid="pie-member-m2"]').trigger('click')
    expect(w.emitted('select')).toEqual([['m2']])
    w.findComponent(ChartStub).vm.$emit('point', { index: 1, datasetIndex: 0, x: 0, y: 0 }) // the bucket's own arc closes it
    await w.vm.$nextTick()
    expect(w.find('[data-testid="pie-members-bucket"]').exists()).toBe(false)
    expect(w.emitted('select')).toEqual([['m2']])
  })

  it('the list repeats every drawn slice as a button with its value and share; clicking one reports it', async () => {
    const w = mountPie({ format: (v: number) => `${v} c` })
    const rows = w.findAll('.dp-row')
    expect(rows.map((r) => r.get('.dp-label').text())).toEqual(['Alpha', 'Beta', 'Other (3)'])
    expect(w.get('[data-testid="pie-row-a"]').text()).toContain('6000 c')
    expect(w.get('[data-testid="pie-row-a"]').text()).toContain('60%')
    expect(w.get('[data-testid="pie-row-a"]').text()).toContain('3 items')
    expect(w.find('[data-testid="pie-row-zero"]').exists()).toBe(false)
    await w.get('[data-testid="pie-row-b"]').trigger('click')
    expect(w.emitted('select')).toEqual([['b']])
  })
})

// deliberate: a click or tap on the chart only shows the tooltip; a double-click, a double-tap or a hold picks.
describe('DrillPie deliberate picking', () => {
  // The chart stand-in has a canvas, and Chart.getChart finds a hit test for it: x < 100 is slice 0, else slice 1.
  const CanvasStub = defineComponent({
    name: 'BaseChart',
    props: { config: { type: Object, required: true }, drillOpen: Boolean },
    emits: ['point'],
    template: '<canvas />',
  })
  const mountDeliberate = (props: Record<string, unknown> = {}) => {
    const w = mount(DrillPie, { props: { slices: SLICES, dark: false, deliberate: true, ...props }, global: { stubs: { BaseChart: CanvasStub } }, attachTo: document.body })
    mounted.push(w)
    return w
  }
  const fire = (w: VueWrapper, type: string, x = 50, y = 50, extra: Record<string, unknown> = {}) => {
    const e = Object.assign(new Event(type, { bubbles: true, cancelable: true }), { pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y }, extra)
    w.get('canvas').element.dispatchEvent(e)
    return e
  }
  beforeEach(() => {
    setReducedMotion(false)
    vi.useFakeTimers()
    vi.spyOn(Chart, 'getChart').mockReturnValue({
      getElementsAtEventForMode: (e: { clientX: number }) => [{ index: e.clientX < 100 ? 0 : 1, datasetIndex: 0 }],
    } as never)
  })
  afterEach(() => vi.useRealTimers())

  /** A whole mouse click on the chart. */
  const mouseClick = (w: VueWrapper, x = 50) => {
    fire(w, 'pointerdown', x)
    vi.advanceTimersByTime(60)
    fire(w, 'pointerup', x)
    fire(w, 'click', x)
  }
  const setFinePointer = (fine: boolean) =>
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) =>
        ({ matches: q === '(hover: hover) and (pointer: fine)' ? fine : false, media: q, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
    )

  it('the hint matches the input: click on a fine pointer with hover, press and hold otherwise; none without deliberate', () => {
    setFinePointer(true)
    expect(mountDeliberate().get('[data-testid="pie-hint"]').text()).toBe('Click a slice to open it')
    setFinePointer(false)
    expect(mountDeliberate().get('[data-testid="pie-hint"]').text()).toBe('Press and hold a slice to open it')
    expect(mountPie().find('[data-testid="pie-hint"]').exists()).toBe(false)
  })

  it('the hint follows the pointer media query when it changes', async () => {
    let fine = false
    let onChange = () => {}
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (q: string) =>
        ({
          get matches() {
            return q === '(hover: hover) and (pointer: fine)' && fine
          },
          media: q,
          addEventListener: (_: string, fn: () => void) => (onChange = fn),
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    )
    const w = mountDeliberate()
    expect(w.get('[data-testid="pie-hint"]').text()).toBe('Press and hold a slice to open it')
    fine = true
    onChange()
    await w.vm.$nextTick()
    expect(w.get('[data-testid="pie-hint"]').text()).toBe('Click a slice to open it')
  })

  it('the chart\'s own click and long-press do not pick', () => {
    const w = mountDeliberate()
    w.findComponent(CanvasStub).vm.$emit('point', { index: 1, datasetIndex: 0, x: 0, y: 0 })
    expect(w.emitted('select')).toBeUndefined()
  })

  it('a mouse click picks the slice under the pointer', () => {
    const w = mountDeliberate()
    mouseClick(w, 150)
    expect(w.emitted('select')).toEqual([['b']])
  })

  it('a mouse double-click picks ONE level: the second click and the dblclick are ignored', () => {
    const w = mountDeliberate()
    mouseClick(w, 50)
    vi.advanceTimersByTime(90)
    mouseClick(w, 50)
    fire(w, 'dblclick', 50)
    expect(w.emitted('select')).toEqual([['a']])
  })

  it('clicks are ignored while the new level is on its way and while it moves, and work again after', async () => {
    const w = mountDeliberate()
    mouseClick(w, 50)
    expect(w.emitted('select')).toEqual([['a']])
    // the new slices arrive after a while (a fetch): still blocked
    vi.advanceTimersByTime(1000)
    mouseClick(w, 150)
    expect(w.emitted('select')).toEqual([['a']])
    await w.setProps({ slices: [{ key: 'n1', label: 'N one', value: 5, color: '#111111' }, { key: 'n2', label: 'N two', value: 5, color: '#222222' }], transition: { key: 'a', dir: 'in' } })
    mouseClick(w, 150) // the motion plays
    expect(w.emitted('select')).toEqual([['a']])
    vi.advanceTimersByTime(560 + 250)
    mouseClick(w, 150)
    expect(w.emitted('select')).toEqual([['a'], ['n2']])
  })

  it('a pick that brings no new level does not lock the pie for good', () => {
    const w = mountDeliberate()
    mouseClick(w, 50)
    vi.advanceTimersByTime(1600) // nothing arrived
    mouseClick(w, 150)
    expect(w.emitted('select')).toEqual([['a'], ['b']])
  })

  it('shows a pointer cursor over a slice a click can pick, and none off the pie or over an inert slice', () => {
    const w = mountDeliberate()
    const box = w.get('.dp-canvas').element as HTMLElement
    fire(w, 'pointermove', 50)
    expect(box.style.cursor).toBe('pointer')
    vi.spyOn(Chart, 'getChart').mockReturnValue({ getElementsAtEventForMode: () => [] } as never)
    fire(w, 'pointermove', 500)
    expect(box.style.cursor).toBe('')
    vi.spyOn(Chart, 'getChart').mockReturnValue({ getElementsAtEventForMode: () => [{ index: 2, datasetIndex: 0 }] } as never) // "Other (3)", inert
    fire(w, 'pointermove', 50)
    expect(box.style.cursor).toBe('')
  })

  it('a finger moving over the pie sets no cursor, and leaving the pie clears it', () => {
    const w = mountDeliberate()
    const box = w.get('.dp-canvas').element as HTMLElement
    fire(w, 'pointermove', 50, 50, { pointerType: 'touch' })
    expect(box.style.cursor).toBe('')
    fire(w, 'pointermove', 50)
    expect(box.style.cursor).toBe('pointer')
    box.dispatchEvent(Object.assign(new Event('pointerleave'), { pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0 }))
    expect(box.style.cursor).toBe('')
  })

  it('a touch tap shows the tooltip only: nothing is picked, not even by the click the browser adds', () => {
    const w = mountDeliberate()
    fire(w, 'pointerdown', 50, 50, { pointerType: 'touch' })
    vi.advanceTimersByTime(80)
    fire(w, 'pointerup', 50, 50, { pointerType: 'touch' })
    fire(w, 'click', 50, 50, { pointerType: 'touch' })
    vi.advanceTimersByTime(2000)
    expect(w.emitted('select')).toBeUndefined()
  })

  it('a touch hold picks it, and the release after it does not pick again or click through', () => {
    const w = mountDeliberate()
    fire(w, 'pointerdown', 50, 50, { pointerType: 'touch' })
    vi.advanceTimersByTime(500)
    expect(w.emitted('select')).toEqual([['a']])
    fire(w, 'pointerup', 50, 50, { pointerType: 'touch' })
    const click = fire(w, 'click', 50, 50, { pointerType: 'touch' })
    expect(click.defaultPrevented).toBe(true)
    expect(w.emitted('select')).toEqual([['a']])
  })

  it('a touch hold that moves away picks nothing', () => {
    const w = mountDeliberate()
    fire(w, 'pointerdown', 50, 50, { pointerType: 'touch' })
    fire(w, 'pointermove', 70, 50, { pointerType: 'touch' })
    vi.advanceTimersByTime(1000)
    expect(w.emitted('select')).toBeUndefined()
  })

  it('a double-tap picks (touch)', () => {
    const w = mountDeliberate()
    for (let i = 0; i < 2; i++) {
      fire(w, 'pointerdown', 50, 50, { pointerType: 'touch' })
      vi.advanceTimersByTime(50)
      fire(w, 'pointerup', 50, 50, { pointerType: 'touch' })
      vi.advanceTimersByTime(100)
    }
    expect(w.emitted('select')).toEqual([['a']])
  })

  it('the folded bucket opens its list by the gesture, and is not reported', async () => {
    const members = [{ key: 'm1', label: 'M1', value: 500, color: '#111111' }, { key: 'm2', label: 'M2', value: 500, color: '#222222' }]
    const w = mountDeliberate({ slices: [SLICES[0], { key: '__b__', label: '2 smaller', value: 1000, color: '#C9C3B8', members }] })
    mouseClick(w, 150)
    await w.vm.$nextTick()
    expect(w.emitted('select')).toBeUndefined()
    expect(w.find('[data-testid="pie-members-__b__"]').exists()).toBe(true)
    // a double-click's second click does not close it again
    mouseClick(w, 150)
    await w.vm.$nextTick()
    expect(w.find('[data-testid="pie-members-__b__"]').exists()).toBe(true)
  })

  it('the list rows still pick with one click, and turning deliberate off brings back the one-click chart', async () => {
    const w = mountDeliberate()
    await w.get('[data-testid="pie-row-b"]').trigger('click')
    expect(w.emitted('select')).toEqual([['b']])
    await w.setProps({ deliberate: false })
    expect(w.find('[data-testid="pie-hint"]').exists()).toBe(false)
    w.findComponent(CanvasStub).vm.$emit('point', { index: 0, datasetIndex: 0, x: 0, y: 0 })
    mouseClick(w, 150) // the gesture is off
    expect(w.emitted('select')).toEqual([['b'], ['a']])
  })

  it('leaves room for the outside labels: padding that grows with the chart, within limits', () => {
    const c = mountDeliberate().findComponent(CanvasStub).props('config') as any
    expect(c.options.layout.padding({ chart: { width: 340 } })).toEqual({ left: 58, right: 58, top: 18, bottom: 18 })
    expect(c.options.layout.padding({ chart: { width: 520 } }).left).toBe(88)
    expect(c.options.layout.padding({ chart: { width: 200 } }).left).toBe(52) // never under 52 px
    expect(c.options.layout.padding({ chart: { width: 900 } }).left).toBe(92) // nor over 92 px
    expect(pluginOf(c, 'arcLabels')).toBeTruthy()
  })
})

describe('DrillPie is generic (ADR 0005: no one-off widgets)', () => {
  it('its source has no knowledge of what the slices are', () => {
    expect(source).not.toMatch(/budget|categor|merchant|transaction|cents|account|debt|spend/i)
  })
})

// The motion is the pie's own (a plugin that re-draws itself), so it does not depend on Chart.js's animation,
// which the site keeps off for every chart: through the real BaseChart the chart still moves its arcs for the
// first frames and ends on the true pie.
describe('DrillPie through the real BaseChart', () => {
  let getContext: typeof HTMLCanvasElement.prototype.getContext
  beforeEach(() => {
    getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
      const noop = () => undefined
      return new Proxy({ canvas: this } as Record<string, unknown>, {
        get: (t, k) => (k in t ? t[k as string] : k === 'measureText' ? () => ({ width: 10 }) : k === 'createLinearGradient' ? () => ({ addColorStop: noop }) : noop),
        set: (t, k, v) => ((t[k as string] = v), true),
      }) as unknown as CanvasRenderingContext2D
    } as unknown as typeof getContext
  })
  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = getContext
  })

  it('builds the pie with its labels and motion plugins while the global Chart.js animation stays off', () => {
    setReducedMotion(false)
    const w = mountPie({}, false)
    const chart = Chart.getChart(w.get('canvas').element as HTMLCanvasElement)!
    expect(w.findComponent(BaseChart).exists()).toBe(true)
    expect((chart.config as any)._config.plugins.map((p: any) => p.id)).toEqual(['arcLabels', 'pieMotion'])
    expect(Chart.defaults.animation).toBe(false)
  })

  it('moves the arcs during the first frame and leaves them on the true pie, drill level after drill level', () => {
    setReducedMotion(false)
    const frames: ((t: number) => void)[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => (frames.push(cb), frames.length))
    const w = mountPie({}, false)
    const chart = Chart.getChart(w.get('canvas').element as HTMLCanvasElement)!
    const arcs = chart.getDatasetMeta(0).data as unknown as { circumference: number }[]
    const final = arcs.map((a) => a.circumference)
    chart.draw()
    expect(arcs.map((a) => a.circumference)).toEqual(final) // put back after the frame
  })
})

describe('donut size helpers', () => {
  afterEach(() => window.localStorage.clear())
  it('clamps to the smallest donut and to the room', () => {
    expect(clampDonutSize(50)).toBe(DONUT_MIN)
    expect(clampDonutSize(333.4)).toBe(333)
    expect(clampDonutSize(900, 500)).toBe(500)
    expect(clampDonutSize(300, 100)).toBe(DONUT_MIN) // a room smaller than the minimum never forces a smaller donut
    expect(clampDonutSize(900, 0)).toBe(900) // no usable room figure: no upper limit
  })
  it('lays out wide only from 640 px, with room for one legend column', () => {
    expect(donutLayout(0, true)).toEqual({ wideOn: false, max: Infinity, auto: null })
    expect(donutLayout(639, true).wideOn).toBe(false)
    expect(donutLayout(900, false)).toMatchObject({ wideOn: false, max: 900, auto: null })
    const l = donutLayout(900, true)
    expect(l.wideOn).toBe(true)
    expect(l.max).toBe(900 - LEGEND_COL_PX - WIDE_GAP_PX)
    expect(l.auto).toBe(360)
    expect(donutLayout(2000, true).auto).toBe(680) // the automatic size stops growing
  })
  it('reads and writes the saved size, and never throws', () => {
    expect(readDonutSize(undefined)).toBeNull()
    expect(readDonutSize('k')).toBeNull()
    writeDonutSize('k', 411.6)
    expect(window.localStorage.getItem('k')).toBe('412')
    expect(readDonutSize('k')).toBe(412)
    writeDonutSize('k', null)
    expect(window.localStorage.getItem('k')).toBeNull()
    for (const junk of ['abc', '-5', '0', '']) {
      window.localStorage.setItem('k', junk)
      expect(readDonutSize('k')).toBeNull()
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readDonutSize('k')).toBeNull()
    expect(() => writeDonutSize('k', 300)).not.toThrow()
  })
})

describe('DrillPie size (resizable, wide, sizeKey)', () => {
  const KEY = 'test-donut'
  let roomWidth = 0
  beforeEach(() => {
    window.localStorage.clear()
    roomWidth = 0
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => roomWidth)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const px = this.style.width ? parseFloat(this.style.width) : 300
      return { width: px, height: px, top: 0, left: 0, right: px, bottom: px, x: 0, y: 0, toJSON: () => ({}) }
    })
  })
  afterEach(() => window.localStorage.clear())
  // the room is measured when the pie is mounted, and the pie redraws for it on the next tick
  const sized = async (props: Record<string, unknown>) => {
    const w = mountPie(props)
    await nextTick()
    return w
  }
  const canvas = (w: VueWrapper) => w.get('.dp-canvas')
  const sizeOf = (w: VueWrapper) => parseFloat((canvas(w).element as HTMLElement).style.width)

  it('with the props off renders as it always did: no style, no handle, no wide class, role on the canvas box', async () => {
    roomWidth = 900
    const w = await sized({ wide: false })
    expect(canvas(w).attributes('style')).toBeUndefined()
    expect(w.find('[data-testid="pie-resize"]').exists()).toBe(false)
    expect(w.classes()).not.toContain('dp-wide')
    expect(w.attributes('style')).toBeUndefined()
    expect(canvas(w).attributes('role')).toBe('img')
  })

  it('shows a labelled handle when resizable, with the chart (not the handle) carrying the image role', async () => {
    const w = await sized({ resizable: true, sizeKey: KEY })
    const h = w.get('[data-testid="pie-resize"]')
    expect(h.attributes('aria-label')).toBe('Resize chart')
    expect(h.attributes('role')).toBe('slider')
    expect(h.attributes('tabindex')).toBe('0')
    expect(canvas(w).attributes('role')).toBeUndefined()
    expect(w.findComponent(ChartStub).attributes('role')).toBe('img')
  })

  it('goes wide with an automatic size only when the room is 640 px or more', async () => {
    roomWidth = 600
    expect((await sized({ wide: true })).classes()).not.toContain('dp-wide')
    roomWidth = 900
    const w = await sized({ wide: true })
    expect(w.classes()).toContain('dp-wide')
    expect(sizeOf(w)).toBe(360)
    expect((w.element as HTMLElement).style.getPropertyValue('--dp-size')).toBe('360px')
  })

  it('steps by 16 px with the arrow keys, keeps the size, and stops at the minimum and the room', async () => {
    roomWidth = 900
    const w = await sized({ wide: true, resizable: true, sizeKey: KEY })
    const h = w.get('[data-testid="pie-resize"]')
    await h.trigger('keydown', { key: 'ArrowRight' })
    expect(sizeOf(w)).toBe(360 + DONUT_STEP)
    expect(window.localStorage.getItem(KEY)).toBe('376')
    await h.trigger('keydown', { key: 'ArrowDown' })
    expect(sizeOf(w)).toBe(360)
    for (let i = 0; i < 60; i++) await h.trigger('keydown', { key: 'ArrowLeft' })
    expect(sizeOf(w)).toBe(DONUT_MIN)
    for (let i = 0; i < 80; i++) await h.trigger('keydown', { key: 'ArrowUp' })
    expect(sizeOf(w)).toBe(900 - LEGEND_COL_PX - WIDE_GAP_PX)
  })

  it('applies a saved size, clamped to the room it has now', async () => {
    roomWidth = 900
    window.localStorage.setItem(KEY, '450')
    expect(sizeOf(await sized({ wide: true, resizable: true, sizeKey: KEY }))).toBe(450)
    window.localStorage.setItem(KEY, '5000')
    expect(sizeOf(await sized({ wide: true, resizable: true, sizeKey: KEY }))).toBe(900 - LEGEND_COL_PX - WIDE_GAP_PX)
    roomWidth = 0
    window.localStorage.setItem(KEY, '300')
    expect(sizeOf(await sized({ resizable: true, sizeKey: KEY }))).toBe(300) // not measured: used as saved
  })

  it('resets on a double-click and on Delete, forgetting the saved size', async () => {
    roomWidth = 900
    window.localStorage.setItem(KEY, '450')
    const w = await sized({ wide: true, resizable: true, sizeKey: KEY })
    await w.get('[data-testid="pie-resize"]').trigger('dblclick')
    expect(sizeOf(w)).toBe(360)
    expect(window.localStorage.getItem(KEY)).toBeNull()
    await w.get('[data-testid="pie-resize"]').trigger('keydown', { key: 'ArrowRight' })
    expect(window.localStorage.getItem(KEY)).toBe('376')
    await w.get('[data-testid="pie-resize"]').trigger('keydown', { key: 'Delete' })
    expect(window.localStorage.getItem(KEY)).toBeNull()
    expect(sizeOf(w)).toBe(360)
  })

  it('a drag of the handle changes the size and saves it when the pointer is released', async () => {
    roomWidth = 900
    const w = await sized({ wide: true, resizable: true, sizeKey: KEY })
    const h = w.get('[data-testid="pie-resize"]')
    const ev = (x: number, y: number) => ({ pointerId: 7, pointerType: 'touch', button: 0, clientX: x, clientY: y })
    await h.trigger('pointerdown', ev(100, 100))
    await h.trigger('pointermove', ev(150, 110)) // the larger movement counts: 50 px
    expect(sizeOf(w)).toBe(410)
    expect(window.localStorage.getItem(KEY)).toBeNull() // nothing is written while the finger moves
    await h.trigger('pointermove', ev(40, 90)) // back past the start: -60 px
    expect(sizeOf(w)).toBe(300)
    await h.trigger('pointerup', ev(40, 90))
    expect(window.localStorage.getItem(KEY)).toBe('300')
    await h.trigger('pointermove', ev(200, 200)) // released: no longer follows
    expect(sizeOf(w)).toBe(300)
  })

  it('a cancelled drag (pointercancel) ends like a release: the size is saved and the pointer no longer followed', async () => {
    roomWidth = 900
    const w = await sized({ wide: true, resizable: true, sizeKey: KEY })
    const h = w.get('[data-testid="pie-resize"]')
    const ev = (x: number, y: number) => ({ pointerId: 7, pointerType: 'touch', button: 0, clientX: x, clientY: y })
    await h.trigger('pointerdown', ev(100, 100))
    await h.trigger('pointermove', ev(130, 100))
    await h.trigger('pointercancel', ev(130, 100))
    expect(window.localStorage.getItem(KEY)).toBe('390')
    await h.trigger('pointermove', ev(300, 100))
    expect(sizeOf(w)).toBe(390)
  })

  describe('measuring', () => {
    let resizeAdds: number
    let resizeRemoves: number
    let observers: Array<{ observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>
    beforeEach(() => {
      resizeAdds = 0
      resizeRemoves = 0
      observers = []
      const add = window.addEventListener.bind(window)
      const remove = window.removeEventListener.bind(window)
      vi.spyOn(window, 'addEventListener').mockImplementation(((t: string, ...rest: unknown[]) => {
        if (t === 'resize') resizeAdds++
        return (add as (...a: unknown[]) => void)(t, ...rest)
      }) as typeof window.addEventListener)
      vi.spyOn(window, 'removeEventListener').mockImplementation(((t: string, ...rest: unknown[]) => {
        if (t === 'resize') resizeRemoves++
        return (remove as (...a: unknown[]) => void)(t, ...rest)
      }) as typeof window.removeEventListener)
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe = vi.fn()
          disconnect = vi.fn()
          constructor() {
            observers.push(this)
          }
        },
      )
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      vi.mocked(window.addEventListener).mockRestore()
      vi.mocked(window.removeEventListener).mockRestore()
    })

    it('a pie with the size props off holds no resize listener and no observer', async () => {
      roomWidth = 900
      const w = await sized({ wide: false })
      expect(resizeAdds).toBe(0)
      expect(observers).toHaveLength(0)
      w.unmount()
    })

    it('a resizable or wide pie attaches both, and removes both on unmount', async () => {
      roomWidth = 900
      const w = await sized({ wide: true, resizable: true, sizeKey: KEY })
      expect(resizeAdds).toBe(1)
      expect(observers).toHaveLength(1)
      expect(observers[0].observe).toHaveBeenCalledTimes(1)
      w.unmount()
      expect(resizeRemoves).toBeGreaterThanOrEqual(1)
      expect(observers[0].disconnect).toHaveBeenCalled()
    })

    it('starts and stops measuring as the props turn on and off', async () => {
      roomWidth = 900
      const w = await sized({ wide: false })
      expect(resizeAdds).toBe(0)
      await w.setProps({ wide: true })
      expect(resizeAdds).toBe(1)
      expect(w.classes()).toContain('dp-wide')
      await w.setProps({ wide: false })
      expect(resizeRemoves).toBe(1)
      expect(observers[0].disconnect).toHaveBeenCalled()
      expect(w.classes()).not.toContain('dp-wide')
      w.unmount()
    })
  })

  it('reloads the size when the key changes', async () => {
    roomWidth = 900
    window.localStorage.setItem('other', '500')
    const w = await sized({ wide: true, resizable: true, sizeKey: KEY })
    expect(sizeOf(w)).toBe(360)
    await w.setProps({ sizeKey: 'other' })
    expect(sizeOf(w)).toBe(500)
  })

  describe('legend side', () => {
    const SIDE_KEY = 'test-donut-side'
    const picker = (w: VueWrapper) => w.find('[data-testid="legend-picker"]')

    it('lays out beside the donut by default and under it for the bottom side, with a bigger room for the donut there', () => {
      expect(donutLayout(900, true, 'bottom')).toEqual({ wideOn: true, max: 900, auto: 540 })
      expect(donutLayout(900, true, 'left')).toEqual(donutLayout(900, true, 'right'))
      expect(donutLayout(2000, true, 'bottom').auto).toBe(560)
      expect(donutLayout(639, true, 'bottom').wideOn).toBe(false)
    })

    it.each(['left', 'right', 'bottom'])('the legendSide prop puts the wide layout on the %s side', async (s) => {
      roomWidth = 900
      const w = await sized({ wide: true, legendSide: s })
      expect(w.classes()).toContain(`dp-side-${s}`)
    })

    it('an unknown or missing side is the right side', async () => {
      roomWidth = 900
      expect((await sized({ wide: true })).classes()).toContain('dp-side-right')
      expect((await sized({ wide: true, legendSide: 'sideways' })).classes()).toContain('dp-side-right')
    })

    it('the side shows only in the wide layout', async () => {
      roomWidth = 600
      const w = await sized({ wide: true, legendSide: 'left', legendPicker: true })
      expect(w.classes().some((c) => c.startsWith('dp-side-'))).toBe(false)
      expect(picker(w).exists()).toBe(false)
    })

    it('offers the picker only when asked for and wide, marks the side in use, and emits the side pressed', async () => {
      roomWidth = 900
      expect(picker(await sized({ wide: true })).exists()).toBe(false) // not asked for
      expect(picker(await sized({ legendPicker: true })).exists()).toBe(false) // not wide
      const w = await sized({ wide: true, legendPicker: true, legendSide: 'left' })
      expect(picker(w).exists()).toBe(true)
      expect(w.get('[data-testid="legend-side-left"]').attributes('aria-pressed')).toBe('true')
      expect(w.get('[data-testid="legend-side-right"]').attributes('aria-pressed')).toBe('false')
      await w.get('[data-testid="legend-side-bottom"]').trigger('click')
      expect(w.emitted('update:legendSide')).toEqual([['bottom']])
      await w.setProps({ legendSide: 'bottom' })
      expect(w.classes()).toContain('dp-side-bottom')
      expect(w.get('[data-testid="legend-side-bottom"]').attributes('aria-pressed')).toBe('true')
    })

    it('a pie without the new props is unchanged: no picker, nothing on the page', async () => {
      roomWidth = 900
      const w = await sized({ wide: true, resizable: true, sizeKey: SIDE_KEY })
      expect(picker(w).exists()).toBe(false)
      expect(w.classes()).toContain('dp-side-right')
    })

    it('a pie whose own box has no size (display: contents in a parent grid) never takes the wide layout', async () => {
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('drill-pie') ? 0 : 900
      })
      const w = await sized({ wide: true, legendPicker: true, legendSide: 'left' })
      expect(w.classes()).not.toContain('dp-wide')
      expect(picker(w).exists()).toBe(false)
    })

    it('starts centred: a pie that is not wide grows twice the pointer movement, and the canvas is centred in the source', async () => {
      const w = await sized({ resizable: true, sizeKey: SIDE_KEY })
      const h = w.get('[data-testid="pie-resize"]')
      const ev = (x: number) => ({ pointerId: 3, pointerType: 'mouse', button: 0, clientX: x, clientY: 0 })
      await h.trigger('pointerdown', ev(100))
      await h.trigger('pointermove', ev(150))
      expect(sizeOf(w)).toBe(400) // 300 + 2 * 50
      await h.trigger('pointerup', ev(150))
      expect(source).toMatch(/\.dp-canvas\s*\{[^}]*justify-self:\s*center/)
    })
  })

  describe('shared size (two pies, one sizeKey)', () => {
    it('resize together while one is dragged, reset together, and a pie that appears later takes the saved size', async () => {
      roomWidth = 900
      const props = { wide: true, resizable: true, sizeKey: 'test-shared-a' }
      const a = await sized(props)
      const b = await sized(props)
      expect(sizeOf(a)).toBe(360)
      expect(sizeOf(b)).toBe(360)
      const h = a.get('[data-testid="pie-resize"]')
      const ev = (x: number) => ({ pointerId: 5, pointerType: 'mouse', button: 0, clientX: x, clientY: 0 })
      await h.trigger('pointerdown', ev(100))
      await h.trigger('pointermove', ev(150))
      await nextTick()
      expect(sizeOf(a)).toBe(410)
      expect(sizeOf(b)).toBe(410) // live, before the pointer is released
      await h.trigger('pointerup', ev(150))
      expect(window.localStorage.getItem('test-shared-a')).toBe('410')
      expect(sizeOf(await sized(props))).toBe(410)
      await a.get('[data-testid="pie-resize"]').trigger('dblclick')
      await nextTick()
      expect(sizeOf(a)).toBe(360)
      expect(sizeOf(b)).toBe(360)
    })

    it('a different key stays independent', async () => {
      roomWidth = 900
      const a = await sized({ wide: true, resizable: true, sizeKey: 'test-shared-b1' })
      const b = await sized({ wide: true, resizable: true, sizeKey: 'test-shared-b2' })
      await a.get('[data-testid="pie-resize"]').trigger('keydown', { key: 'ArrowRight' })
      await nextTick()
      expect(sizeOf(a)).toBe(376)
      expect(sizeOf(b)).toBe(360)
    })
  })

  describe('a drag does not select page text', () => {
    const ev = (x: number, type = 'mouse') => ({ pointerId: 9, pointerType: type, button: 0, clientX: x, clientY: 0 })
    const selectStart = () => {
      const e = new Event('selectstart', { cancelable: true })
      document.dispatchEvent(e)
      return e.defaultPrevented
    }
    const held = async () => {
      roomWidth = 900
      const w = await sized({ wide: true, resizable: true, sizeKey: 'test-select' })
      const h = w.get('[data-testid="pie-resize"]')
      expect(document.body.style.userSelect).not.toBe('none') // nothing is locked before the press
      await h.trigger('pointerdown', ev(100))
      return { w, h }
    }

    it('locks selection while the handle is held and puts it back on release', async () => {
      document.body.style.userSelect = 'text'
      const { h } = await held()
      expect(document.body.style.userSelect).toBe('none')
      expect(selectStart()).toBe(true)
      await h.trigger('pointermove', ev(130))
      expect(document.body.style.userSelect).toBe('none')
      await h.trigger('pointerup', ev(130))
      expect(document.body.style.userSelect).toBe('text')
      expect(selectStart()).toBe(false)
      document.body.style.userSelect = ''
    })

    it('puts it back on pointercancel', async () => {
      const { h } = await held()
      expect(document.body.style.userSelect).toBe('none')
      await h.trigger('pointercancel', ev(100))
      expect(document.body.style.userSelect).toBe('')
      expect(selectStart()).toBe(false)
    })

    it('puts it back when the pie goes away mid-drag', async () => {
      const { w } = await held()
      expect(document.body.style.userSelect).toBe('none')
      w.unmount()
      mounted.splice(mounted.indexOf(w), 1)
      expect(document.body.style.userSelect).toBe('')
      expect(selectStart()).toBe(false)
    })

    it('a pointer that is not the dragging one does not unlock', async () => {
      const { h } = await held()
      await h.trigger('pointerup', { ...ev(100), pointerId: 99 })
      expect(document.body.style.userSelect).toBe('none')
      await h.trigger('pointerup', ev(100))
      expect(document.body.style.userSelect).toBe('')
    })

    it('puts it back when pointer capture is lost, and keeps the size reached', async () => {
      const { h } = await held()
      await h.trigger('pointermove', ev(130))
      await h.trigger('lostpointercapture', ev(130))
      expect(document.body.style.userSelect).toBe('')
      expect(selectStart()).toBe(false)
      expect(window.localStorage.getItem('test-select')).toBe('390')
    })

    it('puts it back when the window loses focus mid-drag', async () => {
      const { h } = await held()
      window.dispatchEvent(new Event('blur'))
      expect(document.body.style.userSelect).toBe('')
      expect(selectStart()).toBe(false)
      await h.trigger('pointermove', ev(300)) // the drag is over: no longer followed
      expect(document.body.style.userSelect).toBe('')
    })

    it('puts it back when the page is hidden mid-drag, but not when it becomes visible', async () => {
      const state = vi.spyOn(document, 'visibilityState', 'get')
      state.mockReturnValue('visible')
      await held()
      document.dispatchEvent(new Event('visibilitychange'))
      expect(document.body.style.userSelect).toBe('none')
      state.mockReturnValue('hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      expect(document.body.style.userSelect).toBe('')
      expect(selectStart()).toBe(false)
    })

    it('removes its blur and visibility listeners when the drag ends', async () => {
      const add = vi.spyOn(window, 'addEventListener')
      const remove = vi.spyOn(window, 'removeEventListener')
      const { h } = await held()
      const blurAdded = add.mock.calls.filter((c) => c[0] === 'blur').length
      expect(blurAdded).toBe(1)
      await h.trigger('pointerup', ev(100))
      expect(remove.mock.calls.filter((c) => c[0] === 'blur')).toHaveLength(1)
    })

    describe('two pies held at once', () => {
      const evOn = (id: number) => ({ pointerId: id, pointerType: 'touch', button: 0, clientX: 100, clientY: 0 })
      const two = async () => {
        roomWidth = 900
        const a = await sized({ wide: true, resizable: true, sizeKey: 'test-two-a' })
        const b = await sized({ wide: true, resizable: true, sizeKey: 'test-two-b' })
        return { ha: a.get('[data-testid="pie-resize"]'), hb: b.get('[data-testid="pie-resize"]') }
      }
      it.each([
        ['first pressed, first released', 'a', 'b'],
        ['first pressed, last released', 'b', 'a'],
      ])('the page text lock comes back to what it was after both let go (%s)', async (_n, firstOff, lastOff) => {
        document.body.style.userSelect = 'text'
        const { ha, hb } = await two()
        await ha.trigger('pointerdown', evOn(1))
        await hb.trigger('pointerdown', evOn(2))
        expect(document.body.style.userSelect).toBe('none')
        const up = (which: string) => (which === 'a' ? ha.trigger('pointerup', evOn(1)) : hb.trigger('pointerup', evOn(2)))
        await up(firstOff)
        expect(document.body.style.userSelect).toBe('none') // the other is still held
        expect(selectStart()).toBe(true)
        await up(lastOff)
        expect(document.body.style.userSelect).toBe('text')
        expect(selectStart()).toBe(false)
        document.body.style.userSelect = ''
      })
      it('one pie going away mid-drag does not release the other one', async () => {
        const { ha, hb } = await two()
        await ha.trigger('pointerdown', evOn(1))
        await hb.trigger('pointerdown', evOn(2))
        const first = mounted[mounted.length - 2]
        first.unmount()
        mounted.splice(mounted.indexOf(first), 1)
        expect(document.body.style.userSelect).toBe('none')
        await hb.trigger('pointerup', evOn(2))
        expect(document.body.style.userSelect).toBe('')
      })
    })

    it('the module lock counts its holders and restores the page value once', () => {
      document.body.style.userSelect = 'text'
      expect(holdSelectionLock()).toBe(true)
      expect(holdSelectionLock()).toBe(true) // the second holder sees "none" but must not save it
      releaseSelectionLock()
      expect(document.body.style.userSelect).toBe('none')
      releaseSelectionLock()
      expect(document.body.style.userSelect).toBe('text')
      releaseSelectionLock() // an extra release is harmless
      expect(document.body.style.userSelect).toBe('text')
      document.body.style.userSelect = ''
    })
  })

  describe('the donut diameter while dragging', () => {
    it('maps the handle movement to the diameter: one to one beside the legend, twice when centred', () => {
      expect(dragDiameter(400, 50, true)).toBe(450)
      expect(dragDiameter(400, -50, true)).toBe(350)
      expect(dragDiameter(400, 50, false)).toBe(500)
      expect(dragDiameter(400, 0, false)).toBe(400) // no movement: no change
    })

    it('starts from the diameter the donut shows (its shorter side), so the first movement does not jump', async () => {
      // a box wider than tall (520 x 372) as the stylesheet used to make it: the drag starts from 372, not 520
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const w = this.style.width ? parseFloat(this.style.width) : 520
        const h = this.style.height ? parseFloat(this.style.height) : 372
        return { width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) }
      })
      const w = await sized({ resizable: true, sizeKey: 'test-diam' })
      const h = w.get('[data-testid="pie-resize"]')
      const ev = (x: number) => ({ pointerId: 4, pointerType: 'mouse', button: 0, clientX: x, clientY: 0 })
      await h.trigger('pointerdown', ev(100))
      await h.trigger('pointermove', ev(110))
      expect(sizeOf(w)).toBe(372 + 2 * 10) // not 520 + 20
      await h.trigger('pointermove', ev(220))
      expect(sizeOf(w)).toBe(372 + 2 * 120)
      await h.trigger('pointerup', ev(220))
    })

    it('grows in proportion to the movement, with no jump between steps, and both pies of one key follow', async () => {
      roomWidth = 1000
      const props = { resizable: true, sizeKey: 'test-diam-both' }
      const a = await sized(props)
      const b = await sized(props)
      const h = a.get('[data-testid="pie-resize"]')
      const ev = (x: number) => ({ pointerId: 6, pointerType: 'mouse', button: 0, clientX: x, clientY: 0 })
      await h.trigger('pointerdown', ev(0))
      let last = 300
      for (const x of [10, 20, 40, 80, 120]) {
        await h.trigger('pointermove', ev(x))
        await nextTick()
        expect(sizeOf(a)).toBe(300 + 2 * x)
        expect(sizeOf(b)).toBe(sizeOf(a))
        expect(sizeOf(a) - last).toBeLessThanOrEqual(2 * 40)
        last = sizeOf(a)
      }
      await h.trigger('pointerup', ev(120))
    })
  })

  describe('legend columns', () => {
    it('fit as many 300 px columns as the room has, at least one, never more than the slices', () => {
      expect(legendColumns(2000, 3)).toBe(3)
      expect(legendColumns(2000, 20)).toBe(6)
      expect(legendColumns(700, 9)).toBe(2)
      expect(legendColumns(100, 4)).toBe(1)
      expect(legendColumns(2000, 0)).toBe(1)
      expect(legendColumns(LEGEND_COL_PX, 5)).toBe(1)
      expect(legendColumns(2 * LEGEND_COL_PX + 24, 5)).toBe(2)
    })

    it('hands the column count to the stylesheet only for a pie that manages its size', async () => {
      roomWidth = 2000
      const w = await sized({ wide: true, resizable: true, sizeKey: 'test-cols' })
      expect((w.element as HTMLElement).style.getPropertyValue('--dp-cols')).toBe('3') // 3 drawn slices
      expect(w.classes()).toContain('dp-managed')
      const plain = await sized({})
      expect((plain.element as HTMLElement).style.getPropertyValue('--dp-cols')).toBe('')
      expect(plain.classes()).not.toContain('dp-managed')
    })

    it('are centred and sized to their content: at most 360 px, with the donut and legend 48 px apart', () => {
      expect(source).toMatch(/\.dp-managed \.dp-list\s*\{[^}]*repeat\(var\(--dp-cols, 1\), minmax\(0, 360px\)\)[^}]*justify-content:\s*center/)
      expect(source).toMatch(/\.drill-pie\.dp-wide\s*\{[^}]*column-gap:\s*48px[^}]*justify-content:\s*center/)
      expect(WIDE_GAP_PX).toBe(48)
    })

    it('a pie mounted in a hidden pane goes wide and shows the picker once it becomes visible, with no resize', async () => {
      let hidden = true
      const callbacks: Array<() => void> = []
      const seen: Element[] = []
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: () => void) {
            callbacks.push(cb)
          }
          observe = (el: Element) => void seen.push(el)
          unobserve = () => {}
          disconnect = () => {}
        },
      )
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('drill-pie') && hidden ? 0 : 900
      })
      const w = await sized({ wide: true, legendPicker: true })
      expect(w.classes()).not.toContain('dp-wide') // measured while hidden: no room of its own
      expect(w.find('[data-testid="legend-picker"]').exists()).toBe(false)
      expect(seen).toContain(w.element) // its own box is watched, not only an ancestor
      hidden = false
      callbacks.forEach((cb) => cb()) // the pane became visible: the box went from no size to a size
      await nextTick()
      expect(w.classes()).toContain('dp-wide')
      expect(w.find('[data-testid="legend-picker"]').exists()).toBe(true)
      vi.unstubAllGlobals()
    })
  })
})

describe('DrillPie legend columns', () => {
  it('goes to two columns by a container query on the pie box, so it applies only where the legend stacks under the pie', () => {
    expect(source).toMatch(/container-type:\s*inline-size/)
    expect(source).toMatch(/@container \(min-width: 560px\)\s*\{\s*\.dp-list\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/)
  })
})
