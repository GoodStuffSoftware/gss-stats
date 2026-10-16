// Flight 3's Apps arm runs two display ads, tagged sudoku_funnel_f3_apps_hero and _feat, plus the bare
// catch-all. These tests pin (1) that every rule still reads the arm's SUMMED total (a two-tag arm
// gives the same kill rules, threshold read, returns and first-session funnel as the equivalent
// single-tag arm), (2) the per-tag split block, (3) the final_urls parsing that maps an ad to a tag,
// (4) the small-sample gate on cost per arrival, (5) that a single-tag arm is unchanged, and (6) the
// counts-only rule: the tagged query groups the refused paths (returns, completions) by ET DAY, never
// by hour. Fixture / in-memory only: no network, no credentials, made-up values.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { fixtureDeps, type Fixture } from './cli'
import { runMorningRead, runPostflightRead, type MorningOptions } from './read'
import { formatMorningReport, tagSplitLines } from './report'
import { createBeaconSource, taggedRowsQuery, WEB_SITE } from './beacon'
import { fetchAdDaily, type AdDayRow, type AdsClient } from '../../src/lib/adsApi'
import { adTagOf, buildTagSplit, isMultiTag, utmCampaignOf } from '../../src/lib/tagSplit'
import { summarizeTaggedRows, type TaggedRow } from '../../src/lib/adsRules'
import { CAMPAIGNS, STAGED_FLIGHT_3, campaignById, etMidnightUtcMs, stagedCampaign, type CampaignFlight } from '../../src/lib/campaigns'
import { addDays } from '../../src/lib/etTime'
import { hideLiveFlight3 } from '../../src/testing/stagedFlight3'
import { etDateFromMs, MIN_COHORT } from '../../src/lib/popupEvents'
import { SPLIT_REFUSED_DIMS, isEtMidnight, isSplitRefusedPath } from '../../src/lib/splitGuard'

const here = path.dirname(fileURLToPath(import.meta.url))
const RETEST = '24279250691'
const RETEST_UC = 'sudoku_funnel_retest'
const TAG_A = 'tag_a_made_up'
const TAG_B = 'tag_b_made_up'
const UC2 = [TAG_A, TAG_B]
const raw = fs.readFileSync(path.join(here, 'fixtures', 'threshold-50.json'), 'utf8')
const baseFixture = (): Fixture => JSON.parse(raw)
const opts: MorningOptions = { campaignId: RETEST, releaseHealth: 'auto', healthOnly: false, healthMinParent: MIN_COHORT, healthParentAgeHours: 24 }

// ── final_urls → tag ────────────────────────────────────────────────────────────────────────
const url = (tag: string | null, extra = '') => `https://www.example.test/?utm_source=google&utm_medium=display${tag == null ? '' : `&utm_campaign=${tag}`}${extra}`

describe('utmCampaignOf and adTagOf: the ad-to-tag mapping', () => {
  it('reads the tag from a landing link, wherever it sits in the query', () => {
    expect(utmCampaignOf(url(TAG_A))).toBe(TAG_A)
    expect(utmCampaignOf(`https://x.test/?utm_campaign=${TAG_A}&utm_source=google`)).toBe(TAG_A)
    expect(utmCampaignOf(`https://x.test/p?a=1&utm_campaign=${TAG_B}#frag`)).toBe(TAG_B)
    expect(utmCampaignOf(`https://x.test/?utm_campaign=tag%5Fa`)).toBe('tag_a')
  })
  it('missing, empty or look-alike keys give null', () => {
    expect(utmCampaignOf('https://x.test/')).toBeNull()
    expect(utmCampaignOf(url(null))).toBeNull()
    expect(utmCampaignOf('https://x.test/?utm_campaign=')).toBeNull()
    expect(utmCampaignOf('https://x.test/?utm_campaign')).toBeNull()
    expect(utmCampaignOf(`https://x.test/?xutm_campaign=${TAG_A}`)).toBeNull()
    expect(utmCampaignOf(`https://x.test/?utm_campaign_x=${TAG_A}`)).toBeNull()
    expect(utmCampaignOf(`https://x.test/#utm_campaign=${TAG_A}`)).toBeNull() // a fragment is not a query
    expect(utmCampaignOf('https://x.test/?utm_campaign=%E0%A4%A')).toBeNull() // malformed escape
  })
  it('an ad maps to its one distinct in-arm tag; a repeated link with the same tag is still that tag', () => {
    expect(adTagOf([url(TAG_A)], UC2)).toBe(TAG_A)
    expect(adTagOf([url(TAG_B), url(TAG_B, '&x=1')], UC2)).toBe(TAG_B)
    expect(adTagOf([url(null), url(TAG_A)], UC2)).toBe(TAG_A) // one link untagged, the other tagged: one distinct tag
  })
  it('no tag, a foreign tag, wrong case, or two different tags map to nothing (never a guess)', () => {
    expect(adTagOf([], UC2)).toBeNull()
    expect(adTagOf([url(null)], UC2)).toBeNull()
    expect(adTagOf([url('some_other_flight')], UC2)).toBeNull()
    expect(adTagOf([url(TAG_A.toUpperCase())], UC2)).toBeNull()
    expect(adTagOf([url(TAG_A), url(TAG_B)], UC2)).toBeNull() // ambiguous
    expect(adTagOf([url(TAG_A), url('some_other_flight')], UC2)).toBeNull() // ambiguous
  })
  it('the bare catch-all tag is an arm tag like any other, and a tag that is only a prefix of one is not', () => {
    const uc = ['f3_hero', 'f3_feat', 'f3']
    expect(adTagOf([url('f3')], uc)).toBe('f3')
    expect(adTagOf([url('f3_he')], uc)).toBeNull()
    expect(adTagOf([url('f3_hero_x')], uc)).toBeNull()
  })
  it('only an arm with several tags is split', () => {
    expect(isMultiTag(['one'])).toBe(false)
    expect(isMultiTag(UC2)).toBe(true)
  })
})

