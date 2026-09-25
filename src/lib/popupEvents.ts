// Pop-up / event-beacon path patterns — Best Sudoku sign-in prompt, first-50 promo,
// upsell, install and outcome beacons.
//
// ONE module for every path pattern (per the task brief): both /api/popups (build the
// panels) and /api/geo + /api/sites (exclude these rows from ordinary page-view/visit
// counts) import this file, so a path rename is a one-line edit here — nowhere else.
//
// Live shape confirmed 2026-09-25 against production D1 (`gss-geo`.hits):
//   /signin-prompt/dismiss    22 hits  (response)
//   /signin-prompt/placement  21 hits  (shown, reason = "placement")
//   /install/play               2 hits  (install accept, method = "play")
//   /signin-prompt/streak        1 hit  (shown, reason = "streak")
// — matches the spec exactly: /signin-prompt/<reason> is "shown" (reason absorbs
// whatever value isn't "accept"/"dismiss"), with /signin-prompt/accept and
// /signin-prompt/dismiss reserved as the two response paths. No other popup family had
// any live rows yet, so the rest of this file follows the spec as given (see the task
// report's "open questions" for what's still unconfirmed).

// ── Exclusion: every prefix below is an EVENT beacon, not a screen view. Every existing
// page-view / visit / path count (geo.ts totals + breakdowns, sites.ts site counts) must
// exclude them — hard requirement #2 in the task brief.
export const POPUP_EVENT_PREFIXES = [
  '/signin-prompt',
  '/signin-eligible',
  '/promo-first50',
  '/first50-congrats',
  '/upsell',
  '/install',
  '/popup-outcome',
] as const

export function isPopupEventPath(path: string): boolean {
  return POPUP_EVENT_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))
}

/** Appends `path <> ? AND path NOT LIKE ?` (ANDed) for every prefix — excludes all popup-event rows. */
export function popupExcludeClause(w: string[], b: unknown[]): void {
  for (const prefix of POPUP_EVENT_PREFIXES) {
    w.push(`path <> ? AND path NOT LIKE ?`)
    b.push(prefix, `${prefix}/%`)
  }
}

/** The inverse of popupExcludeClause: one OR'd fragment matching ANY popup-event row. */
export function popupIncludeClause(): { sql: string; binds: string[] } {
  const sql = `(${POPUP_EVENT_PREFIXES.map(() => 'path = ? OR path LIKE ?').join(' OR ')})`
  const binds: string[] = []
  for (const p of POPUP_EVENT_PREFIXES) binds.push(p, `${p}/%`)
  return { sql, binds }
}

// ── Classification ──────────────────────────────────────────────────────────────────
// A classified pop-up event. `family` identifies which pop-up/funnel — a static id for
// every family except the dynamic outcome beacon, whose family is `popup-outcome:<name>`
// (the `<popup>` path segment, names TBD). `kind` is shown/accept/dismiss/outcome/etc.
// within that family; `extra` is the optional sub-dimension (a reason, an install
// platform/method, an outcome type).
export interface PopupEvent {
  family: string
  kind: string
  extra?: string
}

function segments(path: string, prefix: string): string[] {
  return path.slice(prefix.length).split('/').filter(Boolean)
}

export const UPSELL_REASONS = ['cadence', 'limit', 'daily-locked', 'upgrade-tap', 'settings-upgrade'] as const
export const INSTALL_SHOWN_PLATFORMS = ['android', 'ios', 'desktop'] as const
export const INSTALL_PLATFORM_LIST = ['web', 'play', 'app-store'] as const
export const INSTALL_OUTCOMES = ['pwa-installed', 'standalone-detected', 'play-detected'] as const
const INSTALL_PROMPT_DISMISS = ['dismiss', 'dismiss-forever', 'have-it'] as const
// The names on /popup-outcome/<popup>/<outcome> are TBD (see task brief) — every outcome
// type is accepted for every popup family rather than guessing which ones apply.
export const POPUP_OUTCOME_TYPES = ['signed-in', 'installed', 'returned'] as const

