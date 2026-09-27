// @vitest-environment happy-dom
//
// PARITY (ADR 0003 slice 7): every panel slice 7 converts, rendered the NEW way (a card preset
// over POST /api/metrics, or a generic chart over /api/geo) against the OLD bespoke body over its
// own endpoint, on ONE node:sqlite fixture (functions/_lib/testing/bskFixture.ts, plus the rows a
// panel needs that the shared fixture lacks), asserting the same visible numbers. Every visible
// difference is listed next to the panel and asserted as itself, so none can appear silently.
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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import OverviewWidgetBody from '../widgets/OverviewWidgetBody.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { onRequestPost as metricsPost } from '../../../functions/api/metrics'
import { onRequestPost as overviewPost } from '../../../functions/api/overview'
import { onRequestPost as popupsPost } from '../../../functions/api/popups'
import { onRequestPost as campaignsPost } from '../../../functions/api/campaigns'
import CampaignsWidgetBody from '../widgets/CampaignsWidgetBody.vue'
import { DatabaseSync } from 'node:sqlite'
import ChartCard from '../ChartCard.vue'
import { fetchStats } from '../../api'
import { buildChartConfig } from '../../lib/charts'
import { BEST_SUDOKU_SITES } from '../../lib/bestSudokuSites'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../../../functions/_lib/testing/hitsDb'
import { bskFixture, FIXTURE_NOW } from '../../../functions/_lib/testing/bskFixture'
import { defaultFilters } from '../../lib/defaults'
import type { Widget } from '../../types'

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
  '/api/overview': overviewPost,
  '/api/popups': popupsPost,
  '/api/campaigns': campaignsPost,
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
  const widget = (id: string): Widget => ({ id, i: id, title: 'Release panel', type: 'table', dataset: 'overview', view: 'releasePanel', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 12, h: 9 })
  async function mountOld(nowMs: number) {
    // useOverviewData caches per since|until, so each moment gets its own range key.
    const filters = { ...defaultFilters(), since: new Date(nowMs - 86_400_000).toISOString(), until: new Date(nowMs).toISOString() }
    const w = mount(OverviewWidgetBody, { props: { widget: widget(`ow-release-${nowMs}`), filters } })
    mounted.push(w)
    await settle()
    return w
  }
  function oldPanel(w: VueWrapper): { caption: string; cols: Map<string, Map<string, string>> } {
    const cols = new Map<string, Map<string, string>>()
    for (const col of w.findAll('.release-col')) {
      cols.set(text(col.find('.fc-label').element), new Map(col.findAll('.rel-row').map((r) => [text(r.findAll('span')[0].element), text(r.findAll('span')[1].element)])))
    }
    return { caption: text(w.find('.caption').element), cols }
  }

  it('two days after the release: the same four counts on each side, except R1', async () => {
    const now = Date.parse('2026-09-28T16:00:00Z')
    vi.setSystemTime(now)
    const old = oldPanel(await mountOld(now))
    expect(old.caption).toMatch(/^v1\.95\.3 \(2026-09-26\) — 2 days before vs after\. before = partially instrumented/)
    const card = await mountCard('release-before-after', now)
    const r = rows(card)
    expect(r.get('Release')).toBe('v1.95.3 (2026-09-26)') // L1
    expect(r.get('Days on each side')).toBe('2') // L1: the "2 days" of the old line
    const t = columnTable(card)
    expect([...t.keys()]).toEqual(LABELS)
    for (const side of ['Before', 'After']) {
      for (const label of LABELS) {
        const was = old.cols.get(side)!.get(label)
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
    expect(Number(old.cols.get('Before')!.get('Page views')!.replace(/,/g, ''))).toBeGreaterThan(0)
    expect(Number(old.cols.get('After')!.get('Installs'))).toBeGreaterThan(0)
    expect(Number(old.cols.get('After')!.get('Tagged arrivals'))).toBeGreaterThan(0)
    // The note under the panel is unchanged (L1).
    expect(text(card.find('.mc-captions').element)).toBe(old.caption.slice(old.caption.indexOf('before = ')))
  })

  it('R2: on the release day itself (no full day after it), both say there is nothing to compare yet', async () => {
    const old = await mountOld(FIXTURE_NOW)
    expect(text(old.find('.caption').element)).toBe('No dated release yet. This panel fills in once a release has a date.')
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
  const rateTable: Widget = { id: 'pu-rates', i: 'pu-rates', title: 'Rates (valid ratios only)', type: 'rateTable', dataset: 'popup', dimension: '', metric: 'pageviews', limit: 1, x: 0, y: 0, w: 8, h: 7 }
  const eligible: Widget = { id: 'pu-eligible-bd', i: 'pu-eligible-bd', title: 'Sign-in eligibility', type: 'bar', dataset: 'popup', dimension: 'eligible', metric: 'pageviews', limit: 3, x: 0, y: 0, w: 4, h: 7 }
  async function mountChart(widget: Widget) {
    const w = mount(ChartCard, { props: { widget, filters, dark: false, drillOpen: false } })
    mounted.push(w)
    await settle()
    return w
  }

  it('popup-rates: every old rate row, same label, same rate and n/d (L2), the install caveat in Notes (N3)', async () => {
    const old = await mountChart(rateTable)
    const oldRows = old.findAll('table.rate-table tbody tr').map((tr) => {
      const [label, pct, nd] = tr.findAll('td')
      const noteEl = label.find('.rate-note')
      const full = text(label.element)
      return { label: noteEl.exists() ? norm(full.slice(0, full.length - text(noteEl.element).length)) : full, value: `${text(pct.element)} (${text(nd.element)})`, note: noteEl.exists() ? text(noteEl.element) : '' }
    })
    expect(oldRows.length).toBe(6)
    const card = await mountCard('popup-rates', FIXTURE_NOW, { since: filters.since, until: filters.until, sites: [...BEST_SUDOKU_SITES], excludeOwnVisits: true, ownBrowser: 'Opera', ownOS: 'Windows' })
    const newRows = [...rows(card)].map(([label, value]) => ({ label, value }))
    expect(newRows).toEqual(oldRows.map(({ label, value }) => ({ label, value })))
    // Real rates, a zero one, and the owner's own taps left out on both sides (4/11, not 7/14).
    expect(newRows.find((r) => r.label.startsWith('Upsell'))!.value).toBe('36.4% (4/11)')
    expect(newRows.some((r) => r.value.startsWith('0.0% ('))).toBe(true)
    // N3: the old inline caveat, now a Notes line for the installed rate.
    const oldNote = oldRows.find((r) => r.label.startsWith('Install prompt — installed'))!.note
    expect(oldNote).toMatch(/install fix/i)
    await card.find('button.mc-notes-toggle').trigger('click')
    const notes = card.findAll('.mc-notes li').map((li) => text(li.element))
    expect(notes.some((l) => l.startsWith('Install prompt — installed rate (from the install fix on): ') && /install fix/i.test(l))).toBe(true)
  })

  it('signin-eligibility: the chart bars are the card bars (L3), plus the rate (A1)', async () => {
    const resp = await fetchStats(eligible, filters)
    const cfg = buildChartConfig(eligible, resp)!
    const oldBars = (cfg.data.labels as string[]).map((l, i) => [l, String(cfg.data.datasets[0].data[i])])
    expect(oldBars).toEqual([['earned', '4'], ['capped', '2'], ['unearned', '1']]) // Opera's 2 left out
    const card = await mountCard('signin-eligibility', FIXTURE_NOW, { since: filters.since, until: filters.until, sites: [...BEST_SUDOKU_SITES], excludeOwnVisits: true, ownBrowser: 'Opera', ownOS: 'Windows' })
    const r = [...rows(card)]
    expect(r.slice(0, 3)).toEqual(oldBars)
    expect(card.findAll('.mi-bar-fill').map((b) => (b.element as HTMLElement).style.width)).toEqual(['100%', '50%', '25%'])
    expect(r[3]).toEqual(['Sign-in eligibility rate', '57.1% (4/7)']) // A1
  })
})

// ── Campaigns page ────────────────────────────────────────────────────────────────────────
const campaignsWidget = (view: string): Widget => ({ id: `cw-${view}`, i: `cw-${view}`, title: view, type: 'table', dataset: 'campaigns', view, dimension: '', metric: 'pageviews', limit: 1, notes: ['arrivals-caveat', 'spend-source'], x: 0, y: 0, w: 12, h: 10 })
async function mountOldCampaigns(view: string) {
  const w = mount(CampaignsWidgetBody, { props: { widget: campaignsWidget(view) } })
  mounted.push(w)
  await settle()
  return w
}

describe('campaign-cost ≡ the bespoke cost panel', () => {
  it('same campaigns, spend, source, freshness and costs, except L4, C1, C2 (A2: the refresh action)', async () => {
    const old = await mountOldCampaigns('cost')
    const oldCards = old.findAll('.cost-card').map((c) => ({
      title: text(c.find('.fc-label').element),
      why: c.find('p.state').exists() ? text(c.find('p.state').element) : '',
      rows: new Map(c.findAll('.cost-row:not(.fresh-row)').map((r) => [text(r.findAll('span')[0].element), text(r.findAll('span')[1].element)])),
      fresh: text(c.find('.fresh-row').element),
    }))
    expect(oldCards.map((c) => c.title)).toHaveLength(3)
    const card = await mountCard('campaign-cost', FIXTURE_NOW)
    expect(card.find('.mc-actions .ads-refresh button').exists()).toBe(true) // A2
    expect(old.find('.ads-refresh button').exists()).toBe(true)
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
      expect(n.rows.get('Spend'), o.title).toBe(o.rows.get('Spend'))
      expect(n.rows.get('Source'), o.title).toBe(o.rows.get('Source'))
      // L4: the freshness line, from the two rows (and the stale line under the date).
      const through = n.rows.get('Spend through')!
      const synced = n.rows.get('Synced')!
      const line = `${through === 'no closed spend day stored yet' ? 'No closed spend day stored yet' : `Spend through ${through}`} · ${synced === 'not synced yet' ? 'not synced yet' : `synced ${synced}`}${n.stale ? ` · ${n.stale}` : ''}`
      expect(line, `${o.title}: L4`).toBe(o.fresh)
      for (const label of ['Per arrival', 'Per auth success']) {
        const was = o.rows.get(label)
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
    steps: Map<string, { count: string; rate: string }>
  }
  function oldFunnel(w: VueWrapper): Map<string, Col> {
    return new Map(
      w.findAll('.funnel-col').map((c) => [
        text(c.find('.fc-label').element),
        {
          status: text(c.find('.fc-status').element),
          lines: c.findAll('.tagged-hits').map((l) => text(l.element)),
          steps: new Map(
            c.findAll('.funnel-step').map((st) => [
              text(st.find('.fs-label').element).replace(/ \(.*\)$/, ''),
              { count: text(st.find('.fs-count').element), rate: st.find('.fs-rate').exists() ? text(st.find('.fs-rate').element) : '' },
            ]),
          ),
        },
      ]),
    )
  }

  it('same beacon campaigns, status, counts and valid rates, except F1-F3, D1, D2', async () => {
    const old = oldFunnel(await mountOldCampaigns('funnel'))
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

describe('campaign-country ≡ the bespoke country panel', () => {
  it('same campaigns, same step rows, same US / CA / Other counts', async () => {
    const old = await mountOldCampaigns('country')
    const oldTables = new Map(
      old.findAll('.country-col').map((c) => {
        const heads = c.findAll('thead th').map((th) => text(th.element))
        const body = c.findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => text(td.element)))
        return [text(c.find('.fc-label').element), [heads, ...body]] as const
      }),
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
