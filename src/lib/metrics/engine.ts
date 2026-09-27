// The POST /api/metrics engine (ADR 0003 section 3): plan a validated batch into a small set of
// distinct facts, then derive every requested metric and ratio from those facts' rows in JS.
// Pure: functions/_lib/metricFacts.ts runs and caches the planned statements, and
// functions/api/metrics.ts wires the three together. Nothing here sees SQL text from a client —
// a request names registry ids; the plan names FactIds and validated params.
//
// Derivation reuses the existing primitives: gateRate/MIN_COHORT (lib/popupEvents.ts) for every
// proportion and cost, computeDelta/sameTimeWindowMs/last7DatesBefore (lib/overview.ts) for the
// "today so far" comparisons, rowIsPostInstallFix for the install-fix split,
// campaignAttributionClause's rule for campaign rows inside a site-wide fact.
//
// COST (Workers Free: 10 ms CPU per request). Work is per batch, never per request × row:
//   1. resolve: every request side (metric + params + window + alignment) becomes one SidePlan,
//      memoized, so 200 requests naming five metrics resolve five sides;
//   2. index: each fact arrives already aggregated by SQL into groups of (path, visitor, campaign
//      tag, ET day, install-fix split, time segment) — the segment is the bucket's position
//      against the few instants any side filters on (factCuts: go-lives, attribution starts, the
//      fix), so a fact's size does not grow with traffic, and every side filter is an integer
//      comparison on a group, never a date comparison on a row; the index is built once per batch;
//   3. evaluate: each distinct side classifies each distinct path once and sums its groups;
//   4. assemble: identical requests share one result.
// ET date arithmetic (day windows, serving ends, delta gates, the page range) is done once per
// batch or memoized.

import { CAMPAIGNS, campaignAttributionClause, campaignAttributionStartMs, campaignById, type CampaignAttribution, type CampaignFlight } from '../campaigns'

import { gateRate, INSTALL_GAP_PATHS, POPUPS, rowIsPostInstallFix } from '../popupEvents'
import { computeDelta } from '../overview'
import { FACTS, factKey, rangeMs, type BeaconRow, type FactId, type FactParams, type FactRows, type FactStatement } from './facts'
import { METRICS, rulesOf, type MetricCtx, type MetricDef } from './metrics'
import { RATIOS, type RatioDef } from './ratios'
import { deltasAllowed, etMidnightMs, isProvisional, laterEtDate, measuredInterval, seenInFlightRequired, servingEndMs, type InstrumentationRule, type MeasuredInterval } from './instrumentation'
import type { MetricDelta, MetricValue, WindowName } from './types'
import type { RequestCheck, ResolvedRequest, ValidContext } from './validate'

// ── Planning ─────────────────────────────────────────────────────────────────────────────
export interface PlannedFact {
  /** Stable identity: the fact id plus only the params it keys on (lib/metrics/facts.ts factKey). */
  key: string
  id: FactId
  params: FactParams
  /** Statements this fact costs (0 for an optional store that is not bound). */
  statements: number
}
export interface Plan {
  facts: PlannedFact[]
  statements: number
}
export interface BatchEnv {
  context: ValidContext
  nowMs: number
  /** ET calendar date of nowMs (the KPI fact's anchor). */
  todayEt: string
  /** Whether the gss_stats_ads binding exists (adsSpend costs nothing without it). */
  hasAdsDb: boolean
}

export function factKeyString(id: FactId, p: FactParams): string {
  return JSON.stringify(factKey(id, p))
}

/** The fact params one side of a request reads, from its window and the batch context. */
function factParamsFor(factId: FactId, req: Pick<ResolvedRequest, 'params'>, env: BatchEnv): FactParams {
  switch (factId) {
    case 'campaignPathVisitor':
    case 'campaignReturns':
    case 'flightPathsSeen':
      return { campaignId: req.params.campaignId }
    case 'bskKpiDays':
      return { todayEt: env.todayEt }
    case 'bskRangePath':
      return { since: env.context.since, until: env.context.until }
    case 'popupRangePath':
      return { since: env.context.since, until: env.context.until, sites: env.context.sites }
    case 'adsSpend':
      return {}
  }
}

