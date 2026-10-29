// Editor tool T4: the card editor's Ask-order A/B readout (the ask-order preset's requests, POST /api/metrics) gives every
// number the old Ask-order card (POST /api/features { view: 'ask-order' }, drawn by the retired FeatureHealthCard.vue)
// gives: per group asks shown toward the call point, the assigned rows, the primary per assigned row and the display-only
// row ratios (all days so far); which primary the rule reads, the rule's basis, multiple and verdict (every verdict, before
// and after the call point); each kind's multiple; and the table of every step for the latest day and the range, by group,
// organic vs tagged; plus whether any ask-order row ever arrived. Both run on one real SQLite (node:sqlite, D1's dialect)
// with made-up rows, decoys (another site, manual checks, own visits) included.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openHitsDb, insertHits, sqliteD1, pagesContext, postJson, type HitRow } from '../_lib/testing/hitsDb'
import { addDays, etWallTimeMs } from '../../src/lib/etTime'
import {
  ASK_ORDER_ASKS, ASK_ORDER_GROUPS, ASK_ORDER_OUTCOMES, ASK_ORDER_TAGS, ASK_ORDER_VIEW, askOrderAssignedPath, askOrderFeatureId, askOrderOutcomePath,
  askOrderRespondedPath, askOrderShownPath, readAskOrder, type AskOrderGroupId, type OutcomeId,
} from '../../src/lib/askOrder'
import { askOrderVerdictCode } from '../../src/lib/metrics/metrics'
import { BEST_SUDOKU_SITES } from '../../src/lib/bestSudokuSites'
import { FACTS } from '../../src/lib/metrics/facts'
import { ASK_ORDER } from '../../src/lib/metrics/presets'

const TODAY = '2026-10-20'
const at = (date: string, hours: number) => etWallTimeMs(date) + hours * 3_600_000
const TAGGED = 'sudoku_tired_of_ads'

/** Per ask, per tag, per day (times a day factor 1-3): signed-in and installed rows for each group. */
type Mix = Record<AskOrderGroupId, { si: number; in: number }>
interface Scenario {
  name: string
  days: number
  /** Once-per-device responded rows too (the primary becomes 'responded'). */
  responded: boolean
  mix: Mix
  /** The verdict code the old read gives (lib/metrics/metrics.ts ASK_ORDER_VERDICTS). */
  verdict: number
  tieBreak?: boolean
}
const SCENARIOS: Scenario[] = [
  { name: 'under the call point (preliminary)', days: 2, responded: false, mix: { 'signin-first': { si: 1, in: 1 }, 'install-first': { si: 2, in: 2 } }, verdict: 0 },
  { name: 'switch: install first by 2x', days: 30, responded: false, mix: { 'signin-first': { si: 1, in: 1 }, 'install-first': { si: 2, in: 2 } }, verdict: 1 },
  { name: 'switch: sign-in first has none', days: 30, responded: true, mix: { 'signin-first': { si: 0, in: 0 }, 'install-first': { si: 1, in: 1 } }, verdict: 2 },
  { name: 'keep: sign-in first already larger', days: 30, responded: true, mix: { 'signin-first': { si: 2, in: 2 }, 'install-first': { si: 1, in: 1 } }, verdict: 3 },
  { name: 'keep: below 1.5x', days: 30, responded: false, mix: { 'signin-first': { si: 4, in: 4 }, 'install-first': { si: 5, in: 5 } }, verdict: 4 },
  { name: 'tie-break: sign-ins decide', days: 30, responded: true, mix: { 'signin-first': { si: 2, in: 1 }, 'install-first': { si: 1, in: 2 } }, verdict: 3, tieBreak: true },
]

