// @vitest-environment happy-dom
//
// PARITY (ADR 0003 slice 7): every panel slice 7 converts, rendered the NEW way (a card preset
// over POST /api/metrics, or a generic chart over /api/geo) against the OLD bespoke body over its
// own endpoint, on ONE node:sqlite fixture (functions/_lib/testing/bskFixture.ts, plus the rows a
// panel needs that the shared fixture lacks), asserting the same visible numbers. Every visible
// difference is listed next to the panel and asserted as itself, so none can appear silently.
//
// THE OLD SIDE is a golden (__fixtures__/slice7.golden.json): each old rendering was read from the
// old body mounted over its old endpoint, on this same fixture, and checked live against this
// file (commit 76caad5) the commit before the bodies and endpoints were retired.
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
//
// Pop-ups rate table (popup 'rateTable' → preset popup-rates):
//   L2  Layout: each old row's "%" and "n / d" cells read as one value, "36.4% (4/11)"; the
//       labels are the old ones, in the old order.
//   N3  The install fix caveat the old table printed under the installed-rate label is in the
//       card's Notes (the registry's install-fix note), as every other card's caveats are.
// Sign-in eligibility (popup 'eligible' bar chart → preset signin-eligibility):
//   L3  The three counts are the card's bars (labels and values as the chart's bars).
//   A1  Added: the eligibility rate (earned over all three, a valid partition ratio) under them.
//
// Campaign cost (campaigns 'cost' → preset campaign-cost), with an ads store in the fixture:
//   L4  The one freshness line "Spend through Sep 9 · synced 1h ago" is two rows, "Spend
//       through" and "Synced"; a stale campaign's "stale — sync pending" is a line under the
//       date. The spend-only reason is the card's section heading instead of a line of its own.
//   C1  The spend-only Play-direct card omits "Per arrival" and "Per auth success": it can have
//       no beacon arrivals or sign-ins (old: "—" for both).
//   C2  A cost over fewer than MIN_COHORT arrivals or sign-ins reads "too few to report" (the
//       registry gates every cost like every rate); the old endpoint returned no value, "—".
//   A2  The "Refresh data" button is the card's action, above the cards, as before.
//
// Funnel per campaign (campaigns 'funnel' → preset campaign-funnel):
//   F1  "tagged hits: 180 (vs 50 arrivals)" reads "Tagged hits vs arrivals: 180 hits · 50 arrivals".
//   F2  The install step's label no longer carries the install-fix caveat in brackets; the
//       caveat is in the card's Notes. The two rate lines are pills: "Accept of asks: 26.7%
//       (4/15)" for "26.7% of previous step (4/15)", and "Install of prompts shown post-fix".
//   F3  Each campaign's own colour (its dot and its bars) is the cards' standard bar colour, and
//       a bar's length is relative to the card's largest SHOWN step (the old one counted
//       omitted steps too).
//   D1  The retest's install rate: the registry counts prompts from the install fix row-exactly
//       (denominator 9), /api/campaigns by hour (4) — as in the scorecard.
//   D2  The active retest's not-yet-seen accept step: old "not instrumented" (count and rate),
//       new its live count 0 and "0.0% (0/6)".
//   M1  The upsell-fix segment table moved here from the flight-day panel (that panel is a
//       standard chart now); it stays hidden until lib/adsRules.ts UPSELL_SIGNEDOUT_FIX_AT is
//       set — slice7.upsell.test.ts sets it and compares both.
//
// Arrivals & funnel by country (campaigns 'country' → preset campaign-country):
//   No visible difference: the same steps as rows, US / CA / Other as columns, the same counts,
//   a closed flight's unmeasured steps omitted. (An active flight's not-yet-seen step reads its
//   live count on both, as the old table never labelled it.)
//
// An upcoming flight (before its start, or with no start date yet), on both cards:
//   U1  Shown, as the old panels showed every beacon-tracked campaign: the funnel card with
//       Arrivals 0 and every other step "not started" (old: "not instrumented"), the country
//       card with every cell "not started" (old: 0, a count it could not have measured). A flight
//       with no start date is never queried.
//
// Return visits (campaigns 'returns' → preset campaign-returns):
//   RV1 The per-campaign line chart of return rates is a row of bars side by side, d1 to d31-60,
//       each with its rate and (n/d) (the old counts line "d0=6 · d1=0.0% (0/6) · …" split
//       onto the bars); d0 is its own row.
//   RV2 Fewer than MIN_COHORT first tagged loads: the old one line "too few to report (d0 = 3,
//       need 5)" is the d0 row (3) and "too few to report (n/3)" on each bar.
//   Same: the same campaigns (a flight that ended before the return beacon existed, and a
//   campaign with no return beacons yet, are left out); none left → "No return visits recorded
//   yet."; the rates' lag note is in the card's Notes.
//
// Arrivals by ET hour of day (campaigns 'hourOfDay' → a standard breakdown bar over /api/geo:
// dimension hourEt × campaignFlight, filter arrival = tagged):
//   H1  An hour with no arrivals for a campaign has no bar (and no tooltip line), where the old
//       chart drew a 0-height bar; every count is the same. The legend sits at the top on a
//       desktop, as on every breakdown bar.
// Daily arrivals by flight day (campaigns 'flightDay' → a standard line over /api/geo: dimension
// flightDay × campaignFlight, filter arrival = tagged, `cumulative`):
//   FD1 The two charts (daily left, cumulative right) are one chart: the daily lines solid on the
//       left axis, each campaign's running total dashed on a right-hand "cumulative" axis.
//       Same days (Day 1 to the longest flight), same counts, same running totals.
//   M1  (above) the upsell-fix segment table is on the funnel card; the "▼ upsell fix" day label
//       stays on this chart's axis (lib/charts.ts formatKey, once the fix is set).
//   Numbers: the /api/geo rows against /api/campaigns' own hourOfDayEt and daily series, per
//   campaign, per hour and per flight day, plus the running totals, with rows on both DST
//   changes and at the retest's 12:00 ET attribution start — no difference.
//   Range: both charts read "since first campaign" (ET midnight of the earliest flight start), so,
//       like /api/campaigns, nothing past a flight's attribution start ever drops off; checked
//       below two years on, against the same golden. They differ at the OTHER end (v0.12.1,
//       lib/range.ts): hour-of-day always ends "now"; flight-day ends "until last campaign ends"
//       instead — a fixed instant once every flight is over, so its range (and cache key) stops
//       growing on every load, and "now" only while any flight is open-ended or still running
//       (range.test.ts covers the 2026-10-02 retest-end transition).
//   Series: every beacon-tracked campaign, a campaign with no arrivals — including one with no
//       start date yet, which can never be attributed any rows — at 0 (in the legend, and in the
//       tooltip), as on the old charts and as the funnel/country cards already draw it; the
//       flight-day axis runs to the longest of those flights whether or not it has rows
//       (lib/breakdownBar.test.ts).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { onRequestPost as metricsPost } from '../../../functions/api/metrics'
import { onRequestPost as popupsPost } from '../../../functions/api/popups'
import { onRequestPost as geoPost } from '../../../functions/api/geo'
import { flightDayWidget, hourOfDayWidget } from '../../lib/defaults'
import type { ChartConfiguration } from 'chart.js'
import { CAMPAIGNS } from '../../lib/campaigns'
const CAMPAIGNS_LIST = () => CAMPAIGNS
import { DatabaseSync } from 'node:sqlite'
import ChartCard from '../ChartCard.vue'
import { fetchStats } from '../../api'
import { buildChartConfig } from '../../lib/charts'
import { BEST_SUDOKU_SITES } from '../../lib/bestSudokuSites'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../../../functions/_lib/testing/hitsDb'
import { bskFixture, FIXTURE_NOW } from '../../../functions/_lib/testing/bskFixture'
import { defaultFilters } from '../../lib/defaults'
import type { Widget } from '../../types'
import GOLDEN_FILE from './__fixtures__/slice7.golden.json'

