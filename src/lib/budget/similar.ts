// Pure helpers for the "Change similar purchases?" dialog: which switch position to start in, which rows
// the switch shows, which start ticked, and which the "from now on" rule covers (ticked and locked).
import { sameAmountChoice, type TxnViewPrefs } from './txnView'
import type { SimilarResponse, SimilarRow } from './types'

/** The "Same amount only" start position: the person's saved choice for this merchant, else on for a mixed merchant. */
export function defaultSameAmount(resp: Pick<SimilarResponse, 'mixed' | 'source'>, prefs: Pick<TxnViewPrefs, 'sameAmount'>): boolean {
  return sameAmountChoice(prefs, resp.source.merchantKey) ?? resp.mixed
}

/** The rows the list shows: all of them, or only the ones with the source's exact amount (sign included). */
export function visibleRows(rows: SimilarRow[], sameAmount: boolean): SimilarRow[] {
  return sameAmount ? rows.filter((r) => r.sameAmount) : rows
}

/** Starts ticked: the server's suggestion (never a person-set row; a script-set row only on an ordinary merchant). */
export function preTick(row: SimilarRow): boolean {
  return row.suggestTick
}

/** With the rule on, rows the rule will move anyway (neither a person nor a data fix chose their category) are ticked and locked. */
export function lockedByRule(row: SimilarRow, ruleOn: boolean): boolean {
  return ruleOn && !row.personSet && !row.scriptSet
}

/** The ids ticked now: the person's ticks over the visible rows, plus every rule-locked visible row. */
export function ticked(rows: SimilarRow[], chosen: ReadonlySet<string>, ruleOn: boolean): string[] {
  return rows.filter((r) => lockedByRule(r, ruleOn) || chosen.has(r.id)).map((r) => r.id)
}