// A campaign's attribution is a pure function of its config, and computing its lower bound
// formats ET dates through Intl, so it is built once per campaign object. The index applies
// campaignAttributionClause's rule (its JS twin `matches`: tag in ucValues AND row start at/after
// campaignAttributionStartMs) as a tag set plus a time threshold; the KPI arrivals tile's
// equivalence with /api/overview (functions/api/metrics.equivalence.test.ts) checks they agree.
interface Attribution {
  clause: CampaignAttribution
  tags: ReadonlySet<string>
  startMs: number | null
}
const attributionMemo = new WeakMap<CampaignFlight, Attribution>()
function attributionOf(campaign: CampaignFlight): Attribution {
  let v = attributionMemo.get(campaign)
  if (!v) attributionMemo.set(campaign, (v = { clause: campaignAttributionClause(campaign), tags: new Set(campaign.ucValues), startMs: campaignAttributionStartMs(campaign) }))
  return v
}

function metricCtx(def: MetricDef, req: Pick<ResolvedRequest, 'params' | 'window'>): MetricCtx {
  const campaign = def.params.includes('campaignId') && req.params.campaignId ? campaignById(req.params.campaignId) : undefined
  return { params: req.params, campaign, attribution: campaign ? attributionOf(campaign).clause : undefined, window: req.window }
}

type Static = MeasuredInterval & { needsSeen: boolean }

/** The measured interval from config alone (optimistic about seenInFlightWindow), plus whether
 * the flightPathsSeen evidence is needed. */
function sideStatic(def: MetricDef, ctx: MetricCtx, window: readonly [number, number]): Static {
  const factId = def.windows[ctx.window]!
  if (ctx.campaign && ctx.campaign.flightStart === null && factId !== 'adsSpend') {
    return { status: 'unmeasured', from: Infinity, reason: 'flight-pending', noteIds: ['flight-pending'], goLiveEt: null, needsSeen: false }
  }
  const rules = rulesOf(def, ctx)
  const m = measuredInterval({ rules, window, campaign: ctx.campaign, seenInFlight: true })
  const needsSeen = m.status !== 'unmeasured' && rules.some((r) => r.kind === 'seenInFlightWindow') && seenInFlightRequired(ctx.campaign) && !!ctx.campaign?.flightStart
  return { ...m, needsSeen }
}

/** Per-batch date maths: the page range and today's midnight, computed once. */
interface Clock {
  todayStartMs: number
  pageRange: [number, number] | null
}
function clockOf(env: BatchEnv): Clock {
  return {
    todayStartMs: etMidnightMs(env.todayEt),
    pageRange: env.context.since !== undefined && env.context.until !== undefined ? rangeMs(env.context.since, env.context.until) : null,
  }
}

/** W = [a, b) for a request window. `endMs` is "now" (the KPI fact's own as-of instant for
 * today-so-far, so every window of one fact shares one clock). */
function windowOf(ctx: MetricCtx, clock: Clock, endMs: number): [number, number] {
  switch (ctx.window) {
    case 'attribution':
      return [ctx.campaign ? (attributionOf(ctx.campaign).startMs ?? endMs) : endMs, endMs]
    case 'todaySoFar':
      return [clock.todayStartMs, endMs]
    case 'page':
      return clock.pageRange!
  }
}

/** A request side's context and config-only interval, shared by planBatch and deriveBatch
 * within one request (pass the same memo to both), so each side is resolved once. */
export type SideMemo = Map<string, { ctx: MetricCtx; stat: Static }>
export function newSideMemo(): SideMemo {
  return new Map()
}
function resolveStatic(memo: SideMemo, def: MetricDef, req: Pick<ResolvedRequest, 'params' | 'window'>, clock: Clock, endMs: number): { ctx: MetricCtx; stat: Static } {
  const key = `${def.id}|${req.params.campaignId ?? ''}|${req.params.popup ?? ''}|${req.window}|${endMs}`
  let v = memo.get(key)
  if (!v) {
    const ctx = metricCtx(def, req)
    memo.set(key, (v = { ctx, stat: sideStatic(def, ctx, windowOf(ctx, clock, endMs)) }))
  }
  return v
}

function sidesOf(req: ResolvedRequest): MetricDef[] {
  if (req.kind === 'metric') return [METRICS.get(req.id)!]
  const r = RATIOS.get(req.id)!
  return [METRICS.get(r.num)!, METRICS.get(r.den)!]
}

