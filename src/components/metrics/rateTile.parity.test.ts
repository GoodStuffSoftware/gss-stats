// @vitest-environment happy-dom
//
// PARITY (ADR 0005 slice 4): the pop-up rate tile, rendered the NEW way (the one-item card
// lib/metrics/rateTileCard.ts builds, over POST /api/metrics) against the OLD way, which is still
// restated as an oracle: the rate the retired /api/popups `dimension: 'rate'` branch computed for a
// POPUP_RATE_SPECS key (functions/_lib/testing/popupRateOracle.ts; the branch itself was removed in
// 0.24.1, and the endpoint now answers that dimension with a 400). Both read ONE node:sqlite fixture
// (functions/_lib/testing), all 22 keys, asserting the same visible rate and counts. Every visible difference is listed next
// to its case and asserted as itself, so none can appear silently.
//
//   T1  The (n/d) line reads "(4/11)" on the card; the old tile printed "4/11". Same numbers.
//   T2  A zero denominator: old "—" over "0/0", card "—" over "(0/0)" (a percent always shows
//       its n/d). Old and card both say "—", never 0% or NaN.
//   T3  A key this build does not know has no card: ChartCard says so (ChartCard.rateTile.test.ts);
//       the old tile drew "—" over "0/0" for it.
//   T4  Notes. The old tile drew ONE note: the install-fix note on the installed rate, from the
//       endpoint's `note`, as the hideable runtime note `popup-note` (chartNotes.ts). The card
//       draws that same text in the tile's caption, and a stored hide of `popup-note` still hides
//       it (ChartCard.rateTile.test.ts). Added on the card: the eligibility caveat, "counted from
//       <date>" and "still arriving" on a lagged outcome rate. Asserted per key below.
//   T5  Before tracking went live (TRACKING_ACTIVATION_DATE_ET): the old tile read "—" over
//       "0/0"; the card reads "not yet tracking" (status unmeasured) with no n/d line.
//   T6  The safeUA rules: a browser string safeUA rewrites to '' excludes nothing on the old path
//       (server) and on the card (pageContext), so both read the unfiltered counts.
//   T7  A stored per-chart filter override (widget.filters) drives the card's range, sites and
//       own-visit exclusion, as it did the old tile.
//   I1  A range longer than MAX_RANGE_DAYS: the card keeps the newest days (pageContext.ts), the
//       old tile sent the whole range to /api/popups.
//   I2  A bare-date range ('2026-09-20'): /api/popups reads it as UTC days, the engine as ET days.
//   I3  A bare-date range with since === until sends the card no range at all (the engine answers
//       "missing range", which the card shows as "unavailable"); /api/popups read the one UTC day.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import ChartCard from '../ChartCard.vue'
import { sitesTree } from '../../sitesStore'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { onRequestPost as metricsPost } from '../../../functions/api/metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../../../functions/_lib/testing/hitsDb'
import { popupRateOracle } from '../../../functions/_lib/testing/popupRateOracle'
import { bskFixture, FIXTURE_NOW } from '../../../functions/_lib/testing/bskFixture'
import { BEST_SUDOKU_SITES } from '../../lib/bestSudokuSites'
import { INSTALL_GAP_RATE_KEY, POPUP_RATE_SPECS, SIGNIN_ELIGIBLE_CAVEAT } from '../../lib/popupEvents'
import { rateTileCardRef } from '../../lib/metrics/rateTileCard'
import { metricsContextFor } from '../../lib/metrics/pageContext'
import { cardRefFor } from '../../lib/metrics/readingsCard'
import type { Widget } from '../../types'

/** Rows the shared fixture lacks: the owner's own visits (Opera on Windows), which "hide my own
 * visits" must drop on both paths. */
