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
import { hasNote } from '../notes'
import { safeUA } from '../ownExclusion'
import { SITE_TAG_RE, WHEN_RE } from '../range'
import { addDays } from '../etTime'
import { rangeMs } from './facts'
import { METRICS, metricWindows, OPTIONAL_PARAMS, type MetricDef, type MetricParam } from './metrics'
import { presetById } from './presets'
import { RATIOS, ratioParamsOf, ratioWindowsOf, type RatioDef } from './ratios'
import { COUNTRY_BUCKETS, WINDOW_SIDES, type CardAction, type CardRef, type CardSpec, type DataBinding, type DeltaName, type Display, type DisplayAs, type Label, type RepeatSpec, type WindowName } from './types'

// ── Limits (ADR 0003 section 3, "The security whitelist") ─────────────────────────────────
export const MAX_BODY_BYTES = 64 * 1024
export const MAX_REQUESTS = 200
/** Planner budget: D1 allows 50 queries per invocation; this leaves room for the ads store. */
export const MAX_STATEMENTS = 40
export const KEY_RE = /^[a-z0-9_.:-]{1,64}$/
const MAX_SITES = 50
/** The longest page range a batch may ask for (review finding #10). */
export const MAX_RANGE_DAYS = 400
const DELTA_NAMES: readonly DeltaName[] = ['yesterday', 'avg7']
const CAMPAIGN_IDS = new Set(CAMPAIGNS.map((c) => c.id))
const POPUP_IDS = new Set(POPUPS.map((p) => p.id))
const COUNTRY_IDS: ReadonlySet<string> = new Set(COUNTRY_BUCKETS)
const CARD_ACTIONS: ReadonlySet<CardAction> = new Set(['ads-refresh'])
/** A param value is one of its set: a configured campaign, a registered pop-up, a country bucket. */
function paramValueOk(name: MetricParam, v: unknown): boolean {
  return typeof v === 'string' && (name === 'campaignId' ? CAMPAIGN_IDS : name === 'popup' ? POPUP_IDS : COUNTRY_IDS).has(v)
}
/** The country split is the campaign fact's (its `cb` column): every side of the binding must read
 * that fact in the window asked for. */
function countrySplittable(defs: readonly (MetricDef | undefined)[], window: string): boolean {
  return defs.every((d) => !!d && d.windows[window as WindowName] === 'campaignPathVisitor')
}
function sidesOf(b: { metric: string } | { ratio: string }): (MetricDef | undefined)[] {
  if ('metric' in b) return [METRICS.get(b.metric)]
  const r = RATIOS.get(b.ratio)
  return r ? [METRICS.get(r.num), METRICS.get(r.den)] : [undefined]
}

// ── Data kinds and display compatibility (ADR 0003 section 1) ────────────────────────────
/** 'time': an instant or a day (when spend was last synced); 'code': a category shown as the
 * label note it carries (where a spend figure came from). Neither is a count. */
export type DataKind = 'count' | 'money' | 'proportion' | 'cost' | 'pair' | 'field' | 'time' | 'code'
export const DISPLAYS_FOR: Record<DataKind, readonly DisplayAs[]> = {
  count: ['number', 'bar', 'sparkline'],
  money: ['currency', 'sparkline'],
  // 'bar': the rate as a bar scaled to the section's largest rate, with its (n/d).
  proportion: ['percent', 'counts', 'bar'],
  cost: ['currency'],
  pair: ['counts'],
  field: ['dateRange', 'datetime', 'badge', 'text', 'number', 'currency'],
  time: ['date', 'ago'],
  code: ['status'],
}

