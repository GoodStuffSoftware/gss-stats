// Human-readable reports for the ads-read CLIs. Pure functions of the result objects
// (read.ts), so they are unit-tested and the JSON block always carries the same numbers the
// text shows. Every rate is printed with its counts (formatGated) and MIN_COHORT-gated;
// sign-ups and promo claims appear only as window COUNTS.

import { formatGated, SIGNIN_ELIGIBLE_COUNT_NOTE, UPSELL_KNOWN_BUG_NOTE, type OutcomePopup, type RuleResult } from '../../src/lib/adsRules'
import { POPUP_OUTCOME_TYPES, gateRate, installOutcomeGapNote } from '../../src/lib/popupEvents'
import { RAW_INSTALL_SIGNALS_LABEL } from '../../src/lib/campaigns'
import type { FullRead, MorningResult, PostflightResult, SpendSection } from './read'

const money = (x: number | null | undefined) => (x == null ? '—' : `$${x.toFixed(2)}`)
const n = (x: number | null | undefined) => (x == null ? '—' : x.toLocaleString('en-US'))
const pct = (x: number | null | undefined, dp = 2) => (x == null ? '—' : `${(x * 100).toFixed(dp)}%`)

function spendLines(s: SpendSection): string[] {
  if (!s.ok) return [`Spend: NOT READ (${s.error})`]
  const ctr = gateRate(s.cumulative.clicks, s.cumulative.impressions)
  const lines = [
    `Spend (Google Ads API, closed days through ${s.throughEt ?? 'none yet'}): yesterday ${s.yesterday ? `${money(s.yesterday.cost)} (budget ${money(s.dailyBudget)}), ${n(s.yesterday.impressions)} impr, ${n(s.yesterday.clicks)} clicks` : '—'}`,
    `  cumulative ${money(s.cumulative.cost)} of the ${money(s.hardCap)} cap over ${s.cumulative.days} day(s); CTR ${ctr.value == null ? '—' : pct(ctr.value)} (${n(s.cumulative.clicks)}/${n(s.cumulative.impressions)})${s.todayPartial ? `; today so far ${money(s.todayPartial.cost)} (partial, not counted)` : ''}`,
  ]
  for (const r of s.restated) lines.push(`  restated: ${r.date} ${money(r.before)} → ${money(r.after)}`)
  return lines
}

function ruleLine(r: RuleResult): string {
  return `  [${r.status}] ${r.label}: ${r.detail}`
}

