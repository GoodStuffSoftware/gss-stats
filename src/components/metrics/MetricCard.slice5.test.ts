// @vitest-environment happy-dom
//
// MetricCard, slice 5: freshness (header or footer) and reload, errors that say so, the one
// card-level Notes toggle, the click-through as its own control, following the page context,
// omitting a section every item of which is gated away, spend-only campaigns decided on the
// client, the ET day rolling over, and a preset id that is an Object.prototype member.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import type { CardSpec, MetricValue, MetricsRequestBody } from '../../lib/metrics/types'

const PLAY = '24234347705'
const RETEST = '24279250691'
const mounted: VueWrapper[] = []
const bodies: MetricsRequestBody[] = []
let answer: (req: MetricsRequestBody['requests'][number], body: MetricsRequestBody) => MetricValue = () => ({ status: 'ok', value: 42 })
let failNext = false

beforeEach(() => {
  __resetMetricsStateForTests()
  bodies.length = 0
  failNext = false
  answer = () => ({ status: 'ok', value: 42 })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as MetricsRequestBody
      bodies.push(body)
      if (failNext) return { ok: false, status: 503, json: async () => ({}) }
      const results = Object.fromEntries(body.requests.map((r) => [r.key, answer(r, body)]))
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
    }),
  )
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
async function settle() {
  for (let i = 0; i < 4; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 15))
  }
}
function mountCard(props: InstanceType<typeof MetricCard>['$props']) {
  const w = mount(MetricCard, { props })
  mounted.push(w)
  return w
}
const NOW = Date.parse('2026-09-27T16:00:00Z')

describe('MetricCard — preset lookup and structure', () => {
  it('an Object.prototype member as a preset id is an unknown card, not a crash', () => {
    for (const preset of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(mountCard({ cardRef: { preset } }).text()).toContain(`Unknown card preset "${preset}"`)
    }
  })

  it('the click-through is the title button; no role="button" wraps other controls', async () => {
    answer = (r) => (r.metric === 'campaign.taggedArrivals' ? { status: 'ok', value: 7, noteIds: ['arrivals-caveat'] } : { status: 'ok', value: 1 })
    const w = mountCard({ cardRef: { preset: 'campaign-scorecard' }, nowMs: NOW })
    await settle()
    expect(w.find('[role="button"]').exists()).toBe(false)
    await w.find('button.mc-title-link').trigger('click')
    expect(w.emitted('open-campaigns')).toHaveLength(1)
    await w.find('button.mc-notes-toggle').trigger('click')
    expect(w.emitted('open-campaigns')).toHaveLength(1) // the Notes toggle never opens the page
  })

  it('a section every item of which is gated away is omitted, title included', async () => {
    const spec: CardSpec = {
      v: 1,
      repeat: { over: 'campaigns', ids: ['24215315197'] }, // closed: unmeasured items are omitted
      sections: [
        { layout: 'rows', title: 'Kept', items: [{ id: 'a', label: { metric: true }, data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } }] },
        { layout: 'pills', title: 'Dropped', items: [{ id: 'c', label: { metric: true }, data: { metric: 'campaign.completions' }, display: { as: 'number' } }] },
      ],
    }
    answer = (r) => (r.metric === 'campaign.completions' ? { status: 'unmeasured', reason: 'not-live' } : { status: 'ok', value: 50 })
    const w = mountCard({ cardRef: { spec }, nowMs: NOW })
    await settle()
    expect(w.text()).toContain('Kept')
    expect(w.text()).not.toContain('Dropped')
    expect(w.findAll('.metric-section')).toHaveLength(1)
  })

  it('a row and a tile carry one accessible name: label, value and deltas', async () => {
    answer = () => ({ status: 'ok', value: 86, deltas: { yesterday: { delta: 31, deltaPct: 0.56 } } })
    const w = mountCard({ cardRef: { preset: 'bsk-kpis' }, nowMs: NOW })
    await settle()
    expect(w.find('.mi-tile').attributes('aria-label')).toBe('Page views: 86, vs yesterday +31 (+56%)')
  })

  it('a rate tile shows the rate big and its (n/d) as a small line under it', async () => {
    answer = (r) => (r.ratio === 'bsk.popupTapRate' ? { status: 'ok', value: 5 / 41, numerator: 5, denominator: 41 } : { status: 'ok', value: 1 })
    const w = mountCard({ cardRef: { preset: 'bsk-kpis' }, nowMs: NOW })
    await settle()
    const tile = w.findAll('.mi-tile').find((t) => t.find('.mi-tile-label').text() === 'Pop-up tap rate')!
    expect(tile.find('.mi-tile-num').text()).toBe('12.2%')
    expect(tile.find('.mi-tile-sub').text()).toBe('(5/41)')
  })
})

