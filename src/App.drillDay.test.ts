// @vitest-environment happy-dom
//
// A drill on a day bucket opens a page for that DAY as an absolute range (App.openFilteredPage):
// the UTC day for a `date` chart, the ET day (ET midnight to 1 ms before the next ET midnight) for a
// `dateEt` chart, with no relative window and no drill constraint. The footer then names that one
// day. DST days are 23 h / 25 h long and read the same.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import App from './App.vue'
import { stubAppFetch } from './testing/appFetch'
import Dashboard from './components/Dashboard.vue'
import { saveConfig, loadConfig } from './api'
import { VIEWER_PREFS_KEY } from './lib/viewerPrefs'
import { etDayRangeToISO } from './lib/range'
import PROD_V9 from './lib/__fixtures__/prodLayout.v9.json'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return {
    ...actual,
    loadConfig: vi.fn(async () => null),
    saveConfig: vi.fn(async () => true),
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

beforeEach(() => {
  stubAppFetch()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  localStorage.clear()
  vi.mocked(saveConfig).mockClear()
  const stored: any = JSON.parse(JSON.stringify(PROD_V9))
  stored.version = 12
  vi.mocked(loadConfig).mockImplementation(async () => stored)
  localStorage.setItem(VIEWER_PREFS_KEY, JSON.stringify({ active: 'bsk-launch' }))
})
afterEach(() => {
  vi.useRealTimers()
})

/** Drill on a day bucket of `dimension` and open it as a page; returns that page as saved, and the footer text. */
async function drillDay(dimension: string, value: string) {
  // the label is what the chart shows for the bucket (ChartCard: formatKey), e.g. 'Mar 8'
  const label = new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const w = mount(App, { attachTo: document.body })
  await flushPromises()
  w.findComponent(Dashboard).vm.$emit('drill', { widgetId: 'bsk-trend', dimension, dataset: 'geo', value, label, x: 10, y: 10 })
  await flushPromises()
  ;(document.querySelector('.drill-act') as HTMLButtonElement).click()
  await flushPromises()
  await vi.advanceTimersByTimeAsync(800)
  await flushPromises()
  const saved = vi.mocked(saveConfig).mock.calls.at(-1)![0]
  const page = saved.pages.find((p) => p.parentId === 'bsk-launch')!
  const footer = w.find('.foot').text() as string
  w.unmount()
  return { page, footer }
}

describe('App — opening a day bucket as a page', () => {
  it('a dateEt bucket opens that ET day: ET midnight to the next ET midnight, absolute, no drill constraint', async () => {
    const { page } = await drillDay('dateEt', '2026-06-15')
    expect(page.filters.since).toBe('2026-06-15T04:00:00.000Z')
    expect(page.filters.until).toBe('2026-06-16T03:59:59.999Z')
    expect(page.filters.rangeRel).toBe('')
    expect(page.filters.drill ?? []).toEqual([])
  })
  it('a date bucket still opens that UTC day', async () => {
    const { page } = await drillDay('date', '2026-06-15')
    expect(page.filters.since).toBe('2026-06-15T00:00:00.000Z')
    expect(page.filters.until).toBe('2026-06-15T23:59:59.999Z')
    expect(page.filters.rangeRel).toBe('')
  })
  it.each([
    ['2026-03-08', 'Mar 8'],
    ['2026-11-01', 'Nov 1'],
  ])('the DST day %s is its own 23 h / 25 h ET day, and the footer names that one day', async (day, name) => {
    const { page, footer } = await drillDay('dateEt', day)
    expect(page.filters).toMatchObject({ ...etDayRangeToISO(day), rangeRel: '' })
    expect(page.name).toBe(name)
    expect(footer.split(' · ').at(-1)).toBe(name) // not "Mar 8 – Mar 9" / "Nov 1 – Nov 2"
  })
})
