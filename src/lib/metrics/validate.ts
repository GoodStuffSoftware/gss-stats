// Validation for metric components (ADR 0003): validateCard (a CardSpec against the registry:
// ids, params, windows, display compatibility, note ids) and validateMetricsRequest (the
// POST /api/metrics whitelist, section 3). The server never trusts a card config: it only ever
// sees request lists, and every id, param and window in them is checked against the registry
// maps here before anything reaches a fact builder. No free-text param exists.
//
// normCardRef (the load-time normalizer that keeps `widget.card` through lib/defaults.ts
// normWidget) is slice 5, where it is wired into normalizeConfig.

import { MIN_COHORT, POPUPS } from '../popupEvents'
import { CAMPAIGNS, ORGANIC_ARM_ID } from '../campaigns'
import { safeUA } from '../ownExclusion'
import { SITE_TAG_RE, WHEN_RE } from '../range'
import { addDays } from '../etTime'
import { rangeMs } from './facts'
import { METRICS, metricWindows, OPTIONAL_PARAMS, type MetricDef, type MetricParam } from './metrics'
import { seriesTwin } from './series'
import { presetById } from './presets'
import { RATIOS, ratioParamsOf, ratioSupportsOrganic, ratioWindowsOf, type RatioDef } from './ratios'
import { COUNTRY_BUCKETS, isReadingCountPath, MAX_READINGS_LIMIT, WINDOW_SIDES, type CardAction, type CardNotices, type CardRef, type CardSpec, type DataBinding, type DeltaName, type Display, type DisplayAs, type Label, type RepeatSpec, type WindowName } from './types'

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
const CARD_NOTICES: ReadonlySet<string> = new Set<CardNotices>(['ads-readings'])
/** A param value is one of its set: a configured campaign, a registered pop-up, a country bucket.
 * `campaignId` may also be the organic arm (ORGANIC_ARM_ID), but only on a binding that serves it
 * (`organicOk`: bindingSupportsOrganic). */
function paramValueOk(name: MetricParam, v: unknown, organicOk: boolean): boolean {
  if (typeof v !== 'string') return false
  if (name === 'campaignId' && v === ORGANIC_ARM_ID) return organicOk
  return (name === 'campaignId' ? CAMPAIGN_IDS : name === 'popup' ? POPUP_IDS : COUNTRY_IDS).has(v)
}
/** Whether a binding serves the organic arm: a metric that declares it, or a ratio whose BOTH
 * sides do (ratioSupportsOrganic). Unknown ids never do. */