describe('MetricCard — card notes', () => {
  it('one Notes toggle per card, collapsed by default, listing "<label>: <caveat>"; no per-item toggles or caption lines', async () => {
    answer = (r) =>
      r.metric === 'campaign.taggedArrivals' ? { status: 'ok', value: 7, noteIds: ['arrivals-caveat'] } : r.metric === 'campaign.installs' ? { status: 'partial', value: 2, measuredFrom: 0, noteIds: ['install-fix-note'] } : { status: 'ok', value: 1 }
    const w = mountCard({ cardRef: { preset: 'campaign-scorecard', }, nowMs: NOW })
    await settle()
    const retest = w.findAll('.metric-card').find((c) => c.find('.mc-title').text() === 'US+CA web retest')!
    expect(w.find('.mi-notes-btn').exists()).toBe(false)
    expect(w.findAll('.mi-caption, .mi-tile-caption, .mi-pill-caption')).toHaveLength(0)
    const toggle = retest.find('button.mc-notes-toggle')
    expect(toggle.text()).toBe('Notes')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect((retest.find('.mc-notes').element as HTMLElement).style.display).toBe('none') // collapsed, but in the DOM for aria-controls
    await toggle.trigger('click')
    const lines = retest.findAll('.mc-notes li').map((li) => li.text().replace(/\s+/g, ' '))
    expect(lines[0]).toMatch(/^Tagged arrivals: Floor/)
    expect(lines.some((l) => /^Installs: install fix went live/.test(l))).toBe(true)
  })
})

describe('MetricCard — freshness and errors', () => {
  it("showUpdated 'header': \"Updated just now\" top-right above the tiles, and ↻ refetches the whole card fresh", async () => {
    const w = mountCard({ cardRef: { preset: 'bsk-kpis' }, nowMs: NOW })
    await settle()
    const head = w.find('.metric-card-plain > .mc-head')
    expect(head.find('.mc-updated').text()).toBe('Updated just now')
    expect(w.find('.mc-footer').exists()).toBe(false)
    const firstBatch = bodies[0].requests.length
    await head.find('button.mc-reload').trigger('click')
    await settle()
    const fresh = bodies.filter((b) => b.fresh)
    expect(fresh).toHaveLength(1)
    expect(fresh[0].requests).toHaveLength(firstBatch)
  })

  it("showUpdated 'footer' puts the same line under the card", async () => {
    const spec: CardSpec = { v: 1, showUpdated: 'footer', sections: [{ layout: 'tiles', items: [{ id: 'pv', label: { metric: true }, data: { metric: 'bsk.pageviews', window: 'todaySoFar' }, display: { as: 'number' } }] }] }
    const w = mountCard({ cardRef: { spec }, nowMs: NOW })
    await settle()
    expect(w.find('.mc-footer .mc-updated').text()).toBe('Updated just now')
    expect(w.find('.mc-head .mc-updated').exists()).toBe(false)
  })

  it('a card without showUpdated has no freshness line; reload() is exposed for ChartCard', async () => {
    const w = mountCard({ cardRef: { preset: 'campaign-scorecard' }, nowMs: NOW })
    await settle()
    expect(w.find('.mc-updated').exists()).toBe(false)
    ;(w.vm as unknown as { reload(): void }).reload()
    await settle()
    expect(bodies.some((b) => b.fresh)).toBe(true)
  })

  it('a failed reload: values read "unavailable", "Updated" gives way to an error line, and Retry recovers', async () => {
    const w = mountCard({ cardRef: { preset: 'bsk-kpis' }, nowMs: NOW })
    await settle()
    expect(w.find('.mc-updated').text()).toBe('Updated just now')
    failNext = true
    await w.find('button.mc-reload').trigger('click')
    await settle()
    expect(w.find('.mc-updated').exists()).toBe(false)
    expect(w.find('.mc-error').text()).toBe('Some numbers could not be loaded.')
    expect(w.find('.mi-tile-num').text()).toBe('unavailable')
    expect(w.find('.mi-tile-num').classes()).toContain('muted')
    failNext = false
    await w.find('button.mc-retry').trigger('click')
    await settle()
    expect(w.find('.mc-error').exists()).toBe(false)
    expect(w.find('.mi-tile-num').text()).toBe('42')
    expect(w.find('.mc-updated').text()).toBe('Updated just now')
  })

  it('a per-request server error on a card without showUpdated still shows the error line with Retry', async () => {
    answer = (r) => (r.metric === 'campaign.asks' ? { status: 'error', reason: 'fact-failed' } : { status: 'ok', value: 3 })
    const w = mountCard({ cardRef: { preset: 'campaign-scorecard' }, nowMs: NOW })
    await settle()
    expect(w.find('.mc-error').exists()).toBe(true)
    expect(w.find('button.mc-retry').exists()).toBe(true)
    expect(w.findAll('.mi-pill').some((p) => p.text() === 'Sign-in ask: unavailable')).toBe(true)
  })
})

