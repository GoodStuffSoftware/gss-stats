// Pure draft-building helpers for CardEditor.vue (ADR 0003 slice 6, "Editor UX"). Kept out of
// the .vue files so the draft <-> CardSpec mapping — label/data/display kind switches, id
// generation, reordering — is table-testable without mounting a component (editorModel.test.ts).
//
// Every id a user can pick (metric, ratio, campaign, popup, note, scope path) comes from one of
// the fixed lists below, built from the real registries (METRICS/RATIOS Maps, CAMPAIGNS/POPUPS
// arrays, hasNote's own-key check) — never from a bracket lookup on user-typed text. That is
// what keeps a prototype-named string ('constructor', '__proto__', 'toString') from ever being
// selectable: it simply doesn't appear in any option list, and Map#get/Array#find return
// `undefined` for it rather than resolving through Object.prototype (editorModel.test.ts checks
// this directly). Item/section ids are generated here too, never typed by the user, for the
// same reason.
import { CAMPAIGNS } from '../campaigns'
import { getNote, hasNote, NOTES_REGISTRY, noteOptions, noteRawText } from '../notes'
import { POPUPS } from '../popupEvents'
import { METRICS, metricWindows, type MetricDef, type MetricParam } from './metrics'
import { RATIOS, ratioParamsOf, ratioWindowsOf, type RatioDef } from './ratios'
import { DISPLAYS_FOR, kindOf, type DataKind } from './validate'
import { WINDOW_SIDES } from './types'
import type { CardSpec, DataBinding, Display, DisplayAs, Gating, Label, MetricItem, ParamValue, Params, RepeatSpec, ScopePath, Section, WindowName, WindowSpec } from './types'
import { PRESETS, presetById } from './presets'

