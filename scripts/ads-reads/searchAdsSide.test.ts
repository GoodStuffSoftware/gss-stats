// Flight 3 Search, Ads side: the GAQL the client sends, and the block, the readout and the Spend
// line's average CPC in the morning report. Synthetic fixtures only: no network, no credentials.
import { describe, expect, it } from 'vitest'
import { fixtureDeps, type Fixture } from './cli'
import { runMorningRead, type MorningOptions } from './read'
import { formatMorningReport } from './report'
import { fetchSearchDaily, fetchSearchKeywords, fetchSearchRange, searchDailyQuery, searchKeywordQuery, searchRangeQuery, type AdsClient } from '../../src/lib/adsApi'
import { MIN_COHORT } from '../../src/lib/popupEvents'
import type { SearchSideRaw } from '../../src/lib/searchAdsSide'

const F3_SEARCH = '24358792551'
const F3_APPS = '24358792494'
const opts = (campaignId: string): MorningOptions => ({ campaignId, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 })

const fakeClient = (rows: any[][]): AdsClient & { queries: string[] } => {
  const queries: string[] = []
  return {
    queries,
    async search(q: string) {
      queries.push(q)
      return rows[queries.length - 1] ?? []
    },
  }
}

describe('the Search Ads-side GAQL', () => {
  it('daily and range are campaign-level, the range has no date segment, and both ask for the three shares', () => {
    const d = searchDailyQuery(F3_SEARCH, '2026-10-17', '2026-10-18')
    const r = searchRangeQuery(F3_SEARCH, '2026-10-17', '2026-10-18')
    for (const q of [d, r]) {
      expect(q).toMatch(/^SELECT /)
      expect(q).toContain('FROM campaign WHERE')
      expect(q).toContain(`campaign.id = ${F3_SEARCH}`)
      expect(q).toContain("segments.date BETWEEN '2026-10-17' AND '2026-10-18'")
      for (const f of ['metrics.search_impression_share', 'metrics.search_rank_lost_impression_share', 'metrics.search_budget_lost_impression_share', 'metrics.average_cpc', 'metrics.clicks', 'metrics.cost_micros']) expect(q).toContain(f)
    }
    expect(d).toContain('SELECT segments.date,')
    expect(d).toMatch(/ORDER BY segments\.date$/)
    expect(r).not.toContain('SELECT segments.date')
    expect(r).not.toContain('ORDER BY')
  })
  it('keyword_view carries impression share and lost-to-rank but NOT lost-to-budget (the API refuses it there)', () => {
    const q = searchKeywordQuery(F3_SEARCH, '2026-10-17', '2026-10-18')
    expect(q).toMatch(/^SELECT /)
    expect(q).toContain('FROM keyword_view WHERE')
    expect(q).toContain('ad_group_criterion.keyword.text')
    expect(q).toContain('ad_group_criterion.keyword.match_type')
    expect(q).toContain('metrics.search_impression_share')
    expect(q).toContain('metrics.search_rank_lost_impression_share')
    expect(q).not.toContain('budget_lost')
    expect(q).toContain('ad_group_criterion.negative = false')
    expect(q).toContain("ad_group_criterion.status != 'REMOVED'")
    expect(q).not.toContain('segments.date,')
  })
  it('the fetchers send exactly those queries, read-only, and map the REST camelCase rows with sentinels left raw', async () => {
    const c = fakeClient([
      [{ segments: { date: '2026-10-17' }, metrics: { impressions: '40', clicks: '2', costMicros: '2000000', averageCpc: 1000000, searchImpressionShare: 0.0999, searchRankLostImpressionShare: '--' } }],
      [{ metrics: { impressions: '40', clicks: '2', costMicros: '2000000', averageCpc: 1000000, searchImpressionShare: 0.4, searchRankLostImpressionShare: 0.5, searchBudgetLostImpressionShare: 0.1 } }],
      [{ adGroupCriterion: { keyword: { text: 'free', matchType: 'BROAD' } }, metrics: { impressions: '9', clicks: '1', averageCpc: 450000, searchImpressionShare: 0.2 } }, { metrics: {} }],
    ])
    const daily = await fetchSearchDaily(c, F3_SEARCH, '2026-10-17', '2026-10-18')
    const range = await fetchSearchRange(c, F3_SEARCH, '2026-10-17', '2026-10-18')
    const kws = await fetchSearchKeywords(c, F3_SEARCH, '2026-10-17', '2026-10-18')
    expect(c.queries).toEqual([searchDailyQuery(F3_SEARCH, '2026-10-17', '2026-10-18'), searchRangeQuery(F3_SEARCH, '2026-10-17', '2026-10-18'), searchKeywordQuery(F3_SEARCH, '2026-10-17', '2026-10-18')])
    expect(daily).toEqual([{ date: '2026-10-17', impressions: 40, clicks: 2, costMicros: 2_000_000, avgCpcMicros: 1_000_000, impressionShare: 0.0999, rankLost: '--', budgetLost: null }])
    expect(range).toMatchObject({ impressionShare: 0.4, rankLost: 0.5, budgetLost: 0.1 })
    expect(kws).toEqual([{ text: 'free', matchType: 'BROAD', impressions: 9, clicks: 1, avgCpcMicros: 450_000, impressionShare: 0.2, rankLost: null }])
  })
  it('refuses a campaign the registry does not know, before any query', async () => {
    const c = fakeClient([])
    await expect(fetchSearchDaily(c, '1', '2026-10-17', '2026-10-18')).rejects.toThrow()
    expect(c.queries).toEqual([])
  })
})

