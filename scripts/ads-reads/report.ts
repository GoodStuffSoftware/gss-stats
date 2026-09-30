// Human-readable reports for the ads-read CLIs. Pure functions of the result objects
// (read.ts), so they are unit-tested and the JSON block always carries the same numbers the
// text shows. Every rate is printed with its counts (formatGated) and MIN_COHORT-gated;
// sign-ups and promo claims appear only as window COUNTS.

import {
  formatGated,
  isPlacementBorderline,
  PLACEMENT_BORDERLINE_NOTE,
  promoArmAbsentNote,
  SIGNIN_ELIGIBLE_COUNT_NOTE,
  UPSELL_SIGNEDOUT_EXPECTED_NOTE,
  type OutcomePopup,
  type RuleResult,
} from '../../src/lib/adsRules'
import { POPUP_OUTCOME_TYPES, gateRate, installOutcomeGapNote } from '../../src/lib/popupEvents'
import { RAW_INSTALL_SIGNALS_LABEL } from '../../src/lib/campaigns'
import { noteRawText } from '../../src/lib/notes'
import type { DiagnosticsSection, FullRead, MorningResult, PostflightResult, SpendSection } from './read'
import type { FirebaseCounts } from './firebase'

// `/game` rows are page views, not games played (ADR 0003): the registry label, lower-cased
// for the middle of a sentence.
const GAME_VIEWS = noteRawText('label.campaign.gameViews').toLowerCase()

const money = (x: number | null | undefined) => (x == null ? '—' : `$${x.toFixed(2)}`)
const n = (x: number | null | undefined) => (x == null ? '—' : x.toLocaleString('en-US'))
const pct = (x: number | null | undefined, dp = 2) => (x == null ? '—' : `${(x * 100).toFixed(dp)}%`)

/** What the shared sync (src/lib/adsSync.ts) did before the read. */
export function syncLine(s: SpendSection): string {
  const y = s.sync
  if (!y) return '  sync: not run'
  const pulled = y.ranges?.length ? y.ranges.map((r) => `${r.since}..${r.until}`).join(', ') : y.fetched ? `${y.fetched.since}..${y.fetched.until}` : null
  return `  sync (shared): ${y.outcome}${pulled ? `, pulled ${pulled}` : ''}; ${n(y.daysChanged)} day row(s) and ${n(y.placementRowsChanged)} placement row(s) changed; stored through ${y.spendThrough ?? '—'}${s.sync && !y.runRecorded ? '; sync run not recorded' : ''}${y.warnings?.length ? `; warning: ${y.warnings.join('; ')}` : ''}`
}

/** Killed sync runs (review I2), one line each. */
export function syncAlertLines(s: SpendSection): string[] {
  return (s.syncAlerts ?? []).map((m) => `  SYNC ALERT: ${m}`)
}

function spendLines(s: SpendSection): string[] {
  if (!s.ok) return [`Spend: NOT READ (${s.error})`, syncLine(s), ...syncAlertLines(s)]
  const ctr = gateRate(s.cumulative.clicks, s.cumulative.impressions)
  const lines = [
    `Spend (Google Ads API, closed days through ${s.throughEt ?? 'none yet'}): yesterday ${s.yesterday ? `${money(s.yesterday.cost)} (budget ${money(s.dailyBudget)}), ${n(s.yesterday.impressions)} impr, ${n(s.yesterday.clicks)} clicks` : '—'}`,
    `  cumulative ${money(s.cumulative.cost)} of the ${money(s.hardCap)} cap over ${s.cumulative.days} day(s); CTR ${ctr.value == null ? '—' : pct(ctr.value)} (${n(s.cumulative.clicks)}/${n(s.cumulative.impressions)})${s.todayPartial ? `; today so far ${money(s.todayPartial.cost)} (partial, not counted)` : ''}`,
    syncLine(s),
    ...syncAlertLines(s),
  ]
  for (const r of s.restated) lines.push(`  restated: ${r.date} ${money(r.before)} → ${money(r.after)}`)
  return lines
}

function ruleLine(r: RuleResult): string {
  return `  [${r.status}] ${r.label}: ${r.detail}`
}

