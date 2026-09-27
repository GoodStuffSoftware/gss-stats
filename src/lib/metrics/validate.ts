// Validation for metric components (ADR 0003): validateCard (a CardSpec against the registry:
// ids, params, windows, display compatibility, note ids) and validateMetricsRequest (the
// POST /api/metrics whitelist, section 3). The server never trusts a card config: it only ever
// sees request lists, and every id, param and window in them is checked against the registry
// maps here before anything reaches a fact builder. No free-text param exists.
//
// normCardRef (the load-time normalizer that keeps `widget.card` through lib/defaults.ts
// normWidget) is slice 5, where it is wired into normalizeConfig.

import { MIN_COHORT, POPUPS } from '../popupEvents'
import { CAMPAIGNS } from '../campaigns'
import { NOTES_REGISTRY } from '../notes'
import { safeUA } from '../ownExclusion'
import { SITE_TAG_RE, WHEN_RE } from '../range'
import { METRICS, metricWindows, type MetricDef, type MetricParam } from './metrics'
import { RATIOS, ratioParamsOf, ratioWindowsOf, type RatioDef } from './ratios'
import type { CardSpec, DataBinding, DeltaName, Display, DisplayAs, Label, RepeatSpec, WindowName } from './types'

// ── Limits (ADR 0003 section 3, "The security whitelist") ─────────────────────────────────
export const MAX_BODY_BYTES = 64 * 1024
export const MAX_REQUESTS = 200
/** Planner budget: D1 allows 50 queries per invocation; this leaves room for the ads store. */
export const MAX_STATEMENTS = 40
export const KEY_RE = /^[a-z0-9_.:-]{1,64}$/
const MAX_SITES = 50
const DELTA_NAMES: readonly DeltaName[] = ['yesterday', 'avg7']
const CAMPAIGN_IDS = new Set(CAMPAIGNS.map((c) => c.id))
const POPUP_IDS = new Set(POPUPS.map((p) => p.id))

// ── Data kinds and display compatibility (ADR 0003 section 1) ────────────────────────────
export type DataKind = 'count' | 'money' | 'proportion' | 'cost' | 'pair' | 'field'
export const DISPLAYS_FOR: Record<DataKind, readonly DisplayAs[]> = {
  count: ['number', 'bar', 'sparkline'],
  money: ['currency', 'sparkline'],
  proportion: ['percent', 'counts'],
  cost: ['currency'],
  pair: ['counts'],
  field: ['dateRange', 'datetime', 'badge', 'text', 'number', 'currency'],
}

export function metricKind(def: MetricDef): DataKind {
  return def.unit === 'usd' ? 'money' : 'count'
}
export function ratioKind(def: RatioDef): DataKind {
  return def.kind
}
export function kindOf(b: DataBinding): DataKind | null {
  if ('field' in b) return 'field'
  if ('metric' in b) {
    const m = METRICS.get(b.metric)
    return m ? metricKind(m) : null
  }
  const r = RATIOS.get(b.ratio)
  return r ? ratioKind(r) : null
}

// ── validateCard ─────────────────────────────────────────────────────────────────────────
const SERVED_WINDOWS: ReadonlySet<string> = new Set<WindowName>(['attribution', 'todaySoFar', 'page'])
const SCOPE_PARAM: Record<RepeatSpec['over'], MetricParam | null> = { campaigns: 'campaignId', popups: 'popup', windows: null, readings: null }