const EXTRA = [
  { ts: Date.parse('2026-09-26T14:30:00Z'), site: 'bestsudoku-web', path: '/upsell/shown/limit', visitor: 'returning', browser: 'Opera', os: 'Windows', n: 3 },
  { ts: Date.parse('2026-09-26T14:31:00Z'), site: 'bestsudoku-web', path: '/upsell/accept/limit', visitor: 'returning', browser: 'Opera', os: 'Windows', n: 3 },
  { ts: Date.parse('2026-09-26T14:32:00Z'), site: 'bestsudoku-web', path: '/signin-eligible/earned', visitor: 'returning', browser: 'Opera', os: 'Windows', n: 2 },
  // A small cohort (3 showings, 1 tap): "too few to report" under MIN_COHORT, on both paths.
  { ts: Date.parse('2026-09-26T15:00:00Z'), site: 'bestsudoku-web', path: '/promo-first50/shown', visitor: 'returning', n: 3 },
  { ts: Date.parse('2026-09-26T15:01:00Z'), site: 'bestsudoku-web', path: '/promo-first50/accept', visitor: 'returning', n: 1 },
  // 22:00 ET on 27 Sep, which is already 28 Sep in UTC: it sits inside a bare-date range's last ET
  // day and outside its last UTC day (I2 below); every other window here ends before it.
  { ts: Date.parse('2026-09-28T02:00:00Z'), site: 'bestsudoku-web', path: '/upsell/shown/limit', visitor: 'returning', n: 2 },
]
let db: ReturnType<typeof openHitsDb>
let undoCaches: () => void
let cache: ReturnType<typeof memoryCache>
const mounted: VueWrapper[] = []

async function route(url: string, init: RequestInit): Promise<Response> {
  const path = new URL(url, 'https://stats.goodstuff.software').pathname
  if (path !== '/api/metrics') throw new Error(`unexpected fetch ${path}`)
  const waited: Promise<unknown>[] = []
  const res = await metricsPost(pagesContext(postJson(path, JSON.parse(String(init.body ?? '{}'))), { gss_geo: sqliteD1(db) } as never, waited))
  await Promise.all(waited)
  return res
}

