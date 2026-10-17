// Flight 3 report gaps (spec sections 1-6): the impressions-balance check, the d0 / arrival labels, the
// tagged coach line, tagged new accounts with the v1.99.2 caveat, the F3 cost-per-arrival baselines, and
// the 12:00-24:00 ET serving hours. Synthetic rows only: no network, no credentials. Flight 2 and the
// retest output stays byte-identical (f2ReportGolden.test.ts pins that).
import { afterEach, describe, expect, it } from 'vitest'
import { fixtureDeps, type Fixture } from './cli'
import { runMorningRead, type MorningOptions } from './read'
import {
  ARRIVALS_TAGGED_ROWS_LABEL,
  COST_PER_ARRIVAL_BENCHMARK,
  D0_DEVICES_LABEL,
  F3_COST_PER_ARRIVAL_BENCHMARK_TEXT,
  coachCountsLine,
  firstSessionLines,
  formatMorningReport,
  impressionsBalanceLine,
  tagSplitLines,
} from './report'
import { addCoachRow, emptyCoachCounts, isCoachPath, summarizeTaggedRows, type TaggedRow } from '../../src/lib/adsRules'
import { CAMPAIGNS, STAGED_FLIGHT_3, etMidnightUtcMs } from '../../src/lib/campaigns'
import { MEASUREMENT_CHANGES, newAccountMeasurementNote } from '../../src/lib/measurementChanges'
import { IMPRESSIONS_UNEVEN_GAP, buildTagSplit, impressionsBalance } from '../../src/lib/tagSplit'
import { MIN_COHORT } from '../../src/lib/popupEvents'
import type { AdDayRow } from '../../src/lib/adsApi'

const F3_APPS = STAGED_FLIGHT_3.apps.ids.campaignId
const F3_SEARCH = STAGED_FLIGHT_3.search.ids.campaignId
const [HERO, FEAT] = STAGED_FLIGHT_3.apps.ucValues
const SEARCH_TAG = STAGED_FLIGHT_3.search.ucValues[0]
const opts = (campaignId: string): MorningOptions => ({ campaignId, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 })

// ── the impressions-balance check (spec section 3) ───────────────────────────────────────────
describe('impressionsBalance: flagged when the largest and smallest ad share are more than 20 points apart', () => {
  const split = (a: number, b: number) => impressionsBalance([{ tag: 'x_hero', impressions: a }, { tag: 'x_feat', impressions: b }])
  it('64/36 is flagged uneven', () => {
    const b = split(640, 360)!
    expect(b.uneven).toBe(true)
    expect(b.shares.map((s) => Math.round(s.share * 100))).toEqual([64, 36])
    expect(b.gap).toBeCloseTo(0.28, 10)
  })
  it('60/40 is the edge: not flagged', () => {
    expect(IMPRESSIONS_UNEVEN_GAP).toBe(0.2)
    expect(split(600, 400)!.uneven).toBe(false)
    expect(split(400, 600)!.uneven).toBe(false)
  })
  it('an even split is not flagged, and neither is 55/45', () => {
    expect(split(500, 500)!.uneven).toBe(false)
    expect(split(500, 500)!.gap).toBe(0)
    expect(split(550, 450)!.uneven).toBe(false)
  })
  it('the order of the ads does not matter', () => {
    expect(split(360, 640)!.uneven).toBe(true)
  })
  it('a starved ad (100/0) is flagged uneven; no impressions at all has nothing to compare', () => {
    expect(split(100, 0)!.uneven).toBe(true)
    expect(split(0, 100)!.gap).toBe(1)
    expect(split(0, 0)).toBeNull()
    expect(impressionsBalance([{ tag: 'only', impressions: 50 }])).toBeNull()
  })
  it('three ads: largest minus smallest', () => {
    const b = impressionsBalance([{ tag: 'a', impressions: 50 }, { tag: 'b', impressions: 30 }, { tag: 'c', impressions: 20 }])!
    expect(b.gap).toBeCloseTo(0.3, 10)
    expect(b.uneven).toBe(true)
  })
})