function seed(db: DatabaseSync, sc: Scenario): void {
  const rows: (HitRow & { n?: number })[] = []
  for (let k = 0; k < sc.days; k++) {
    if (k % 7 === 5) continue // a gap day
    const day = addDays(TODAY, -k)
    const f = 1 + (k % 3)
    for (const g of ASK_ORDER_GROUPS) {
      const m = sc.mix[g.id]
      for (const t of ASK_ORDER_TAGS) {
        const campaign = t.id === 'tagged' ? { campaign: TAGGED } : {}
        const add = (path: string, n: number, h: number) => {
          if (n > 0) rows.push({ ts: at(day, h), site: (k + h) % 2 ? 'bestsudoku-web' : 'bestsudoku-app', path, ...campaign, n })
        }
        add(askOrderAssignedPath(g.id), 10 * f, 0.5)
        for (const a of ASK_ORDER_ASKS) {
          add(askOrderShownPath(g.id, a.id), 3 * f, 11.5)
          const counts: Record<OutcomeId, number> = { 'signed-in': m.si * f, installed: m.in * f, returned: 2 * f, 'still-playing': 1 * f }
          for (const o of ASK_ORDER_OUTCOMES) add(askOrderOutcomePath(g.id, a.id, o.id), counts[o.id], 12.5)
          if (sc.responded) add(askOrderRespondedPath(g.id, a.id), a.id === 'signin' ? m.si * f : m.in * f, 23.5)
        }
        // Decoys: another site, a manual check and an own visit (dropped by the exclusions and the own-visit toggle).
        rows.push({ ts: at(day, 9), site: 'other-site', path: askOrderAssignedPath(g.id), ...campaign, n: 4 })
        rows.push({ ts: at(day, 13), site: 'bestsudoku-web', path: askOrderShownPath(g.id, 'signin'), campaign: 'manual_check', n: 5 })
        rows.push({ ts: at(day, 10), site: 'bestsudoku-web', path: askOrderShownPath(g.id, 'install'), browser: 'Chrome', os: 'Windows', ...campaign, n: 2 })
      }
    }
  }
  // A near-miss path and an unknown group: never counted.
  rows.push({ ts: at(addDays(TODAY, -1), 8), site: 'bestsudoku-web', path: '/ab/ask-order/signin-first/assignedx', n: 7 })
  rows.push({ ts: at(addDays(TODAY, -1), 8), site: 'bestsudoku-web', path: '/ab/ask-order/other-first/assigned', n: 7 })
  insertHits(db, rows)
}

let db: DatabaseSync
const closeDb = () => { try { db?.close() } catch { /* already closed */ } }
let d1: ReturnType<typeof sqliteD1>
function open(sc?: Scenario) {
  closeDb()
  db = openHitsDb()
  d1 = sqliteD1(db)
  if (sc) seed(db, sc)
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  open(SCENARIOS[1])
  ;(globalThis as any).caches = { default: { match: async () => undefined, put: async () => {} } }
})
afterEach(() => {
  vi.useRealTimers()
  closeDb()
  delete (globalThis as any).caches
})

async function oldModel(body: Record<string, unknown>) {
  const { onRequestPost } = await import('./features')
  const res = await onRequestPost(pagesContext(postJson('/api/features', { ...body, view: ASK_ORDER_VIEW }), { gss_geo: d1 }) as any)
  expect(res.status).toBe(200)
  return (await res.json()) as any
}

// The ask-order preset's requests, by hand (as lib/metrics/scope.ts resolves its repeats): the panels per group
// (feature ao-<group>, all days so far), the rule lines, everSeen, and the table per window x group x tag (feature
// ao-<group>-<tag>) x row.
const COUNT_ROWS = ['assigned', 'shown-signin', 'shown-install', 'signin-signed-in', 'signin-installed', 'signin-returned', 'signin-still-playing', 'install-signed-in', 'install-installed', 'install-returned', 'install-still-playing', 'responded-signin', 'responded-install', 'response']
const RATIO_ROWS = ['signed-in', 'installed', 'response', 'responded', 'returned', 'still-playing']
type Req = { key: string; metric: string; window: string; params: { feature?: string; step?: string } }
function presetRequests(): Req[] {
  const out: Req[] = []
  const add = (metric: string, window: string, params: Req['params'] = {}) => out.push({ key: `k${out.length}`, metric, window, params })
  add('askOrder.everSeen', 'page')
  for (const g of ASK_ORDER_GROUPS) {
    const feature = askOrderFeatureId(g.id)
    for (const step of ['shown', 'assigned']) add('feature.step', 'allTime', { feature, step })
    for (const m of ['askOrder.combinedPerAssigned', 'askOrder.respondedPerAssigned']) add(m, 'allTime', { feature })
    for (const step of RATIO_ROWS) add('feature.stepRatio', 'allTime', { feature, step })
  }
  for (const m of ['primary', 'ruleBasis', 'ruleMultiple', 'verdict', 'signedInMultiple', 'installedMultiple']) add(`askOrder.${m}`, 'allTime')
  for (const w of ['latestDay', 'page']) for (const g of ASK_ORDER_GROUPS) for (const t of ASK_ORDER_TAGS) {
    const feature = `${askOrderFeatureId(g.id)}-${t.id}`
    for (const step of COUNT_ROWS) add('feature.step', w, { feature, step })
    for (const step of RATIO_ROWS) add('feature.stepRatio', w, { feature, step })
  }
  return out
}

async function cardValues(body: Record<string, unknown>) {
  const { onRequestPost } = await import('./metrics')
  const requests = presetRequests()
  const context = { since: body.since, until: body.until, sites: body.sites ?? [], ...(body.excludeOwnVisits ? { excludeOwnVisits: true, ownBrowser: body.ownBrowser, ownOS: body.ownOS } : {}) }
  const waited: Promise<unknown>[] = []
  const before = d1.statements.length
  const res = await onRequestPost(pagesContext(postJson('/api/metrics', { v: 1, context, requests }), { gss_geo: d1 }, waited) as any)
  await Promise.all(waited)
  const json = (await res.json()) as any
  return { status: res.status, error: json.error as string | undefined, requests, results: json.results as Record<string, { status: string; value?: number | null }>, statements: d1.statements.slice(before) }
}

