// Tests only: the pop-up rate as the retired `/api/popups` `dimension: 'rate'` branch answered it
// (removed in 0.24.1; a rate tile has been a metric card since layout version 18). It is the oracle
// the /api/metrics equivalence tests and the rate-tile parity test compare the registry against.
//
// It restates that branch over the same pieces it was built from, so it does not depend on any
// route: the same range rule (a datetime as given, a bare YYYY-MM-DD read as UTC days), the same
// WHERE (sites, "hide my own visits", the pop-up path filter, the counts-only guard), the same
// UTC-hour x path x install-fix GROUP BY, then `aggregatePopupRows` and `computePopupRate`.
import type { DatabaseSync } from 'node:sqlite'
import {
  INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS,
  INSTALL_GAP_RATE_KEY,
  POPUP_RATE_SPECS,
  aggregatePopupRows,
  computePopupRate,
  installOutcomeGapNote,
  popupIncludeClause,
  type HourPathCount,
} from '../../../src/lib/popupEvents'
import { excludeOwnClause } from '../../../src/lib/ownExclusion'
import { refusedPathExcludeClause } from '../../../src/lib/splitGuard'

export interface OracleOwn {
  excludeOwnVisits?: boolean
  ownBrowser?: string
  ownOS?: string
}
export interface OracleRate {
  rate: number | null
  insufficientCohort: boolean
  numerator: number
  denominator: number
  note?: string
}

const isDateOnly = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)

/** The rate for one POPUP_RATE_SPECS key over `since`..`until` (strings, as the endpoint took them). */
export function popupRateOracle(db: DatabaseSync, key: string, range: { since: string; until: string; sites?: string[] } & OracleOwn): OracleRate {
  const sinceMs = Date.parse(range.since)
  const untilMs = isDateOnly(range.until) ? Date.parse(range.until) + 86_400_000 : Date.parse(range.until)
  const w: string[] = ['ts >= ?', 'ts < ?']
  const b: unknown[] = [sinceMs, untilMs]
  const sites = range.sites ?? []
  if (sites.length) {
    w.push(`site IN (${sites.map(() => '?').join(', ')})`)
    b.push(...sites)
  }
  excludeOwnClause(w, b, range.excludeOwnVisits === true, range.ownBrowser, range.ownOS)
  const inc = popupIncludeClause()
  w.push(inc.sql)
  b.push(...inc.binds)
  refusedPathExcludeClause(w, b)
  const fixAt = INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS
  const pfSql = fixAt === null ? '0' : '(ts >= ?)'
  const sql = `SELECT CAST(ts / 3600000 AS INTEGER) AS hr, path, ${pfSql} AS pf, COUNT(*) AS c FROM hits WHERE ${w.join(' AND ')} GROUP BY hr, path, pf`
  const binds = [...(fixAt === null ? [] : [fixAt]), ...b] as (string | number)[]
  const rows: HourPathCount[] = (db.prepare(sql).all(...binds) as any[]).map((r) => ({
    hourStartMs: Number(r.hr) * 3_600_000,
    path: String(r.path ?? ''),
    count: Number(r.c) || 0,
    postInstallFix: Number(r.pf) === 1,
  }))
  const agg = aggregatePopupRows(rows)
  const spec = POPUP_RATE_SPECS.find((s) => s.key === key)
  const gated = spec ? computePopupRate(agg, spec) : { value: null, insufficientCohort: false, numerator: 0, denominator: 0 }
  const note = key === INSTALL_GAP_RATE_KEY ? installOutcomeGapNote({ startMs: sinceMs, endMs: untilMs }) : null
  return {
    rate: gated.value,
    insufficientCohort: gated.insufficientCohort,
    numerator: gated.numerator,
    denominator: gated.denominator,
    ...(note ? { note } : {}),
  }
}