const GOLDEN = GOLDEN_FILE as Record<string, unknown>
/** The old side of a comparison, as captured from the retired body (see the header). */
function fromGolden<T = any>(key: string): T {
  if (!Object.hasOwn(GOLDEN, key)) throw new Error(`no golden for "${key}"`)
  return JSON.parse(JSON.stringify(GOLDEN[key])) as T
}

/** Rows the shared fixture lacks: the owner's own visits (Opera on Windows), which "hide my own
 * visits" must drop from the pop-up figures on both paths. */
const PARITY_EXTRA = [
  { ts: Date.parse('2026-09-26T14:30:00Z'), site: 'bestsudoku-web', path: '/upsell/shown/limit', visitor: 'returning', browser: 'Opera', os: 'Windows', n: 3 },
  { ts: Date.parse('2026-09-26T14:31:00Z'), site: 'bestsudoku-web', path: '/upsell/accept/limit', visitor: 'returning', browser: 'Opera', os: 'Windows', n: 3 },
  { ts: Date.parse('2026-09-26T14:32:00Z'), site: 'bestsudoku-web', path: '/signin-eligible/earned', visitor: 'returning', browser: 'Opera', os: 'Windows', n: 2 },
]
let db: ReturnType<typeof openHitsDb>
let cache: ReturnType<typeof memoryCache>
let undoCaches: () => void
const mounted: VueWrapper[] = []

const HANDLERS: Record<string, (ctx: any) => Response | Promise<Response>> = {
  '/api/metrics': metricsPost,
  '/api/popups': popupsPost,
  '/api/geo': geoPost,
}
/** gss-stats' own ads store, for the cost panel: stored spend for two campaigns (Android's whole
 * flight, closed days; the retest's first, still-open day), none for Play-direct (it falls back to
 * the hand-entered figure), and one finished sync run. */
function adsDb(): DatabaseSync {
  const a = new DatabaseSync(':memory:')
  a.exec('CREATE TABLE ads_daily_metrics (campaign_id TEXT, date TEXT, cost_micros INTEGER, impressions INTEGER, clicks INTEGER, source TEXT, fetched_at TEXT, placements_fetched_at TEXT)')
  a.exec('CREATE TABLE ads_sync_runs (campaigns_ok TEXT, campaigns_pulled TEXT, finished_at TEXT, status TEXT)')
  const ins = a.prepare("INSERT INTO ads_daily_metrics VALUES (?, ?, ?, 100, 10, 'google-ads-api', ?, NULL)")
  for (let d = 2; d <= 9; d++) ins.run('24215315197', `2026-09-0${d}`, 15_000_000, '2026-09-10T12:00:00Z')
  ins.run('24279250691', '2026-09-26', 5_000_000, '2026-09-26T20:00:00Z')
  a.prepare('INSERT INTO ads_sync_runs VALUES (?, ?, ?, ?)').run('["24215315197","24279250691"]', '["24215315197","24279250691"]', '2026-09-26T19:30:00Z', 'ok')
  return a
}
let ads: DatabaseSync
async function route(url: string, init: RequestInit): Promise<Response> {
  const path = new URL(url, 'https://stats.goodstuff.software').pathname
  const handler = HANDLERS[path]
  if (!handler) throw new Error(`unexpected fetch ${path}`)
  const waited: Promise<unknown>[] = []
  const res = await handler(pagesContext(postJson(path, JSON.parse(String(init.body ?? '{}'))), { gss_geo: sqliteD1(db), gss_stats_ads: sqliteD1(ads as never) } as never, waited))
  await Promise.all(waited)
  return res
}

