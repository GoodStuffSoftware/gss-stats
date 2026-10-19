// @vitest-environment happy-dom
//
// The Flight 3 per-arm daily card (preset `campaign-f3-daily`, Campaigns widget cw-f3-daily) and the
// Cost card additions (average CPC, cost per completed game, the auth-success caption), rendered by
// MetricCard from a stubbed POST /api/metrics. States: no arm registered (the staged state: the card
// says so and asks for nothing), live arms (a sparkline per row with its ET days listed), and the
// Cost card's new rows. Counts-only: every request is a per-day series on a campaign id and nothing
// else (no country, hour, place or device), and the days line carries a date and a count only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { __resetReturnRefreshForTests } from '../../composables/useReturnRefresh'
import { campaignById, STAGED_FLIGHT_3 } from '../../lib/campaigns'
import { defaultCampaignsWidgets } from '../../lib/defaults'
import { markedChanges } from '../../lib/measurementChanges'
import { CAMPAIGN_COST, CAMPAIGN_F3_DAILY, presetById } from '../../lib/metrics/presets'
import { seriesDaysText, SERIES_DAYS_LISTED } from '../../lib/metrics/render'
import { validateCard } from '../../lib/metrics/validate'
import type { CardSpec, MetricsResponseBody } from '../../lib/metrics/types'

const APPS = STAGED_FLIGHT_3.apps.ids.campaignId
const SEARCH = STAGED_FLIGHT_3.search.ids.campaignId
const PLAY = STAGED_FLIGHT_3.appsPlay.ids.campaignId
const LIVE = '24279250691' // a registered flight standing in for a live F3 arm
const NOW = Date.parse('2026-10-19T12:10:00Z')

interface Sent {
  key: string
  metric?: string
  ratio?: string
  params?: Record<string, unknown>
  series?: string
  window?: string
}
let sent: Sent[] = []
type Answer = (r: Sent) => MetricsResponseBody['results'][string]
function stubMetrics(answer: Answer) {
  sent = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { requests: Sent[] }
      const results: MetricsResponseBody['results'] = {}
      for (const r of body.requests) {
        sent.push(r)
        results[r.key] = answer(r)
      }
      return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 1, cacheHits: 0, statements: 1 } }) }
    }),
  )
}
const SERIES: Record<string, { day: string; value: number }[]> = {
  'campaign.completions': [
    { day: '2026-10-17', value: 12 },
    { day: '2026-10-18', value: 9 },
  ],
  'campaign.f3Asks': [
    { day: '2026-10-17', value: 7 },
    { day: '2026-10-18', value: 0 },
  ],
  'campaign.newAccounts': [
    { day: '2026-10-17', value: 2 },
    { day: '2026-10-18', value: 3 },
  ],
}
const seriesAnswer: Answer = (r) => {
  const s = SERIES[r.metric ?? '']
  return s ? { status: 'ok', value: s.reduce((a, p) => a + p.value, 0), series: s } : { status: 'ok', value: 1 }
}

async function settle() {
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
  }
}
const mounted: VueWrapper[] = []
async function mountCard(cardRef: InstanceType<typeof MetricCard>['$props']['cardRef']) {
  const w = mount(MetricCard, { props: { cardRef, nowMs: NOW } })
  mounted.push(w)
  await settle()
  return w
}
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const livePinned = (): CardSpec => ({ ...CAMPAIGN_F3_DAILY, repeat: { ...CAMPAIGN_F3_DAILY.repeat!, ids: [LIVE] } })