/** The promo-arm note goes on the $50-and-later threshold reads and every post-flight stage:
 * their promo-ask counts span the hours when the client showed no first-50 offer at all. */
export function promoArmNoteApplies(r: FullRead, postflight: boolean): boolean {
  return postflight || (r.thresholds.length > 0 && Math.max(...r.thresholds) >= 50)
}

/** The first-50 part of the Accounts line: the promos/first50 COUNTER and, separately, what the
 * signed-out client sees (promos_public/first50). Report text only. */
export function first50Text(f: FirebaseCounts): string {
  const counter = f.first50 ? `counter ${n(f.first50.claimed)}/${n(f.first50.cap)} claimed, ${f.first50.closed ? 'closed' : 'open'}` : 'counter not read'
  const c = f.first50Client
  let client: string
  if (!c || c.state === 'unknown') client = `client offer UNKNOWN (read failed: ${c?.error ?? 'not read'})`
  else if (c.exists === false) client = 'client offer HIDDEN (promos_public missing)'
  else {
    const upd = c.updateTime && !Number.isNaN(Date.parse(c.updateTime)) ? `, updated ${etMinuteLabel(Date.parse(c.updateTime))}` : ''
    client = `client offer ${c.state === 'visible' ? 'VISIBLE' : 'HIDDEN'} (promos_public open=${c.open == null ? 'unset' : String(c.open)}${upd})`
  }
  return `first-50: ${counter}; ${client}`
}

/** A loud line when the counter and the client disagree (null when they agree or either side is
 * unknown). Report text only: never a kill rule, never a push. */
export function first50FlagLine(f: FirebaseCounts): string | null {
  const c = f.first50Client
  if (!f.first50 || f.first50.closed == null || !c || c.state === 'unknown') return null
  const counterOpen = f.first50.closed === false
  if (counterOpen && c.state === 'hidden') return 'FLAG: first-50 counter says open but the client offer is hidden'
  if (!counterOpen && c.state === 'visible') return 'FLAG: first-50 counter says closed but the client offer is visible'
  return null
}