/** Groups every valid request into distinct facts (deduplicated by fact key), adding the
 * flightPathsSeen fact wherever a closed flight's instrumentation depends on it. A side that is
 * unmeasured from config alone (a spend-only campaign, a beacon not live, a pending flight)
 * plans no fact at all. */
export function planBatch(requests: readonly ResolvedRequest[], env: BatchEnv, memo: SideMemo = newSideMemo()): Plan {
  const clock = clockOf(env)
  const facts = new Map<string, PlannedFact>()
  const seenSides = new Set<string>()
  const add = (id: FactId, p: FactParams) => {
    const key = factKeyString(id, p)
    if (!facts.has(key)) facts.set(key, { key, id, params: factKey(id, p).params as FactParams, statements: id === 'adsSpend' && !env.hasAdsDb ? 0 : 1 })
  }
  for (const req of requests) {
    for (const def of sidesOf(req)) {
      const sideKey = `${def.id}|${req.params.campaignId ?? ''}|${req.params.popup ?? ''}|${req.window}`
      if (seenSides.has(sideKey)) continue
      seenSides.add(sideKey)
      const { ctx, stat: side } = resolveStatic(memo, def, req, clock, env.nowMs)
      if (side.status === 'unmeasured') continue
      const factId = def.windows[req.window]!
      add(factId, factParamsFor(factId, req, env))
      if (side.needsSeen) add('flightPathsSeen', { campaignId: ctx.campaign!.id })
    }
  }
  const list = [...facts.values()]
  return { facts: list, statements: list.reduce((a, f) => a + f.statements, 0) }
}

// ── Derivation ───────────────────────────────────────────────────────────────────────────
/** A fetched fact: its rows and the instant they were read (a cached entry keeps its own). */
export type FactResult = { ok: true; rows: FactRows; asOfMs: number } | { ok: false; error: string }

interface DeriveEnv extends BatchEnv {
  facts: ReadonlyMap<string, FactResult>
}

/** One fact's rows, indexed once per batch. The SQL already aggregated them (lib/metrics/facts.ts:
 * one row per path, visitor, campaign tag, KPI day, segment and install-fix split), so each row is
 * one group; the index only adds per-path lookups. Parallel arrays, one entry per group. */
interface FactIndex {
  paths: string[]
  /** Groups per distinct path (indices into the g* arrays). */
  byPath: number[][]
  /** Sum of counts per distinct path (the seenInFlightWindow evidence). */
  pathTotal: Float64Array
  campaigns: string[]
  gVisitorNew: Uint8Array
  gCampaign: Int32Array
  gDay: Int8Array
  gPf: Int8Array // 1 at/after the fact's split, 0 before, -1 unknown
  gSeg: Int32Array
  gCount: Float64Array
  /** The fact's sorted cuts (factCuts): a group's seg = how many of them its bucket start reached. */
  cuts: readonly number[]
}

/** A pre-fix install-gap row the fact could not drop in SQL (only popupRangePath, whose query is
 * /api/popups' own and keeps them; aggregatePopupRows drops them the same way, by its `pf`). */
function isUnmeasuredGapRow(r: BeaconRow): boolean {
  return (INSTALL_GAP_PATHS as readonly string[]).includes(r.path) && !rowIsPostInstallFix({ hourStartMs: 0, path: r.path, count: r.c, postInstallFix: r.pf ?? false })
}

function buildIndex(rows: readonly BeaconRow[], cuts: readonly number[], dropGap: boolean): FactIndex {
  const n = rows.length
  const pathIds = new Map<string, number>()
  const campIds = new Map<string, number>()
  const paths: string[] = []
  const campaigns: string[] = []
  const gPath = new Int32Array(n)
  const gVisitorNew = new Uint8Array(n)
  const gCampaign = new Int32Array(n)
  const gDay = new Int8Array(n)
  const gPf = new Int8Array(n)
  const gSeg = new Int32Array(n)
  const gCount = new Float64Array(n)
  let g = 0
  for (let i = 0; i < n; i++) {
    const r = rows[i]
    if (dropGap && isUnmeasuredGapRow(r)) continue
    let p = pathIds.get(r.path)
    if (p === undefined) {
      pathIds.set(r.path, (p = paths.length))
      paths.push(r.path)
    }
    let c = campIds.get(r.campaign)
    if (c === undefined) {
      campIds.set(r.campaign, (c = campaigns.length))
      campaigns.push(r.campaign)
    }
    gPath[g] = p
    gVisitorNew[g] = r.visitor === 'new' ? 1 : 0
    gCampaign[g] = c
    gDay[g] = r.day
    gPf[g] = r.pf === null ? -1 : r.pf ? 1 : 0
    gSeg[g] = r.seg
    gCount[g] = r.c
    g++
  }
  const byPath: number[][] = paths.map(() => [])
  const pathTotal = new Float64Array(paths.length)
  for (let k = 0; k < g; k++) {
    byPath[gPath[k]].push(k)
    pathTotal[gPath[k]] += gCount[k]
  }
  return { paths, byPath, pathTotal, campaigns, gVisitorNew, gCampaign, gDay, gPf, gSeg, gCount, cuts }
}

