// The POST /api/metrics engine (ADR 0003 section 3): plan a validated batch into a small set of
// distinct facts, then derive every requested metric and ratio from those facts' rows in JS.
// Pure: functions/_lib/metricFacts.ts runs and caches the planned statements, and
// functions/api/metrics.ts wires the three together. Nothing here sees SQL text from a client —
// a request names registry ids; the plan names FactIds and validated params.
//
// Derivation reuses the existing primitives: gateRate/MIN_COHORT (lib/popupEvents.ts) for every
// proportion and cost, computeDelta/sameTimeWindowMs/last7DatesBefore (lib/overview.ts) for the
// "today so far" comparisons, rowIsPostInstallFix for the install-fix split,
// campaignAttributionClause's JS twin for campaign rows inside a site-wide fact.

import { campaignAttributionClause, campaignAttributionStartMs, campaignById, type CampaignAttribution, type CampaignFlight } from '../campaigns'
import { gateRate, INSTALL_GAP_PATHS, rowIsPostInstallFix } from '../popupEvents'
import { computeDelta, last7DatesBefore, sameTimeWindowMs } from '../overview'
import { FACTS, factKey, rangeMs, type BeaconRow, type FactId, type FactParams, type FactRows } from './facts'
import { METRICS, rowMatcher, rulesOf, type MetricCtx, type MetricDef } from './metrics'
import { RATIOS } from './ratios'
import { anyPathSeen, deltasAllowed, etMidnightMs, isProvisional, laterEtDate, measuredInterval, seenInFlightRequired, servingEndMs, type MeasuredInterval } from './instrumentation'
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
    case 'bskKpiMinutes':
      return { todayEt: env.todayEt }
    case 'bskHourPath':
      return { since: env.context.since, until: env.context.until }
    case 'popupHourPath':
      return { since: env.context.since, until: env.context.until, sites: env.context.sites }
    case 'adsSpend':
      return {}
  }
}

function sidesOf(req: ResolvedRequest): MetricDef[] {
  if (req.kind === 'metric') return [METRICS.get(req.id)!]
  const r = RATIOS.get(req.id)!
  return [METRICS.get(r.num)!, METRICS.get(r.den)!]
}

// A campaign's attribution (SQL + JS twin) and its lower bound are pure functions of its config,
// and computing the bound formats ET dates through Intl; one batch asks for them per side, so
// they are built once per campaign object.
const attributionMemo = new WeakMap<CampaignFlight, { attribution: CampaignAttribution; startMs: number | null }>()
function attributionOf(campaign: CampaignFlight): { attribution: CampaignAttribution; startMs: number | null } {
  let v = attributionMemo.get(campaign)
  if (!v) attributionMemo.set(campaign, (v = { attribution: campaignAttributionClause(campaign), startMs: campaignAttributionStartMs(campaign) }))
  return v
}

function metricCtx(def: MetricDef, req: Pick<ResolvedRequest, 'params' | 'window'>): MetricCtx {
  const campaign = def.params.includes('campaignId') && req.params.campaignId ? campaignById(req.params.campaignId) : undefined
  return { params: req.params, campaign, attribution: campaign ? attributionOf(campaign).attribution : undefined, window: req.window }
}

/** Groups every valid request into distinct facts (deduplicated by fact key), adding the
 * flightPathsSeen fact wherever a closed flight's instrumentation depends on it. A side that is
 * unmeasured from config alone (a spend-only campaign, a beacon not live, a pending flight)
 * plans no fact at all. */
export function planBatch(requests: readonly ResolvedRequest[], env: BatchEnv): Plan {
  const facts = new Map<string, PlannedFact>()
  const add = (id: FactId, p: FactParams) => {
    const key = factKeyString(id, p)
    if (!facts.has(key)) facts.set(key, { key, id, params: factKey(id, p).params as FactParams, statements: id === 'adsSpend' && !env.hasAdsDb ? 0 : 1 })
  }
  for (const req of requests) {
    for (const def of sidesOf(req)) {
      const ctx = metricCtx(def, req)
      const side = sideStatic(def, ctx, env, env.nowMs)
      if (side.status === 'unmeasured') continue
      add(def.windows[req.window]!, factParamsFor(def.windows[req.window]!, req, env))
      if (side.needsSeen) add('flightPathsSeen', { campaignId: ctx.campaign!.id })
    }
  }
  const list = [...facts.values()]
  return { facts: list, statements: list.reduce((a, f) => a + f.statements, 0) }
}

