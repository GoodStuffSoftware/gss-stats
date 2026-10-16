// @vitest-environment happy-dom
//
// FeatureHealthCard and the step chart config, with fetch stubbed and made-up data.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import FeatureHealthCard from './FeatureHealthCard.vue'
import { featureHealthWidget, defaultFeaturesWidgets } from '../lib/defaults'
import { buildStepChartConfig } from '../lib/featureHealthChart'
import { HEALTH_CAPTION, stepsViewFor, featureIdOfView, type FeatureHealth, type FeatureHealthModel } from '../lib/featureHealth'
import { COACH_TIPS_CAPTION, COACH_TIPS_EMPTY_NOTE, COACH_TIPS_VIEW } from '../lib/coachTips'
import { ASK_ORDER_CAPTION, ASK_ORDER_EMPTY_NOTE, ASK_ORDER_FEATURES, ASK_ORDER_VIEW, askOrderFeatureId } from '../lib/askOrder'
import type { GlobalFilters } from '../types'

const feature: FeatureHealth = {
  id: 'made-up',
  label: 'Made-up feature',
  blurb: 'A made-up blurb.',
  status: 'silent',
  statusNote: 'averaged 9 a day, none yesterday',
  latest: 0,
  prev: 9,
  range: 20,
  steps: [
    { id: 'shown', label: 'Shown', latest: 0, prev: 9, range: 20, perDay: [5, 6, 9, 0] },
    { id: 'tapped', label: 'Tapped', latest: 0, prev: 3, range: 8, perDay: [1, 2, 3, 0], ratio: { label: 'tapped per shown', latest: null, prev: 0.33, range: 0.4 } },
  ],
}
const model: FeatureHealthModel & { meta: Record<string, string> } = {
  days: ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'],
  latestDay: '2026-10-14',
  prevDay: '2026-10-13',
  features: [feature],
  meta: { since: '2026-10-11', until: '2026-10-14', rangeFrom: '2026-10-11', rangeTo: '2026-10-14', sites: '', today: '2026-10-15' },
}
const filters: GlobalFilters = { siteSel: [], since: '2026-10-11T04:00:00.000Z', until: '2026-10-15T04:00:00.000Z', excludeSelfReferrals: false, excludeOwnVisits: true, ownBrowser: 'Firefox', ownOS: 'Linux' }

const mounted: VueWrapper[] = []
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => model, text: async () => '' })))
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  vi.unstubAllGlobals()
})
let uniq = 0
async function mountCard(view: string) {
  // A distinct site selection per mount, so the shared in-flight request (api.ts) never crosses tests.
  const widget = { ...featureHealthWidget({ x: 0, y: 0, w: 12, h: 20 }), view, siteSel: ['made-up-site-' + view + '-' + ++uniq] }
  const w = mount(FeatureHealthCard, { props: { widget, filters, dark: false }, global: { stubs: { BaseChart: true } } })
  mounted.push(w)
  await flushPromises()
  return w
}

describe('FeatureHealthCard', () => {
  it('renders a row per feature with the status badge and the caption', async () => {
    const w = await mountCard('health')
    const row = w.find('tr[data-feature="made-up"]')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('Made-up feature')
    expect(row.text()).toContain('Went silent')
    expect(row.text()).toContain('Shown')
    expect(w.find('[data-testid="feature-health-caption"]').text()).toBe(HEALTH_CAPTION)
  })

  it('shows a dash for a zero-denominator ratio', async () => {
    const w = await mountCard('health')
    expect(w.find('tr[data-feature="made-up"]').text()).toContain('— · 0.33 · 0.40')
  })

  it('renders a step view as a chart with the status badge and no table', async () => {
    const w = await mountCard(stepsViewFor('made-up'))
    expect(w.find('table').exists()).toBe(false)
    expect(w.find('.fh-chart[data-feature="made-up"]').text()).toContain('Went silent')
  })
})