// ── Cuts: the instants a timed fact is segmented at ──────────────────────────────────────
/** The instant a rule can move a measured interval's start to, if any. */
function ruleInstant(r: InstrumentationRule): number | null {
  switch (r.kind) {
    case 'liveAt':
    case 'unmeasuredBefore':
      return r.atMs
    case 'liveOnEtDate':
      return r.dateEt === null ? null : etMidnightMs(r.dateEt)
    default:
      return null
  }
}
/** Every context a metric can be asked in: each pop-up and each campaign it takes as a param. */
function contextsOf(def: MetricDef, window: WindowName): MetricCtx[] {
  const popups: (string | undefined)[] = def.params.includes('popup') ? POPUPS.map((p) => p.id) : [undefined]
  const campaigns: (CampaignFlight | undefined)[] = def.params.includes('campaignId') ? CAMPAIGNS : [undefined]
  return popups.flatMap((popup) =>
    campaigns.map((campaign) => ({
      params: { ...(popup ? { popup } : {}), ...(campaign ? { campaignId: campaign.id } : {}) },
      campaign,
      attribution: campaign ? attributionOf(campaign).clause : undefined,
      window,
    })),
  )
}
const cutsMemo = new Map<FactId, readonly number[]>()
/** The sorted instants a timed fact is segmented at (lib/metrics/facts.ts `s`): everything any
 * side reading it can filter on, from the registry itself —
 *  - a rule's go-live (a partial interval keeps buckets that overlap it: start >= from - bucket + 1),
 *  - a campaign's attribution start (a campaign metric read from this site-wide fact),
 *  - the numerator's go-live of an aligned ratio whose denominator reads this fact (by time,
 *    unless it is the fact's own `pf` split, which is row-exact).
 * Static per deploy, so every batch shares the fact's cache entry. [] for an untimed fact. */
export function factCuts(id: FactId): readonly number[] {
  const hit = cutsMemo.get(id)
  if (hit) return hit
  const fact = FACTS[id]
  const out = new Set<number>()
  if (fact.bucketMs !== null) {
    const bucket = fact.bucketMs
    for (const def of METRICS.values()) {
      for (const [w, f] of Object.entries(def.windows) as [WindowName, FactId][]) {
        if (f !== id) continue
        for (const ctx of contextsOf(def, w)) {
          for (const r of rulesOf(def, ctx)) {
            const x = ruleInstant(r)
            if (x !== null) out.add(x - bucket + 1)
          }
          if (ctx.campaign && !fact.keyParams.includes('campaignId')) {
            const a = attributionOf(ctx.campaign).startMs
            if (a !== null) out.add(a)
          }
        }
      }
    }
    for (const r of RATIOS.values()) {
      if (!r.alignDenominator) continue
      const num = METRICS.get(r.num)!
      for (const [w, f] of Object.entries(METRICS.get(r.den)!.windows) as [WindowName, FactId][]) {
        if (f !== id) continue
        for (const ctx of contextsOf(num, w)) {
          for (const rule of rulesOf(num, ctx)) {
            const x = ruleInstant(rule)
            if (x !== null && x !== fact.splitAt) out.add(x)
          }
        }
      }
    }
  }
  const cuts = [...out].sort((a, b) => a - b)
  cutsMemo.set(id, cuts)
  return cuts
}

