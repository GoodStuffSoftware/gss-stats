import { describe, expect, it } from 'vitest'
import {
  SEARCH_HOLD_LINE,
  SEARCH_PROPOSE_LINE,
  SEARCH_READOUT,
  buildSearchAdsSide,
  parseShare,
  searchAdsSideLines,
  searchLabel,
  searchProposal,
  shareNumber,
  shareText,
  type KeywordRaw,
  type SearchDayRaw,
  type SearchMetricsRaw,
  type SearchSideRaw,
  type Share,
} from './searchAdsSide'

const v = (x: number): Share => ({ kind: 'value', v: x })
const NA: Share = { kind: 'na' }

describe('impression-share sentinels', () => {
  it('null, undefined, "--" and junk are n/a, never 0', () => {
    for (const raw of [null, undefined, '--', '', '  ', 'abc', Number.NaN, -0.2, 1.5]) {
      expect(parseShare(raw, 'impressionShare')).toEqual(NA)
      expect(parseShare(raw, 'lost')).toEqual(NA)
    }
    expect(shareText(NA)).toBe('n/a')
    expect(shareNumber(NA)).toBeNull()
  })
  it('an impression share under 10% (Google reports 0.0999) prints "<10%", not a number', () => {
    for (const raw of [0.0999, 0.05, 0, '0.0999']) {
      const s = parseShare(raw, 'impressionShare')
      expect(s).toEqual({ kind: 'below10' })
      expect(shareText(s)).toBe('<10%')
      expect(shareNumber(s)).toBeNull()
    }
    expect(shareText(parseShare(0.1, 'impressionShare'))).toBe('10%')
  })
  it('a lost share over 90% (Google reports 0.9001) prints ">90%" and still counts as over every cut-off', () => {
    const s = parseShare(0.9001, 'lost')
    expect(shareText(s)).toBe('>90%')
    expect(shareNumber(s)).toBeGreaterThan(0.9)
    expect(shareText(parseShare(0.9, 'lost'))).toBe('90%')
  })
  it('a lost share is 0% only when Google sent 0', () => {
    expect(shareText(parseShare(0, 'lost'))).toBe('0%')
    expect(shareText(parseShare(null, 'lost'))).toBe('n/a')
  })
  it('numeric strings parse (the API sends doubles, but a string must not read as 0)', () => {
    expect(parseShare('0.42', 'lost')).toEqual(v(0.42))
    expect(shareText(parseShare('0.42', 'lost'))).toBe('42%')
  })
})

describe('the Search label cut-offs', () => {
  it('keeps every cut-off in the one constant', () => {
    expect(SEARCH_READOUT).toMatchObject({ fromDay: 3, bidLimitedRankLost: 0.3, budgetLimitedBudgetLost: 0.2, proposeUnderClicksPerDay: 2, proposeRankLost: 0.5, proposeRaiseTo: 1.25, holdAt: 0.99 })
  })
  it('bid-limited at rank-lost 30% or more, whatever the budget share', () => {
    expect(searchLabel(v(0.3), v(0))).toBe('bid-limited')
    expect(searchLabel(v(0.3), v(0.9))).toBe('bid-limited')
    expect(searchLabel(parseShare(0.9001, 'lost'), NA)).toBe('bid-limited')
  })
  it('judges the whole percent the report prints: 29.5% prints 30% and is bid-limited, 29.4% prints 29% and is not', () => {
    expect(shareText(v(0.295))).toBe('30%')
    expect(searchLabel(v(0.295), v(0))).toBe('bid-limited')
    expect(shareText(v(0.294))).toBe('29%')
    expect(searchLabel(v(0.294), v(0))).toBe('fine')
    expect(searchProposal(1, v(0.495))).toBe('PROPOSE')
  })
  it('budget-limited when rank-lost is under 30% and budget-lost is 20% or more', () => {
    expect(searchLabel(v(0.29), v(0.2))).toBe('budget-limited')
    expect(searchLabel(v(0), v(0.55))).toBe('budget-limited')
  })
  it('fine when both are under their cut-offs', () => {
    expect(searchLabel(v(0.29), v(0.19))).toBe('fine')
    expect(searchLabel(v(0), v(0))).toBe('fine')
  })
  it('n/a (not a guess) when the answer needs a figure Google did not send', () => {
    expect(searchLabel(NA, v(0.5))).toBe('n/a')
    expect(searchLabel(v(0.1), NA)).toBe('n/a')
    expect(searchLabel(NA, NA)).toBe('n/a')
  })
})