/** What the old card shows for one request, from the old endpoint's answer (its allTime map and per-feature steps). */
function oldValue(old: any, r: Req): { value: number | null; unmeasured?: true } {
  const read = readAskOrder(old.allTime)
  const groupOf = (feature: string) => read.groups.find((g) => askOrderFeatureId(g.group) === feature)!
  switch (r.metric) {
    case 'askOrder.everSeen': return { value: old.everSeen ? 0 : null }
    case 'askOrder.combinedPerAssigned':
    case 'askOrder.respondedPerAssigned': {
      const which = r.metric === 'askOrder.combinedPerAssigned' ? 'combined' : 'responded'
      return read.primary.id === which ? { value: groupOf(r.params.feature!).primaryPerAssigned } : { value: null, unmeasured: true }
    }
    case 'askOrder.primary': return { value: read.primary.id === 'responded' ? 1 : 0 }
    case 'askOrder.ruleBasis': return { value: read.rule.tieBreak ? 1 : 0 }
    case 'askOrder.ruleMultiple': return { value: read.rule.multiple }
    case 'askOrder.verdict': return { value: askOrderVerdictCode(read) }
    case 'askOrder.signedInMultiple': return { value: read.kinds[0].multiple }
    case 'askOrder.installedMultiple': return { value: read.kinds[1].multiple }
  }
  if (r.window === 'allTime') {
    const g = groupOf(r.params.feature!)
    if (r.metric === 'feature.step') return { value: r.params.step === 'shown' ? g.asksShown : g.assigned }
    const perAssigned: Record<string, number | null> = {
      'signed-in': g.perOutcome['signed-in'].perAssigned,
      installed: g.perOutcome.installed.perAssigned,
      response: g.responseRowsPerAssigned,
      responded: g.respondedPerAssigned,
      returned: g.perOutcome.returned.perAssigned,
      'still-playing': g.perOutcome['still-playing'].perAssigned,
    }
    return { value: perAssigned[r.params.step!] }
  }
  // The table: the old card's askCell / askRatio over the old feature's tagged step ids.
  const [, group, tag] = /^ao-(.+)-(organic|tagged)$/.exec(r.params.feature!)!
  const f = old.features.find((x: any) => x.id === askOrderFeatureId(group as AskOrderGroupId))
  const which = r.window === 'latestDay' ? 'latest' : 'range'
  const n = (stepId: string) => Number(f?.steps.find((s: any) => s.id === `${stepId}-${tag}`)?.[which] ?? 0)
  const outcomes = (os: OutcomeId[]) => ASK_ORDER_ASKS.reduce((a, k) => a + os.reduce((b, o) => b + n(`${k.id}-${o}`), 0), 0)
  const sums: Record<string, () => number> = {
    response: () => outcomes(['signed-in', 'installed']),
    'signed-in': () => outcomes(['signed-in']),
    installed: () => outcomes(['installed']),
    returned: () => outcomes(['returned']),
    'still-playing': () => outcomes(['still-playing']),
    responded: () => ASK_ORDER_ASKS.reduce((a, k) => a + n(`responded-${k.id}`), 0),
  }
  if (r.metric === 'feature.step') return { value: r.params.step === 'response' ? sums.response() : n(r.params.step!) }
  const den = n('assigned')
  return { value: den > 0 ? sums[r.params.step!]() / den : null }
}

const NOWS = ['2026-10-20T14:00:00Z', '2026-10-21T03:30:00Z'] // 10:00 and 23:30 ET
const WINDOWS = (now: string) => {
  const today = now.slice(0, 10)
  return [
    { since: addDays(today, -29), until: today },
    { since: addDays(today, -6), until: today },
    { since: `${addDays(today, -3)}T15:30:00Z`, until: now },
    { since: addDays(today, -1), until: addDays(today, -1) },
  ]
}
// The card hides known traffic always (lib/defaults.ts askOrderCardFor maps only a widget that hides it).
const TOGGLES = [
  { excludeKnownTraffic: true },
  { excludeKnownTraffic: true, sites: ['bestsudoku-web'] },
  { excludeKnownTraffic: true, sites: [...BEST_SUDOKU_SITES] },
  { excludeKnownTraffic: true, excludeOwnVisits: true, ownBrowser: 'Chrome', ownOS: 'Windows' },
]