/** The measured interval from config alone (optimistic about seenInFlightWindow), plus whether
 * the flightPathsSeen evidence is needed. */
function sideStatic(def: MetricDef, ctx: MetricCtx, env: BatchEnv, windowEndMs: number): MeasuredInterval & { needsSeen: boolean } {
  const factId = def.windows[ctx.window]!
  if (ctx.campaign && ctx.campaign.flightStart === null && factId !== 'adsSpend') {
    return { status: 'unmeasured', from: Infinity, reason: 'flight-pending', noteIds: ['flight-pending'], goLiveEt: null, needsSeen: false }
  }
  const rules = rulesOf(def, ctx)
  const m = measuredInterval({ rules, window: windowOf(ctx, env, windowEndMs), campaign: ctx.campaign, seenInFlight: true })
  const needsSeen = m.status !== 'unmeasured' && rules.some((r) => r.kind === 'seenInFlightWindow') && seenInFlightRequired(ctx.campaign) && !!ctx.campaign?.flightStart
  return { ...m, needsSeen }
}

/** W = [a, b) for a request window. `endMs` is "now" (the KPI fact's own as-of instant for
 * today-so-far, so every window of one fact shares one clock). */
function windowOf(ctx: MetricCtx, env: BatchEnv, endMs: number): [number, number] {
  switch (ctx.window) {
    case 'attribution':
      return [ctx.campaign ? (attributionOf(ctx.campaign).startMs ?? endMs) : endMs, endMs]
    case 'todaySoFar':
      return [etMidnightMs(env.todayEt), endMs]
    case 'page':
      return rangeMs(env.context.since!, env.context.until!)
  }
}

// ── Derivation ───────────────────────────────────────────────────────────────────────────
/** A fetched fact: its rows and the instant they were read (a cached entry keeps its own). */
export type FactResult = { ok: true; rows: FactRows; asOfMs: number } | { ok: false; error: string }

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

// Per fact: which ET day (0 = today so far, 1..7 = the same time on each earlier day) each KPI
// row falls in, computed once per fact and shared by every metric that reads it.
const dayIndexCache = new WeakMap<object, Int8Array>()
function dayIndexOf(rows: readonly BeaconRow[], todayEt: string, asOfMs: number): Int8Array {
  const cached = dayIndexCache.get(rows)
  if (cached) return cached
  const windows: [number, number][] = [[etMidnightMs(todayEt), asOfMs], ...last7DatesBefore(todayEt).map((d) => sameTimeWindowMs(d, asOfMs))]
  const idx = new Int8Array(rows.length).fill(-1)
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].t ?? -1
    for (let d = 0; d < windows.length; d++) {
      if (t >= windows[d][0] && t < windows[d][1]) {
        idx[i] = d
        break
      }
    }
  }
  dayIndexCache.set(rows, idx)
  return idx
}

/** A row the fact could not drop in SQL: a pre-fix install-gap row (only popupHourPath, whose
 * query is /api/popups' own and keeps them; aggregatePopupRows drops them the same way). */
function isUnmeasuredGapRow(r: BeaconRow): boolean {
  return (INSTALL_GAP_PATHS as readonly string[]).includes(r.path) && !rowIsPostInstallFix({ hourStartMs: r.t ?? 0, path: r.path, count: r.c, postInstallFix: r.pf ?? undefined })
}

/** Whether a row lies at or after `fromMs` — row-exact through the fact's `pf` split when the
 * boundary is that split (rowIsPostInstallFix), else by bucket start. null = the fact cannot tell. */
function rowAtOrAfter(r: BeaconRow, fromMs: number, splitAt: number | null): boolean | null {
  if (splitAt !== null && fromMs === splitAt && r.pf !== null) return rowIsPostInstallFix({ hourStartMs: r.t ?? 0, path: r.path, count: r.c, postInstallFix: r.pf }, splitAt)
  if (r.t !== null) return r.t >= fromMs
  return null
}

interface DeriveEnv extends BatchEnv {
  facts: ReadonlyMap<string, FactResult>
}