describe('the proposal', () => {
  it('proposes only when under 2 clicks a day AND rank-lost is 50% or more', () => {
    expect(searchProposal(1.5, v(0.5))).toBe('PROPOSE')
    expect(searchProposal(0, parseShare(0.9001, 'lost'))).toBe('PROPOSE')
    expect(searchProposal(1.99, v(0.8))).toBe('PROPOSE')
  })
  it('holds otherwise', () => {
    expect(searchProposal(2, v(0.8))).toBe('HOLD')
    expect(searchProposal(1.5, v(0.49))).toBe('HOLD')
    expect(searchProposal(5, v(0.1))).toBe('HOLD')
  })
  it('holds with a note when rank-lost is n/a, never proposing on a missing figure', () => {
    expect(searchProposal(0, NA)).toBe('HOLD (rank-lost n/a)')
  })
  it('the two lines read exactly as briefed', () => {
    expect(SEARCH_PROPOSE_LINE).toBe("PROPOSE: raise the 'app' keywords only to $1.25 max CPC (Mike decides)")
    expect(SEARCH_HOLD_LINE).toBe('HOLD $0.99')
  })
})

const m = (o: Partial<SearchMetricsRaw> = {}): SearchMetricsRaw => ({ impressions: 0, clicks: 0, costMicros: 0, avgCpcMicros: null, impressionShare: null, rankLost: null, budgetLost: null, ...o })
const day = (date: string, o: Partial<SearchMetricsRaw> = {}): SearchDayRaw => ({ date, ...m(o) })
const kw = (text: string, o: Partial<KeywordRaw> = {}): KeywordRaw => ({ text, matchType: 'BROAD', impressions: 0, clicks: 0, avgCpcMicros: null, impressionShare: null, rankLost: null, ...o })

/** Flight 2026-10-17; closed days 10-17 and 10-18. 5 clicks over 2 days = 2.5 a day, $5.00 -> avg CPC $1.00. */
const raw = (cum: Partial<SearchMetricsRaw>, keywords: KeywordRaw[] | null = [], keywordsError: string | null = null): SearchSideRaw => ({
  daily: [day('2026-10-17', { impressions: 40, clicks: 2, costMicros: 2_000_000, impressionShare: 0.4, rankLost: 0.5, budgetLost: 0.1 })],
  cumulative: m({ impressions: 90, clicks: 5, costMicros: 5_000_000, impressionShare: 0.35, rankLost: 0.4, budgetLost: 0.05, ...cum }),
  keywords,
  keywordsError,
})
const build = (flightDay: number, through: string | null, r: SearchSideRaw | null, error: string | null = null) =>
  searchAdsSideLines(buildSearchAdsSide({ flightDay, flightStartEt: '2026-10-17', throughEt: through, raw: r, error }))

