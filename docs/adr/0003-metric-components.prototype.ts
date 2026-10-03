// Type prototype for docs/adr/0003-metric-components.md. NOT wired into the app: it sits
// outside tsconfig.json's `include`, and vitest never picks it up (no `.test.` in the name).
// It proves two things the ADR claims:
//   1. The config schema (ADR section 1) can express the current campaign card and the KPI
//      tiles: both JSON examples below are checked against CardSpec with `satisfies`.
//   2. Ratio validity (ADR section 2) is mechanical: units plus declared subsets reject every
//      invalid funnel rate the dashboard shows today, and accept the valid ones.
// Self-contained on purpose (no imports), so Node 24 runs it directly:
//   node docs/adr/0003-metric-components.prototype.ts
//   npx tsc --noEmit --strict --target esnext --module nodenext docs/adr/0003-metric-components.prototype.ts

// ── Section 1: the config schema ─────────────────────────────────────────────────────────

/** What one counted thing IS. Ratio validity is decided on these. */
export type Unit = 'device' | 'row' | 'pageview' | 'completion' | 'showing' | 'signin' | 'finish' | 'usd' | 'day'

/** Fields of the object a card instance is bound to (config only, never a query). */
export type ScopePath =
  | 'campaign.id'
  | 'campaign.label'
  | 'campaign.status'
  | 'campaign.statusToday'
  | 'campaign.flight'
  | 'campaign.measurabilityNote'
  | 'popup.id'
  | 'popup.label'
  | 'window.label'
  | 'reading.readAt'
  | 'reading.kind'
  | 'reading.spend'
  | 'reading.rules'
  | 'reading.proposal'

/** A label is literal text or a bound object. */
export type Label =
  | string // literal; textLite markup (**bold**, [link](https://…)); {campaign.label}-style vars filled from scope
  | { note: string; vars?: Record<string, ScopePath> } // a lib/notes.ts registry entry
  | { bind: ScopePath } // a field of the bound object, e.g. the campaign's name
  | { metric: true } // the data binding's own registry label

export type ParamValue = string | { scope: 'campaignId' | 'popup' }
export interface Params {
  campaignId?: ParamValue
  popup?: ParamValue
}
export type WindowSpec = 'page' | 'attribution' | 'flight' | 'todaySoFar' | 'allTime' | 'before' | 'after' | { scope: 'window' }

/** Declarative data: a registry id plus params. Never SQL, never an endpoint path. */
export type DataBinding =
  | { metric: string; params?: Params; window?: WindowSpec }
  | { ratio: string; params?: Params; window?: WindowSpec }
  | { field: ScopePath }

export type Display =
  | { as: 'number'; deltas?: ('yesterday' | 'avg7')[] }
  | { as: 'currency' }
  | { as: 'percent'; decimals?: 0 | 1 | 2 | 3 | 4 } // always followed by "(n/d)" — widened to 0–4 (matches validate.ts and render.ts)
  | { as: 'counts' }
  | { as: 'dateRange'; days?: boolean }
  | { as: 'datetime' }
  | { as: 'badge'; tones?: Record<string, 'neutral' | 'live' | 'warn'> }
  | { as: 'bar' }
  | { as: 'sparkline'; series: 'daily' }
  | { as: 'text' }

export interface Gating {
  minCohort?: number // may only RAISE the MIN_COHORT floor
  whenUnmeasured?: 'auto' | 'omit' | 'label' // auto = omit for a closed campaign, label otherwise
  whenEmpty?: 'dash' | 'omit' | { note: string }
}

export interface RepeatSpec {
  over: 'campaigns' | 'popups' | 'windows' | 'readings'
  ids?: string[]
  status?: ('closed' | 'active' | 'upcoming')[]
  flightingToday?: boolean
  empty?: { label: Label; text: Label }
}

export interface MetricItem {
  id: string
  label: Label
  data: DataBinding
  display: Display
  gating?: Gating
  caption?: Label
  frame?: 'row' | 'pill' | 'tile'
  repeat?: RepeatSpec
}

export interface Section {
  layout: 'rows' | 'pills' | 'tiles' | 'bars' | 'table' // 'table': items are columns, `repeat` instances are rows
  title?: Label
  repeat?: RepeatSpec
  items: MetricItem[]
}

export interface CardSpec {
  v: 1
  repeat?: RepeatSpec
  title?: Label
  badge?: { data: DataBinding; display: Extract<Display, { as: 'badge' }> }
  sections: Section[]
  captions?: string[]
  link?: 'campaigns-page'
  minWidth?: number
}

