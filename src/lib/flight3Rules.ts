// Flight 3's rule readouts: the morning read prints nine numbered rules on every F3 read, each
// as `Rule <n> · <name>: <number> | threshold <t> → PASS | PROPOSE PAUSE | NOT YET | NO DATA`.
// Rules 1-4 are the coded kill rules (src/lib/adsRules.ts evaluateKillRules, numbers unchanged);
// 5-9 are the checks the runbook (docs/routines/ads-cloud-daily.md, "Flight 3") used to leave to a
// human read of the report:
//   5 tracking check (days 1-2)      6 cost per complete row     7 Apps first-move row ratio
//   8 traffic held (derived from 2 and 6, never counted twice)   9 D+7 verdict (decideFlight3)
// PROPOSE ONLY: nothing here pauses a campaign. Pure functions of counts and dollars: no I/O, no
// Intl (adsRules.ts is in the Worker bundle and this file is its sibling), no visitor id.
import { canProposePause, type DecisionResult, type Flight3DecisionRow, type RuleResult, type ServingState } from './adsRules'
import { MIN_COHORT } from './popupEvents'
import type { StagedArm } from './campaigns'

/** Rule 5: Search needs this many tagged complete rows before "zero ask rows" means broken tracking. */
export const F3_SEARCH_MIN_COMPLETES = 10
/** Rule 5: Apps needs this many tagged arrivals before "zero /coach/shown/place rows" means broken tracking. */
export const F3_APPS_MIN_ARRIVALS = 30
/** Rule 6 and 8: most a tagged complete row may cost. */
export const F3_MAX_COST_PER_COMPLETE_ROW = 3
/** Rule 7: first-move rows over d0 arrival rows must reach this share. */
export const F3_MIN_FIRST_MOVE_RATIO = 0.2
/** The validity floor: under this many ask rows the verdict is inconclusive, whatever the count. */
export const F3_VALIDITY_ASKS = 20
/** Go at this many new accounts or more, iterate from ITERATE_MIN, stop below it. */
export const F3_GO_MIN = 5
export const F3_ITERATE_MIN = 2
/** First flight day whose read judges a count that needs two days of data (rules 5 NO DATA, 6, 7), and the day CTR arms. */
export const F3_JUDGE_FROM_DAY = 3
/** First flight day whose read states the D+7 verdict (the final read, flight end + 1 = day 8). */
export const F3_VERDICT_FROM_DAY = 8

export type ReadoutVerdict = 'PASS' | 'PROPOSE PAUSE' | 'NOT YET' | 'NO DATA' | 'n/a' | 'GO' | 'ITERATE' | 'STOP' | 'INCONCLUSIVE'
export interface RuleReadout {
  /** 1-9. */
  n: number
  name: string
  /** The measured figure (or why there is none). */
  number: string
  /** What it is held to; null for an n/a rule. */
  threshold: string | null
  verdict: ReadoutVerdict
}

const usd = (x: number) => `$${x.toFixed(2)}`
const pct = (x: number, dp = 2) => `${(x * 100).toFixed(dp)}%`

/** `Rule <n> · <name>: <number> | threshold <t> → <verdict>`; an n/a rule has no threshold or verdict. */
export function ruleReadoutLine(r: RuleReadout): string {
  if (r.verdict === 'n/a' || r.threshold == null) return `Rule ${r.n} · ${r.name}: ${r.number}`
  return `Rule ${r.n} · ${r.name}: ${r.number} | threshold ${r.threshold} → ${r.verdict}`
}

const KILL_RULE_NUMBER: Record<RuleResult['id'], number> = { 'placement-leak': 1, ctr: 2, 'funnel-reach': 3, 'hard-cap': 4 }
const KILL_RULE_NAME: Record<RuleResult['id'], string> = { 'placement-leak': 'placement leak', ctr: 'CTR', 'funnel-reach': 'funnel reach', 'hard-cap': 'hard cap' }

/** A coded kill rule (1-4) in the readout shape: trip -> PROPOSE PAUSE, clear -> PASS, not armed ->
 * NOT YET (the hard cap, which is always "armed", reads PASS under its cap), no data -> NO DATA. */
