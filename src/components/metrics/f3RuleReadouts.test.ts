// @vitest-environment happy-dom
//
// The `f3-rule-readouts` preset (Campaigns page, widget cw-f3-rules), rendered by MetricCard from one
// GET /api/ads/readings answer: one card per F3 arm, the newest stored F3 morning read's date,
// flight day and proposal, then rules 1-9 (rule, number, threshold, verdict). States: no F3 read
// yet, a filled read, and PROPOSE PAUSE in red (verdict and proposal cells). Also the pure scope
// pieces behind it (readingsScope.campaignF3ReadOf, the 'rules' repeat, scopeField / scopeTone).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { __resetReturnRefreshForTests } from '../../composables/useReturnRefresh'
import { fetchAdsReadings } from '../../api'
import { campaignById, STAGED_FLIGHT_3 } from '../../lib/campaigns'
import { F3_RULE_READOUTS, presetById } from '../../lib/metrics/presets'
import { campaignF3ReadOf } from '../../lib/metrics/readingsScope'
import { resolveRepeat, scopeField, scopeTone, usesF3Read, type ScopeInstance } from '../../lib/metrics/scope'
import { validateCard } from '../../lib/metrics/validate'
import { defaultCampaignsWidgets } from '../../lib/defaults'
import type { ReadingF3, ReadingRecord } from '../../lib/adsRules'

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return { ...actual, fetchAdsReadings: vi.fn() }
})
const mocked = vi.mocked(fetchAdsReadings)

const APPS = STAGED_FLIGHT_3.apps.ids.campaignId
const SEARCH = STAGED_FLIGHT_3.search.ids.campaignId
const PLAY = STAGED_FLIGHT_3.appsPlay.ids.campaignId

const readouts = (verdict2: ReadingF3['readouts'][number]['verdict']): ReadingF3['readouts'] => [
  { n: 1, name: 'Placement leak', number: '$0.40 on 1 placement', threshold: 'under $2 on any one', verdict: 'PASS' },
  { n: 2, name: 'CTR', number: '0.21%', threshold: 'at least 0.30%', verdict: verdict2 },
  { n: 5, name: 'Tracking check', number: 'day 2', threshold: null, verdict: 'NOT YET' },
  { n: 9, name: 'D+7 verdict', number: 'not until D+7', threshold: null, verdict: 'n/a' },
]
const f3 = (proposal: ReadingF3['proposal'], verdict2: ReadingF3['readouts'][number]['verdict'], flightDay = 2): ReadingF3 => ({ v: 1, arm: 'apps', flightDay, readouts: readouts(verdict2), proposal })
let n = 0
const rec = (campaignId: string, extra: Partial<ReadingRecord> = {}): ReadingRecord => ({
  v: 1,
  id: `r${++n}`,
  campaignId,
  kind: 'daily',
  readAt: '2026-10-19T12:05:00Z',
  etDate: '2026-10-19',
  spendThroughEt: '2026-10-18',
  cumulativeSpend: 18.4,
  thresholds: [],
  complete: true,
  rules: null,
  proposal: null,
  decision: null,
  counts: { taggedArrivals: 5 },
  notes: [],
  ...extra,
})
const camp = (campaignId: string, readings: ReadingRecord[]) => ({
  campaignId,
  label: campaignById(campaignId)?.label ?? campaignId,
  status: 'active',
  spend: { spend: 18.4, source: 'google-ads-api', fetchedAt: '2026-10-19T11:00:00Z', lastDate: '2026-10-18' },
  spendThrough: '2026-10-18',
  lastSync: '2026-10-19T11:30:00Z',
  stale: false,
  thresholdsFired: null,
  readings,
})
const serve = (campaigns: unknown[]) => mocked.mockResolvedValue({ generatedAt: '2026-10-19T12:10:00Z', storeBound: true, storeReadable: true, campaigns } as never)

async function settle() {
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
  }
}
const mounted: VueWrapper[] = []
async function newCard() {
  const w = mount(MetricCard, { props: { cardRef: { preset: 'f3-rule-readouts' } } })
  mounted.push(w)
  await settle()
  return w
}
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const blocks = (w: VueWrapper) =>
  w.findAll('.metric-card-grid > *').map((c) => {
    const tables = c.findAll('table')
    const rowsOf = (t: (typeof tables)[number] | undefined) => (t ? t.findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => squash(td.text()))) : [])
    const tonesOf = (t: (typeof tables)[number] | undefined) => (t ? t.findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => td.find('.mtc').classes().find((k) => k.startsWith('tone-'))?.slice(5) ?? null)) : [])
    return {
      label: squash(c.find('.mc-title').text()),
      tables: tables.map((t) => ({ heads: t.findAll('th').map((h) => squash(h.text())), rows: rowsOf(t), tones: tonesOf(t) })),
      empty: c.find('.metric-table-empty').exists() ? squash(c.find('.metric-table-empty').text()) : null,
    }
  })

beforeEach(() => {
  n = 0
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  vi.useFakeTimers({ now: Date.parse('2026-10-19T12:10:00Z') })
  mocked.mockReset()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results: {}, meta: { facts: 0, cacheHits: 0, statements: 0 } }) })))
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('f3-rule-readouts preset', () => {
  it('is a valid registered preset over the three F3 arms, on the Campaigns page defaults', () => {
    expect(presetById('f3-rule-readouts')).toBe(F3_RULE_READOUTS)
    expect(validateCard(F3_RULE_READOUTS)).toEqual([])
    expect(F3_RULE_READOUTS.repeat).toMatchObject({ over: 'campaigns', ids: [APPS, SEARCH, PLAY] })
    expect(usesF3Read(F3_RULE_READOUTS)).toBe(true)
    const wd = defaultCampaignsWidgets().find((x) => x.id === 'cw-f3-rules')
    expect(wd).toMatchObject({ card: { preset: 'f3-rule-readouts' }, x: 0, y: 88, w: 12 })
  })
})

