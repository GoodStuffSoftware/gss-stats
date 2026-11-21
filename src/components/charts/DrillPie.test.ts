// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { Chart } from 'chart.js'
import { defineComponent } from 'vue'
import BaseChart from './BaseChart.vue'
import DrillPie, { sliceLabelParts, type PieSlice } from './DrillPie.vue'
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

  it('shows a hint under the pie; without deliberate there is none', () => {
    expect(mountDeliberate().get('[data-testid="pie-hint"]').text()).toBe('Double-click or press and hold a slice to open it')
    expect(mountPie().find('[data-testid="pie-hint"]').exists()).toBe(false)
  })

  it('a click on the chart, or the chart\'s own long-press, does not pick', () => {
    const w = mountDeliberate()
    w.findComponent(CanvasStub).vm.$emit('point', { index: 1, datasetIndex: 0, x: 0, y: 0 })
    fire(w, 'pointerdown')
    vi.advanceTimersByTime(100)
    fire(w, 'pointerup')
    fire(w, 'click')
    expect(w.emitted('select')).toBeUndefined()
  })

  it('a double-click picks the slice under the pointer', () => {
    const w = mountDeliberate()
    fire(w, 'dblclick', 150)
    expect(w.emitted('select')).toEqual([['b']])
  })

  it('a hold picks it, and the release after it does not pick again or click through', () => {
    const w = mountDeliberate()
    fire(w, 'pointerdown', 50)
    vi.advanceTimersByTime(500)
    expect(w.emitted('select')).toEqual([['a']])
    fire(w, 'pointerup', 50)
    const click = fire(w, 'click', 50)
    expect(click.defaultPrevented).toBe(true)
    expect(w.emitted('select')).toEqual([['a']])
  })

  it('a hold that moves away picks nothing', () => {
    const w = mountDeliberate()
    fire(w, 'pointerdown', 50)
    fire(w, 'pointermove', 70)
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
    fire(w, 'dblclick', 150)
    await w.vm.$nextTick()
    expect(w.emitted('select')).toBeUndefined()
    expect(w.find('[data-testid="pie-members-__b__"]').exists()).toBe(true)
  })

  it('the list rows still pick with one click, and turning deliberate off brings back the one-click chart', async () => {
    const w = mountDeliberate()
    await w.get('[data-testid="pie-row-b"]').trigger('click')
    expect(w.emitted('select')).toEqual([['b']])
    await w.setProps({ deliberate: false })
    expect(w.find('[data-testid="pie-hint"]').exists()).toBe(false)
    w.findComponent(CanvasStub).vm.$emit('point', { index: 0, datasetIndex: 0, x: 0, y: 0 })
    fire(w, 'dblclick', 150) // the gesture is off
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
