// @vitest-environment happy-dom
//
// PARITY (ADR 0005 slice 3, step B1): the `ads-readings-log` preset, rendered by MetricCard, shows
// the same readings as the bespoke widget it replaces (widgets/AdsReadingsWidgetCard.vue) for one
// GET /api/ads/readings fixture. The tables are compared cell for cell and header for header; the
// fixture covers an incomplete reading, sign-ups exact / at-most / null, a null spend, a stale
// freshness note, the page notices, more than 30 readings and a campaignIds narrowing.
//
// Every visible difference is asserted as itself, so none can appear silently:
//
//   P1  Campaign header: the old widget prints "$12.50 (Google Ads API)" on one line; the card
//       prints the registry's "Spend" and "Source" rows ("$12.50", "Ads API" or "hand-entered").
//       The amount, and the "—" for none, are identical; the source wording is the registry's,
//       and with no spend on record the Source row reads "—" (old: "no spend on record").
//   P2  Freshness: the same sentence, under a "Data" label on the card.
//   P3  Fired thresholds: one text, joined with "; ", under a "Fired" label (the old widget drew
//       one chip per threshold).
//   P4  The Sign-ups header has no explanatory tooltip on the card (old: title=SIGNUPS_HINT).
//   P5  Rules / Proposal colour (trip / watch / clear / muted, and 'PROPOSE PAUSE') is not drawn
//       on the card: the text is identical, only the tone is missing (gap G6, see the handoff).
//   P6  Notices: the same lines in the same order, but the card draws them all above the refresh
//       button (old: store warning, note, button, then the sync alerts).
//   P7  First-load and failure states are the card's generic ones, not "Loading…" / the error text.
//
// Not differences: the Kind column ("<kind> (incomplete)"), the dim of an incomplete row, "No
// readings yet.", "No campaign has readings or stored spend yet.", the campaign filter
// (readings, stored Ads spend or an active status, unless campaignIds is set) and the 30-row limit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import AdsReadingsWidgetCard from '../widgets/AdsReadingsWidgetCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { __resetReturnRefreshForTests } from '../../composables/useReturnRefresh'
import { fetchAdsReadings } from '../../api'
import { STALE_NOTE } from '../../lib/adsFreshness'
import { SMALL_SAMPLE_NOTE } from '../../lib/popupEvents'
import { CAMPAIGNS } from '../../lib/campaigns'

vi.mock('../../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api')>()
  return { ...actual, fetchAdsReadings: vi.fn() }
})
const mocked = vi.mocked(fetchAdsReadings)

// Two real campaigns, in the order the server returns them (CAMPAIGNS order).
const [X, Y] = [CAMPAIGNS[0].id, CAMPAIGNS[2].id]
const LABEL = { [X]: CAMPAIGNS[0].label, [Y]: CAMPAIGNS[2].label } as Record<string, string>

const rules = (...s: string[]) => s.map((status, i) => ({ id: (['placement-leak', 'ctr', 'funnel-reach', 'hard-cap'] as const)[i], label: 'r', status, value: 1, limit: 2, detail: '' }))
let n = 0
const rec = (campaignId: string, extra: Record<string, unknown> = {}, counts: Record<string, number | null> = {}) => ({
  v: 1,
  id: `r${++n}`,
  campaignId,
  kind: 'daily',
  readAt: `2026-09-26T${String(10 + (n % 10)).padStart(2, '0')}:00:00Z`,
  etDate: '2026-09-26',
  spendThroughEt: '2026-09-25',
  cumulativeSpend: 10.5,
  thresholds: [],
  complete: true,
  rules: rules('clear', 'clear', 'no-data', 'n/a'),
  proposal: null,
  decision: null,
  counts: { taggedArrivals: 5, asks: 4, accepts: 3, authSuccess: 2, signUpsAtMost: 1, signUpsExact: 0, ...counts },
  notes: [],
  ...extra,
})
const camp = (campaignId: string, readings: unknown[], extra: Record<string, unknown> = {}) => ({
  campaignId,
  label: LABEL[campaignId],
  status: 'active',
  spend: { spend: 12.5, source: 'google-ads-api', fetchedAt: '2026-10-03T11:00:00Z', lastDate: '2026-10-02' },
  spendThrough: '2026-10-02',
  lastSync: '2026-10-03T11:30:00Z',
  stale: false,
  thresholdsFired: null,
  readings,
  ...extra,
})
const resp = (campaigns: unknown[], extra: Record<string, unknown> = {}) => ({ generatedAt: '2026-10-03T12:00:00Z', storeBound: true, storeReadable: true, campaigns, syncAlerts: [], ...extra }) as never