export function killRuleReadout(r: RuleResult, ctx: { taggedArrivals?: number | null } = {}): RuleReadout {
  const n = KILL_RULE_NUMBER[r.id]
  const name = KILL_RULE_NAME[r.id]
  if (r.status === 'n/a') return { n, name, number: r.detail, threshold: null, verdict: 'n/a' }
  const verdict: ReadoutVerdict =
    r.status === 'trip' ? 'PROPOSE PAUSE' : r.status === 'clear' || r.status === 'watch' ? 'PASS' : r.status === 'not-armed' ? (r.id === 'hard-cap' ? 'PASS' : 'NOT YET') : 'NO DATA'
  let number = r.detail
  let threshold: string
  switch (r.id) {
    case 'placement-leak':
      threshold = `at most ${pct(r.limit, 0)} of spend outside the approved list`
      if (r.value != null) number = `${pct(r.value, 1)} of spend outside the approved list`
      break
    case 'ctr':
      threshold = `at least ${pct(r.limit)}`
      break
    case 'funnel-reach':
      threshold = 'at least 1 tagged sign-in ask'
      if (r.value != null) number = `${r.value} asks${ctx.taggedArrivals != null ? ` from ${ctx.taggedArrivals} tagged arrivals` : ''}`
      else if (r.status === 'no-data' && r.detail.includes('NOT COMPUTABLE')) number = 'not computable (no first-session ask beacon in the window to tell zero asks from a working funnel)'
      break
    case 'hard-cap':
      threshold = `under ${usd(r.limit)}`
      if (r.value != null) number = `${usd(r.value)} of ${usd(r.limit)}`
      else if (r.status === 'no-data') number = 'campaign status unreadable'
      break
  }
  return { n, name, number, threshold, verdict }
}

/** Cost per tagged complete row: closed-day spend over the tagged complete rows in the same closed days. null under 1 row. */
export function costPerCompleteRow(spend: number | null | undefined, rows: number | null | undefined): number | null {
  return spend != null && rows != null && rows > 0 ? spend / rows : null
}

/** The ET date arithmetic the flight day needs, without Intl (plain calendar days between two YYYY-MM-DD dates). */
export function flightDayOf(flightStartEt: string, dateEt: string): number {
  const ms = (d: string) => Date.parse(`${d}T00:00:00Z`)
  return Math.round((ms(dateEt) - ms(flightStartEt)) / 86_400_000) + 1
}

/** Flight 3's go / iterate / stop table (spec section 2): judged on tagged new accounts within the
 * arm's cap, valid only at 20+ ask rows (committed-repeat, committed-challenge and placement).
 * Under 20 asks it is INCONCLUSIVE whatever the count; otherwise 5+ go, 2-4 iterate, 0-1 stop. */
export function decideFlight3(newAccounts: number, asks: number): DecisionResult {
  const row: Flight3DecisionRow =
    asks < F3_VALIDITY_ASKS ? 'f3-inconclusive' : newAccounts >= F3_GO_MIN ? 'f3-go' : newAccounts >= F3_ITERATE_MIN ? 'f3-iterate' : 'f3-stop'
  const figure = `${newAccounts} new account${newAccounts === 1 ? '' : 's'} within the arm's cap, ${asks} ask row${asks === 1 ? '' : 's'} (committed-repeat, committed-challenge, placement)`
  switch (row) {
    case 'f3-go':
      return { row, reading: `Go: ${figure}.`, next: 'Propose flight 4 at a larger budget. Proposal only; Mike decides.' }
    case 'f3-iterate':
      return { row, reading: `Iterate: ${figure}.`, next: 'Iterate on the funnel and the creative before any larger budget. Proposal only; Mike decides.' }
    case 'f3-stop':
      return { row, reading: `Stop: ${figure}; at 20 or more asks the funnel is judged.`, next: 'Stop paid acquisition on this arm. Proposal only; Mike decides.' }
    default:
      return { row, reading: `Inconclusive: ${figure}; under ${F3_VALIDITY_ASKS} asks the result is neither go, iterate nor stop, whatever the new-account count.`, next: 'No go, iterate or stop on this arm. Report to Mike.' }
  }
}
const VERDICT_WORD: Record<Flight3DecisionRow, ReadoutVerdict> = { 'f3-go': 'GO', 'f3-iterate': 'ITERATE', 'f3-stop': 'STOP', 'f3-inconclusive': 'INCONCLUSIVE' }
/** `F3 verdict GO` for a flight 3 decision row; null for any other row. */
export function flight3VerdictWord(row: string): string | null {
  return row in VERDICT_WORD ? VERDICT_WORD[row as Flight3DecisionRow] : null
}

