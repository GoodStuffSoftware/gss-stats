// @vitest-environment happy-dom
//
// A click on a day point of a date chart hands the app a drill for that day: 'date' (UTC day) and
// 'dateEt' (ET day, the default trend charts' axis) are both let through by ChartCard.onPoint even
// though neither is a semantic drill key (lib/drill.ts); App.openFilteredPage then turns the day into
// a range (App.drillDay.test.ts). A dimension that isn't drillable still emits nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import ChartCard from './ChartCard.vue'
import { sitesLoaded } from '../sitesStore'
import { etDayRangeToISO } from '../lib/range'
import type { GlobalFilters, StatsResponse, Widget } from '../types'

const fetchStatsMock = vi.hoisted(() => vi.fn())
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, fetchStats: fetchStatsMock }
})

beforeEach(() => {
  sitesLoaded.value = true
  fetchStatsMock.mockReset()
})

const widget = (dimension: string): Widget => ({
  id: 'w1',
  i: 'w1',
  title: 'Pageviews over time',
  type: 'area',
  dataset: 'geo',
  dimension,
  metric: 'pageviews',
  limit: 90,
  x: 0,
  y: 0,
  w: 9,
  h: 8,
})

// One plotted day: the range is exactly that ET day, so the axis has one point and point 0 is it.
const DAY = '2026-03-08'
const range = etDayRangeToISO(DAY)
const filters: GlobalFilters = { siteSel: [], since: range.since, until: range.until, excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }

function response(dimension: string, key: string): StatsResponse {
  return {
    rows: [{ key: { [dimension]: key }, pageviews: 5, visits: 5 }],
    totals: { pageviews: 5, visits: 5 },
    meta: { site: 'all', host: null, since: range.since, until: range.until, dimensions: [dimension], metric: 'pageviews' },
  } as StatsResponse
}

/** Mount a card on `dimension`, click its first point, and return what the card emitted as a drill. */
async function clickFirstPoint(dimension: string, key: string) {
  fetchStatsMock.mockImplementation(async () => response(dimension, key))
  const Stub = defineComponent({ props: ['config'], emits: ['point'], methods: { suppressForDrill() {} }, template: '<div class="chart-stub" />' })
  const w = mount(ChartCard, {
    props: { widget: widget(dimension), filters, dark: false, drillOpen: false },
    global: { stubs: { BaseChart: Stub } },
  })
  await flushPromises()
  w.findComponent(Stub).vm.$emit('point', { index: 0, datasetIndex: 0, x: 10, y: 20 })
  await flushPromises()
  return w.emitted('drill')
}

describe('ChartCard — a click on a day point emits a drill', () => {
  it('a dateEt point drills with the ET day as its value', async () => {
    expect(await clickFirstPoint('dateEt', DAY)).toEqual([
      [{ widgetId: 'w1', dimension: 'dateEt', dataset: 'geo', value: DAY, label: 'Mar 8', x: 10, y: 20 }],
    ])
  })
  it('a date point drills with the UTC day as its value', async () => {
    expect(await clickFirstPoint('date', DAY)).toEqual([
      [{ widgetId: 'w1', dimension: 'date', dataset: 'geo', value: DAY, label: 'Mar 8', x: 10, y: 20 }],
    ])
  })
  it('a dimension that is not drillable emits nothing, so its tooltip stays up', async () => {
    expect(await clickFirstPoint('notADimension', 'x')).toBeUndefined()
  })
})