export function metricKind(def: MetricDef): DataKind {
  return def.unit === 'usd' ? 'money' : def.unit === 'instant' ? 'time' : def.unit === 'code' ? 'code' : 'count'
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
const SERVED_WINDOWS: ReadonlySet<string> = new Set<WindowName>(['attribution', 'todaySoFar', 'page', ...WINDOW_SIDES])
const SCOPE_PARAM: Record<RepeatSpec['over'], MetricParam | null> = { campaigns: 'campaignId', popups: 'popup', windows: null, readings: null, countries: 'country' }

/** Errors for a card spec, [] when valid. Runs on load, in the editor and in tests. */
export function validateCard(spec: CardSpec): string[] {
  const errors: string[] = []
  if (!spec || spec.v !== 1) return ['card: v must be 1']
  if (!Array.isArray(spec.sections) || !spec.sections.length) errors.push('card: needs at least one section')
  const checkLabel = (where: string, l: Label | undefined, hasData: boolean) => {
    if (l === undefined || typeof l === 'string') return
    if ('note' in l && !hasNote(l.note)) errors.push(`${where}: unknown note id '${l.note}'`)
    if ('metric' in l && !hasData) errors.push(`${where}: { metric: true } needs a metric or ratio binding`)
  }
  const checkNote = (where: string, id: string) => {
    if (!hasNote(id)) errors.push(`${where}: unknown note id '${id}'`)
  }
  const checkRepeat = (where: string, r: RepeatSpec | undefined) => {
    if (!r) return
    if (!Object.hasOwn(SCOPE_PARAM, r.over)) return void errors.push(`${where}.repeat: unknown repeat '${String(r.over)}'`)
    for (const id of r.ids ?? []) {
      if (r.over === 'campaigns' && !CAMPAIGN_IDS.has(id)) errors.push(`${where}.repeat: unknown campaign '${id}'`)
      if (r.over === 'popups' && !POPUP_IDS.has(id)) errors.push(`${where}.repeat: unknown pop-up '${id}'`)
      if (r.over === 'countries' && !COUNTRY_IDS.has(id)) errors.push(`${where}.repeat: unknown country bucket '${id}'`)
      if (r.over === 'windows' && !(WINDOW_SIDES as readonly string[]).includes(id)) errors.push(`${where}.repeat: unknown window '${id}'`)
    }
    if (r.tracked !== undefined && (r.tracked !== true || r.over !== 'campaigns')) errors.push(`${where}.repeat: tracked is for campaigns, and only true`)
    if (r.empty) {
      checkLabel(`${where}.repeat.empty.label`, r.empty.label, false)
      checkLabel(`${where}.repeat.empty.text`, r.empty.text, false)
    }
  }
  const check = (where: string, b: DataBinding, d: Display, repeats: readonly (RepeatSpec | undefined)[]) => {
    const scope = scopeOf(...repeats)
    const k = kindOf(b)
    if (!k) return void errors.push(`${where}: unknown data id`)
    if (!DISPLAYS_FOR[k].includes(d.as)) errors.push(`${where}: display '${d.as}' not allowed for a ${k}`)
    if (d.as === 'percent' && d.decimals !== undefined && !(Number.isInteger(d.decimals) && d.decimals >= 0 && d.decimals <= 4)) errors.push(`${where}: decimals must be an integer from 0 to 4`)
    if ('field' in b) return
    const isMetric = 'metric' in b
    const allowedParams = isMetric ? METRICS.get(b.metric)!.params : ratioParamsOf(RATIOS.get(b.ratio)!)
    const windows = isMetric ? metricWindows(METRICS.get(b.metric)!) : ratioWindowsOf(RATIOS.get(b.ratio)!)
    for (const [name, v] of Object.entries(b.params ?? {})) {
      if (!allowedParams.includes(name as MetricParam)) errors.push(`${where}: param '${name}' not accepted`)
      else if (typeof v === 'string' && !paramValueOk(name as MetricParam, v)) errors.push(`${where}: unknown ${name} '${v}'`)
    }
    for (const p of allowedParams) {
      if (OPTIONAL_PARAMS.has(p)) continue
      if (b.params?.[p] === undefined && !scope.has(p)) errors.push(`${where}: param '${p}' is neither set nor provided by a repeat`)
    }
    // The windows this binding reads: its own, the repeat's (`{ scope: 'window' }`), or the default.
    let asked: string[] = [windows[0]]
    if (b.window !== undefined) {
      if (typeof b.window === 'object' && b.window !== null && (b.window as { scope?: unknown }).scope === 'window' && Object.keys(b.window).length === 1) {
        const wr = repeats.find((r) => r?.over === 'windows')
        if (!wr) errors.push(`${where}: window { scope: 'window' } needs a repeat over windows`)
        asked = wr ? ((wr.ids?.length ? wr.ids : ['before', 'after']) as string[]) : []
        for (const w of asked) if (!windows.includes(w as WindowName)) errors.push(`${where}: window '${w}' not allowed (${windows.join(', ')})`)
      } else if (typeof b.window !== 'string' || !SERVED_WINDOWS.has(b.window)) {
        errors.push(`${where}: window ${JSON.stringify(b.window)} is not served`)
      } else {
        asked = [b.window]
        if (!windows.includes(b.window as WindowName)) errors.push(`${where}: window '${b.window}' not allowed (${windows.join(', ')})`)
      }
    }
    if ((b.params?.country !== undefined || scope.has('country')) && allowedParams.includes('country') && !asked.every((w) => countrySplittable(sidesOf(b), w))) {
      errors.push(`${where}: a country split needs the campaign attribution window`)
    }
    if (d.as === 'number' && d.deltas?.length) {
      const w = b.window ?? windows[0]
      if (!isMetric || k !== 'count' || w !== 'todaySoFar') errors.push(`${where}: deltas need a count metric over 'todaySoFar'`)
    }
  }
  function scopeOf(...repeats: (RepeatSpec | undefined)[]): Set<MetricParam> {
    return new Set(repeats.map((r) => (r && Object.hasOwn(SCOPE_PARAM, r.over) ? SCOPE_PARAM[r.over] : null)).filter((p): p is MetricParam => !!p))
  }

  if (spec.showUpdated !== undefined && typeof spec.showUpdated !== 'boolean' && spec.showUpdated !== 'header' && spec.showUpdated !== 'footer') errors.push("card: showUpdated must be a boolean, 'header' or 'footer'")
  if (spec.actions !== undefined && (!Array.isArray(spec.actions) || !spec.actions.every((a) => CARD_ACTIONS.has(a)))) errors.push(`card: actions must be a list of ${[...CARD_ACTIONS].join(', ')}`)
  checkRepeat('card', spec.repeat)
  checkLabel('card.title', spec.title, false)
  for (const id of spec.captions ?? []) checkNote('card.captions', id)
  if (spec.badge) {
    if (!('field' in spec.badge.data)) errors.push('badge: must bind a field')
    check('badge', spec.badge.data, spec.badge.display, [spec.repeat])
  }
  spec.sections?.forEach((s, si) => {
    const where = `sections[${si}]`
    if (!['rows', 'pills', 'tiles', 'bars', 'columns', 'table'].includes(s.layout)) errors.push(`${where}: unknown layout '${String(s.layout)}'`)
    checkRepeat(where, s.repeat)
    checkLabel(`${where}.title`, s.title, false)
    if (s.columns !== undefined || s.columnLabel !== undefined) {
      if (s.layout !== 'table') errors.push(`${where}: columns are for a 'table' section`)
      if (s.repeat && s.columns) errors.push(`${where}: a table repeats its rows or its columns, not both`)
      checkRepeat(`${where}.columns`, s.columns)
      checkLabel(`${where}.columnLabel`, s.columnLabel, false)
    }
    if (s.rowsLabel !== undefined) {
      if (!s.columns) errors.push(`${where}: rowsLabel heads a column table's row labels; it needs columns`)
      checkLabel(`${where}.rowsLabel`, s.rowsLabel, false)
    }
    const ids = new Set<string>()
    for (const it of s.items ?? []) {
      const w = `${where}.${it.id}`
      if (ids.has(it.id)) errors.push(`${w}: duplicate item id`)
      ids.add(it.id)
      checkRepeat(w, it.repeat)
      checkLabel(`${w}.label`, it.label, !('field' in it.data))
      checkLabel(`${w}.caption`, it.caption, !('field' in it.data))
      check(w, it.data, it.display, [spec.repeat, s.repeat, s.columns, it.repeat])
      if (it.gating?.minCohort != null && it.gating.minCohort < MIN_COHORT) errors.push(`${w}: minCohort below MIN_COHORT`)
      if (it.captionMode !== undefined && it.captionMode !== 'inline' && it.captionMode !== 'compact') errors.push(`${w}: captionMode must be 'inline' or 'compact'`)
      const empty = it.gating?.whenEmpty
      if (empty && typeof empty === 'object') checkNote(`${w}.gating.whenEmpty`, empty.note)
      if (it.gating?.whenZero !== undefined && it.gating.whenZero !== 'omit') errors.push(`${w}: whenZero must be 'omit'`)
      const ns = it.gating?.whenNotStarted
      if (ns !== undefined && ns !== 'label' && ns !== 'zero') errors.push(`${w}: whenNotStarted must be 'label' or 'zero'`)
      if (it.frame !== undefined && !['row', 'pill', 'tile', 'column'].includes(it.frame)) errors.push(`${w}: unknown frame '${String(it.frame)}'`)
    }
  })
  return errors
}

// ── normCardRef (load-time: a widget's saved `card`) ───────────────────────────────────────
/** The preset id a card that failed validation is replaced with: MetricCard renders a short
 * "can't be shown" message for it, so a bad saved card is a placeholder, never a crash. */
export const INVALID_CARD_PRESET = 'invalid-card'
export const CARD_LIMITS = { sections: 8, items: 40, stringLength: 200, jsonBytes: 16 * 1024 } as const
const PRESET_ID_RE = /^[a-z0-9-]{1,64}$/

function withinLimits(v: unknown, depth = 0): boolean {
  if (depth > 12) return false
  if (typeof v === 'string') return v.length <= CARD_LIMITS.stringLength
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'boolean' || v === null) return true
  if (Array.isArray(v)) return v.length <= 64 && v.every((x) => withinLimits(x, depth + 1))
  if (typeof v === 'object') return Object.keys(v as object).length <= 32 && Object.values(v as object).every((x) => withinLimits(x, depth + 1))
  return false
}