// ── the per-tag split and the cost gate ─────────────────────────────────────────────────────
const row = (campaign: string, p: string, count: number, hourStartMs: number, visitor = 'new'): TaggedRow => ({ hourStartMs, path: p, visitor, campaign, count })
const D1 = etMidnightUtcMs('2026-09-29') // yesterday's ET midnight in the tests below
const D2 = etMidnightUtcMs('2026-09-30')
const H = 3_600_000
const ad = (date: string, adId: string, finalUrls: string[], costMicros: number, clicks = 10, impressions = 100): AdDayRow => ({ date, adId, finalUrls, costMicros, clicks, impressions })

describe('buildTagSplit', () => {
  const rows: TaggedRow[] = [
    row(TAG_A, '/', 7, D1 + 20 * H),
    row(TAG_B, '/', 4, D1 + 21 * H),
    row(TAG_A, '/game/complete/normal/easy', 3, D1 + 22 * H),
    row(TAG_B, '/game/complete/normal/easy', 1, D1 + 5 * H),
    row(TAG_A, '/signin-prompt/placement', 2, D1 - 40 * H, 'returning'), // an earlier day: cumulative only
    row(TAG_B, '/auth/success/google/new', 2, D1 + 3 * H, 'returning'),
    row(TAG_A, '/', 9, D2 + 2 * H), // today (not yesterday)
  ]
  const yesterday = { fromMs: D1, toMs: D2 }

  it('per-tag counts are the tagged rows cut by their own tag: they add up to the arm total, cumulative and yesterday', () => {
    const sp = buildTagSplit({ rows, ucValues: UC2, yesterday, adRows: null })!
    const total = summarizeTaggedRows(rows)
    const totalY = summarizeTaggedRows(rows, yesterday)
    const [a, b] = sp.tags
    expect([a.tag, b.tag]).toEqual(UC2)
    expect(a.total).toEqual({ arrivals: 19, completes: 3, asks: 2, newAccounts: 0 })
    expect(b.total).toEqual({ arrivals: 5, completes: 1, asks: 0, newAccounts: 2 })
    expect(a.total.arrivals + b.total.arrivals).toBe(total.taggedArrivals)
    expect(a.total.completes + b.total.completes).toBe(total.funnel.completed)
    expect(a.total.asks + b.total.asks).toBe(total.asks.total)
    expect(a.total.newAccounts + b.total.newAccounts).toBe(total.authSuccessSplit.new)
    expect(a.yesterday).toEqual({ arrivals: 10, completes: 3, asks: 0, newAccounts: 0 })
    expect(b.yesterday).toEqual({ arrivals: 5, completes: 1, asks: 0, newAccounts: 2 })
    expect(a.yesterday!.arrivals + b.yesterday!.arrivals).toBe(totalY.taggedArrivals)
    expect(sp.unsplitHits).toBe(0)
  })
  it('a row with no tag, or a tag outside the arm, is counted nowhere in the split and is said so', () => {
    const odd: TaggedRow[] = [...rows, { hourStartMs: D1 + H, path: '/', visitor: 'new', count: 5 }, row('foreign', '/', 6, D1 + H)]
    const sp = buildTagSplit({ rows: odd, ucValues: UC2, adRows: null })!
    expect(sp.unsplitHits).toBe(11)
    expect(sp.tags[0].total.arrivals + sp.tags[1].total.arrivals).toBe(24)
    expect(sp.tags[0].yesterday).toBeNull() // no day window given
  })
  it('maps ad cost to the tag in each ad\'s final URLs, sums the closed days, and puts an unmappable ad on its own line', () => {
    const adRows = [
      ad('2026-09-28', 'ad1', [url(TAG_A)], 4_000_000, 5, 50),
      ad('2026-09-29', 'ad1', [url(TAG_A)], 6_500_000, 7, 70),
      ad('2026-09-29', 'ad2', [url(TAG_B)], 3_000_000, 3, 30),
      ad('2026-09-29', 'ad3', [url(null)], 1_250_000, 1, 10), // no tag
      ad('2026-09-29', 'ad4', [url(TAG_A), url(TAG_B)], 2_000_000, 2, 20), // ambiguous
      ad('2026-09-29', 'ad5', [url('some_other_flight')], 0.5e6, 1, 5), // foreign tag
    ]
    const sp = buildTagSplit({ rows, ucValues: UC2, adRows, costThroughEt: '2026-09-29' })!
    expect(sp.tags.map((t) => [t.cost, t.clicks, t.impressions])).toEqual([[10.5, 12, 120], [3, 3, 30]])
    expect(sp.untagged).toEqual({ ads: 3, cost: 3.75, clicks: 4, impressions: 35 })
    // total ad cost is conserved: every dollar is on a tag or on the untagged line
    expect(sp.tags[0].cost! + sp.tags[1].cost! + sp.untagged!.cost).toBeCloseTo(17.25, 6)
    expect(sp.costRead).toBe(true)
    expect(sp.costThroughEt).toBe('2026-09-29')
  })
  it('cost per arrival is "—" (null) under 5 arrivals and a figure at 5 (MIN_COHORT)', () => {
    const mk = (n: number) => buildTagSplit({ rows: [row(TAG_A, '/', n, D1 + H), row(TAG_B, '/', 20, D1 + H)], ucValues: UC2, adRows: [ad('2026-09-29', 'a', [url(TAG_A)], 10_000_000)] })!
    expect(mk(4).tags[0].costPerArrival).toBeNull()
    expect(mk(5).tags[0].costPerArrival).toBe(2)
    expect(mk(0).tags[0].costPerArrival).toBeNull()
    expect(mk(4).tags[1].costPerArrival).toBe(0) // 20 arrivals and no spend mapped to B: a real $0.00
  })
  it('no ad read means no cost anywhere, and the reason is carried', () => {
    const sp = buildTagSplit({ rows, ucValues: UC2, adRows: null, costError: 'Ads not available: boom' })!
    expect(sp.costRead).toBe(false)
    expect(sp.costError).toBe('Ads not available: boom')
    expect(sp.tags.every((t) => t.cost === null && t.costPerArrival === null)).toBe(true)
    expect(sp.untagged).toBeNull()
  })
  it('a single-tag arm has no split at all', () => {
    expect(buildTagSplit({ rows, ucValues: ['only_tag'], adRows: [] })).toBeNull()
  })
})

