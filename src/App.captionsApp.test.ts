// @vitest-environment happy-dom
//
// Chart captions slice 1c, App.vue's two hand-offs: a duplicated chart is a deep copy (it shares no
// array or object with the original), and the ChartEditor opened for a chart receives that chart's
// own latest response, as ChartCard reported it (no second fetch).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import App from './App.vue'
import Dashboard from './components/Dashboard.vue'
import ChartCard from './components/ChartCard.vue'
import ChartEditor from './components/ChartEditor.vue'
import { stubAppFetch, type AppFetch } from './testing/appFetch'
import { defaultConfig, normalizeConfig } from './lib/defaults'
import { loadConfig, saveConfig } from './api'
import { CAMPAIGN_SCORECARD } from './lib/metrics/presets'
import type { DashboardConfig, StatsResponse, Widget } from './types'

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>()
  return { ...actual, loadConfig: vi.fn(), saveConfig: vi.fn(async () => true) }
})
vi.mock('./sitesStore', async (importOriginal) => ({ ...(await importOriginal<typeof import('./sitesStore')>()), loadSites: vi.fn(async () => {}) }))
vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  loadIdentity: vi.fn(async () => {}),
  checkSessionExpired: vi.fn(async () => {}),
}))

const GEO_ID = 'cc-geo'
const FULL_ID = 'cc-full'

/** The default config with two extra charts on the active page: a plain geo chart (its response
 * comes from the stubbed fetch) and a chart carrying every field a duplicate must keep. */
function stored(): DashboardConfig {
  const cfg = normalizeConfig(JSON.parse(JSON.stringify(defaultConfig())))
  const page = cfg.pages.find((p) => p.id === cfg.activePageId) ?? cfg.pages[0]
  cfg.activePageId = page.id
  const base = { x: 0, y: 0, w: 4, h: 6 }
  const geo = { ...base, id: GEO_ID, i: GEO_ID, title: 'Geo chart', type: 'bar', dataset: 'geo', dimension: 'country', metric: 'pageviews' } as unknown as Widget
  const full = {
    ...base,
    id: FULL_ID,
    i: FULL_ID,
    title: 'Full chart',
    type: 'bar',
    card: { spec: JSON.parse(JSON.stringify(CAMPAIGN_SCORECARD)) },
    caption: 'My caption',
    hiddenCaveats: ['a', 'b'],
    notes: ['x', 'y'],
    fit: 'content',
  } as unknown as Widget
  page.widgets.push(geo, full)
  // Another page reuses the geo chart's id, as production pages do (`country`, `geo-map`, ...). A
  // note widget never loads, so it never reports a response of its own.
  const other = cfg.pages.find((p) => p.id !== page.id && !p.isDefault)!
  other.widgets.push({ ...base, id: GEO_ID, i: GEO_ID, title: 'Same id, other page', type: 'note', note: 'Hi.' } as unknown as Widget)
  return cfg
}
const otherPageId = () => {
  const cfg = stored()
  return cfg.pages.find((p) => p.id !== cfg.activePageId && !p.isDefault)!.id
}

let wrapper: VueWrapper | null = null
let fetchStub: AppFetch
beforeEach(() => {
  localStorage.clear()
  fetchStub = stubAppFetch()
  vi.mocked(loadConfig).mockResolvedValue(stored())
  vi.mocked(saveConfig).mockClear()
  vi.stubGlobal('innerWidth', 1280)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.unstubAllGlobals()
})
async function load() {
  wrapper = mount(App, { attachTo: document.body })
  await flushPromises()
}
const widgets = () => wrapper!.findComponent(Dashboard).props('widgets') as Widget[]

describe('App: duplicating a chart', () => {
  it('is a deep copy: the duplicate keeps every field and shares no array with the original', async () => {
    await load()
    const original = widgets().find((w) => w.id === FULL_ID)!
    const before = JSON.parse(JSON.stringify(original))
    wrapper!.findComponent(Dashboard).vm.$emit('duplicate', original)
    await flushPromises()

    const copy = widgets().find((w) => w.title === 'Full chart (copy)')! as any
    expect(copy.id).not.toBe(FULL_ID)
    expect(copy.i).toBe(copy.id)
    const { id: _a, i: _b, x: _c, y: _d, title: _e, ...copied } = copy
    const { id: _f, i: _g, x: _h, y: _j, title: _k, ...kept } = before
    expect(JSON.parse(JSON.stringify(copied))).toEqual(kept) // caption, hiddenCaveats, notes, fit, the card's items[].display and repeat

    copy.hiddenCaveats.push('c')
    copy.notes.push('z')
    copy.card.spec.sections[0].items[0].display.changed = true
    copy.card.spec.sections[0].items.push({ id: 'extra' })
    copy.card.spec.repeat.ids = ['x']
    const orig = widgets().find((w) => w.id === FULL_ID)! as any
    expect(JSON.parse(JSON.stringify(orig))).toEqual(before)
    expect(orig.hiddenCaveats).not.toBe(copy.hiddenCaveats)
    expect(orig.card.spec.sections[0].items).not.toBe(copy.card.spec.sections[0].items)
    expect(orig.card.spec.repeat).not.toBe(copy.card.spec.repeat)
  })
})