/** What GET /api/ads/readings does with ?campaignId=: keep those campaigns, or all when none. */
function serve(r: { campaigns: { campaignId: string }[] }) {
  mocked.mockImplementation(async (q: string) => {
    const ids = new URLSearchParams(q).getAll('campaignId')
    return (ids.length ? { ...r, campaigns: r.campaigns.filter((c) => ids.includes(c.campaignId)) } : r) as never
  })
}

/** The rules/spend a /api/metrics request would answer for each campaign in the fixture. */
let spendById: Record<string, { spend: number | null; source: string }> = {}
function metricsFetch() {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { requests: { key: string; metric?: string; params?: { campaignId?: string } }[] }
    const results: Record<string, unknown> = {}
    for (const r of body.requests) {
      const s = spendById[r.params?.campaignId ?? '']
      if (r.metric === 'campaign.spend') results[r.key] = s?.spend == null ? { status: 'ok', value: null } : { status: 'ok', value: s.spend }
      else if (r.metric === 'campaign.spendSource') {
        results[r.key] = s?.source === 'google-ads-api' ? { status: 'ok', value: 1, noteIds: ['spend-source.ads-api'] } : s?.source === 'config' ? { status: 'ok', value: 0, noteIds: ['spend-source.config'] } : { status: 'ok', value: null }
      } else results[r.key] = { status: 'unmeasured', value: null }
    }
    return { ok: true, status: 200, json: async () => ({ v: 1, generatedAt: 'x', results, meta: { facts: 0, cacheHits: 0, statements: 0 } }) }
  })
}

async function settle() {
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(200) // past useMetrics' batching window
    await flushPromises()
  }
}
const mounted: VueWrapper[] = []
async function oldWidget(widget: Record<string, unknown> = {}) {
  const w = mount(AdsReadingsWidgetCard, { props: { widget } })
  mounted.push(w)
  await settle()
  return w
}
async function newCard(props: Record<string, unknown> = {}) {
  const w = mount(MetricCard, { props: { cardRef: { preset: 'ads-readings-log' }, ...props } })
  mounted.push(w)
  await settle()
  return w
}
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Old widget: one entry per campaign block. */
const oldBlocks = (w: VueWrapper) =>
  w.findAll('.camp').map((c) => ({
    label: squash(c.find('.camp-label').text()),
    spend: squash(c.find('.camp-spend').text()),
    fresh: c.find('.fresh').exists() ? squash(c.find('.fresh').text()) : null,
    fired: c.find('.fired').exists() ? c.findAll('.chip').map((x) => squash(x.text())) : null,
    heads: c.findAll('th').map((t) => t.text()),
    rows: c.findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => squash(td.text()))),
    dim: c.findAll('tbody tr').map((tr) => tr.classes().includes('incomplete')),
    empty: c.find('.state').exists() ? squash(c.find('.state').text()) : null,
  }))
/** New card: one entry per campaign card. */
const newBlocks = (w: VueWrapper) =>
  w.findAll('.metric-card-grid > *').map((c) => {
    const rowText = (label: string) => {
      const row = c.findAll('.mi-row').find((r) => squash(r.find('.mi-label').text()) === label)
      return row ? squash(row.find('.mi-value').text()) : null
    }
    return {
      label: squash(c.find('.mc-title').text()),
      spend: rowText('Spend'),
      source: rowText('Source'),
      fresh: rowText('Data'),
      fired: c.find('.mi-pill-value').exists() ? squash(c.find('.mi-pill-value').text()) : null,
      heads: c.findAll('th').map((t) => t.text()),
      rows: c.findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => squash(td.text()))),
      dim: c.findAll('tbody tr').map((tr) => tr.classes().includes('incomplete')),
      empty: c.find('.metric-table-empty').exists() ? squash(c.find('.metric-table-empty').text()) : null,
    }
  })