describe('tagSplitLines', () => {
  const rows = [row(TAG_A, '/', 6, D1 + H), row(TAG_B, '/', 3, D1 + H)]
  it('prints one line per tag with arrivals, completes, sign-in asks and new accounts; "—" under 5 arrivals', () => {
    const adRows = [ad('2026-09-29', 'a', [url(TAG_A)], 12_000_000), ad('2026-09-29', 'b', [url(TAG_B)], 6_000_000), ad('2026-09-29', 'c', [url(null)], 1_000_000)]
    const text = tagSplitLines(buildTagSplit({ rows, ucValues: UC2, yesterday: { fromMs: D1, toMs: D2 }, adRows, costThroughEt: '2026-09-29' })).join('\n')
    expect(text).toContain('Per-tag split')
    expect(text).toMatch(new RegExp(`${TAG_A}: arrivals 6 \\(6\\), completes 0 \\(0\\), sign-in asks 0 \\(0\\), new accounts 0 \\(0\\); ad spend \\$12\\.00 .*cost per arrival \\$2\\.00`))
    expect(text).toMatch(new RegExp(`${TAG_B}: arrivals 3 \\(3\\).*ad spend \\$6\\.00 .*cost per arrival —`))
    expect(text).toContain('untagged: 1 ad(s)')
    expect(text).toContain('ad cost through 2026-09-29')
  })
  it('prints nothing for a single-tag arm, and no hour, place or device word in the block', () => {
    expect(tagSplitLines(null)).toEqual([])
    expect(tagSplitLines(undefined)).toEqual([])
    const text = tagSplitLines(buildTagSplit({ rows, ucValues: UC2, adRows: null, costError: 'x' })).join('\n').toLowerCase()
    for (const word of ['hour', 'country', 'region', 'city', 'device', 'browser', 'visitor']) expect(text).not.toContain(word)
  })
})