/** Metrics removed from the registry. A saved custom card (a copy of a preset made before the
 * removal) may still carry an item bound to one; such items are dropped on load, and a section
 * left empty goes with them, so the card loads without it instead of turning invalid. */
const RETIRED_METRICS: ReadonlySet<string> = new Set(['bsk.deferredCompletions'])
function dropRetiredItems(spec: CardSpec): CardSpec {
  if (!spec || !Array.isArray(spec.sections)) return spec
  const retired = (it: unknown): boolean => {
    const m = (it as { data?: { metric?: unknown } } | null)?.data?.metric
    return typeof m === 'string' && RETIRED_METRICS.has(m)
  }
  const sections = spec.sections.flatMap((sec) => {
    if (!sec || !Array.isArray(sec.items) || !sec.items.some(retired)) return [sec]
    const items = sec.items.filter((it) => !retired(it))
    return items.length ? [{ ...sec, items }] : []
  })
  return { ...spec, sections }
}
/** A widget's saved `card`, normalised on every load (lib/defaults.ts normWidget): absent or
 * not an object → undefined (no card); `{ preset }` → kept by id (an unknown id renders as an
 * unknown card, it is never guessed); `{ spec }` → a plain-JSON copy when it is within
 * CARD_LIMITS and passes validateCard, otherwise the INVALID_CARD_PRESET placeholder. Never
 * throws: stored data can be anything. */