function evalSide(def: MetricDef, req: ResolvedRequest, env: DeriveEnv, alignFromMs: number | null = null): Side {
  const ctx = metricCtx(def, req)
  const factId = def.windows[req.window]!
  const factRes = env.facts.get(factKeyString(factId, factParamsFor(factId, req, env)))
  const asOfMs = factRes?.ok ? factRes.asOfMs : env.nowMs
  const stat = sideStatic(def, ctx, env, req.window === 'todaySoFar' ? asOfMs : env.nowMs)
  const caveats = def.caveats ?? []
  if (stat.status === 'unmeasured') return { status: 'unmeasured', value: null, reason: stat.reason, noteIds: stat.noteIds }

  // seenInFlightWindow: a closed flight whose serving window never saw this metric's paths.
  let m: MeasuredInterval = stat
  if (stat.needsSeen) {
    const seen = env.facts.get(factKeyString('flightPathsSeen', { campaignId: ctx.campaign!.id }))
    if (!seen || !seen.ok) return { status: 'error', value: null, reason: 'fact-failed', noteIds: [] }
    const pathTest = def.path
    const saw = seen.rows.kind === 'beacon' && anyPathSeen(seen.rows.rows, (p) => (pathTest ? pathTest(p, ctx) : true))
    m = measuredInterval({ rules: rulesOf(def, ctx), window: windowOf(ctx, env, req.window === 'todaySoFar' ? asOfMs : env.nowMs), campaign: ctx.campaign, seenInFlight: saw })
    if (m.status === 'unmeasured') return { status: 'unmeasured', value: null, reason: m.reason, noteIds: m.noteIds }
  }
  if (!factRes || !factRes.ok) return { status: 'error', value: null, reason: 'fact-failed', noteIds: [] }
  const noteIds = [...new Set([...m.noteIds, ...caveats])]
  const status = m.status === 'partial' ? 'partial' : 'ok'

  if (factRes.rows.kind === 'spend') {
    return { status, value: def.spend ? def.spend(factRes.rows.rows, ctx) : null, m, noteIds, asOfMs }
  }

  const fact = FACTS[factId]
  const rows = factRes.rows.rows
  const matches = rowMatcher(def, ctx)
  // A campaign metric read from a site-wide fact: campaignAttributionClause's own rule, in JS.
  const attribution = ctx.attribution && !fact.keyParams.includes('campaignId') ? ctx.attribution : null
  const dropGap = factId === 'popupHourPath'
  const bucket = fact.bucketMs
  const partialFrom = m.status === 'partial' && bucket !== null ? m.from : null
  const today = req.window === 'todaySoFar'
  const dayIdx = today ? dayIndexOf(rows, env.todayEt, asOfMs) : null
  const sums = new Array<number>(today ? 8 : 1).fill(0)
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const day = dayIdx ? dayIdx[i] : 0
    if (day < 0) continue
    if (!matches(r)) continue
    if (attribution && !attribution.matches(r.campaign, r.t ?? -1)) continue
    if (dropGap && isUnmeasuredGapRow(r)) continue
    // Only the requested window is restricted to I: comparison days are shown only when fully
    // measured (deltasAllowed), so they never need it.
    if (day === 0 && partialFrom !== null && (r.t ?? 0) + bucket! <= partialFrom) continue
    if (alignFromMs !== null && day === 0) {
      const after = rowAtOrAfter(r, alignFromMs, fact.splitAt)
      if (after === null) return { status: 'error', value: null, reason: 'cannot-align', noteIds: [] }
      if (!after) continue
    }
    sums[day] += r.c
  }
  return { status, value: sums[0], m, noteIds, ...(today ? { days: sums } : {}), asOfMs }
}

/** When a lagged numerator's denominator stops growing: a campaign's serving end, else the
 * window's end. */
function lagStopMs(req: ResolvedRequest, def: MetricDef, env: DeriveEnv, side: Side): number {
  const campaign = def.params.includes('campaignId') && req.params.campaignId ? campaignById(req.params.campaignId) : undefined
  if (req.window === 'attribution' && campaign) return servingEndMs(campaign)
  if (req.window === 'page') return rangeMs(env.context.since!, env.context.until!)[1]
  return side.asOfMs ?? env.nowMs
}

function withLag(v: MetricValue, lagDays: MetricDef['lagDays'], stopMs: number, nowMs: number): MetricValue {
  if (!isProvisional(lagDays, stopMs, nowMs)) return v
  return { ...v, provisional: true, noteIds: [...new Set([...(v.noteIds ?? []), 'still-arriving'])] }
}