// ── fetchAdDaily: a read-only ad_group_ad SELECT ────────────────────────────────────────────
describe('fetchAdDaily', () => {
  const stub = (rows: any[]): AdsClient & { queries: string[] } => {
    const queries: string[] = []
    return { queries, search: async (q: string) => (queries.push(q), rows) }
  }
  it('issues one SELECT from ad_group_ad for the campaign and maps rows, dropping malformed ones', async () => {
    const c = stub([
      { adGroupAd: { ad: { id: '11', finalUrls: [url(TAG_A), 5] } }, segments: { date: '2026-09-28' }, metrics: { costMicros: '4000000', impressions: '50', clicks: '5' } },
      { adGroupAd: { ad: { id: '12' } }, segments: { date: '2026-09-28' }, metrics: {} },
      { adGroupAd: { ad: { id: '13' } }, segments: { date: 'bad' }, metrics: {} },
      { adGroupAd: {}, segments: { date: '2026-09-28' }, metrics: {} },
    ])
    const rows = await fetchAdDaily(c, RETEST, '2026-09-26', '2026-09-28')
    expect(rows).toEqual([
      { date: '2026-09-28', adId: '11', finalUrls: [url(TAG_A)], costMicros: 4_000_000, impressions: 50, clicks: 5 },
      { date: '2026-09-28', adId: '12', finalUrls: [], costMicros: 0, impressions: 0, clicks: 0 },
    ])
    expect(c.queries).toHaveLength(1)
    expect(c.queries[0]).toMatch(/^SELECT .*final_urls.* FROM ad_group_ad WHERE campaign\.id = 24279250691 AND segments\.date BETWEEN '2026-09-26' AND '2026-09-28'/)
    expect(c.queries[0]).not.toMatch(/\b(mutate|UPDATE|INSERT|DELETE|REMOVE)\b/i)
  })
  it('refuses a campaign outside the registry and a malformed or empty date range before any query', async () => {
    const c = stub([])
    await expect(fetchAdDaily(c, '99999999999', '2026-09-26', '2026-09-28')).rejects.toThrow(/not in lib\/campaigns/)
    await expect(fetchAdDaily(c, '1; DROP', '2026-09-26', '2026-09-28')).rejects.toThrow(/invalid campaign id/)
    await expect(fetchAdDaily(c, RETEST, "2026-09-26'", '2026-09-28')).rejects.toThrow(/YYYY-MM-DD/)
    await expect(fetchAdDaily(c, RETEST, '2026-09-29', '2026-09-28')).rejects.toThrow(/empty date range/)
    expect(c.queries).toEqual([])
  })
})

