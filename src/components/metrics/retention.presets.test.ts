// @vitest-environment happy-dom
//
// R-2 presets (picker only, never a default): `retention-verdict` and `campaign-engagement`,
// rendered through MetricCard over POST /api/metrics against the node:sqlite fixture. Each one
// renders its rows and carries its caveats behind the card's Notes toggle: the retention
// caveats (disjoint groups, lower bound) on the verdict and every R2-7 figure, and the
// completions-per-arrival caveat on E1.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { onRequestPost as metricsPost } from '../../../functions/api/metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../../../functions/_lib/testing/hitsDb'
import { bskFixture, FIXTURE_NOW } from '../../../functions/_lib/testing/bskFixture'
import { CAMPAIGNS } from '../../lib/campaigns'
import { getNote, noteRawText } from '../../lib/notes'
import { defaultWidgets } from '../../lib/defaults'

const RETEST = CAMPAIGNS.find((c) => c.id === '24279250691')!.label

let db: ReturnType<typeof openHitsDb>
let undoCaches: () => void
const mounted: VueWrapper[] = []

async function route(url: string, init: RequestInit): Promise<Response> {
  const path = new URL(url, 'https://stats.goodstuff.software').pathname
  if (path !== '/api/metrics') throw new Error(`unexpected fetch ${path}`)
  const waited: Promise<unknown>[] = []
  const res = await metricsPost(pagesContext(postJson(path, JSON.parse(String(init.body))), { gss_geo: sqliteD1(db) } as never, waited) as never)
  await Promise.all(waited)
  return res
}

beforeAll(() => {
  db = openHitsDb()
  insertHits(db, bskFixture())
  vi.useFakeTimers({ now: FIXTURE_NOW, toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
  vi.stubGlobal('fetch', vi.fn(route))
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
})
afterAll(() => {
  undoCaches()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function settle() {
  for (let i = 0; i < 6; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 15))
  }
}
async function mountNew(preset: string) {
  const w = mount(MetricCard, { props: { cardRef: { preset }, nowMs: FIXTURE_NOW } })
  mounted.push(w)
  await settle()
  return w
}
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
/** Every line of the card's Notes (each toggle opened first). */
async function noteLines(w: VueWrapper): Promise<string[]> {
  for (const toggle of w.findAll('button.mc-notes-toggle')) await toggle.trigger('click')
  return w.findAll('.mc-notes li').map((li) => norm(li.text()))
}

describe('retention-verdict (picker only)', () => {
  it('renders one row per campaign arm and the organic baseline, with the verdict', async () => {
    const w = await mountNew('retention-verdict')
    const text = norm(w.text())
    expect(text).toContain(RETEST)
    expect(text).toContain(noteRawText('label.arm.organic'))
    // The retest has 6 first tagged loads in the fixture: under the 200 floor, so no verdict yet.
    expect(text).toContain('too few')
  })

  it('carries the disjoint-groups and lower-bound caveats, and no clock time', async () => {
    const w = await mountNew('retention-verdict')
    const lines = (await noteLines(w)).join('\n')
    expect(lines).toContain(noteRawText('retention-disjoint'))
    expect(lines).toContain(noteRawText('retention-lower-bound'))
    expect(noteRawText('retention-disjoint')).not.toMatch(/\d\d?:\d\d|\b(am|pm|UTC|ET)\b/i)
    expect(noteRawText('retention-lower-bound')).not.toMatch(/\d\d?:\d\d|\b(am|pm|UTC|ET)\b/i)
  })

  it('marks only the disjoint-groups caveat as never hideable', () => {
    expect(getNote('retention-disjoint')?.hideable).toBe(false)
    expect(getNote('retention-lower-bound')?.hideable).toBeUndefined()
    expect(getNote('engagement-per-arrival')?.hideable).toBeUndefined()
  })

  it('offers no split: no country, hour or device repeat or param anywhere in the card', async () => {
    const { PRESETS } = await import('../../lib/metrics/presets')
    for (const id of ['retention-verdict', 'campaign-engagement']) {
      const json = JSON.stringify(PRESETS[id])
      expect(json, id).not.toMatch(/countries|"country"|hourEt|device|"popup"/)
    }
  })

  it('is not a default: no default widget uses it', () => {
    expect(JSON.stringify(defaultWidgets())).not.toMatch(/retention-verdict|campaign-engagement/)
  })
})

describe('campaign-engagement (picker only)', () => {
  it('renders completions per arrival with its two inputs, and its caveat', async () => {
    const w = await mountNew('campaign-engagement')
    const text = norm(w.text())
    expect(text).toContain(RETEST)
    expect(text).toContain(noteRawText('label.campaign.engagementPerArrival'))
    expect(text).toContain(noteRawText('label.campaign.completions'))
    expect(text).toContain(noteRawText('label.campaign.returnD0'))
    expect((await noteLines(w)).join('\n')).toContain(noteRawText('engagement-per-arrival'))
  })
})
