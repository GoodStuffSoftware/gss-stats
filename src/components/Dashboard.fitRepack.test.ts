// @vitest-environment happy-dom
//
// A fit-to-content card pushes the cards below it down (and pulls them back up when it shrinks):
// grid-layout-plus only compacts when its layout array changes, not when one item's `h` does, so
// Dashboard asks the grid to compact after it sets a fitted height. The real GridLayout is mounted;
// ChartCard is a stub that reports a content height, which is all the Dashboard listens for.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, nextTick, reactive } from 'vue'
import Dashboard from './Dashboard.vue'
import { fitRows } from '../lib/fit'
import type { GlobalFilters, Widget } from '../types'

let wrapper: VueWrapper | null = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
})

const filters: GlobalFilters = {
  siteSel: [], since: '2026-09-01', until: '2026-09-30',
  excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '',
}
const card = (id: string, y: number, h: number, fit = false): Widget => ({
  id, i: id, title: id, type: 'note', dimension: '', metric: 'pageviews', limit: 10, x: 0, y, w: 12, h,
  card: { preset: 'x' }, ...(fit ? { fit: 'content' as const } : {}),
}) as unknown as Widget

// Each stub reports its widget's content height when asked, through the same `fit-height` emit.
const reporters = new Map<string, (px: number) => void>()
const StubCard = defineComponent({
  props: { widget: { type: Object, required: true } },
  emits: ['fit-height'],
  setup(props, { emit }) {
    reporters.set((props.widget as Widget).id, (px) => emit('fit-height', px))
    return () => null
  },
})

async function mountDashboard(widgets: Widget[]) {
  wrapper = mount(Dashboard, {
    props: { widgets, filters, dark: false, drillOpenId: null, controlsVisible: false },
    global: { stubs: { ChartCard: StubCard } },
    attachTo: document.body,
  })
  await nextTick()
  await nextTick()
}
const report = async (id: string, px: number) => {
  reporters.get(id)!(px)
  await nextTick()
  await nextTick()
}

describe('Dashboard: a fit card re-packs the cards below it', () => {
  it('a taller fitted card pushes the next card down, and a shorter one pulls it back up', async () => {
    vi.stubGlobal('innerWidth', 1280)
    const widgets = reactive([card('top', 0, 4, true), card('below', 4, 4)]) as Widget[]
    await mountDashboard(widgets)
    expect(widgets[1].y).toBe(4)

    await report('top', 900)
    expect(widgets[0].h).toBe(fitRows(900))
    expect(widgets[1].y).toBe(widgets[0].y + widgets[0].h) // no overlap

    await report('top', 200)
    expect(widgets[0].h).toBe(fitRows(200))
    expect(widgets[1].y).toBe(widgets[0].h) // back up under the shorter card
  })

  it('a phone-width report changes nothing', async () => {
    vi.stubGlobal('innerWidth', 390)
    const widgets = reactive([card('top', 0, 4, true), card('below', 4, 4)]) as Widget[]
    await mountDashboard(widgets)
    await report('top', 900)
    expect(widgets[0].h).toBe(4)
    expect(widgets[1].y).toBe(4)
  })
})