describe('MetricCard — decided from config, on the client', () => {
  it('the spend-only campaign shows only its Flight row from the first render — no "…", never requested', async () => {
    const w = mountCard({ cardRef: { preset: 'campaign-scorecard' }, nowMs: NOW })
    const play = () => w.findAll('.metric-card').find((c) => c.find('.mc-title').text().startsWith('Play-direct'))!
    expect(play().findAll('.mi-row').map((r) => r.find('.mi-label').text())).toEqual(['Flight']) // before any fetch resolves
    expect(play().text()).not.toContain('…')
    await settle()
    expect(play().findAll('.mi-row').map((r) => r.find('.mi-label').text())).toEqual(['Flight'])
    expect(play().text()).not.toContain('not yet tracking')
    expect(bodies.flatMap((b) => b.requests).some((r) => r.params?.campaignId === PLAY)).toBe(false)
  })
})

describe('MetricCard — following the page context and the ET day', () => {
  it('a new range re-requests every item in one batch', async () => {
    const spec: CardSpec = { v: 1, sections: [{ layout: 'rows', items: [{ id: 'pv', label: { metric: true }, data: { metric: 'bsk.pageviews', window: 'page' }, display: { as: 'number' } }, { id: 'auth', label: { metric: true }, data: { metric: 'bsk.authSuccess', window: 'page' }, display: { as: 'number' } }] }] }
    answer = (_r, body) => ({ status: 'ok', value: body.context?.since?.startsWith('2026-09-01') ? 1 : 2 })
    const w = mountCard({ cardRef: { spec }, nowMs: NOW, context: { since: '2026-09-01T04:00:00.000Z', until: '2026-09-08T04:00:00.000Z' } })
    await settle()
    expect(w.findAll('.mi-value').map((v) => v.text())).toEqual(['1', '1'])
    const before = bodies.length
    await w.setProps({ context: { since: '2026-09-10T04:00:00.000Z', until: '2026-09-17T04:00:00.000Z' } })
    await settle()
    const after = bodies.slice(before)
    expect(after).toHaveLength(1)
    expect(after[0].context?.since).toBe('2026-09-10T04:00:00.000Z')
    expect(w.findAll('.mi-value').map((v) => v.text())).toEqual(['2', '2'])
  })

  // The retest's last serving day is 2026-10-02 (ET). 23:59 ET that day is 03:59Z on the 3rd.
  const LAST_MINUTE = Date.parse('2026-10-03T03:59:00Z')
  const FIRST_MINUTE = Date.parse('2026-10-03T04:01:00Z')

  it('across midnight into 2026-10-03: the flight-ended tiles and badges change, and "today so far" is re-requested', async () => {
    let day = 'before'
    answer = () => ({ status: 'ok', value: day === 'before' ? 100 : 3 })
    const kpis = mountCard({ cardRef: { preset: 'bsk-kpis' }, nowMs: LAST_MINUTE })
    const cards = mountCard({ cardRef: { preset: 'campaign-scorecard' }, nowMs: LAST_MINUTE })
    await settle()
    expect(kpis.findAll('.mi-tile-label').map((l) => l.text())).toContain('Tagged arrivals — US+CA web retest')
    const badge = () => cards.findAll('.metric-card').find((c) => c.find('.mc-title').text() === 'US+CA web retest')!.find('.mc-badge').text()
    expect(badge()).toBe('flighting today')
    expect(kpis.find('.mi-tile-num').text()).toBe('100')

    day = 'after'
    const before = bodies.length
    await kpis.setProps({ nowMs: FIRST_MINUTE })
    await cards.setProps({ nowMs: FIRST_MINUTE })
    await settle()
    expect(kpis.findAll('.mi-tile-label').map((l) => l.text())).not.toContain('Tagged arrivals — US+CA web retest')
    expect(kpis.find('.mp-tile-text').text()).toBe('no campaign flighting today')
    expect(badge()).toBe('active')
    const todaySoFar = bodies.slice(before).flatMap((b) => b.requests).filter((r) => r.window === 'todaySoFar')
    expect(todaySoFar.some((r) => r.metric === 'bsk.pageviews')).toBe(true)
    expect(todaySoFar.some((r) => r.params?.campaignId === RETEST)).toBe(false)
    expect(kpis.find('.mi-tile-num').text()).toBe('3') // today's value, not yesterday's entry
  })

  it('the day rolls over on the clock alone, without the nowMs seam', async () => {
    vi.useFakeTimers({ now: LAST_MINUTE + 50_000, toFake: ['Date', 'setInterval', 'clearInterval'] })
    const kpis = mountCard({ cardRef: { preset: 'bsk-kpis' } })
    await settle()
    expect(kpis.findAll('.mi-tile-label').map((l) => l.text())).toContain('Tagged arrivals — US+CA web retest')
    vi.setSystemTime(FIRST_MINUTE)
    vi.advanceTimersByTime(15_000) // the card's clock tick
    await settle()
    expect(kpis.find('.mp-tile-text').text()).toBe('no campaign flighting today')
  })
})