describe('the per-tag split prints each tag\'s impression share and the balance line', () => {
  const D1 = etMidnightUtcMs('2026-10-18')
  const url = (tag: string) => `https://www.example.test/?utm_source=google&utm_medium=display&utm_campaign=${tag}`
  const ad = (adId: string, tag: string | null, impressions: number): AdDayRow => ({ date: '2026-10-18', adId, finalUrls: [tag ? url(tag) : 'https://www.example.test/'], costMicros: 5_000_000, clicks: 10, impressions })
  const rows: TaggedRow[] = [
    { hourStartMs: D1 + 3_600_000, path: '/', visitor: 'new', campaign: HERO, count: 9 },
    { hourStartMs: D1 + 3_600_000, path: '/', visitor: 'new', campaign: FEAT, count: 6 },
  ]
  const text = (a: number, b: number, extra: AdDayRow[] = []) =>
    tagSplitLines(buildTagSplit({ rows, ucValues: [HERO, FEAT], adRows: [ad('a', HERO, a), ad('b', FEAT, b), ...extra], costThroughEt: '2026-10-18' })).join('\n')

  it('64/36: each tag line carries its share and the balance line says UNEVEN, compare rates not totals', () => {
    const t = text(640, 360)
    expect(t).toContain('64% of tagged-ad impressions')
    expect(t).toContain('36% of tagged-ad impressions')
    expect(t).toContain("impressions balance: UNEVEN: hero 64% / feat 36% of impressions; ad rotation isn't even, compare rates not totals")
  })
  it('60/40: the edge reads even enough and names the 20-point rule', () => {
    const t = text(600, 400)
    expect(t).toContain('impressions balance: even enough (hero 60% / feat 40% of impressions; flagged when the shares are more than 20 points apart)')
    expect(t).not.toContain('UNEVEN')
  })
  it('an even split reads even enough', () => {
    expect(text(500, 500)).toContain('impressions balance: even enough (hero 50% / feat 50% of impressions')
  })
  it('a small bare catch-all tag does not flag an even hero/feat split, and a starved ad does flag', () => {
    const BARE = STAGED_FLIGHT_3.apps.ucValues[2]
    const bare = tagSplitLines(buildTagSplit({ rows, ucValues: [HERO, FEAT, BARE], adRows: [ad('a', HERO, 5000), ad('b', FEAT, 5000), ad('c', BARE, 100)], costThroughEt: '2026-10-18' })).join('\n')
    expect(bare).toContain('impressions balance: even enough (hero 50% / feat 50% of impressions')
    expect(bare).not.toContain('UNEVEN')
    const starved = tagSplitLines(buildTagSplit({ rows, ucValues: [HERO, FEAT, BARE], adRows: [ad('a', HERO, 5000), ad('b', FEAT, 0)], costThroughEt: '2026-10-18' })).join('\n')
    expect(starved).toContain('impressions balance: UNEVEN: hero 100% / feat 0% of impressions')
  })
  it('an untagged ad is left out of the shares', () => {
    const t = text(500, 500, [ad('c', null, 9000)])
    expect(t).toContain('50% of tagged-ad impressions')
    expect(t).toContain('impressions balance: even enough')
    expect(t).toContain('untagged: 1 ad(s)')
  })
  it('no ad read: no share and no balance line', () => {
    const t = tagSplitLines(buildTagSplit({ rows, ucValues: [HERO, FEAT], adRows: null, costError: 'x' })).join('\n')
    expect(t).not.toContain('impressions balance')
    expect(t).not.toContain('of tagged-ad impressions')
  })
  it('the header names the arrival definition without the donut\'s d0 count', () => {
    expect(text(500, 500)).toContain("arrivals are first-ever tagged rows (not the donut's /return/<tag>/d0 count)")
  })
  it('impressionsBalanceLine: null when fewer than two ads have impressions', () => {
    expect(impressionsBalanceLine(null)).toBe('  impressions balance: not checked (no ad impressions yet, or fewer than two ads)')
  })
})