export function fullReadLines(r: FullRead, title: string, opts: { postflight?: boolean } = {}): string[] {
  const promoNote = promoArmNoteApplies(r, !!opts.postflight)
  const out: string[] = [`=== ${title} (cumulative ${money(r.cumulativeSpend)}, closed days through ${r.spendThroughEt ?? '—'}) — ${r.complete ? 'complete' : 'INCOMPLETE, retried next run'} ===`]
  out.push('Kill rules (propose only; nothing is changed):')
  for (const rule of r.kill.rules) out.push(ruleLine(rule))
  out.push(`Proposal: ${r.kill.proposal ?? `none: campaign ${r.kill.servingState === 'ended' ? 'ended' : r.kill.servingState === 'paused' ? 'paused' : 'not serving'}, nothing to pause`}`)
  if (r.placements) {
    out.push(
      `Placements: ${money(r.placements.approvedCost)} on approved, ${money(r.placements.itemizedCost)} itemized, of ${money(r.placements.campaignCost)}; outside share ${pct(r.placements.outsideShare)}${isPlacementBorderline(r.placements.outsideShare) ? ` (${PLACEMENT_BORDERLINE_NOTE})` : ''}`,
    )
    for (const o of r.placements.offList) out.push(`  off-list: ${o.name} ${money(o.cost)}`)
  }
  const t = r.tagged
  if (t) {
    const s = t.summary
    out.push(
      `Tagged funnel (campaign tag only, exclusions applied): ${n(s.taggedArrivals)} arrivals (floor), ${n(s.taggedHits)} hits; ${GAME_VIEWS} ${n(s.funnel.played)}; asks ${n(s.asks.total)} (placement ${n(s.asks.byPath['/signin-prompt/placement'])}, streak ${n(s.asks.byPath['/signin-prompt/streak'])}, promo ${n(s.asks.byPath['/promo-first50/shown'])}${s.asks.otherShownReasons ? `, other sign-in reasons ${n(s.asks.otherShownReasons)}` : ''}); accepts ${n(s.accepts.total)}; auth redirect ${n(s.authRedirect)}, auth success ${n(s.authSuccess)}`,
    )
    // Not a rate (review finding, 2026-09-26): "asks" counts event rows within a tagged
    // session, "arrivals" counts first-ever tagged beacons — dividing one by the other mixes
    // units with no shared visitor id to join them on, so this is a count pair, not a percent.
    // acceptRate IS a real rate (accepts/asks — the same popup, the same session).
    if (promoNote) out.push(`  promo asks: ${promoArmAbsentNote()}`)
    out.push(`  ${n(s.asks.total)} asks · ${n(s.taggedArrivals)} arrivals; accept rate ${formatGated(t.acceptRate)}; cost per tagged arrival ${money(t.costPerArrival)}`)
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
      out.push(`  ${label}: shown ${n(s.shown[p])}; outcomes ${rates}${p === 'promo-first50' && promoNote ? `; ${promoArmAbsentNote()}` : ''}`)
    }
    out.push(`  promo accept/dismiss ${n(s.promoFirst50.accept)}/${n(s.promoFirst50.dismiss)}; upsell accept/dismiss ${n(s.upsell.accept)}/${n(s.upsell.dismiss)}; install-prompt installed ${n(s.outcomes.install.installed)} [${installOutcomeGapNote()}]; ${RAW_INSTALL_SIGNALS_LABEL} ${n(s.rawInstallSignals)}`)
    out.push(`  signin-eligible: earned ${n(s.signinEligible.earned)}, capped ${n(s.signinEligible.capped)}, unearned ${n(s.signinEligible.unearned)} (${SIGNIN_ELIGIBLE_COUNT_NOTE})`)
    if (s.upsell.shown <= 1) out.push(`  ${UPSELL_SIGNEDOUT_EXPECTED_NOTE}`)
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
      `Accounts (Firestore COUNT queries, window only, nobody matched): new ${n(f.newAccountsInWindow)} (of ${n(f.accountsWithCreatedAt)} with createdAt); promo claims ${n(f.promoClaimsInWindow)} (of ${n(f.promoClaimsTotal)}); ${first50Text(f)}`,
    )
    const flag = first50FlagLine(f)
    if (flag) out.push(`  ${flag}`)
  } else out.push('Accounts: not read (no --firebase-sa)')
  if (r.decision) {
    out.push(`Decision table (spec section 13): row ${r.decision.row}; ${r.decision.label}`)
    out.push(`  reading: ${r.decision.reading}`)
    out.push(`  next: ${r.decision.next}`)
  }
  if (r.segments) {
    const s = r.segments
    out.push(`Segments at the signed-out upsell fix (${s.boundaryLabel}) — two separate short tests (spec section 14a):`)
    for (const [name, f] of [['pre-fix', s.pre], ['post-fix', s.post]] as const) {
      out.push(
        `  ${name}: spend ${money(f.spend)} over ${f.spendDays} closed day(s); ${n(f.taggedArrivals)} tagged arrivals; asks ${n(f.asks)}, accepts ${n(f.accepts)} (accept rate ${formatGated(gateRate(f.accepts, f.asks))}); ${f.signUps.label}; upsell shown ${n(f.upsell.shown)}, accepted ${n(f.upsell.accept)}`,
      )
    }
    out.push(`  fix day ${s.boundaryDay}: spend ${money(s.boundaryDaySpend)} (straddles the fix; Ads spend is per ET day)`)
    out.push(`  ${s.note}`)
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
  if (r.failures.length) out.push(`READ FAILED: ${r.failureDetails.join("; ")}`)
  const flag1 = r.thresholdRead?.firebase ? first50FlagLine(r.thresholdRead.firebase) : null
  if (flag1) out.push(flag1)
  if (r.missedReads.length) out.push(`Previous scheduled read missing: ${r.missedReads.join(', ')}`)
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
    out.push(syncLine(r.spend), ...syncAlertLines(r.spend))
  }
  const h = r.releaseHealth
  if (!h.evaluated) out.push(`Release health: ${h.reason}`)
  else {
    out.push(`Release health (${h.reason}): ${h.alerts ? `${h.alerts} ALERT(S)` : 'no alerts'}`)
    for (const x of h.results ?? []) out.push(`  [${x.status}] ${x.parentLabel} ${n(x.parent)} → ${x.childLabel} ${n(x.children)}${x.status === 'known-gap' ? ' (known gap, never alerts)' : ''}`)
  }
  if (r.play) out.push(r.play.line)
  const diag = diagnosticsLines(r.diagnostics)
  if (diag.length) out.push('', ...diag)
  const playLines = playReportsLines(r.playReports)
  if (playLines.length) out.push('', ...playLines)
  if (r.thresholdRead) out.push('', ...fullReadLines(r.thresholdRead, `THRESHOLD READ at $${Math.max(...r.thresholdRead.thresholds)}`))
  out.push('', storeLine(r))
  out.push(`Errors: ${r.errors.length ? r.errors.join(' | ') : 'none'}`)
  out.push(`Push: ${r.notify.push ? `YES (${r.notify.reason}): ${r.notify.text}` : `no (${r.notify.reason})`}${r.notify.busCopy ? ' + bus copy' : ''}`)
  out.push(`Notes: ${r.notes.join(' / ')}`)
  return out.join('\n')
}