export function normCardRef(raw: unknown): CardRef | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if ('preset' in r) return typeof r.preset === 'string' && PRESET_ID_RE.test(r.preset) ? { preset: r.preset } : { preset: INVALID_CARD_PRESET }
  if (!('spec' in r)) return undefined
  // `from` (review fix, 2026-09-27 — the "Reset to preset" data-loss bug): kept ONLY when it is
  // a real, still-resolvable preset id — presetById is already own-key-safe (Object.hasOwn over
  // a null-prototype PRESETS), so a prototype-named id ('constructor', '__proto__') or an id
  // that no longer names a preset both resolve to `undefined` here, same as any other unknown
  // id. Anything else just silently loses its "Reset to preset" shortcut; it never becomes a
  // wrong one — that mistrust is the whole point of normalizing it at all.
  const from = typeof r.from === 'string' && PRESET_ID_RE.test(r.from) && presetById(r.from) ? r.from : undefined
  try {
    const text = JSON.stringify(r.spec)
    if (typeof text !== 'string' || text.length > CARD_LIMITS.jsonBytes) return { preset: INVALID_CARD_PRESET }
    const spec = dropRetiredItems(JSON.parse(text) as CardSpec)
    if (!withinLimits(spec) || !Array.isArray(spec.sections) || spec.sections.length > CARD_LIMITS.sections) return { preset: INVALID_CARD_PRESET }
    const items = spec.sections.reduce((n, sec) => n + (Array.isArray(sec?.items) ? sec.items.length : Infinity), 0)
    if (items > CARD_LIMITS.items) return { preset: INVALID_CARD_PRESET }
    if (validateCard(spec).length) return { preset: INVALID_CARD_PRESET }
    return from ? { spec, from } : { spec }
  } catch {
    return { preset: INVALID_CARD_PRESET }
  }
}