describe('step chart and defaults', () => {
  it('builds one dataset per step and one label per day', () => {
    const cfg = buildStepChartConfig(model, feature)
    expect(cfg.data.datasets.map((d) => d.label)).toEqual(['Shown', 'Tapped'])
    expect(cfg.data.labels).toHaveLength(4)
    expect(cfg.data.datasets[0].data).toEqual([5, 6, 9, 0])
  })

  it('maps feature ids to step views and back; the Features page has a chart per feature', () => {
    expect(featureIdOfView(stepsViewFor('abc'))).toBe('abc')
    expect(featureIdOfView('health')).toBeNull()
    const widgets = defaultFeaturesWidgets()
    for (const w of widgets.filter((x) => x.view !== COACH_TIPS_VIEW && x.view !== ASK_ORDER_VIEW)) {
      expect(w.dataset).toBe('features')
      expect(featureIdOfView(w.view)).toBeTruthy()
    }
    // The Coach tips table sits under the charts, full width, and appears once.
    const tips = widgets.filter((x) => x.view === COACH_TIPS_VIEW)
    expect(tips).toHaveLength(1)
    expect(tips[0]).toMatchObject({ dataset: 'features', x: 0, w: 12, excludeKnownTraffic: true })
    const charts = widgets.filter((x) => x.view !== COACH_TIPS_VIEW && x.view !== ASK_ORDER_VIEW)
    expect(tips[0].y).toBeGreaterThanOrEqual(Math.max(...charts.map((x) => x.y + x.h)))
    // The Ask-order card sits under the Coach tips, full width, and appears once.
    const ask = widgets.filter((x) => x.view === ASK_ORDER_VIEW)
    expect(ask).toHaveLength(1)
    expect(ask[0]).toMatchObject({ id: 'fw-ask-order', dataset: 'features', x: 0, w: 12, excludeKnownTraffic: true })
    expect(ask[0].y).toBeGreaterThanOrEqual(tips[0].y + tips[0].h)
  })
})

describe('Coach tips card', () => {
  const coachFeature = (id: string, label: string, shown: [number, number], dismissed: [number, number], closed: [number, number]): FeatureHealth => ({
    id: `tip-${id}`,
    label,
    blurb: `The ${id} tip.`,
    status: 'ok',
    statusNote: '',
    latest: 0,
    prev: 0,
    range: 0,
    steps: [
      { id: 'shown', label: 'Shown', latest: shown[0], prev: 0, range: shown[1], perDay: [] },
      { id: 'dismissed', label: 'Dismissed', latest: dismissed[0], prev: 0, range: dismissed[1], perDay: [], ratio: { label: 'dismissed per shown', latest: shown[0] ? dismissed[0] / shown[0] : null, prev: null, range: shown[1] ? dismissed[1] / shown[1] : null } },
      { id: 'closed', label: 'Closed while showing', latest: closed[0], prev: 0, range: closed[1], perDay: [], ratio: { label: 'closed while showing per shown', latest: shown[0] ? closed[0] / shown[0] : null, prev: null, range: shown[1] ? closed[1] / shown[1] : null } },
    ],
  })
  const opened: FeatureHealth = {
    id: 'tour-opened',
    label: 'Show me around',
    blurb: 'Taps on "Show me around".',
    status: 'ok',
    statusNote: '',
    latest: 0,
    prev: 0,
    range: 0,
    steps: [{ id: 'opened', label: 'Opened', latest: 4, prev: 0, range: 9, perDay: [] }],
  }
  const coachModel = (everSeen: boolean) => ({
    ...model,
    everSeen,
    features: [coachFeature('place', 'Place', [10, 40], [5, 10], [2, 8]), coachFeature('hint', 'Hint', [0, 0], [0, 0], [0, 0]), opened],
  })
  const mountCoach = async (m: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => m, text: async () => '' })))
    return mountCard(COACH_TIPS_VIEW)
  }

  it('asks the features endpoint for the coach-tips view and nothing split by hour, place or device', async () => {
    await mountCoach(coachModel(true))
    const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.view).toBe(COACH_TIPS_VIEW)
    expect(Object.keys(body).sort()).toEqual(['excludeKnownTraffic', 'excludeOwnVisits', 'ownBrowser', 'ownOS', 'since', 'sites', 'until', 'view'])
  })

  it('draws a row per tip with counts, ratios and a dash for a zero denominator, and the tour total apart', async () => {
    const w = await mountCoach(coachModel(true))
    const place = w.find('tr[data-tip="tip-place"]')
    expect(place.find('[data-col="latest-shown"]').text()).toBe('10')
    expect(place.find('[data-col="range-shown"]').text()).toBe('40')
    expect(place.find('[data-col="latest-dismissed"]').text()).toBe('5')
    expect(place.find('[data-col="latest-closed"]').text()).toBe('2')
    expect(place.find('[data-col="latest-dismissed-ratio"]').text()).toBe('0.50')
    expect(place.find('[data-col="range-closed-ratio"]').text()).toBe('0.20')
    const hint = w.find('tr[data-tip="tip-hint"]')
    expect(hint.find('[data-col="latest-dismissed-ratio"]').text()).toBe('—')
    expect(hint.find('[data-col="range-closed-ratio"]').text()).toBe('—')
    const tour = w.find('tr[data-tip="tour-opened"]')
    expect(tour.find('[data-col="latest-opened"]').text()).toBe('4')
    expect(tour.find('[data-col="range-opened"]').text()).toBe('9')
    expect(w.findAll('tr[data-tip]').map((r) => r.attributes('data-tip'))).toEqual(['tip-place', 'tip-hint', 'tour-opened'])
    expect(w.find('[data-testid="coach-tips-caption"]').text()).toBe(COACH_TIPS_CAPTION)
  })

  it('says the game version has not shipped while no coach row has ever arrived', async () => {
    const w = await mountCoach(coachModel(false))
    expect(w.find('[data-testid="coach-tips-empty"]').text()).toBe(COACH_TIPS_EMPTY_NOTE)
    expect(w.find('[data-testid="coach-tips-empty"]').text()).toContain('No coach data yet')
  })

  it('shows no such note once rows exist', async () => {
    const w = await mountCoach(coachModel(true))
    expect(w.find('[data-testid="coach-tips-empty"]').exists()).toBe(false)
  })
})

