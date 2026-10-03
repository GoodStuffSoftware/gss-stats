// @vitest-environment happy-dom
//
// PARITY (ADR 0003 slice 5): the presets `campaign-scorecard` and `bsk-kpis`, rendered through
// MetricCard over POST /api/metrics against the node:sqlite fixture, show the same numbers as the
// bespoke Overview body they replaced (OverviewWidgetBody.vue, views 'scorecard' and 'kpis').
// Phase B retired that body and its /api/overview sections, so its output is a golden fixture
// (__fixtures__/bespokeOverview.golden.json), captured by mounting the real body over the real
// /api/overview handler on this same fixture at FIXTURE_NOW, the commit before they were removed.
//
// Every visible difference is listed here and asserted as itself, so none can appear silently:
//
//   D1  Install rate (retest pill): the registry's denominator counts prompts from the install
//       fix row-exactly; /api/overview buckets by hour and misses the 5 in the fix's own hour.
//       Old "too few to report (2/4)", new "22.2% (2/9)".
//   D3  Return rate (d2-7) for the closed Android flight, which ended before the return beacon
//       existed: old shows a rate, the registry says unmeasured, and a closed card omits it.
//   D4  The spend-only Play-direct card: old shows zeros and a dash; every beacon value is
//       unmeasured (spend-only), so the closed card shrinks to its flight row.
//   D5  Closed Android "Installs" row: its flight never saw the installed outcome. The old
//       body omitted the Install pill but still showed the row's count; the card omits both.
//   S1  (slice-1 fix) "Game-screen views" is a pair: "100 views · 50 arrivals", never a rate.
//       The old pill showed the count alone.
//   N2  The old tiles' one-line notes under the label (the install-fix gap on "Installs",
//       "can double-count" on "Raw install signals") are in the card's Notes instead, as
//       "<label>: <caveat>" (owner ruling: no visible caveat lines).
//   N1  Caveats (arrivals floor, install fix, counted-from, still arriving, raw-install dedupe,
//       the returns definition) are new text, but only behind each card's one collapsed
//       "Notes" toggle, as "<label>: <caveat>" — no caption line is visible until it is opened.
//
// Not differences: a rate tile shows its rate big and "(n/d)" as a small line under it, as the
// old tile did; "Updated just now" and the reload control sit top-right above the tiles.
//
// D2 (an active flight's unseen step stays live) does not show here: the fixture's active
// flight has seen every step. The KPI arrivals tile already uses campaign attribution on both
// paths (slice 1), so it matches outright.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import MetricCard from './MetricCard.vue'
import { __resetMetricsStateForTests } from '../../composables/useMetrics'
import { onRequestPost as metricsPost } from '../../../functions/api/metrics'
import { insertHits, installCaches, memoryCache, openHitsDb, pagesContext, postJson, sqliteD1 } from '../../../functions/_lib/testing/hitsDb'
import { bskFixture, FIXTURE_NOW } from '../../../functions/_lib/testing/bskFixture'
import { scopeCampaignsToGolden } from '../../../functions/_lib/testing/goldenCampaigns'
import { CAMPAIGNS } from '../../lib/campaigns'
import GOLDEN from './__fixtures__/bespokeOverview.golden.json'

const ANDROID = CAMPAIGNS.find((c) => c.id === '24215315197')!.label
const PLAY = CAMPAIGNS.find((c) => c.id === '24234347705')!.label
const RETEST = CAMPAIGNS.find((c) => c.id === '24279250691')!.label

let db: ReturnType<typeof openHitsDb>
let undoCaches: () => void
// The golden holds the three campaigns configured when it was recorded; see goldenCampaigns.ts.
let restoreCampaigns: () => void
const mounted: VueWrapper[] = []

async function route(url: string, init: RequestInit): Promise<Response> {
  const path = new URL(url, 'https://stats.goodstuff.software').pathname
  const handler = path === '/api/metrics' ? metricsPost : null
  if (!handler) throw new Error(`unexpected fetch ${path}`)
  const waited: Promise<unknown>[] = []
  const res = await handler(pagesContext(postJson(path, JSON.parse(String(init.body))), { gss_geo: sqliteD1(db) } as never, waited) as never)
  await Promise.all(waited)
  return res
}

