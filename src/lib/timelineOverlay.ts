// What a date-axis line chart can draw OVER its lines — the generic version of the Overview's
// former one-off timeline overlay, now options on the standard line chart (Widget.markers,
// Widget.goLiveMarkers, Widget.flightBands; see lib/charts.ts timelineOverlayPlugin):
//  - release markers: every dated release (lib/releases.ts). A 'major' one is a dashed labelled
//    line, the rest short unlabelled ticks, so a long history stays legible;
//  - go-live markers: the instants a measurement started or changed (tracking activation, the
//    game-complete + auth-status beacons, the install fix, the raw-install de-dupe);
//  - campaign flight bands: one shaded band per CAMPAIGNS flight with a known start, from its
//    first ET day through its last; an ACTIVE flight's band is open-ended (runs to the axis end).
// Everything here is pure (no canvas), so band layout and item lists are unit-tested; the chart
// plugin only turns them into pixels. Every item also carries its date, label and note, which
// the chart shows on hover/tap and in the accessible list under the chart (ChartCard.vue).
import { datedReleases } from './releases'
import { CAMPAIGNS, type CampaignFlight } from './campaigns'
import {
  TRACKING_ACTIVATION_DATE_ET,
  NEW_BEACONS_LIVE_AT_ET,
  NEW_BEACONS_LIVE_MARKER_LABEL,
  RAW_INSTALL_DEDUPE_LIVE_AT_ET,
  RAW_INSTALL_DEDUPE_MARKER_LABEL,
  INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS,
} from './popupEvents'
import { etDateFast } from './etTime'

export type OverlayKind = 'release' | 'minor-release' | 'go-live' | 'flight'

export interface OverlayItem {
  kind: OverlayKind
  date: string // ET calendar date (YYYY-MM-DD) the item starts on
  endDate?: string // flights only: last ET day (inclusive); absent + openEnded for an active flight
  openEnded?: boolean
  label: string // short on-chart label
  note: string // the longer description (tooltip + list)
}

export interface OverlayOptions {
  releases?: boolean
  goLive?: boolean
  flights?: boolean
}

/** The go-live instants, as ET days. Plain wording only (they're shown to the owner). */
export function goLiveItems(): OverlayItem[] {
  const items: OverlayItem[] = []
  if (TRACKING_ACTIVATION_DATE_ET) {
    items.push({ kind: 'go-live', date: TRACKING_ACTIVATION_DATE_ET, label: 'tracking starts', note: 'Pop-up and campaign-return tracking went live on the web.' })
  }
  items.push({ kind: 'go-live', date: NEW_BEACONS_LIVE_AT_ET, label: NEW_BEACONS_LIVE_MARKER_LABEL, note: 'Completed-game and new/existing sign-in beacons went live.' })
  if (INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS !== null) {
    items.push({ kind: 'go-live', date: etDateFast(INSTALL_ACCEPT_OUTCOME_FIXED_AT_UTC_MS), label: 'install fix', note: 'Prompt-driven installs are recorded from here on; earlier ones were not.' })
  }
  items.push({ kind: 'go-live', date: RAW_INSTALL_DEDUPE_LIVE_AT_ET, label: RAW_INSTALL_DEDUPE_MARKER_LABEL, note: 'Raw install signals stopped double-sending from several open tabs.' })
  return items
}

export function releaseItems(): OverlayItem[] {
  return datedReleases().map((r) => ({ kind: r.major ? 'release' : 'minor-release', date: r.dateEt, label: r.version, note: r.note }))
}

/** A flight's band: closed flights end at flightEnd. An ACTIVE flight is open-ended (runs to the
 * axis end) only while it's still inside its serving window (ET today <= flightEnd); once past
 * it, it ends at flightEnd like any other, even if nobody has flipped its status yet. */
export function flightItems(flights: CampaignFlight[] = CAMPAIGNS, todayEt: string = etDateFast(Date.now())): OverlayItem[] {
  return flights
    .filter((f) => f.flightStart !== null && f.status !== 'upcoming')
    .map((f) => {
      const open = f.status === 'active' && todayEt <= f.flightEnd
      return {
        kind: 'flight' as const,
        date: f.flightStart!,
        ...(open ? { openEnded: true } : { endDate: f.flightEnd }),
        label: f.label,
        note: open ? `Campaign flight from ${f.flightStart}, still serving.` : `Campaign flight ${f.flightStart} to ${f.flightEnd}.`,
      }
    })
}

/** Every overlay item the options switch on, sorted by date (flights first on a tie). */
export function overlayItems(opts: OverlayOptions, flights: CampaignFlight[] = CAMPAIGNS, todayEt?: string): OverlayItem[] {
  const items = [...(opts.flights ? flightItems(flights, todayEt) : []), ...(opts.releases ? releaseItems() : []), ...(opts.goLive ? goLiveItems() : [])]
  const order: Record<OverlayKind, number> = { flight: 0, release: 1, 'go-live': 2, 'minor-release': 3 }
  return items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : order[a.kind] - order[b.kind]))
}

/** Items that touch the axis range [first, last] (flights by overlap), for the list. */
export function itemsInRange(items: OverlayItem[], first: string, last: string): OverlayItem[] {
  return items.filter((it) => {
    if (it.kind !== 'flight') return it.date >= first && it.date <= last
    const end = it.openEnded ? last : it.endDate!
    return it.date <= last && end >= first
  })
}

/** The category index a point-in-time item sits at on a date axis: the first plotted day on or
 * after its date, or -1 when it falls outside the plotted range. */
export function markerIndex(dates: string[], date: string): number {
  if (!dates.length || date < dates[0] || date > dates[dates.length - 1]) return -1
  return dates.findIndex((d) => d >= date)
}

export interface BandLayout {
  item: OverlayItem
  startIndex: number // first category the band covers
  endIndex: number // last category the band covers (inclusive)
  clippedStart: boolean // the flight began before the plotted range
  clippedEnd: boolean // it ends after the range (or is open-ended)
  row: number // label row: overlapping bands take successive rows so their labels don't collide
}

/** Where each flight band sits on a date axis (category indexes, both ends inclusive). A band
 * covers whole ET days, from its first day through its last; an open-ended band runs to the axis
 * end; a band wholly outside the range is dropped. Overlapping bands get successive label rows. */
export function layoutFlightBands(dates: string[], flights: OverlayItem[]): BandLayout[] {
  if (!dates.length) return []
  const first = dates[0]
  const last = dates[dates.length - 1]
  const out: BandLayout[] = []
  for (const item of flights) {
    if (item.kind !== 'flight') continue
    const end = item.openEnded ? last : item.endDate!
    if (item.date > last || end < first) continue
    const startIndex = item.date <= first ? 0 : dates.findIndex((d) => d >= item.date)
    let endIndex = dates.length - 1
    if (end < last) {
      // the last plotted day that is still on or before the band's last day
      for (let i = dates.length - 1; i >= 0; i--) {
        if (dates[i] <= end) {
          endIndex = i
          break
        }
      }
    }
    if (endIndex < startIndex) continue // the band's days fall between two plotted days
    out.push({ item, startIndex, endIndex, clippedStart: item.date < first, clippedEnd: !!item.openEnded || end > last, row: 0 })
  }
  // Greedy rows by start: a band overlapping one already in a row goes to the next row.
  out.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex)
  const rowEnds: number[] = []
  for (const b of out) {
    let row = rowEnds.findIndex((end) => end < b.startIndex)
    if (row === -1) row = rowEnds.length
    rowEnds[row] = b.endIndex
    b.row = row
  }
  return out
}