export function classifyPopupPath(path: string): PopupEvent | null {
  if (!path) return null

  if (path === '/signin-prompt' || path.startsWith('/signin-prompt/')) {
    const [x] = segments(path, '/signin-prompt')
    if (!x) return null
    if (x === 'accept' || x === 'dismiss') return { family: 'signin-prompt', kind: x }
    return { family: 'signin-prompt', kind: 'shown', extra: x }
  }

  if (path === '/signin-eligible' || path.startsWith('/signin-eligible/')) {
    const [x] = segments(path, '/signin-eligible')
    if (x === 'earned' || x === 'capped' || x === 'unearned') return { family: 'signin-eligible', kind: x }
    return null
  }

  if (path === '/promo-first50' || path.startsWith('/promo-first50/')) {
    const [x] = segments(path, '/promo-first50')
    if (x === 'shown' || x === 'accept' || x === 'dismiss') return { family: 'promo-first50', kind: x }
    return null
  }

  if (path === '/first50-congrats' || path.startsWith('/first50-congrats/')) {
    const [x] = segments(path, '/first50-congrats')
    if (x === 'shown') return { family: 'first50-congrats', kind: 'shown' }
    if (x === 'ack') return { family: 'first50-congrats', kind: 'accept' }
    if (x === 'close') return { family: 'first50-congrats', kind: 'dismiss' }
    return null
  }

  if (path === '/upsell' || path.startsWith('/upsell/')) {
    const [kind, reason] = segments(path, '/upsell')
    if ((kind === 'shown' || kind === 'accept' || kind === 'dismiss') && reason) {
      return { family: 'upsell', kind, extra: reason }
    }
    return null
  }

  if (path === '/install' || path.startsWith('/install/')) {
    const [a, b] = segments(path, '/install')
    if (!a) return null
    if (a === 'prompt' && b && (INSTALL_SHOWN_PLATFORMS as readonly string[]).includes(b)) {
      return { family: 'install', kind: 'shown', extra: b }
    }
    if (a === 'prompt' && b && (INSTALL_PROMPT_DISMISS as readonly string[]).includes(b)) {
      return { family: 'install', kind: 'dismiss', extra: b }
    }
    if (a === 'platforms' && b && (INSTALL_PLATFORM_LIST as readonly string[]).includes(b)) {
      return { family: 'install', kind: 'platformList', extra: b }
    }
    if (a === 'play') return { family: 'install', kind: 'accept', extra: 'play' }
    if (a === 'pwa-accept') return { family: 'install', kind: 'accept', extra: 'pwa' }
    if (a === 'app-store') return { family: 'install', kind: 'accept', extra: 'app-store' }
    if (a === 'pwa-decline') return { family: 'install', kind: 'dismiss', extra: 'pwa' }
    if ((INSTALL_OUTCOMES as readonly string[]).includes(a)) return { family: 'install', kind: 'outcome', extra: a }
    return null
  }

  if (path === '/popup-outcome' || path.startsWith('/popup-outcome/')) {
    const [name, outcome] = segments(path, '/popup-outcome')
    if (name && outcome && (POPUP_OUTCOME_TYPES as readonly string[]).includes(outcome)) {
      return { family: `popup-outcome:${name}`, kind: outcome }
    }
    return null
  }

  return null
}

// ── ET day bucketing (hard requirement #3) ──────────────────────────────────────────
// SQLite has no time zones, so the Function groups rows by UTC HOUR (an aggregate,
// D1-side operation) and this maps each hour's start instant to its US-Eastern calendar
// date via Intl — never a fixed offset, so DST is handled correctly. A single UTC-hour
// bucket never spans two America/New_York calendar days: the ET offset is always a whole
// number of hours (-4 EDT / -5 EST), so ET midnight always falls exactly on a UTC-hour
// boundary — true even on the two DST-transition nights (the repeated/skipped local hour
// still sits inside one UTC hour).
const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
/** The America/New_York calendar date (YYYY-MM-DD) containing the given instant. */
export function etDateFromMs(ms: number): string {
  return ET_DATE_FMT.format(new Date(ms)) // en-CA formats as YYYY-MM-DD directly
}

// ── Rate math (hard requirement #4) ─────────────────────────────────────────────────
/** numerator / denominator, or null (never NaN/Infinity) when the denominator is 0. */
export function computeRate(numerator: number, denominator: number): number | null {
  if (!denominator) return null
  return numerator / denominator
}

// ── Aggregation ──────────────────────────────────────────────────────────────────────
// The Function fetches one row per (UTC hour bucket, path) with its count — still an
// aggregate query (no per-row/per-visitor data), never correlated by timestamp or
// device. This classifies and re-aggregates that into three maps: `coarse` (total per
// family+kind, e.g. every "signin-prompt shown" regardless of reason), `detailed`
// (per family+kind+extra, e.g. per upsell reason) and `byDay` (per ET date + family +
// kind, for trend charts).
export interface HourPathCount {
  hourStartMs: number // the UTC hour bucket's start instant
  path: string
  count: number
}

export interface PopupAggregate {
  coarse: Map<string, number> // `${family}|${kind}` -> count
  detailed: Map<string, number> // `${family}|${kind}|${extra}` -> count
  byDay: Map<string, number> // `${etDate}|${family}|${kind}` -> count
}