/** What a Widget stores in `widget.card`. */
export type CardRef = { preset: string } | { spec: CardSpec }

// ── Section 2: the registry excerpt (units and subsets only; the real one also carries the
// fact, reducer, params, windows and instrumentation rules) ──────────────────────────────

interface MetricDef {
  id: string
  unit: Unit
  /** Every counted thing of this metric maps to a DISTINCT counted thing of `subsetOf`. */
  subsetOf?: string
}
interface RatioDef {
  id: string
  kind: 'proportion' | 'cost' | 'pair'
  num: string
  den: string
}

const METRICS: MetricDef[] = [
  { id: 'campaign.taggedHits', unit: 'row' },
  { id: 'campaign.taggedArrivals', unit: 'device' },
  { id: 'campaign.gameViews', unit: 'pageview' },
  { id: 'campaign.completions', unit: 'completion' },
  { id: 'campaign.asks', unit: 'showing' },
  { id: 'campaign.accepts', unit: 'showing', subsetOf: 'campaign.asks' },
  { id: 'campaign.signedInAfterAsk', unit: 'showing', subsetOf: 'campaign.asks' },
  { id: 'campaign.authSuccess', unit: 'signin' },
  { id: 'campaign.installPrompts', unit: 'showing' },
  { id: 'campaign.installs', unit: 'showing', subsetOf: 'campaign.installPrompts' },
  { id: 'campaign.returnD0', unit: 'device' },
  { id: 'campaign.returnD2to7', unit: 'device', subsetOf: 'campaign.returnD0' },
  { id: 'campaign.spend', unit: 'usd' },
  { id: 'bsk.pageviews', unit: 'pageview' },
  { id: 'bsk.popupShown', unit: 'showing' },
  { id: 'bsk.popupAccepts', unit: 'showing', subsetOf: 'bsk.popupShown' },
  { id: 'bsk.authSuccess', unit: 'signin' },
]
const RATIOS: RatioDef[] = [
  { id: 'campaign.acceptPerAsk', kind: 'proportion', num: 'campaign.accepts', den: 'campaign.asks' },
  { id: 'campaign.signedInPerAsk', kind: 'proportion', num: 'campaign.signedInAfterAsk', den: 'campaign.asks' },
  { id: 'campaign.installPerPrompt', kind: 'proportion', num: 'campaign.installs', den: 'campaign.installPrompts' },
  { id: 'campaign.returnD2to7PerD0', kind: 'proportion', num: 'campaign.returnD2to7', den: 'campaign.returnD0' },
  { id: 'campaign.costPerArrival', kind: 'cost', num: 'campaign.spend', den: 'campaign.taggedArrivals' },
  { id: 'campaign.gameViewsVsArrivals', kind: 'pair', num: 'campaign.gameViews', den: 'campaign.taggedArrivals' },
  { id: 'bsk.popupTapRate', kind: 'proportion', num: 'bsk.popupAccepts', den: 'bsk.popupShown' },
]
const metricById = new Map(METRICS.map((m) => [m.id, m]))
const ratioById = new Map(RATIOS.map((r) => [r.id, r]))

/** The validity rule. A proportion needs the same unit AND a declared subset chain from the
 * numerator to the denominator; a cost needs money over a count; a pair is counts only. */
export function ratioVerdict(r: Pick<RatioDef, 'kind' | 'num' | 'den'>): { ok: boolean; reason: string } {
  const n = metricById.get(r.num)
  const d = metricById.get(r.den)
  if (!n || !d) return { ok: false, reason: 'unknown metric' }
  if (r.kind === 'pair') return { ok: true, reason: 'counts only' }
  if (r.kind === 'cost') return n.unit === 'usd' && d.unit !== 'usd' ? { ok: true, reason: 'money per ' + d.unit } : { ok: false, reason: 'cost needs usd over a count' }
  if (n.unit !== d.unit) return { ok: false, reason: `unit ${n.unit} over ${d.unit}` }
  for (let cur: MetricDef | undefined = n; cur; cur = cur.subsetOf ? metricById.get(cur.subsetOf) : undefined) {
    if (cur.subsetOf === d.id) return { ok: true, reason: `${n.unit} subset` }
  }
  return { ok: false, reason: 'same unit but no declared subset' }
}

