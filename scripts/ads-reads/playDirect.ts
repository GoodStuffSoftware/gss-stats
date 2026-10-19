// The Play-direct arm's readout: an arm whose ads open the Play listing (CampaignFlight.kind ===
// 'play-direct') has no web arrival, so three lines carry its result:
//   - tagged first opens (/return/<uc>/d0 rows from the app, via the Play install referrer),
//   - tagged sign-ins (new accounts), both counts the existing reads already make, and
//   - Play Console installs: the store-listing acquisitions Play prints for the arm's utm_campaign
//     (scripts/ads-reads/play.ts sumByUtmCampaign).
// Play's bulk reports lag 6-14 days, so the install line says how complete it is: PARTIAL until Play's
// listing data runs a week past the flight's last day, INSTALL VERDICT after. Aggregate counts only: no
// visitor id, no join, no hour/place/device split. Report text and data only; never a rule.
import { addDays } from '../../src/lib/etTime'
import { summarizeError } from '../../src/lib/adsRedact'
import { CAMPAIGN_SPEND, CAMPAIGNS, type CampaignFlight } from '../../src/lib/campaigns'
import type { PlayReportsSection, PlayUtmCampaignRow } from './play'

/** Play's listing data must reach this many days past the flight's last day before the read is called the install verdict. */
export const PLAY_VERDICT_SETTLE_DAYS = 7
/** Said where the numbers are printed: acquisitions and device installs are different counts. */
export const PLAY_ACQUISITION_NOTE =
  "store listing acquisitions are installers Play attributes to a visit through this utm_campaign, as Play prints them; they differ from device installs (the installs-by-day lines count every device install on the account, the developer's own household devices included, with no campaign attached), and Play's lag is 6-14 days"
/** The twin's net device installs: derived by hand in the September review, so it is quoted with its source and never computed from a file. */
export const PLAY_BASELINE_NET_DEVICE_NOTE =
  '"8 net device installs" (hand-derived in the September review of the closed twin, not from the Play file)'
/** The utm_campaign of the twin the September review's hand-derived figure belongs to; the quoted note prints only beside that twin. */
export const PLAY_BASELINE_NOTE_UC = 'sudoku_tired_of_ads_play'
/** The September twin's cost per net install, the reference beside "cost per tagged first open": hand-derived (never computed from a file), from the same source note as the net device installs. */
export const PLAY_BASELINE_COST_PER_NET_INSTALL_NOTE =
  '~$9.50 per net install (hand-derived in the September review of the closed twin, the same source note as the net device installs figure in the Baseline line below; not from the Play file)'
export const PLAY_NOT_LANDED_TEXT = 'not landed yet (lags 6-14 days)'

export type PlayReadLabel = 'INSTALL VERDICT' | 'PARTIAL'
/** INSTALL VERDICT once Play's store-listing horizon is PLAY_VERDICT_SETTLE_DAYS or more past the flight end, else PARTIAL. */
export function playReadLabel(storePerformanceThrough: string | null, flightEnd: string): PlayReadLabel {
  return storePerformanceThrough != null && storePerformanceThrough >= addDays(flightEnd, PLAY_VERDICT_SETTLE_DAYS) ? 'INSTALL VERDICT' : 'PARTIAL'
}

export interface PlayDirectInstalls {
  /** The Play read ran and returned data. */
  read: boolean
  /** Why it did not (read false). */
  error: string | null
  /** Last date of Play's store-listing file. */
  through: string | null
  lagDays: number | null
  /** Summed over the arm's utm_campaign values; null when Play printed no row for any of them. */
  acquisitions: number | null
  visitors: number | null
  /** One entry per utm_campaign value of the arm that has a row. */
  rows: PlayUtmCampaignRow[]
  /** 'not landed yet' = no row and the store-listing horizon has not reached the flight end. */
  state: 'counts' | 'no row yet' | 'no row at horizon' | 'not read'
  label: PlayReadLabel
}

/** The arm's own utm_campaign rows from a Play read (pure). */
export function playDirectInstalls(p: PlayReportsSection | null, ucValues: readonly string[], flightEnd: string): PlayDirectInstalls {
  const label = playReadLabel(p?.storePerformanceThrough ?? null, flightEnd)
  if (!p || !p.ok) return { read: false, error: p?.error ?? 'not read', through: null, lagDays: null, acquisitions: null, visitors: null, rows: [], state: 'not read', label }
  const rows = (p.acquisitionByUtmCampaign ?? []).filter((r) => ucValues.includes(r.utmCampaign))
  const through = p.storePerformanceThrough
  if (!rows.length) {
    const reached = through != null && through >= flightEnd
    return { read: true, error: null, through, lagDays: p.storePerformanceLagDays, acquisitions: null, visitors: null, rows, state: reached ? 'no row at horizon' : 'no row yet', label }
  }
  return {
    read: true,
    error: null,
    through,
    lagDays: p.storePerformanceLagDays,
    acquisitions: rows.reduce((a, r) => a + r.acquisitions, 0),
    visitors: rows.reduce((a, r) => a + r.visitors, 0),
    rows,
    state: 'counts',
    label,
  }
}