beforeAll(() => {
  db = openHitsDb()
  insertHits(db, [...bskFixture(), ...PARITY_EXTRA])
  ads = adsDb()
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

  it('two days after the release: the same four counts on each side, except R1', async () => {
    const now = Date.parse('2026-09-28T16:00:00Z')
    vi.setSystemTime(now)
    const old = fromGolden<{ caption: string; cols: Record<string, Record<string, string>> }>('release.twoDaysAfter')
    expect(old.caption).toMatch(/^v1\.95\.3 \(2026-09-26\) — 2 days before vs after\. before = partially instrumented/)
    const card = await mountCard('release-before-after', now)
    const r = rows(card)
    expect(r.get('Release')).toBe('v1.95.3 (2026-09-26)') // L1
    expect(r.get('Days on each side')).toBe('2') // L1: the "2 days" of the old line
    const t = columnTable(card)
    expect([...t.keys()]).toEqual(LABELS)
    for (const side of ['Before', 'After']) {
      for (const label of LABELS) {
        const was = old.cols[side][label]
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
    expect(Number(old.cols.Before['Page views'].replace(/,/g, ''))).toBeGreaterThan(0)
    expect(Number(old.cols.After.Installs)).toBeGreaterThan(0)
    expect(Number(old.cols.After['Tagged arrivals'])).toBeGreaterThan(0)
    // The note under the panel is unchanged (L1).
    expect(text(card.find('.mc-captions').element)).toBe(old.caption.slice(old.caption.indexOf('before = ')))
  })

  it('R2: on the release day itself (no full day after it), both say there is nothing to compare yet', async () => {
    const old = fromGolden<string>('release.releaseDay')
    expect(old).toBe('No dated release yet. This panel fills in once a release has a date.')
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

// ── Pop-ups page ──────────────────────────────────────────────────────────────────────────
describe('the Pop-ups page panels ≡ their /api/popups renderings', () => {
  const filters = { ...defaultFilters(), siteSel: [...BEST_SUDOKU_SITES], since: '2026-09-20T04:00:00.000Z', until: '2026-09-27T04:00:00.000Z', rangeRel: '', excludeOwnVisits: true, ownBrowser: 'Opera', ownOS: 'Windows' }

  it('popup-rates: every old rate row, same label, same rate and n/d (L2), the install caveat in Notes (N3), PLUS the new signed-in/returned/still-playing count tiles (A2, review round 2026-09-27)', async () => {
    const oldRows = fromGolden<{ label: string; value: string; note: string }[]>('popups.rateTable')
    expect(oldRows.length).toBe(6)
    const card = await mountCard('popup-rates', FIXTURE_NOW, { since: filters.since, until: filters.until, sites: [...BEST_SUDOKU_SITES], excludeOwnVisits: true, ownBrowser: 'Opera', ownOS: 'Windows' })
    const newRows = [...rows(card)].map(([label, value]) => ({ label, value }))
    // The original 6 rate rows are byte-for-byte unchanged (parity with the retired panel).
    expect(newRows.slice(0, 6)).toEqual(oldRows.map(({ label, value }) => ({ label, value })))
    // Real rates, a zero one, and the owner's own taps left out on both sides (4/11, not 7/14).
    expect(newRows.find((r) => r.label.startsWith('Upsell'))!.value).toBe('36.4% (4/11)')
    expect(newRows.some((r) => r.value.startsWith('0.0% ('))).toBe(true)
    // New: signed-in/returned/still-playing, one row per pop-up, appended after the 6 rate rows.
    // A count, never a rate (these are lagged cohorts — see presets.ts's comment); an explicit
    // "0" where a pop-up had no rows this range (never blank), and "not yet tracking" for
    // first50-congrats (POPUPS.noOutcomeTracking — a product decision, not a gap).
    expect(newRows.length).toBe(6 + 5 * 3) // 5 pop-ups x {signed-in, returned, still-playing}
    const byLabel = new Map(newRows.map((r) => [r.label, r.value]))
    expect(byLabel.get('First 50 congrats — signed in')).toBe('not yet tracking')
    expect(byLabel.get('First 50 congrats — returned')).toBe('not yet tracking')
    expect(byLabel.get('First 50 congrats — still playing')).toBe('not yet tracking')
    expect(byLabel.get('Sign-in prompt — signed in')).toBe('1') // a real, nonzero count
    expect(byLabel.get('Upsell — returned')).toBe('1') // a real, nonzero count
    expect(byLabel.get('First 50 promo — signed in')).toBe('0') // explicit zero, never blank
    expect(byLabel.get('Install prompt — still playing')).toBe('0') // explicit zero, never blank
    // N3: the old inline caveat, now a Notes line for the installed rate.
    const oldNote = oldRows.find((r) => r.label.startsWith('Install prompt — installed'))!.note
    expect(oldNote).toMatch(/install fix/i)
    await card.find('button.mc-notes-toggle').trigger('click')
    const notes = card.findAll('.mc-notes li').map((li) => text(li.element))
    expect(notes.some((l) => l.startsWith('Install prompt — installed rate (from the install fix on): ') && /install fix/i.test(l))).toBe(true)
  })

  it('signin-eligibility: the chart bars are the card bars (L3), plus the rate (A1)', async () => {
    const oldBars = fromGolden<[string, string][]>('popups.eligibility')
    expect(oldBars).toEqual([['earned', '4'], ['capped', '2'], ['unearned', '1']]) // Opera's 2 left out
    const card = await mountCard('signin-eligibility', FIXTURE_NOW, { since: filters.since, until: filters.until, sites: [...BEST_SUDOKU_SITES], excludeOwnVisits: true, ownBrowser: 'Opera', ownOS: 'Windows' })
    const r = [...rows(card)]
    expect(r.slice(0, 3)).toEqual(oldBars)
    expect(card.findAll('.mi-bar-fill').map((b) => (b.element as HTMLElement).style.width)).toEqual(['100%', '50%', '25%'])
    expect(r[3]).toEqual(['Sign-in eligibility rate', '57.1% (4/7)']) // A1
  })
})

// ── Campaigns page ────────────────────────────────────────────────────────────────────────

describe('campaign-cost ≡ the bespoke cost panel', () => {
  it('same campaigns, spend, source, freshness and costs, except L4, C1, C2 (A2: the refresh action)', async () => {
    const oldSide = fromGolden<{ refresh: boolean; cards: { title: string; why: string; rows: Record<string, string>; fresh: string }[] }>('campaigns.cost')
    const oldCards = oldSide.cards
    expect(oldCards.map((c) => c.title)).toHaveLength(3)
    const card = await mountCard('campaign-cost', FIXTURE_NOW)
    expect(card.find('.mc-actions .ads-refresh button').exists()).toBe(true) // A2
    expect(oldSide.refresh).toBe(true)
    const newCards = card.findAll('.metric-card').map((c) => ({
      title: text(c.find('.mc-title').element),
      why: c.find('.section-title').exists() ? text(c.find('.section-title').element) : '',
      rows: new Map(c.findAll('.mi-row').map((r) => [text(r.find('.mi-label').element), text(r.find('.mi-value').element)])),
      stale: c.findAll('.mi-caption').map((x) => text(x.element)).join(' '),
    }))
    expect(newCards.map((c) => c.title)).toEqual(oldCards.map((c) => c.title))
    const seen = new Set<string>()
    for (const o of oldCards) {
      const n = newCards.find((c) => c.title === o.title)!
      expect(n.why, `${o.title}: L4 spend-only reason`).toBe(o.why)
      expect(n.rows.get('Spend'), o.title).toBe(o.rows.Spend)
      expect(n.rows.get('Source'), o.title).toBe(o.rows.Source)
      // L4: the freshness line, from the two rows (and the stale line under the date).
      const through = n.rows.get('Spend through')!
      const synced = n.rows.get('Synced')!
      const line = `${through === 'no closed spend day stored yet' ? 'No closed spend day stored yet' : `Spend through ${through}`} · ${synced === 'not synced yet' ? 'not synced yet' : `synced ${synced}`}${n.stale ? ` · ${n.stale}` : ''}`
      expect(line, `${o.title}: L4`).toBe(o.fresh)
      for (const label of ['Per arrival', 'Per auth success']) {
        const was = o.rows[label]
        const now = n.rows.get(label)
        if (o.why) {
          expect([was, now], `${o.title} ${label}: C1`).toEqual(['—', undefined])
          seen.add('C1')
        } else if (was === '—' && now === 'too few to report') {
          seen.add('C2')
        } else {
          expect(now, `${o.title} ${label}`).toBe(was)
        }
      }
    }
    expect([...seen].sort()).toEqual(['C1', 'C2']) // every listed difference still occurs
    // The fixture exercises both sources and a real cost.
    expect(newCards.map((c) => c.rows.get('Source'))).toEqual(expect.arrayContaining(['Ads API', 'hand-entered']))
    expect(newCards.some((c) => /^\$\d+\.\d{2}$/.test(c.rows.get('Per arrival') ?? ''))).toBe(true)
  })
})

describe('campaign-funnel ≡ the bespoke funnel panel', () => {
  interface Col {
    status: string
    lines: string[]
    steps: [string, { count: string; rate: string }][]
  }

  it('same beacon campaigns, status, counts and valid rates, except F1-F3, D1, D2', async () => {
    const old = new Map(fromGolden<[string, Col][]>('campaigns.funnel').map(([t, c]) => [t, { ...c, steps: new Map(c.steps) }]))
    const card = await mountCard('campaign-funnel', FIXTURE_NOW)
    const cards = new Map(card.findAll('.metric-card').map((c) => [text(c.find('.mc-title').element), c]))
    expect([...cards.keys()]).toEqual([...old.keys()]) // the spend-only campaign is in neither
    expect(old.size).toBe(2)
    const seen = new Set<string>()
    for (const [title, o] of old) {
      const c = cards.get(title)!
      expect(text(c.find('.mc-badge').element), title).toBe(o.status)
      const sections = c.findAll('.metric-section')
      const rowsOf = (i: number) => new Map(sections[i].findAll('.mi-row').map((r) => [text(r.find('.mi-label').element), text(r.find('.mi-value').element)]))
      const top = rowsOf(0)
      // F1: the tagged-hits line, as counts.
      const hits = /^tagged hits: ([\d,]+) \(vs ([\d,]+) arrivals\)$/.exec(o.lines[0])!
      expect(top.get('Tagged hits vs arrivals'), title).toBe(`${hits[1]} hits · ${hits[2]} arrivals`)
      seen.add('F1')
      expect(`${[...top.keys()][1]}: ${top.get([...top.keys()][1])}`, title).toBe(o.lines[1])
      const bars = rowsOf(1)
      for (const [label, st] of o.steps) {
        if (st.count === 'not instrumented') {
          expect(c.find('.mc-badge').text(), `${title} ${label}: D2 only on an active flight`).toBe('active')
          expect(bars.get(label), `${title} ${label}: D2`).toBe('0')
          seen.add('D2')
        } else {
          expect(bars.get(label), `${title} ${label}`).toBe(st.count)
        }
      }
      expect([...bars.keys()], `${title}: no step appears that the old view omitted`).toEqual([...o.steps.keys()])
      const pills = new Map(c.findAll('.mi-pill').map((p) => [text(p.element).slice(0, text(p.element).indexOf(':')), text(p.element).slice(text(p.element).indexOf(':') + 1).trim()]))
      for (const [label, st] of o.steps) {
        if (!st.rate) continue
        const pill = label === 'Accept' ? 'Accept of asks' : 'Install of prompts shown post-fix'
        const got = pills.get(pill)
        seen.add('F2')
        if (st.rate === 'not instrumented') {
          expect(got, `${title}: D2`).toBe('0.0% (0/6)')
          continue
        }
        const m = /^(.*?) of (previous step|prompts shown post-fix) \((\d+)\/(\d+)\)$/.exec(st.rate)!
        if (label === 'Install' && got !== `${m[1]} (${m[3]}/${m[4]})`) {
          expect([st.rate, got], `${title}: D1`).toEqual(['too few to report of prompts shown post-fix (2/4)', '22.2% (2/9)'])
          seen.add('D1')
          continue
        }
        expect(got, `${title} ${label}`).toBe(`${m[1]} (${m[3]}/${m[4]})`)
      }
      expect(c.findAll('.mi-bar-fill').length).toBe(bars.size) // F3: a bar per shown step
    }
    expect([...seen].sort()).toEqual(['D1', 'D2', 'F1', 'F2'])
  })

  it('M1: with the upsell fix unset, no card shows a segment table', async () => {
    const card = await mountCard('campaign-funnel', FIXTURE_NOW)
    expect(card.findAll('.metric-section.layout-table')).toHaveLength(0)
    expect(card.text()).not.toMatch(/upsell fix/)
  })
})

describe('an upcoming flight: its funnel and country cards show, as the old panels did', () => {
  // The old panels drew every beacon-tracked campaign: an upcoming one had its arrivals at 0 and
  // every other step unmeasured. The cards match: Arrivals 0, every other step "not started" (a
  // flight whose window opens later, or with no start date yet), and the country card too.
  const STEPS = ['Game-screen views', 'Completed a game', 'Sign-in ask', 'Accept', 'Auth success', 'Install prompt', 'Install']
  const byTitle = (w: VueWrapper) => new Map(w.findAll('.metric-card').filter((c) => (c.element as HTMLElement).style.display !== 'none').map((c) => [text(c.find('.mc-title').element), c]))
  const barsOf = (c: ReturnType<VueWrapper['find']>) => new Map(c.findAll('.metric-section.layout-bars .mi-row').map((r) => [text(r.find('.mi-label').element), text(r.find('.mi-value').element)]))
  function expectUpcomingFunnel(c: ReturnType<VueWrapper['find']>, title: string) {
    const bars = barsOf(c)
    expect(bars.get('Arrivals'), title).toBe('0')
    for (const step of STEPS) expect(bars.get(step), `${title} ${step}`).toBe('not started')
    expect(text(c.find('.metric-section.layout-rows').element), title).toMatch(/not started/)
    for (const pill of c.findAll('.mi-pill')) expect(text(pill.element), title).toMatch(/: not started$/)
  }
  function expectUpcomingCountry(c: ReturnType<VueWrapper['find']>, title: string) {
    const t = c.find('table.metric-table.columns')
    const body = t.findAll('tbody tr').map((tr) => [text(tr.find('th').element), ...tr.findAll('td').map((td) => text(td.element))])
    expect(body.map((r) => r[0]), title).toEqual(['Arrivals', ...STEPS])
    for (const r of body) expect(r.slice(1), `${title} ${r[0]}`).toEqual(['not started', 'not started', 'not started'])
  }

  it('before its start date (the retest on 2026-09-20)', async () => {
    const now = Date.parse('2026-09-20T16:00:00Z')
    vi.setSystemTime(now)
    const funnel = byTitle(await mountCard('campaign-funnel', now))
    const retest = CAMPAIGNS.find((c) => c.id === '24279250691')!
    expect([...funnel.keys()]).toContain(retest.label)
    expectUpcomingFunnel(funnel.get(retest.label)!, retest.label)
    const country = byTitle(await mountCard('campaign-country', now))
    expectUpcomingCountry(country.get(retest.label)!, retest.label)
  })

  it('with no start date yet (a pending flight): never asked, the same card; the scorecard still omits its steps', async () => {
    const retest = CAMPAIGNS.find((c) => c.id === '24279250691')!
    const pending = { ...retest, id: '99999999999', label: 'Upcoming test flight', status: 'upcoming' as const, flightStart: null, flightStartTimeEt: undefined }
    CAMPAIGNS.push(pending)
    try {
      const funnel = byTitle(await mountCard('campaign-funnel', FIXTURE_NOW))
      expectUpcomingFunnel(funnel.get(pending.label)!, pending.label)
      const country = byTitle(await mountCard('campaign-country', FIXTURE_NOW))
      expectUpcomingCountry(country.get(pending.label)!, pending.label)
      const scorecard = byTitle(await mountCard('campaign-scorecard', FIXTURE_NOW))
      expect(text(scorecard.get(pending.label)!.element)).not.toMatch(/not started|Arrivals/)
      const asked = (vi.mocked(fetch).mock.calls as [string, RequestInit][]).flatMap(([, init]) => JSON.parse(String(init.body ?? '{}')).requests ?? [])
      expect(asked.filter((r: { params?: { campaignId?: string } }) => r.params?.campaignId === pending.id).map((r: { metric?: string; ratio?: string }) => r.metric ?? r.ratio ?? '').filter((m) => !m.startsWith('campaign.spend') && m !== 'campaign.lastSync')).toEqual([])
    } finally {
      CAMPAIGNS.splice(CAMPAIGNS.indexOf(pending), 1)
    }
  })
})

describe('campaign-country ≡ the bespoke country panel', () => {
  it('same campaigns, same step rows, same US / CA / Other counts', async () => {
    const oldTables = new Map(
      fromGolden<[string, string[][]][]>('campaigns.country'),
    )
    expect(oldTables.size).toBe(2)
    const card = await mountCard('campaign-country', FIXTURE_NOW)
    const newTables = new Map(
      card.findAll('.metric-card').map((c) => {
        const t = c.find('table.metric-table.columns')
        const heads = t.findAll('thead th').map((th) => text(th.element))
        const body = t.findAll('tbody tr').map((tr) => [text(tr.find('th').element), ...tr.findAll('td').map((td) => text(td.element))])
        return [text(c.find('.mc-title').element), [heads, ...body]] as const
      }),
    )
    expect([...newTables.keys()]).toEqual([...oldTables.keys()])
    for (const [title, rowsOld] of oldTables) expect(newTables.get(title), title).toEqual(rowsOld)
    // The fixture splits a campaign across countries, and a closed flight drops steps.
    const android = oldTables.get([...oldTables.keys()][0])!
    expect(android.length - 1).toBeLessThan(8)
    expect(android.some((r) => r[1] !== '0' && r[2] !== '0' && r[1] !== 'US')).toBe(true)
  })

  it('asks the server for each cell with a country param, all from one campaign fact', async () => {
    const d1 = sqliteD1(db)
    const res = await metricsPost(pagesContext(postJson('/api/metrics', { v: 1, requests: [
      { key: 'us', metric: 'campaign.taggedArrivals', params: { campaignId: '24215315197', country: 'US' } },
      { key: 'ca', metric: 'campaign.taggedArrivals', params: { campaignId: '24215315197', country: 'CA' } },
      { key: 'all', metric: 'campaign.taggedArrivals', params: { campaignId: '24215315197' } },
      { key: 'bad', metric: 'campaign.taggedArrivals', params: { campaignId: '24215315197', country: 'FR' } },
      { key: 'kpi', metric: 'campaign.taggedArrivals', params: { campaignId: '24215315197', country: 'US' }, window: 'todaySoFar' },
    ] }), { gss_geo: d1 } as never) as never)
    const body = (await res.json()) as { results: Record<string, { status: string; value?: number; reason?: string }> }
    expect(body.results.us.value! + body.results.ca.value!).toBe(body.results.all.value)
    expect(body.results.bad).toMatchObject({ status: 'error', reason: 'bad-param' })
    expect(body.results.kpi).toMatchObject({ status: 'error', reason: 'bad-param' }) // no country split on the KPI fact
    expect(d1.statements.filter((s) => s.includes('AS cb'))).toHaveLength(1)
  })
})

describe('Notes name each label once, however many columns repeat it', () => {
  // A column table repeats every row's item once per column (Arrivals under US, CA and Other;
  // each count under Before and After): its Notes line names the row once, not once per column.
  it.each([
    ['campaign-country', FIXTURE_NOW],
    ['release-before-after', Date.parse('2026-09-28T16:00:00Z')],
  ] as const)('%s', async (preset, now) => {
    vi.setSystemTime(now)
    const card = await mountCard(preset, now)
    let lines = 0
    for (const toggle of card.findAll('button.mc-notes-toggle')) await toggle.trigger('click')
    for (const li of card.findAll('.mc-notes li')) {
      const t = text(li.element)
      const head = t.slice(0, t.indexOf(': '))
      const names = head.split(', ')
      expect(new Set(names).size, t).toBe(names.length)
      lines++
    }
    expect(lines, `${preset} has Notes`).toBeGreaterThan(0)
  })
})

describe('campaign-returns ≡ the bespoke return-visits panel', () => {
  const visible = (w: VueWrapper) => w.findAll('.metric-card').filter((c) => (c.element as HTMLElement).style.display !== 'none')
  function newReturns(w: VueWrapper) {
    return visible(w).map((c) => ({
      title: text(c.find('.mc-title').element),
      d0: [...rows(c as unknown as VueWrapper)].find(([l]) => l === 'First tagged loads (d0)')?.[1],
      cols: c.findAll('.mi-col').map((col) => [text(col.find('.mi-col-label').element), `${text(col.find('.mi-col-num').element)}${col.find('.mi-col-sub').exists() ? ` ${text(col.find('.mi-col-sub').element)}` : ''}`]),
    }))
  }
  /** Runs `fn` against another hits table (the rest of the fixture, other return rows). */
  async function withDb<T>(rowsOf: typeof bskFixture, fn: () => Promise<T>): Promise<T> {
    const saved = db
    db = openHitsDb()
    insertHits(db, rowsOf())
    try {
      return await fn()
    } finally {
      db = saved
    }
  }

  it('RV1: the same campaigns, d0 and every bucket\'s rate with its n/d, as bars in bucket order', async () => {
    const oldCols = fromGolden<{ title: string; counts: string }[]>('campaigns.returns')
    expect(oldCols.map((c) => c.title)).toEqual(['US+CA web retest']) // Android's flight predates the beacon
    const card = await mountCard('campaign-returns', FIXTURE_NOW)
    const got = newReturns(card)
    expect(got.map((c) => c.title)).toEqual(oldCols.map((c) => c.title))
    for (const o of oldCols) {
      const n = got.find((c) => c.title === o.title)!
      const parts = o.counts.split(' · ')
      expect(parts[0]).toBe(`d0=${n.d0}`)
      expect(n.cols.map(([l, v]) => `${l}=${v}`)).toEqual(parts.slice(1))
      expect(n.cols.map(([l]) => l)).toEqual(['d1', 'd2-7', 'd8-14', 'd15-30', 'd31-60'])
    }
  })

  it('RV2: fewer than MIN_COHORT first loads — the d0 row and "too few to report (n/d)" on each bar', async () => {
    const few = () => bskFixture().map((r) => (String(r.path).startsWith('/return/sudoku_funnel_retest/d0') ? { ...r, n: 3 } : r))
    await withDb(few, async () => {
      const old = fromGolden<string>('campaigns.returns.tooFew')
      expect(old).toBe('too few to report (d0 = 3, need 5)')
      __resetMetricsStateForTests()
      cache.clear()
      const card = await mountCard('campaign-returns', FIXTURE_NOW)
      const [n] = newReturns(card)
      expect(n.d0).toBe('3')
      for (const [, v] of n.cols) expect(v).toMatch(/^too few to report \(\d+\/3\)$/)
    })
  })

  it('none left: "No return visits recorded yet." on both', async () => {
    const none = () => bskFixture().filter((r) => !String(r.path).startsWith('/return/'))
    await withDb(none, async () => {
      const old = fromGolden<string>('campaigns.returns.none')
      expect(old).toBe('No return visits recorded yet.')
      __resetMetricsStateForTests()
      cache.clear()
      const card = await mountCard('campaign-returns', FIXTURE_NOW)
      expect(visible(card)).toHaveLength(0)
      expect(text(card.find('.metric-card-empty').element)).toBe('No return visits recorded yet.')
    })
  })
})

describe('the campaign arrivals charts ≡ their bespoke panels', () => {
  const stub = { global: { stubs: { BaseChart: { name: 'BaseChart', props: ['config', 'drillOpen'], template: '<div class="chart-stub" />' } } } }
  const configs = (w: VueWrapper) => w.findAllComponents({ name: 'BaseChart' }).map((c) => c.props('config') as ChartConfiguration)
  /** What an old chart drew: its axis labels and each dataset's label and values. */
  interface Drawn {
    labels: string[]
    series: [string, number[]][]
  }
  const mountOldChart = (view: string): Drawn[] => fromGolden<Drawn[]>(`campaigns.${view}.chart`)
  async function mountNewChart(widget: Widget) {
    const w = mount(ChartCard, { props: { widget, filters: defaultFilters(), dark: false, drillOpen: false }, ...stub })
    mounted.push(w)
    await settle()
    return configs(w)
  }
  const series = (cfg: ChartConfiguration) => cfg.data.datasets.map((d) => [d.label, (d.data as (number | null)[]).map((v) => v ?? 0)] as const)

  it('hour of day: the same 24 hours and the same arrivals per campaign (H1)', async () => {
    const [old] = mountOldChart('hourOfDay')
    const [neu] = await mountNewChart(hourOfDayWidget({ x: 0, y: 0, w: 12, h: 8 }))
    expect(neu.type).toBe('bar')
    expect(neu.data.labels).toEqual(old.labels)
    expect(new Map(series(neu))).toEqual(new Map(old.series))
    expect(old.series.length).toBe(2)
    expect(old.series.every(([, d]) => d.some((v) => v > 0))).toBe(true)
  })

  it('flight day: the same days, daily arrivals and running totals, on one chart (FD1)', async () => {
    const [oldDaily, oldCum] = mountOldChart('flightDay')
    const [neu] = await mountNewChart(flightDayWidget({ x: 0, y: 0, w: 12, h: 10 }))
    expect(neu.type).toBe('line')
    expect(neu.data.labels).toEqual(oldDaily.labels)
    expect(neu.data.labels).toEqual(oldCum.labels)
    const daily = neu.data.datasets.filter((d) => (d as { yAxisID?: string }).yAxisID === 'y')
    const cum = neu.data.datasets.filter((d) => (d as { yAxisID?: string }).yAxisID === 'y1')
    expect(new Map(daily.map((d) => [d.label, d.data]))).toEqual(new Map(oldDaily.series))
    expect(new Map(cum.map((d) => [String(d.label).replace(/ \(cumulative\)$/, ''), d.data]))).toEqual(new Map(oldCum.series))
    expect(cum.every((d) => Array.isArray((d as { borderDash?: number[] }).borderDash))).toBe(true)
    expect(neu.data.labels).toHaveLength(8) // Day 1 to the longest flight (Android, 8 days)
  })

  it('a beacon-tracked campaign with no start date yet still gets a series, drawn at 0, on both charts', async () => {
    const retest = CAMPAIGNS.find((c) => c.id === '24279250691')!
    const pending = { ...retest, id: '99999999999', label: 'Upcoming test flight', status: 'upcoming' as const, flightStart: null, flightStartTimeEt: undefined }
    CAMPAIGNS.push(pending)
    try {
      const [hour] = await mountNewChart(hourOfDayWidget({ x: 0, y: 0, w: 12, h: 8 }))
      const hourSeries = new Map(series(hour))
      expect([...hourSeries.keys()], 'hour-of-day legend').toContain(pending.label)
      expect(hourSeries.get(pending.label)).toEqual(Array(24).fill(0))

      const [day] = await mountNewChart(flightDayWidget({ x: 0, y: 0, w: 12, h: 10 }))
      const dayDaily = day.data.datasets.filter((d) => (d as { yAxisID?: string }).yAxisID === 'y')
      const pendingLine = dayDaily.find((d) => d.label === pending.label)
      expect(pendingLine, 'flight-day legend').toBeTruthy()
      // flightLength (lib/charts.ts) is 0 for a flight with no start, so it never stretches the
      // axis: still Day 1 to the longest DATED flight (Android, 8 days), all zeros for pending.
      expect(day.data.labels).toHaveLength(8)
      expect(pendingLine!.data).toEqual(Array(8).fill(0))
    } finally {
      CAMPAIGNS.splice(CAMPAIGNS.indexOf(pending), 1)
    }
  })

  it('two years on, both charts still count every arrival since the first flight began', async () => {
    const later = Date.parse('2028-09-26T21:00:00Z')
    vi.setSystemTime(later)
    const hourW = hourOfDayWidget({ x: 0, y: 0, w: 12, h: 8 })
    const dayW = flightDayWidget({ x: 0, y: 0, w: 12, h: 10 })
    expect(hourW.filters!.since).toBe('2026-09-02T04:00:00.000Z')
    expect(dayW.filters!.since).toBe('2026-09-02T04:00:00.000Z')
    // The hour-of-day chart still ends "now" two years on; the flight-day chart's range has
    // closed instead — every flight ended long ago (ET midnight of the day after the retest's
    // 2026-10-02 end, the latest of the three) — and stays fixed there, not at `later`.
    expect(hourW.filters!.until).toBe(new Date(later).toISOString())
    expect(dayW.filters!.until).toBe('2026-10-03T04:00:00.000Z')
    const [hour] = await mountNewChart(hourW)
    expect(new Map(series(hour))).toEqual(new Map(mountOldChart('hourOfDay')[0].series))
    const [day] = await mountNewChart(dayW)
    const daily = day.data.datasets.filter((d) => (d as { yAxisID?: string }).yAxisID === 'y')
    expect(new Map(daily.map((d) => [d.label, d.data]))).toEqual(new Map(mountOldChart('flightDay')[0].series))
  })
})

describe('the arrivals charts: numbers per bucket, /api/geo against /api/campaigns', () => {
  const RETEST = { site: 'bestsudoku-web', campaign: 'sudoku_funnel_retest', visitor: 'new' }
  const ANDROID = { site: 'bestsudoku-web', campaign: 'sudoku_tired_of_ads', visitor: 'new' }
  const at = (iso: string) => Date.parse(iso)
  /** Edge rows: the retest's noon-ET attribution start (11:59 ET not attributed, 12:00 ET day 1),
   * the fall-back hour (01:30 EDT and 01:30 EST on 2026-11-01), the spring-forward day
   * (2027-03-14, 01:30 EST then 03:30 EDT), and a late arrival long after the flights ended. */
  const EDGES = [
    { ...RETEST, ts: at('2026-09-26T15:59:00Z'), path: '/', n: 2 }, // 11:59 ET: before attribution
    { ...RETEST, ts: at('2026-09-26T16:00:00Z'), path: '/', n: 3 }, // 12:00 ET: flight day 1
    { ...RETEST, ts: at('2026-10-02T03:30:00Z'), path: '/', n: 1 }, // 23:30 ET on 10-01: day 6
    { ...RETEST, ts: at('2026-10-03T04:10:00Z'), path: '/', n: 1 }, // 00:10 ET on 10-03: after the flight
    { ...ANDROID, ts: at('2026-11-01T05:30:00Z'), path: '/', n: 4 }, // 01:30 EDT
    { ...ANDROID, ts: at('2026-11-01T06:30:00Z'), path: '/', n: 5 }, // 01:30 EST (the repeated hour)
    { ...ANDROID, ts: at('2027-03-14T06:30:00Z'), path: '/', n: 6 }, // 01:30 EST
    { ...ANDROID, ts: at('2027-03-14T07:30:00Z'), path: '/', n: 7 }, // 03:30 EDT (02:xx skipped)
    { ...ANDROID, ts: at('2026-09-05T14:00:00Z'), path: '/install/prompt/android', n: 2 }, // an event row as a first beacon
  ]
  const NOW = at('2027-03-20T16:00:00Z')
  const beacon = CAMPAIGNS_LIST().filter((c) => c.measurement !== 'spend-only')

  async function both() {
    const saved = db
    db = openHitsDb()
    insertHits(db, [...bskFixture(), ...EDGES])
    vi.setSystemTime(NOW)
    cache.clear()
    try {
      const old = new Map<string, { hourOfDayEt: number[]; daily: { day: number; arrivals: number }[] }>(
        fromGolden<[string, { hourOfDayEt: number[]; daily: { day: number; arrivals: number }[] }][]>('campaigns.arrivals.edges'),
      )
      const hourW = hourOfDayWidget({ x: 0, y: 0, w: 12, h: 8 })
      const dayW = flightDayWidget({ x: 0, y: 0, w: 12, h: 10 })
      const hour = await fetchStats(hourW, hourW.filters!)
      const day = await fetchStats(dayW, dayW.filters!)
      return { old, hour, day, hourCfg: buildChartConfig(hourW, hour)!, dayCfg: buildChartConfig(dayW, day)! }
    } finally {
      db = saved
    }
  }
  const cell = (rows: { key: Record<string, string>; pageviews: number }[], dim: string, v: string, c: string) => rows.filter((r) => r.key[dim] === v && r.key.campaignFlight === c).reduce((a, r) => a + r.pageviews, 0)

  it('hour of day: every campaign, every ET hour, the same arrivals — DST days included', async () => {
    const { old, hour, hourCfg } = await both()
    for (const c of beacon) {
      const want: number[] = old.get(c.id)!.hourOfDayEt
      const got = Array.from({ length: 24 }, (_, h) => cell(hour.rows, 'hourEt', String(h), c.id))
      expect(got, c.label).toEqual(want)
      const drawn = hourCfg.data.datasets.find((d) => d.label === c.label)!
      expect((drawn.data as (number | null)[]).map((v) => v ?? 0), `${c.label} drawn`).toEqual(want)
    }
    // The edges landed where they should: both 01:00 ET buckets of the fall-back day, and 01:00
    // and 03:00 on the spring-forward day, on Android; the retest's noon arrivals at 12:00.
    const android = old.get('24215315197')!.hourOfDayEt
    expect(android[1]).toBeGreaterThanOrEqual(4 + 5 + 6)
    expect(android[3]).toBeGreaterThanOrEqual(7)
    expect(old.get('24279250691')!.hourOfDayEt[11]).toBe(0) // 11:59 ET is before attribution
  })

  it('flight day: every campaign, every day, the same daily arrivals and running totals', async () => {
    const { old, day, dayCfg } = await both()
    const labels = dayCfg.data.labels as string[]
    for (const c of beacon) {
      const daily: { day: number; arrivals: number }[] = old.get(c.id)!.daily
      const byDay = new Map<number, number>()
      for (const r of daily) if (r.day > 0) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.arrivals)
      const want = labels.map((_, i) => byDay.get(i + 1) ?? 0)
      const got = labels.map((_, i) => cell(day.rows, 'flightDay', String(i + 1), c.id))
      expect(got, c.label).toEqual(want)
      const drawn = dayCfg.data.datasets.find((d) => d.label === c.label)!
      expect(drawn.data, `${c.label} drawn`).toEqual(want)
      let run = 0
      const cumulative = want.map((v) => (run += v))
      expect(dayCfg.data.datasets.find((d) => d.label === `${c.label} (cumulative)`)!.data, `${c.label} cumulative`).toEqual(cumulative)
    }
    const retest = old.get('24279250691')!.daily as { day: number; arrivals: number }[]
    expect(retest.find((r) => r.day === 1)!.arrivals).toBe(7 + 3) // fixture's 7 plus the 12:00 ET 3, not the 11:59 2
    expect(labels).toHaveLength(8)
  })
})