/** Errors for a card spec, [] when valid. Runs on load, in the editor and in tests. */
export function validateCard(spec: CardSpec): string[] {
  const errors: string[] = []
  if (!spec || spec.v !== 1) return ['card: v must be 1']
  if (!Array.isArray(spec.sections) || !spec.sections.length) errors.push('card: needs at least one section')
  const checkLabel = (where: string, l: Label | undefined, hasData: boolean) => {
    if (l === undefined || typeof l === 'string') return
    if ('note' in l && !NOTES_REGISTRY[l.note]) errors.push(`${where}: unknown note id '${l.note}'`)
    if ('metric' in l && !hasData) errors.push(`${where}: { metric: true } needs a metric or ratio binding`)
  }
  const checkNote = (where: string, id: string) => {
    if (!NOTES_REGISTRY[id]) errors.push(`${where}: unknown note id '${id}'`)
  }
  const checkRepeat = (where: string, r: RepeatSpec | undefined) => {
    if (!r) return
    for (const id of r.ids ?? []) {
      if (r.over === 'campaigns' && !CAMPAIGN_IDS.has(id)) errors.push(`${where}.repeat: unknown campaign '${id}'`)
      if (r.over === 'popups' && !POPUP_IDS.has(id)) errors.push(`${where}.repeat: unknown pop-up '${id}'`)
    }
    if (r.empty) {
      checkLabel(`${where}.repeat.empty.label`, r.empty.label, false)
      checkLabel(`${where}.repeat.empty.text`, r.empty.text, false)
    }
  }
  const check = (where: string, b: DataBinding, d: Display, scope: ReadonlySet<MetricParam>) => {
    const k = kindOf(b)
    if (!k) return void errors.push(`${where}: unknown data id`)
    if (!DISPLAYS_FOR[k].includes(d.as)) errors.push(`${where}: display '${d.as}' not allowed for a ${k}`)
    if ('field' in b) return
    const isMetric = 'metric' in b
    const allowedParams = isMetric ? METRICS.get(b.metric)!.params : ratioParamsOf(RATIOS.get(b.ratio)!)
    const windows = isMetric ? metricWindows(METRICS.get(b.metric)!) : ratioWindowsOf(RATIOS.get(b.ratio)!)
    for (const [name, v] of Object.entries(b.params ?? {})) {
      if (!allowedParams.includes(name as MetricParam)) errors.push(`${where}: param '${name}' not accepted`)
      else if (typeof v === 'string' && !(name === 'campaignId' ? CAMPAIGN_IDS : POPUP_IDS).has(v)) errors.push(`${where}: unknown ${name} '${v}'`)
    }
    for (const p of allowedParams) {
      if (b.params?.[p] === undefined && !scope.has(p)) errors.push(`${where}: param '${p}' is neither set nor provided by a repeat`)
    }
    if (b.window !== undefined) {
      if (typeof b.window !== 'string' || !SERVED_WINDOWS.has(b.window)) errors.push(`${where}: window ${JSON.stringify(b.window)} is not served`)
      else if (!windows.includes(b.window as WindowName)) errors.push(`${where}: window '${b.window}' not allowed (${windows.join(', ')})`)
    }
    if (d.as === 'number' && d.deltas?.length) {
      const w = b.window ?? windows[0]
      if (!isMetric || k !== 'count' || w !== 'todaySoFar') errors.push(`${where}: deltas need a count metric over 'todaySoFar'`)
    }
  }
  const scopeOf = (...repeats: (RepeatSpec | undefined)[]) => new Set(repeats.map((r) => (r ? SCOPE_PARAM[r.over] : null)).filter((p): p is MetricParam => !!p))

  checkRepeat('card', spec.repeat)
  checkLabel('card.title', spec.title, false)
  for (const id of spec.captions ?? []) checkNote('card.captions', id)
  if (spec.badge) {
    if (!('field' in spec.badge.data)) errors.push('badge: must bind a field')
    check('badge', spec.badge.data, spec.badge.display, scopeOf(spec.repeat))
  }
  spec.sections?.forEach((s, si) => {
    const where = `sections[${si}]`
    checkRepeat(where, s.repeat)
    checkLabel(`${where}.title`, s.title, false)
    const ids = new Set<string>()
    for (const it of s.items ?? []) {
      const w = `${where}.${it.id}`
      if (ids.has(it.id)) errors.push(`${w}: duplicate item id`)
      ids.add(it.id)
      checkRepeat(w, it.repeat)
      checkLabel(`${w}.label`, it.label, !('field' in it.data))
      checkLabel(`${w}.caption`, it.caption, !('field' in it.data))
      check(w, it.data, it.display, scopeOf(spec.repeat, s.repeat, it.repeat))
      if (it.gating?.minCohort != null && it.gating.minCohort < MIN_COHORT) errors.push(`${w}: minCohort below MIN_COHORT`)
      const empty = it.gating?.whenEmpty
      if (empty && typeof empty === 'object') checkNote(`${w}.gating.whenEmpty`, empty.note)
    }
  })
  return errors
}

