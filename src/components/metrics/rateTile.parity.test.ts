// @vitest-environment happy-dom
//
// PARITY (ADR 0005 slice 4): the pop-up rate tile, rendered the NEW way (the one-item card
// lib/metrics/rateTileCard.ts builds, over POST /api/metrics) against the OLD way, which is still
// live: /api/popups answering `dimension: 'rate'` for a POPUP_RATE_SPECS key (the endpoint keeps
// that branch for a rolled-back build). Both read ONE node:sqlite fixture (functions/_lib/testing),
// all 22 keys, asserting the same visible rate and counts. Every visible difference is listed next
// to its case and asserted as itself, so none can appear silently.
//
//   T1  The (n/d) line reads "(4/11)" on the card; the old tile printed "4/11". Same numbers.
//   T2  A zero denominator: old "—" over "0/0", card "—" over "(0/0)" (a percent always shows
//       its n/d). Old and card both say "—", never 0% or NaN.
//   T3  A key this build does not know has no card: ChartCard says so (ChartCard.rateTile.test.ts);
//       the old tile drew "—" over "0/0" for it.
//   T4  Added on the card: the registry's notes for a value (the install-fix note on the installed
//       rate, the eligibility caveat, the still-arriving note on a lagged outcome rate) show under
//       the tile; the old tile drew none of them.
//   I1  A range longer than MAX_RANGE_DAYS: the card keeps the newest days (pageContext.ts), the
//       old tile sent the whole range to /api/popups.
//   I2  A bare-date range ('2026-09-20'): /api/popups reads it as UTC days, the engine as ET days.
//   I3  A bare-date range with since === until sends the card no range at all (the engine answers
//       "missing range", which the card shows as "unavailable"); /api/popups read the one UTC day.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { onRequestPost as metricsPost } from '../../../functions/api/metrics'
import { onRequestPost as popupsPost } from '../../../functions/api/popups'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../../../functions/_lib/testing/hitsDb'
import { bskFixture, FIXTURE_NOW } from '../../../functions/_lib/testing/bskFixture'
import { BEST_SUDOKU_SITES } from '../../lib/bestSudokuSites'
import { POPUP_RATE_SPECS } from '../../lib/popupEvents'
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
const OWN = { excludeOwnVisits: true, ownBrowser: 'Opera', ownOS: 'Windows' }
const WINDOW: Range = { since: '2026-09-20T04:00:00.000Z', until: '2026-09-27T04:00:00.000Z' }
const SITES = [...BEST_SUDOKU_SITES] as string[]

const widgetFor = (key: string): Widget => ({ id: 'r', i: 'r', title: 'Rate', type: 'rate', dataset: 'popup', dimension: key, metric: 'pageviews', limit: 1, x: 0, y: 0, w: 3, h: 3 })

interface Old { value: string; counts: string; tooFew: boolean }
/** The retired tile's rendering of the endpoint's answer (its rateDisplay and rateCounts). */
async function oldTile(key: string, range: Range): Promise<Old> {
  const res = await popupsPost(
    pagesContext(postJson('/api/popups', { dimension: 'rate', rateKey: key, since: range.since, until: range.until, limit: 1, sites: SITES, ...OWN }), { gss_geo: sqliteD1(db) } as never) as never,
  )
  const d = (await res.json()) as { rate: number | null; insufficientCohort?: boolean; numerator?: number; denominator?: number }
  const tooFew = !!d.insufficientCohort
  return {
    tooFew,
    value: tooFew ? 'too few to report' : d.rate == null ? '—' : `${(d.rate * 100).toFixed(1)}%`,
    counts: d.denominator == null ? '' : `${d.numerator ?? 0}/${d.denominator}`,
  }
}
interface New { value: string; counts: string; label: string; notes: string }
async function newTile(key: string, range: Range): Promise<New> {
  const ref = cardRefFor(widgetFor(key))
  expect(ref, key).not.toBeNull()
  const context = metricsContextFor(range, SITES, OWN)
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

  it('shows the same rate and counts (T1, T2) and the spec label, over the pop-up window', async () => {
    const seen = new Set<string>()
    const table: string[] = []
    for (const spec of POPUP_RATE_SPECS) {
      const o = await oldTile(spec.key, WINDOW)
      const n = await newTile(spec.key, WINDOW)
      table.push(`${spec.key} | old ${o.value} ${o.counts} | new ${n.value} ${n.counts} | ${n.notes}`)
      expect(n.label, `${spec.key} label`).toBe(spec.label)
      expect(n.value, `${spec.key} rate`).toBe(o.value)
      expect(n.counts, `${spec.key} n/d (T1)`).toBe(o.counts ? `(${o.counts})` : '')
      seen.add(o.tooFew ? 'too-few' : o.value === '—' ? 'dash' : 'rate')
    }
    console.log(table.join('\n'))
    // The fixture exercises a real rate, a gated "too few to report" and an empty denominator.
    expect([...seen].sort()).toEqual(['dash', 'rate', 'too-few'])
  }, 60_000)
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