/** The closed Play-direct twin's figures, for the line beside the arm: what the earlier Play-direct flight bought. */
export interface PlayDirectBaseline {
  campaignId: string
  label: string
  flightStart: string
  flightEnd: string
  spend: number | null
  ucValues: string[]
  read: boolean
  error: string | null
  /** Store-listing figures by the twin's own utm_campaign (the Play UTM file). */
  listingAcquisitions: number | null
  listingVisitors: number | null
  /** The twin ran before the app could read the install referrer: it has no tagged app rows. */
  taggedAppRows: 'none'
}

/** The closed Play-direct campaigns in the registry (found by their kind and status, never by id). */
export function closedPlayDirectCampaigns(campaigns: readonly CampaignFlight[] = CAMPAIGNS): CampaignFlight[] {
  return campaigns.filter((c) => c.kind === 'play-direct' && c.status === 'closed' && c.flightStart != null)
}

/** Days past a twin's flight end that its utm_campaign rows are still counted (late listing visits and installs; the tag is the twin's alone). */
export const BASELINE_TAIL_DAYS = 21

type PlayRead = (o: { since: string; until: string; flightStart: string; cumulativeSpend: number }) => Promise<PlayReportsSection>

/** Reads Play for the twin's dates and its own utm_campaign. Best effort: a failure is carried in the result, never thrown. */
export async function playDirectBaseline(twin: CampaignFlight, read: PlayRead | null, spend: number | null = CAMPAIGN_SPEND[twin.id] ?? null): Promise<PlayDirectBaseline> {
  const base: PlayDirectBaseline = {
    campaignId: twin.id,
    label: twin.label,
    flightStart: twin.flightStart!,
    flightEnd: twin.flightEnd,
    spend,
    ucValues: [...twin.ucValues],
    read: false,
    error: null,
    listingAcquisitions: null,
    listingVisitors: null,
    taggedAppRows: 'none',
  }
  if (!read) return { ...base, error: '--play-sa not given' }
  try {
    const p = await read({ since: twin.flightStart!, until: addDays(twin.flightEnd, BASELINE_TAIL_DAYS), flightStart: twin.flightStart!, cumulativeSpend: spend ?? 0 })
    if (!p.ok) return { ...base, error: p.error ?? 'Play read failed' }
    const mine = playDirectInstalls(p, twin.ucValues, twin.flightEnd)
    return {
      ...base,
      read: true,
      listingAcquisitions: mine.acquisitions,
      listingVisitors: mine.visitors,
    }
  } catch (e) {
    return { ...base, error: summarizeError(e) }
  }
}

export interface PlayDirectBlock {
  campaignId: string
  ucValues: string[]
  flightEnd: string
  /** Cumulative closed-day ad clicks (the rule 5 input); null when spend was not read. */
  clicks: number | null
  /** Cumulative closed-day ad spend, dollars (the "cost per tagged first open" numerator); null when spend was not read. */
  spend: number | null
  /** Tagged /return/<uc>/d0 rows: first opens that carried the install referrer. null when not read. */
  d0Rows: number | null
  /** Tagged first opens in the same closed days the spend covers (the cost line's denominator), so today's partial day
   * is in neither side. undefined = not computed separately (a finished flight: every day is closed); null = not read. */
  closedD0Rows?: number | null
  /** Tagged /auth/success/<provider>/new rows, capped at Firestore new accounts when that was read. */
  signIns: { count: number; note: string } | null
  installs: PlayDirectInstalls
  baseline: PlayDirectBaseline | null
}
export function buildPlayDirectBlock(i: {
  campaign: CampaignFlight
  playReports: PlayReportsSection | null
  clicks: number | null
  spend?: number | null
  d0Rows: number | null
  closedD0Rows?: number | null
  signIns: { count: number; note: string } | null
  baseline: PlayDirectBaseline | null
}): PlayDirectBlock {
  return {
    campaignId: i.campaign.id,
    ucValues: [...i.campaign.ucValues],
    flightEnd: i.campaign.flightEnd,
    clicks: i.clicks,
    spend: i.spend ?? null,
    d0Rows: i.d0Rows,
    ...(i.closedD0Rows !== undefined ? { closedD0Rows: i.closedD0Rows } : {}),
    signIns: i.signIns,
    installs: playDirectInstalls(i.playReports, i.campaign.ucValues, i.campaign.flightEnd),
    baseline: i.baseline,
  }
}