/** Standing Recommendations verdicts (R3), carried from the retired routines, never
 * re-derived and never acted on here (this file only formats text). */
const RECOMMENDATION_STANDING_VERDICTS = 'Maximize Conversions REJECT; conversion tracking REJECT PERMANENTLY; Customer Match REJECT; Optimized targeting REJECT'

/** R2/R3/R5/R8 diagnostic depth: every line here is informational only. An "ANOMALY" tag
 * means "propose to Mike" in the sense of flagging it in the report text — it is never wired
 * to `notify.push`, never a kill rule, never an automatic action (contract sections 12-13 are
 * unchanged by this file). */
function diagnosticsLines(d: DiagnosticsSection): string[] {
  const empty = !d.hourly && !d.geo && !d.devices && !d.targeting && !d.recommendations && !d.countryCounts && !d.accountCrossCheck && !d.errors.length
  if (empty) return []
  const out = [`Diagnostics for ${d.spendThroughEt ?? 'the closed day'} (informational only; never a kill rule or an automatic action):`]
  if (d.hourly) {
    const top = [...d.hourly].sort((a, b) => b.cost - a.cost).slice(0, 3)
    out.push(`  hourly (account tz): ${d.hourly.length} hour(s) with delivery${top.length ? `; top by spend: ${top.map((h) => `${h.hour}:00 ${money(h.cost)} (${n(h.impressions)} impr, ${n(h.clicks)} clicks)`).join(', ')}` : ''}`)
  } else out.push('  hourly: not read')
  if (d.geo) {
    if (!d.geo.length) out.push('  geo: no rows')
    for (const g of d.geo) out.push(`  geo: ${g.country} (${g.countryCode}) ${money(g.cost)}, ${n(g.impressions)} impr, ${n(g.clicks)} clicks, bid modifier ${g.bidModifier == null ? 'none on record' : `${g.bidModifier} (${g.bidAdjustmentPct}%)`}`)
  } else out.push('  geo: not read')
  if (d.devices) {
    for (const dv of d.devices) {
      const shouldBeZero = dv.device === 'DESKTOP' || dv.device === 'CONNECTED_TV'
      const nonZero = dv.impressions > 0 || dv.clicks > 0
      out.push(`  device: ${dv.device} ${n(dv.impressions)} impr, ${n(dv.clicks)} clicks, ${money(dv.cost)}${shouldBeZero && nonZero ? ' — ANOMALY: computers/TV should read zero on a mobile-app placement campaign, propose to Mike' : ''}`)
    }
  } else out.push('  devices: not read')
  if (d.targeting) {
    for (const t of d.targeting) {
      const placementMismatch = t.expectedPlacements != null && t.placements !== t.expectedPlacements
      const optimizedOn = t.audienceBidOnly === false
      out.push(
        `  targeting: ${t.adGroup} [${t.status ?? '—'}] ${n(t.placements)} placement(s)${t.expectedPlacements != null ? ` (build spec: ${t.expectedPlacements})` : ' (build spec: unknown ad group)'}, optimized targeting ${optimizedOn ? 'ON' : 'off'}${placementMismatch ? ' — ANOMALY: placement count does not match the build spec, propose to Mike' : ''}${optimizedOn ? ' — ANOMALY: optimized targeting is on (do-not-change list, spec section 14), propose to Mike' : ''}`,
      )
    }
  } else out.push('  targeting: not read')
  if (d.recommendations) {
    out.push(d.recommendations.length ? `  recommendations queued: ${d.recommendations.map((r) => r.type ?? 'unknown').join(', ')} (read-only; nothing applied or dismissed)` : '  recommendations: none queued')
    out.push(`  standing verdicts (never re-derived, never applied): ${RECOMMENDATION_STANDING_VERDICTS}`)
  } else out.push('  recommendations: not read')
  if (d.countryCounts) out.push(`  beacon countries (tagged arrivals, aggregate counts): ${d.countryCounts.length ? d.countryCounts.map((c) => `${c.country} ${n(c.count)}`).join(', ') : 'none'}`)
  else out.push('  beacon countries: not read')
  if (d.accountCrossCheck) {
    const cc = d.accountCrossCheck
    const below = cc.firestoreNewAccounts != null && cc.beaconAuthSuccessNew != null && cc.firestoreNewAccounts < cc.beaconAuthSuccessNew
    out.push(`  account cross-check (${cc.etDate}): Firestore new accounts ${n(cc.firestoreNewAccounts)} vs beacon /auth/success new ${n(cc.beaconAuthSuccessNew)}${below ? ' — ANOMALY: Firestore count below the beacon count, propose to Mike' : ''}`)
  } else out.push('  account cross-check: not read')
  if (d.errors.length) out.push(`  diagnostic read errors (best-effort; did not block the read above): ${d.errors.join(' | ')}`)
  return out
}