// ── Ids: generated, never typed ───────────────────────────────────────────────────────────
let idCounter = 0
export function freshId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${idCounter}-${Date.now().toString(36)}`
}

// ── Reordering (sections, items) ──────────────────────────────────────────────────────────
export function reorder<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list]
  const out = [...list]
  const [moved] = out.splice(from, 1)
  out.splice(to, 0, moved)
  return out
}
export function moveBy<T>(list: readonly T[], index: number, dir: -1 | 1): T[] {
  return reorder(list, index, index + dir)
}

// ── Default drafts ─────────────────────────────────────────────────────────────────────────
const firstMetricId = (): string => METRICS.keys().next().value ?? ''

export function emptyItem(): MetricItem {
  return { id: freshId('item'), label: '', data: { metric: firstMetricId() }, display: { as: 'number' } }
}
export function emptySection(): Section {
  return { layout: 'rows', items: [emptyItem()] }
}
export function emptySpec(): CardSpec {
  return { v: 1, sections: [emptySection()] }
}
export function duplicateItem(item: MetricItem): MetricItem {
  return { ...cloneJson(item), id: freshId('item') }
}
/** A deep copy via a JSON round-trip, not `structuredClone`: every value CardEditor clones
 * (CardSpec, MetricItem, …) is JSON-safe by construction (Label/DataBinding/Display/RepeatSpec
 * are all plain strings/numbers/booleans/plain objects — the same shape `POST /api/metrics` and
 * KV storage already require), and `structuredClone` throws ("DataCloneError") on a Vue
 * `reactive()` proxy in at least one runtime this app tests under (happy-dom) — CardEditor.vue
 * passes reactive proxies here whenever the caller's own prop value is itself reactive (a normal
 * thing for a `v-model`-bound component to receive). JSON.stringify already reads straight
 * through a proxy (see CardEditor.vue's fingerprint), so this sidesteps the whole issue instead
 * of chasing `toRaw()` through every call site. */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
/** A deep, editable copy of a preset (or the given spec) — "the first edit to a preset copies
 * it into an explicit spec" (ADR section 4). Never the live PRESETS object: mutating that would
 * corrupt every other widget using the preset. */
export function cloneSpec(spec: CardSpec): CardSpec {
  return cloneJson(spec)
}
export function specFromPresetId(id: string): CardSpec {
  return cloneSpec(presetById(id) ?? emptySpec())
}
export interface PresetOption {
  value: string
  label: string
  description: string
}
/** Preset ids, with their plain-language name and one-line description from the notes registry
 * (`label.preset.<id>` / `label.preset.<id>.description`) — never the raw id, and never an
 * auto-humanized guess at one (review fix, 2026-09-27: the picker used to show "Bsk Kpis").
 * Every preset in lib/metrics/presets.ts PRESETS needs both entries registered in notes.ts; a
 * preset without one falls back to its id here rather than crashing, but that is a registry gap
 * to fix, not a supported permanent state — own keys only (PRESETS is null-prototype;
 * Object.keys is already own-key-safe). */
export function presetOptions(): PresetOption[] {
  return Object.keys(PRESETS).map((id) => ({
    value: id,
    label: hasNote(`label.preset.${id}`) ? noteRawText(`label.preset.${id}`) : id,
    description: hasNote(`label.preset.${id}.description`) ? noteRawText(`label.preset.${id}.description`) : '',
  }))
}

// ── Label kind ─────────────────────────────────────────────────────────────────────────────
export type LabelKind = 'text' | 'metric' | 'note' | 'bind'
export function labelKind(label: Label | undefined): LabelKind {
  if (label === undefined || typeof label === 'string') return 'text'
  if ('metric' in label) return 'metric'
  if ('note' in label) return 'note'
  return 'bind'
}
/** Switches a Label to a new kind, keeping whatever of the previous value still applies (e.g.
 * re-picking 'note' after 'note' keeps the chosen note id). Round-trips: labelKind(makeLabel(k,
 * l)) === k for every kind (editorModel.test.ts). */
export function makeLabel(kind: LabelKind, current: Label | undefined, fallbackScopePath: ScopePath): Label {
  switch (kind) {
    case 'text':
      return typeof current === 'string' ? current : ''
    case 'metric':
      return { metric: true }
    case 'note': {
      // Re-picking 'note' on a note label keeps it whole — its id AND its `vars` (a preset's
      // "{campaign}" binding), never a bare `{ note }` that would render the placeholder raw.
      if (current !== undefined && typeof current === 'object' && 'note' in current) return current.vars ? { note: current.note, vars: { ...current.vars } } : { note: current.note }
      return { note: '' }
    }
    case 'bind': {
      const path = current !== undefined && typeof current === 'object' && 'bind' in current ? current.bind : fallbackScopePath
      return { bind: path }
    }
  }
}

/** A note label with a different note id, keeping the `vars` it already binds (the owner
 * removes a var explicitly in the Variables list, never as a side effect of re-picking). */
export function withNoteId(current: Label | undefined, id: string): Label {
  const vars = current !== undefined && typeof current === 'object' && 'note' in current ? current.vars : undefined
  return vars ? { note: id, vars: { ...vars } } : { note: id }
}

// ── Scope paths (for a `bind` label or a `field` data binding) — a fixed, curated list per
// repeat kind, never derived from user text. ──────────────────────────────────────────────
export const SCOPE_PATH_OPTIONS: Record<RepeatSpec['over'], { value: ScopePath; label: string }[]> = {
  campaigns: [
    { value: 'campaign.id', label: 'Campaign id' },
    { value: 'campaign.label', label: 'Campaign name' },
    { value: 'campaign.status', label: 'Status' },
    { value: 'campaign.statusToday', label: 'Status (today)' },
    { value: 'campaign.flight', label: 'Flight dates' },
    { value: 'campaign.measurabilityNote', label: 'Measurability note' },
    { value: 'campaign.upsellFixAt', label: 'Upsell fix time' },
    { value: 'campaign.upsellFixFlightDay', label: 'Upsell fix flight day' },
    { value: 'campaign.returnTagShared', label: 'Shared return tag note' },
  ],
  popups: [
    { value: 'popup.id', label: 'Pop-up id' },
    { value: 'popup.label', label: 'Pop-up name' },
  ],
  windows: [
    { value: 'window.label', label: 'Window label (Before / After)' },
    { value: 'release.label', label: 'Release (version and date)' },
  ],
  countries: [{ value: 'country.label', label: 'Country (US / CA / Other)' }],
  readings: [
    { value: 'reading.readAt', label: 'Read at' },
    { value: 'reading.kind', label: 'Reading kind' },
    { value: 'reading.spend', label: 'Spend' },
    { value: 'reading.rules', label: 'Rules' },
    { value: 'reading.proposal', label: 'Proposal' },
  ],
}
export function scopePathOptions(over: RepeatSpec['over'] | undefined): { value: ScopePath; label: string }[] {
  return over ? SCOPE_PATH_OPTIONS[over] : []
}
/** A ScopePath's plain label, from the SAME table the pickers use — flattened once, since a path
 * string is unique across every repeat kind (e.g. 'campaign.label' only ever appears under
 * 'campaigns'). Used wherever a bound field needs to be named back to the owner outside its own
 * picker (the item summary line, a label-kind switch) — never the bare path string itself. */
const ALL_SCOPE_PATH_LABELS: ReadonlyMap<string, string> = new Map(Object.values(SCOPE_PATH_OPTIONS).flat().map((o) => [o.value, o.label]))
export function scopePathLabel(path: ScopePath): string {
  return ALL_SCOPE_PATH_LABELS.get(path) ?? 'Unknown field'
}

// ── Notes (for a `note` label, or a caption) — plain-text previews only: noteRawText strips
// markup and resolves the note's own default vars, so no raw `**`/`{var}` ever shows in a
// picker. `noteOptions()` already excludes 'label'-kind entries (UI names, never a caption). ──
export interface NoteOption {
  value: string
  preview: string
}
export function noteLabelOptions(): NoteOption[] {
  return noteOptions().map((o) => ({ value: o.value, preview: noteRawText(o.value) || o.value }))
}
export function isKnownNote(id: string): boolean {
  return hasNote(id)
}
/** A note's plain-text name for the editor, of ANY kind (a caption or a label entry such as a
 * funnel step's name), `{vars}` shown as "…"; null for an id that is not a note. The item summary
 * line and the pickers read it, so a preset's label notes never show as "Unknown note". */
export function notePreview(id: string): string | null {
  if (!hasNote(id)) return null
  return (noteRawText(id) || id).replace(/\{[A-Za-z0-9_.]+\}/g, '…')
}
/** The note picker for a LABEL (an item's label, a section or card title): the caption notes plus
 * the label entries (metric and funnel-step names, card labels; not the preset names or the unit
 * words), and always `current` when it is a real note, so an existing pick is never blank. */
export function labelNoteOptions(current?: string): NoteOption[] {
  const out = noteLabelOptions()
  const seen = new Set(out.map((o) => o.value))
  for (const n of Object.values(NOTES_REGISTRY)) {
    if (n.kind !== 'label' || n.id.startsWith('label.preset.') || n.id.startsWith('unit.') || seen.has(n.id)) continue
    seen.add(n.id)
    out.push({ value: n.id, preview: notePreview(n.id)! })
  }
  if (current && !seen.has(current) && getNote(current)) out.push({ value: current, preview: notePreview(current)! })
  return out
}

// ── Data kind ──────────────────────────────────────────────────────────────────────────────
export type DataBindingKind = 'metric' | 'ratio' | 'field'
export function dataBindingKind(b: DataBinding): DataBindingKind {
  if ('field' in b) return 'field'
  return 'metric' in b ? 'metric' : 'ratio'
}
export function makeData(kind: DataBindingKind, current: DataBinding, fallbackScopePath: ScopePath): DataBinding {
  switch (kind) {
    case 'metric':
      return 'metric' in current ? current : { metric: firstMetricId() }
    case 'ratio':
      return 'ratio' in current ? current : { ratio: RATIOS.keys().next().value ?? '' }
    case 'field':
      return 'field' in current ? current : { field: fallbackScopePath }
  }
}

/** The windows and params a metric or ratio id accepts ([] for an unknown id). */
function acceptsOf(b: { metric: string } | { ratio: string }): { windows: WindowName[]; params: MetricParam[] } | null {
  if ('metric' in b) {
    const def = METRICS.get(b.metric)
    return def ? { windows: metricWindows(def), params: def.params } : null
  }
  const r = RATIOS.get(b.ratio)
  return r ? { windows: ratioWindowsOf(r), params: ratioParamsOf(r) } : null
}
/** Picks a metric or ratio id, keeping what the current binding already set whenever the new id
 * still accepts it: re-picking the SAME id is a no-op (the current binding, window and params
 * intact), and switching to another id keeps each param it accepts and the window when it serves
 * it (a `{ scope: 'window' }` binding when it serves a before/after side). Anything the new id
 * does not accept is dropped, so the result never trips validateCard for a leftover. */
export function rebindData(current: DataBinding, next: { metric: string } | { ratio: string }): DataBinding {
  if ('metric' in next && 'metric' in current && current.metric === next.metric) return current
  if ('ratio' in next && 'ratio' in current && current.ratio === next.ratio) return current
  if ('field' in current) return next
  const acc = acceptsOf(next)
  if (!acc) return next
  const out: { metric?: string; ratio?: string; params?: Params; window?: WindowSpec } = { ...next }
  const params: Params = {}
  for (const [k, v] of Object.entries(current.params ?? {})) if (acc.params.includes(k as MetricParam)) params[k as MetricParam] = v
  if (Object.keys(params).length) out.params = params
  const w = current.window
  if (typeof w === 'string' ? acc.windows.includes(w as WindowName) : w !== undefined && acc.windows.some((x) => (WINDOW_SIDES as readonly string[]).includes(x))) out.window = w
  return out as DataBinding
}

// ── Metric / ratio pickers — grouped, plain-language options built ONLY from the real
// registries (Maps), so an unknown/prototype-named id can never appear as an option. ────────
export interface MetricOption {
  id: string
  label: string
  unit: string
  family: string
}
function familyOf(id: string): string {
  const prefix = id.slice(0, id.indexOf('.'))
  return prefix === 'campaign' ? 'Campaign' : prefix === 'bsk' ? 'Today (site-wide)' : prefix === 'popup' ? 'Pop-ups' : 'Other'
}
let metricOptionsCache: MetricOption[] | null = null
export function metricOptions(): MetricOption[] {
  if (!metricOptionsCache) {
    metricOptionsCache = [...METRICS.values()].map((m) => ({ id: m.id, label: noteRawText(m.label) || m.id, unit: m.unit, family: familyOf(m.id) }))
  }
  return metricOptionsCache
}
export interface RatioOption {
  id: string
  label: string
  kind: RatioDef['kind']
  num: string
  den: string
  summary: string
}
function ratioSummary(r: RatioDef): string {
  const numLabel = METRICS.get(r.num) ? noteRawText(METRICS.get(r.num)!.label) || r.num : r.num
  const denLabel = METRICS.get(r.den) ? noteRawText(METRICS.get(r.den)!.label) || r.den : r.den
  if (r.kind === 'proportion') return `${numLabel} ÷ ${denLabel} (same ${METRICS.get(r.den)?.unit ?? ''})`
  if (r.kind === 'cost') return `${numLabel} per ${denLabel}`
  return `${numLabel} and ${denLabel} — counts only`
}
let ratioOptionsCache: RatioOption[] | null = null
export function ratioOptions(): RatioOption[] {
  if (!ratioOptionsCache) {
    ratioOptionsCache = [...RATIOS.values()].map((r) => ({ id: r.id, label: noteRawText(r.label) || r.id, kind: r.kind, num: r.num, den: r.den, summary: ratioSummary(r) }))
  }
  return ratioOptionsCache
}
export function metricDef(id: string): MetricDef | undefined {
  return METRICS.get(id)
}
export function ratioDef(id: string): RatioDef | undefined {
  return RATIOS.get(id)
}
/** "campaign" / "site-wide" / "pop-up" — the id's own namespace prefix, spelled out, purely to
 * disambiguate two metrics that would otherwise share a short plain name (e.g. "Tagged arrivals"
 * meaning something different per family is unlikely today, but the summary line shows it on
 * every metric/ratio regardless, so it never has to guess when it WOULD matter). '' for a prefix
 * outside the three known families (defensive; every real metric/ratio id has one of these). */
function idNamespaceWord(id: string): string {
  const prefix = id.slice(0, id.indexOf('.'))
  return prefix === 'campaign' ? 'campaign' : prefix === 'bsk' ? 'site-wide' : prefix === 'popup' ? 'pop-up' : ''
}
/** A DataBinding's plain-language name — for the item summary line and anywhere else a data
 * pick needs to be named back to the owner OUTSIDE its own picker (review fix, 2026-09-27: "no
 * ids anywhere a user reads" — this used to be the bare metric/ratio id or ScopePath). An id
 * that no longer resolves (hand-edited storage, a since-removed metric) reads as "Unknown …"
 * rather than showing the id itself; validateCard flags the same item with a real error
 * alongside it, so the problem is never silently disguised as a normal-looking name. */
export function dataSummaryLabel(binding: DataBinding): string {
  if ('field' in binding) return scopePathLabel(binding.field)
  if ('metric' in binding) {
    const def = metricDef(binding.metric)
    if (!def) return 'Unknown metric'
    const label = noteRawText(def.label) || 'Unnamed metric'
    const ns = idNamespaceWord(binding.metric)
    return ns ? `${label} (${ns})` : label
  }
  const def = ratioDef(binding.ratio)
  if (!def) return 'Unknown ratio'
  const label = noteRawText(def.label) || 'Unnamed ratio'
  const ns = idNamespaceWord(binding.ratio)
  return ns ? `${label} (${ns})` : label
}

// Campaign/pop-up option lists — from the real arrays, id + label only (never a free-text id).
export const CAMPAIGN_ID_OPTIONS: { value: string; label: string }[] = CAMPAIGNS.map((c) => ({ value: c.id, label: c.label }))
export const POPUP_ID_OPTIONS: { value: string; label: string }[] = POPUPS.map((p) => ({ value: p.id, label: p.label }))

/** Whether a param the user could pin is already an explicit string (rather than left to the
 * repeat scope) — the editor's "campaign: from card" chip vs. an override select. */
export function paramIsPinned(v: ParamValue | undefined): v is string {
  return typeof v === 'string'
}

// ── Display kind / compatibility ──────────────────────────────────────────────────────────
/** Plain names for a Display's `as` — never the raw camelCase type-level string (review fix,
 * 2026-09-27), used both by the display-kind picker's own tabs and the item summary line. */
const DISPLAY_AS_LABELS: Record<DisplayAs, string> = {
  number: 'Number',
  currency: 'Currency',
  percent: 'Percent',
  counts: 'Counts',
  dateRange: 'Date range',
  datetime: 'Date & time',
  badge: 'Badge',
  bar: 'Bar',
  sparkline: 'Sparkline',
  text: 'Text',
  date: 'Date',
  ago: 'Time ago',
  status: 'Label',
}
export function displayAsLabel(as: DisplayAs): string {
  return DISPLAY_AS_LABELS[as] ?? as
}
export interface DisplayOption {
  as: DisplayAs
  disabled: boolean
  hint?: string
}
/** The displays compatible with a binding's data kind (validate.ts's DISPLAYS_FOR), with
 * 'sparkline' always present-but-disabled: MetricValue carries no per-day series yet (see
 * lib/metrics/render.ts's own "GAP" comment), so the editor never lets it be picked even though
 * the kind allows it in principle. Returns [] for an unresolvable binding (unknown id), which
 * the caller renders as "pick a metric/ratio first". */
export function displayOptionsFor(binding: DataBinding): DisplayOption[] {
  const k = kindOf(binding)
  if (!k) return []
  return DISPLAYS_FOR[k].map((as) => (as === 'sparkline' ? { as, disabled: true, hint: 'Coming soon — no daily series data yet' } : { as, disabled: false }))
}
/** Whether `as` is a display the given binding's data kind actually allows AND the editor
 * offers (excludes the disabled sparkline placeholder) — used to auto-correct the display when
 * the user switches data under it. */
export function isDisplaySelectable(binding: DataBinding, as: DisplayAs): boolean {
  const k = kindOf(binding)
  return !!k && DISPLAYS_FOR[k].includes(as) && as !== 'sparkline'
}
export function dataKindOf(binding: DataBinding): DataKind | null {
  return kindOf(binding)
}
/** The first selectable display for a data kind — used to fix up `display` when a binding
 * change makes the current one incompatible (validateCard would otherwise reject it). */
export function firstDisplayFor(binding: DataBinding): DisplayAs | null {
  const opts = displayOptionsFor(binding).filter((o) => !o.disabled)
  return opts[0]?.as ?? null
}
export function makeDisplay(as: DisplayAs, current: Display): Display {
  switch (as) {
    case 'number':
      return { as: 'number', ...(current.as === 'number' && current.deltas ? { deltas: current.deltas } : {}) }
    case 'percent':
      return { as: 'percent', decimals: current.as === 'percent' ? current.decimals : 1 }
    case 'dateRange':
      return { as: 'dateRange', days: current.as === 'dateRange' ? current.days : true }
    case 'badge':
      return { as: 'badge', ...(current.as === 'badge' && current.tones ? { tones: current.tones } : {}) }
    case 'sparkline':
      return { as: 'sparkline', series: 'daily' }
    default:
      return { as }
  }
}

// ── Repeat ─────────────────────────────────────────────────────────────────────────────────
/** Switches a repeat to another kind. The ids/status/tracked/flightingToday filters belong to
 * the old kind and are dropped; `empty` (what shows when the repeat yields nothing) does not
 * depend on the kind and is kept. CardEditorRepeat.vue also remembers each kind's own filters
 * for the life of the editor, so switching away and back restores them. */
export function withRepeatOver(current: RepeatSpec | undefined, over: RepeatSpec['over'] | ''): RepeatSpec | undefined {
  if (!over) return undefined
  if (current?.over === over) return current
  return current?.empty ? { over, empty: current.empty } : { over }
}
// ── Gating ─────────────────────────────────────────────────────────────────────────────────
/** An item with some gating fields changed; `undefined` removes a field, and an emptied gating
 * is dropped altogether rather than left as `gating: {}` (a no-op edit leaves the item equal). */
export function withGating(item: MetricItem, patch: Partial<Record<keyof Gating, unknown>>): MetricItem {
  const gating: Record<string, unknown> = { ...item.gating }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete gating[k]
    else gating[k] = v
  }
  const { gating: _old, ...rest } = item
  return Object.keys(gating).length ? { ...rest, gating: gating as Gating } : rest
}
/** An object with `key` set to `value`, or without `key` when `value` is undefined — never a
 * key holding `undefined` (so a no-op edit leaves the object deep-equal to what it was). */
export function withField<T extends object, K extends keyof T>(obj: T, key: K, value: T[K] | undefined): T {
  const out = { ...obj }
  if (value === undefined) delete out[key]
  else out[key] = value
  return out
}


// ── Error grouping (validateCard's flat string[] -> per-section / per-item, for inline
// display) — validate.ts's `where` strings are always `sections[N]` or `sections[N].<itemId>`,
// optionally with a further `.field` suffix, so a prefix match is enough; never a bracket
// lookup on a user-controlled id. ────────────────────────────────────────────────────────────
export interface GroupedErrors {
  cardErrors: string[]
  sectionErrors: string[][]
  itemErrors: Record<string, string[]>[]
}
const SECTION_PREFIX_RE = /^sections\[(\d+)\]/
export function groupErrors(errors: readonly string[], spec: CardSpec): GroupedErrors {
  const cardErrors: string[] = []
  const sectionErrors: string[][] = spec.sections.map(() => [])
  const itemErrors: Record<string, string[]>[] = spec.sections.map(() => ({}))
  for (const e of errors) {
    const m = SECTION_PREFIX_RE.exec(e)
    if (!m) {
      cardErrors.push(e)
      continue
    }
    const si = Number(m[1])
    const section = spec.sections[si]
    const rest = e.slice(m[0].length).replace(/^\./, '')
    const item = section?.items.find((it) => rest === it.id || rest.startsWith(`${it.id}:`) || rest.startsWith(`${it.id}.`))
    if (item) {
      const bucket = (itemErrors[si][item.id] ??= [])
      bucket.push(e)
    } else if (sectionErrors[si]) {
      sectionErrors[si].push(e)
    } else {
      cardErrors.push(e)
    }
  }
  return { cardErrors, sectionErrors, itemErrors }
}