const n = (x: number | null | undefined) => (x == null ? '—' : x.toLocaleString('en-US'))
const money = (x: number | null) => (x == null ? '—' : `$${x.toFixed(2)}`)

/** The WATCH line "cost per tagged first open": closed-day spend over the tagged /return/<uc>/d0 count. A watch figure, never a rule: a first open is not an install. */
export function costPerTaggedFirstOpenLine(b: PlayDirectBlock): string {
  const head = '  WATCH \u00b7 cost per tagged first open'
  const reference = b.baseline && b.baseline.ucValues.includes(PLAY_BASELINE_NOTE_UC) ? `; reference, the September twin's ${PLAY_BASELINE_COST_PER_NET_INSTALL_NOTE}` : ''
  // Spend is through yesterday (closed days); the opens must cover the same days, not today's partial one.
  const opens = b.closedD0Rows !== undefined ? b.closedD0Rows : b.d0Rows
  if (opens == null) return `${head}: tagged first opens ${b.closedD0Rows !== undefined ? 'in the closed days ' : ''}not read${reference}`
  if (opens === 0) return `${head}: no tagged first opens yet${reference}`
  if (b.spend == null) return `${head}: spend not read (${n(opens)} tagged first opens)${reference}`
  return `${head}: ${money(b.spend / opens)} (${money(b.spend)} closed-day spend / ${n(opens)} tagged first opens in those same closed days); watch only, a first open is not an install${reference}`
}

/** The report lines of a Play-direct arm: tagged first opens and sign-ins, the labelled Play installs, and the baseline. */
export function playDirectLines(b: PlayDirectBlock | undefined | null): string[] {
  if (!b) return []
  const tags = b.ucValues.join(', ')
  const out = ['Play-direct arm (the ads open the Play listing, so there is no web arrival; informational only, never a kill rule or an automatic action):']
  out.push(`  Tagged first opens (/return/<uc>/d0 rows for ${tags}): ${n(b.d0Rows)}${b.clicks != null ? ` from ${n(b.clicks)} clicks` : ''}; tagged sign-ins (new accounts): ${b.signIns ? `${n(b.signIns.count)} (${b.signIns.note})` : 'not read'}`)
  out.push(costPerTaggedFirstOpenLine(b))
  const ins = b.installs
  const head = `  Play Console installs (store listing acquisitions for utm_campaign ${tags}, as Play prints them)`
  if (!ins.read) out.push(`${head}: not read (${ins.error ? summarizeError(ins.error) : 'no Play read'}); ${PLAY_NOT_LANDED_TEXT}`)
  else if (ins.state === 'no row yet') out.push(`${head}: ${PLAY_NOT_LANDED_TEXT}; Play's listing data runs through ${ins.through ?? 'no date yet'}, the flight ends ${b.flightEnd}`)
  else {
    const labelText =
      ins.label === 'INSTALL VERDICT'
        ? `INSTALL VERDICT: Play's listing data runs through ${ins.through}, ${PLAY_VERDICT_SETTLE_DAYS}+ days past the flight end ${b.flightEnd}`
        : `PARTIAL: Play's listing data runs through ${ins.through} against a flight end of ${b.flightEnd} (needs ${addDays(b.flightEnd, PLAY_VERDICT_SETTLE_DAYS)}); later days are not in yet, so this is a floor`
    if (ins.state === 'no row at horizon') out.push(`${head}: no row for the tag in Play's store-listing file through ${ins.through} (0 acquisitions as printed; Play folds small tags into Other); ${labelText}`)
    else out.push(`${head}: ${n(ins.acquisitions)} acquisitions of ${n(ins.visitors)} listing visitors; ${labelText}`)
  }
  out.push(`  Note: ${PLAY_ACQUISITION_NOTE}.`)
  const bl = b.baseline
  if (bl) {
    const where = `${bl.label}, ${bl.flightStart}..${bl.flightEnd}, ${money(bl.spend)} spent, utm_campaign ${bl.ucValues.join(', ')}`
    if (!bl.read) out.push(`  Baseline (closed Play-direct twin ${where}): not read (${bl.error ?? 'no Play read'})`)
    else {
      const listing = bl.listingAcquisitions == null ? 'no store-listing row in the Play UTM file' : `${n(bl.listingAcquisitions)} acquisitions / ${n(bl.listingVisitors)} listing visitors (UTM file)`
      // The hand-derived net device installs and the "no tagged app rows" fact are the September twin's alone: a later closed Play-direct arm gets neither.
      const september = bl.ucValues.includes(PLAY_BASELINE_NOTE_UC)
      out.push(
        `  Baseline (closed Play-direct twin ${where}): ${listing}${september ? `; separately, ${PLAY_BASELINE_NET_DEVICE_NOTE}; tagged app rows: none (the app could not read the install referrer then)` : ''}`,
      )
    }
  }
  return out
}