/** A planned fact's statement, segmented at its cuts. The one place a fact is built for D1. */
export function buildFact(f: Pick<PlannedFact, 'id' | 'params'>, nowMs: number): FactStatement {
  const def = FACTS[f.id]
  if (def.usesNow) return def.build(f.params, nowMs, factCuts(f.id))
  // Every other statement depends only on its params (and config), so it is built once.
  const key = JSON.stringify([f.id, f.params])
  let stmt = builtMemo.get(key)
  if (!stmt) {
    if (builtMemo.size > 500) builtMemo.clear()
    builtMemo.set(key, (stmt = def.build(f.params, nowMs, factCuts(f.id))))
  }
  return stmt
}
const builtMemo = new Map<string, FactStatement>()

/** One distinct request side: a metric with its params, window and alignment. */
interface SidePlan {
  def: MetricDef
  ctx: MetricCtx
  factId: FactId
  factKey: string
  fact: FactResult | undefined
  asOfMs: number
  stat: Static
  /** Day-0 rows must start at/after this (a partial interval, or an alignment by time). */
  day0FromMs: number | null
  /** Every row must start at/after this (a campaign read from a site-wide fact). */
  allFromMs: number | null
  /** Only these campaign tags (a campaign read from a site-wide fact). */
  tags: ReadonlySet<string> | null
  /** Day-0 rows must be at/after the fact's own split (the install fix, row-exact). */
  alignPf: boolean
  cannotAlign: boolean
  alignFromMs: number | null
  result?: Side
}

interface Side {
  status: 'ok' | 'partial' | 'unmeasured' | 'error'
  value: number | null
  m?: MeasuredInterval
  reason?: string
  noteIds: string[]
  /** Deltas for a today-so-far count: [today, day-1 … day-7]. */
  days?: number[]
  asOfMs?: number
}

class Batch {
  readonly clock: Clock
  private readonly sides = new Map<string, SidePlan>()
  private readonly indexes = new Map<string, FactIndex | null>()
  private readonly masks = new Map<string, Uint8Array>()
  private readonly gates = new Map<string, { yesterday: boolean; avg7: boolean }>()

  constructor(
    readonly env: DeriveEnv,
    private readonly memo: SideMemo,
  ) {
    this.clock = clockOf(env)
  }

  /** Resolves (and memoizes) one side. `alignFromMs` restricts the denominator of an aligned
   * proportion to where its numerator is measured. */
  side(def: MetricDef, req: ResolvedRequest, alignFromMs: number | null): SidePlan {
    const key = `${def.id}|${req.params.campaignId ?? ''}|${req.params.popup ?? ''}|${req.window}|${alignFromMs ?? ''}`
    let plan = this.sides.get(key)
    if (plan) return plan
    const factId = def.windows[req.window]!
    const factKey = factKeyString(factId, factParamsFor(factId, req, this.env))
    const fact = this.env.facts.get(factKey)
    const asOfMs = fact?.ok ? fact.asOfMs : this.env.nowMs
    const { ctx, stat } = resolveStatic(this.memo, def, req, this.clock, req.window === 'todaySoFar' ? asOfMs : this.env.nowMs)
    const factDef = FACTS[factId]
    const bucket = factDef.bucketMs
    let day0FromMs: number | null = null
    let allFromMs: number | null = null
    let tags: ReadonlySet<string> | null = null
    let alignPf = false
    let cannotAlign = false
    // Only the requested window is restricted to I: comparison days are shown only when fully
    // measured (deltasAllowed), so they never need it. A bucket counts when it overlaps I:
    // start + bucket > from, i.e. start >= from - bucket + 1 (starts are whole buckets).
    if (stat.status === 'partial' && bucket !== null) day0FromMs = stat.from - bucket + 1
    // A campaign metric read from a site-wide fact: campaignAttributionClause's rule.
    if (ctx.campaign && !factDef.keyParams.includes('campaignId')) {
      const a = attributionOf(ctx.campaign)
      tags = a.startMs === null ? new Set() : a.tags
      allFromMs = a.startMs
    }
    if (alignFromMs !== null) {
      if (factDef.splitAt !== null && alignFromMs === factDef.splitAt) alignPf = true // row-exact (rowIsPostInstallFix)
      else if (bucket !== null) day0FromMs = Math.max(day0FromMs ?? -Infinity, alignFromMs)
      else cannotAlign = true
    }
    plan = { def, ctx, factId, factKey, fact, asOfMs, stat, day0FromMs, allFromMs, tags, alignPf, cannotAlign, alignFromMs }
    this.sides.set(key, plan)
    return plan
  }