export function bindingSupportsOrganic(b: { metric: string } | { ratio: string }): boolean {
  if ('metric' in b) return !!METRICS.get(b.metric)?.organic
  const r = RATIOS.get(b.ratio)
  return !!r && ratioSupportsOrganic(r)
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
  field: ['dateRange', 'datetime', 'datetime-et', 'badge', 'text', 'number', 'currency'],
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
/** The shape of a notes-registry id ('small-sample', 'label.bsk.gameViews'). A card's note ids
 * (captions, `{ note }` labels, `whenEmpty.note`) are checked for this shape only, never for
 * whether this build's registry has them: adding a registry id takes no layout version, so a tab
 * on an older build loads and saves ids a newer build wrote. An id this build doesn't know is
 * kept as stored and renders as nothing (lib/metrics/render.ts, NoteBlock.vue, MetricCard.vue). */
export const NOTE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const noteIdOk = (id: unknown): boolean => typeof id === 'string' && NOTE_ID_RE.test(id)

/** Errors for a card spec, [] when valid. Runs on load, in the editor and in tests. */
export function validateCard(spec: CardSpec): string[] {
  const errors: string[] = []
  if (!spec || spec.v !== 1) return ['card: v must be 1']
  if (!Array.isArray(spec.sections) || !spec.sections.length) errors.push('card: needs at least one section')
  const checkLabel = (where: string, l: Label | undefined, hasData: boolean) => {
    if (l === undefined || typeof l === 'string') return
    if ('bind' in l) checkScopePath(where, l.bind)
    if ('note' in l && !noteIdOk(l.note)) errors.push(`${where}: ${JSON.stringify(l.note) ?? 'undefined'} is not a note id`)
    if ('metric' in l && !hasData) errors.push(`${where}: { metric: true } needs a metric or ratio binding`)
  }
  // A reading's counts are an allow-list (types.ts READING_COUNT_FIELDS): any other
  // `reading.count.*` path is refused, so a return / game-start / tutorial / tour total of a
  // stored record can never be bound from a card.
  const checkScopePath = (where: string, path: unknown) => {
    if (typeof path === 'string' && path.startsWith('reading.count.') && !isReadingCountPath(path)) errors.push(`${where}: '${path}' is not a reading count a card may show`)
  }
  const checkNote = (where: string, id: unknown) => {
    if (!noteIdOk(id)) errors.push(`${where}: ${JSON.stringify(id) ?? 'undefined'} is not a note id`)
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
    if (r.limit !== undefined && (r.over !== 'readings' || typeof r.limit !== 'number' || !Number.isInteger(r.limit) || r.limit < 1 || r.limit > MAX_READINGS_LIMIT)) {
      errors.push(`${where}.repeat: limit is for readings, a whole number from 1 to ${MAX_READINGS_LIMIT}`)
    }
    if (r.withActivity !== undefined && (r.withActivity !== true || r.over !== 'campaigns')) errors.push(`${where}.repeat: withActivity is for campaigns, and only true`)
    if (r.tracked !== undefined && (r.tracked !== true || r.over !== 'campaigns')) errors.push(`${where}.repeat: tracked is for campaigns, and only true`)
    // The organic arm rides only on a campaigns repeat; bindings that don't serve it are left out
    // of its instance (scope.ts configRuling), never requested.
    if (r.organic !== undefined && (r.organic !== true || r.over !== 'campaigns')) errors.push(`${where}.repeat: organic is for campaigns, and only true`)
    // The organic row is always there, so it would hide a flightingToday repeat's empty state.
    else if (r.organic && r.flightingToday) errors.push(`${where}.repeat: organic cannot combine with flightingToday`)
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
    if ('field' in b) return void checkScopePath(where, b.field)
    const isMetric = 'metric' in b
    const allowedParams = isMetric ? METRICS.get(b.metric)!.params : ratioParamsOf(RATIOS.get(b.ratio)!)
    const windows = isMetric ? metricWindows(METRICS.get(b.metric)!) : ratioWindowsOf(RATIOS.get(b.ratio)!)
    for (const [name, v] of Object.entries(b.params ?? {})) {
      if (!allowedParams.includes(name as MetricParam)) errors.push(`${where}: param '${name}' not accepted`)
      else if (typeof v === 'string' && !paramValueOk(name as MetricParam, v, bindingSupportsOrganic(b))) errors.push(`${where}: unknown ${name} '${v}'`)
    }
    // A country repeat or country columns over a binding that takes no country param would split
    // it by place: the counts-only rule (lib/splitGuard.ts) refuses that for completions, so the
    // card is refused here rather than the request failing later.
    if (scope.has('country') && !allowedParams.includes('country')) errors.push(`${where}: a country repeat or columns over a binding that takes no country param`)
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
    if (d.as === 'sparkline') {
      // A series is the metric's own count (or spend) per ET day: never a ratio (no per-day rate
      // escapes MIN_COHORT), never a country split, only a ranged window with a daily twin fact.
      if (!isMetric) errors.push(`${where}: a sparkline needs a count or money metric, not a ratio`)
      else {
        const def = METRICS.get(b.metric)!
        if (asked.some((w) => !seriesTwin(def, w as WindowName))) errors.push(`${where}: a sparkline needs the page or attribution window over a metric with daily data`)
      }
      if (b.params?.country !== undefined || scope.has('country')) errors.push(`${where}: a sparkline cannot be split by country`)
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
  if (spec.notices !== undefined && !CARD_NOTICES.has(spec.notices)) errors.push(`card: notices must be one of ${[...CARD_NOTICES].join(', ')}`)
  checkRepeat('card', spec.repeat)
  checkLabel('card.title', spec.title, false)
  if (spec.captions !== undefined && !Array.isArray(spec.captions)) errors.push('card.captions: must be a list of note ids')
  else for (const id of spec.captions ?? []) checkNote('card.captions', id)
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
      if (empty && typeof empty === 'object') checkNote(`${w}.gating.whenEmpty`, (empty as { note?: unknown }).note)
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
/** A saved card's size limits. normCardRef (on load) and the card editor's Save gate both check
 * them through cardLimitProblems, so a card the editor saves always loads. `jsonBytes` counts the
 * characters of the card's JSON. */
export const CARD_LIMITS = { sections: 8, items: 40, stringLength: 200, jsonBytes: 16 * 1024, objectKeys: 32, arrayLength: 64, depth: 12 } as const
const PRESET_ID_RE = /^[a-z0-9-]{1,64}$/

/** Where a value sits in a card, in validateCard's own `where` style so the editor's groupErrors
 * files it under its section or item: `sections[0].<item id>.label`, `card.badge.display`. */
function limitWhere(data: unknown, path: readonly (string | number)[]): string {
  if (path[0] !== 'sections' || typeof path[1] !== 'number') return path.length ? `card.${path.join('.')}` : 'card'
  let where = `sections[${path[1]}]`
  let rest = path.slice(2)
  if (rest[0] === 'items' && typeof rest[1] === 'number') {
    const id = (data as { sections?: ({ items?: ({ id?: unknown } | null)[] } | null)[] }).sections?.[path[1]]?.items?.[rest[1]]?.id
    where += typeof id === 'string' ? `.${id}` : `.items[${rest[1]}]`
    rest = rest.slice(2)
  }
  return rest.length ? `${where}.${rest.join('.')}` : where
}

/** Every way a card spec breaks CARD_LIMITS, [] when it fits: its JSON size, the section and item
 * counts, and anywhere in it a string, object or array over its limit or nesting too deep. It
 * checks the card as it would be saved (its JSON), and never throws. normCardRef refuses any card
 * this flags, and the card editor's Save gate runs it next to validateCard, so the editor can't
 * save a card that would load as the placeholder. */
export function cardLimitProblems(spec: unknown): string[] {
  let text: string | undefined
  try {
    text = JSON.stringify(spec)
  } catch {
    return ['card: not plain data']
  }
  if (typeof text !== 'string') return ['card: not plain data']
  if (text.length > CARD_LIMITS.jsonBytes) return [`card: too large to save (${text.length.toLocaleString('en-US')} characters of data; up to ${CARD_LIMITS.jsonBytes.toLocaleString('en-US')})`]
  const data = JSON.parse(text) as unknown
  const problems: string[] = []
  const walk = (v: unknown, path: (string | number)[], depth: number): void => {
    if (depth > CARD_LIMITS.depth) return void problems.push(`${limitWhere(data, path)}: nested more than ${CARD_LIMITS.depth} levels deep`)
    if (typeof v === 'string') {
      if (v.length > CARD_LIMITS.stringLength) problems.push(`${limitWhere(data, path)}: up to ${CARD_LIMITS.stringLength} characters (this is ${v.length})`)
      return
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) problems.push(`${limitWhere(data, path)}: not a finite number`)
      return
    }
    if (typeof v === 'boolean' || v === null) return
    if (Array.isArray(v)) {
      if (v.length > CARD_LIMITS.arrayLength) problems.push(`${limitWhere(data, path)}: up to ${CARD_LIMITS.arrayLength} entries (this has ${v.length})`)
      v.forEach((x, i) => walk(x, [...path, i], depth + 1))
      return
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v as object)
      if (keys.length > CARD_LIMITS.objectKeys) {
        const tones = path.length === 3 && path[0] === 'badge' && path[1] === 'display' && path[2] === 'tones'
        problems.push(tones ? `Badge colours: up to ${CARD_LIMITS.objectKeys} (this card has ${keys.length})` : `${limitWhere(data, path)}: up to ${CARD_LIMITS.objectKeys} settings (this has ${keys.length})`)
      }
      for (const k of keys) walk((v as Record<string, unknown>)[k], [...path, k], depth + 1)
      return
    }
    problems.push(`${limitWhere(data, path)}: not plain data`)
  }
  walk(data, [], 0)
  const sections = (data as { sections?: unknown } | null)?.sections
  if (!Array.isArray(sections)) problems.push('card: sections must be a list')
  else {
    if (sections.length > CARD_LIMITS.sections) problems.push(`card: up to ${CARD_LIMITS.sections} sections (this card has ${sections.length})`)
    const items = sections.reduce<number>((n, sec) => {
      const list = (sec as { items?: unknown } | null)?.items
      return n + (Array.isArray(list) ? list.length : Infinity)
    }, 0)
    if (items === Infinity) problems.push('card: every section needs a list of items')
    else if (items > CARD_LIMITS.items) problems.push(`card: up to ${CARD_LIMITS.items} items in all (this card has ${items})`)
  }
  return problems
}

/** Metrics removed from the registry. A saved custom card (a copy of a preset made before the
 * removal) may still carry an item bound to one; such items are dropped on load, and a section
 * left empty goes with them, so the card loads without it instead of turning invalid. */
const RETIRED_METRICS: ReadonlySet<string> = new Set(['bsk.deferredCompletions'])
/** Whether a repeat spec (stored data: anything) repeats over countries. */
const overCountries = (r: unknown): boolean => !!r && typeof r === 'object' && (r as { over?: unknown }).over === 'countries'
/** A KNOWN metric or ratio that takes no country param (an unknown id is left for validateCard
 * to refuse). */
function takesNoCountry(it: unknown): boolean {
  const d = (it as { data?: { metric?: unknown; ratio?: unknown } } | null)?.data
  if (typeof d?.metric === 'string') {
    const m = METRICS.get(d.metric)
    return !!m && !m.params.includes('country')
  }
  if (typeof d?.ratio === 'string') {
    const r = RATIOS.get(d.ratio)
    return !!r && !ratioParamsOf(r).includes('country')
  }
  return false
}
/** Drops, on load, items bound to a retired metric, and items under a country repeat or country
 * columns whose metric no longer takes a country param (R-1b: campaign.completions, in a copy of
 * the campaign-country card saved before the change). A section left empty goes with them, so
 * the card loads without them instead of turning invalid. */
function dropRetiredItems(spec: CardSpec): CardSpec {
  if (!spec || !Array.isArray(spec.sections)) return spec
  const cardCountries = overCountries(spec.repeat)
  const sections = spec.sections.flatMap((sec) => {
    if (!sec || !Array.isArray(sec.items)) return [sec]
    const secCountries = cardCountries || overCountries(sec.repeat) || overCountries(sec.columns)
    const drop = (it: unknown): boolean => {
      const m = (it as { data?: { metric?: unknown } } | null)?.data?.metric
      if (typeof m === 'string' && RETIRED_METRICS.has(m)) return true
      return (secCountries || overCountries((it as { repeat?: unknown } | null)?.repeat)) && takesNoCountry(it)
    }
    if (!sec.items.some(drop)) return [sec]
    const items = sec.items.filter((it) => !drop(it))
    return items.length ? [{ ...sec, items }] : []
  })
  return { ...spec, sections }
}
/** Downgrades, on load, a stored sparkline item that cannot be drawn (a window with no daily
 * twin such as today so far, a country split, a window main's editor never refused) to the plain
 * form the item shows without it: Number for a count, Currency for money. Same shape as
 * dropRetiredItems: one bad item costs only its sparkline, never the whole card. Only a count or
 * money metric is downgraded (the plain form of anything else is not a guess to make); the editor
 * still refuses to CREATE an undrawable sparkline (editorModel sparklineBlocker). */
function downgradeUndrawableSparklines(spec: CardSpec): CardSpec {
  if (!spec || !Array.isArray(spec.sections)) return spec
  const bad = validateCard(spec).filter((e) => e.includes('sparkline'))
  if (!bad.length) return spec
  const sections = spec.sections.map((sec, si) => {
    if (!sec || !Array.isArray(sec.items)) return sec
    const items = sec.items.map((it) => {
      if (it?.display?.as !== 'sparkline' || !bad.some((e) => e.startsWith(`sections[${si}].${it.id}: `))) return it
      const k = kindOf(it.data)
      if (k !== 'count' && k !== 'money') return it
      return { ...it, display: k === 'money' ? { as: 'currency' as const } : { as: 'number' as const } }
    })
    return { ...sec, items }
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
    const spec = downgradeUndrawableSparklines(dropRetiredItems(JSON.parse(text) as CardSpec))
    if (cardLimitProblems(spec).length) return { preset: INVALID_CARD_PRESET }
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
  /** 'daily': the request also wants the metric's per-ET-day series (lib/metrics/series.ts). */
  series?: 'daily'
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
  if (only(raw, ['key', 'metric', 'ratio', 'params', 'window', 'deltas', 'series', 'minCohort'])) return failed(key, 'bad-request')
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
      if (!paramValueOk(name as MetricParam, v, metric ? !!metric.organic : ratioSupportsOrganic(ratio!))) return failed(key, 'bad-param')
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

  let series: 'daily' | undefined
  if (raw.series !== undefined) {
    // Only a metric (never a ratio: no per-day rate), with no country split, in a ranged window
    // that has a daily twin fact (lib/metrics/series.ts seriesTwin).
    if (raw.series !== 'daily' || !metric || params.country !== undefined || seriesTwin(metric, window) === null) return failed(key, 'bad-series')
    series = 'daily'
  }

  let minCohort = MIN_COHORT
  if (raw.minCohort !== undefined) {
    if (typeof raw.minCohort !== 'number' || !Number.isInteger(raw.minCohort) || raw.minCohort < 1 || raw.minCohort > 1_000_000) return failed(key, 'bad-param')
    if (kind !== 'proportion' && kind !== 'cost') return failed(key, 'bad-param')
    minCohort = Math.max(MIN_COHORT, raw.minCohort) // may only RAISE the floor
  }
  return { key, ok: true, req: { key, kind: metric ? 'metric' : 'ratio', id, params, window, deltas, ...(series ? { series } : {}), minCohort } }
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
