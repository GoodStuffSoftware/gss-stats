// @vitest-environment happy-dom
//
// ChartEditor x caption display (Widget.captionDisplay): the "Long notes" select, the same one for a
// chart and for a metric card (a card is edited inside this editor, with CardEditor in place of the
// chart-only fields). 'always' is the absence of the key, so a widget nobody touched saves exactly
// as it was; a note widget has no notes to fold and never keeps the key. The card tests mount the
// real CardEditor, so they get an explicit timeout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ChartEditor from './ChartEditor.vue'
import { __resetMetricsStateForTests } from '../composables/useMetrics'
import { normalizeConfig } from '../lib/defaults'
import type { DashboardConfig, Widget } from '../types'

const SLOW = 20000
const mounted: VueWrapper[] = []
beforeEach(() => {
  __resetMetricsStateForTests()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { requests: { key: string }[] }
      const results: Record<string, unknown> = {}
      for (const r of body.requests) results[r.key] = { status: 'ok', value: 42 }
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
    }),
  )
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
})

const chart = (over: Partial<Widget> = {}): Widget =>
  ({ id: 'w1', i: 'w1', title: 'Panel', type: 'table', dataset: 'popup', dimension: 'kind', metric: 'pageviews', limit: 10, x: 0, y: 0, w: 6, h: 6, ...over }) as Widget
const card = (over: Partial<Widget> = {}): Widget =>
  ({ id: 'ow-kpis', i: 'ow-kpis', title: 'Today at a glance', type: 'table', dataset: 'overview', view: 'kpis', card: { preset: 'bsk-kpis' }, dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 3, w: 12, h: 8, ...over }) as Widget
function open(widget: Widget, isNew = false) {
  const w = mount(ChartEditor, { props: { widget, isNew } })
  mounted.push(w)
  return w
}
const select = (w: VueWrapper) => w.get<HTMLSelectElement>('select[data-testid="caption-display"]')
async function save(w: VueWrapper): Promise<Widget> {
  await w.get('button.btn-primary').trigger('click')
  const ev = w.emitted('save')!
  return ev[ev.length - 1][0] as Widget
}
function viaStorage(saved: Widget): Widget {
  const raw = { version: 10, activePageId: 'p1', pages: [{ id: 'p1', name: 'P', filters: { siteSel: [] }, widgets: [saved] }] } as unknown as DashboardConfig
  return normalizeConfig(raw).pages[0].widgets[0]
}

describe.each([
  ['chart editor', chart, 'Long notes'],
  ['card editor', card, 'Long notes'],
])('%s: Long notes', (_name, make, label) => {
  it('shows the three choices, "Always shown in full" for a widget saved without the option, and saves it with no key', async () => {
    const w = open(make())
    await flushPromises()
    expect(w.text()).toContain(label)
    expect(select(w).findAll('option').map((o) => o.attributes('value'))).toEqual(['always', 'collapsible', 'auto'])
    expect(select(w).element.value).toBe('always')
    expect('captionDisplay' in (await save(w))).toBe(false)
  }, SLOW)

  it.each(['collapsible', 'auto'] as const)('saves %s, and a saved layout keeps it through normalizeConfig and reopens on it', async (mode) => {
    const w = open(make())
    await flushPromises()
    await select(w).setValue(mode)
    const out = await save(w)
    expect(out.captionDisplay).toBe(mode)
    const stored = viaStorage(out)
    expect(stored.captionDisplay).toBe(mode)
    const again = open(stored)
    await flushPromises()
    expect(select(again).element.value).toBe(mode)
  }, SLOW)

  it('choosing Always shown again removes the key', async () => {
    const w = open(make({ captionDisplay: 'auto' }))
    await flushPromises()
    expect(select(w).element.value).toBe('auto')
    await select(w).setValue('always')
    expect('captionDisplay' in (await save(w))).toBe(false)
  }, SLOW)

  it('Cancel leaves the saved widget as it was', async () => {
    const original = make({ captionDisplay: 'collapsible' })
    const w = open(original)
    await flushPromises()
    await select(w).setValue('always')
    await w.findAll('button').find((b) => b.text() === 'Cancel')!.trigger('click')
    expect(original.captionDisplay).toBe('collapsible')
    expect(w.emitted('save')).toBeUndefined()
  }, SLOW)
})

describe('a note widget', () => {
  it('has no Long notes select and never saves the key', async () => {
    const w = open(chart({ type: 'note', dataset: undefined, dimension: '', note: 'Hello', captionDisplay: 'auto' }))
    await flushPromises()
    expect(w.find('select[data-testid="caption-display"]').exists()).toBe(false)
    expect('captionDisplay' in (await save(w))).toBe(false)
  })

  it('a widget switched to a note in the editor drops the key it had', async () => {
    const w = open(chart({ captionDisplay: 'collapsible' }))
    await flushPromises()
    const typeSelect = w.findAll('select').find((s) => s.findAll('option').some((o) => o.attributes('value') === 'note'))!
    await typeSelect.setValue('note')
    await flushPromises()
    expect('captionDisplay' in (await save(w))).toBe(false)
  })
})