// ── validateMetricsRequest (the server whitelist) ─────────────────────────────────────────
export interface ResolvedRequest {
  key: string
  kind: 'metric' | 'ratio'
  id: string
  params: { campaignId?: string; popup?: string; country?: string }
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

/** WHEN_RE's shape AND a real calendar day and clock time: '2026-02-30' (which Date.parse rolls
 * over to March 2), '2026-99-99' and 'T25:61' are all refused. */
function isRealWhen(v: string): boolean {
  if (!WHEN_RE.test(v)) return false
  const day = v.slice(0, 10)
  if (addDays(day, 0) !== day) return false
  const t = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(v)
  return !t || (Number(t[1]) <= 23 && Number(t[2]) <= 59 && (t[3] === undefined || Number(t[3]) <= 59))
}

const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** The MAX_RANGE_DAYS cap. Two bare dates are a count of ET calendar days (both inclusive), not
 * milliseconds: a range spanning one more fall-back than spring-forward is an hour longer than
 * its days × 24 h and must not be refused for it. Anything with a clock time is measured. */
function rangeTooLong(since: string, until: string, a: number, b: number): boolean {
  if (BARE_DATE_RE.test(since) && BARE_DATE_RE.test(until)) {
    const days = Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / 86_400_000) + 1
    return days > MAX_RANGE_DAYS
  }
  return b - a > MAX_RANGE_DAYS * 86_400_000
}

function validateContext(raw: unknown): ValidContext | string {
  if (raw === undefined) return { sites: [], excludeOwnVisits: false, ownBrowser: '', ownOS: '' }
  if (!isObj(raw)) return 'context must be an object'
  const extra = only(raw, ['since', 'until', 'sites', 'excludeOwnVisits', 'ownBrowser', 'ownOS'])
  if (extra) return `context.${extra} is not accepted`
  for (const k of ['since', 'until'] as const) {
    if (raw[k] !== undefined && (typeof raw[k] !== 'string' || !isRealWhen(raw[k] as string))) return `context.${k} must be YYYY-MM-DD or an ISO datetime`
  }
  if ((raw.since === undefined) !== (raw.until === undefined)) return 'context.since and context.until go together'
  if (raw.since !== undefined) {
    const [a, b] = rangeMs(raw.since as string, raw.until as string) // how the facts read it (bare dates are ET days)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 'context.since and context.until must be real instants'
    if (a >= b) return 'context.since must be before context.until'
    if (rangeTooLong(raw.since as string, raw.until as string, a, b)) return `context range is longer than ${MAX_RANGE_DAYS} days`
  }
  let sites: string[] = []
  if (raw.sites !== undefined) {
    if (!Array.isArray(raw.sites) || raw.sites.length > MAX_SITES) return `context.sites must be a list of at most ${MAX_SITES} site tags`
    if (!raw.sites.every((s) => typeof s === 'string' && SITE_TAG_RE.test(s))) return 'context.sites contains an invalid site tag'
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
  const kind: DataKind = metric ? metricKind(metric) : ratio!.kind

  const params: ResolvedRequest['params'] = {}
  if (raw.params !== undefined) {
    if (!isObj(raw.params)) return failed(key, 'bad-param')
    for (const [name, v] of Object.entries(raw.params)) {
      if (!allowedParams.includes(name as MetricParam)) return failed(key, 'bad-param')
      if (!paramValueOk(name as MetricParam, v)) return failed(key, 'bad-param')
      params[name as MetricParam] = v as string
    }
  }
  for (const p of allowedParams) if (params[p] === undefined && !OPTIONAL_PARAMS.has(p)) return failed(key, 'missing-param')

  let window = windows[0]
  if (raw.window !== undefined) {
    if (typeof raw.window !== 'string' || !windows.includes(raw.window as WindowName)) return failed(key, 'bad-window')
    window = raw.window as WindowName
  }
  if (window === 'page' && (context.since === undefined || context.until === undefined)) return failed(key, 'missing-range')
  if (params.country !== undefined && !countrySplittable(metric ? [metric] : [METRICS.get(ratio!.num), METRICS.get(ratio!.den)], window)) return failed(key, 'bad-param')

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