describe('Ask-order card', () => {
  type Cell = { latest?: number; range?: number }
  /** A group's FeatureHealth with the given step counts (everything else 0). */
  const group = (g: 'signin-first' | 'install-first', cells: Record<string, Cell>): FeatureHealth => ({
    id: askOrderFeatureId(g),
    label: g,
    blurb: '',
    status: 'ok',
    statusNote: '',
    latest: 0,
    prev: 0,
    range: 0,
    steps: ASK_ORDER_FEATURES.find((f) => f.id === askOrderFeatureId(g))!.steps.map((s) => ({
      id: s.id,
      label: s.label,
      latest: cells[s.id]?.latest ?? 0,
      prev: 0,
      range: cells[s.id]?.range ?? 0,
      perDay: [],
    })),
  })
  const askModel = (everSeen: boolean, allTime: Record<string, number> = {}, a: Record<string, Cell> = {}, b: Record<string, Cell> = {}) => ({
    ...model,
    everSeen,
    allTime,
    features: [group('signin-first', a), group('install-first', b)],
  })
  const mountAsk = async (m: unknown) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => m, text: async () => '' })))
    return mountCard(ASK_ORDER_VIEW)
  }
  const k = (g: string, step: string) => `ao-${g}.${step}`

  it('asks the features endpoint for the ask-order view and nothing split by hour, place or device', async () => {
    await mountAsk(askModel(true))
    const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.view).toBe(ASK_ORDER_VIEW)
    expect(Object.keys(body).sort()).toEqual(['excludeKnownTraffic', 'excludeOwnVisits', 'ownBrowser', 'ownOS', 'since', 'sites', 'until', 'view'])
  })

  it('says the game version has not shipped while no row has ever arrived, and not afterwards', async () => {
    const empty = await mountAsk(askModel(false))
    expect(empty.find('[data-testid="ask-order-empty"]').text()).toBe(ASK_ORDER_EMPTY_NOTE)
    const live = await mountAsk(askModel(true))
    expect(live.find('[data-testid="ask-order-empty"]').exists()).toBe(false)
  })

  it('draws the progress toward 150 asks per group and ONE preliminary read below it', async () => {
    const w = await mountAsk(
      askModel(true, {
        [k('signin-first', 'assigned-organic')]: 50,
        [k('signin-first', 'shown-signin-organic')]: 30,
        [k('signin-first', 'shown-install-tagged')]: 10,
        [k('signin-first', 'signin-signed-in-organic')]: 5,
        [k('install-first', 'assigned-organic')]: 20,
        [k('install-first', 'shown-install-organic')]: 25,
      }),
    )
    const groups = w.findAll('.ao-group')
    expect(groups.map((g) => g.attributes('data-group'))).toEqual(['signin-first', 'install-first'])
    expect(groups[0].find('[data-col="asks-progress"]').text()).toBe('asks shown 40 / 150')
    expect(groups[1].find('[data-col="asks-progress"]').text()).toBe('asks shown 25 / 150')
    expect(groups[0].find('.ao-bar').attributes('aria-valuenow')).toBe('40')
    expect(groups[0].find('[data-col="assigned"]').text()).toBe('assigned rows 50')
    // Signed-in rows and installed rows are separate row ratios, each labelled as such.
    expect(groups[0].find('[data-col="per-assigned-signed-in"]').text()).toContain('signed-in rows per assigned row 0.10 (5 rows)')
    expect(groups[0].find('[data-col="per-assigned-installed"]').text()).toContain('installed rows per assigned row 0.00 (0 rows)')
    expect(groups[0].find('[data-col="response-rows-per-assigned"]').text()).toContain('(a device that both signs in and installs counts twice)')
    const verdicts = w.findAll('[data-testid="ask-order-verdict"]')
    expect(verdicts).toHaveLength(1)
    expect(verdicts[0].attributes('data-state')).toBe('preliminary')
    expect(verdicts[0].text()).toContain('Preliminary')
    // Progress counts every row, organic plus tagged.
    expect(groups[0].find('[data-col="primary-per-assigned"]').text()).toContain('0.10 (5 rows)')
  })

  it('states which primary is active and why: combined until a responded row is seen, then responded', async () => {
    const combined = await mountAsk(askModel(true, { [k('signin-first', 'assigned-organic')]: 10 }))
    const p1 = combined.find('[data-testid="ask-order-primary"]')
    expect(p1.attributes('data-primary')).toBe('combined')
    expect(p1.text()).toBe('Primary: combined response rows (responded row not seen yet)')
    const seen = await mountAsk(askModel(true, { [k('signin-first', 'assigned-organic')]: 10, [k('install-first', 'responded-install-tagged')]: 2 }))
    const p2 = seen.find('[data-testid="ask-order-primary"]')
    expect(p2.attributes('data-primary')).toBe('responded')
    expect(p2.text()).toBe('Primary: responded per assigned (once-per-device row)')
    expect(seen.find('.ao-group[data-group="install-first"] [data-col="responded-per-assigned"]').text()).toContain('(2 rows)')
  })

  it('shows signed-in and installed row ratios as display only, beside the primary', async () => {
    const w = await mountAsk(
      askModel(true, {
        [k('signin-first', 'assigned-organic')]: 100,
        [k('signin-first', 'signin-signed-in-organic')]: 10,
        [k('signin-first', 'install-installed-organic')]: 20,
      }),
    )
    const g = w.find('.ao-group[data-group="signin-first"]')
    expect(g.find('[data-col="per-assigned-signed-in"]').text()).toContain('signed-in rows per assigned row 0.10 (10 rows)')
    expect(g.find('[data-col="per-assigned-installed"]').text()).toContain('installed rows per assigned row 0.20 (20 rows)')
    expect(g.find('[data-col="per-assigned-signed-in"]').attributes('title')).toContain('Display only')
    expect(g.find('[data-col="per-assigned-installed"]').attributes('title')).toContain('Display only')
    expect(g.find('[data-col="primary-per-assigned"]').text()).toContain('combined response rows')
    expect(g.find('[data-col="primary-per-assigned"]').text()).toContain('0.30 (30 rows)')
    expect(w.find('[data-testid="ask-order-kinds"]').text()).toContain('(display only)')
  })

  it('makes ONE call on the combined primary once both groups reach 150, with the 1.5x result', async () => {
    const w = await mountAsk(
      askModel(true, {
        [k('signin-first', 'assigned-organic')]: 100,
        [k('signin-first', 'shown-signin-organic')]: 150,
        [k('signin-first', 'signin-signed-in-organic')]: 10,
        [k('signin-first', 'install-installed-organic')]: 20,
        [k('install-first', 'assigned-organic')]: 100,
        [k('install-first', 'shown-install-organic')]: 100,
        [k('install-first', 'shown-signin-tagged')]: 50,
        [k('install-first', 'signin-signed-in-organic')]: 20,
        [k('install-first', 'install-installed-tagged')]: 40,
      }),
    )
    const verdicts = w.findAll('[data-testid="ask-order-verdict"]')
    expect(verdicts).toHaveLength(1)
    const v = verdicts[0]
    expect(v.attributes('data-state')).toBe('call')
    expect(v.attributes('data-basis')).toBe('primary')
    expect(v.find('[data-col="rule-multiple"]').text()).toContain('2.00x')
    expect(v.find('[data-col="rule-multiple"]').text()).toContain('1.5x rule on the primary')
    expect(v.text()).toContain('switch everyone to install first')
  })

  it('keeps sign-in first below 1.5x on the responded primary, and switches at exactly 1.5x', async () => {
    const base = {
      [k('signin-first', 'assigned-organic')]: 100,
      [k('signin-first', 'shown-signin-organic')]: 150,
      [k('install-first', 'assigned-organic')]: 100,
      [k('install-first', 'shown-install-organic')]: 150,
      [k('signin-first', 'responded-signin-organic')]: 10,
    }
    const below = await mountAsk(askModel(true, { ...base, [k('install-first', 'responded-signin-organic')]: 14 }))
    expect(below.find('[data-testid="ask-order-verdict"]').text()).toContain('keep sign-in first')
    const exact = await mountAsk(askModel(true, { ...base, [k('install-first', 'responded-signin-organic')]: 15 }))
    expect(exact.find('[data-testid="ask-order-primary"]').attributes('data-primary')).toBe('responded')
    expect(exact.find('[data-testid="ask-order-verdict"]').text()).toContain('switch everyone to install first')
  })

  it('says sign-ins decide when the kinds point opposite ways', async () => {
    const w = await mountAsk(
      askModel(true, {
        [k('signin-first', 'assigned-organic')]: 100,
        [k('signin-first', 'shown-signin-organic')]: 150,
        [k('signin-first', 'signin-signed-in-organic')]: 10,
        [k('install-first', 'assigned-organic')]: 100,
        [k('install-first', 'shown-install-organic')]: 150,
        [k('install-first', 'signin-signed-in-organic')]: 5,
        [k('install-first', 'install-installed-organic')]: 20,
      }),
    )
    const v = w.find('[data-testid="ask-order-verdict"]')
    expect(v.attributes('data-basis')).toBe('sign-ins')
    expect(v.find('[data-col="rule-multiple"]').text()).toContain('rule on sign-ins')
    expect(v.text()).toContain('sign-ins decide')
    expect(v.text()).toContain('keep sign-in first')
  })

  it('fills the table by window, group and tag, with row ratios and a dash for a zero denominator', async () => {
    const w = await mountAsk(
      askModel(
        true,
        {},
        {
          'assigned-tagged': { latest: 8, range: 40 },
          'signin-signed-in-tagged': { latest: 2, range: 10 },
          'install-signed-in-tagged': { latest: 2, range: 6 },
          'install-installed-tagged': { latest: 1, range: 4 },
        },
        { 'signin-returned-organic': { latest: 3, range: 3 } },
      ),
    )
    const cell = (row: string, col: string) => w.find(`tr[data-row="${row}"] [data-col="${col}"]`).text()
    expect(cell('assigned', 'latest-signin-first-tagged')).toBe('8')
    expect(cell('assigned', 'range-signin-first-tagged')).toBe('40')
    expect(cell('signin-signed-in', 'range-signin-first-tagged')).toBe('10')
    expect(cell('response-rows', 'latest-signin-first-tagged')).toBe('5') // 2 + 2 signed in, 1 installed
    expect(cell('response-rows', 'range-signin-first-tagged')).toBe('20')
    expect(cell('signed-in-per-assigned', 'range-signin-first-tagged')).toBe('0.40') // (10 + 6) / 40
    expect(cell('installed-per-assigned', 'range-signin-first-tagged')).toBe('0.10')
    expect(cell('response-rows-per-assigned', 'latest-signin-first-tagged')).toBe('0.63')
    expect(cell('responded-signin', 'range-signin-first-tagged')).toBe('0')
    expect(cell('responded-per-assigned', 'range-signin-first-tagged')).toBe('0.00')
    // No assigned rows: a dash, never Infinity or NaN.
    expect(cell('signed-in-per-assigned', 'latest-signin-first-organic')).toBe('—')
    expect(cell('returned-per-assigned', 'latest-install-first-organic')).toBe('—')
    expect(cell('assigned', 'latest-install-first-organic')).toBe('0')
    expect(w.findAll('tr[data-row] .fh-name').map((c) => c.text())).toContain('Returned rows per assigned row (group rows only)')
  })

  it('captions the row ratios, the approximate tagged column, the group-only returns and the per-device gap', async () => {
    const w = await mountAsk(askModel(true))
    const cap = w.find('[data-testid="ask-order-caption"]').text()
    expect(cap).toBe(ASK_ORDER_CAPTION)
    expect(cap).toContain('row ratio')
    expect(cap).toContain('a device that both signs in and installs')
    expect(cap).toContain('once-per-device responded row')
    expect(cap).toContain('for display only')
    expect(cap).toContain('sign-ins decide')
    expect(cap).toContain('1.5x')
    expect(cap).toContain('never from the ordinary return rows')
    expect(cap).toContain('per-event counts')
    expect(cap).toContain('approximate')
    expect(cap).toContain('organic plus tagged')
  })
})