type Kind = 'count' | 'money' | 'proportion' | 'cost' | 'pair' | 'field'
const DISPLAYS_FOR: Record<Kind, Display['as'][]> = {
  count: ['number', 'bar', 'sparkline'],
  money: ['currency', 'sparkline'],
  proportion: ['percent', 'counts'],
  cost: ['currency'],
  pair: ['counts'],
  field: ['dateRange', 'datetime', 'badge', 'text', 'number', 'currency'],
}
function kindOf(b: DataBinding): Kind | null {
  if ('field' in b) return 'field'
  if ('metric' in b) {
    const m = metricById.get(b.metric)
    return m ? (m.unit === 'usd' ? 'money' : 'count') : null
  }
  const r = ratioById.get(b.ratio)
  return r ? r.kind === 'proportion' ? 'proportion' : r.kind : null
}
const MIN_COHORT = 5

/** Load-time and save-time check. The server runs the same id/param checks on requests. */
export function validateCard(spec: CardSpec): string[] {
  const errors: string[] = []
  const check = (where: string, b: DataBinding, d: Display) => {
    const k = kindOf(b)
    if (!k) return errors.push(`${where}: unknown data id`)
    if (!DISPLAYS_FOR[k].includes(d.as)) errors.push(`${where}: display '${d.as}' not allowed for a ${k}`)
  }
  if (spec.badge) check('badge', spec.badge.data, spec.badge.display)
  spec.sections.forEach((s, si) =>
    s.items.forEach((it) => {
      check(`sections[${si}].${it.id}`, it.data, it.display)
      if (it.gating?.minCohort != null && it.gating.minCohort < MIN_COHORT) errors.push(`${it.id}: minCohort below MIN_COHORT`)
    }),
  )
  return errors
}

// ── The two JSON examples from the ADR, checked against the schema ───────────────────────

export const CAMPAIGN_SCORECARD = {
  v: 1,
  repeat: { over: 'campaigns' },
  link: 'campaigns-page',
  minWidth: 230,
  title: { bind: 'campaign.label' },
  badge: { data: { field: 'campaign.statusToday' }, display: { as: 'badge', tones: { 'flighting today': 'live' } } },
  sections: [
    {
      layout: 'rows',
      items: [
        { id: 'flight', label: 'Flight', data: { field: 'campaign.flight' }, display: { as: 'dateRange', days: true }, gating: { whenEmpty: { note: 'flight-pending' } } },
        { id: 'arrivals', label: { metric: true }, data: { metric: 'campaign.taggedArrivals' }, display: { as: 'number' } },
        { id: 'auth', label: 'Auth successes', data: { metric: 'campaign.authSuccess' }, display: { as: 'number' } },
        { id: 'installs', label: 'Installs', data: { metric: 'campaign.installs' }, display: { as: 'number' } },
        { id: 'return', label: 'Return rate (d2-7)', data: { ratio: 'campaign.returnD2to7PerD0' }, display: { as: 'percent', decimals: 1 } },
        { id: 'cpa', label: 'Cost / arrival', data: { ratio: 'campaign.costPerArrival' }, display: { as: 'currency' } },
      ],
    },
    {
      layout: 'pills',
      items: [
        { id: 'played', label: 'Game screen views', data: { ratio: 'campaign.gameViewsVsArrivals' }, display: { as: 'counts' } },
        { id: 'completed', label: 'Completed games', data: { metric: 'campaign.completions' }, display: { as: 'number' } },
        { id: 'asks', label: 'Sign-in asks', data: { metric: 'campaign.asks' }, display: { as: 'number' } },
        { id: 'accept', label: 'Accept', data: { ratio: 'campaign.acceptPerAsk' }, display: { as: 'percent', decimals: 1 } },
        { id: 'signedIn', label: 'Signed in after ask', data: { ratio: 'campaign.signedInPerAsk' }, display: { as: 'percent', decimals: 1 } },
        { id: 'prompts', label: 'Install prompts', data: { metric: 'campaign.installPrompts' }, display: { as: 'number' } },
        { id: 'install', label: 'Install', data: { ratio: 'campaign.installPerPrompt' }, display: { as: 'percent', decimals: 1 } },
      ],
    },
  ],
} satisfies CardSpec

export const BSK_KPI_TILES = {
  v: 1,
  sections: [
    {
      layout: 'tiles',
      items: [
        { id: 'pv', label: 'Page views', data: { metric: 'bsk.pageviews', window: 'todaySoFar' }, display: { as: 'number', deltas: ['yesterday', 'avg7'] } },
        {
          id: 'arrivals',
          label: 'Tagged arrivals — {campaign.label}',
          data: { metric: 'campaign.taggedArrivals', window: 'todaySoFar' },
          display: { as: 'number', deltas: ['yesterday', 'avg7'] },
          repeat: { over: 'campaigns', flightingToday: true, empty: { label: 'Tagged arrivals', text: { note: 'no-campaign-flighting' } } },
        },
        { id: 'tap', label: 'Pop-up tap rate', data: { ratio: 'bsk.popupTapRate', window: 'todaySoFar' }, display: { as: 'percent', decimals: 1 } },
        { id: 'auth', label: 'Auth successes', data: { metric: 'bsk.authSuccess', window: 'todaySoFar' }, display: { as: 'number', deltas: ['yesterday', 'avg7'] } },
      ],
    },
  ],
} satisfies CardSpec

