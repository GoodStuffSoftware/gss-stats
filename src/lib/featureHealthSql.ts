// The SQL half of the feature-health view (functions/api/features.ts): one column per configured
// step, built from FEATURES alone. No bound value is a path (every path is a checked literal via
// sqlLit), so the statement's bind count is only the window, the sites and the shared exclusions.
//
// Grouping is by ET DAY only (etDateSql), never by hour, place or device, and the caller's window is
// always whole ET days, so a refused path (src/lib/splitGuard.ts) is only ever read as a per-ET-day
// total, which the counts-only rule allows.

import { etDateSql } from './etTime'
import { FEATURES, flatSteps, type FeatureDef, type StepMatch } from './featureHealth'
import { NUL_PATH_SQL, sqlInt, sqlLit } from './popupEvents'

/** The SQL twin of stepMatches (featureHealth.ts): equals one exact path, or starts with a prefix
 * (substr, case-exact, no LIKE wildcards), and is not an excepted path. */
export function stepMatchSql(match: StepMatch): string {
  const terms = [
    ...(match.exact ?? []).map((p) => `path = ${sqlLit(p)}`),
    ...(match.prefix ?? []).map((p) => `substr(path, 1, ${sqlInt(p.length)}) = ${sqlLit(p)}`),
  ]
  if (!terms.length) return '0'
  const except = match.except?.length ? ` AND path NOT IN (${match.except.map(sqlLit).join(', ')})` : ''
  return `((${terms.join(' OR ')})${except})`
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

/** Per ET day, one count per step (columns s0..sN in flatSteps order). */
export function dailyStepsSql(whereTerms: readonly string[], features: readonly FeatureDef[] = FEATURES): string {
  const cols = flatSteps(features).map((f) => `SUM(CASE WHEN ${stepMatchSql(f.step.match)} THEN 1 ELSE 0 END) AS s${f.index}`)
  return `SELECT ${etDateSql()} AS d, ${cols.join(', ')} FROM hits WHERE ${whereTerms.join(' AND ')} GROUP BY d ORDER BY d`
}

/** The count of rows before the cutoff, one total per feature (columns f0..fN in config order): the
 * "is it new" test. A COUNT of rows, never MIN(ts) or MAX(ts). */
export function beforeCutoffSql(whereTerms: readonly string[], features: readonly FeatureDef[] = FEATURES): string {
  const cols = features.map((f, i) => `SUM(CASE WHEN ${featureMatchSql(f)} THEN 1 ELSE 0 END) AS f${i}`)
  return `SELECT ${cols.join(', ')} FROM hits WHERE ${whereTerms.join(' AND ')}`
}
