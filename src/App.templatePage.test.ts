// @vitest-environment happy-dom
//
// A page built from a template is known by its marker (DashboardPage.templateId): the Retention page
// keeps only the date range (and Sync) in its filter bar, and Restore default charts brings back
// the page's own template set. The campaigns page still shows no bar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import App from './App.vue'
import { stubAppFetch } from './testing/appFetch'
import { loadConfig, saveConfig } from './api'
import { VIEWER_PREFS_KEY } from './lib/viewerPrefs'
import { TEMPLATE_WIDGETS, defaultConfig, defaultRetentionPage } from './lib/defaults'
import { applyPageDraft, newPageDraft } from './lib/wizards'
import type { DashboardConfig } from './types'

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
vi.mock('./sitesStore', async (importOriginal) => ({ ...(await importOriginal<typeof import('./sitesStore')>()), loadSites: vi.fn(async () => {}) }))
vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  loadIdentity: vi.fn(async () => {}),
  checkSessionExpired: vi.fn(async () => {}),
}))

const mounted: VueWrapper[] = []
beforeEach(() => {
  stubAppFetch()
  localStorage.clear()
  vi.mocked(saveConfig).mockClear()
})
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** The fresh layout plus a Retention page built from the template (marked), the Retention page by its
 * legacy id (unmarked), and a Traffic page built from its template. Ids by role. */
function stored(): { cfg: DashboardConfig; ids: Record<string, string> } {
  let cfg: DashboardConfig = JSON.parse(JSON.stringify(defaultConfig()))
  const ids: Record<string, string> = {}
  for (const [key, start] of [['retention', 'tpl-bsk-retention'], ['traffic', 'tpl-bsk-launch']] as const) {
    const { result, page } = applyPageDraft(cfg, { ...newPageDraft('Best Sudoku'), name: key, start }, cfg.pages[0])
    cfg = { ...cfg, pages: result.pages, groupOrder: result.groupOrder }
    ids[key] = page.id
  }
  cfg.pages.push(JSON.parse(JSON.stringify({ ...defaultRetentionPage(), name: 'Legacy retention' })))
  ids.legacy = 'bsk-retention'
  ids.campaigns = 'bsk-campaigns'
  ids.default = cfg.pages[0].id
  return { cfg, ids }
}
async function mountOn(role: string, edit?: (s: { cfg: DashboardConfig; ids: Record<string, string> }) => void): Promise<{ w: VueWrapper; ids: Record<string, string> }> {
  const s = stored()
  edit?.(s)
  vi.mocked(loadConfig).mockImplementation(async () => JSON.parse(JSON.stringify(s.cfg)))
  localStorage.setItem(VIEWER_PREFS_KEY, JSON.stringify({ active: s.ids[role] }))
  const w = mount(App, { attachTo: document.body })
  mounted.push(w)
  await flushPromises()
  return { w, ids: s.ids }
}
const barLabels = (w: VueWrapper) => w.findAll('.filterbar-inflow .filter-bar > .group > label:first-child').map((l) => l.text())

describe('App: the main filter bar by page template', () => {
  it('Retention (built from the template): the date range and Sync stay; Sites and Exclusions are gone', async () => {
    const { w } = await mountOn('retention')
    expect(barLabels(w)).toEqual(['Range', 'Pages'])
    expect(w.find('.filterbar-inflow .range-field').exists()).toBe(true)
    expect(w.find('.filterbar-inflow .sync-toggle').exists()).toBe(true)
    expect(w.find('.filterbar-inflow .site-btn').exists()).toBe(false)
    expect(w.find('.filterbar-inflow .excl-btn').exists()).toBe(false)
    // the "show filters" pin is still there, and what it pins is the same trimmed bar
    expect(w.find('.fb-anchor').exists()).toBe(true)
  })

  it('Retention by its legacy id (no marker) is trimmed the same way', async () => {
    const { w } = await mountOn('legacy')
    expect(barLabels(w)).toEqual(['Range', 'Pages'])
  })

  it('a page built from another template keeps the whole bar', async () => {
    const { w } = await mountOn('traffic')
    expect(barLabels(w)).toEqual(['Sites', 'Range', 'Exclusions', 'Pages'])
  })

  it('the Overview page keeps the whole bar', async () => {
    const { w } = await mountOn('default')
    expect(barLabels(w)).toEqual(['Sites', 'Range', 'Exclusions', 'Pages'])
  })

  it('the campaigns page still shows no bar and no pin (unchanged)', async () => {
    const { w } = await mountOn('campaigns')
    expect(w.find('.filterbar-inflow').exists()).toBe(false)
    expect(w.find('.fb-anchor').exists()).toBe(false)
  })
})

describe('App: Restore default charts on a template-built page', () => {
  it('brings back the Retention set (not the generic one) after the cards were deleted', async () => {
    const confirm = vi.fn(() => true)
    vi.stubGlobal('confirm', confirm)
    const { w, ids } = await mountOn('retention', (s) => {
      s.cfg.pages.find((p) => p.id === s.ids.retention)!.widgets = []
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await w.find('.drawer-btn').trigger('click')
    await flushPromises()
    const drawer = document.body
    const row = Array.from(drawer.querySelectorAll<HTMLElement>('.dr-page')).find((r) => r.textContent!.includes('retention'))!
    const more = row.querySelector<HTMLElement>('.dr-more') ?? row.parentElement!.querySelector<HTMLElement>('.dr-more')!
    more.click()
    await flushPromises()
    const item = Array.from(document.querySelectorAll<HTMLElement>('#page-menu [role="menuitem"]')).find((b) => b.textContent!.includes('Restore default charts'))!
    item.click()
    await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    const saved = vi.mocked(saveConfig).mock.calls.at(-1)![0] as DashboardConfig
    const page = saved.pages.find((p) => p.id === ids.retention)!
    expect(page.templateId).toBe('tpl-bsk-retention')
    expect(page.widgets.map((x) => x.title)).toEqual(TEMPLATE_WIDGETS['tpl-bsk-retention']().map((x) => x.title))
  })
})