// The ads readings log: per-campaign header rows plus a table whose rows repeat over the
// stored readings (records from gss-stats-ads, not beacon rows) and whose items are columns.
export const ADS_READINGS_LOG = {
  v: 1,
  repeat: { over: 'campaigns' },
  title: { bind: 'campaign.label' },
  sections: [
    { layout: 'rows', items: [{ id: 'spend', label: 'Spend', data: { metric: 'campaign.spend' }, display: { as: 'currency' } }] },
    {
      layout: 'table',
      repeat: { over: 'readings' },
      items: [
        { id: 'at', label: 'Read at', data: { field: 'reading.readAt' }, display: { as: 'datetime' } },
        { id: 'kind', label: 'Kind', data: { field: 'reading.kind' }, display: { as: 'text' } },
        { id: 'spent', label: 'Cumulative spend', data: { field: 'reading.spend' }, display: { as: 'currency' } },
        { id: 'rules', label: 'Rules', data: { field: 'reading.rules' }, display: { as: 'text' } },
        { id: 'proposal', label: 'Proposal', data: { field: 'reading.proposal' }, display: { as: 'text' } },
      ],
    },
  ],
} satisfies CardSpec

// ── Run: the audit verdicts and the schema checks ────────────────────────────────────────

const LEGACY_FUNNEL: [string, string, string][] = [
  ['Played a game (played / arrivals)', 'campaign.gameViews', 'campaign.taggedArrivals'],
  ['Completed a game (completed / played)', 'campaign.completions', 'campaign.gameViews'],
  ['Sign-in ask (ask / completed)', 'campaign.asks', 'campaign.completions'],
  ['Accept (accept / ask)', 'campaign.accepts', 'campaign.asks'],
  ['Auth success (authSuccess / accept)', 'campaign.authSuccess', 'campaign.accepts'],
  ['Install prompt (installPrompt / authSuccess)', 'campaign.installPrompts', 'campaign.authSuccess'],
  ['Install (install / installPrompt)', 'campaign.installs', 'campaign.installPrompts'],
  ['Return rate (d2-7 / d0)', 'campaign.returnD2to7', 'campaign.returnD0'],
  ['Pop-up tap rate (accepts / shown)', 'bsk.popupAccepts', 'bsk.popupShown'],
]
const EXPECTED_VALID = new Set(['Accept (accept / ask)', 'Install (install / installPrompt)', 'Return rate (d2-7 / d0)', 'Pop-up tap rate (accepts / shown)'])

let failures = 0
for (const [name, num, den] of LEGACY_FUNNEL) {
  const v = ratioVerdict({ kind: 'proportion', num, den })
  const expected = EXPECTED_VALID.has(name)
  if (v.ok !== expected) failures++
  console.log(`${v.ok ? 'VALID  ' : 'INVALID'} ${name} (${v.reason})${v.ok !== expected ? '  <-- UNEXPECTED' : ''}`)
}
for (const r of RATIOS) {
  const v = ratioVerdict(r)
  if (!v.ok) failures++
  console.log(`registry ${r.id}: ${v.ok ? 'ok' : 'REJECTED'} (${v.reason})`)
}
for (const [name, spec] of [['campaign scorecard', CAMPAIGN_SCORECARD], ['KPI tiles', BSK_KPI_TILES], ['ads readings log', ADS_READINGS_LOG]] as const) {
  const errs = validateCard(spec)
  if (errs.length) failures++
  console.log(`${name}: ${errs.length ? errs.join('; ') : 'valid'}`)
}
// A percent on the game-views pair must be refused, exactly like the 314.7% pill today.
const bad: CardSpec = { v: 1, sections: [{ layout: 'pills', items: [{ id: 'played', label: 'Played a game', data: { ratio: 'campaign.gameViewsVsArrivals' }, display: { as: 'percent' } }] }] }
const badErrs = validateCard(bad)
if (!badErrs.length) failures++
console.log(`percent on a pair: ${badErrs.length ? 'refused (' + badErrs[0] + ')' : 'ACCEPTED  <-- UNEXPECTED'}`)

if (failures) throw new Error(`${failures} check(s) failed`)
console.log('all checks passed')