// ── the tagged coach line (spec section 4) ───────────────────────────────────────────────────
describe('coach counts: per tip shown / dismissed / closed-at, plus tour-opened, as totals', () => {
  it('addCoachRow sorts a coach path into its bucket and ignores every other path', () => {
    const c = emptyCoachCounts()
    addCoachRow(c, '/coach/shown/place', 5)
    addCoachRow(c, '/coach/shown/place', 2)
    addCoachRow(c, '/coach/shown/streak', 3)
    addCoachRow(c, '/coach/dismissed/place', 1)
    addCoachRow(c, '/coach/closed-at/place', 4)
    addCoachRow(c, '/coach/tour-opened', 6)
    addCoachRow(c, '/', 99)
    addCoachRow(c, '/coach/shown/', 99) // no tip
    addCoachRow(c, '/coach/shown/a/b', 99) // not a single-segment tip
    addCoachRow(c, '/coach/unknown/place', 99)
    expect(c).toEqual({ shown: { place: 7, streak: 3 }, dismissed: { place: 1 }, closedAt: { place: 4 }, tourOpened: 6 })
  })
  it('isCoachPath agrees with addCoachRow', () => {
    for (const p of ['/coach/shown/place', '/coach/dismissed/x', '/coach/closed-at/x', '/coach/tour-opened']) expect(isCoachPath(p)).toBe(true)
    for (const p of ['/', '/coach/shown/', '/coach/shown/a/b', '/coach/other/x', '/tour/start']) expect(isCoachPath(p)).toBe(false)
  })

  const D17 = etMidnightUtcMs('2026-10-17')
  const D18 = etMidnightUtcMs('2026-10-18')
  const D19 = etMidnightUtcMs('2026-10-19')
  const row = (path: string, count: number, hourStartMs: number): TaggedRow => ({ hourStartMs, path, visitor: 'new', campaign: SEARCH_TAG, count })
  // The refused paths come back at their ET midnight (no hour); tour-opened keeps its hour bucket.
  const rows = [
    row('/coach/shown/place', 5, D17),
    row('/coach/shown/place', 7, D18),
    row('/coach/shown/streak', 4, D18),
    row('/coach/dismissed/place', 2, D18),
    row('/coach/closed-at/place', 1, D17),
    row('/coach/tour-opened', 2, D17 + 15 * 3_600_000),
    row('/coach/tour-opened', 6, D18 + 15 * 3_600_000),
  ]
  it('summarizeTaggedRows totals them cumulatively and per ET-day window, never by hour', () => {
    const all = summarizeTaggedRows(rows).coach!
    expect(all).toEqual({ shown: { place: 12, streak: 4 }, dismissed: { place: 2 }, closedAt: { place: 1 }, tourOpened: 8 })
    const y = summarizeTaggedRows(rows, { fromMs: D18, toMs: D19 }).coach!
    expect(y).toEqual({ shown: { place: 7, streak: 4 }, dismissed: { place: 2 }, closedAt: {}, tourOpened: 6 })
    expect(summarizeTaggedRows(rows).coachShownPlace).toBe(12) // the day 1-2 tracking check is unchanged
  })
  it('a summary with no coach rows has no coach field (flight 2 and retest result JSON are unchanged)', () => {
    expect(summarizeTaggedRows([row('/', 3, D18)]).coach).toBeUndefined()
  })
  it('coachCountsLine: tips sorted, yesterday in brackets, "none" for an empty group', () => {
    const all = summarizeTaggedRows(rows).coach!
    const y = summarizeTaggedRows(rows, { fromMs: D18, toMs: D19 }).coach!
    expect(coachCountsLine(all, y)).toBe(
      'coach strip (tagged ET-day totals; yesterday in brackets; counts only): shown place 12 (7), streak 4 (4); dismissed place 2 (2); closed-at place 1 (0); tour-opened 8 (6)',
    )
    expect(coachCountsLine(emptyCoachCounts())).toBe('coach strip (tagged ET-day totals; counts only): shown none; dismissed none; closed-at none; tour-opened 0')
  })
  it('the line carries no hour, place-of-day or device split word', () => {
    const line = coachCountsLine(summarizeTaggedRows(rows).coach!, summarizeTaggedRows(rows, { fromMs: D18, toMs: D19 }).coach!).toLowerCase()
    for (const w of ['hour', 'device', 'country', 'browser', 'visitor']) expect(line).not.toContain(w)
  })
})

// ── the v1.99.2 caveat on tagged new accounts (spec section 5) ──────────────────────────────
describe('newAccountMeasurementNote', () => {
  const change = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.2')!
  const shipped = change.dateEt
  afterEach(() => {
    change.dateEt = shipped
  })
  it('is null before the change date and the v1.99.2 text from it on', () => {
    change.dateEt = '2026-10-16'
    expect(newAccountMeasurementNote('2026-10-15')).toBeNull()
    expect(newAccountMeasurementNote('2026-10-16')).toBe(`v1.99.2 (from 2026-10-16): ${change.note}`)
    expect(newAccountMeasurementNote('2026-10-30')).toContain('v1.99.2 (from 2026-10-16)')
  })
  it('is null while the change has no date', () => {
    change.dateEt = null
    expect(newAccountMeasurementNote('2026-10-30')).toBeNull()
  })
})

