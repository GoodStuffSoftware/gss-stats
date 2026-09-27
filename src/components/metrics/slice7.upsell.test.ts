// @vitest-environment happy-dom
//
// PARITY with the signed-out upsell fix SET (ADR 0003 slice 7, difference M1 in
// slice7.parity.test.ts): lib/adsRules.ts UPSELL_SIGNEDOUT_FIX_AT is null in production today, so
// neither the old flight-day panel's segment table nor the funnel card's segment section shows.
// This file sets it (a module mock both paths read) and checks that the funnel card's segment
// section appears for the flight the fix falls in — and only that one — with the same tagged
// upsell shown / accepted / dismissed on each side as the old table, split at the exact instant.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'

const { FIX_AT } = vi.hoisted(() => ({ FIX_AT: Date.parse('2026-09-26T18:00:00Z') }))
vi.mock('../../lib/adsRules', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../lib/adsRules')>()), UPSELL_SIGNEDOUT_FIX_AT: FIX_AT }))

import MetricCard from './MetricCard.vue'
import CampaignsWidgetBody from '../widgets/CampaignsWidgetBody.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { onRequestPost as metricsPost } from '../../../functions/api/metrics'
import { onRequestPost as campaignsPost } from '../../../functions/api/campaigns'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../../../functions/_lib/testing/hitsDb'
import { bskFixture, FIXTURE_NOW } from '../../../functions/_lib/testing/bskFixture'
import { UPSELL_SIGNEDOUT_FIX_AT } from '../../lib/adsRules'
import type { Widget } from '../../types'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import GOLDEN_FILE from './__fixtures__/slice7.upsell.golden.json'

// The old table is read through `golden` (as in slice7.parity.test.ts): the live old flight-day
// body while it exists, checked against its stored copy (SLICE7_CAPTURE=1 rewrites it).
const GOLDEN_PATH = resolve(process.cwd(), 'src/components/metrics/__fixtures__/slice7.upsell.golden.json')
const CAPTURE = process.env.SLICE7_CAPTURE === '1'
const GOLDEN: Record<string, unknown> = { ...(GOLDEN_FILE as Record<string, unknown>) }
const captured: Record<string, unknown> = {}
async function golden<T>(key: string, live: () => Promise<T> | T): Promise<T> {
  const value = JSON.parse(JSON.stringify(await live())) as T
  if (CAPTURE) captured[key] = value
  else expect(value, `live old rendering ≡ golden "${key}"`).toEqual(GOLDEN[key])
  return value
}

const RETEST = { site: 'bestsudoku-web', campaign: 'sudoku_funnel_retest', visitor: 'returning' }
/** Tagged upsell rows on both sides of the fix, one pair in the fix's own minute. */
const UPSELL_ROWS = [
  { ...RETEST, ts: Date.parse('2026-09-26T17:10:00Z'), path: '/upsell/shown/limit', n: 5 },
  { ...RETEST, ts: Date.parse('2026-09-26T17:12:00Z'), path: '/upsell/accept/limit', n: 2 },
  { ...RETEST, ts: FIX_AT - 1_000, path: '/upsell/dismiss/limit', n: 1 },
  { ...RETEST, ts: FIX_AT, path: '/upsell/shown/limit', n: 4 },
  { ...RETEST, ts: Date.parse('2026-09-26T18:30:00Z'), path: '/upsell/dismiss/limit', n: 3 },
]

let db: ReturnType<typeof openHitsDb>
let undoCaches: () => void
const mounted: VueWrapper[] = []
async function route(url: string, init: RequestInit): Promise<Response> {
  const path = new URL(url, 'https://stats.goodstuff.software').pathname
  const handler = path === '/api/metrics' ? metricsPost : path === '/api/campaigns' ? campaignsPost : null
  if (!handler) throw new Error(`unexpected fetch ${path}`)
  const waited: Promise<unknown>[] = []
  const res = await handler(pagesContext(postJson(path, JSON.parse(String(init.body))), { gss_geo: sqliteD1(db) } as never, waited) as never)
  await Promise.all(waited)
  return res
}
beforeAll(() => {
  db = openHitsDb()
  insertHits(db, [...bskFixture(), ...UPSELL_ROWS])
  vi.useFakeTimers({ now: FIXTURE_NOW, toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
  vi.stubGlobal('fetch', vi.fn(route))
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
})
afterAll(() => {
  if (CAPTURE) writeFileSync(GOLDEN_PATH, JSON.stringify({ ...GOLDEN, ...captured }, null, 2) + '\n')
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

describe('the upsell-fix segment section, with the fix set', () => {
  it('the mock is in force on both paths', () => {
    expect(UPSELL_SIGNEDOUT_FIX_AT).toBe(FIX_AT)
  })

  it('appears on the retest card only, with the old table\'s shown / accepted / dismissed on each side', async () => {
    const widget: Widget = { id: 'cw-flightday', i: 'cw-flightday', title: 'x', type: 'table', dataset: 'campaigns', view: 'flightDay', dimension: '', metric: 'pageviews', limit: 1, notes: ['arrivals-caveat', 'flight-day-caption'], x: 0, y: 0, w: 12, h: 10 }
    const old = await golden('flightDay.segments', async () => {
      const w = mount(CampaignsWidgetBody, { props: { widget } })
      mounted.push(w)
      await settle()
      return w.findAll('.segment').map((seg) => ({ caption: norm(seg.find('p').text()), rows: seg.findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => norm(td.text()))) }))
    })
    expect(old).toHaveLength(1) // the fix falls in the retest's flight only
    expect(old[0].caption).toMatch(/^▼ US\+CA web retest: signed-out upsell fix at 2026-09-26 14:00 ET \(flight day 1\) — a funnel segment boundary/)
    const oldRows = old[0].rows
    expect(oldRows).toEqual([
      ['pre-fix', '5', '2', '1'],
      ['post-fix', '4', '0', '3'],
    ])

    const card = mount(MetricCard, { props: { cardRef: { preset: 'campaign-funnel' }, nowMs: FIXTURE_NOW } })
    mounted.push(card)
    await settle()
    const cards = card.findAll('.metric-card')
    const withTable = cards.filter((c) => c.find('.metric-section.layout-table').exists())
    expect(withTable.map((c) => norm(c.find('.mc-title').text()))).toEqual(['US+CA web retest'])
    const section = withTable[0].find('.metric-section.layout-table')
    expect(norm(section.find('.section-title').text())).toBe('▼ Signed-out upsell fix at 2026-09-26 14:00 ET (flight day 1) — a funnel segment boundary: read the two sides as separate short tests.')
    expect(section.findAll('thead th').map((th) => norm(th.text()))).toEqual(['Tagged upsell', 'Shown', 'Accepted', 'Dismissed'])
    expect(section.findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => norm(td.text())))).toEqual(oldRows)
  })
})