async function compare(body: Record<string, unknown>): Promise<{ n: number; old: any }> {
  const got = await cardValues(body)
  expect(got.status, `${JSON.stringify(body)} ${got.error}`).toBe(200)
  const old = await oldModel(body)
  let n = 0
  for (const r of got.requests) {
    const v = got.results[r.key]
    const label = `${JSON.stringify(body)} ${r.metric} ${r.window} ${r.params.feature ?? ''} ${r.params.step ?? ''}`
    const want = oldValue(old, r)
    if (want.unmeasured) expect(v?.status, label).toBe('unmeasured')
    else expect(v?.status, label).toBe(want.value === null ? 'no-data' : 'ok')
    if (want.value === null) expect(v?.value ?? null, label).toBeNull()
    else expect(v?.value, label).toBeCloseTo(want.value, 10)
    n++
  }
  return { n, old }
}

describe('the ask-order preset (POST /api/metrics) == /api/features { view: ask-order }', () => {
  for (const sc of SCENARIOS) {
    it(`every number of the old card, every window and known-traffic-hidden filter: ${sc.name}`, async () => {
      open(sc)
      let compared = 0
      for (const now of NOWS) {
        vi.setSystemTime(new Date(now))
        for (const w of WINDOWS(now)) for (const t of TOGGLES) {
          const { n, old } = await compare({ ...w, ...t })
          compared += n
          const read = readAskOrder(old.allTime)
          expect(askOrderVerdictCode(read), sc.name).toBe(sc.verdict)
          expect(read.rule.tieBreak, sc.name).toBe(sc.tieBreak === true)
          expect(read.primary.id, sc.name).toBe(sc.responded ? 'responded' : 'combined')
        }
      }
      expect(compared).toBe(NOWS.length * WINDOWS(NOWS[0]).length * TOGGLES.length * presetRequests().length)
    }, 120_000)
  }

  it('everSeen false: no ask-order row ever, or only manual checks (the old "no ask-order data yet" note)', async () => {
    vi.setSystemTime(new Date(NOWS[0]))
    const body = { since: addDays(TODAY, -29), until: TODAY, excludeKnownTraffic: true }
    open()
    expect((await oldModel(body)).everSeen).toBe(false)
    await compare(body)
    open()
    insertHits(db, [{ ts: at(addDays(TODAY, -3), 13), site: 'bestsudoku-web', path: askOrderAssignedPath('signin-first'), campaign: 'manual_check' }])
    expect((await oldModel(body)).everSeen).toBe(false)
    const got = await cardValues(body)
    expect(got.results.k0.status).toBe('no-data')
    await compare(body)
  })

  it('a group with no rows in the window reads 0 in the table (the old askCell), and no ratio', async () => {
    vi.setSystemTime(new Date(NOWS[0]))
    const body = { since: addDays(TODAY, -29), until: TODAY, excludeKnownTraffic: true }
    open()
    insertHits(db, [{ ts: at(addDays(TODAY, -40), 9), site: 'bestsudoku-web', path: askOrderAssignedPath('signin-first') }])
    const got = await cardValues(body)
    const assigned = got.requests.find((r) => r.window === 'page' && r.params.feature === 'ao-install-first-tagged' && r.params.step === 'assigned')!
    expect(got.results[assigned.key]).toMatchObject({ status: 'ok', value: 0 })
    await compare(body)
  })

  it('load: the whole card is ONE POST of at most 200 requests and three statements (the window days, the all-time totals, the ever count)', async () => {
    vi.setSystemTime(new Date(NOWS[0]))
    expect(presetRequests().length).toBeLessThanOrEqual(200)
    const got = await cardValues({ since: addDays(TODAY, -29), until: TODAY, excludeKnownTraffic: true })
    expect(got.statements).toHaveLength(3)
  })
})

describe('counts only', () => {
  it('the preset reads only feature.* counts and ratios and askOrder.* reads', () => {
    const metrics = ASK_ORDER.sections.flatMap((s) => s.items).map((i) => (i.data as any).metric).filter(Boolean)
    expect([...new Set(metrics)].every((m) => /^(feature\.(step|stepRatio)|askOrder\.\w+)$/.test(m))).toBe(true)
  })

  it('the all-time read: COUNT(*) per path and campaign tag only; no day, visitor, hour, place or device column, no JOIN', () => {
    const fact = (FACTS as any).featureAllTime
    expect(fact).toBeDefined()
    const { sql } = fact.build({ since: addDays(TODAY, -6), until: TODAY, sites: [], todayEt: TODAY, set: 'ask-order' }, Date.now())
    expect(sql).toMatch(/COUNT\(\*\)/)
    expect(sql).not.toMatch(/\bJOIN\b/i)
    const select = sql.slice(0, sql.indexOf(' FROM hits '))
    for (const col of ['visitor', 'country', 'region', 'city', 'device', 'browser', 'os', 'colo', 'lat', 'lon', 'postal', 'timezone', 'hour']) {
      expect(select).not.toMatch(new RegExp(`\\b${col}\\b`))
    }
  })
})