export function fullReadLines(r: FullRead, title: string): string[] {
  const out: string[] = [`=== ${title} (cumulative ${money(r.cumulativeSpend)}, closed days through ${r.spendThroughEt ?? '—'}) — ${r.complete ? 'complete' : 'INCOMPLETE, retried next run'} ===`]
  out.push('Kill rules (propose only; nothing is changed):')
  for (const rule of r.kill.rules) out.push(ruleLine(rule))
  out.push(`Proposal: ${r.kill.proposal}`)
  if (r.placements) {
    out.push(`Placements: ${money(r.placements.approvedCost)} on approved, ${money(r.placements.itemizedCost)} itemized, of ${money(r.placements.campaignCost)}; outside share ${pct(r.placements.outsideShare)}`)
    for (const o of r.placements.offList) out.push(`  off-list: ${o.name} ${money(o.cost)}`)
  }
  const t = r.tagged
  if (t) {
    const s = t.summary
    out.push(
      `Tagged funnel (campaign tag only, exclusions applied): ${n(s.taggedArrivals)} arrivals (floor), ${n(s.taggedHits)} hits; played ${n(s.funnel.played)}; asks ${n(s.asks.total)} (placement ${n(s.asks.byPath['/signin-prompt/placement'])}, streak ${n(s.asks.byPath['/signin-prompt/streak'])}, promo ${n(s.asks.byPath['/promo-first50/shown'])}${s.asks.otherShownReasons ? `, other sign-in reasons ${n(s.asks.otherShownReasons)}` : ''}); accepts ${n(s.accepts.total)}; auth redirect ${n(s.authRedirect)}, auth success ${n(s.authSuccess)}`,
    )
    out.push(`  ask rate ${formatGated(t.askRate)}; accept rate ${formatGated(t.acceptRate)}; cost per tagged arrival ${money(t.costPerArrival)}`)
    out.push(`  dismisses (read separately): sign-in ${n(s.dismisses.signinPrompt)}, promo ${n(s.dismisses.promoFirst50)}`)
    out.push(`  install: prompt shown ${n(s.install.promptShown)}, taps ${n(s.install.taps)}, installed ${n(s.install.installed)} [${installOutcomeGapNote()}]; ${RAW_INSTALL_SIGNALS_LABEL} ${n(s.install.rawSignals)}; signin-eligible (count of asks) earned ${n(s.signinEligible.earned)}, capped ${n(s.signinEligible.capped)}, unearned ${n(s.signinEligible.unearned)}`)
  }
  if (r.site) {
    const s = r.site.summary
    out.push('Site-wide on bestsudoku-web since the 2026-09-26 go-live (NOT campaign-attributed):')
    const popups: [OutcomePopup, string][] = [
      ['signin-prompt', 'sign-in prompt'],
      ['promo-first50', 'first-50 promo'],
      ['upsell', 'upsell'],
      ['install', 'install prompt'],
    ]
    for (const [p, label] of popups) {
      const rates = POPUP_OUTCOME_TYPES.map((o) => `${o} ${formatGated(r.site!.outcomeRates[p][o])}`).join(', ')
      out.push(`  ${label}: shown ${n(s.shown[p])}; outcomes ${rates}`)
    }
    out.push(`  promo accept/dismiss ${n(s.promoFirst50.accept)}/${n(s.promoFirst50.dismiss)}; upsell accept/dismiss ${n(s.upsell.accept)}/${n(s.upsell.dismiss)}; install-prompt installed ${n(s.outcomes.install.installed)} [${installOutcomeGapNote()}]; ${RAW_INSTALL_SIGNALS_LABEL} ${n(s.rawInstallSignals)}`)
    out.push(`  signin-eligible: earned ${n(s.signinEligible.earned)}, capped ${n(s.signinEligible.capped)}, unearned ${n(s.signinEligible.unearned)} (${SIGNIN_ELIGIBLE_COUNT_NOTE})`)
    if (s.upsell.shown <= 1) out.push(`  ${UPSELL_KNOWN_BUG_NOTE}`)
  }
  if (r.returns) {
    const fmt = (c: Record<string, number>, rates: Record<string, number | null>) =>
      `d0 ${n(c.d0)}; ` + ['d1', 'd2-7', 'd8-14', 'd15-30', 'd31-60'].map((b) => `${b} ${formatGated(gateRate(c[b], c.d0))}`).join(', ')
    out.push(`Returns /return/<uc>/ (attributed by the path): web ${fmt(r.returns.web, r.returns.webRates)}`)
    out.push(`  app ${fmt(r.returns.app, r.returns.appRates)}`)
  }
  if (r.play) out.push(r.play.line)
  if (r.firebase) {
    const f = r.firebase
    out.push(
      `Accounts (Firestore COUNT queries, window only, nobody matched): new ${n(f.newAccountsInWindow)} (of ${n(f.accountsWithCreatedAt)} with createdAt); promo claims ${n(f.promoClaimsInWindow)} (of ${n(f.promoClaimsTotal)}); first-50 ${f.first50 ? `${n(f.first50.claimed)}/${n(f.first50.cap)} claimed, ${f.first50.closed ? 'closed' : 'open'}` : '—'}`,
    )
  } else out.push('Accounts: not read (no --firebase-sa)')
  if (r.decision) {
    out.push(`Decision table (spec section 13): row ${r.decision.row}; sign-ups ${r.decision.signUps} = ${r.decision.basis}`)
    out.push(`  reading: ${r.decision.reading}`)
    out.push(`  next: ${r.decision.next}`)
  }
  if (r.errors.length) out.push(`Read errors: ${r.errors.join(' | ')}`)
  return out
}

