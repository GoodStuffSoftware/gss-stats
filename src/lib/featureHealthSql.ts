// The SQL half of the feature-health view (functions/api/features.ts): one column per configured
// step, built from FEATURES alone. No bound value is a path (every path is a checked literal via
// sqlLit), so the statement's bind count is only the window, the sites and the shared exclusions.
//
// Grouping is by ET DAY only (etDateSql), never by hour, place or device, and the caller's window is
// always whole ET days, so a refused path (src/lib/splitGuard.ts) is only ever read as a per-ET-day
// total, which the counts-only rule allows.

import { etDateSql } from './etTime'
import { FEATURES, featureStepKey, featureStepOf, flatSteps, stepMatches, type FeatureDef, type StepMatch } from './featureHealth'
import { refusedRowWindow, REFUSED_WINDOW_KEY } from './splitGuard'
import { NUL_PATH_SQL, sqlInt, sqlLit } from './popupEvents'

/** A row's campaign tag (`campaign`, the row's uc): tagged = set and not empty. Literals, never binds. */
const TAG_SQL = { tagged: "(campaign IS NOT NULL AND campaign <> '')", organic: "(campaign IS NULL OR campaign = '')" } as const

/** The SQL twin of stepMatches (featureHealth.ts): equals one exact path, or starts with a prefix
 * (substr, case-exact, no LIKE wildcards), and is not an excepted path; with a `tag`, the row's
 * campaign is also set (tagged) or empty (organic). */
export function stepMatchSql(match: StepMatch): string {
  const terms = [
    ...(match.exact ?? []).map((p) => `path = ${sqlLit(p)}`),
    ...(match.prefix ?? []).map((p) => `substr(path, 1, ${sqlInt(p.length)}) = ${sqlLit(p)}`),
  ]
  if (!terms.length) return '0'
  const except = match.except?.length ? ` AND path NOT IN (${match.except.map(sqlLit).join(', ')})` : ''
  const tag = match.tag ? ` AND ${TAG_SQL[match.tag]}` : ''
  return `((${terms.join(' OR ')})${except}${tag})`
}

/** A feature matches a row when any of its steps does. */
export function featureMatchSql(feature: FeatureDef): string {
  return `(${feature.steps.map((s) => stepMatchSql(s.match)).join(' OR ')})`
}

/** The row filter every statement shares: the path belongs to some configured step, and carries no
 * NUL byte (LIKE-style matching would read such a path as shorter than it is). */
export function anyStepWhere(features: readonly FeatureDef[] = FEATURES): string {
  return `(${features.map(featureMatchSql).join(' OR ')}) AND NOT (${NUL_PATH_SQL})`
}

// ── The `featureStep` chart dimension (functions/api/geo.ts) ─────────────────────────────────────
// The same step matches the Features page counts, so a chart built with the editor reads the same rows.
// Counts only: nothing here groups by hour, place or device. Literals, never binds.

/** A row of the step `<featureId>.<stepId>` (featureStepOf), as a drill / series filter: the step's own match,
 * so two steps that share a path (Games and Games, easy) each count it. A value naming no step matches no row. */
export function featureStepFilterSql(key: string): string {
  const hit = featureStepOf(key)
  return hit ? `(${stepMatchSql(hit.step.match)} AND NOT (${NUL_PATH_SQL}))` : '0'
}

/** stepMatchSql, shorter: a step's exact paths as one IN list. The same rows (exact equality, same except and tag terms);
 * used only by the featureStep expressions, which sit in a ring that must stay under the statement-size cap. */
function compactStepMatchSql(match: StepMatch): string {
  const terms: string[] = []
  if (match.exact?.length) terms.push(match.exact.length === 1 ? `path=${sqlLit(match.exact[0])}` : `path IN (${match.exact.map(sqlLit).join(',')})`)
  for (const p of match.prefix ?? []) terms.push(`substr(path,1,${sqlInt(p.length)})=${sqlLit(p)}`)
  if (!terms.length) return '0'
  const except = match.except?.length ? ` AND path NOT IN (${match.except.map(sqlLit).join(',')})` : ''
  const tag = match.tag ? ` AND ${TAG_SQL[match.tag]}` : ''
  // Parentheses only where an AND follows the OR group: the callers put the result straight after WHEN or OR.
  return except || tag ? `(${terms.join(' OR ')})${except}${tag}` : terms.join(' OR ')
}

/** The steps a featureStep CASE needs, in config order: a step that can never be a row's FIRST match is left out
 * (no match terms, the same match as an earlier step, or only exact paths that an earlier tag-free step already
 * matches, like Games, easy after Games). Filtering by such a step still works (featureStepFilterSql). */
function firstMatchSteps(): { key: string; match: StepMatch }[] {
  const out: { key: string; match: StepMatch }[] = []
  const seen = new Set<string>()
  for (const f of flatSteps(FEATURES)) {
    const m = compactStepMatchSql(f.step.match)
    if (m === '0' || seen.has(m)) continue
    const mt = f.step.match
    const shadowed =
      !mt.tag && !mt.prefix?.length && !!mt.exact?.length &&
      mt.exact.every((p) => out.some((o) => !o.match.tag && stepMatches(o.match, p, null)))
    if (shadowed) continue
    seen.add(m)
    out.push({ key: featureStepKey(f.feature.id, f.step.id), match: mt })
  }
  return out
}