  /** The fact's index, built once per batch. */
  private index(factId: FactId, factKey: string, fact: FactResult): FactIndex | null {
    if (this.indexes.has(factKey)) return this.indexes.get(factKey)!
    const idx = fact.ok && fact.rows.kind === 'beacon' ? buildIndex(fact.rows.rows, factCuts(factId), factId === 'popupRangePath') : null
    this.indexes.set(factKey, idx)
    return idx
  }

  /** Which of the index's distinct paths the metric counts — each path classified once. */
  private mask(idx: FactIndex, factKey: string, def: MetricDef, ctx: MetricCtx): Uint8Array {
    const key = `${factKey}|${def.id}|${ctx.params.popup ?? ''}|${ctx.campaign?.id ?? ''}`
    let m = this.masks.get(key)
    if (m) return m
    m = new Uint8Array(idx.paths.length)
    const test = def.path
    for (let p = 0; p < idx.paths.length; p++) m[p] = !test || test(idx.paths[p], ctx) ? 1 : 0
    this.masks.set(key, m)
    return m
  }

  private rank(idx: FactIndex, x: number | null): number {
    if (x === null) return 0
    const i = idx.cuts.indexOf(x)
    if (i < 0) throw new Error('instant missing from the fact\'s cuts') // factCuts is incomplete
    return i + 1 // groups with seg >= i + 1 start at/after x
  }

  evaluate(plan: SidePlan): Side {
    if (plan.result) return plan.result
    return (plan.result = this.evaluateOnce(plan))
  }

  private evaluateOnce(plan: SidePlan): Side {
    const { def, ctx, stat, fact } = plan
    if (stat.status === 'unmeasured') return { status: 'unmeasured', value: null, reason: stat.reason, noteIds: stat.noteIds }
    // seenInFlightWindow: a closed flight whose serving window never saw this metric's paths.
    let m: MeasuredInterval = stat
    if (stat.needsSeen) {
      const seenKey = factKeyString('flightPathsSeen', { campaignId: ctx.campaign!.id })
      const seen = this.env.facts.get(seenKey)
      if (!seen || !seen.ok) return { status: 'error', value: null, reason: 'fact-failed', noteIds: [] }
      const idx = this.index('flightPathsSeen', seenKey, seen)
      const mask = idx ? this.mask(idx, seenKey, def, ctx) : new Uint8Array(0)
      let saw = false
      for (let p = 0; idx && p < idx.paths.length && !saw; p++) saw = mask[p] === 1 && idx.pathTotal[p] > 0
      m = measuredInterval({ rules: rulesOf(def, ctx), window: windowOf(ctx, this.clock, ctx.window === 'todaySoFar' ? plan.asOfMs : this.env.nowMs), campaign: ctx.campaign, seenInFlight: saw })
      if (m.status === 'unmeasured') return { status: 'unmeasured', value: null, reason: m.reason, noteIds: m.noteIds }
    }
    if (!fact || !fact.ok) return { status: 'error', value: null, reason: 'fact-failed', noteIds: [] }
    if (plan.cannotAlign) return { status: 'error', value: null, reason: 'cannot-align', noteIds: [] }
    const noteIds = def.caveats?.length ? [...new Set([...m.noteIds, ...def.caveats])] : m.noteIds
    const status = m.status === 'partial' ? 'partial' : 'ok'
    if (fact.rows.kind === 'spend') return { status, value: def.spend ? def.spend(fact.rows.rows, ctx) : null, m, noteIds, asOfMs: plan.asOfMs }

    const idx = this.index(plan.factId, plan.factKey, fact)!
    const mask = this.mask(idx, plan.factKey, def, ctx)
    const needAll = this.rank(idx, plan.allFromMs)
    const need0 = Math.max(needAll, this.rank(idx, plan.day0FromMs))
    let tagOk: Uint8Array | null = null
    if (plan.tags) {
      tagOk = new Uint8Array(idx.campaigns.length)
      for (let c = 0; c < idx.campaigns.length; c++) tagOk[c] = plan.tags.has(idx.campaigns[c]) ? 1 : 0
    }
    const onlyNew = def.visitor === 'new'
    const today = ctx.window === 'todaySoFar'
    const sums = new Array<number>(today ? 8 : 1).fill(0)
    for (let p = 0; p < idx.paths.length; p++) {
      if (!mask[p]) continue
      const groups = idx.byPath[p]
      for (let k = 0; k < groups.length; k++) {
        const g = groups[k]
        if (onlyNew && !idx.gVisitorNew[g]) continue
        if (tagOk && !tagOk[idx.gCampaign[g]]) continue
        const day = idx.gDay[g]
        if (day === 0) {
          if (idx.gSeg[g] < need0) continue
          if (plan.alignPf && idx.gPf[g] !== 1) continue
        } else if (idx.gSeg[g] < needAll) continue
        sums[day] += idx.gCount[g]
      }
    }
    return { status, value: sums[0], m, noteIds, ...(today ? { days: sums } : {}), asOfMs: plan.asOfMs }
  }