// ── validateMetricsRequest (the server whitelist) ─────────────────────────────────────────
export interface ResolvedRequest {
  key: string
  kind: 'metric' | 'ratio'
  id: string
  params: { campaignId?: string; popup?: string }
  window: WindowName
  deltas: DeltaName[]
  minCohort: number
}
export type RequestCheck = { key: string; ok: true; req: ResolvedRequest } | { key: string; ok: false; reason: string }

export interface ValidContext {
  since?: string
  until?: string
  sites: string[]
  excludeOwnVisits: boolean
  ownBrowser: string
  ownOS: string
}

export type ValidatedBatch =
  | { ok: true; context: ValidContext; fresh: boolean; requests: RequestCheck[] }
  | { ok: false; status: 400 | 413; error: string; detail?: Record<string, unknown> }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const only = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).find((k) => !allowed.includes(k))
const bad = (error: string, detail?: Record<string, unknown>): ValidatedBatch => ({ ok: false, status: 400, error, ...(detail ? { detail } : {}) })

function validateContext(raw: unknown): ValidContext | string {
  if (raw === undefined) return { sites: [], excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
  if (!isObj(raw)) return 'context must be an object'
  const extra = only(raw, ['since', 'until', 'sites', 'excludeOwnVisits', 'ownBrowser', 'ownOS'])
  if (extra) return `context.${extra} is not accepted`
  for (const k of ['since', 'until'] as const) {
    if (raw[k] !== undefined && (typeof raw[k] !== 'string' || !WHEN_RE.test(raw[k] as string))) return `context.${k} must be YYYY-MM-DD or an ISO datetime`
  }
  if ((raw.since === undefined) !== (raw.until === undefined)) return 'context.since and context.until go together'
  let sites: string[] = []
  if (raw.sites !== undefined) {
    if (!Array.isArray(raw.sites) || raw.sites.length > MAX_SITES || !raw.sites.every((s) => typeof s === 'string' && SITE_TAG_RE.test(s))) return `context.sites must be at most ${MAX_SITES} site tags`
    sites = [...new Set(raw.sites as string[])].sort()
  }
  if (raw.excludeOwnVisits !== undefined && raw.excludeOwnVisits !== true) return 'context.excludeOwnVisits must be exactly true when set'
  for (const k of ['ownBrowser', 'ownOS'] as const) {
    if (raw[k] !== undefined && (typeof raw[k] !== 'string' || safeUA(raw[k]) !== raw[k])) return `context.${k} is not a valid user-agent value`
  }
  return {
    ...(raw.since !== undefined ? { since: raw.since as string, until: raw.until as string } : {}),
    sites,
    excludeOwnVisits: raw.excludeOwnVisits === true,
    ownBrowser: (raw.ownBrowser as string | undefined) ?? '',
    ownOS: (raw.ownOS as string | undefined) ?? '',
  }
}

function failed(key: string, reason: string): RequestCheck {
  return { key, ok: false, reason }
}

function checkRequest(raw: Record<string, unknown>, key: string, context: ValidContext): RequestCheck {
  if (only(raw, ['key', 'metric', 'ratio', 'params', 'window', 'deltas', 'minCohort'])) return failed(key, 'bad-request')
  const hasMetric = raw.metric !== undefined
  const hasRatio = raw.ratio !== undefined
  if (hasMetric === hasRatio) return failed(key, 'bad-request') // exactly one of metric | ratio
  const id = hasMetric ? raw.metric : raw.ratio
  if (typeof id !== 'string') return failed(key, 'unknown-id')
  const metric = hasMetric ? METRICS.get(id) : undefined
  const ratio = hasRatio ? RATIOS.get(id) : undefined
  if (!metric && !ratio) return failed(key, 'unknown-id') // a Map lookup; never reaches SQL
  const allowedParams = metric ? metric.params : ratioParamsOf(ratio!)
  const windows = metric ? metricWindows(metric) : ratioWindowsOf(ratio!)
  const kind: 'count' | 'money' | 'proportion' | 'cost' | 'pair' = metric ? (metricKind(metric) as 'count' | 'money') : ratio!.kind

  const params: ResolvedRequest['params'] = {}
  if (raw.params !== undefined) {
    if (!isObj(raw.params)) return failed(key, 'bad-param')
    for (const [name, v] of Object.entries(raw.params)) {
      if (!allowedParams.includes(name as MetricParam)) return failed(key, 'bad-param')
      if (typeof v !== 'string' || !(name === 'campaignId' ? CAMPAIGN_IDS : POPUP_IDS).has(v)) return failed(key, 'bad-param')
      params[name as MetricParam] = v
    }
  }
  for (const p of allowedParams) if (params[p] === undefined) return failed(key, 'missing-param')

  let window = windows[0]
  if (raw.window !== undefined) {
    if (typeof raw.window !== 'string' || !windows.includes(raw.window as WindowName)) return failed(key, 'bad-window')
    window = raw.window as WindowName
  }
  if (window === 'page' && (context.since === undefined || context.until === undefined)) return failed(key, 'missing-range')

  let deltas: DeltaName[] = []
  if (raw.deltas !== undefined) {
    if (!Array.isArray(raw.deltas) || !raw.deltas.every((d) => DELTA_NAMES.includes(d as DeltaName))) return failed(key, 'bad-deltas')
    deltas = [...new Set(raw.deltas as DeltaName[])]
    if (deltas.length && (kind !== 'count' || window !== 'todaySoFar')) return failed(key, 'bad-deltas')
  }

  let minCohort = MIN_COHORT
  if (raw.minCohort !== undefined) {
    if (typeof raw.minCohort !== 'number' || !Number.isInteger(raw.minCohort) || raw.minCohort < 1 || raw.minCohort > 1_000_000) return failed(key, 'bad-param')
    if (kind !== 'proportion' && kind !== 'cost') return failed(key, 'bad-param')
    minCohort = Math.max(MIN_COHORT, raw.minCohort) // may only RAISE the floor
  }
  return { key, ok: true, req: { key, kind: metric ? 'metric' : 'ratio', id, params, window, deltas, minCohort } }
}

/** The whole-batch whitelist. `bodyText` is the raw request body (the handler enforces
 * MAX_BODY_BYTES before reading it). Batch-level problems are a 400/413; a problem with one
 * request is that request's `error` result, so the rest of the batch still answers. */
export function validateMetricsRequest(bodyText: string): ValidatedBatch {
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    return bad('invalid JSON body')
  }
  if (!isObj(body)) return bad('body must be an object')
  const extra = only(body, ['v', 'context', 'fresh', 'requests'])
  if (extra) return bad(`${extra} is not accepted`)
  if (body.v !== 1) return bad('v must be 1')
  if (body.fresh !== undefined && body.fresh !== true) return bad('fresh must be exactly true when set')
  if (!Array.isArray(body.requests) || !body.requests.length) return bad('requests must be a non-empty array')
  if (body.requests.length > MAX_REQUESTS) return { ok: false, status: 413, error: 'too many requests', detail: { maxRequests: MAX_REQUESTS } }
  const context = validateContext(body.context)
  if (typeof context === 'string') return bad(context)
  const seen = new Set<string>()
  const requests: RequestCheck[] = []
  for (const r of body.requests) {
    if (!isObj(r) || typeof r.key !== 'string' || !KEY_RE.test(r.key)) return bad('every request needs a key matching ' + KEY_RE.source)
    if (seen.has(r.key)) return bad(`duplicate key '${r.key}'`)
    seen.add(r.key)
    requests.push(checkRequest(r, r.key, context))
  }
  return { ok: true, context, fresh: body.fresh === true, requests }
}