/** The grouping expression: a row's FIRST matching step in config order, `<featureId>.<stepId>`, or `emptyLabel`.
 * A path shared by two steps lands on the first (Games before Games, easy); filter by step to count it for each.
 * No NUL test here: a query grouping by this dimension always carries featureStepPrefilter, which drops NUL paths. */
export function featureStepSqlCase(emptyLabel: string): string {
  const steps = firstMatchSteps()
  // Every row reaching this CASE passed featureStepPrefilter, so it matches some step: the last step needs no test of its own.
  const last = steps.pop()
  const whens = steps.map((o) => `WHEN ${compactStepMatchSql(o.match)} THEN ${sqlLit(o.key)}`)
  return `CASE ${whens.join(' ')} ELSE ${last ? sqlLit(last.key) : sqlLit(emptyLabel)} END`
}

/** Prefilter for a query that groups by featureStep: only rows of some configured step (anyStepWhere's rows), and no
 * NUL path. Steps with no except or tag share one exact-path list and one prefix list; the others keep their own term. */
export function featureStepPrefilter(w: string[], _b: unknown[]): void {
  const exact = new Set<string>()
  const prefix = new Set<string>()
  const own: string[] = []
  const steps = flatSteps(FEATURES).map((st) => st.step.match)
  const plain = steps.filter((mt) => !mt.tag && !mt.except?.length)
  for (const mt of steps) {
    // A step with an except list but no tag is plain too when every excepted path is matched by a plain step anyway
    // (the signin shown prefix excepts the accept and dismiss paths, which have steps of their own).
    const covered = !mt.tag && !!mt.except?.length && mt.except.every((p) => plain.some((o) => stepMatches(o, p, null)))
    if (mt.tag || (mt.except?.length && !covered)) {
      const c = `(${compactStepMatchSql(mt)})`
      if (c !== '(0)' && !own.includes(c)) own.push(c)
    } else {
      for (const p of mt.exact ?? []) exact.add(p)
      for (const p of mt.prefix ?? []) prefix.add(p)
    }
  }
  // An exact path under a plain prefix, and a prefix under a shorter plain prefix, add no rows: leave them out.
  const prefixes = [...prefix].filter((p) => ![...prefix].some((q) => q !== p && p.startsWith(q)))
  const exactLeft = [...exact].filter((p) => !prefixes.some((q) => p.startsWith(q)))
  const terms = [
    ...(exactLeft.length ? [`path IN (${exactLeft.map(sqlLit).join(',')})`] : []),
    ...prefixes.map((p) => `substr(path,1,${sqlInt(p.length)})=${sqlLit(p)}`),
    ...own,
  ]
  w.push(`(${terms.length ? terms.join(' OR ') : '0'}) AND instr(path,char(0))=0`) // NUL_PATH_SQL, negated
}

/** The window a featureStep query counts every row over: [since, until) snapped to ET midnights the way
 * /api/features snaps its range (refusedRowWindow), so a step chart reads the same days as the Features page.
 * An empty snapped window counts nothing. `moved` is true when the snap changed a bound. */
export function featureStepWindow(sinceMs: number, untilMs: number): { terms: string[]; binds: number[]; moved: boolean; key: string } {
  const [from, to] = refusedRowWindow(sinceMs, untilMs)
  const moved = from !== sinceMs || to !== untilMs
  const empty = !Number.isFinite(from) || !Number.isFinite(to) || from >= to
  return { terms: ['ts >= ?', 'ts < ?'], binds: empty ? [0, 0] : [from, to], moved, key: REFUSED_WINDOW_KEY }
}

/** Per ET day, one count per step (columns s0..sN in flatSteps order). */
export function dailyStepsSql(whereTerms: readonly string[], features: readonly FeatureDef[] = FEATURES): string {
  const cols = flatSteps(features).map((f) => `SUM(CASE WHEN ${stepMatchSql(f.step.match)} THEN 1 ELSE 0 END) AS s${f.index}`)
  return `SELECT ${etDateSql()} AS d, ${cols.join(', ')} FROM hits WHERE ${whereTerms.join(' AND ')} GROUP BY d ORDER BY d`
}

/** One count per step over every row the where terms leave (columns s0..sN in flatSteps order): a single
 * total row, never grouped by anything, so a refused path is read as one total (the Ask-order card's
 * all-time progress toward its call point). */
export function totalStepsSql(whereTerms: readonly string[], features: readonly FeatureDef[] = FEATURES): string {
  const cols = flatSteps(features).map((f) => `SUM(CASE WHEN ${stepMatchSql(f.step.match)} THEN 1 ELSE 0 END) AS s${f.index}`)
  return `SELECT ${cols.join(', ')} FROM hits WHERE ${whereTerms.join(' AND ')}`
}

/** The count of rows before the cutoff, one total per feature (columns f0..fN in config order): the
 * "is it new" test. A COUNT of rows, never MIN(ts) or MAX(ts). */
export function beforeCutoffSql(whereTerms: readonly string[], features: readonly FeatureDef[] = FEATURES): string {
  const cols = features.map((f, i) => `SUM(CASE WHEN ${featureMatchSql(f)} THEN 1 ELSE 0 END) AS f${i}`)
  return `SELECT ${cols.join(', ')} FROM hits WHERE ${whereTerms.join(' AND ')}`
}