/** R4: Play Console bulk-reports, informational only (never a kill rule, never `notify`; the
 * $50/$75 lines below are report text, never a pause proposal — see checkpoint() in play.ts).
 * Bulk reports lag a day or more, so every figure names the date it covers, and the household
 * caveat is repeated on each data line rather than stated once (coordinator's instruction: say
 * it in the report line, not behind one shared footnote). */
function playReportsLines(p: MorningResult['playReports']): string[] {
  if (!p) return []
  const out = ['Play Console bulk reports (informational only; never a kill rule or an automatic action):']
  if (!p.ok) {
    out.push(`  Play reports: ${p.error ?? 'not read'}`)
    return out
  }
  const household = "includes the developer's own household devices; not attributable to any one campaign"
  if (p.installsByDay?.length) {
    out.push(`  installs by day, horizon ${p.installsThrough} (${p.installsLagDays}-day lag, ${household}):`)
    for (const d of p.installsByDay) out.push(`    ${d.date}: ${n(d.deviceInstalls)} device installs, ${n(d.userInstalls)} user installs, ${n(d.deviceUninstalls)} uninstalls, ${n(d.activeDeviceInstalls)} active devices`)
  } else out.push(`  installs by day: no rows for the requested window (horizon ${p.installsThrough ?? 'no data yet'}, ${household})`)
  if (p.acquisitionBySource?.length) {
    out.push(`  acquisition by source (store listing visitors/acquisitions), horizon ${p.storePerformanceThrough} (${p.storePerformanceLagDays}-day lag, ${household}):`)
    for (const s of p.acquisitionBySource) out.push(`    ${s.date} ${s.dimension ?? 'unknown source'}: ${n(s.visitors)} store listing visitors, ${n(s.acquisitions)} acquisitions, ${pct(s.conversionRate)} conversion`)
  } else out.push(`  acquisition by source: no rows for the requested window (horizon ${p.storePerformanceThrough ?? 'no data yet'})`)
  if (p.acquisitionByCountry?.length) {
    out.push(`  store listing visitors by country, horizon ${p.storePerformanceThrough} (${household}):`)
    for (const c of p.acquisitionByCountry) out.push(`    ${c.date} ${c.dimension ?? 'unknown country'}: ${n(c.visitors)} visitors, ${n(c.acquisitions)} acquisitions, ${pct(c.conversionRate)} conversion`)
  } else out.push(`  store listing visitors by country: no rows for the requested window (horizon ${p.storePerformanceThrough ?? 'no data yet'})`)
  out.push(`  day-1/day-7 retention: ${p.retentionNote}`)
  for (const c of p.checkpoints) out.push(`  $${c.threshold} cumulative-spend Play-install checkpoint (informational, never a kill rule): [${c.status}] ${c.detail}`)
  if (p.errors.length) out.push(`  Play read errors (best-effort; did not block the read above): ${p.errors.join(' | ')}`)
  return out
}