export interface Flight3RulesInput {
  arm: StagedArm
  /** Day 1 = the arm's flightStart (ET). */
  flightDay: number
  /** The coded kill rules 1-4, in any order (rule 4 from the daily hard-cap read when no fuller evaluation ran). */
  killRules: readonly RuleResult[]
  servingState: ServingState
  /** Closed-day spend is readable. */
  spendOk: boolean
  /** Cumulative closed-day spend, dollars. */
  closedSpend: number
  /** Cumulative tagged counts; null when the tagged read failed. */
  tagged: { taggedArrivals: number; completeRows: number; flight3Asks: number; coachShownPlace: number } | null
  /** Tagged complete rows in the same closed days as closedSpend; null when not read. */
  closedCompletes: number | null
  /** First-session tagged row counts (Apps rule 7); null when the first-session read failed. */
  firstSession: { firstMove: number | null; arrivals: number | null } | null
  /** Tagged /auth/success/<provider>/new rows, capped at Firestore new accounts once that was read. */
  signUps: { count: number; note: string } | null
}
export interface Flight3Block {
  arm: StagedArm
  flightDay: number
  /** Rules 1-9, in order. */
  readouts: RuleReadout[]
  /** Rule numbers (1-7) that read PROPOSE PAUSE. Rule 8 is derived from 2 and 6, and rule 9 is a verdict: neither counts here. */
  tripped: number[]
  /** null = rules tripped but the campaign is not serving, so there is nothing to pause. */
  proposal: 'PROPOSE PAUSE' | 'CONTINUE' | null
  servingState: ServingState
  /** Cumulative and yesterday's cost per tagged complete row (null under 1 row), for the "Tagged so far" line. */
  costPerRow: { cumulative: number | null; yesterday: number | null }
}