function deltasFor(side: Side, req: ResolvedRequest, campaign: CampaignFlight | undefined, env: DeriveEnv): MetricValue['deltas'] | undefined {
  if (!req.deltas.length || !side.days || !side.m) return undefined
  // A campaign tile also compares only against days after its attribution start (kpiComparisonGate).
  const goLive = laterEtDate(side.m.goLiveEt, campaign?.flightStart ?? null)
  const allowed = deltasAllowed(goLive, env.todayEt)
  const out: { yesterday?: MetricDelta; avg7?: MetricDelta } = {}
  const today = side.days[0]
  if (req.deltas.includes('yesterday') && allowed.yesterday) out.yesterday = computeDelta(today, side.days[1])
  if (req.deltas.includes('avg7') && allowed.avg7) out.avg7 = computeDelta(today, side.days.slice(1, 8).reduce((a, b) => a + b, 0) / 7)
  return Object.keys(out).length ? out : undefined
}

const compact = (v: MetricValue): MetricValue => {
  const out = { ...v }
  if (!out.noteIds?.length) delete out.noteIds
  return out
}

function deriveMetric(req: ResolvedRequest, env: DeriveEnv): MetricValue {
  const def = METRICS.get(req.id)!
  const side = evalSide(def, req, env)
  if (side.status === 'unmeasured' || side.status === 'error') return compact({ status: side.status, reason: side.reason, noteIds: side.noteIds })
  if (side.value === null) return compact({ status: 'no-data', value: null, noteIds: side.noteIds })
  const campaign = req.params.campaignId ? campaignById(req.params.campaignId) : undefined
  const deltas = deltasFor(side, req, campaign, env)
  const v: MetricValue = {
    status: side.status,
    value: side.value,
    ...(side.status === 'partial' ? { measuredFrom: side.m!.from } : {}),
    ...(deltas ? { deltas } : {}),
    noteIds: side.noteIds,
  }
  return compact(withLag(v, def.lagDays, lagStopMs(req, def, env, side), env.nowMs))
}

function deriveRatio(req: ResolvedRequest, env: DeriveEnv): MetricValue {
  const r = RATIOS.get(req.id)!
  const numDef = METRICS.get(r.num)!
  const denDef = METRICS.get(r.den)!
  const num = evalSide(numDef, req, env)
  // alignDenominator: count the denominator only inside I(num) ∩ I(den) (the install fix).
  const align = r.alignDenominator && num.status === 'partial' ? num.m!.from : null
  const den = evalSide(denDef, req, env, align)
  for (const s of [num, den]) {
    if (s.status === 'unmeasured') return compact({ status: 'unmeasured', reason: s.reason, noteIds: s.noteIds })
  }
  for (const s of [num, den]) if (s.status === 'error') return { status: 'error', reason: s.reason }
  const noteIds = [...new Set([...num.noteIds, ...den.noteIds])]
  const partial = num.status === 'partial' || den.status === 'partial'
  const froms = [num, den].filter((s) => s.status === 'partial').map((s) => s.m!.from)
  const base = { ...(partial ? { measuredFrom: Math.max(...froms) } : {}), noteIds }
  const n = num.value
  const d = den.value ?? 0
  let v: MetricValue
  if (r.kind === 'pair') {
    v = { status: partial ? 'partial' : 'ok', value: null, numerator: n ?? 0, denominator: d, ...base }
  } else if (n === null) {
    v = { status: 'no-data', value: null, denominator: d, ...base } // no spend known
  } else {
    const g = gateRate(n, d, req.minCohort)
    const status = d === 0 ? 'no-data' : g.insufficientCohort ? 'too-few' : partial ? 'partial' : 'ok'
    v = { status, value: g.value, numerator: n, denominator: d, ...base }
  }
  return compact(withLag(v, numDef.lagDays, lagStopMs(req, denDef, env, den), env.nowMs))
}

/** Every request's result, keyed by its key. Invalid requests carry their validation reason. */
export function deriveBatch(checks: readonly RequestCheck[], env: DeriveEnv): Record<string, MetricValue> {
  const out: Record<string, MetricValue> = {}
  for (const c of checks) {
    if (!c.ok) {
      out[c.key] = { status: 'error', reason: c.reason }
      continue
    }
    try {
      out[c.key] = c.req.kind === 'metric' ? deriveMetric(c.req, env) : deriveRatio(c.req, env)
    } catch {
      out[c.key] = { status: 'error', reason: 'derive-failed' }
    }
  }
  return out
}

export type { WindowName }