beforeEach(() => {
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  vi.useFakeTimers({ now: NOW })
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('campaign-f3-daily preset', () => {
  it('is a valid registered preset over the three staged F3 arms, on the Campaigns page defaults', () => {
    expect(presetById('campaign-f3-daily')).toBe(CAMPAIGN_F3_DAILY)
    expect(validateCard(CAMPAIGN_F3_DAILY)).toEqual([])
    expect(CAMPAIGN_F3_DAILY.repeat).toMatchObject({ over: 'campaigns', ids: [APPS, SEARCH, PLAY] })
    const wd = defaultCampaignsWidgets().find((x) => x.id === 'cw-f3-daily')
    expect(wd).toMatchObject({ card: { preset: 'campaign-f3-daily' }, x: 0, y: 102, w: 12 })
  })
  it('three rows: completed games, F3 sign-in asks, new accounts, each a daily series with its days listed', () => {
    const items = CAMPAIGN_F3_DAILY.sections[0].items
    expect(items.map((i) => ('metric' in i.data ? i.data.metric : null))).toEqual(['campaign.completions', 'campaign.f3Asks', 'campaign.newAccounts'])
    for (const i of items) expect(i.display).toEqual({ as: 'sparkline', series: 'daily', days: true })
  })
  it('a days flag only means true, and only on a sparkline', () => {
    const bad = JSON.parse(JSON.stringify(CAMPAIGN_F3_DAILY)) as CardSpec
    ;(bad.sections[0].items[0].display as { days?: unknown }).days = false
    expect(validateCard(bad).join(' ')).toMatch(/days must be true/)
  })
})

describe('seriesDaysText: the days line', () => {
  it('lists each ET day with its count, oldest first, joined by a middle dot', () => {
    expect(seriesDaysText([{ day: '2026-10-17', value: 12 }, { day: '2026-10-18', value: 9 }], false)).toBe('Oct 17 12 · Oct 18 9')
  })
  it('a zero day is listed as 0 (a measured quiet day, not a gap)', () => {
    expect(seriesDaysText([{ day: '2026-10-17', value: 0 }], false)).toBe('Oct 17 0')
  })
  it('only the latest SERIES_DAYS_LISTED days', () => {
    const series = Array.from({ length: SERIES_DAYS_LISTED + 6 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, value: i }))
    const text = seriesDaysText(series, false).split(' · ')
    expect(text).toHaveLength(SERIES_DAYS_LISTED)
    expect(text[0]).toBe('Oct 7 6')
    expect(text[text.length - 1]).toBe('Oct 20 19')
  })
  it('a spend series is shown in dollars', () => {
    expect(seriesDaysText([{ day: '2026-10-17', value: 5.25 }], true)).toBe('Oct 17 $5.25')
  })
  it('nothing but a date and a count per entry: no hour, place or device word', () => {
    for (const part of seriesDaysText([{ day: '2026-10-17', value: 4 }, { day: '2026-10-18', value: 8 }], false).split(' · ')) expect(part).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d+$/)
  })
})

describe('the card, with no arm registered (the staged state)', () => {
  const unregistered = (): CardSpec => ({ ...CAMPAIGN_F3_DAILY, repeat: { ...CAMPAIGN_F3_DAILY.repeat!, ids: ['99999999999'] } })
  it('says Flight 3 has not started, shows no rows and asks the metrics endpoint for nothing', async () => {
    stubMetrics(seriesAnswer)
    const w = await mountCard({ spec: unregistered() })
    expect(squash(w.text())).toContain('Flight 3 has not started')
    expect(w.findAll('.metric-item')).toHaveLength(0)
    expect(w.findAll('.mi-days')).toHaveLength(0)
    expect(sent).toEqual([])
  })
})

describe('the card, on the real F3 arms', () => {
  it('one card per registered arm: the Apps, Search and Apps play arms, each with its three rows', async () => {
    stubMetrics(seriesAnswer)
    const w = await mountCard({ preset: 'campaign-f3-daily' })
    const titles = w.findAll('.mc-title').map((t) => squash(t.text()))
    expect(titles).toEqual([campaignById(APPS)!.label, campaignById(SEARCH)!.label, campaignById(PLAY)!.label])
    expect(w.findAll('.metric-item')).toHaveLength(9)
    expect(new Set(sent.map((r) => String(r.params?.campaignId)))).toEqual(new Set([APPS, SEARCH, PLAY]))
  })
})

describe('the card, with a live arm', () => {
  it('lists the days of each of the three series under its row', async () => {
    stubMetrics(seriesAnswer)
    const w = await mountCard({ spec: livePinned() })
    expect(w.findAll('.metric-card')).toHaveLength(1)
    const rows = w.findAll('.metric-item').map((m) => ({ label: squash(m.find('.mi-label').text()), value: squash(m.find('.mi-value').text()), days: squash(m.find('.mi-days').text()) }))
    expect(rows).toEqual([
      { label: 'Completed games', value: '21', days: 'Oct 17 12 · Oct 18 9' },
      { label: 'Sign-in asks (flight 3)', value: '7', days: 'Oct 17 7 · Oct 18 0' },
      { label: 'New accounts', value: '5', days: 'Oct 17 2 · Oct 18 3' },
    ])
  })
  it('draws a sparkline per row', async () => {
    stubMetrics(seriesAnswer)
    const w = await mountCard({ spec: livePinned() })
    expect(w.findAll('.mi-spark')).toHaveLength(3)
  })
  it('counts only: every request is a daily series on the campaign id alone', async () => {
    stubMetrics(seriesAnswer)
    await mountCard({ spec: livePinned() })
    const mine = sent.filter((r) => String(r.params?.campaignId) === LIVE)
    expect(mine.map((r) => r.metric).sort()).toEqual(['campaign.completions', 'campaign.f3Asks', 'campaign.newAccounts'])
    for (const r of mine) {
      expect(r.series).toBe('daily')
      expect(Object.keys(r.params ?? {})).toEqual(['campaignId'])
    }
  })
  it('a series that is not there yet (no points) lists no days but keeps the row', async () => {
    stubMetrics(() => ({ status: 'ok', value: 0 }))
    const w = await mountCard({ spec: livePinned() })
    expect(w.findAll('.metric-item')).toHaveLength(3)
    expect(w.findAll('.mi-days')).toHaveLength(0)
  })
})