  /** deltasAllowed for a go-live date, once per batch. */
  gate(goLiveEt: string | null): { yesterday: boolean; avg7: boolean } {
    const key = goLiveEt ?? ''
    let g = this.gates.get(key)
    if (!g) this.gates.set(key, (g = deltasAllowed(goLiveEt, this.env.todayEt)))
    return g
  }

  /** When a lagged numerator's denominator stops growing: a campaign's serving end, else the
   * window's end. */
  lagStopMs(req: ResolvedRequest, def: MetricDef, side: Side): number {
    const campaign = def.params.includes('campaignId') && req.params.campaignId ? campaignById(req.params.campaignId) : undefined
    if (req.window === 'attribution' && campaign) return servingEndMs(campaign)
    if (req.window === 'page') return this.clock.pageRange![1]
    return side.asOfMs ?? this.env.nowMs
  }
}

// Results are built field by field (no spreads, no `delete`): one is assembled per distinct
// request, and optional fields are simply absent rather than null or undefined.

/** Marks a lagged value provisional (its outcome is still arriving). */
function applyLag(v: MetricValue, lagDays: MetricDef['lagDays'], stopMs: number, nowMs: number): MetricValue {
  if (!isProvisional(lagDays, stopMs, nowMs)) return v
  v.provisional = true
  v.noteIds = v.noteIds ? (v.noteIds.includes('still-arriving') ? v.noteIds : [...v.noteIds, 'still-arriving']) : ['still-arriving']
  return v
}

/** A comparison, or nothing: JSON has no Infinity or NaN (both would arrive as null), so a delta
 * is emitted only when finite, and its percentage only when finite too (none against a zero). */
function finiteDelta(today: number, compare: number): MetricDelta | undefined {
  const d = computeDelta(today, compare)
  if (!Number.isFinite(d.delta)) return undefined
  return d.deltaPct !== null && Number.isFinite(d.deltaPct) ? { delta: d.delta, deltaPct: d.deltaPct } : { delta: d.delta }
}

function deltasFor(batch: Batch, side: Side, req: ResolvedRequest, campaign: CampaignFlight | undefined): MetricValue['deltas'] | undefined {
  if (!req.deltas.length || !side.days || !side.m) return undefined
  // A campaign tile also compares only against days after its attribution start (kpiComparisonGate).
  const allowed = batch.gate(laterEtDate(side.m.goLiveEt, campaign?.flightStart ?? null))
  const days = side.days
  const today = days[0]
  let yesterday: MetricDelta | undefined
  let avg7: MetricDelta | undefined
  if (allowed.yesterday && req.deltas.includes('yesterday')) yesterday = finiteDelta(today, days[1])
  if (allowed.avg7 && req.deltas.includes('avg7')) avg7 = finiteDelta(today, (days[1] + days[2] + days[3] + days[4] + days[5] + days[6] + days[7]) / 7)
  if (!yesterday && !avg7) return undefined
  const out: { yesterday?: MetricDelta; avg7?: MetricDelta } = {}
  if (yesterday) out.yesterday = yesterday
  if (avg7) out.avg7 = avg7
  return out
}

function statusOnly(status: 'unmeasured' | 'error', reason: string | undefined, noteIds: string[]): MetricValue {
  const v: MetricValue = { status }
  if (reason !== undefined) v.reason = reason
  if (noteIds.length) v.noteIds = noteIds
  return v
}