const coarseKey = (family: string, kind: string) => `${family}|${kind}`
const detailedKey = (family: string, kind: string, extra: string) => `${family}|${kind}|${extra}`
const dayKey = (etDate: string, family: string, kind: string) => `${etDate}|${family}|${kind}`

function bump(m: Map<string, number>, k: string, n: number): void {
  m.set(k, (m.get(k) ?? 0) + n)
}

export function aggregatePopupRows(rows: HourPathCount[]): PopupAggregate {
  const coarse = new Map<string, number>()
  const detailed = new Map<string, number>()
  const byDay = new Map<string, number>()
  for (const r of rows) {
    const ev = classifyPopupPath(r.path)
    if (!ev) continue
    bump(coarse, coarseKey(ev.family, ev.kind), r.count)
    if (ev.extra) bump(detailed, detailedKey(ev.family, ev.kind, ev.extra), r.count)
    bump(byDay, dayKey(etDateFromMs(r.hourStartMs), ev.family, ev.kind), r.count)
  }
  return { coarse, detailed, byDay }
}

export function coarseCount(agg: PopupAggregate, family: string, kind: string): number {
  return agg.coarse.get(coarseKey(family, kind)) ?? 0
}
export function detailedCount(agg: PopupAggregate, family: string, kind: string, extra: string): number {
  return agg.detailed.get(detailedKey(family, kind, extra)) ?? 0
}
/** Every `${date}` bucket for one family+kind, as [date, count] pairs, unsorted. */
export function dayCounts(agg: PopupAggregate, family: string, kind: string): [string, number][] {
  const suffix = `|${family}|${kind}`
  const out: [string, number][] = []
  for (const [key, count] of agg.byDay) {
    if (!key.endsWith(suffix)) continue
    out.push([key.slice(0, key.length - suffix.length), count])
  }
  return out
}
/** Every `${extra}` bucket for one family+kind, as [extra, count] pairs, unsorted. */
export function detailedBreakdown(agg: PopupAggregate, family: string, kind: string): [string, number][] {
  const prefix = `${family}|${kind}|`
  const out: [string, number][] = []
  for (const [key, count] of agg.detailed) {
    if (!key.startsWith(prefix)) continue
    out.push([key.slice(prefix.length), count])
  }
  return out
}

// ── Registry (dashboard-facing) ─────────────────────────────────────────────────────
// Every "simple" pop-up funnel this dashboard renders panels for: shown/accept/dismiss
// counts, a tap rate, and (once real events show up) outcome rates. Adding a new one
// here is enough to make it selectable in the chart editor's dimension/rate pickers.
export interface PopupDef {
  id: string
  label: string
  hasReasonBreakdown?: boolean // shown/accept/dismiss further breaks down by a reason
}

export const POPUPS: PopupDef[] = [
  { id: 'signin-prompt', label: 'Sign-in prompt' },
  { id: 'promo-first50', label: 'First 50 promo' },
  { id: 'first50-congrats', label: 'First 50 congrats' },
  { id: 'upsell', label: 'Upsell', hasReasonBreakdown: true },
  { id: 'install', label: 'Install prompt', hasReasonBreakdown: true },
]

export interface PopupRateSpec {
  key: string
  label: string
  kind: 'tap' | 'outcome' | 'eligibility'
  popup?: string
  outcome?: string
}

export const POPUP_RATE_SPECS: PopupRateSpec[] = [
  ...POPUPS.map((p) => ({ key: `${p.id}:tap`, label: `${p.label} — tap rate (accept / shown)`, kind: 'tap' as const, popup: p.id })),
  ...POPUPS.flatMap((p) =>
    POPUP_OUTCOME_TYPES.map((o) => ({
      key: `${p.id}:outcome:${o}`,
      label: `${p.label} — ${o.replace('-', ' ')} rate`,
      kind: 'outcome' as const,
      popup: p.id,
      outcome: o,
    })),
  ),
  { key: 'signin-eligible:rate', label: 'Sign-in eligibility rate (earned / total)', kind: 'eligibility' as const },
]

export function computePopupRate(agg: PopupAggregate, spec: PopupRateSpec): number | null {
  if (spec.kind === 'eligibility') {
    const earned = coarseCount(agg, 'signin-eligible', 'earned')
    const capped = coarseCount(agg, 'signin-eligible', 'capped')
    const unearned = coarseCount(agg, 'signin-eligible', 'unearned')
    return computeRate(earned, earned + capped + unearned)
  }
  const shown = coarseCount(agg, spec.popup!, 'shown')
  if (spec.kind === 'tap') return computeRate(coarseCount(agg, spec.popup!, 'accept'), shown)
  // outcome
  return computeRate(coarseCount(agg, `popup-outcome:${spec.popup}`, spec.outcome!), shown)
}