beforeAll(() => {
  restoreCampaigns = scopeCampaignsToGolden()
  db = openHitsDb()
  insertHits(db, bskFixture())
  vi.useFakeTimers({ now: FIXTURE_NOW, toFake: ['Date'] })
  undoCaches = installCaches(memoryCache())
  vi.stubGlobal('fetch', vi.fn(route))
})
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount()
  __resetMetricsStateForTests()
})
afterAll(() => {
  restoreCampaigns()
  undoCaches()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function settle() {
  for (let i = 0; i < 6; i++) {
    await flushPromises()
    await new Promise((r) => setTimeout(r, 15))
  }
}
async function mountNew(preset: string) {
  const w = mount(MetricCard, { props: { cardRef: { preset }, nowMs: FIXTURE_NOW } })
  mounted.push(w)
  await settle()
  return w
}

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()
/** Visible text of an element, without the collapsed notes toggle's "i". */
function text(el: Element | undefined): string {
  if (!el) return ''
  const clone = el.cloneNode(true) as Element
  clone.querySelectorAll('button').forEach((b) => b.remove())
  return norm(clone.textContent)
}
const pillKey = (pill: string) => pill.slice(0, pill.indexOf(':'))
const pillValue = (pill: string) => pill.slice(pill.indexOf(':') + 1).trim()

interface Card {
  badge: string
  rows: Map<string, string>
  pills: Map<string, string>
}
/** The retired bespoke scorecard, as captured (see the header). */
function oldScorecard(): Map<string, Card> {
  return new Map(GOLDEN.scorecard.map((c) => [c.title, { badge: c.badge, rows: new Map(c.rows as [string, string][]), pills: new Map(c.pills as [string, string][]) }]))
}
function newScorecard(w: VueWrapper): Map<string, Card> {
  return new Map(
    w.findAll('.metric-card').map((c) => [
      text(c.find('.mc-title').element),
      {
        badge: text(c.find('.mc-badge').element),
        rows: new Map(c.findAll('.mi-row').map((r) => [text(r.find('.mi-label').element), text(r.find('.mi-value').element)])),
        pills: new Map(c.findAll('.mi-pill').map((p) => [pillKey(text(p.element)), pillValue(text(p.element))])),
      },
    ]),
  )
}

/** Where the new card may differ from the old body: [campaign, 'row' | 'pill', label] → the
 * old text, the new text (undefined = omitted), and which documented difference it is. */
const SCORECARD_DIFFS: [campaign: string, kind: 'row' | 'pill', label: string, oldText: string, newText: string | undefined, why: string][] = [
  [ANDROID, 'row', 'Return rate (d2-7)', '10.0% (2/20)', undefined, 'D3'],
  [ANDROID, 'row', 'Installs', '1', undefined, 'D5'],
  [ANDROID, 'pill', 'Game-screen views', '100', '100 views · 50 arrivals', 'S1'],
  [PLAY, 'row', 'Tagged arrivals', '0', undefined, 'D4'],
  [PLAY, 'row', 'Auth successes', '0', undefined, 'D4'],
  [PLAY, 'row', 'Installs', '0', undefined, 'D4'],
  [PLAY, 'row', 'Return rate (d2-7)', '— (0/0)', undefined, 'D4'],
  [PLAY, 'row', 'Cost / arrival', '—', undefined, 'D4'],
  [RETEST, 'pill', 'Game-screen views', '21', '21 views · 7 arrivals', 'S1'],
  [RETEST, 'pill', 'Install', 'too few to report (2/4)', '22.2% (2/9)', 'D1'],
]

describe('campaign-scorecard ≡ the bespoke Overview scorecard', () => {
  it('same cards, titles, badges, rows and pills, except the documented differences', async () => {
    const before = oldScorecard()
    const after = newScorecard(await mountNew('campaign-scorecard'))
    expect([...after.keys()]).toEqual([...before.keys()])
    expect([...before.keys()]).toEqual([ANDROID, PLAY, RETEST])

    const used = new Set<number>()
    for (const [title, o] of before) {
      const n = after.get(title)!
      expect(n.badge, `${title} badge`).toBe(o.badge)
      for (const kind of ['row', 'pill'] as const) {
        const oldMap = kind === 'row' ? o.rows : o.pills
        const newMap = kind === 'row' ? n.rows : n.pills
        // Nothing new appears: every new row or pill has an old counterpart.
        for (const label of newMap.keys()) expect(oldMap.has(label), `${title} ${kind} "${label}" is new`).toBe(true)
        for (const [label, oldText] of oldMap) {
          const i = SCORECARD_DIFFS.findIndex(([c, k, l]) => c === title && k === kind && l === label)
          if (i < 0) {
            expect(newMap.get(label), `${title} ${kind} "${label}"`).toBe(oldText)
            continue
          }
          used.add(i)
          const [, , , expectOld, expectNew, why] = SCORECARD_DIFFS[i]
          expect(oldText, `${why}: old ${title} ${kind} "${label}"`).toBe(expectOld)
          expect(newMap.get(label), `${why}: new ${title} ${kind} "${label}"`).toBe(expectNew)
        }
      }
    }
    expect([...used].sort((a, b) => a - b), 'every documented difference still occurs').toEqual(SCORECARD_DIFFS.map((_, i) => i))
  })

  it('S1: the game-screen views pair reads against the card\'s own tagged-arrivals row', async () => {
    const after = newScorecard(await mountNew('campaign-scorecard'))
    for (const title of [ANDROID, RETEST]) {
      const c = after.get(title)!
      expect(c.pills.get('Game-screen views')).toBe(`${Number(c.pills.get('Game-screen views')!.split(' ')[0])} views · ${c.rows.get('Tagged arrivals')} arrivals`)
    }
  })

  it('D4: a card with every pill omitted drops the pill section entirely', async () => {
    const w = await mountNew('campaign-scorecard')
    const play = w.findAll('.metric-card').find((c) => c.find('.mc-title').text() === PLAY)!
    expect(play.findAll('.metric-section')).toHaveLength(1)
  })
})

describe('bsk-kpis ≡ the bespoke "Today at a glance" tiles', () => {
  interface Tile {
    label: string
    value: string
    deltas: string[]
  }
  /** The retired bespoke tiles, as captured (a rate and its (n/d) joined, as below). */
  const oldTiles = (): Tile[] => GOLDEN.kpis.map((k) => ({ label: k.label, value: k.value, deltas: k.deltas }))
  const newTiles = (w: VueWrapper): Tile[] =>
    w.findAll('.mi-tile, .mp-tile').map((t) => ({
      label: text((t.find('.mi-tile-label').exists() ? t.find('.mi-tile-label') : t.find('.mp-tile-label')).element),
      value: norm(`${text((t.find('.mi-tile-num').exists() ? t.find('.mi-tile-num') : t.find('.mp-tile-text')).element)} ${t.find('.mi-tile-sub').exists() ? text(t.find('.mi-tile-sub').element) : ''}`),
      deltas: t.findAll('.mi-tile-delta').map((d) => text(d.element)),
    }))

  // Tiles added after the bespoke panel was retired — no golden equivalent exists for these, so
  // they are excluded from the strict before/after comparison below (which is a parity check
  // against the retired code, not a frozen list of every tile bsk-kpis may ever show). Each one
  // gets its own coverage elsewhere (see the auth-error/auth-redirect test below; the five v1.97.0 tutorial/tour-exit tiles are
  // rendered in both states by the 'v1.97.0 tutorial + tour-exit tiles' test).
  const ADDED_AFTER_RETIREMENT = new Set([
    'Sign-in failures',
    'Sign-in redirect fallbacks',
    'Auth successes — new',
    'Auth successes — existing',
    'Auth successes — unknown',
    'Tutorial completed — first run',
    'Tutorial completed — replay',
    'Tour exits — preamble',
    'Tour exits — hub',
    'Tour exits — section',
  ])

  it('same tiles in the same order, same values and the same delta lines ("new today" included)', async () => {
    const before = oldTiles()
    const after = newTiles(await mountNew('bsk-kpis')).filter((t) => !ADDED_AFTER_RETIREMENT.has(t.label))
    expect(after.map((t) => t.label)).toEqual(before.map((t) => t.label))
    expect(after.map((t) => t.value)).toEqual(before.map((t) => t.value))
    expect(after.map((t) => t.deltas)).toEqual(before.map((t) => t.deltas))
    // The fixture exercises both delta states and a rate tile.
    expect(before.filter((t) => t.deltas[0] === 'new today').length).toBeGreaterThanOrEqual(5)
    expect(before.filter((t) => t.deltas[0]?.startsWith('vs yesterday')).length).toBeGreaterThanOrEqual(3)
    expect(after.find((t) => t.label === 'Pop-up tap rate')!.value).toMatch(/^\d+\.\d% \(\d+\/\d+\)$/)
  })

  it('the freshness line and reload control stay: "Updated just now" and ↻, as before', async () => {
    const neu = await mountNew('bsk-kpis')
    expect(text(neu.find('.mc-updated').element)).toBe(GOLDEN.updated)
    expect(neu.find('button.mc-reload').exists()).toBe(true)
  })

  it('auth-error / auth-redirect tiles: present, next to Auth successes, reading an explicit zero (not blank/hidden) — the fixture has no rows for either yet', async () => {
    const after = newTiles(await mountNew('bsk-kpis'))
    const labels = after.map((t) => t.label)
    const authIdx = labels.indexOf('Auth successes')
    expect(authIdx).toBeGreaterThanOrEqual(0)
    expect(labels[authIdx + 1]).toBe('Auth successes — new')
    expect(labels[authIdx + 2]).toBe('Auth successes — existing')
    expect(labels[authIdx + 3]).toBe('Auth successes — unknown')
    expect(labels[authIdx + 4]).toBe('Sign-in failures')
    expect(labels[authIdx + 5]).toBe('Sign-in redirect fallbacks')
    const errors = after.find((t) => t.label === 'Sign-in failures')!
    const redirects = after.find((t) => t.label === 'Sign-in redirect fallbacks')!
    // A real, visible "0" — go-live (2026-09-22) predates the fixture's "today", so this reads
    // as a measured zero, not the muted "not yet tracking" gated text a pre-go-live window
    // would show (lib/metrics/render.ts applyUnmeasuredGating).
    expect(errors.value).toBe('0')
    expect(redirects.value).toBe('0')
  })

  it('auth-success new/existing/unknown tiles: present, next to Auth successes, reading real counts including an explicit zero (A2, review round 2026-09-27)', async () => {
    const after = newTiles(await mountNew('bsk-kpis'))
    const byLabel = new Map(after.map((t) => [t.label, t]))
    // FIXTURE_NOW (2026-09-26T21:00:00Z) is inside the go-live day but AFTER go-live
    // (19:43:02Z), so "today so far" is a PARTIAL window: a real count, not a false zero and
    // not the muted "not yet tracking" a window entirely before go-live would show.
    expect(byLabel.get('Auth successes — new')!.value).toBe('0') // explicit zero, never blank
    expect(byLabel.get('Auth successes — existing')!.value).toBe('4') // a real, nonzero count
    expect(byLabel.get('Auth successes — unknown')!.value).toBe('0') // explicit zero, never blank
    // Existing + new + unknown (4+0+0=4) is at most the base Auth successes count (6) — the
    // base metric predates the split and counts sign-ins with no status row too.
    expect(Number(byLabel.get('Auth successes')!.value)).toBeGreaterThanOrEqual(4)
  })

  const TOUR_TILES = [
    'Tutorial completed — first run',
    'Tutorial completed — replay',
    'Tour exits — preamble',
    'Tour exits — hub',
    'Tour exits — section',
  ]

  it('v1.97.0 tutorial + tour-exit tiles: all five render; muted before go-live, real counts after (counts only, no splits)', async () => {
    // Before go-live (FIXTURE_NOW is 2026-09-26): no rows can exist, so the tiles read as
    // not-yet-tracking, never a false zero.
    const before = newTiles(await mountNew('bsk-kpis'))
    for (const label of TOUR_TILES) {
      const t = before.find((x) => x.label === label)
      expect(t, label).toBeTruthy()
      expect(t!.value, `${label} before go-live`).not.toBe('0')
      expect(t!.value, `${label} before go-live`).not.toMatch(/^\d/)
    }
    // After go-live, with rows on both sides of the first-run/replay and preamble/hub/section split.
    const liveMs = Date.parse('2026-10-03T20:00:00Z')
    const rows = (path: string, n: number) => ({ site: 'bestsudoku-web', ts: Date.parse('2026-10-03T18:00:00Z'), path, visitor: 'returning', n })
    insertHits(db, [
      rows('/game/tutorial-complete/first-run', 4),
      rows('/game/tutorial-complete/replay', 2),
      rows('/tour/exit-at/preamble', 3),
      rows('/tour/exit-at/hub', 1),
    ])
    try {
      vi.setSystemTime(liveMs)
      const w = mount(MetricCard, { props: { cardRef: { preset: 'bsk-kpis' }, nowMs: liveMs } })
      mounted.push(w)
      await settle()
      const byLabel = new Map(newTiles(w).map((t) => [t.label, t]))
      expect(byLabel.get('Tutorial completed — first run')!.value).toBe('4')
      expect(byLabel.get('Tutorial completed — replay')!.value).toBe('2')
      expect(byLabel.get('Tour exits — preamble')!.value).toBe('3')
      expect(byLabel.get('Tour exits — hub')!.value).toBe('1')
      expect(byLabel.get('Tour exits — section')!.value).toBe('0') // a measured zero, not blank
    } finally {
      vi.setSystemTime(FIXTURE_NOW)
      db.exec("DELETE FROM hits WHERE path LIKE '/game/tutorial-complete/%' OR path LIKE '/tour/exit-at/%'")
    }
  })

  it('no-campaign days: the arrivals placeholder is a tile, as before', async () => {
    const w = mount(MetricCard, { props: { cardRef: { preset: 'bsk-kpis' }, nowMs: Date.parse('2026-09-20T16:00:00Z') } })
    mounted.push(w)
    await settle()
    const placeholder = w.find('.mp-tile')
    expect(text(placeholder.find('.mp-tile-label').element)).toBe('Tagged arrivals')
    expect(text(placeholder.find('.mp-tile-text').element)).toBe('no campaign flighting today')
  })
})

describe('N1: caveats never add a visible line', () => {
  it.each(['campaign-scorecard', 'bsk-kpis'])('%s: every caveat is behind the card\'s one collapsed Notes toggle', async (preset) => {
    const w = await mountNew(preset)
    expect(w.findAll('.mi-caption, .mi-tile-caption, .mi-pill-caption')).toHaveLength(0)
    for (const l of w.findAll('.mc-notes')) expect((l.element as HTMLElement).style.display).toBe('none')
    const toggles = w.findAll('button.mc-notes-toggle')
    expect(toggles.length).toBeGreaterThan(0)
    for (const b of toggles) expect(b.attributes('aria-expanded')).toBe('false')
    await toggles[0].trigger('click')
    const lines = w.findAll('.mc-notes li').map((li) => norm(li.text()))
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).toMatch(/^[^:]+: \S/) // "<label>: <caveat>"
    // No raw beacon path in anything the card can show, notes included.
    expect(w.text()).not.toMatch(/\/(return|install|game|popup-outcome|auth)\//)
    expect(w.emitted('open-campaigns')).toBeUndefined() // the toggle never opens the Campaigns page
  })

  it('N2: every old tile note has a line in the card Notes, under the same label', async () => {
    const oldNotes = GOLDEN.kpis.flatMap((k) => ('note' in k && k.note ? [[k.label, k.note] as const] : []))
    expect(oldNotes.map(([l]) => l)).toEqual(['Installs', 'Raw install signals'])
    const w = await mountNew('bsk-kpis')
    await w.find('button.mc-notes-toggle').trigger('click')
    const lines = w.findAll('.mc-notes li').map((li) => norm(li.text()))
    expect(lines.some((l) => l.startsWith('Installs: install fix went live'))).toBe(true)
    expect(lines.some((l) => l.startsWith('Raw install signals: ') && l.includes('double-count'))).toBe(true)
    expect(lines.some((l) => l.startsWith('Return visits (day 1+): Devices that first arrived'))).toBe(true)
  })
})
