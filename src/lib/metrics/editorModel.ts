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
import { hasNote, noteOptions, noteRawText } from '../notes'
import { POPUPS } from '../popupEvents'
import { METRICS, type MetricDef } from './metrics'
import { RATIOS, type RatioDef } from './ratios'
import { DISPLAYS_FOR, kindOf, type DataKind } from './validate'
import type { CardSpec, DataBinding, Display, DisplayAs, Label, MetricItem, ParamValue, RepeatSpec, ScopePath, Section } from './types'
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
/** Preset ids, humanized — own keys only (PRESETS is null-prototype; Object.keys is already
 * own-key-safe). */
export function presetOptions(): { value: string; label: string }[] {
  return Object.keys(PRESETS).map((id) => ({ value: id, label: id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }))
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
      const id = current !== undefined && typeof current === 'object' && 'note' in current ? current.note : ''
      return { note: id }
    }
    case 'bind': {
      const path = current !== undefined && typeof current === 'object' && 'bind' in current ? current.bind : fallbackScopePath
      return { bind: path }
    }
  }
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
  ],
  popups: [
    { value: 'popup.id', label: 'Pop-up id' },
    { value: 'popup.label', label: 'Pop-up name' },
  ],
  windows: [{ value: 'window.label', label: 'Window label (Before / After)' }],
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

// Campaign/pop-up option lists — from the real arrays, id + label only (never a free-text id).
export const CAMPAIGN_ID_OPTIONS: { value: string; label: string }[] = CAMPAIGNS.map((c) => ({ value: c.id, label: c.label }))
export const POPUP_ID_OPTIONS: { value: string; label: string }[] = POPUPS.map((p) => ({ value: p.id, label: p.label }))

/** Whether a param the user could pin is already an explicit string (rather than left to the
 * repeat scope) — the editor's "campaign: from card" chip vs. an override select. */
export function paramIsPinned(v: ParamValue | undefined): v is string {
  return typeof v === 'string'
}

// ── Display kind / compatibility ──────────────────────────────────────────────────────────
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
export function withRepeatOver(current: RepeatSpec | undefined, over: RepeatSpec['over'] | ''): RepeatSpec | undefined {
  if (!over) return undefined
  if (current?.over === over) return current
  return { over }
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
