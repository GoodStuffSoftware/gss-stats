// @vitest-environment happy-dom
//
// The day selector on a card with `dayPicker` (the Today at a glance KPI tiles): previous / next
// arrows and a date pick, today by default with "next" disabled. A past day reads that ET day (the
// POST carries `context.day`), shows no "Updated Ns ago", and a live push never refetches it; a
// choice of today is the live card again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { __resetReturnRefreshForTests, emitLiveChange, RETURN_MIN_AGE_MS } from '../../composables/useReturnRefresh'
import { PRESETS } from '../../lib/metrics/presets'
import { MAX_DAY_LOOKBACK_DAYS } from '../../lib/metrics/validate'
import type { MetricsRequestBody } from '../../lib/metrics/types'

const NOW = Date.parse('2026-10-06T15:00:00Z') // Tue 2026-10-06, 11:00 ET
const TODAY = '2026-10-06'
const bodies: MetricsRequestBody[] = []
let wrapper: VueWrapper | null = null

beforeEach(() => {
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  bodies.length = 0
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  vi.useFakeTimers({ now: NOW })
  // The server's side of the contract: today's values are liveSafe, a chosen past day's never are.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as MetricsRequestBody
      bodies.push(body)
      const live = body.context?.day === undefined
      const results = Object.fromEntries(body.requests.map((r) => [r.key, { status: 'ok', value: 42, ...(live ? { liveSafe: true } : {}) }]))
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
    }),
  )
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function settle() {
  await vi.advanceTimersByTimeAsync(50)
  await flushPromises()
  await vi.advanceTimersByTimeAsync(50)
  await flushPromises()
}
async function mountCard() {
  wrapper = mount(MetricCard, { props: { cardRef: { preset: 'bsk-kpis' } } })
  await settle()
  return wrapper
}
const prev = () => wrapper!.find('button[aria-label="Previous day"]')
const next = () => wrapper!.find('button[aria-label="Next day"]')
const input = () => wrapper!.find('input[type="date"]')
const pick = async (day: string) => {
  await input().setValue(day)
  await settle()
}
const lastBody = () => bodies[bodies.length - 1]

describe('MetricCard day selector', () => {
  it('starts on today: the live read, "next" disabled, no day sent, "Updated" shown', async () => {
    await mountCard()
    expect((input().element as HTMLInputElement).value).toBe(TODAY)
    expect((input().element as HTMLInputElement).max).toBe(TODAY)
    expect(next().attributes('disabled')).toBeDefined()
    expect(prev().attributes('disabled')).toBeUndefined()
    expect(wrapper!.text()).not.toContain('Today\u00a0') // no "Today" reset link while on today
    expect(wrapper!.findAll('button').some((b) => b.text() === 'Today')).toBe(false)
    expect(bodies).toHaveLength(1)
    expect(bodies[0].context?.day).toBeUndefined()
    expect(wrapper!.find('.mc-updated').exists()).toBe(true)
  })

  it('previous day: reads the day before (context.day), no "Updated Ns ago", and reports the day', async () => {
    await mountCard()
    await prev().trigger('click')
    await settle()
    expect(lastBody().context?.day).toBe('2026-10-05')
    expect(lastBody().requests.some((r) => r.window === 'todaySoFar')).toBe(true)
    expect(wrapper!.find('.mc-updated').exists()).toBe(false)
    expect(wrapper!.find('button.mc-reload').exists()).toBe(true) // still reloadable
    expect(next().attributes('disabled')).toBeUndefined()
    expect((input().element as HTMLInputElement).value).toBe('2026-10-05')
    expect(wrapper!.emitted('day-change')).toEqual([['2026-10-05']])
  })

  it('next from a past day walks forward, and onto today is the live card again', async () => {
    await mountCard()
    await pick('2026-10-04')
    await next().trigger('click')
    await settle()
    expect(lastBody().context?.day).toBe('2026-10-05')
    await next().trigger('click')
    await settle()
    expect(lastBody().context?.day).toBeUndefined()
    expect(next().attributes('disabled')).toBeDefined()
    expect(wrapper!.find('.mc-updated').exists()).toBe(true)
    expect(wrapper!.emitted('day-change')!.map((e) => e[0])).toEqual(['2026-10-04', '2026-10-05', null])
  })

  it('a picked date is read, today (the "Today" link, or picking today) goes back to live', async () => {
    await mountCard()
    await pick('2026-10-01')
    expect(lastBody().context?.day).toBe('2026-10-01')
    const todayBtn = wrapper!.findAll('button').find((b) => b.text() === 'Today')!
    await todayBtn.trigger('click')
    await settle()
    expect(lastBody().context?.day).toBeUndefined()
    await pick('2026-09-30')
    await pick(TODAY)
    expect(lastBody().context?.day).toBeUndefined()
  })

  it('stops at the floor: "previous" disabled there, a date before it is clamped', async () => {
    await mountCard()
    const floor = '2026-07-08' // MAX_DAY_LOOKBACK_DAYS before 2026-10-06
    expect(MAX_DAY_LOOKBACK_DAYS).toBe(90)
    expect((input().element as HTMLInputElement).min).toBe(floor)
    await pick('2026-06-01')
    expect(lastBody().context?.day).toBe(floor)
    expect(prev().attributes('disabled')).toBeDefined()
  })

  it('a past day is not refetched by a live push; today is', async () => {
    await mountCard()
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    emitLiveChange()
    await settle()
    expect(bodies).toHaveLength(2) // the first load, then the push refetch of today
    expect(lastBody().context?.day).toBeUndefined()

    await prev().trigger('click')
    await settle()
    const n = bodies.length
    await vi.advanceTimersByTimeAsync(RETURN_MIN_AGE_MS + 1000)
    emitLiveChange()
    await settle()
    expect(bodies).toHaveLength(n)
  })

  it('a card without the flag has no selector', async () => {
    const plain = Object.values(PRESETS).find((p) => !p.dayPicker && !p.repeat)!
    wrapper = mount(MetricCard, { props: { cardRef: { spec: plain } } })
    await settle()
    expect(wrapper.find('.mc-day').exists()).toBe(false)
  })
})
