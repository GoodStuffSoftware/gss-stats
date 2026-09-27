// @vitest-environment happy-dom
//
// PARITY (ADR 0003 slice 7): every panel slice 7 converts, rendered the NEW way (a card preset
// over POST /api/metrics, or a generic chart over /api/geo) against the OLD bespoke body over its
// own endpoint, on ONE node:sqlite fixture (functions/_lib/testing/bskFixture.ts, plus the rows a
// panel needs that the shared fixture lacks), asserting the same visible numbers. Every visible
// difference is listed next to the panel and asserted as itself, so none can appear silently.
//
// Release panel (overview 'releasePanel' → preset release-before-after):
//   R1  "Installs" in the Before window: the old panel counted 0, because every install outcome
//       before the install fix (26 Sep, 12:26 ET, after the release's midnight) is dropped as
//       unmeasured; the card says "not yet tracking" instead of a 0 it could not have measured.
//   R2  No full day on each side yet (the release day itself): the old panel said "No dated
//       release yet…" although the release is dated; the card names the release and says "no
//       release window yet" for the days and every count.
//   L1  Layout: the old "v1.95.3 (2026-09-26) — 2 days before vs after." line is two rows
//       ("Release", "Days on each side"); the Before and After boxes are one table with Before and
//       After as its columns. The "before = partially instrumented" note is unchanged, under it.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import OverviewWidgetBody from '../widgets/OverviewWidgetBody.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { onRequestPost as metricsPost } from '../../../functions/api/metrics'
import { onRequestPost as overviewPost } from '../../../functions/api/overview'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../../../functions/_lib/testing/hitsDb'
import { bskFixture, FIXTURE_NOW } from '../../../functions/_lib/testing/bskFixture'
import { defaultFilters } from '../../lib/defaults'
import type { Widget } from '../../types'

let db: ReturnType<typeof openHitsDb>
let cache: ReturnType<typeof memoryCache>
let undoCaches: () => void
const mounted: VueWrapper[] = []

const HANDLERS: Record<string, (ctx: any) => Response | Promise<Response>> = {
  '/api/metrics': metricsPost,
  '/api/overview': overviewPost,
}
async function route(url: string, init: RequestInit): Promise<Response> {
  const path = new URL(url, 'https://stats.goodstuff.software').pathname
  const handler = HANDLERS[path]
  if (!handler) throw new Error(`unexpected fetch ${path}`)
  const waited: Promise<unknown>[] = []
  const res = await handler(pagesContext(postJson(path, JSON.parse(String(init.body ?? '{}'))), { gss_geo: sqliteD1(db) } as never, waited))
  await Promise.all(waited)
  return res
}

beforeAll(() => {
  db = openHitsDb()
  insertHits(db, bskFixture())
  vi.useFakeTimers({ now: FIXTURE_NOW, toFake: ['Date'] })
  cache = memoryCache()
  undoCaches = installCaches(cache)
  vi.stubGlobal('fetch', vi.fn(route))
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  cache.clear()
  vi.setSystemTime(FIXTURE_NOW)
})
afterAll(() => {
  undoCaches()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function settle() {
  for (let i = 0; i < 8; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 15))
  }
}
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
function text(el: Element | undefined): string {
  if (!el) return ''
  const clone = el.cloneNode(true) as Element
  clone.querySelectorAll('button').forEach((b) => b.remove())
  return norm(clone.textContent)
}

async function mountCard(preset: string, nowMs: number, context?: Record<string, unknown>) {
  const w = mount(MetricCard, { props: { cardRef: { preset }, nowMs, ...(context ? { context } : {}) } })
  mounted.push(w)
  await settle()
  return w
}
/** A column table (Section.columns): row label → the cell text under each column heading. */
function columnTable(w: VueWrapper): Map<string, Map<string, string>> {
  const table = w.find('table.metric-table.columns')
  const heads = table.findAll('thead th').slice(1).map((th) => text(th.element))
  const out = new Map<string, Map<string, string>>()
  for (const tr of table.findAll('tbody tr')) {
    const cells = tr.findAll('td').map((td) => text(td.element))
    out.set(text(tr.find('th').element), new Map(heads.map((h, i) => [h, cells[i]])))
  }
  return out
}
const rows = (w: VueWrapper) => new Map(w.findAll('.mi-row').map((r) => [text(r.find('.mi-label').element), text(r.find('.mi-value').element)]))