// ── the morning report, Search arm (single tag) and Apps arm (two ads) ──────────────────────
type TaggedFx = Extract<NonNullable<Fixture['beacon']>, { tagged: unknown }>
type TaggedFxRow = TaggedFx['tagged'][number]

/** Day 3 morning (2026-10-19; day 1 = 10-17): closed days 10-17 and 10-18 at $18 each = $36, so the $18 and $35 reads are both crossed. */
function fixture(arm: 'search' | 'apps', opts2: { heroImpr?: number; featImpr?: number } = {}): Fixture {
  const id = arm === 'apps' ? F3_APPS : F3_SEARCH
  const tag = (t: string) => ({ campaign: t })
  const tags = arm === 'apps' ? [HERO, FEAT] : [SEARCH_TAG]
  const tagged: TaggedFxRow[] = []
  tags.forEach((t, i) => {
    const k = i + 1
    tagged.push(
      { hour: '2026-10-17T17:00:00Z', path: '/', visitor: 'new', count: 10 * k, ...tag(t) },
      { hour: '2026-10-18T17:00:00Z', path: '/', visitor: 'new', count: 12 * k, ...tag(t) },
      { hour: '2026-10-18T18:00:00Z', path: '/game/complete/normal/easy', visitor: 'new', count: 8, ...tag(t) },
      { hour: '2026-10-18T19:00:00Z', path: '/signin-prompt/placement', visitor: 'new', count: 3, ...tag(t) },
      { hour: '2026-10-17T20:00:00Z', path: '/auth/success/google/new', visitor: 'new', count: 1, ...tag(t) },
      { hour: '2026-10-18T20:00:00Z', path: '/auth/success/google/new', visitor: 'new', count: 2, ...tag(t) },
      // coach strip: refused paths come back at their ET midnight (04:00Z), tour-opened keeps its hour
      { hour: '2026-10-17T04:00:00Z', path: '/coach/shown/place', visitor: 'new', count: 5, ...tag(t) },
      { hour: '2026-10-18T04:00:00Z', path: '/coach/shown/place', visitor: 'new', count: 7, ...tag(t) },
      { hour: '2026-10-18T04:00:00Z', path: '/coach/shown/streak', visitor: 'new', count: 4, ...tag(t) },
      { hour: '2026-10-18T04:00:00Z', path: '/coach/dismissed/place', visitor: 'new', count: 2, ...tag(t) },
      { hour: '2026-10-17T04:00:00Z', path: '/coach/closed-at/place', visitor: 'new', count: 1, ...tag(t) },
      { hour: '2026-10-17T15:00:00Z', path: '/coach/tour-opened', visitor: 'new', count: 2, ...tag(t) },
      { hour: '2026-10-18T15:00:00Z', path: '/coach/tour-opened', visitor: 'new', count: 6, ...tag(t) },
    )
  })
  const url = (t: string) => `https://www.example.test/?utm_source=google&utm_medium=${arm === 'apps' ? 'display' : 'cpc'}&utm_campaign=${t}`
  const adDaily: AdDayRow[] =
    arm === 'apps'
      ? [
          { date: '2026-10-17', adId: 'hero', finalUrls: [url(HERO)], costMicros: 9_000_000, clicks: 40, impressions: opts2.heroImpr ?? 5000 },
          { date: '2026-10-17', adId: 'feat', finalUrls: [url(FEAT)], costMicros: 9_000_000, clicks: 40, impressions: opts2.featImpr ?? 5000 },
          { date: '2026-10-18', adId: 'hero', finalUrls: [url(HERO)], costMicros: 9_000_000, clicks: 40, impressions: 0 },
          { date: '2026-10-18', adId: 'feat', finalUrls: [url(FEAT)], costMicros: 9_000_000, clicks: 40, impressions: 0 },
        ]
      : []
  return {
    now: '2026-10-19T12:05:00Z',
    ads: {
      status: { id, name: `fixture F3 ${arm}`, status: 'ENABLED', servingStatus: 'SERVING', primaryStatus: 'ELIGIBLE', dailyBudget: 10 },
      daily: {
        '2026-10-17': { costMicros: 18_000_000, impressions: 5000, clicks: 80 },
        '2026-10-18': { costMicros: 18_000_000, impressions: 5000, clicks: 80 },
        '2026-10-19': { costMicros: 0, impressions: 0, clicks: 0 },
      },
      placements: [],
      ...(adDaily.length ? { adDaily } : {}),
    },
    beacon: {
      tagged,
      siteEvents: [],
      returns: tags.map((t) => ({ site: 'bestsudoku-web', path: `/return/${t}/d0`, count: 30 })),
      returnSites: [],
    },
    store: {},
  }
}
const read = async (fx: Fixture, id: string) => runMorningRead(fixtureDeps(fx, true), opts(id))
const report = async (arm: 'search' | 'apps', o: { heroImpr?: number; featImpr?: number } = {}) => {
  const id = arm === 'apps' ? F3_APPS : F3_SEARCH
  const r = await read(fixture(arm, o), id)
  return { r, text: formatMorningReport(r), lines: formatMorningReport(r).split('\n') }
}