const ET_MINUTE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
function etMinuteLabel(ms: number): string {
  const p = Object.fromEntries(ET_MINUTE.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ET`
}

function header(r: MorningResult | PostflightResult, kind: string): string[] {
  const et = etMinuteLabel(Date.parse(r.readAt))
  const s = r.status
  return [
    `BSK retest ${kind}, ${et}${r.dryRun ? ' [DRY RUN: nothing written]' : ''}`,
    `Campaign ${r.campaign.id} "${r.campaign.label}" (${r.campaign.ucValues.join(', ')}): ${s ? `${s.status}/${s.servingStatus}${s.dailyBudget != null ? `, budget ${money(s.dailyBudget)}/day` : ''}` : `status NOT READ (${r.statusError})`}`,
  ]
}

export function formatMorningReport(r: MorningResult): string {
  const out = header(r, r.mode === 'health-only' ? 'release-health backstop' : 'morning read')
  if (r.mode === 'morning') {
    out.push(...spendLines(r.spend))
    const t = r.tagged
    out.push(
      t.ok
        ? `Tagged so far: ${n(t.cumulative!.taggedArrivals)} arrivals (floor), ${n(t.cumulative!.taggedHits)} hits, ${n(t.cumulative!.asks)} asks, ${n(t.cumulative!.accepts)} accepts, ${n(t.cumulative!.authSuccess)} auth successes; yesterday ${n(t.yesterday!.taggedArrivals)} arrivals, ${n(t.yesterday!.asks)} asks`
        : `Tagged: NOT READ (${t.error})`,
    )
    const th = r.thresholds
    out.push(
      th.crossedNow.length
        ? `Thresholds: CROSSED ${th.crossedNow.map((x) => `$${x}`).join(', ')} (already fired: ${th.consumedBefore.length ? th.consumedBefore.map((x) => `$${x}`).join(', ') : 'none'})`
        : `Thresholds: none newly crossed (next ${th.next == null ? 'none' : `$${th.next}`}; fired: ${th.consumedBefore.length ? th.consumedBefore.map((x) => `$${x}`).join(', ') : 'none'})${th.stateError ? ` [state unreadable: ${th.stateError}]` : ''}`,
    )
    if (r.hardCapDaily) out.push(`Hard cap (every read): [${r.hardCapDaily.status}] ${r.hardCapDaily.detail}`)
  } else {
    out.push(r.spend.ok ? `Today so far: ${money(r.spend.todayPartial?.cost ?? 0)} (served today: ${(r.spend.todayPartial?.cost ?? 0) > 0 ? 'yes' : 'no'})` : `Spend: NOT READ (${r.spend.error})`)
  }
  const h = r.releaseHealth
  if (!h.evaluated) out.push(`Release health: ${h.reason}`)
  else {
    out.push(`Release health (${h.reason}): ${h.alerts ? `${h.alerts} ALERT(S)` : 'no alerts'}`)
    for (const x of h.results ?? []) out.push(`  [${x.status}] ${x.parentLabel} ${n(x.parent)} → ${x.childLabel} ${n(x.children)}${x.status === 'known-gap' ? ' (known gap, never alerts)' : ''}`)
  }
  if (r.play) out.push(r.play.line)
  if (r.thresholdRead) out.push('', ...fullReadLines(r.thresholdRead, `THRESHOLD READ at $${Math.max(...r.thresholdRead.thresholds)}`))
  out.push('', storeLine(r))
  out.push(`Errors: ${r.errors.length ? r.errors.join(' | ') : 'none'}`)
  out.push(`Push: ${r.notify.push ? `YES (${r.notify.reason}): ${r.notify.text}` : `no (${r.notify.reason})`}${r.notify.busCopy ? ' + bus copy' : ''}`)
  out.push(`Notes: ${r.notes.join(' / ')}`)
  return out.join('\n')
}

function storeLine(r: MorningResult | PostflightResult): string {
  const s = r.store
  if (s.dryRun) return `Store (${s.kind}): dry run, nothing written`
  return `Store (${s.kind}): campaigns ${s.campaignsSynced ? 'synced' : 'NOT synced'}, spend ${s.spendWritten ? 'written' : 'NOT written'}, readings ${s.readingsWritten ? 'written' : 'NOT written'}${s.errors.length ? ` [${s.errors.join(' | ')}]` : ''}`
}

export function formatPostflightReport(r: PostflightResult): string {
  const out = header(r, `post-flight ${r.stage} read`)
  out.push(...spendLines(r.spend))
  out.push(`Spend ended ${r.spendEndEt ?? '—'}; this stage is due ${r.dueEt ?? '—'} (${r.due ? 'due' : 'NOT due yet'})`)
  if (r.postFlightSpend) out.push(`After-flight spend: [${r.postFlightSpend.status}] ${r.postFlightSpend.detail}`)
  if (r.read) out.push('', ...fullReadLines(r.read, `POST-FLIGHT ${r.stage.toUpperCase()}`))
  const b = r.promoSplit.beacon
  if (b) {
    const row = (o: Record<string, number>, shown: number) => POPUP_OUTCOME_TYPES.map((t) => `${t} ${formatGated(gateRate(o[t], shown))}`).join(', ')
    out.push(`Promo vs non-promo (site-wide outcome beacons, anonymous): promo shown ${n(b.promoShown)}: ${row(b.promo, b.promoShown)}`)
    out.push(`  sign-in prompt (non-promo) shown ${n(b.nonPromoShown)}: ${row(b.nonPromo, b.nonPromoShown)}`)
  }
  const a = r.promoSplit.accounts
  if (a) out.push(`  accounts in the flight window: ${n(a.newInWindow)} new, ${n(a.promoClaimsInWindow)} promo claims, ~${n(a.nonPromoInWindow)} non-promo (counts only)`)
  out.push('', storeLine(r))
  out.push(`Errors: ${r.errors.length ? r.errors.join(' | ') : 'none'}`)
  out.push(`Push: ${r.notify.push ? `YES (${r.notify.reason}): ${r.notify.text}` : `no (${r.notify.reason})`}${r.notify.busCopy ? ' + bus copy' : ''}`)
  out.push(`Notes: ${r.notes.join(' / ')}`)
  return out.join('\n')
}

/** The report followed by the machine-readable block the routine prompt parses. */
export function withJson(text: string, result: unknown): string {
  return `${text}\n\n----- JSON -----\n${JSON.stringify(result, null, 2)}\n`
}