describe('the card', () => {
  it('asks the readings endpoint deep enough to reach the daily read behind same-day rows', async () => {
    serve([camp(APPS, []), camp(SEARCH, []), camp(PLAY, [])])
    await newCard()
    expect(mocked).toHaveBeenCalled()
    expect(new URLSearchParams(mocked.mock.calls[0][0] as string).get('limit')).toBe('30')
  })
  it('empty: "No F3 read yet." per arm, no read or proposal row; an F2-era reading does not count', async () => {
    serve([camp(APPS, [rec(APPS)]), camp(SEARCH, []), camp(PLAY, [])])
    const w = await newCard()
    const b = blocks(w)
    expect(b.map((x) => x.label)).toEqual([campaignById(APPS)!.label, campaignById(SEARCH)!.label, campaignById(PLAY)!.label])
    for (const x of b) {
      expect(x.empty).toBe('No F3 read yet.')
      expect(x.tables.flatMap((t) => t.rows)).toEqual([])
    }
  })
  it('filled: the read date and flight day, the proposal, and each rule with number, threshold and verdict', async () => {
    serve([camp(APPS, [rec(APPS, { f3: f3('CONTINUE', 'PASS') })]), camp(SEARCH, []), camp(PLAY, [])])
    const [apps, search] = blocks(await newCard())
    expect(apps.empty).toBeNull()
    expect(apps.tables[0]).toMatchObject({ heads: ['Read (ET)', 'Proposal'], rows: [['Oct 19 · data through Oct 18 · flight day 2', 'CONTINUE']], tones: [[null, null]] })
    expect(apps.tables[1].heads).toEqual(['Rule', 'Number', 'Threshold', 'Verdict'])
    expect(apps.tables[1].rows).toEqual([
      ['1 · Placement leak', '$0.40 on 1 placement', 'under $2 on any one', 'PASS'],
      ['2 · CTR', '0.21%', 'at least 0.30%', 'PASS'],
      ['5 · Tracking check', 'day 2', '—', 'NOT YET'],
      ['9 · D+7 verdict', 'not until D+7', '—', 'n/a'],
    ])
    expect(apps.tables[1].tones.map((r) => r[3])).toEqual(['clear', 'clear', 'muted', 'muted'])
    expect(search.empty).toBe('No F3 read yet.')
  })
  it('PROPOSE PAUSE: red on the tripped verdict and on the proposal; the newest daily F3 read wins', async () => {
    const older = rec(APPS, { readAt: '2026-10-18T12:05:00Z', etDate: '2026-10-18', f3: f3('CONTINUE', 'PASS', 1) })
    const newest = rec(APPS, { proposal: 'PROPOSE PAUSE', f3: f3('PROPOSE PAUSE', 'PROPOSE PAUSE') })
    const threshold = rec(APPS, { kind: 'threshold', thresholds: [50] })
    serve([camp(APPS, [threshold, newest, older]), camp(SEARCH, []), camp(PLAY, [])])
    const [apps] = blocks(await newCard())
    expect(apps.tables[0].rows).toEqual([['Oct 19 · data through Oct 18 · flight day 2', 'PROPOSE PAUSE']])
    expect(apps.tables[0].tones).toEqual([[null, 'trip']])
    expect(apps.tables[1].rows[1]).toEqual(['2 · CTR', '0.21%', 'at least 0.30%', 'PROPOSE PAUSE'])
    expect(apps.tables[1].tones.map((r) => r[3])).toEqual(['clear', 'trip', 'muted', 'muted'])
  })
})

describe('scope pieces', () => {
  it('campaignF3ReadOf: the newest daily reading with f3; only rule text and proposal are copied', () => {
    expect(campaignF3ReadOf([])).toBeUndefined()
    expect(campaignF3ReadOf([rec(APPS)])).toBeUndefined()
    expect(campaignF3ReadOf([rec(APPS, { kind: 'threshold', f3: f3('CONTINUE', 'PASS') })])).toBeUndefined()
    const got = campaignF3ReadOf([rec(APPS, { f3: f3(null, 'PROPOSE PAUSE', 3) })])!
    expect(got).toEqual({ etDate: '2026-10-19', dataThrough: '2026-10-18', flightDay: 3, proposal: null, rules: readouts('PROPOSE PAUSE') })
    expect(JSON.stringify(got)).not.toContain('taggedArrivals')
  })
  it("a 'rules' repeat yields nothing outside a campaign; the not-serving proposal reads as a note", () => {
    expect(resolveRepeat({ over: 'rules' }, { todayEt: '2026-10-19' })).toEqual([])
    const read = campaignF3ReadOf([rec(APPS, { f3: f3(null, 'PROPOSE PAUSE') })])!
    const scope: ScopeInstance = { kind: 'campaign', campaign: campaignById(APPS)!, ads: { spendThrough: null, lastSync: null, stale: false, storeBound: true, thresholdsFired: null, loadedAtMs: 0, f3: read } }
    expect(scopeField(scope, 'campaign.f3Proposal')).toMatch(/not serving/)
    expect(scopeTone(scope, 'campaign.f3Proposal')).toBeNull()
    const rows = resolveRepeat({ over: 'rules' }, { todayEt: '2026-10-19' }, scope)
    expect(rows.map((r) => (r.kind === 'rule' ? r.rule.n : null))).toEqual([1, 2, 5, 9])
  })
})