describe('the F3 morning report: arrival labels and the tagged coach line', () => {
  it('Tagged so far names its arrivals as new-visitor tagged rows, and the d0 label sits on the Returns and first-session lines', async () => {
    const { lines, text } = await report('search')
    const tagged = lines.find((l) => l.startsWith('Tagged so far'))!
    expect(tagged).toContain(`${ARRIVALS_TAGGED_ROWS_LABEL}, a floor`)
    expect(ARRIVALS_TAGGED_ROWS_LABEL).toBe('arrivals (new-visitor tagged rows)')
    expect(D0_DEVICES_LABEL).toBe('d0 devices (/return/<tag>/d0)')
    expect(text).toContain(`Returns /return/<uc>/ (attributed by the path): web ${D0_DEVICES_LABEL} 30;`)
    expect(lines.some((l) => l.startsWith(`  ${D0_DEVICES_LABEL}:`))).toBe(true)
  })
  it('the coach line follows Tagged so far: per tip shown / dismissed / closed-at plus tour-opened, cumulative with yesterday in brackets', async () => {
    const { lines } = await report('search')
    const at = lines.findIndex((l) => l.startsWith('Tagged so far'))
    expect(lines[at + 1]).toBe(
      '  coach strip (tagged ET-day totals; yesterday in brackets; counts only): shown place 12 (7), streak 4 (4); dismissed place 2 (2); closed-at place 1 (0); tour-opened 8 (6)',
    )
  })
  it('the tracking-check count of /coach/shown/place rows is still the same total', async () => {
    const { lines } = await report('search')
    expect(lines.find((l) => l.startsWith('Tagged so far'))).toContain('/coach/shown/place rows 12 (7)')
  })
  it('the first-session arrivals step: d0 label for flight 3, the plain label for flight 2', async () => {
    const { r } = await report('search')
    const f3 = firstSessionLines(r.firstSession, true).join('\n')
    const f2 = firstSessionLines(r.firstSession, false).join('\n')
    expect(f3).toContain(`  ${D0_DEVICES_LABEL}:`)
    expect(f2).not.toContain(D0_DEVICES_LABEL)
    expect(firstSessionLines(r.firstSession)).toEqual(firstSessionLines(r.firstSession, false))
  })
})

describe('the F3 morning report: tagged new accounts and the v1.99.2 caveat', () => {
  const change = MEASUREMENT_CHANGES.find((c) => c.id === 'v1.99.2')!
  const shipped = change.dateEt
  afterEach(() => {
    change.dateEt = shipped
  })
  it('Tagged so far carries the cumulative /auth/success/<provider>/new count, counts not rates, with the v1.99.2 caveat once its date has come', async () => {
    change.dateEt = '2026-10-16'
    const { lines } = await report('search')
    const tagged = lines.find((l) => l.startsWith('Tagged so far'))!
    expect(tagged).toContain('; tagged new accounts 3 cumulative (/auth/success/<provider>/new rows; counts, not rates; measurement change v1.99.2 (from 2026-10-16): ')
  })
  it('before the caveat date the count prints without it', async () => {
    change.dateEt = '2026-10-25'
    const { lines } = await report('search')
    const tagged = lines.find((l) => l.startsWith('Tagged so far'))!
    expect(tagged).toContain('; tagged new accounts 3 cumulative (/auth/success/<provider>/new rows; counts, not rates)')
    expect(tagged).not.toContain('v1.99.2')
  })
  it('the Apps arm sums both ads (3 per ad)', async () => {
    const { lines } = await report('apps')
    expect(lines.find((l) => l.startsWith('Tagged so far'))).toContain('tagged new accounts 6 cumulative')
  })
})