function storeLine(r: MorningResult | PostflightResult): string {
  const s = r.store
  const dup = r.dedup?.skipped.length ? `; already recorded today, not stored again: ${r.dedup.skipped.map((x) => x.entryKind).join(', ')}` : ''
  if (s.dryRun) return `Store (${s.kind}): dry run, nothing written${dup}`
  return `Store (${s.kind}): campaigns ${s.campaignsSynced ? 'synced' : 'NOT synced'}, spend ${s.spendWritten ? 'up to date' : 'NOT stored'}, readings ${s.readingsWritten ? 'written' : 'NOT written'}${dup}${s.errors.length ? ` [${s.errors.join(' | ')}]` : ''}`
}

export function formatPostflightReport(r: PostflightResult): string {
  const out = header(r, `post-flight ${r.stage} read`)
  if (r.failures.length) out.push(`READ FAILED: ${r.failureDetails.join("; ")}`)
  const flag2 = r.read?.firebase ? first50FlagLine(r.read.firebase) : null
  if (flag2) out.push(flag2)
  out.push(...spendLines(r.spend))
  out.push(`Spend ended ${r.spendEndEt ?? '—'}; this stage is due ${r.dueEt ?? '—'} (${r.due ? 'due' : 'NOT due yet'})`)
  if (r.postFlightSpend) out.push(`After-flight spend: [${r.postFlightSpend.status}] ${r.postFlightSpend.detail}`)
  if (r.hardCap) out.push(`Hard cap: [${r.hardCap.status}] ${r.hardCap.detail}`)
  if (r.read) out.push('', ...fullReadLines(r.read, `POST-FLIGHT ${r.stage.toUpperCase()}`, { postflight: true }))
  const b = r.promoSplit.beacon
  if (b) {
    const row = (o: Record<string, number>, shown: number) => POPUP_OUTCOME_TYPES.map((t) => `${t} ${formatGated(gateRate(o[t], shown))}`).join(', ')
    out.push(`Promo vs non-promo (site-wide outcome beacons, anonymous): promo shown ${n(b.promoShown)}: ${row(b.promo, b.promoShown)}`)
    out.push(`  sign-in prompt (non-promo) shown ${n(b.nonPromoShown)}: ${row(b.nonPromo, b.nonPromoShown)}`)
  }
  const a = r.promoSplit.accounts
  if (a) out.push(`  accounts in the flight window: ${n(a.newInWindow)} new, ${n(a.promoClaimsInWindow)} promo claims, ~${n(a.nonPromoInWindow)} non-promo (counts only)`)
  const c = r.cohort
  if (c) {
    out.push(
      `Cohort (accounts created in the flight window; ${c.label}): ${n(c.total)} total; paid ${formatGated(c.rates.paid)}, trial active ${formatGated(c.rates.trialActive)}, expired ${formatGated(c.rates.expired)}; promo set ${formatGated(c.rates.promoSet)}, unset ${n(c.promoUnset)}${c.consistent ? '' : ' [counts do not add up: read the raw counts only]'}`,
    )
  } else if (r.cohortNote) out.push(`Cohort by tier: ${r.cohortNote}${r.promoSplit.accounts ? ` (plain window count: ${n(r.promoSplit.accounts.newInWindow)} new accounts, sitewide)` : ''}`)
  for (const rec of r.recommendations) out.push(rec)
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