const base = (now: string, campaignId: string, searchSide?: SearchSideRaw): Fixture => ({
  now,
  ads: {
    status: { id: campaignId, name: 'fixture', status: 'ENABLED', servingStatus: 'SERVING', primaryStatus: 'ELIGIBLE', dailyBudget: 10 },
    daily: {
      '2026-10-17': { costMicros: 8_000_000, impressions: 400, clicks: 9 },
      '2026-10-18': { costMicros: 9_500_000, impressions: 500, clicks: 11 },
      '2026-10-19': { costMicros: 0, impressions: 0, clicks: 0 },
    },
    placements: [],
    ...(searchSide ? { searchSide } : {}),
  },
  beacon: { tagged: [{ hour: '2026-10-17T17:00:00Z', path: '/', visitor: 'new', count: 9 }], siteEvents: [], returns: [], returnSites: [] },
  store: {},
})
const side = (over: Partial<SearchSideRaw['cumulative'] & object> = {}): SearchSideRaw => ({
  daily: [
    { date: '2026-10-17', impressions: 400, clicks: 9, costMicros: 8_000_000, avgCpcMicros: 888_889, impressionShare: 0.42, rankLost: 0.5, budgetLost: 0 },
    { date: '2026-10-18', impressions: 500, clicks: 11, costMicros: 9_500_000, avgCpcMicros: 863_636, impressionShare: 0.0999, rankLost: 0.9001, budgetLost: null },
  ],
  cumulative: { impressions: 900, clicks: 20, costMicros: 17_500_000, avgCpcMicros: 875_000, impressionShare: 0.3, rankLost: 0.45, budgetLost: 0.1, ...over },
  keywords: [{ text: 'sudoku app', matchType: 'PHRASE', impressions: 200, clicks: 8, avgCpcMicros: 900_000, impressionShare: 0.25, rankLost: 0.4 }],
  keywordsError: null,
})
const run = async (fx: Fixture, campaignId: string) => formatMorningReport(await runMorningRead(fixtureDeps(fx, true), opts(campaignId))).split('\n')