describe('the Cost card additions', () => {
  it('carries the average CPC and cost per completed game rows and the auth-success caption', () => {
    const ids = CAMPAIGN_COST.sections[0].items.map((i) => i.id)
    expect(ids).toEqual(expect.arrayContaining(['cpa', 'cps', 'cpc', 'cpg']))
    expect(CAMPAIGN_COST.sections[0].items.find((i) => i.id === 'cpc')!.data).toEqual({ ratio: 'campaign.avgCpc' })
    expect(CAMPAIGN_COST.sections[0].items.find((i) => i.id === 'cpg')!.data).toEqual({ ratio: 'campaign.costPerComplete' })
    expect(CAMPAIGN_COST.captions).toEqual(['cost-per-signin-approx'])
    expect(validateCard(CAMPAIGN_COST)).toEqual([])
  })
  const costAnswer: Answer = (r) => {
    if (r.ratio === 'campaign.avgCpc') return { status: 'ok', value: 0.5, numerator: 10, denominator: 20 }
    if (r.ratio === 'campaign.costPerComplete') return { status: 'ok', value: 1.25, numerator: 10, denominator: 8 }
    if (r.ratio) return { status: 'ok', value: 2, numerator: 10, denominator: 5 }
    return { status: 'ok', value: 10 }
  }
  const pinned = (): CardSpec => ({ ...CAMPAIGN_COST, repeat: { over: 'campaigns', ids: [LIVE] } })

  it('shows Average CPC and Cost / completed game as dollars', async () => {
    stubMetrics(costAnswer)
    const w = await mountCard({ spec: pinned() })
    const rows = new Map(w.findAll('.mi-row').map((r) => [squash(r.find('.mi-label').text()), squash(r.find('.mi-value').text())]))
    expect(rows.get('Average CPC')).toBe('$0.50')
    expect(rows.get('Cost / completed game')).toBe('$1.25')
  })
  it('asks for the two ratios against the campaign id alone, in the attribution window', async () => {
    stubMetrics(costAnswer)
    await mountCard({ spec: pinned() })
    for (const id of ['campaign.avgCpc', 'campaign.costPerComplete']) {
      const r = sent.filter((x) => x.ratio === id)
      expect(r, id).toHaveLength(1)
      expect(r[0].params).toEqual({ campaignId: LIVE })
      expect(r[0].series).toBeUndefined()
    }
  })
  it('a ratio with no data (hand-entered spend has no clicks) reads a dash, never a figure', async () => {
    stubMetrics((r) => (r.ratio === 'campaign.avgCpc' ? { status: 'no-data', value: null } : costAnswer(r)))
    const w = await mountCard({ spec: pinned() })
    const rows = new Map(w.findAll('.mi-row').map((r) => [squash(r.find('.mi-label').text()), squash(r.find('.mi-value').text())]))
    expect(rows.get('Average CPC')).toBe('—')
    expect(rows.get('Cost / completed game')).toBe('$1.25')
  })
  it('the caption under the card says the cost per auth success counts all auth successes and is approximate from v1.99.2', async () => {
    stubMetrics(costAnswer)
    const w = await mountCard({ spec: pinned() })
    const text = squash(w.find('.mc-captions').text())
    expect(text).toContain('Cost per auth success divides spend by all auth successes, not only new accounts.')
    const since = markedChanges().find((c) => c.id === 'v1.99.2')!
    expect(text).toContain(`From ${since.dateEt} (v1.99.2)`)
    expect(text).toContain('approximate')
  })
})