function deriveMetric(batch: Batch, req: ResolvedRequest): MetricValue {
  const def = METRICS.get(req.id)!
  const side = batch.evaluate(batch.side(def, req, null))
  if (side.status === 'unmeasured' || side.status === 'error') return statusOnly(side.status, side.reason, side.noteIds)
  if (side.value !== null && !Number.isFinite(side.value)) return statusOnly('error', 'non-finite', []) // never a JSON null
  const v: MetricValue = { status: side.value === null ? 'no-data' : side.status, value: side.value }
  if (side.value !== null) {
    if (side.status === 'partial') v.measuredFrom = side.m!.from
    const deltas = deltasFor(batch, side, req, req.params.campaignId ? campaignById(req.params.campaignId) : undefined)
    if (deltas) v.deltas = deltas
  }
  if (side.noteIds.length) v.noteIds = side.noteIds
  return side.value === null ? v : applyLag(v, def.lagDays, batch.lagStopMs(req, def, side), batch.env.nowMs)
}

function alignFrom(r: RatioDef, num: SidePlan): number | null {
  return r.alignDenominator && num.stat.status === 'partial' ? num.stat.from : null
}

function deriveRatio(batch: Batch, req: ResolvedRequest): MetricValue {
  const r = RATIOS.get(req.id)!
  const numDef = METRICS.get(r.num)!
  const denDef = METRICS.get(r.den)!
  const numPlan = batch.side(numDef, req, null)
  const num = batch.evaluate(numPlan)
  // alignDenominator: count the denominator only inside I(num) ∩ I(den) (the install fix). From
  // the numerator's interval (seenInFlightWindow can only make it unmeasured, never move it).
  const den = batch.evaluate(batch.side(denDef, req, alignFrom(r, numPlan)))
  if (num.status === 'unmeasured') return statusOnly('unmeasured', num.reason, num.noteIds)
  if (den.status === 'unmeasured') return statusOnly('unmeasured', den.reason, den.noteIds)
  if (num.status === 'error') return statusOnly('error', num.reason, [])
  if (den.status === 'error') return statusOnly('error', den.reason, [])
  const partial = num.status === 'partial' || den.status === 'partial'
  const n = num.value
  const d = den.value ?? 0
  if ((n !== null && !Number.isFinite(n)) || !Number.isFinite(d)) return statusOnly('error', 'non-finite', []) // never a JSON null
  let v: MetricValue
  if (r.kind === 'pair') {
    v = { status: partial ? 'partial' : 'ok', value: null, numerator: n ?? 0, denominator: d }
  } else if (n === null) {
    v = { status: 'no-data', value: null, denominator: d } // no spend known
  } else {
    const g = gateRate(n, d, req.minCohort)
    v = { status: d === 0 ? 'no-data' : g.insufficientCohort ? 'too-few' : partial ? 'partial' : 'ok', value: g.value, numerator: n, denominator: d }
  }
  if (partial) v.measuredFrom = Math.max(num.status === 'partial' ? num.m!.from : -Infinity, den.status === 'partial' ? den.m!.from : -Infinity)
  const noteIds = num.noteIds.length && den.noteIds.length ? [...new Set([...num.noteIds, ...den.noteIds])] : num.noteIds.length ? num.noteIds : den.noteIds
  if (noteIds.length) v.noteIds = noteIds
  return applyLag(v, numDef.lagDays, batch.lagStopMs(req, denDef, den), batch.env.nowMs)
}

/** Every request's result, keyed by its key. Invalid requests carry their validation reason.
 * Pass the SideMemo planBatch used, so each side is resolved once per request. */
export function deriveBatch(checks: readonly RequestCheck[], env: DeriveEnv, memo: SideMemo = newSideMemo()): Record<string, MetricValue> {
  const batch = new Batch(env, memo)
  // No prototype: a client key such as "__proto__" (it passes KEY_RE) must be an ordinary own
  // property of the results, never a prototype assignment that silently drops it.
  const out: Record<string, MetricValue> = Object.create(null)
  const same = new Map<string, MetricValue>() // identical requests share one result
  for (const c of checks) {
    if (!c.ok) {
      out[c.key] = { status: 'error', reason: c.reason }
      continue
    }
    const r = c.req
    const sig = `${r.kind}|${r.id}|${r.params.campaignId ?? ''}|${r.params.popup ?? ''}|${r.window}|${r.deltas.join(',')}|${r.minCohort}`
    let v = same.get(sig)
    if (!v) {
      try {
        v = r.kind === 'metric' ? deriveMetric(batch, r) : deriveRatio(batch, r)
      } catch {
        v = { status: 'error', reason: 'derive-failed' }
      }
      same.set(sig, v)
    }
    out[c.key] = v
  }
  return out
}

export type { WindowName }