describe('App: the editor gets the chart’s current response', () => {
  it('passes the edited chart’s own data and error, without a new fetch', async () => {
    await load()
    const geoCard = wrapper!.findAllComponents(ChartCard).find((c) => c.props('widget').id === GEO_ID)!
    const fetchesBefore = fetchStub.fetch.mock.calls.length
    const held = (geoCard.vm as unknown as { data: StatsResponse | null }).data
    expect(held).not.toBeNull()

    wrapper!.findComponent(Dashboard).vm.$emit('edit', widgets().find((w) => w.id === GEO_ID)!)
    await flushPromises()
    const editor = wrapper!.findComponent(ChartEditor)
    expect(editor.props('data')).toStrictEqual(held)
    expect(editor.props('data')!.meta.site).toBe('all')
    expect(editor.props('error')).toBeNull()
    expect(fetchStub.fetch.mock.calls.length).toBe(fetchesBefore)
  })

  it('a card’s reported error reaches the editor of that card only', async () => {
    await load()
    const geoCard = wrapper!.findAllComponents(ChartCard).find((c) => c.props('widget').id === GEO_ID)!
    geoCard.vm.$emit('data', null, 'Failed to load')
    await flushPromises()

    const dash = wrapper!.findComponent(Dashboard)
    dash.vm.$emit('edit', widgets().find((w) => w.id === GEO_ID)!)
    await flushPromises()
    expect(wrapper!.findComponent(ChartEditor).props('error')).toBe('Failed to load')

    wrapper!.findComponent(ChartEditor).vm.$emit('cancel')
    await flushPromises()
    dash.vm.$emit('edit', widgets().find((w) => w.id === FULL_ID)!)
    await flushPromises()
    expect(wrapper!.findComponent(ChartEditor).props('error')).not.toBe('Failed to load')
  })
})

describe('App: chart responses are kept per page (NIT-7)', () => {
  type AppVm = { switchPage(id: string): void; deletePage(id: string): void; chartData: Record<string, unknown> }
  const vm = () => wrapper!.vm as unknown as AppVm

  it("an editor on another page never gets a same-id chart's response, and deleting a page drops its responses", async () => {
    await load()
    const dash = wrapper!.findComponent(Dashboard)
    dash.vm.$emit('data', GEO_ID, null, 'Failed on the first page')
    await flushPromises()

    const other = otherPageId()
    vm().switchPage(other)
    await flushPromises()
    const same = widgets().find((w) => w.id === GEO_ID)!
    expect(same.type).toBe('note')
    dash.vm.$emit('edit', same)
    await flushPromises()
    expect(wrapper!.findComponent(ChartEditor).props('error')).toBeNull()
    expect(wrapper!.findComponent(ChartEditor).props('data')).toBeNull()
    wrapper!.findComponent(ChartEditor).vm.$emit('cancel')
    await flushPromises()

    // A response reported on this page is this page's; deleting the page drops it, the first page's stays.
    dash.vm.$emit('data', GEO_ID, null, 'Failed on the other page')
    await flushPromises()
    const pageOf = (key: string) => (JSON.parse(key) as string[])[0]
    expect(Object.keys(vm().chartData).some((k) => pageOf(k) === other)).toBe(true)
    vi.stubGlobal('confirm', () => true)
    vm().deletePage(other)
    await flushPromises()
    expect(Object.keys(vm().chartData).some((k) => pageOf(k) === other)).toBe(false)
    expect(Object.keys(vm().chartData).length).toBeGreaterThan(0)
  })

  it('duplicating a chart still works, and the editor still gets the edited chart’s own error', async () => {
    await load()
    const dash = wrapper!.findComponent(Dashboard)
    dash.vm.$emit('data', GEO_ID, null, 'Failed to load')
    dash.vm.$emit('duplicate', widgets().find((w) => w.id === GEO_ID)!)
    await flushPromises()
    expect(widgets().filter((w) => w.title.startsWith('Geo chart'))).toHaveLength(2)
    dash.vm.$emit('edit', widgets().find((w) => w.id === GEO_ID)!)
    await flushPromises()
    expect(wrapper!.findComponent(ChartEditor).props('error')).toBe('Failed to load')
  })
})