describe('MetricCard — verification fixes', () => {
  const untitled = (showUpdated?: CardSpec['showUpdated']): CardSpec => ({
    v: 1,
    ...(showUpdated !== undefined ? { showUpdated } : {}),
    sections: [{ layout: 'tiles', items: [{ id: 'pv', label: { metric: true }, data: { metric: 'bsk.pageviews', window: 'todaySoFar' }, display: { as: 'number' } }] }],
  })

  it("an untitled footer card whose reload fails keeps Retry visible, and Retry recovers", async () => {
    const w = mountCard({ cardRef: { spec: untitled('footer') }, nowMs: NOW })
    await settle()
    expect(w.find('.mc-footer .mc-updated').text()).toBe('Updated just now')
    failNext = true
    await w.find('.mc-footer button.mc-reload').trigger('click')
    await settle()
    expect(w.find('.mc-footer .mc-error').text()).toBe('Some numbers could not be loaded.')
    const retry = w.find('.mc-footer button.mc-retry')
    expect(retry.exists()).toBe(true)
    failNext = false
    await retry.trigger('click')
    await settle()
    expect(w.find('.mc-error').exists()).toBe(false)
    expect(w.find('.mc-footer .mc-updated').text()).toBe('Updated just now')
    expect(w.find('.mi-tile-num').text()).toBe('42')
  })

  it('an untitled card with no freshness line, no badge and no notes still shows its error line', async () => {
    answer = () => ({ status: 'error', reason: 'fact-failed' })
    const w = mountCard({ cardRef: { spec: untitled() }, nowMs: NOW })
    await settle()
    expect(w.find('.mc-head .mc-error').text()).toBe('Some numbers could not be loaded.')
    expect(w.find('button.mc-retry').exists()).toBe(true)
  })

  it('the live region is in the DOM, empty, from mount, and is filled when a value fails', async () => {
    answer = (r) => (r.metric === 'bsk.pageviews' && bodies.length > 1 ? { status: 'error', reason: 'fact-failed' } : { status: 'ok', value: 1 })
    const w = mountCard({ cardRef: { preset: 'bsk-kpis' }, nowMs: NOW })
    const live = () => w.find('[role="status"]')
    expect(live().exists()).toBe(true)
    expect(live().text()).toBe('')
    expect(live().attributes('aria-live')).toBe('polite')
    await settle()
    expect(live().text()).toBe('')
    w.findComponent(MetricCard).vm.reload()
    await settle()
    expect(live().text()).toBe('Some numbers could not be loaded.')
    expect(w.findAll('[role="status"]')).toHaveLength(1) // the visible error line is not a second region
  })

  it('a status word in a pill is muted, not styled as a value', async () => {
    answer = (r) => (r.metric === 'campaign.asks' ? { status: 'error', reason: 'fact-failed' } : { status: 'ok', value: 3 })
    const w = mountCard({ cardRef: { preset: 'campaign-scorecard' }, nowMs: NOW })
    await settle()
    const ask = w.findAll('.mi-pill').find((p) => p.text().startsWith('Sign-in ask'))!
    expect(ask.find('.mi-pill-value').text()).toBe('unavailable')
    expect(ask.find('.mi-pill-value').classes()).toContain('muted')
    const auth = w.findAll('.mi-pill').find((p) => p.text().startsWith('Auth success'))!
    expect(auth.find('.mi-pill-value').classes()).not.toContain('muted')
  })

  it('each Notes toggle names its card and controls its list', async () => {
    answer = (r) => (r.metric === 'campaign.taggedArrivals' ? { status: 'ok', value: 7, noteIds: ['arrivals-caveat'] } : { status: 'ok', value: 1 })
    const w = mountCard({ cardRef: { preset: 'campaign-scorecard' }, nowMs: NOW })
    await settle()
    const toggles = w.findAll('button.mc-notes-toggle')
    expect(toggles.map((t) => t.attributes('aria-label'))).toContain('Notes: US+CA web retest')
    const ids = new Set<string>()
    for (const t of toggles) {
      const id = t.attributes('aria-controls')!
      expect(w.find(`#${id}`).exists(), id).toBe(true)
      ids.add(id)
    }
    expect(ids.size).toBe(toggles.length) // one list per card
  })

  it('an untitled card\'s toggle is plain "Notes"', async () => {
    answer = () => ({ status: 'ok', value: 1, noteIds: ['arrivals-caveat'] })
    const w = mountCard({ cardRef: { preset: 'bsk-kpis' }, nowMs: NOW })
    await settle()
    expect(w.find('button.mc-notes-toggle').attributes('aria-label')).toBe('Notes')
  })

  it('a day when only a spend-only campaign flights: the arrivals placeholder says why, and nothing is requested for it', async () => {
    const w = mountCard({ cardRef: { preset: 'bsk-kpis' }, nowMs: Date.parse('2026-09-11T16:00:00Z') })
    await settle()
    expect(w.find('.mp-tile-label').text()).toBe('Tagged arrivals')
    expect(w.find('.mp-tile-text').text()).toBe('no beacon-tracked campaign flighting today')
    expect(bodies.flatMap((b) => b.requests).some((r) => r.params?.campaignId === PLAY)).toBe(false)
  })

  it('"not started": the retest before its 12:00 ET start reads a muted "not started" on its card', async () => {
    answer = (r) => (r.params?.campaignId === RETEST ? { status: 'unmeasured', reason: 'not-started', noteIds: ['not-started'] } : { status: 'ok', value: 1 })
    const w = mountCard({ cardRef: { preset: 'campaign-scorecard' }, nowMs: Date.parse('2026-09-26T15:59:00Z') })
    await settle()
    const retest = w.findAll('.metric-card').find((c) => c.find('.mc-title').text() === 'US+CA web retest')!
    const arrivals = retest.findAll('.mi-row').find((r) => r.find('.mi-label').text() === 'Tagged arrivals')!
    expect(arrivals.find('.mi-value').text()).toBe('not started')
    expect(arrivals.find('.mi-value').classes()).toContain('muted')
    expect(retest.text()).not.toContain('not yet tracking')
  })
})