beforeAll(() => {
  db = openHitsDb()
  insertHits(db, [...bskFixture(), ...EXTRA])
  vi.useFakeTimers({ now: FIXTURE_NOW, toFake: ['Date'] })
  cache = memoryCache()
  undoCaches = installCaches(cache)
  vi.stubGlobal('fetch', vi.fn(route))
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  cache.clear()
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

interface Range { since: string; until: string }
interface Own { excludeOwnVisits: boolean; ownBrowser: string; ownOS: string }
const OWN: Own = { excludeOwnVisits: true, ownBrowser: 'Opera', ownOS: 'Windows' }
const WINDOW: Range = { since: '2026-09-20T04:00:00.000Z', until: '2026-09-27T04:00:00.000Z' }
const INSTALL_FIX_TEXT = 'earlier prompt-driven installs not recorded'
const SITES = [...BEST_SUDOKU_SITES] as string[]

const widgetFor = (key: string): Widget => ({ id: 'r', i: 'r', title: 'Rate', type: 'rate', dataset: 'popup', dimension: key, metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3 })

interface Old { value: string; counts: string; tooFew: boolean; note: string }
/** The retired tile's rendering of the retired endpoint's answer (its rateDisplay and rateCounts). */
async function oldTile(key: string, range: Range, own: Own = OWN): Promise<Old> {
  const d = popupRateOracle(db, key, { since: range.since, until: range.until, sites: SITES, ...own })
  const tooFew = !!d.insufficientCohort
  return {
    tooFew,
    note: d.note ?? '',
    value: tooFew ? 'too few to report' : d.rate == null ? '—' : `${(d.rate * 100).toFixed(1)}%`,
    counts: d.denominator == null ? '' : `${d.numerator ?? 0}/${d.denominator}`,
  }
}
interface New { value: string; counts: string; label: string; notes: string }
async function newTile(key: string, range: Range, own: Own = OWN): Promise<New> {
  const ref = cardRefFor(widgetFor(key))
  expect(ref, key).not.toBeNull()
  const context = metricsContextFor(range, SITES, own)
  const w = mount(MetricCard, { props: { cardRef: ref!, context, nowMs: FIXTURE_NOW } })
  mounted.push(w)
  await settle()
  const tile = w.find('.mi-tile')
  return {
    value: norm(tile.find('.mi-tile-num').text()),
    counts: norm(tile.find('.mi-tile-sub').exists() ? tile.find('.mi-tile-sub').text() : ''),
    label: norm(tile.find('.mi-tile-label').text()),
    notes: norm(tile.find('.mi-tile-caption').exists() ? tile.find('.mi-tile-caption').text() : ''),
  }
}

describe('the rate tile card matches the retired rate tile, every key (all 22)', () => {
  it('has 22 keys, each mapped to a card', () => {
    expect(POPUP_RATE_SPECS).toHaveLength(22)
    for (const s of POPUP_RATE_SPECS) expect(rateTileCardRef(widgetFor(s.key)), s.key).not.toBeNull()
  })

  for (const spec of POPUP_RATE_SPECS) {
    it(`${spec.key}: the same rate and counts (T1, T2), the spec label and the install-fix note (T4)`, async () => {
      const o = await oldTile(spec.key, WINDOW)
      const n = await newTile(spec.key, WINDOW)
      expect(n.label, 'label').toBe(spec.label)
      expect(n.value, 'rate').toBe(o.value)
      expect(n.counts, 'n/d (T1)').toBe(o.counts ? `(${o.counts})` : '')
      // T4: the old tile's one note (the install-fix note) is on the card's caption exactly when
      // the old endpoint sent it.
      expect(n.notes.includes(INSTALL_FIX_TEXT), 'install-fix note').toBe(o.note !== '')
    })
  }

  it('the fixture exercises a real rate, a gated "too few to report" and an empty denominator', async () => {
    const seen = new Set<string>()
    for (const spec of POPUP_RATE_SPECS) {
      const o = await oldTile(spec.key, WINDOW)
      seen.add(o.tooFew ? 'too-few' : o.value === '—' ? 'dash' : 'rate')
    }
    expect([...seen].sort()).toEqual(['dash', 'rate', 'too-few'])
  })

  it('T4: the notes the card draws, by kind', async () => {
    // the install-fix note: on the installed rate only (the old tile's one note)
    expect((await newTile(INSTALL_GAP_RATE_KEY, WINDOW)).notes).toContain(INSTALL_FIX_TEXT)
    expect((await oldTile(INSTALL_GAP_RATE_KEY, WINDOW)).note).not.toBe('')
    expect((await newTile('upsell:tap', WINDOW)).notes).not.toContain(INSTALL_FIX_TEXT)
    // the eligibility caveat and the still-arriving note on a lagged outcome rate
    // placement: the caveat is the tile's caption (.mi-tile-caption, under the figure), not elsewhere
    const eligible = await newTile('signin-eligible:rate', WINDOW)
    expect(eligible.notes).toContain(norm(SIGNIN_ELIGIBLE_CAVEAT))
    expect((await newTile('upsell:tap', WINDOW)).notes).not.toContain(norm(SIGNIN_ELIGIBLE_CAVEAT))
    expect((await newTile('install:outcome:still-playing', WINDOW)).notes).toMatch(/still arriving/i)
  })
})

describe('T5 to T7: before activation, the safeUA rules and a stored filter override', () => {
  const key = 'upsell:tap'

  it('T5: before tracking went live the old tile read "—" over "0/0"; the card reads "not yet tracking"', async () => {
    const before: Range = { since: '2026-09-14T04:00:00.000Z', until: '2026-09-20T04:00:00.000Z' }
    const o = await oldTile(key, before)
    const n = await newTile(key, before)
    expect(o).toMatchObject({ value: '—', counts: '0/0' })
    expect(n.value).toBe('not yet tracking')
    expect(n.counts).toBe('')
  })

  it('T6: a browser string safeUA rewrites excludes nothing, on both paths (the unfiltered counts)', async () => {
    const unsafe: Own = { excludeOwnVisits: true, ownBrowser: 'Opera<script>', ownOS: 'Windows' }
    const none: Own = { excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
    const o = await oldTile(key, WINDOW, unsafe)
    const n = await newTile(key, WINDOW, unsafe)
    const unfiltered = await oldTile(key, WINDOW, none)
    expect(n.counts).toBe(`(${o.counts})`)
    expect(o.counts).toBe(unfiltered.counts)
    expect(n.value).toBe(o.value)
    // not vacuous: a safe browser string really does drop the owner's rows
    expect((await oldTile(key, WINDOW, OWN)).counts).not.toBe(unfiltered.counts)
  })

  it('T7: a stored per-chart filter override drives the card, as it drove the old tile', async () => {
    const other: Range = { since: '2026-09-01T04:00:00.000Z', until: '2026-09-05T04:00:00.000Z' }
    sitesTree.value = [{ domain: 'bestsudoku.app', subs: [{ host: 'bestsudoku.app', tags: SITES } as never] } as never]
    try {
      const override = { siteSel: ['bestsudoku.app'], since: WINDOW.since, until: WINDOW.until, excludeSelfReferrals: false, ...OWN }
      const global = { siteSel: [] as string[], since: other.since, until: other.until, excludeSelfReferrals: false, excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
      const o = await oldTile(key, WINDOW)
      const w = mount(ChartCard, { props: { widget: { ...widgetFor(key), filters: override }, filters: global, dark: false, drillOpen: false } })
      mounted.push(w)
      await settle()
      expect(norm(w.find('.mi-tile-num').text())).toBe(o.value)
      expect(norm(w.find('.mi-tile-sub').text())).toBe(`(${o.counts})`)
      // not vacuous: the global filter alone reads another window (before tracking went live)
      const g = mount(ChartCard, { props: { widget: widgetFor(key), filters: global, dark: false, drillOpen: false } })
      mounted.push(g)
      await settle()
      expect(norm(g.find('.mi-tile').text())).not.toContain(`(${o.counts})`)
    } finally {
      sitesTree.value = []
    }
  })
})

describe('the differences that come from the card engine reading the range (I1 to I3)', () => {
  const key = 'upsell:tap'
  const sent = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)))

  it('I1: a range longer than the limit sends the card its newest days; the figures are the same here', async () => {
    const long: Range = { since: '2025-05-01T04:00:00.000Z', until: WINDOW.until }
    const o = await oldTile(key, long)
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockClear()
    const n = await newTile(key, long)
    expect(n.value).toBe(o.value)
    expect(n.counts).toBe(`(${o.counts})`)
    const since = String(sent()[0].context.since)
    expect(Date.parse(since)).toBeGreaterThan(Date.parse(long.since))
    expect((Date.parse(long.until) - Date.parse(since)) / 86_400_000).toBeLessThan(400)
  })

  it('I2: a bare-date range is UTC days for /api/popups and ET days for the card', async () => {
    const bare: Range = { since: '2026-09-26', until: '2026-09-27' }
    const o = await oldTile(key, bare)
    const n = await newTile(key, bare)
    expect(o.counts).toBe('4/11') // UTC days: the 22:00 ET row of 27 Sep (28 Sep UTC) is out
    expect(n.counts).toBe('(4/13)') // ET days: it is in
  })

  it('I3: a bare-date range with since equal to until sends the card no range', async () => {
    const same: Range = { since: '2026-09-26', until: '2026-09-26' }
    const o = await oldTile(key, same)
    const n = await newTile(key, same)
    expect(o).toMatchObject({ value: '36.4%', counts: '4/11' })
    expect(n.value).toBe('unavailable') // the card's "not loaded" word, not a number
  })
})
