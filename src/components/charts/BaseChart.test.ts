// @vitest-environment happy-dom
// BaseChart keeps Chart.js animation off globally (snappy dashboard, immediate first paint); a chart that sets its
// own `options.animation` opts in. Chart.js only copies the keys of the GLOBAL animation default into its
// per-property settings, so without the opt-in swap a per-chart object never animates (checked with animator.has).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { Chart, animator, type ChartConfiguration } from 'chart.js'
import BaseChart from './BaseChart.vue'

function fakeCtx(canvas: HTMLCanvasElement) {
  const noop = () => undefined
  return new Proxy({ canvas } as Record<string, unknown>, {
    get: (t, k) =>
      k in t ? t[k as string] : k === 'measureText' ? () => ({ width: 10 }) : k === 'createLinearGradient' ? () => ({ addColorStop: noop }) : noop,
    set: (t, k, v) => {
      t[k as string] = v
      return true
    },
  })
}

function config(animation?: unknown): ChartConfiguration {
  const options: Record<string, unknown> = { responsive: false }
  if (animation !== undefined) options.animation = animation
  return { type: 'doughnut', data: { labels: ['a', 'b'], datasets: [{ data: [1, 2] }] }, options } as ChartConfiguration
}

const mounted: VueWrapper[] = []
function mountChart(cfg: ChartConfiguration) {
  const w = mount(BaseChart, { props: { config: cfg, drillOpen: false }, attachTo: document.body })
  mounted.push(w)
  const canvas = w.get('canvas').element as HTMLCanvasElement
  return { w, chart: Chart.getChart(canvas) }
}

let getContext: typeof HTMLCanvasElement.prototype.getContext
beforeEach(() => {
  getContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    return fakeCtx(this) as unknown as CanvasRenderingContext2D
  } as unknown as typeof getContext
})
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  HTMLCanvasElement.prototype.getContext = getContext
  vi.restoreAllMocks()
})

describe('BaseChart animation opt-in', () => {
  it('a chart with no animation option does not animate (as before)', () => {
    const { chart } = mountChart(config())
    expect(chart).toBeTruthy()
    expect(animator.has(chart as never)).toBe(false)
    expect(Chart.defaults.animation).toBe(false)
  })

  it('animation: false stays off', () => {
    const { chart } = mountChart(config(false))
    expect(animator.has(chart as never)).toBe(false)
    expect((chart as unknown as { _animationsDisabled: boolean })._animationsDisabled).toBe(true)
    expect(Chart.defaults.animation).toBe(false)
  })

  it('a per-chart animation object animates, and the global default is off again afterwards', () => {
    const { chart } = mountChart(config({ duration: 450, easing: 'easeOutQuart', animateRotate: true, animateScale: true }))
    expect(animator.has(chart as never)).toBe(true)
    expect(Chart.defaults.animation).toBe(false)
    // another chart built afterwards, without the option, is still off
    const other = mountChart(config())
    expect(animator.has(other.chart as never)).toBe(false)
  })

  it('the global default is off again even when the constructor throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const bad = { ...config({ duration: 450 }), type: 'not-a-chart-type' } as unknown as ChartConfiguration
    try {
      mountChart(bad)
    } catch {
      // Vue may rethrow the error from the mounted hook; either way the default must be restored
    }
    expect(Chart.defaults.animation).toBe(false)
  })
})