describe('the morning read, Search arm', () => {
  it('flight day 3 prints the Ads-side block, the readout line and HOLD, between the F3 rules and Thresholds', async () => {
    const out = await run(base('2026-10-19T12:05:00Z', F3_SEARCH, side()), F3_SEARCH)
    const head = out.findIndex((l) => l.startsWith('Search Ads side (Google Ads only'))
    expect(head).toBeGreaterThan(out.findIndex((l) => l.startsWith('F3 rules')))
    expect(head).toBeLessThan(out.findIndex((l) => l.startsWith('Thresholds:')))
    expect(out).toContain('  2026-10-17: 400 impr, 9 clicks, avg CPC $0.89, impression share 42%, lost to rank 50%, lost to budget 0%')
    expect(out).toContain('  2026-10-18: 500 impr, 11 clicks, avg CPC $0.86, impression share <10%, lost to rank >90%, lost to budget n/a')
    expect(out).toContain('Search: 10.0 clicks/day, avg CPC $0.88, lost to rank 45% → bid-limited')
    expect(out).toContain('HOLD $0.99')
    expect(out.some((l) => l.includes('by keyword') && l.includes('keyword_view'))).toBe(true)
  })
  it('day 3 can propose the raise (under 2 clicks a day, rank-lost 50%+)', async () => {
    const out = await run(base('2026-10-19T12:05:00Z', F3_SEARCH, side({ clicks: 3, costMicros: 3_000_000, rankLost: 0.8 })), F3_SEARCH)
    expect(out).toContain('Search: 1.5 clicks/day, avg CPC $1.00, lost to rank 80% → bid-limited')
    expect(out).toContain("PROPOSE: raise the 'app' keywords only to $1.25 max CPC (Mike decides)")
    expect(out).not.toContain('HOLD $0.99')
  })
  it('flight day 2 prints NOT YET for the readout (the block itself still prints)', async () => {
    const fx = base('2026-10-18T12:05:00Z', F3_SEARCH, side())
    const out = await run(fx, F3_SEARCH)
    expect(out).toContain('Search: NOT YET (flight day 2; the readout starts on flight day 3)')
    expect(out.some((l) => l.startsWith('PROPOSE') || l.startsWith('HOLD $'))).toBe(false)
  })
  it('before the flight (today 2026-10-16) nothing is queried: NOT YET, no data, no Ads error', async () => {
    const fx = base('2026-10-16T14:00:00Z', F3_SEARCH)
    let called = 0
    const deps = fixtureDeps(fx, true)
    deps.ads = { ...deps.ads!, searchSide: async () => (called++, side()) }
    const result = await runMorningRead(deps, opts(F3_SEARCH))
    const out = formatMorningReport(result).split('\n')
    expect(called).toBe(0)
    expect(out).toContain('Search: NOT YET (flight day 0; the readout starts on flight day 3)')
    expect(out.some((l) => l.includes('no closed flight day yet'))).toBe(true)
    expect(result.errors.filter((e) => /search/i.test(e))).toEqual([])
  })
  it('an Ads source without the search pull says NOT READ and never fails the read', async () => {
    const result = await runMorningRead(fixtureDeps(base('2026-10-19T12:05:00Z', F3_SEARCH), true), opts(F3_SEARCH))
    const out = formatMorningReport(result).split('\n')
    expect(out).toContain('Search Ads side (Google Ads only): NOT READ (not supported by this Ads source)')
    expect(out).toContain('Search: n/a (the Ads read failed)')
    expect(result.failures).toEqual([])
  })
  it('a search pull that throws is carried in the block, redacted, and does not fail the read', async () => {
    const deps = fixtureDeps(base('2026-10-19T12:05:00Z', F3_SEARCH), true)
    deps.ads = { ...deps.ads!, searchSide: async () => { throw new Error('boom') } }
    const result = await runMorningRead(deps, opts(F3_SEARCH))
    expect(formatMorningReport(result)).toContain('Search Ads side (Google Ads only): NOT READ (boom')
    expect(result.failures).toEqual([])
  })
  it('the Spend line carries the average CPC and the Search baseline', async () => {
    const out = await run(base('2026-10-19T12:05:00Z', F3_SEARCH, side()), F3_SEARCH)
    const spend = out.indexOf(out.find((l) => l.startsWith('Spend (Google Ads API'))!)
    // yesterday 10-18: $9.50 / 11 clicks; cumulative $17.50 / 20 clicks
    expect(out[spend + 2]).toBe('  avg CPC (cost / clicks): yesterday $0.86, cumulative $0.88; baselines (cost per arrival, not per click): F2 Search $0.64 per arrival')
  })
})

describe('the morning read, Apps arm', () => {
  it('the Spend line carries the average CPC and the Apps baselines, and no Search block', async () => {
    const out = await run(base('2026-10-19T12:05:00Z', F3_APPS), F3_APPS)
    const spend = out.indexOf(out.find((l) => l.startsWith('Spend (Google Ads API'))!)
    expect(out[spend + 2]).toBe('  avg CPC (cost / clicks): yesterday $0.86, cumulative $0.88; baselines (cost per arrival, not per click): F1/F2 Apps $0.32-0.34 per arrival, first-move 6.4% (see rule 7)')
    expect(out.some((l) => l.startsWith('Search Ads side') || l.startsWith('Search: '))).toBe(false)
  })
  it('zero clicks print "—", not $0.00', async () => {
    const fx = base('2026-10-19T12:05:00Z', F3_APPS)
    fx.ads = { ...(fx.ads as Extract<Fixture['ads'], { daily: unknown }>), daily: { '2026-10-18': { costMicros: 0, impressions: 0, clicks: 0 } } }
    const out = await run(fx, F3_APPS)
    expect(out.find((l) => l.startsWith('  avg CPC'))).toContain('yesterday —, cumulative —')
  })
})