const noticesOf = (w: VueWrapper) => w.findAll('.mc-notice').map((p) => squash(p.text()))

beforeEach(() => {
  n = 0
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  vi.useFakeTimers({ now: Date.parse('2026-10-03T12:00:00Z') })
  mocked.mockReset()
  spendById = { [X]: { spend: 12.5, source: 'google-ads-api' }, [Y]: { spend: 12.5, source: 'google-ads-api' } }
  vi.stubGlobal('fetch', metricsFetch())
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
  __resetReturnRefreshForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ads-readings-log parity: the readings table', () => {
  it('shows the same header and the same cells for a mixed fixture (incomplete, sign-ups exact / at-most / null, null spend, proposal, thresholds)', async () => {
    serve(
      resp([
        camp(X, [
          rec(X, { complete: false, rules: null }),
          rec(X, { kind: 'threshold', thresholds: [50], proposal: 'PROPOSE PAUSE', rules: rules('trip', 'clear', 'clear', 'clear') }, { signUpsAtMost: 7, signUpsExact: 1 }),
          rec(X, { kind: 'postflight', stage: 'day15', cumulativeSpend: null, proposal: null, notes: ['no pause proposed: campaign ended'], rules: rules('watch', 'clear', 'clear', 'clear') }, { signUpsAtMost: 1500 }),
          rec(X, { rules: rules('not-armed', 'not-armed') }, { signUpsAtMost: null, taggedArrivals: null, asks: 0, accepts: null }),
          rec(X, { kind: 'adhoc', complete: false }, { signUpsAtMost: 1234, signUpsExact: 1 }),
        ]),
        camp(Y, []),
      ]),
    )
    const o = oldBlocks(await oldWidget())
    const c = newBlocks(await newCard())
    expect(c).toHaveLength(o.length)
    expect(o[0].rows).toHaveLength(5)
    expect(c[0].heads.map((h) => h.replace(/\s+/g, ' '))).toEqual(o[0].heads)
    expect(c[0].heads).toEqual(['Read', 'Kind', 'Spend', 'Rules', 'Proposal', 'Arrivals', 'Asks', 'Accepts', 'Auth', 'Sign-ups'])
    expect(c[0].rows).toEqual(o[0].rows)
    expect(c[0].dim).toEqual(o[0].dim)
    expect(c[0].dim).toEqual([true, false, false, false, true])
    // the pieces the issue calls out, spelled out so a regression names itself
    const kinds = c[0].rows.map((r) => r[1])
    expect(kinds).toEqual(['daily (incomplete)', 'threshold $50', 'post-flight day15', 'daily', 'adhoc (incomplete)'])
    expect(c[0].rows.map((r) => r[9])).toEqual(['at most 1', '7 (exact)', 'at most 1,500', '—', '1,234 (exact)'])
    expect(c[0].rows[2][2]).toBe('—') // null spend
    expect(c[0].rows[2][4]).toBe('campaign ended') // proposalLabel's "no pause proposed" note
  })

  it('an empty campaign shows "No readings yet." on both', async () => {
    serve(resp([camp(X, [rec(X)]), camp(Y, [])]))
    const o = oldBlocks(await oldWidget())
    const c = newBlocks(await newCard())
    expect(o[1].empty).toBe('No readings yet.')
    expect(c[1].empty).toBe('No readings yet.')
    expect(c[1].rows).toEqual([])
    expect(c[0].empty).toBeNull()
  })

  it('shows 30 readings by default on both (more than 30 in the response), newest first', async () => {
    const many = Array.from({ length: 45 }, (_, i) => rec(X, { readAt: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T12:00:00Z` }, { asks: i }))
    serve(resp([camp(X, many), camp(Y, [])]))
    const o = oldBlocks(await oldWidget())
    mocked.mockClear()
    const c = newBlocks(await newCard())
    expect(new URLSearchParams(mocked.mock.calls[0][0] as string).get('limit')).toBe('30')
    // the server applies the limit; the stub here returns 45, the card trims to its repeat's limit
    expect(c[0].rows).toHaveLength(30)
    expect(c[0].rows).toEqual(o[0].rows.slice(0, 30))
  })

  it('narrowing to one of two campaigns (campaignIds) draws that campaign only, on both', async () => {
    serve(resp([camp(X, [rec(X)]), camp(Y, [rec(Y)])]))
    const o = oldBlocks(await oldWidget({ campaignIds: [Y] }))
    const c = newBlocks(await newCard({ campaignIds: [Y] }))
    expect(o).toHaveLength(1)
    expect(c).toHaveLength(1)
    expect(c[0].label).toBe(o[0].label)
    expect(c[0].rows).toEqual(o[0].rows)
    // narrowing also narrows the request
    expect(mocked.mock.calls.every(([q]) => new URLSearchParams(q as string).getAll('campaignId').join() === Y)).toBe(true)
  })

  it('without campaignIds, hides a campaign with no readings, no Ads spend and a paused status (and shows the empty text if none are left)', async () => {
    const idle = { status: 'paused', spend: { spend: 3, source: 'config', fetchedAt: null, lastDate: null } }
    serve(resp([camp(X, [], idle), camp(Y, [rec(Y)])]))
    const o = oldBlocks(await oldWidget())
    const c = newBlocks(await newCard())
    expect(o.map((b) => b.label)).toEqual([LABEL[Y]])
    expect(c.map((b) => b.label)).toEqual([LABEL[Y]])

    serve(resp([camp(X, [], idle), camp(Y, [], idle)]))
    const ow = await oldWidget()
    const cw = await newCard()
    expect(ow.text()).toContain('No campaign has readings or stored spend yet.')
    expect(cw.text()).toContain('No campaign has readings or stored spend yet.')
    // ...but an explicit campaignIds shows them anyway, as the old widget does
    const cn = newBlocks(await newCard({ campaignIds: [X] }))
    expect(cn.map((b) => b.label)).toEqual([LABEL[X]])
    expect(oldBlocks(await oldWidget({ campaignIds: [X] })).map((b) => b.label)).toEqual([LABEL[X]])
  })
})

describe('ads-readings-log parity: the campaign header', () => {
  it('P1 spend and source: the same amount, the registry\'s wording for the source', async () => {
    spendById = { [X]: { spend: 12.5, source: 'google-ads-api' }, [Y]: { spend: 3, source: 'config' } }
    serve(resp([camp(X, [rec(X)]), camp(Y, [rec(Y)], { spend: { spend: 3, source: 'config', fetchedAt: null, lastDate: null } })]))
    const o = oldBlocks(await oldWidget())
    const c = newBlocks(await newCard())
    expect(o.map((b) => b.spend)).toEqual(['$12.50 (Google Ads API)', '$3.00 (hand-entered config)'])
    expect(c.map((b) => b.spend)).toEqual(['$12.50', '$3.00'])
    expect(c.map((b) => b.source)).toEqual(['Ads API', 'hand-entered'])
  })

  it('P1 null spend: "—" on both; the Source row is "—" where the old line says "no spend on record"', async () => {
    spendById = { [X]: { spend: null, source: 'none' }, [Y]: { spend: 1, source: 'config' } }
    serve(resp([camp(X, [rec(X)], { spend: { spend: null, source: 'none', fetchedAt: null, lastDate: null } }), camp(Y, [rec(Y)])]))
    const o = oldBlocks(await oldWidget())
    const c = newBlocks(await newCard())
    expect(o[0].spend).toBe('— (no spend on record)')
    expect(c[0].spend).toBe('—')
    expect(c[0].source).toBe('—') // the old widget words it "no spend on record"
  })

  it('P2 freshness: the same sentence, with the stale note when stale; absent with an unbound store', async () => {
    serve(resp([camp(X, [rec(X)], { stale: true, lastSync: '2026-10-01T12:00:00Z' }), camp(Y, [rec(Y)])]))
    const o = oldBlocks(await oldWidget())
    const c = newBlocks(await newCard())
    expect(o[0].fresh).toContain(STALE_NOTE)
    expect(c[0].fresh).toBe(o[0].fresh)
    expect(c[1].fresh).toBe(o[1].fresh)
    expect(c[1].fresh).not.toContain(STALE_NOTE)

    serve(resp([camp(X, [])], { storeBound: false, storeReadable: false }))
    expect(oldBlocks(await oldWidget())[0].fresh).toBeNull()
    expect(newBlocks(await newCard())[0].fresh).toBeNull()
  })

  it('P3 fired thresholds: the same chips, joined into one text on the card', async () => {
    const fired = [
      { threshold: 50, firedAt: '2026-10-01T19:00:00Z' },
      { threshold: 100, firedAt: '2026-10-02T19:00:00Z' },
    ]
    serve(resp([camp(X, [rec(X)], { thresholdsFired: fired }), camp(Y, [rec(Y)])]))
    const o = oldBlocks(await oldWidget())
    const c = newBlocks(await newCard())
    expect(o[0].fired).toEqual(['$50 · Oct 1, 3:00 PM ET', '$100 · Oct 2, 3:00 PM ET'])
    expect(c[0].fired).toBe(o[0].fired!.join('; '))
    expect(o[1].fired).toBeNull()
    expect(c[1].fired).toBeNull()
  })
})

describe('ads-readings-log parity: the notices (G7)', () => {
  const alert = { source: 'ads-sync', startedAt: '2026-10-02T03:00:00Z', message: 'killed mid-run' }

  it('an unbound store, the static note and each sync alert read the same on both, in order', async () => {
    serve(resp([camp(X, [])], { storeBound: false, storeReadable: false, syncAlerts: [alert, { ...alert, startedAt: '2026-10-02T04:00:00Z', message: 'again' }] }))
    const ow = await oldWidget()
    const old = ow.findAll('.state.small, .note, .sync-alert').map((p) => squash(p.text())).filter((t) => !t.startsWith('No '))
    const c = noticesOf(await newCard())
    expect(old).toEqual([
      'Readings store not bound (gss_stats_ads) — showing config spend only.',
      `${SMALL_SAMPLE_NOTE} Proposals only; the routine never changes a campaign.`,
      'Sync alert: killed mid-run',
      'Sync alert: again',
    ])
    expect(c).toEqual(old)
  })

  it('an unreadable store reads the same on both; a healthy one shows only the static note', async () => {
    serve(resp([camp(X, [rec(X)])], { storeReadable: false }))
    const c1 = noticesOf(await newCard())
    expect(c1[0]).toBe('Readings store unreadable — showing config spend only.')
    expect(oldBlocks(await oldWidget()).length).toBe(1)
    serve(resp([camp(X, [rec(X)])]))
    const c2 = noticesOf(await newCard())
    expect(c2).toEqual([`${SMALL_SAMPLE_NOTE} Proposals only; the routine never changes a campaign.`])
  })
})

describe('ads-readings-log parity: the accepted differences, pinned', () => {
  it('P4 / P5: the old widget has a Sign-ups tooltip and rules / proposal tones; the card has neither (the text is identical)', async () => {
    serve(resp([camp(X, [rec(X, { proposal: 'PROPOSE PAUSE', rules: rules('trip', 'clear', 'clear', 'clear') })]), camp(Y, [])]))
    const ow = await oldWidget()
    const cw = await newCard()
    expect(ow.findAll('th')[9].attributes('title')).toBeTruthy()
    expect(ow.find('td.trip').exists()).toBe(true)
    expect(cw.findAll('th')[9].attributes('title')).toBeUndefined()
    expect(cw.find('tbody td.trip, tbody .trip').exists()).toBe(false)
    expect(newBlocks(cw)[0].rows).toEqual(oldBlocks(ow)[0].rows)
    expect(newBlocks(cw)[0].rows[0][3]).toBe('TRIPPED: placement-leak')
    expect(newBlocks(cw)[0].rows[0][4]).toBe('PROPOSE PAUSE')
  })

  it('draws no count outside the five whitelisted ones, and no hour, place or device beside a row', async () => {
    serve(resp([camp(X, [rec(X, {}, { returnD0Web: 777, returnD0App: 778, returnD1: 779, gameStart: 888, tutorialComplete: 889, tourSkip: 890 })]), camp(Y, [])]))
    const w = await newCard()
    expect(w.text()).not.toMatch(/777|778|779|888|889|890/)
    expect(w.findAll('tbody tr')[0].findAll('td')).toHaveLength(10)
  })
})