// ── Release panel ─────────────────────────────────────────────────────────────────────────
describe('release-before-after ≡ the bespoke release panel', () => {
  const LABELS = ['Page views', 'Tagged arrivals', 'Auth successes', 'Installs']
  const widget = (id: string): Widget => ({ id, i: id, title: 'Release panel', type: 'table', dataset: 'overview', view: 'releasePanel', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 12, h: 9 })
  async function mountOld(nowMs: number) {
    // useOverviewData caches per since|until, so each moment gets its own range key.
    const filters = { ...defaultFilters(), since: new Date(nowMs - 86_400_000).toISOString(), until: new Date(nowMs).toISOString() }
    const w = mount(OverviewWidgetBody, { props: { widget: widget(`ow-release-${nowMs}`), filters } })
    mounted.push(w)
    await settle()
    return w
  }
  function oldPanel(w: VueWrapper): { caption: string; cols: Map<string, Map<string, string>> } {
    const cols = new Map<string, Map<string, string>>()
    for (const col of w.findAll('.release-col')) {
      cols.set(text(col.find('.fc-label').element), new Map(col.findAll('.rel-row').map((r) => [text(r.findAll('span')[0].element), text(r.findAll('span')[1].element)])))
    }
    return { caption: text(w.find('.caption').element), cols }
  }

  it('two days after the release: the same four counts on each side, except R1', async () => {
    const now = Date.parse('2026-09-28T16:00:00Z')
    vi.setSystemTime(now)
    const old = oldPanel(await mountOld(now))
    expect(old.caption).toMatch(/^v1\.95\.3 \(2026-09-26\) — 2 days before vs after\. before = partially instrumented/)
    const card = await mountCard('release-before-after', now)
    const r = rows(card)
    expect(r.get('Release')).toBe('v1.95.3 (2026-09-26)') // L1
    expect(r.get('Days on each side')).toBe('2') // L1: the "2 days" of the old line
    const t = columnTable(card)
    expect([...t.keys()]).toEqual(LABELS)
    for (const side of ['Before', 'After']) {
      for (const label of LABELS) {
        const was = old.cols.get(side)!.get(label)
        const now = t.get(label)!.get(side)
        if (side === 'Before' && label === 'Installs') {
          expect(was, 'R1 old').toBe('0')
          expect(now, 'R1 new').toBe('not yet tracking')
          continue
        }
        expect(now, `${side} ${label}`).toBe(was)
      }
    }
    // The fixture exercises real numbers on both sides.
    expect(Number(old.cols.get('Before')!.get('Page views')!.replace(/,/g, ''))).toBeGreaterThan(0)
    expect(Number(old.cols.get('After')!.get('Installs'))).toBeGreaterThan(0)
    expect(Number(old.cols.get('After')!.get('Tagged arrivals'))).toBeGreaterThan(0)
    // The note under the panel is unchanged (L1).
    expect(text(card.find('.mc-captions').element)).toBe(old.caption.slice(old.caption.indexOf('before = ')))
  })

  it('R2: on the release day itself (no full day after it), both say there is nothing to compare yet', async () => {
    const old = await mountOld(FIXTURE_NOW)
    expect(text(old.find('.caption').element)).toBe('No dated release yet. This panel fills in once a release has a date.')
    const card = await mountCard('release-before-after', FIXTURE_NOW)
    const r = rows(card)
    expect(r.get('Release')).toBe('v1.95.3 (2026-09-26)')
    expect(r.get('Days on each side')).toBe('no release window yet')
    const t = columnTable(card)
    for (const label of LABELS) for (const side of ['Before', 'After']) expect(t.get(label)!.get(side), `${side} ${label}`).toBe('no release window yet')
  })

  it('reads the first-hit aggregate once, then the two windows in one statement', async () => {
    const now = Date.parse('2026-09-28T16:00:00Z')
    vi.setSystemTime(now)
    const d1 = sqliteD1(db)
    const res = await metricsPost(pagesContext(postJson('/api/metrics', { v: 1, requests: [
      { key: 'a', metric: 'bsk.pageviews', window: 'before' },
      { key: 'b', metric: 'bsk.pageviews', window: 'after' },
      { key: 'c', metric: 'release.windowDays', window: 'after' },
    ] }), { gss_geo: d1 } as never) as never)
    const body = (await res.json()) as { results: Record<string, { value: number }>; meta: { statements: number } }
    expect(body.meta.statements).toBe(2)
    expect(d1.statements.filter((s) => s.includes('MIN(ts)'))).toHaveLength(1)
    expect(body.results.c.value).toBe(2)
  })
})