// ── the tagged read keeps refused paths to ET days ──────────────────────────────────────────
describe('taggedRowsQuery groups the refused paths by ET day, never by hour', () => {
  const twoTag: CampaignFlight = { ...campaignById(RETEST)!, ucValues: UC2 }
  const openDb = () => {
    const db = new DatabaseSync(':memory:')
    const text = ['site', 'path', 'referrer', 'country', 'region', 'city', 'postal', 'continent', 'timezone', 'lat', 'lon', 'colo', 'org', 'device', 'browser', 'os', 'lang', 'refpath', 'source', 'medium', 'campaign']
    db.exec(`CREATE TABLE hits (ts INTEGER, screenw INTEGER DEFAULT 0, visitor TEXT DEFAULT 'new', ${text.map((c) => `${c} TEXT DEFAULT ''`).join(', ')})`)
    return db
  }
  type Hit = { iso: string; path: string; tag: string; visitor?: string; n: number }
  // Hits across ET days (09-28 .. 11-02, so one is on EST), around ET midnight and mid-day, on refused and open paths.
  const hits: Hit[] = [
    { iso: '2026-09-29T03:30:00Z', path: '/return/tag_a_made_up/d0', tag: TAG_A, n: 2 }, // ET 09-28 23:30
    { iso: '2026-09-29T04:10:00Z', path: '/return/tag_a_made_up/d0', tag: TAG_A, n: 3 }, // ET 09-29 00:10
    { iso: '2026-09-29T20:15:00Z', path: '/return/tag_b_made_up/d1', tag: TAG_B, visitor: 'returning', n: 4 },
    { iso: '2026-09-29T21:45:00Z', path: '/game/complete/normal/easy', tag: TAG_B, n: 5 },
    { iso: '2026-09-29T22:45:00Z', path: '/game/complete/normal/easy', tag: TAG_A, n: 1 },
    { iso: '2026-09-29T21:05:00Z', path: '/game/start/easy', tag: TAG_A, visitor: 'returning', n: 2 },
    { iso: '2026-09-29T20:20:00Z', path: '/', tag: TAG_A, n: 6 },
    { iso: '2026-09-29T21:20:00Z', path: '/', tag: TAG_B, n: 7 },
    { iso: '2026-09-29T21:30:00Z', path: '/signin-prompt/placement', tag: TAG_B, visitor: 'returning', n: 3 },
    { iso: '2026-09-30T10:15:00Z', path: '/', tag: TAG_B, n: 2 }, // inside the 2h maturity cut at 12:05Z, hour 10
    { iso: '2026-09-30T11:30:00Z', path: '/', tag: TAG_A, n: 4 }, // hour 11: not yet mature at 12:05Z
    { iso: '2026-09-30T11:40:00Z', path: '/return/tag_a_made_up/d0', tag: TAG_A, n: 3 }, // refused + new + hour 11
    { iso: '2026-09-30T09:40:00Z', path: '/return/tag_b_made_up/d0', tag: TAG_B, n: 5 }, // refused + new + hour 9 (matured)
    { iso: '2026-11-02T04:30:00Z', path: '/game/complete/normal/easy', tag: TAG_A, n: 2 }, // ET 11-01 23:30 EST
    { iso: '2026-11-02T05:30:00Z', path: '/game/complete/normal/easy', tag: TAG_A, n: 3 }, // ET 11-02 00:30 EST
  ]
  const load = (db: DatabaseSync) => {
    const ins = db.prepare('INSERT INTO hits (ts, site, path, campaign, visitor) VALUES (?, ?, ?, ?, ?)')
    for (const h of hits) for (let i = 0; i < h.n; i++) ins.run(Date.parse(h.iso), WEB_SITE, h.path, h.tag, h.visitor ?? 'new')
  }
  const select = (db: DatabaseSync) => async (sql: string, binds: unknown[]) => db.prepare(sql).all(...(binds as (string | number)[])) as any[]
  const NOW = Date.parse('2026-09-30T12:05:00Z')
  // The previous behaviour, as the reference: every row at its UTC hour.
  const hourRef = (): TaggedRow[] => {
    const m = new Map<string, TaggedRow>()
    for (const h of hits) {
      const ts = Date.parse(h.iso)
      const hs = Math.floor(ts / H) * H
      const k = `${hs}|${h.path}|${h.visitor ?? 'new'}|${h.tag}`
      const prev = m.get(k)
      if (prev) prev.count += h.n
      else m.set(k, { hourStartMs: hs, path: h.path, visitor: h.visitor ?? 'new', campaign: h.tag, count: h.n })
    }
    return [...m.values()]
  }
  const matured = (rows: TaggedRow[]) => rows.filter((r) => r.visitor === 'new' && (r.matured ?? r.hourStartMs + 2 * H <= NOW)).reduce((a, r) => a + r.count, 0)

  it('refused-path rows come back with an ET day and no hour; every other row keeps its hour', async () => {
    const db = openDb()
    load(db)
    const q = taggedRowsQuery(twoTag, null, NOW - 2 * H)
    expect(q.sql).toMatch(/AS etd/)
    const raws = await select(db)(q.sql, q.binds)
    expect(raws.length).toBeGreaterThan(0)
    for (const r of raws) {
      if (isSplitRefusedPath(String(r.path))) {
        expect(r.hr, String(r.path)).toBeNull()
        expect(r.etd, String(r.path)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      } else {
        expect(r.etd, String(r.path)).toBeNull()
        expect(typeof r.hr).toBe('number')
      }
    }
    // The selected columns are the dimensions of the rule-3 read and nothing finer: no ts, place or device.
    const cols = q.sql.slice(0, q.sql.indexOf(' FROM hits'))
    expect(cols).not.toMatch(/\b(country|region|city|device|browser|os|screenw)\b/)
    for (const dim of SPLIT_REFUSED_DIMS) if (dim !== 'visitor' && dim !== 'date') expect(q.sql).not.toMatch(new RegExp(`\\bGROUP BY\\b.*\\b${dim}\\b`))
  })
  it('the mapped rows put a refused row at its ET midnight, and the ET-day, cumulative and matured-arrival reads equal the hour-grouped reference', async () => {
    const db = openDb()
    load(db)
    const src = createBeaconSource(select(db) as never)
    const got = await src.tagged(twoTag, null, NOW - 2 * H)
    const ref = hourRef()
    for (const r of got) if (isSplitRefusedPath(r.path)) expect(isEtMidnight(r.hourStartMs), r.path).toBe(true)
    expect(summarizeTaggedRows(got)).toEqual(summarizeTaggedRows(ref))
    for (const d of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-11-01', '2026-11-02']) {
      const w = { fromMs: etMidnightUtcMs(d), toMs: etMidnightUtcMs(addDays(d, 1)) }
      expect(summarizeTaggedRows(got, w), d).toEqual(summarizeTaggedRows(ref, w))
      for (const tag of UC2) {
        const f = (rows: TaggedRow[]) => summarizeTaggedRows(rows.filter((r) => r.campaign === tag), w)
        expect(f(got), `${d} ${tag}`).toEqual(f(ref))
      }
    }
    // the ET-day cut sits on the right side of ET midnight (23:30 vs 00:10 ET), and across the EST change
    expect(summarizeTaggedRows(got, { fromMs: etMidnightUtcMs('2026-09-28'), toMs: etMidnightUtcMs('2026-09-29') }).taggedArrivals).toBe(2)
    expect(summarizeTaggedRows(got, { fromMs: etMidnightUtcMs('2026-11-01'), toMs: etMidnightUtcMs('2026-11-02') }).funnel.completed).toBe(2)
    expect(etDateFromMs(etMidnightUtcMs('2026-11-02') - 1)).toBe('2026-11-01')
    // the health pair's matured arrivals are the same number, refused new rows included
    expect(matured(got)).toBe(matured(ref))
    expect(matured(got)).toBeGreaterThan(0)
    // the instant flag exists only when asked for
    expect((await src.tagged(twoTag, null)).every((r) => r.matured === undefined)).toBe(true)
  })
  it('the maturity flag is on non-refused rows and on new-visitor refused rows only; a returning refused row has none', async () => {
    const db = openDb()
    load(db)
    const q = taggedRowsQuery(twoTag, null, NOW - 2 * H)
    const raws = await select(db)(q.sql, q.binds)
    const refusedReturning = raws.filter((r) => isSplitRefusedPath(String(r.path)) && r.visitor !== 'new')
    const refusedNew = raws.filter((r) => isSplitRefusedPath(String(r.path)) && r.visitor === 'new')
    expect(refusedReturning.length).toBeGreaterThan(0)
    expect(refusedNew.length).toBeGreaterThan(0)
    for (const r of refusedReturning) expect(r.mat, String(r.path)).toBeNull()
    for (const r of [...refusedNew, ...raws.filter((x) => !isSplitRefusedPath(String(x.path)))]) expect([0, 1], String(r.path)).toContain(r.mat)
    // mapped: a returning refused row carries no flag, so nothing sub-day of it reaches a rule
    const got = await createBeaconSource(select(db) as never).tagged(twoTag, null, NOW - 2 * H)
    for (const r of got) if (isSplitRefusedPath(r.path) && r.visitor !== 'new') expect(r.matured).toBeUndefined()
    // the health pair's count is unchanged
    expect(matured(got)).toBe(matured(hourRef()))
  })
  it('with the upsell-fix flag too, the pre/post split is unchanged and the binds line up with the placeholders', async () => {
    const db = openDb()
    load(db)
    const fix = Date.parse('2026-09-29T21:00:00Z')
    const q = taggedRowsQuery(twoTag, fix, NOW - 2 * H)
    expect(q.sql.match(/\?/g)?.length).toBe(q.binds.length)
    expect(q.binds.slice(0, 2)).toEqual([fix, NOW - 2 * H])
    const got = await createBeaconSource(select(db) as never).tagged(twoTag, fix, NOW - 2 * H)
    const sideCount = (rows: TaggedRow[], post: boolean) => rows.filter((r) => (r.postUpsellFix ?? false) === post).reduce((a, r) => a + r.count, 0)
    const all = hits.reduce((a, h) => a + h.n, 0)
    expect(sideCount(got, true) + sideCount(got, false)).toBe(all)
    expect(sideCount(got, true)).toBe(hits.filter((h) => Date.parse(h.iso) >= fix).reduce((a, h) => a + h.n, 0))
  })
})

// ── end to end: the rules read the arm's total ──────────────────────────────────────────────
type FxRow = NonNullable<Fixture['beacon'] extends infer B ? (B extends { tagged: infer T } ? T : never) : never>[number]
const baseRows = (): FxRow[] => [
  { hour: '2026-09-27T17:00:00Z', path: '/', visitor: 'new', count: 18 },
  { hour: '2026-09-29T20:00:00Z', path: '/', visitor: 'new', count: 12 },
  { hour: '2026-09-29T20:00:00Z', path: '/game', visitor: 'returning', count: 64 },
  { hour: '2026-09-29T20:00:00Z', path: '/game/complete/normal/easy', visitor: 'new', count: 9 },
  { hour: '2026-09-28T21:00:00Z', path: '/signin-prompt/placement', visitor: 'returning', count: 3 },
  { hour: '2026-09-29T21:00:00Z', path: '/signin-prompt/placement', visitor: 'returning', count: 5 },
  { hour: '2026-09-29T21:00:00Z', path: '/promo-first50/shown', visitor: 'returning', count: 2 },
  { hour: '2026-09-29T21:00:00Z', path: '/signin-prompt/dismiss', visitor: 'returning', count: 2 },
  { hour: '2026-09-29T21:00:00Z', path: '/signin-prompt/accept', visitor: 'returning', count: 1 },
  { hour: '2026-09-29T21:00:00Z', path: '/auth/redirect/google', visitor: 'returning', count: 1 },
  { hour: '2026-09-29T21:00:00Z', path: '/auth/success/google', visitor: 'returning', count: 3 },
  { hour: '2026-09-29T21:00:00Z', path: '/auth/success/google/new', visitor: 'returning', count: 3 },
  { hour: '2026-09-28T22:00:00Z', path: '/install/prompt/android', visitor: 'returning', count: 4 },
  { hour: '2026-09-28T22:00:00Z', path: '/install/pwa-accept', visitor: 'returning', count: 1 },
  { hour: '2026-09-28T22:00:00Z', path: '/signin-eligible/earned', visitor: 'returning', count: 5 },
  { hour: '2026-09-29T22:00:00Z', path: `/return/${RETEST_UC}/d0`, visitor: 'new', count: 8 },
  { hour: '2026-09-29T22:00:00Z', path: '/tour/start', visitor: 'new', count: 6 },
]
/** The same events as the single-tag fixture, each row cut into two rows for TAG_A / TAG_B. */
const twoTagFixture = (): Fixture => {
  const fx = baseFixture()
  const b = fx.beacon as Extract<NonNullable<Fixture['beacon']>, { tagged: unknown }>
  b.tagged = baseRows().flatMap((r) => {
    const a = Math.ceil(r.count / 2)
    const rest = r.count - a
    return [{ ...r, count: a, campaign: TAG_A, path: r.path.split(RETEST_UC).join(TAG_A) }, ...(rest > 0 ? [{ ...r, count: rest, campaign: TAG_B, path: r.path.split(RETEST_UC).join(TAG_B) }] : [])]
  })
  b.returns = b.returns.flatMap((r) => {
    const a = Math.ceil(r.count / 2)
    const rest = r.count - a
    return [{ ...r, count: a, path: r.path.split(RETEST_UC).join(TAG_A) }, ...(rest > 0 ? [{ ...r, count: rest, path: r.path.split(RETEST_UC).join(TAG_B) }] : [])]
  })
  const ads = fx.ads as Extract<NonNullable<Fixture['ads']>, { daily: unknown }>
  ads.adDaily = [
    { date: '2026-09-28', adId: 'ad-1', finalUrls: [url(TAG_A)], costMicros: 20_000_000, impressions: 3000, clicks: 30 },
    { date: '2026-09-29', adId: 'ad-1', finalUrls: [url(TAG_A)], costMicros: 12_000_000, impressions: 2000, clicks: 20 },
    { date: '2026-09-29', adId: 'ad-2', finalUrls: [url(TAG_B)], costMicros: 18_000_000, impressions: 2500, clicks: 25 },
  ]
  return fx
}
const singleTagFixture = (): Fixture => {
  const fx = baseFixture()
  const b = fx.beacon as Extract<NonNullable<Fixture['beacon']>, { tagged: unknown }>
  b.tagged = baseRows().map((r) => ({ ...r, campaign: RETEST_UC }))
  return fx
}

const retest = campaignById(RETEST)!
const realUc = [...retest.ucValues]
afterEach(() => {
  ;(retest as { ucValues: string[] }).ucValues = [...realUc]
})
const asTwoTag = () => {
  ;(retest as { ucValues: string[] }).ucValues = [...UC2]
}

describe('the rules read the arm\'s summed total, not one tag', () => {
  it('a two-tag arm gives the same kill rules, threshold read, tagged read, returns and first-session funnel as the single-tag arm', async () => {
    const single = await runMorningRead(fixtureDeps(singleTagFixture(), true), opts)
    asTwoTag()
    const two = await runMorningRead(fixtureDeps(twoTagFixture(), true), opts)
    expect(single.thresholdRead).not.toBeNull()
    expect(two.thresholdRead).not.toBeNull()
    expect(single.thresholdRead!.tagged!.summary.taggedArrivals).toBeGreaterThan(0)
    expect(two.thresholdRead!.kill).toEqual(single.thresholdRead!.kill)
    expect(two.thresholdRead!.decision).toEqual(single.thresholdRead!.decision)
    expect(two.thresholdRead!.tagged).toEqual(single.thresholdRead!.tagged)
    expect(two.thresholdRead!.returns).toEqual(single.thresholdRead!.returns)
    expect(two.thresholdRead!.segments).toEqual(single.thresholdRead!.segments)
    expect(two.thresholdRead!.complete).toBe(single.thresholdRead!.complete)
    expect(two.thresholds).toEqual(single.thresholds)
    expect(two.tagged).toEqual(single.tagged)
    expect(single.firstSession).not.toBeNull()
    expect(two.firstSession).toEqual(single.firstSession)
    expect(two.releaseHealth).toEqual(single.releaseHealth)
    expect(two.hardCapDaily).toEqual(single.hardCapDaily)
    expect(two.spend).toEqual(single.spend)
  })
  it('the two-tag report carries the split in the daily block and the threshold read; the single-tag report does not', async () => {
    const single = await runMorningRead(fixtureDeps(singleTagFixture(), true), opts)
    asTwoTag()
    const two = await runMorningRead(fixtureDeps(twoTagFixture(), true), opts)
    expect(single.tagSplit).toBeNull()
    expect(single.thresholdRead!.tagSplit).toBeNull()
    expect(formatMorningReport(single)).not.toContain('Per-tag split')
    const text = formatMorningReport(two)
    expect(text.match(/Per-tag split/g)).toHaveLength(2) // the daily block and the threshold read
    expect(two.tagSplit!.tags.map((t) => t.tag)).toEqual(UC2)
    // the split adds up to the arm total the rules read
    const sum = (f: (c: { arrivals: number; completes: number; asks: number; newAccounts: number }) => number) => two.tagSplit!.tags.reduce((a, t) => a + f(t.total), 0)
    expect(sum((c) => c.arrivals)).toBe(two.tagged.cumulative!.taggedArrivals)
    expect(sum((c) => c.asks)).toBe(two.tagged.cumulative!.asks)
    const sumY = two.tagSplit!.tags.reduce((a, t) => a + t.yesterday!.arrivals, 0)
    expect(sumY).toBe(two.tagged.yesterday!.taggedArrivals)
    // ad cost: A = $20 + $12, B = $18 on the closed days, both mapped by the link's tag
    expect(two.tagSplit!.tags.map((t) => t.cost)).toEqual([32, 18])
    expect(two.tagSplit!.costRead).toBe(true)
  })
  it('a failed ad-cost read never fails the read or reaches its errors; the split still prints with the reason', async () => {
    asTwoTag()
    const fx = twoTagFixture()
    const deps = fixtureDeps(fx, true)
    deps.ads!.adDaily = async () => {
      throw new Error('boom')
    }
    const two = await runMorningRead(deps, opts)
    expect(two.tagSplit!.costRead).toBe(false)
    expect(two.tagSplit!.tags[0].total.arrivals).toBeGreaterThan(0)
    expect(two.thresholdRead!.complete).toBe(true)
    expect(two.thresholdRead!.errors.join(' ')).not.toContain('boom')
    expect(formatMorningReport(two)).toContain('ad cost: not read')
  })
  it('the post-flight read splits too, with cumulative counts only', async () => {
    asTwoTag()
    const fx = twoTagFixture()
    const r = await runPostflightRead(fixtureDeps({ ...fx, now: '2026-10-03T12:05:00Z' }, true), { campaignId: RETEST, stage: 'wrapup', force: true })
    const sp = r.read!.tagSplit!
    expect(sp.tags.map((t) => t.tag)).toEqual(UC2)
    expect(sp.tags.every((t) => t.yesterday === null)).toBe(true)
    expect(sp.tags.reduce((a, t) => a + t.total.arrivals, 0)).toBe(r.read!.tagged!.summary.taggedArrivals)
    expect(r.read!.tagged!.summary.taggedArrivals).toBeGreaterThan(0)
  })
  it('a single-tag arm\'s read is the same as before: no split, no cost query', async () => {
    const fx = singleTagFixture()
    const deps = fixtureDeps(fx, true)
    let queried = 0
    deps.ads!.adDaily = async () => {
      queried++
      return []
    }
    const r = await runMorningRead(deps, opts)
    expect(queried).toBe(0)
    expect(r.tagSplit).toBeNull()
    expect(JSON.stringify(r)).not.toContain('Per-tag split')
  })
})

// ── flight 3 staged ─────────────────────────────────────────────────────────────────────────
describe('flight 3 staged Apps arm', () => {
  it('has the hero, features and bare tags, each a valid return-path tag, none shared with Search', () => {
    const apps = STAGED_FLIGHT_3.apps.ucValues
    expect(apps).toEqual(['sudoku_funnel_f3_apps_hero', 'sudoku_funnel_f3_apps_feat', 'sudoku_funnel_f3_apps'])
    for (const t of apps) expect(/^[a-z][a-z0-9_]{0,39}$/.test(t), t).toBe(true) // the shape campaigns.ts parseReturnPath accepts
    for (const t of STAGED_FLIGHT_3.search.ucValues) expect(apps).not.toContain(t)
    expect(new Set(apps).size).toBe(3)
  })
  it('stays inert while staged: neither arm is registered, and activation copies the tags unchanged', () => {
    const restore = hideLiveFlight3() // the staged state, whatever the real STAGED_FLIGHT_3_DATES hold
    try {
      expect(CAMPAIGNS.some((c) => c.ucValues.some((u) => u.startsWith('sudoku_funnel_f3_')))).toBe(false)
    } finally {
      restore()
    }
    const c = stagedCampaign('apps', { id: '99900000011', flightStart: '2026-10-20', flightEnd: '2026-10-26' })
    expect(c.ucValues).toEqual(STAGED_FLIGHT_3.apps.ucValues)
    expect(isMultiTag(c.ucValues)).toBe(true)
    expect(isMultiTag(STAGED_FLIGHT_3.search.ucValues)).toBe(false)
  })
})