describe('the Search readout lines', () => {
  it('day 3 prints the briefed line and a HOLD when rank-lost is under 50%', () => {
    const out = build(3, '2026-10-18', raw({}))
    expect(out).toContain('Search: 2.5 clicks/day, avg CPC $1.00, lost to rank 40% → bid-limited')
    expect(out[out.length - 1]).toBe('HOLD $0.99')
  })
  it('day 3 proposes the raise at under 2 clicks a day and 50%+ rank-lost', () => {
    const out = build(3, '2026-10-18', raw({ clicks: 3, costMicros: 3_300_000, rankLost: 0.62 }))
    expect(out).toContain('Search: 1.5 clicks/day, avg CPC $1.10, lost to rank 62% → bid-limited')
    expect(out[out.length - 1]).toBe("PROPOSE: raise the 'app' keywords only to $1.25 max CPC (Mike decides)")
  })
  it('the three labels come through the report line', () => {
    expect(build(3, '2026-10-18', raw({ rankLost: 0.1, budgetLost: 0.3 }))).toContain('Search: 2.5 clicks/day, avg CPC $1.00, lost to rank 10% → budget-limited')
    expect(build(3, '2026-10-18', raw({ rankLost: 0.1, budgetLost: 0.05 }))).toContain('Search: 2.5 clicks/day, avg CPC $1.00, lost to rank 10% → fine')
    expect(build(3, '2026-10-18', raw({ rankLost: 0.35, budgetLost: 0 }))).toContain('Search: 2.5 clicks/day, avg CPC $1.00, lost to rank 35% → bid-limited')
  })
  it('a missing lost-to-rank prints n/a and the HOLD note, never 0%', () => {
    const out = build(3, '2026-10-18', raw({ rankLost: null }))
    expect(out).toContain('Search: 2.5 clicks/day, avg CPC $1.00, lost to rank n/a → n/a')
    expect(out[out.length - 1]).toContain('HOLD $0.99 (lost to rank is n/a')
    expect(out.join('\n')).not.toContain('lost to rank 0%')
  })
  it('no clicks gives avg CPC n/a, not $0.00', () => {
    const out = build(3, '2026-10-18', raw({ clicks: 0, costMicros: 0, impressions: 0, impressionShare: null, rankLost: null, budgetLost: null }))
    expect(out).toContain('Search: 0.0 clicks/day, avg CPC n/a, lost to rank n/a → n/a')
  })
  it('before day 3 the readout is NOT YET and there is no proposal line', () => {
    const out = build(2, '2026-10-17', raw({}))
    expect(out).toContain('Search: NOT YET (flight day 2; the readout starts on flight day 3)')
    expect(out.some((l) => l.startsWith('HOLD') || l.startsWith('PROPOSE'))).toBe(false)
    expect(out.some((l) => l.startsWith('Search: ') && l.includes('clicks/day'))).toBe(false)
  })
  it('before the flight starts (no closed day) nothing is queried and the readout is NOT YET', () => {
    const out = build(0, '2026-10-16', null)
    expect(out[0]).toContain('no closed flight day yet')
    expect(out).toContain('Search: NOT YET (flight day 0; the readout starts on flight day 3)')
  })
  it('a failed Ads read says so on the block and the readout, and is not a number', () => {
    const out = build(3, '2026-10-18', null, 'HTTP 500')
    expect(out[0]).toBe('Search Ads side (Google Ads only): NOT READ (HTTP 500)')
    expect(out).toContain('Search: n/a (the Ads read failed)')
  })
})

describe('the per-day, cumulative and keyword lines', () => {
  it('zero-fills a closed day Google returned no row for, and prints sentinels honestly', () => {
    const out = build(3, '2026-10-18', raw({ impressionShare: 0.0999, rankLost: 0.9001 }))
    expect(out).toContain('  2026-10-17: 40 impr, 2 clicks, avg CPC $1.00, impression share 40%, lost to rank 50%, lost to budget 10%')
    expect(out).toContain('  2026-10-18: 0 impr, 0 clicks, avg CPC n/a, impression share n/a, lost to rank n/a, lost to budget n/a')
    expect(out).toContain("  cumulative (Google's own aggregate for the range): 90 impr, 5 clicks, avg CPC $1.00, impression share <10%, lost to rank >90%, lost to budget 5%")
  })
  it('lists keywords by clicks, with no lost-to-budget column, and counts the idle ones', () => {
    const kws = [
      kw('idle one'),
      kw('free', { impressions: 50, clicks: 1, avgCpcMicros: 450_000, impressionShare: 0.0999, rankLost: 0.7 }),
      kw('sudoku app', { matchType: 'PHRASE', impressions: 20, clicks: 3, avgCpcMicros: 800_000, impressionShare: 0.3, rankLost: null }),
      kw('idle two'),
    ]
    const out = build(3, '2026-10-18', raw({}, kws))
    const at = out.findIndex((l) => l.startsWith('  by keyword'))
    expect(out[at]).toContain('lost to budget is not available per keyword')
    expect(out[at + 1]).toBe('    "sudoku app" [PHRASE]: 3 clicks, 20 impr, avg CPC $0.80, impression share 30%, lost to rank n/a')
    expect(out[at + 2]).toBe('    "free" [BROAD]: 1 click, 50 impr, avg CPC $0.45, impression share <10%, lost to rank 70%')
    expect(out[at + 3]).toBe('    (2 with no impressions not listed)')
  })
  it('a failed keyword query leaves only the keyword part out', () => {
    const out = build(3, '2026-10-18', raw({}, null, 'HTTP 400: nope'))
    expect(out).toContain('  by keyword: NOT READ (HTTP 400: nope)')
    expect(out.some((l) => l.startsWith('Search: ') && l.includes('clicks/day'))).toBe(true)
  })
})
