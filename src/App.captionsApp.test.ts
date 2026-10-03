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
  return cfg
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