/** Rules 5-9 and the whole block. `ctrFloor` is the arm's CTR floor, only to word rule 8's threshold. */
export function buildFlight3Rules(i: Flight3RulesInput, opts: { ctrFloor?: number; costPerRowYesterday?: number | null } = {}): Flight3Block {
  const day = i.flightDay
  const search = i.arm === 'search'
  const killByN = new Map<number, RuleReadout>()
  for (const r of i.killRules) killByN.set(KILL_RULE_NUMBER[r.id], killRuleReadout(r, { taggedArrivals: i.tagged?.taggedArrivals }))
  const missing = (n: number): RuleReadout => ({ n, name: ['placement leak', 'CTR', 'funnel reach', 'hard cap'][n - 1], number: 'not evaluated', threshold: 'n/a', verdict: 'NO DATA' })
  const readouts: RuleReadout[] = [1, 2, 3, 4].map((n) => killByN.get(n) ?? missing(n))
  const t = i.tagged

  // 5. Tracking check: a week of spend on broken tracking is the cost this rule exists to cap.
  {
    let number: string
    let threshold: string
    let verdict: ReadoutVerdict
    if (search) {
      threshold = `${F3_SEARCH_MIN_COMPLETES}+ complete rows need 1+ sign-in ask row`
      number = t ? `${t.completeRows} complete rows, ${t.flight3Asks} sign-in ask rows` : 'tagged read failed'
      if (day < 2) verdict = 'NOT YET'
      else if (!t) verdict = 'NO DATA'
      else if (t.completeRows >= F3_SEARCH_MIN_COMPLETES) verdict = t.flight3Asks === 0 ? 'PROPOSE PAUSE' : 'PASS'
      else if (day < F3_JUDGE_FROM_DAY) verdict = 'NOT YET'
      else {
        verdict = 'NO DATA'
        number += '; too few rows to judge'
      }
    } else {
      threshold = `${F3_APPS_MIN_ARRIVALS}+ tagged arrivals need 1+ /coach/shown/place row`
      number = t ? `${t.taggedArrivals} tagged arrivals, ${t.coachShownPlace} /coach/shown/place rows` : 'tagged read failed'
      if (day < 2) verdict = 'NOT YET'
      else if (!t) verdict = 'NO DATA'
      else if (t.taggedArrivals >= F3_APPS_MIN_ARRIVALS) verdict = t.coachShownPlace === 0 ? 'PROPOSE PAUSE' : 'PASS'
      else if (day < F3_JUDGE_FROM_DAY) verdict = 'NOT YET'
      else {
        verdict = 'NO DATA'
        number += '; too few rows to judge'
      }
    }
    readouts.push({ n: 5, name: 'tracking check', number, threshold, verdict })
  }

  // 6. Cost per complete row. 0 rows once spend is over the max is itself the finding: the arm bought no completes.
  const cost = i.spendOk ? costPerCompleteRow(i.closedSpend, i.closedCompletes) : null
  {
    const threshold = `at most ${usd(F3_MAX_COST_PER_COMPLETE_ROW)} a complete row`
    let number: string
    let verdict: ReadoutVerdict
    if (!i.spendOk || i.closedCompletes == null) number = !i.spendOk ? 'spend not read' : 'tagged complete rows not read'
    else if (i.closedCompletes === 0) number = `0 complete rows from ${usd(i.closedSpend)}`
    else number = `${usd(cost!)} per complete row (${usd(i.closedSpend)} / ${i.closedCompletes} rows)`
    if (day < F3_JUDGE_FROM_DAY) verdict = 'NOT YET'
    else if (!i.spendOk || i.closedCompletes == null) verdict = 'NO DATA'
    else if (i.closedCompletes === 0) verdict = i.closedSpend > F3_MAX_COST_PER_COMPLETE_ROW ? 'PROPOSE PAUSE' : 'NO DATA'
    else verdict = cost! > F3_MAX_COST_PER_COMPLETE_ROW ? 'PROPOSE PAUSE' : 'PASS'
    readouts.push({ n: 6, name: 'cost per complete row', number, threshold, verdict })
  }

  // 7. First-move row ratio (Apps only): first-move rows over /return/<uc>/d0 arrival rows. Row counts with no visitor join.
  {
    const name = 'first-move row ratio'
    if (search) readouts.push({ n: 7, name, number: 'n/a (Apps arm only)', threshold: null, verdict: 'n/a' })
    else {
      const fm = i.firstSession?.firstMove ?? null
      const d0 = i.firstSession?.arrivals ?? null
      const ready = fm != null && d0 != null && d0 >= MIN_COHORT
      const number = ready
        ? `${pct(fm / d0, 1)} (${fm} first-move rows / ${d0} d0 rows; row ratio, same definition as F2's 6.4%)`
        : `${fm ?? '—'} first-move rows / ${d0 ?? '—'} d0 rows (needs ${MIN_COHORT}+ d0 rows; row ratio, same definition as F2's 6.4%)`
      const verdict: ReadoutVerdict = day < F3_JUDGE_FROM_DAY ? 'NOT YET' : !ready ? 'NO DATA' : fm / d0 < F3_MIN_FIRST_MOVE_RATIO ? 'PROPOSE PAUSE' : 'PASS'
      readouts.push({ n: 7, name, number, threshold: `at least ${pct(F3_MIN_FIRST_MOVE_RATIO, 0)} of d0 rows`, verdict })
    }
  }

  // 8. Traffic held: derived from rules 2 and 6 (cost per complete row and the CTR floor), never counted twice.
  {
    const r2 = readouts[1]
    const r6 = readouts[5]
    const verdict: ReadoutVerdict =
      r2.verdict === 'PROPOSE PAUSE' || r6.verdict === 'PROPOSE PAUSE'
        ? 'PROPOSE PAUSE'
        : r2.verdict === 'NOT YET' || r6.verdict === 'NOT YET'
          ? 'NOT YET'
          : r2.verdict === 'NO DATA' || r6.verdict === 'NO DATA'
            ? 'NO DATA'
            : 'PASS'
    const cpr = cost != null ? usd(cost) : i.closedCompletes === 0 ? `no complete rows (${usd(i.closedSpend)})` : 'not readable'
    const ctr = i.killRules.find((r) => r.id === 'ctr')
    const ctrText = ctr?.value != null ? pct(ctr.value) : 'not readable yet'
    readouts.push({
      n: 8,
      name: 'traffic held',
      number: `cost per complete row ${cpr}, CTR ${ctrText} (derived from rules 2 and 6)`,
      threshold: `complete rows at most ${usd(F3_MAX_COST_PER_COMPLETE_ROW)} each and CTR at least ${opts.ctrFloor != null ? pct(opts.ctrFloor) : 'the arm floor'}`,
      verdict,
    })
  }

  // 9. D+7 verdict: the go / iterate / stop table. NOT YET until the final read; before it, the running figure and what the table would say.
  {
    const threshold = `5+ new accounts go, 2-4 iterate, 0-1 stop; under ${F3_VALIDITY_ASKS} asks inconclusive`
    if (!t || !i.signUps) readouts.push({ n: 9, name: 'D+7 verdict', number: 'tagged read failed', threshold, verdict: day >= F3_VERDICT_FROM_DAY ? 'NO DATA' : 'NOT YET' })
    else {
      const d = decideFlight3(i.signUps.count, t.flight3Asks)
      const word = VERDICT_WORD[d.row as Flight3DecisionRow]
      const base = `${i.signUps.count} new accounts (${i.signUps.note}), ${t.flight3Asks} ask rows`
      if (day >= F3_VERDICT_FROM_DAY) readouts.push({ n: 9, name: 'D+7 verdict', number: base, threshold, verdict: word })
      else readouts.push({ n: 9, name: 'D+7 verdict', number: `${base}; running, the table would say ${word}`, threshold, verdict: 'NOT YET' })
    }
  }

  const tripped = readouts.filter((r) => r.n <= 7 && r.verdict === 'PROPOSE PAUSE').map((r) => r.n)
  const proposal = !tripped.length ? 'CONTINUE' : canProposePause(i.servingState) ? 'PROPOSE PAUSE' : null
  return {
    arm: i.arm,
    flightDay: day,
    readouts,
    tripped,
    proposal,
    servingState: i.servingState,
    costPerRow: { cumulative: cost, yesterday: opts.costPerRowYesterday ?? null },
  }
}
