// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { Chart, animator } from 'chart.js'
import { defineComponent } from 'vue'
import BaseChart from './BaseChart.vue'
import DrillPie, { ANIMATION_ON, type PieSlice } from './DrillPie.vue'
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

  it('animates in with the per-chart option BaseChart opts in on; animate=false turns it off', () => {
    expect(configOf(mountPie()).options.animation).toEqual({ duration: 450, easing: 'easeOutQuart', animateRotate: true, animateScale: true })
    expect(configOf(mountPie()).options.animation).toEqual(ANIMATION_ON)
    expect(configOf(mountPie({ animate: false })).options.animation).toBe(false)
  })

  it('prefers-reduced-motion turns the animation off', () => {
    setReducedMotion(true)
    expect(configOf(mountPie()).options.animation).toBe(false)
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

describe('DrillPie is generic (ADR 0005: no one-off widgets)', () => {
  it('its source has no knowledge of what the slices are', () => {
    expect(source).not.toMatch(/budget|categor|merchant|transaction|cents|account|debt|spend/i)
  })
})

// The point of the opt-in: with the site's global "animation off", the per-chart option must still animate
// when the real BaseChart builds the real Chart.js chart (and must not when motion is reduced).
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

  it('the sweep runs by default and not under reduced motion; the global default stays off', () => {
    setReducedMotion(false)
    const w = mountPie({}, false)
    const chart = Chart.getChart(w.get('canvas').element as HTMLCanvasElement)!
    expect(w.findComponent(BaseChart).exists()).toBe(true)
    expect(animator.has(chart as never)).toBe(true)
    expect(Chart.defaults.animation).toBe(false)

    setReducedMotion(true)
    const calm = mountPie({}, false)
    const calmChart = Chart.getChart(calm.get('canvas').element as HTMLCanvasElement)!
    expect(animator.has(calmChart as never)).toBe(false)
  })
})