describe('the F3 morning report: the impressions balance on the Apps arm', () => {
  it('64/36 shows the UNEVEN line and each ad\'s share', async () => {
    const { text } = await report('apps', { heroImpr: 6400, featImpr: 3600 })
    expect(text).toContain("impressions balance: UNEVEN: hero 64% / feat 36% of impressions; ad rotation isn't even, compare rates not totals")
    expect(text).toContain('64% of tagged-ad impressions')
  })
  it('60/40 and an even split are not flagged', async () => {
    expect((await report('apps', { heroImpr: 6000, featImpr: 4000 })).text).toContain('impressions balance: even enough (hero 60% / feat 40%')
    const even = (await report('apps', { heroImpr: 5000, featImpr: 5000 })).text
    expect(even).toContain('impressions balance: even enough (hero 50% / feat 50%')
    expect(even).not.toContain('UNEVEN')
  })
})

describe('the F3 cost-per-arrival baselines', () => {
  it('the constants: Apps $0.32-0.34, Search $0.64, and the shared F1/F2 figure stays $0.32', () => {
    expect(F3_COST_PER_ARRIVAL_BENCHMARK_TEXT.apps).toBe('about $0.32-0.34, the F1/F2 in-app figure')
    expect(F3_COST_PER_ARRIVAL_BENCHMARK_TEXT.search).toBe('about $0.64, the F2 Search figure')
    expect(COST_PER_ARRIVAL_BENCHMARK).toBe(0.32)
  })
  it('the Apps threshold read prints the Apps baseline and its arrivals label', async () => {
    const { text } = await report('apps')
    expect(text).toContain(`${ARRIVALS_TAGGED_ROWS_LABEL}; accept rate`)
    expect(text).toContain('benchmark about $0.32-0.34, the F1/F2 in-app figure')
    expect(text).not.toContain('benchmark about $0.32, the F1/F2 in-app figure')
  })
  it('the Search threshold read prints the Search baseline', async () => {
    const { text } = await report('search')
    expect(text).toContain('benchmark about $0.64, the F2 Search figure')
    expect(text).not.toContain('benchmark about $0.32')
  })
})

describe('flight 2 and the retest keep their wording', () => {
  it('none of the flight 3 lines or labels appear in the report of a flight 2 campaign', async () => {
    const f2 = CAMPAIGNS.find((c) => c.id === '24316608605')!
    expect(f2).toBeTruthy()
    const fx = fixture('search')
    ;(fx.ads as { status: { id: string } }).status.id = f2.id
    const text = formatMorningReport(await read(fx, f2.id))
    for (const s of ['coach strip (', 'tagged new accounts', 'impressions balance', ARRIVALS_TAGGED_ROWS_LABEL, D0_DEVICES_LABEL, '$0.64']) expect(text).not.toContain(s)
  })
})

// ── the serving hours (12:00-24:00 ET for flight 3) ─────────────────────────────────────────
describe('servingHoursEt is [startHour, endHourExclusive): 24 is a valid end', () => {
  it('flight 3 serves 12:00-24:00 ET and flight 2 stays 12:00-23:00', () => {
    expect(STAGED_FLIGHT_3.apps.servingHoursEt).toEqual([12, 24])
    expect(STAGED_FLIGHT_3.search.servingHoursEt).toEqual([12, 24])
    for (const c of CAMPAIGNS.filter((x) => x.ucValues.some((u) => u.startsWith('sudoku_funnel_f2_')))) expect(c.servingHoursEt, c.id).toEqual([12, 23])
  })
  it('every registered window is a real clock window: whole hours, 0 <= start < end <= 24 (the end is exclusive, so 24 is midnight)', () => {
    for (const c of CAMPAIGNS) {
      if (!c.servingHoursEt) continue
      const [s, e] = c.servingHoursEt
      expect(Number.isInteger(s) && Number.isInteger(e), c.id).toBe(true)
      expect(s, c.id).toBeGreaterThanOrEqual(0)
      expect(s, c.id).toBeLessThan(e)
      expect(e, c.id).toBeLessThanOrEqual(24)
    }
  })
  it('nothing reads the window to filter rows: the noon-ET start alone bounds attribution, so 24 changes no count', () => {
    // flightStartTimeEt ('12:00') is the only schedule value campaignAttributionClause reads; servingHoursEt is descriptive.
    for (const arm of ['apps', 'search'] as const) expect(STAGED_FLIGHT_3[arm].flightStartTimeEt).toBe('12:00')
  })
})
